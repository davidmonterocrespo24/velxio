#!/usr/bin/env python3
"""
esp32_worker.py — Standalone ESP32 QEMU subprocess worker.

Runs as a child process of esp32_lib_manager.  Loads libqemu-xtensa in its
own process address space so multiple instances can coexist without DLL state
conflicts.

stdin  line 1 : JSON config
               {"lib_path": "...", "firmware_b64": "...", "machine": "..."}
stdin  line 2+: JSON commands
               {"cmd": "set_pin",          "pin": N,       "value": V}
               {"cmd": "set_adc",          "channel": N,   "millivolts": V}
               {"cmd": "set_adc_raw",      "channel": N,   "raw": V}
               {"cmd": "set_adc_waveform", "channel": N,   "samples_u12_b64": "<base64-LE-uint16>", "period_ns": P}
               {"cmd": "uart_send",        "uart": N,      "data": "<base64>"}
               {"cmd": "set_i2c_response", "addr": N,      "response": V}
               {"cmd": "set_spi_response", "response": V}
               {"cmd": "stop"}

stdout        : JSON event lines (one per line, flushed immediately)
               {"type": "system",       "event": "booted"}
               {"type": "system",       "event": "crash",  "reason": "...", ...}
               {"type": "system",       "event": "reboot", "count": N}
               {"type": "gpio_change",  "pin": N,  "state": V}
               {"type": "gpio_dir",     "pin": N,  "dir": V}
               {"type": "uart_tx",      "uart": N, "byte": V}
               {"type": "ledc_update",  "channel": N, "duty": V, "duty_pct": F, "gpio": N|-1}
               {"type": "rmt_event",    "channel": N, ...}
               {"type": "ws2812_update","channel": N, "pixels": [...]}
               {"type": "i2c_event",    "bus": N, "addr": N, "event": N, "response": N}
               {"type": "spi_event",    "bus": N, "event": N, "response": N}
               {"type": "error",        "message": "..."}

stderr        : debug logs (never part of the JSON protocol)
"""
import base64
import ctypes
import json
import os
import sys
import tempfile
import threading
import time

# I2C slave state machines — extracted to a standalone module for testability
try:
    from app.services.esp32_i2c_slaves import (
        MPU6050Slave as _MPU6050Slave,
        BMP280Slave  as _BMP280Slave,
        DS1307Slave  as _DS1307Slave,
        DS3231Slave  as _DS3231Slave,
        I2CWriteSink as _I2CWriteSink,
    )
except ImportError:
    # Fallback: direct import when running from backend/ directory as subprocess
    import importlib.util, pathlib, sys as _sys
    _here = pathlib.Path(__file__).parent
    _spec = importlib.util.spec_from_file_location('esp32_i2c_slaves', _here / 'esp32_i2c_slaves.py')
    _mod  = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
    # Register in sys.modules BEFORE exec — @dataclass looks up cls.__module__
    # there, and crashes with AttributeError on None when missing.
    _sys.modules['esp32_i2c_slaves'] = _mod
    _spec.loader.exec_module(_mod)  # type: ignore[union-attr]
    _MPU6050Slave = _mod.MPU6050Slave  # type: ignore[assignment]
    _BMP280Slave  = _mod.BMP280Slave   # type: ignore[assignment]
    _DS1307Slave  = _mod.DS1307Slave   # type: ignore[assignment]
    _DS3231Slave  = _mod.DS3231Slave   # type: ignore[assignment]
    _I2CWriteSink = _mod.I2CWriteSink  # type: ignore[assignment]

# SPI slaves (Phase 1: SSD168x ePaper). Same fallback dance — when the worker
# runs as a subprocess from backend/ the package import won't resolve.
try:
    from app.services.esp32_spi_slaves import (
        Ssd168xEpaperSlave as _Ssd168xEpaperSlave,
        Uc8159cEpaperSlave as _Uc8159cEpaperSlave,
    )
except ImportError:
    import importlib.util, pathlib, sys as _sys
    _here = pathlib.Path(__file__).parent
    _spec = importlib.util.spec_from_file_location('esp32_spi_slaves', _here / 'esp32_spi_slaves.py')
    _mod = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
    # Same dataclass-needs-sys.modules fix as the i2c fallback above.
    _sys.modules['esp32_spi_slaves'] = _mod
    _spec.loader.exec_module(_mod)  # type: ignore[union-attr]
    _Ssd168xEpaperSlave = _mod.Ssd168xEpaperSlave  # type: ignore[assignment]
    _Uc8159cEpaperSlave = _mod.Uc8159cEpaperSlave  # type: ignore[assignment]

# ─── stdout helpers ──────────────────────────────────────────────────────────

_stdout_lock = threading.Lock()


def _emit(obj: dict) -> None:
    """Write one JSON event line to stdout (thread-safe, always flushed)."""
    with _stdout_lock:
        sys.stdout.write(json.dumps(obj) + '\n')
        sys.stdout.flush()


def _log(msg: str) -> None:
    """Write a debug message to stderr (invisible to parent's stdout reader)."""
    sys.stderr.write(f'[esp32_worker] {msg}\n')
    sys.stderr.flush()


# ─── GPIO pinmap (identity: slot i → GPIO i-1) ──────────────────────────────
# ESP32 has 40 GPIOs (0-39), ESP32-C3 only has 22 (0-21).
# The pinmap is rebuilt after reading config (see main()), defaulting to ESP32.

_GPIO_COUNT = 40
_PINMAP = (ctypes.c_int16 * (_GPIO_COUNT + 1))(
    _GPIO_COUNT,
    *range(_GPIO_COUNT),
)


def _build_pinmap(gpio_count: int):
    """Build a pinmap array for the given GPIO count."""
    global _GPIO_COUNT, _PINMAP
    _GPIO_COUNT = gpio_count
    _PINMAP = (ctypes.c_int16 * (gpio_count + 1))(
        gpio_count,
        *range(gpio_count),
    )

# ─── ctypes callback types ───────────────────────────────────────────────────

_WRITE_PIN = ctypes.CFUNCTYPE(None,            ctypes.c_int,   ctypes.c_int)
_DIR_PIN   = ctypes.CFUNCTYPE(None,            ctypes.c_int,   ctypes.c_int)
_I2C_EVENT = ctypes.CFUNCTYPE(ctypes.c_int,    ctypes.c_uint8, ctypes.c_uint8, ctypes.c_uint16)
_SPI_EVENT = ctypes.CFUNCTYPE(ctypes.c_uint8,  ctypes.c_uint8, ctypes.c_uint16)
_UART_TX   = ctypes.CFUNCTYPE(None,            ctypes.c_uint8, ctypes.c_uint8)
_RMT_EVENT = ctypes.CFUNCTYPE(None,            ctypes.c_uint8, ctypes.c_uint32, ctypes.c_uint32)


class _CallbacksT(ctypes.Structure):
    _fields_ = [
        ('picsimlab_write_pin',     _WRITE_PIN),
        ('picsimlab_dir_pin',       _DIR_PIN),
        ('picsimlab_i2c_event',     _I2C_EVENT),
        ('picsimlab_spi_event',     _SPI_EVENT),
        ('picsimlab_uart_tx_event', _UART_TX),
        ('pinmap',                  ctypes.c_void_p),
        ('picsimlab_rmt_event',     _RMT_EVENT),
    ]


# ─── RMT / WS2812 NeoPixel decoder ───────────────────────────────────────────

_WS2812_HIGH_THRESHOLD = 48  # RMT ticks; high pulse > threshold → bit 1


def _decode_rmt_item(value: int) -> tuple[int, int, int, int]:
    """Unpack a 32-bit RMT item → (level0, duration0, level1, duration1)."""
    level0    = (value >> 31) & 1
    duration0 = (value >> 16) & 0x7FFF
    level1    = (value >> 15) & 1
    duration1 =  value        & 0x7FFF
    return level0, duration0, level1, duration1


class _RmtDecoder:
    """Accumulate RMT items for one channel; flush complete WS2812 frames."""

    def __init__(self, channel: int):
        self.channel  = channel
        self._bits:   list[int] = []
        self._pixels: list[dict] = []

    @staticmethod
    def _bits_to_byte(bits: list[int], offset: int) -> int:
        val = 0
        for i in range(8):
            val = (val << 1) | bits[offset + i]
        return val

    def feed(self, value: int) -> list[dict] | None:
        """
        Process one RMT item.
        Returns a list of {r, g, b} pixel dicts on end-of-frame, else None.
        """
        level0, dur0, _, dur1 = _decode_rmt_item(value)

        # Reset pulse (both durations zero) signals end of frame
        if dur0 == 0 and dur1 == 0:
            pix = list(self._pixels)
            self._pixels.clear()
            self._bits.clear()
            return pix or None

        # Classify the high pulse → bit 1 or bit 0
        if level0 == 1 and dur0 > 0:
            self._bits.append(1 if dur0 > _WS2812_HIGH_THRESHOLD else 0)

        # Every 24 bits → one GRB pixel → convert to RGB
        while len(self._bits) >= 24:
            g = self._bits_to_byte(self._bits, 0)
            r = self._bits_to_byte(self._bits, 8)
            b = self._bits_to_byte(self._bits, 16)
            self._pixels.append({'r': r, 'g': g, 'b': b})
            self._bits = self._bits[24:]

        return None


# ─── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:  # noqa: C901  (complexity OK for inline worker)
    # ── 1. Read config from stdin ─────────────────────────────────────────────
    raw_cfg = sys.stdin.readline()
    if not raw_cfg.strip():
        _log('No config received on stdin — exiting')
        os._exit(1)
    try:
        cfg = json.loads(raw_cfg)
    except Exception as exc:
        _log(f'Bad config JSON: {exc}')
        os._exit(1)

    lib_path          = cfg['lib_path']
    firmware_b64      = cfg['firmware_b64']
    machine           = cfg.get('machine', 'esp32-picsimlab')
    initial_sensors   = cfg.get('sensors', [])
    wifi_enabled      = cfg.get('wifi_enabled', False)
    wifi_hostfwd_port = cfg.get('wifi_hostfwd_port', 0)

    # Adjust GPIO pinmap based on chip: ESP32-C3 has only 22 GPIOs
    if 'c3' in machine:
        _build_pinmap(22)

    # ── 2. Load DLL ───────────────────────────────────────────────────────────
    _MINGW64_BIN = r'C:\msys64\mingw64\bin'
    if os.name == 'nt' and os.path.isdir(_MINGW64_BIN):
        os.add_dll_directory(_MINGW64_BIN)
    try:
        lib_size = os.path.getsize(lib_path) if os.path.isfile(lib_path) else 0
        _log(f'Loading library: {lib_path} ({lib_size} bytes)')
        lib = ctypes.CDLL(lib_path)
    except Exception as exc:
        _emit({'type': 'error', 'message': f'Cannot load DLL: {exc}'})
        os._exit(1)
    lib.qemu_picsimlab_get_internals.restype = ctypes.c_void_p

    # qemu_picsimlab_uart_receive() injects a UART-RX interrupt into the guest CPU.
    # QEMU asserts qemu_mutex_iothread_locked() at that point, so the caller MUST
    # hold the IO-thread lock.  Acquire it before every uart_receive call and
    # release immediately after.  The functions are exported as:
    #   qemu_mutex_lock_iothread_impl(const char *file, int line)
    #   qemu_mutex_unlock_iothread()
    try:
        _lock_iothread   = lib.qemu_mutex_lock_iothread_impl
        _lock_iothread.restype  = None
        _lock_iothread.argtypes = [ctypes.c_char_p, ctypes.c_int]
        _unlock_iothread = lib.qemu_mutex_unlock_iothread
        _unlock_iothread.restype  = None
        _unlock_iothread.argtypes = []
    except AttributeError:
        _lock_iothread   = None
        _unlock_iothread = None

    # Predicate: is the iothread lock currently held by this thread?
    # Used to avoid re-acquiring when we're already inside a QEMU callback
    # (e.g., chip's vx_uart_write fired from inside _on_uart_tx).
    try:
        _iothread_locked = lib.qemu_mutex_iothread_locked
        _iothread_locked.restype  = ctypes.c_bool
        _iothread_locked.argtypes = []
    except AttributeError:
        _iothread_locked = None

    # qemu_system_shutdown_request() schedules a clean shutdown from inside
    # the QEMU main-loop thread (which owns the AIO context).  Calling
    # qemu_cleanup() directly from a Python thread (the command loop) triggers
    # the "blk_exp_close_all_type: in_aio_context_home_thread" assertion
    # because the block device teardown happens on the wrong thread.
    # SHUTDOWN_CAUSE_HOST_SIGNAL = 3 (matches the constant in qapi/run-state.json)
    try:
        _shutdown_request = lib.qemu_system_shutdown_request
        _shutdown_request.restype  = None
        _shutdown_request.argtypes = [ctypes.c_int]
    except AttributeError:
        _shutdown_request = None

    # ── ESP32-CAM frame injection ─────────────────────────────────────────
    # Exported by hw/misc/esp32_i2s_cam.c (the OV2640+I²S patch). When the
    # symbol is absent (= stock library, no camera patch yet), we keep a
    # no-op so the worker stays compatible with un-patched libraries.
    try:
        _push_camera_frame_c = lib.velxio_push_camera_frame
        _push_camera_frame_c.restype  = None
        _push_camera_frame_c.argtypes = [ctypes.c_char_p, ctypes.c_size_t]
        def _push_camera_frame(payload: bytes) -> None:
            buf = ctypes.c_char_p(payload) if payload else None
            n = len(payload) if payload else 0
            if _lock_iothread:
                _lock_iothread(b'esp32_worker.py:camera', 0)
            try:
                _push_camera_frame_c(buf, n)
            finally:
                if _unlock_iothread:
                    _unlock_iothread()
    except AttributeError:
        def _push_camera_frame(payload: bytes) -> None:
            # Stock library — no camera support compiled in. The first
            # time we hit this path we emit a warning so the user
            # understands why fb_get returns nothing; subsequent calls
            # are silent.
            if not getattr(_push_camera_frame, '_warned', False):
                _log('camera_frame: velxio_push_camera_frame symbol '
                     'missing — rebuild libqemu-xtensa with the '
                     'OV2640+I²S patch (test/test-esp32-cam/autosearch).')
                _push_camera_frame._warned = True  # type: ignore[attr-defined]

    # ── 3. Write firmware to a temp file ──────────────────────────────────────
    try:
        fw_bytes = base64.b64decode(firmware_b64)
        tmp = tempfile.NamedTemporaryFile(suffix='.bin', delete=False)
        tmp.write(fw_bytes)
        tmp.close()
        firmware_path: str | None = tmp.name
    except Exception as exc:
        _emit({'type': 'error', 'message': f'Firmware decode error: {exc}'})
        os._exit(1)

    rom_dir   = os.path.dirname(lib_path).encode()
    args_list = [
        b'qemu',
        b'-M', machine.encode(),
        b'-nographic',
        b'-L', rom_dir,
        b'-drive', f'file={firmware_path},if=mtd,format=raw'.encode(),
    ]

    # Deterministic instruction counting for stable timers.
    # Required for ESP32-C3 boot (RISC-V needs deterministic timing).
    # For ESP32 (Xtensa), -icount is NOT used: the WiFi AP beacon timer
    # runs on QEMU_CLOCK_REALTIME, so decoupling virtual time from real
    # time can cause beacon delivery issues on slow/virtualized hosts.
    if 'c3' in machine:
        args_list.extend([b'-icount', b'3'])

    # ── WiFi NIC (slirp user-mode networking) ──────────────────────────────
    if wifi_enabled:
        nic_model = 'esp32c3_wifi' if 'c3' in machine else 'esp32_wifi'
        nic_arg = f'user,model={nic_model},net=192.168.4.0/24'
        if wifi_hostfwd_port:
            nic_arg += f',hostfwd=tcp::{wifi_hostfwd_port}-192.168.4.15:80'
        args_list.extend([b'-nic', nic_arg.encode()])
        _log(f'WiFi enabled: -nic {nic_arg}')

    argc = len(args_list)
    argv = (ctypes.c_char_p * argc)(*args_list)

    # ── 4. Shared mutable state ───────────────────────────────────────────────
    _stopped       = threading.Event()      # set on "stop" command
    _init_done     = threading.Event()      # set when qemu_init() returns
    _sensors_ready = threading.Event()      # set after pre-registering initial sensors
    _i2c_responses: dict[int, int] = {}     # 7-bit addr → response byte (simple)
    _i2c_slaves:    dict = {}               # 7-bit addr → I2C slave/sink instance
    _spi_response   = [0xFF]                # MISO byte for SPI transfers (default)

    # Custom-chip runtimes that registered their respective protocols at chip_setup.
    # Mutated when sensor_type=='custom-chip' is processed in initial_sensors.
    _chip_uart_runtimes: list = []          # runtimes that called vx_uart_attach
    _chip_spi_runtimes:  list = []          # runtimes that called vx_spi_attach
    _chip_timer_runtimes: list = []         # runtimes with active timers
    _chip_pin_watch_runtimes: list = []     # runtimes that called vx_pin_watch

    # ePaper SSD168x slaves keyed by frontend component_id. The slave decodes
    # SPI bytes; on MASTER_ACTIVATION it emits an `epaper_update` WS frame.
    # `dc_pin` / `cs_pin` / `rst_pin` (gpio numbers) are tracked via
    # `_on_pin_change`; an active slave is one whose `cs_low` is True.
    _epaper_slaves: dict = {}
    # Per-slave runtime state keyed identically: dict with keys
    #   'slave', 'dc_pin', 'cs_pin', 'rst_pin', 'busy_pin', 'cs_low',
    #   'dc_high', 'refresh_ms'.
    _epaper_state: dict = {}

    # Live GPIO state tracked from QEMU's _on_pin_change callback. Custom-chip
    # runtimes' vx_pin_read consults this to see what the firmware just drove.
    _pin_state: dict[int, int] = {}
    _rmt_decoders:  dict[int, _RmtDecoder] = {}
    _uart0_buf      = bytearray()           # accumulate UART0 for crash detection
    _reboot_count   = [0]
    _crashed        = [False]
    _camera_frame_count = [0]               # ESP32-CAM frame trace counter
    _CRASH_STR      = b'Cache disabled but cached memory region accessed'
    _REBOOT_STR     = b'Rebooting...'
    # LEDC channel → GPIO pin (populated from GPIO out_sel sync events)
    # ESP32 signal indices: 72-79 = LEDC HS ch 0-7, 80-87 = LEDC LS ch 0-7
    _ledc_gpio_map: dict[int, int] = {}

    def _refresh_ledc_gpio_map() -> None:
        """Scan gpio_out_sel[40] registers and update _ledc_gpio_map.

        Called eagerly from the 0x5000 LEDC duty callback on cache miss,
        and periodically from the LEDC polling thread.
        """
        try:
            out_sel_ptr = lib.qemu_picsimlab_get_internals(2)
            if not out_sel_ptr:
                return
            out_sel = (ctypes.c_uint32 * 40).from_address(out_sel_ptr)
            for gpio_pin in range(40):
                signal = int(out_sel[gpio_pin]) & 0xFF
                if 72 <= signal <= 87:
                    ledc_ch = signal - 72
                    if _ledc_gpio_map.get(ledc_ch) != gpio_pin:
                        _ledc_gpio_map[ledc_ch] = gpio_pin
        except Exception:
            pass

    # Sensor state: gpio_pin → {type, properties..., saw_low, responding}
    _sensors: dict[int, dict] = {}
    _sensors_lock = threading.Lock()

    # ── Generic sync-handler registry ────────────────────────────────────────
    # Each entry implements step() -> bool.  step() is called once per
    # GPIO_IN read sync (every digitalRead() / pulseIn() iteration in firmware).
    # Returning True signals completion; the dispatcher removes the handler.
    # All mutations happen exclusively on the QEMU thread — no locks needed.
    #
    # To add a new GPIO-timed sensor:
    #   1. Write a class with a step() -> bool method
    #   2. Append an instance to _sync_handlers from _on_pin_change or _on_dir_change
    #   3. No changes to the dispatcher are needed
    _sync_handlers: list = []

    def _dht22_build_payload(temperature: float, humidity: float) -> list[int]:
        """Build 5-byte DHT22 data payload: [hum_H, hum_L, temp_H, temp_L, checksum]."""
        hum = round(humidity * 10)
        tmp = round(temperature * 10)
        h_H = (hum >> 8) & 0xFF
        h_L = hum & 0xFF
        raw_t = ((-tmp) & 0x7FFF) | 0x8000 if tmp < 0 else tmp & 0x7FFF
        t_H = (raw_t >> 8) & 0xFF
        t_L = raw_t & 0xFF
        chk = (h_H + h_L + t_H + t_L) & 0xFF
        return [h_H, h_L, t_H, t_L, chk]

    def _dht22_build_sync_phases(payload: list[int]) -> list[tuple[int, int]]:
        """Build list of (sync_count, pin_value) phase transitions for DHT22.

        Each entry means: after sync_count digitalRead() calls in this phase,
        drive the pin to pin_value and advance to the next phase.

        The Adafruit DHT library decodes bits by comparing
        highCycles > lowCycles — only RATIOS matter, not absolute values.
        We use the raw µs values as sync counts to preserve correct ratios.

        After the last data bit (40th bit HIGH→LOW), the firmware's
        expectPulse() loop ends — no more syncs will arrive.  So we do
        NOT add a trailing phase; cleanup happens immediately after the
        last phase transition fires.
        """
        phases: list[tuple[int, int]] = []
        # Preamble: LOW 80 syncs → drive HIGH
        phases.append((80, 1))
        # Preamble: HIGH 80 syncs → drive LOW
        phases.append((80, 0))
        # 40 data bits: LOW 50 syncs → HIGH, then HIGH (26 or 70) → LOW
        for byte_val in payload:
            for b in range(7, -1, -1):
                bit = (byte_val >> b) & 1
                phases.append((50, 1))              # LOW phase → drive HIGH
                phases.append((70 if bit else 26, 0))  # HIGH phase → drive LOW
        return phases

    class DHT22SyncHandler:
        """Drives the DHT22 waveform synchronously, one GPIO_IN read sync at a time.

        Uses phase-based counting: each phase defines how many syncs to wait before
        driving the pin to a new value.  The Adafruit DHT library decodes bits by
        comparing highCycles vs lowCycles — only RATIOS matter, so raw µs values used
        as sync counts preserve the correct bit decoding.
        """
        def __init__(self, gpio: int, slot: int, phases: list[tuple[int, int]]) -> None:
            self._gpio        = gpio
            self._slot        = slot
            self._phases      = phases
            self._phase_idx   = 0
            self._count       = 0
            self._total_syncs = 0

        def step(self) -> bool:
            """Advance one sync tick.  Returns True when the handler is done."""
            self._count += 1
            if self._phase_idx >= len(self._phases):
                return self._finish()
            target, pin_value = self._phases[self._phase_idx]
            if self._count >= target:
                lib.qemu_picsimlab_set_pin(self._slot, pin_value)
                self._total_syncs += self._count
                self._count       = 0
                self._phase_idx  += 1
                if self._phase_idx >= len(self._phases):
                    return self._finish()
            return False

        def _finish(self) -> bool:
            with _sensors_lock:
                sensor = _sensors.get(self._gpio)
                if sensor:
                    sensor['responding'] = False
            _log(f'DHT22 sync respond done gpio={self._gpio} '
                 f'total_syncs={self._total_syncs} phases={len(self._phases)}')
            _emit({'type': 'system', 'event': 'dht22_diag', 'gpio': self._gpio,
                   'status': 'ok', 'total_syncs': self._total_syncs})
            return True

    class HCSR04SyncHandler:
        """Drives HC-SR04 ECHO pin synchronously from the QEMU GPIO_IN read callback.

        _on_dir_change(-1, -1) fires for EVERY gpio_get_level() call in the
        firmware — including pulseIn()'s busy-wait loops.  The state machine:

          Phase 1 of pulseIn() (wait for !HIGH = wait for LOW):
            ECHO is LOW so the condition is immediately false.  One
            gpio_get_level() call fires.  We skip it.

          Phase 2 of pulseIn() (wait for HIGH):
            After skipping _SKIP_COUNT pre-phase2 callbacks, the next
            gpio_get_level() fires.  We set ECHO HIGH here.  pulseIn() sees HIGH
            immediately (qemu_picsimlab_set_pin is synchronous) and exits phase 2.

          Phase 3 of pulseIn() (measure HIGH duration):
            Subsequent gpio_get_level() calls fire step().  We hold ECHO HIGH
            until echo_us wall-clock µs have elapsed (perf_counter_ns), then
            set LOW.  Virtual time ≈ wall-clock time (confirmed: 30 000 µs
            pulseIn timeout = 30 ms wall-clock), so pulseIn() measures ≈ echo_us
            virtual µs → correct distance.

        Guard: wall-clock timeouts replace step-count limits.  A step-count
        guard is wrong because steps fire at rates that vary with QEMU load;
        using a fixed count would cut the pulse short for longer distances
        (100 cm = 5 800 µs, 200 cm = 11 600 µs) before elapsed_us is reached.
        """
        _SKIP_COUNT       = 2         # pre-phase2 callbacks to skip
        _ARMED_TIMEOUT_US = 40_000    # µs; give up if we never enter 'high'
        _HIGH_TIMEOUT_US  = 32_000    # µs; pulseIn() timeout is 30 000 µs

        def __init__(self, trig_gpio: int, echo_slot: int, echo_us: int) -> None:
            self._trig_gpio     = trig_gpio
            self._echo_slot     = echo_slot
            self._echo_us       = echo_us
            self._state         = 'armed'
            self._total_steps   = 0
            self._arm_start_ns  = time.perf_counter_ns()
            self._echo_start_ns = 0

        def step(self) -> bool:
            self._total_steps += 1

            if self._state == 'armed':
                if self._total_steps <= self._SKIP_COUNT:
                    return False
                # Check armed timeout (handler never entered 'high')
                arm_us = (time.perf_counter_ns() - self._arm_start_ns) // 1000
                if arm_us > self._ARMED_TIMEOUT_US:
                    _log(f'HCSR04 armed timeout trig={self._trig_gpio} '
                         f'arm_us={arm_us} steps={self._total_steps} — releasing')
                    with _sensors_lock:
                        sensor = _sensors.get(self._trig_gpio)
                        if sensor:
                            sensor['responding'] = False
                    return True
                # pulseIn() is now in phase 2 (waiting for HIGH) → raise ECHO
                lib.qemu_picsimlab_set_pin(self._echo_slot, 1)
                _emit({'type': 'system', 'event': 'hcsr04_echo_high',
                       'gpio': self._trig_gpio, 'echo_us': self._echo_us})
                _log(f'HCSR04 ECHO HIGH (sync) trig={self._trig_gpio} '
                     f'slot={self._echo_slot} echo_us={self._echo_us} '
                     f'armed_us={arm_us} skip={self._total_steps - 1}')
                self._echo_start_ns = time.perf_counter_ns()
                self._state = 'high'
                return False

            elif self._state == 'high':
                elapsed_us = (time.perf_counter_ns() - self._echo_start_ns) // 1000
                if elapsed_us >= self._echo_us:
                    return self._finish(elapsed_us)
                # Safety: don't hold ECHO past pulseIn() timeout
                if elapsed_us >= self._HIGH_TIMEOUT_US:
                    _log(f'HCSR04 high timeout trig={self._trig_gpio} '
                         f'elapsed_us={elapsed_us} echo_us={self._echo_us}')
                    lib.qemu_picsimlab_set_pin(self._echo_slot, 0)
                    with _sensors_lock:
                        sensor = _sensors.get(self._trig_gpio)
                        if sensor:
                            sensor['responding'] = False
                    return True

            return False

        def _finish(self, elapsed_us: int) -> bool:
            lib.qemu_picsimlab_set_pin(self._echo_slot, 0)
            _emit({'type': 'system', 'event': 'hcsr04_echo_low',
                   'gpio': self._trig_gpio})
            _log(f'HCSR04 ECHO LOW (sync) trig={self._trig_gpio} '
                 f'elapsed_us={elapsed_us} echo_us={self._echo_us} '
                 f'steps={self._total_steps}')
            with _sensors_lock:
                sensor = _sensors.get(self._trig_gpio)
                if sensor:
                    sensor['responding'] = False
            return True

    # ── 5. ctypes callbacks (called from QEMU thread) ─────────────────────────

    def _on_pin_change(slot: int, value: int) -> None:
        if _stopped.is_set():
            return
        gpio = int(_PINMAP[slot]) if 1 <= slot <= _GPIO_COUNT else slot
        _pin_state[gpio] = value & 1
        _emit({'type': 'gpio_change', 'pin': gpio, 'state': value})

        # Dispatch to any custom-chip runtime that has a vx_pin_watch on this
        # GPIO. We're called from QEMU's GPIO state-change path which holds the
        # IO-thread lock, so the chip's callback can safely call vx_pin_write
        # (which goes back into picsimlab and requires the same lock).
        if _chip_pin_watch_runtimes:
            for rt in _chip_pin_watch_runtimes:
                try:
                    rt.notify_pin_change(gpio, value)
                except Exception as e:
                    _log(f'[custom-chip pin_watch] error: {e!r}')

        # ePaper SSD168x: track DC / CS / RST pin states for every slave.
        # CS rising re-arms the next byte; CS falling activates the slave.
        # RST falling clears the controller's RAM (active LOW).
        if _epaper_state:
            for st in _epaper_state.values():
                if gpio == st['dc_pin']:
                    st['dc_high'] = bool(value & 1)
                elif gpio == st['cs_pin']:
                    st['cs_low'] = (value & 1) == 0
                elif gpio == st['rst_pin']:
                    if (value & 1) == 0:
                        st['slave'].reset()

        # Sensor protocol dispatch by type
        with _sensors_lock:
            sensor = _sensors.get(gpio)
        if sensor is None:
            return

        stype = sensor.get('type', '')

        if stype == 'dht22':
            # Record that the firmware drove the pin LOW (start signal).
            # The actual response is triggered from _on_dir_change when the
            # firmware switches the pin to INPUT mode.
            if value == 0 and not sensor.get('responding', False):
                sensor['saw_low'] = True

        elif stype == 'hc-sr04':
            # HC-SR04 trigger:
            #   TRIG HIGH → arm: save echo params
            #   TRIG LOW  → add HCSR04SyncHandler to _sync_handlers
            #
            # The sync handler drives ECHO from within the QEMU GPIO_IN read
            # callback (_on_dir_change slot=-1 direction=-1), which fires for
            # every gpio_get_level() call in the firmware — including pulseIn().
            # This is 100% synchronous with the QEMU thread, eliminating the
            # non-deterministic visibility issue that plagued the background-thread
            # approach (only ~33% success rate due to cross-thread pin propagation).
            if value == 1 and not sensor.get('responding', False):
                echo_pin = int(sensor.get('echo_pin', gpio + 1))
                distance = float(sensor.get('distance', 40.0))
                echo_us  = max(100, int(distance * 58))
                sensor['_trig_armed'] = {'echo_slot': echo_pin + 1, 'echo_us': echo_us}
                _log(f'HCSR04 TRIG HIGH (armed) gpio={gpio} echo_slot={echo_pin + 1} '
                     f'echo_us={echo_us} dist={distance}cm')

            elif value == 0 and sensor.get('_trig_armed') and not sensor.get('responding', False):
                armed     = sensor.pop('_trig_armed')
                echo_slot = armed['echo_slot']
                echo_us   = armed['echo_us']
                sensor['responding'] = True
                _sync_handlers.append(HCSR04SyncHandler(gpio, echo_slot, echo_us))
                _log(f'HCSR04 TRIG LOW → sync handler armed gpio={gpio} '
                     f'echo_slot={echo_slot} echo_us={echo_us}')

    def _on_dir_change(slot: int, direction: int) -> None:
        if _stopped.is_set():
            return

        # ── GPIO_IN read sync (slot == -1, direction == -1) ──────────────
        # Every digitalRead() in the firmware triggers this sync.  We use
        # it to drive DHT22 pin transitions synchronously on the QEMU
        # thread, perfectly synchronized with the firmware's expectPulse()
        # loop iterations.
        if slot == -1:
            if direction == -1:
                # GPIO_IN read sync — advance all active sync handlers.
                # step() returns True when done; list-comp removes finished handlers.
                if _sync_handlers:
                    _sync_handlers[:] = [h for h in _sync_handlers if not h.step()]
                return  # always return for GPIO_IN syncs (fast path)
            marker = direction & 0xF000
            if marker == 0x5000:  # LEDC duty change (from esp32_ledc.c)
                ledc_ch = (direction >> 8) & 0x0F
                intensity = direction & 0xFF  # 0-100 percentage
                gpio = _ledc_gpio_map.get(ledc_ch, -1)
                if gpio == -1:
                    _refresh_ledc_gpio_map()
                    gpio = _ledc_gpio_map.get(ledc_ch, -1)
                _emit({'type': 'ledc_update', 'channel': ledc_ch,
                       'duty': intensity,
                       'duty_pct': intensity,
                       'gpio': gpio})
            return

        # ── DHT22: track direction changes + trigger sync response ───────
        if slot >= 1:
            gpio = int(_PINMAP[slot]) if slot <= _GPIO_COUNT else slot
            with _sensors_lock:
                sensor = _sensors.get(gpio)
            if sensor is not None and sensor.get('type') == 'dht22':
                if direction == 1:
                    # OUTPUT mode — record timestamp for diagnostics
                    sensor['dir_out_ns'] = time.perf_counter_ns()
                elif direction == 0:
                    # INPUT mode — trigger DHT22 sync-based response
                    if sensor.get('saw_low', False) and not sensor.get('responding', False):
                        sensor['saw_low'] = False
                        sensor['responding'] = True

                        # Build the response waveform phases
                        temp = sensor.get('temperature', 25.0)
                        hum = sensor.get('humidity', 50.0)
                        payload = _dht22_build_payload(temp, hum)
                        phases = _dht22_build_sync_phases(payload)

                        # Drive pin LOW synchronously — firmware sees LOW
                        # at its first digitalRead() in expectPulse().
                        lib.qemu_picsimlab_set_pin(slot, 0)

                        # Arm the sync-based response state machine
                        _sync_handlers.append(DHT22SyncHandler(gpio, slot, phases))
                        _log(f'DHT22 sync armed gpio={gpio} '
                             f'temp={temp} hum={hum} '
                             f'phases={len(phases)} payload={payload}')
        gpio = int(_PINMAP[slot]) if 1 <= slot <= _GPIO_COUNT else slot
        _emit({'type': 'gpio_dir', 'pin': gpio, 'dir': direction})

    def _on_uart_tx(uart_id: int, byte_val: int) -> None:
        if _stopped.is_set():
            return
        _emit({'type': 'uart_tx', 'uart': uart_id, 'byte': byte_val})
        # Dispatch to any custom-chip runtimes that declared a UART.
        # The chip's on_rx_byte callback runs synchronously in this thread.
        for rt in _chip_uart_runtimes:
            try:
                rt.feed_uart_byte(byte_val)
            except Exception as e:
                _log(f'[custom-chip uart_tx] error: {e!r}')
        # Crash / reboot detection on UART0 only
        if uart_id == 0:
            _uart0_buf.append(byte_val)
            if byte_val == ord('\n') or len(_uart0_buf) >= 512:
                chunk = bytes(_uart0_buf)
                _uart0_buf.clear()
                if _CRASH_STR in chunk and not _crashed[0]:
                    _crashed[0] = True
                    _emit({'type': 'system', 'event': 'crash',
                           'reason': 'cache_error', 'reboot': _reboot_count[0]})
                if _REBOOT_STR in chunk:
                    _crashed[0] = False
                    _reboot_count[0] += 1
                    _emit({'type': 'system', 'event': 'reboot',
                           'count': _reboot_count[0]})
                # WiFi progress logging (only in debug — helps diagnose prod issues)
                if wifi_enabled:
                    line = chunk.decode('utf-8', errors='replace').strip()
                    if any(kw in line.lower() for kw in (
                        'wifi', 'connect', 'ip address', 'wl_connected',
                        'dhcp', 'sta_start', 'sta_got_ip', 'sta_disconnect',
                    )):
                        _log(f'[wifi-uart] {line}')

    def _on_rmt_event(channel: int, config0: int, value: int) -> None:
        if _stopped.is_set():
            return
        level0, dur0, level1, dur1 = _decode_rmt_item(value)
        _emit({'type': 'rmt_event', 'channel': channel, 'config0': config0,
               'value': value, 'level0': level0, 'dur0': dur0,
               'level1': level1, 'dur1': dur1})
        if channel not in _rmt_decoders:
            _rmt_decoders[channel] = _RmtDecoder(channel)
        pixels = _rmt_decoders[channel].feed(value)
        if pixels:
            _emit({'type': 'ws2812_update', 'channel': channel, 'pixels': pixels})

    # ── Per-slave I2C event counter (for logging) ─────────────────────────────
    _i2c_event_seq: dict = {}   # addr → event count

    _I2C_OP_NAME = {0x00: 'START_RECV', 0x01: 'START_SEND', 0x02: 'START_ASYNC',
                    0x03: 'FINISH',    0x04: 'NACK',
                    0x05: 'WRITE',     0x06: 'READ'}
    _MPU_REG_NAME = {
        0x19: 'SMPRT_DIV', 0x1A: 'CONFIG', 0x1B: 'GYRO_CFG', 0x1C: 'ACCEL_CFG',
        0x3B: 'AX_H', 0x3C: 'AX_L', 0x3D: 'AY_H', 0x3E: 'AY_L',
        0x3F: 'AZ_H', 0x40: 'AZ_L', 0x41: 'T_H',  0x42: 'T_L',
        0x43: 'GX_H', 0x44: 'GX_L', 0x45: 'GY_H', 0x46: 'GY_L',
        0x47: 'GZ_H', 0x48: 'GZ_L',
        0x6B: 'PWR_MGMT1', 0x68: 'SIG_RST', 0x75: 'WHO_AM_I',
    }

    def _on_i2c_event(bus_id: int, addr: int, event: int) -> int:
        """Synchronous — must return immediately; called from QEMU thread."""
        slave = _i2c_slaves.get(addr)
        op    = event & 0xFF
        data  = (event >> 8) & 0xFF
        op_name = _I2C_OP_NAME.get(op, f'0x{op:02x}')

        if slave is not None:
            result  = slave.handle_event(event)
            reg_ptr = getattr(slave, 'reg_ptr', 0)

            # Build descriptive annotation
            if op in (0x00, 0x01):   # START_RECV / START_SEND
                note = f'→ reg_ptr=0x{reg_ptr:02x}'
            elif op == 0x06:  # READ byte (actual data delivery to firmware)
                reg_nm = _MPU_REG_NAME.get((reg_ptr - 1) & 0xFF, f'0x{(reg_ptr-1)&0xFF:02x}')
                note = f'→ {reg_nm}=0x{result:02x}'
            elif op == 0x05:  # WRITE byte
                note = f'byte=0x{data:02x} → reg_ptr=0x{reg_ptr:02x}'
            else:
                note = ''

            if type(slave).__name__ == 'MPU6050Slave':
                seq = _i2c_event_seq
                n   = seq[addr] = seq.get(addr, 0) + 1
                _log(f'I2C #{n:03d} bus={bus_id} addr=0x{addr:02x} {op_name} {note}')
            else:
                _log(f'I2C bus={bus_id} addr=0x{addr:02x} event=0x{event:04x} '
                     f'op={op_name} result=0x{result:02x} slave={type(slave).__name__}')
            # Emit trace event to WebSocket so JS test can observe I2C traffic
            if not _stopped.is_set():
                _emit({'type': 'i2c_trace', 'bus': bus_id, 'addr': addr,
                       'event': event, 'op': op_name, 'result': result,
                       'reg_ptr': reg_ptr})
            return result

        _log(f'I2C bus={bus_id} addr=0x{addr:02x} event=0x{event:04x} op={op_name} '
             f'NO_SLAVE registered={list(_i2c_slaves.keys())}')
        resp = _i2c_responses.get(addr, 0)
        if not _stopped.is_set():
            _emit({'type': 'i2c_event', 'bus': bus_id, 'addr': addr,
                   'event': event, 'response': resp})

        # NACK on START_SEND / START_RECV when no slave responds. Real
        # I²C hardware NACKs by leaving SDA high during the ack slot;
        # the picsimlab_i2c bridge has been claiming every address and
        # returning ACK by default, which fooled drivers (notably the
        # esp32-camera SCCB auto-probe — it kept thinking 0x21 was a
        # valid OV7725 sensor and never advanced to 0x30 / OV2640).
        # Returning non-zero from the I2CSlave.event callback is the
        # QEMU convention for "I don't recognise this address".
        # An explicit override via _i2c_responses still wins so test
        # harnesses that register a fake response keep working.
        if op in (0x00, 0x01) and resp == 0 and addr not in _i2c_responses:
            return 1
        return resp

    def _on_spi_event(bus_id: int, event: int) -> int:
        """Synchronous — must return immediately; called from QEMU thread.

        Event encoding (picsimlab — see hw/ssi/picsimlab_spi.c and the CS irq
        handler in esp32_picsimlab.c):
            event = data << 8                                  → SPI byte transfer
                                                                 (op = low byte = 0x00,
                                                                  MOSI = high byte)
            event = ((((cs_idx & 3) << 1) | level) << 8) | 0x01 → CS line change
                                                                  (op = 0x01,
                                                                   ignored by chips
                                                                   that drive their own
                                                                   CS via pin_watch)
        """
        # Custom-chip SPI runtimes get first dibs on byte transfers. The chip's
        # pre-armed buffer holds the next MISO byte; the runtime overwrites it
        # with the master's MOSI byte and advances. on_done fires when count is
        # reached.
        op   = event & 0xFF
        mosi = (event >> 8) & 0xFF
        if _chip_spi_runtimes and op == 0x00:
            for rt in _chip_spi_runtimes:
                try:
                    return rt.spi_transfer_byte(mosi) & 0xFF
                except Exception as e:
                    _log(f'[custom-chip spi_event] error: {e!r}')

        # ePaper SSD168x panels — feed every byte to the active slave (CS LOW).
        # ePaper is write-only on MOSI; the panel uses BUSY for status, so we
        # always respond 0xFF on MISO. Multiple panels on the same bus would
        # both receive the byte, but the user's wiring + CS gating decide
        # which slave's `cs_low` is True.
        if _epaper_state and op == 0x00:
            any_active = False
            for st in _epaper_state.values():
                if st['cs_low']:
                    any_active = True
                    try:
                        st['slave'].feed(mosi, st['dc_high'])
                    except Exception as e:
                        _log(f'[epaper spi_event] error: {e!r}')
            if any_active:
                return 0xFF
        resp = _spi_response[0]
        if not _stopped.is_set():
            _emit({'type': 'spi_event', 'bus': bus_id, 'event': event, 'response': resp})
        return resp

    # Keep callback struct alive (prevent GC from freeing ctypes closures)
    _cbs_ref = _CallbacksT(
        picsimlab_write_pin     = _WRITE_PIN(_on_pin_change),
        picsimlab_dir_pin       = _DIR_PIN(_on_dir_change),
        picsimlab_i2c_event     = _I2C_EVENT(_on_i2c_event),
        picsimlab_spi_event     = _SPI_EVENT(_on_spi_event),
        picsimlab_uart_tx_event = _UART_TX(_on_uart_tx),
        pinmap                  = ctypes.cast(_PINMAP, ctypes.c_void_p).value,
        picsimlab_rmt_event     = _RMT_EVENT(_on_rmt_event),
    )
    lib.qemu_picsimlab_register_callbacks(ctypes.byref(_cbs_ref))

    # ── 6. QEMU thread ────────────────────────────────────────────────────────

    def _qemu_thread() -> None:
        try:
            lib.qemu_init(argc, argv, None)
        except Exception as exc:
            _emit({'type': 'error', 'message': f'qemu_init failed: {exc}'})
        finally:
            _init_done.set()
        # Wait for initial sensors to be pre-registered before executing firmware.
        # This prevents race conditions where the firmware tries to read a sensor
        # (e.g. DHT22 pulseIn) before the sensor handler is registered.
        _sensors_ready.wait(timeout=5.0)
        lib.qemu_main_loop()

    # With -nographic, qemu_init registers the stdio mux chardev which reads
    # from fd 0.  If we leave fd 0 as the JSON-command pipe from the parent,
    # QEMU's mux will consume those bytes and forward them to UART0 RX,
    # corrupting user-sent serial data.  Redirect fd 0 to /dev/null before
    # qemu_init runs so the mux gets EOF and leaves our command pipe alone.
    # Save the original pipe fd for the command loop below.
    _orig_stdin_fd = os.dup(0)
    _nul = os.open(os.devnull, os.O_RDONLY)
    os.dup2(_nul, 0)
    os.close(_nul)

    # Also redirect fd 1 (stdout) to /dev/null so QEMU's -nographic UART mux
    # doesn't write raw UART bytes onto our JSON event pipe.  Without this:
    #   1. Raw UART bytes prefix each JSON line, corrupting the protocol.
    #   2. On a busy host the pipe fills up, causing _on_uart_tx (called
    #      synchronously from qemu_main_loop) to block inside sys.stdout.flush(),
    #      which stalls qemu_main_loop() and prevents QEMU_CLOCK_REALTIME timers
    #      (including Esp32_WLAN_beacon_timer) from firing → WiFi never connects.
    # Save the real pipe fd and rebind sys.stdout so _emit() keeps working.
    import io as _io
    _orig_stdout_fd = os.dup(1)
    _nul_w = os.open(os.devnull, os.O_WRONLY)
    os.dup2(_nul_w, 1)
    os.close(_nul_w)
    sys.stdout = _io.TextIOWrapper(
        _io.FileIO(_orig_stdout_fd, mode='w', closefd=True),
        line_buffering=True,
        write_through=True,
    )

    qemu_t = threading.Thread(target=_qemu_thread, daemon=True, name=f'qemu-{machine}')
    qemu_t.start()

    if not _init_done.wait(timeout=30.0):
        _emit({'type': 'error', 'message': 'qemu_init timed out after 30 s'})
        os._exit(1)

    # Pre-register initial sensors before letting QEMU execute firmware.
    for s in initial_sensors:
        gpio = int(s.get('pin', 0))
        sensor_type = s.get('sensor_type', '')
        with _sensors_lock:
            sensor_data: dict = {
                'type': sensor_type,
                **{k: v for k, v in s.items() if k not in ('sensor_type', 'pin')},
                'saw_low': False,
                'responding': False,
            }
            # For I2C sensors, also create the slave state machine immediately
            # so _on_i2c_event can find it when the firmware's Wire.begin() runs.
            if sensor_type == 'mpu6050':
                i2c_addr = int(s.get('addr', 0x68))
                slave = _MPU6050Slave(i2c_addr)
                _i2c_slaves[i2c_addr] = slave
                sensor_data['i2c_addr'] = i2c_addr
                sensor_data['slave'] = slave
            elif sensor_type == 'bmp280':
                i2c_addr = int(s.get('addr', 0x76))
                slave = _BMP280Slave(i2c_addr)
                if 'temperature' in s: slave.update(float(s['temperature']), slave._press_hpa)
                if 'pressure'    in s: slave.update(slave._temp_c, float(s['pressure']))
                _i2c_slaves[i2c_addr] = slave
                sensor_data['i2c_addr'] = i2c_addr
                sensor_data['slave'] = slave
            elif sensor_type in ('ds1307', 'ds3231'):
                i2c_addr = int(s.get('addr', 0x68))
                slave = _DS3231Slave() if sensor_type == 'ds3231' else _DS1307Slave()
                _i2c_slaves[i2c_addr] = slave
                sensor_data['i2c_addr'] = i2c_addr
                sensor_data['slave'] = slave
            elif sensor_type == 'epaper-ssd168x':
                # ePaper SSD168x panel: backend decodes SPI traffic and emits
                # `epaper_update` events with the latched framebuffer.
                comp_id = str(s.get('component_id', f'epaper-{gpio}'))
                width = int(s.get('width', 200))
                height = int(s.get('height', 200))
                refresh_ms = int(s.get('refresh_ms', 50))
                busy_pin = int(s.get('busy_pin', -1))

                def _flush_factory(_comp_id=comp_id,
                                   _w=width, _h=height,
                                   _refresh=refresh_ms,
                                   _busy=busy_pin,
                                   _lib=lib):
                    """Build an on_flush callback bound to this slave's
                    component_id so the WS event can route to the right panel."""
                    def _on_flush(frame):
                        try:
                            frame_b64 = base64.b64encode(frame.pixels).decode('ascii')
                        except Exception:
                            return
                        _emit({
                            'type': 'epaper_update',
                            'data': {
                                'component_id': _comp_id,
                                'width': _w,
                                'height': _h,
                                'frame_b64': frame_b64,
                                'refresh_ms': _refresh,
                            },
                        })
                        # Drive BUSY high on the wired GPIO so firmware
                        # busy-wait loops see realistic timing. Falls LOW
                        # again after refresh_ms via a short timer.
                        if _busy is not None and _busy >= 0:
                            try:
                                _lib.qemu_picsimlab_set_pin(_busy + 1, 1)

                                def _busy_low(_b=_busy):
                                    try:
                                        _lib.qemu_picsimlab_set_pin(_b + 1, 0)
                                    except Exception:
                                        pass

                                threading.Timer(_refresh / 1000.0, _busy_low).start()
                            except Exception:
                                pass
                    return _on_flush

                # Pick the decoder family from the payload. Defaults to
                # SSD168x for backward compatibility (initial frontends only
                # sent SSD168x); the UC8159c value is sent for ACeP panels.
                ctl_family = str(s.get('controller_family', 'ssd168x'))
                if ctl_family == 'uc8159c':
                    slave = _Uc8159cEpaperSlave(
                        component_id=comp_id, width=width, height=height,
                        on_flush=_flush_factory(),
                    )
                else:
                    slave = _Ssd168xEpaperSlave(
                        component_id=comp_id, width=width, height=height,
                        on_flush=_flush_factory(),
                    )
                state = {
                    'slave': slave,
                    'dc_pin': int(s.get('dc_pin', -1)),
                    'cs_pin': int(s.get('cs_pin', -1)),
                    'rst_pin': int(s.get('rst_pin', -1)),
                    'busy_pin': busy_pin,
                    'cs_low': False,
                    'dc_high': False,
                    'refresh_ms': refresh_ms,
                    'controller_family': ctl_family,
                }
                _epaper_slaves[comp_id] = slave
                _epaper_state[comp_id] = state
                sensor_data['epaper_component_id'] = comp_id
                _log(f"[epaper:{ctl_family}] registered '{comp_id}' "
                     f"({width}x{height}) "
                     f"DC={state['dc_pin']} CS={state['cs_pin']} "
                     f"RST={state['rst_pin']} BUSY={state['busy_pin']}")
            elif sensor_type in ('ssd1306', 'pcf8574'):
                default_addr = 0x3C if sensor_type == 'ssd1306' else 0x27
                i2c_addr = int(s.get('addr', default_addr))
                sink = _I2CWriteSink(i2c_addr, _emit)
                _i2c_slaves[i2c_addr] = sink
                sensor_data['i2c_addr'] = i2c_addr
                sensor_data['slave'] = sink
            elif sensor_type == 'custom-chip':
                # User-supplied chip compiled to WASM. The runtime loads the
                # binary in this same Python process so I2C callbacks fire
                # synchronously when QEMU calls _on_i2c_event — same fidelity
                # as the hardcoded slaves above.
                # See docs/wiki/custom-chips-esp32-backend-runtime.md
                try:
                    from app.services.wasm_chip_runtime import WasmChipRuntime
                    from app.services.wasm_chip_slave   import WasmChipI2CSlave
                except ImportError:
                    # Fallback: same pattern as esp32_i2c_slaves at the top of
                    # this file. The worker subprocess may run from a cwd that
                    # doesn't have `app.services` on sys.path.
                    import importlib.util, pathlib as _pl
                    _here = _pl.Path(__file__).parent
                    _spec_rt = importlib.util.spec_from_file_location(
                        'wasm_chip_runtime', _here / 'wasm_chip_runtime.py'
                    )
                    _mod_rt = importlib.util.module_from_spec(_spec_rt)
                    _spec_rt.loader.exec_module(_mod_rt)
                    WasmChipRuntime = _mod_rt.WasmChipRuntime
                    _spec_sl = importlib.util.spec_from_file_location(
                        'wasm_chip_slave', _here / 'wasm_chip_slave.py'
                    )
                    _mod_sl = importlib.util.module_from_spec(_spec_sl)
                    # The slave module imports from app.services.wasm_chip_runtime;
                    # patch sys.modules so that import resolves to our loaded module.
                    sys.modules['app.services.wasm_chip_runtime'] = _mod_rt
                    _spec_sl.loader.exec_module(_mod_sl)
                    WasmChipI2CSlave = _mod_sl.WasmChipI2CSlave
                wasm_b64 = s.get('wasm_b64', '')
                if not wasm_b64:
                    _log("[custom-chip] missing wasm_b64 in sensor payload")
                else:
                    try:
                        wasm_bytes = base64.b64decode(wasm_b64)
                        attrs      = s.get('attrs', {}) or {}
                        pin_map    = s.get('pin_map', {}) or {}

                        # ── Plumbing: hook the runtime to QEMU's live peripherals ──
                        # GPIO output: chip's vx_pin_write → qemu_picsimlab_set_pin
                        def _chip_pin_writer(gpio: int, value: int, _lib=lib):
                            _lib.qemu_picsimlab_set_pin(gpio + 1, value)

                        # GPIO input: chip reads current QEMU pin state.
                        def _chip_pin_reader(gpio: int, _store=_pin_state):
                            return int(_store.get(gpio, 0)) & 1

                        # UART RX: chip's vx_uart_write → inject bytes into firmware UART.
                        # Acquire the iothread lock ONLY if we don't already hold it
                        # (typical case: the chip's vx_uart_write is fired from inside
                        # _on_uart_tx, which is already in the QEMU thread holding the
                        # lock — re-acquiring there triggers an assertion).
                        def _chip_uart_writer(uart_id: int, data: bytes,
                                              _lib=lib,
                                              _lock=_lock_iothread,
                                              _unlock=_unlock_iothread,
                                              _is_locked=_iothread_locked):
                            buf = (ctypes.c_uint8 * len(data))(*data)
                            need_lock = bool(_lock) and (not _is_locked or not _is_locked())
                            if need_lock:
                                _lock(b'esp32_worker.py:custom-chip', 0)
                            try:
                                _lib.qemu_picsimlab_uart_receive(int(uart_id), buf, len(data))
                            finally:
                                if need_lock and _unlock:
                                    _unlock()

                        # Timer arm: just track this runtime so the scheduler thread
                        # picks up the new deadline on its next iteration.
                        def _chip_timer_scheduler(rt):
                            if rt not in _chip_timer_runtimes:
                                _chip_timer_runtimes.append(rt)

                        runtime = WasmChipRuntime(
                            wasm_bytes, attrs, _emit,
                            pin_map=pin_map,
                            pin_writer=_chip_pin_writer,
                            pin_reader=_chip_pin_reader,
                            uart_writer=_chip_uart_writer,
                            timer_scheduler=_chip_timer_scheduler,
                        )
                        runtime.run_chip_setup()

                        if runtime.i2c_address is not None:
                            slave = WasmChipI2CSlave(runtime.i2c_address, runtime)
                            _i2c_slaves[runtime.i2c_address] = slave
                            sensor_data['i2c_addr'] = runtime.i2c_address
                            sensor_data['slave']    = slave
                            _log(f"[custom-chip] I2C slave registered at 0x{runtime.i2c_address:02x}")
                        if runtime.uart_config is not None:
                            _chip_uart_runtimes.append(runtime)
                            _log("[custom-chip] UART chip registered on UART0")
                        if runtime.spi_config is not None:
                            _chip_spi_runtimes.append(runtime)
                            _log("[custom-chip] SPI chip registered")
                        if runtime.has_pin_watches():
                            _chip_pin_watch_runtimes.append(runtime)
                            _log(f"[custom-chip] pin watches registered: {list(runtime._pin_watches.keys())}")
                        if (runtime.i2c_address is None and runtime.uart_config is None
                                and runtime.spi_config is None):
                            _log("[custom-chip] WASM loaded but no I2C/UART/SPI peripherals declared "
                                 "— chip is GPIO-only")
                        sensor_data['runtime'] = runtime
                    except Exception as e:
                        _log(f"[custom-chip] failed to load: {e!r}")
            _sensors[gpio] = sensor_data
    _sensors_ready.set()
    _log(f'_i2c_slaves registered: {list(_i2c_slaves.keys())}')

    _emit({'type': 'system', 'event': 'booted'})
    _log(f'QEMU started: machine={machine} firmware={firmware_path}')
    _log(f'QEMU args: {[a.decode() for a in args_list]}')

    # ── 6.5 Custom-chip timer thread ──────────────────────────────────────────
    # Wakes on each chip's next_timer_deadline. Acquires the QEMU IO-thread lock
    # before firing callbacks because vx_pin_write inside a timer would touch
    # picsimlab_set_pin which requires the lock.
    def _chip_timer_thread() -> None:
        while not _stopped.is_set():
            # Find the soonest deadline across all chips with active timers.
            soonest_ns: int | None = None
            for rt in list(_chip_timer_runtimes):
                d = rt.next_timer_deadline()
                if d is not None and (soonest_ns is None or d < soonest_ns):
                    soonest_ns = d
            if soonest_ns is None:
                # No active timers — sleep a bit and re-check.
                _stopped.wait(0.050)
                continue
            now_ns = time.monotonic_ns() - _t0_ref[0]
            wait_ns = max(0, soonest_ns - now_ns)
            if wait_ns > 0:
                _stopped.wait(wait_ns / 1e9)
                if _stopped.is_set():
                    break
            # Fire under the IO-thread lock so any pin_write the timer triggers is safe.
            if _lock_iothread:
                _lock_iothread(b'esp32_worker.py:chip_timer', 0)
            try:
                for rt in list(_chip_timer_runtimes):
                    try:
                        rt.fire_due_timers()
                    except Exception as e:
                        _log(f'[custom-chip timer] error: {e!r}')
            finally:
                if _unlock_iothread:
                    _unlock_iothread()

    _t0_ref = [time.monotonic_ns()]   # used so the timer thread can compute "now"
    _timer_t = threading.Thread(target=_chip_timer_thread, daemon=True, name='chip-timer')
    _timer_t.start()

    # ── 7. LEDC polling thread (100 ms interval) ──────────────────────────────

    def _ledc_poll_thread() -> None:
        # Track last-emitted duty to avoid flooding identical updates
        _last_duty = [0.0] * 16
        while not _stopped.wait(0.1):
            try:
                ptr = lib.qemu_picsimlab_get_internals(6)  # LEDC_CHANNEL_DUTY
                if ptr is None or ptr == 0:
                    continue
                arr = (ctypes.c_float * 16).from_address(ptr)
                _refresh_ledc_gpio_map()
                for ch in range(16):
                    duty_pct = float(arr[ch])
                    if abs(duty_pct - _last_duty[ch]) < 0.01:
                        continue
                    _last_duty[ch] = duty_pct
                    if duty_pct > 0:
                        gpio = _ledc_gpio_map.get(ch, -1)
                        _emit({'type': 'ledc_update', 'channel': ch,
                               'duty': round(duty_pct, 2),
                               'duty_pct': round(duty_pct, 2),
                               'gpio': gpio})
            except Exception:
                pass

    threading.Thread(target=_ledc_poll_thread, daemon=True, name='ledc-poll').start()

    # ── 8. Command loop (main thread reads original stdin pipe) ───────────────

    for raw_line in os.fdopen(_orig_stdin_fd, 'r'):
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        try:
            cmd = json.loads(raw_line)
        except Exception:
            continue

        c = cmd.get('cmd', '')

        if c == 'set_pin':
            # Identity pinmap: slot = gpio_num + 1
            lib.qemu_picsimlab_set_pin(int(cmd['pin']) + 1, int(cmd['value']))

        elif c == 'set_adc':
            raw_v = int(int(cmd['millivolts']) * 4095 / 3300)
            ch = int(cmd['channel'])
            clamped = max(0, min(4095, raw_v))
            lib.qemu_picsimlab_set_apin(ch, clamped)

        elif c == 'set_adc_raw':
            lib.qemu_picsimlab_set_apin(int(cmd['channel']),
                                        max(0, min(4095, int(cmd['raw']))))

        elif c == 'set_adc_waveform':
            # Push a periodic 12-bit waveform LUT to QEMU so the SAR ADC
            # peripheral can interpolate against its virtual clock on every
            # MMIO read. Matches the per-read fidelity of AVR/RP2040.
            #
            # libqemu-xtensa must export `qemu_picsimlab_set_apin_waveform`;
            # if not (older binary), silently downgrade to a single-sample
            # `set_apin` so circuits with waveforms still produce *something*.
            try:
                ch = int(cmd['channel'])
                b64 = cmd.get('samples_u12_b64', '') or ''
                period_ns = int(cmd.get('period_ns', 0))
                if b64 and period_ns > 0 and hasattr(lib, 'qemu_picsimlab_set_apin_waveform'):
                    raw = base64.b64decode(b64)
                    # Samples are little-endian uint16. Allocate a C buffer and
                    # hand QEMU a pointer; the waveform setter copies the data
                    # internally.
                    n = len(raw) // 2
                    if n > 0:
                        arr_type = ctypes.c_uint16 * n
                        arr = arr_type.from_buffer_copy(raw[:n * 2])
                        lib.qemu_picsimlab_set_apin_waveform(
                            ch,
                            arr,
                            ctypes.c_int(n),
                            ctypes.c_uint64(period_ns),
                        )
                else:
                    # Clear waveform: fall back to last-known DC value (no-op if
                    # the API isn't available — QEMU just keeps whatever was
                    # last written via `set_apin`).
                    if hasattr(lib, 'qemu_picsimlab_set_apin_waveform'):
                        lib.qemu_picsimlab_set_apin_waveform(
                            ch, None, ctypes.c_int(0), ctypes.c_uint64(0)
                        )
            except Exception as err:
                # Never let an ADC-waveform failure kill the worker — log to
                # stderr and keep the guest running with its last DC sample.
                print(f'[esp32_worker] set_adc_waveform failed: {err}',
                      file=sys.stderr, flush=True)

        elif c == 'uart_send':
            data = base64.b64decode(cmd['data'])
            buf  = (ctypes.c_uint8 * len(data))(*data)
            # Must hold the QEMU IO-thread lock: uart_receive injects a UART-RX
            # interrupt into the guest CPU and QEMU asserts the lock is held.
            if _lock_iothread:
                _lock_iothread(b'esp32_worker.py', 0)
            try:
                lib.qemu_picsimlab_uart_receive(
                    int(cmd.get('uart', 0)), buf, len(data)
                )
            finally:
                if _unlock_iothread:
                    _unlock_iothread()

        elif c == 'set_i2c_response':
            _i2c_responses[int(cmd['addr'])] = int(cmd['response']) & 0xFF

        elif c == 'set_spi_response':
            _spi_response[0] = int(cmd['response']) & 0xFF

        elif c == 'sensor_attach':
            gpio = int(cmd['pin'])
            sensor_type = cmd.get('sensor_type', '')
            with _sensors_lock:
                sensor_data: dict = {
                    'type': sensor_type,
                    **{k: v for k, v in cmd.items()
                       if k not in ('cmd', 'pin', 'sensor_type')},
                    'saw_low': False,
                    'responding': False,
                }
                if sensor_type == 'mpu6050':
                    i2c_addr = int(cmd.get('addr', 0x68))
                    slave = _MPU6050Slave(i2c_addr)
                    _i2c_slaves[i2c_addr] = slave
                    sensor_data['i2c_addr'] = i2c_addr
                    sensor_data['slave'] = slave
                elif sensor_type == 'bmp280':
                    i2c_addr = int(cmd.get('addr', 0x76))
                    slave = _BMP280Slave(i2c_addr)
                    _i2c_slaves[i2c_addr] = slave
                    sensor_data['i2c_addr'] = i2c_addr
                    sensor_data['slave'] = slave
                elif sensor_type in ('ds1307', 'ds3231'):
                    i2c_addr = int(cmd.get('addr', 0x68))
                    slave = _DS3231Slave() if sensor_type == 'ds3231' else _DS1307Slave()
                    _i2c_slaves[i2c_addr] = slave
                    sensor_data['i2c_addr'] = i2c_addr
                    sensor_data['slave'] = slave
                elif sensor_type in ('ssd1306', 'pcf8574'):
                    default_addr = 0x3C if sensor_type == 'ssd1306' else 0x27
                    i2c_addr = int(cmd.get('addr', default_addr))
                    sink = _I2CWriteSink(i2c_addr, _emit)
                    _i2c_slaves[i2c_addr] = sink
                    sensor_data['i2c_addr'] = i2c_addr
                    sensor_data['slave'] = sink
                elif sensor_type == 'epaper-ssd168x':
                    # Runtime registration of an SSD168x ePaper panel. Mirrors
                    # the `_init_sensors` branch above. Component-id keyed so
                    # multiple panels on the same board route correctly.
                    comp_id = str(cmd.get('component_id', f'epaper-{gpio}'))
                    width = int(cmd.get('width', 200))
                    height = int(cmd.get('height', 200))
                    refresh_ms = int(cmd.get('refresh_ms', 50))
                    busy_pin = int(cmd.get('busy_pin', -1))

                    def _flush_factory_rt(_comp_id=comp_id,
                                          _w=width, _h=height,
                                          _refresh=refresh_ms,
                                          _busy=busy_pin,
                                          _lib=lib):
                        def _on_flush(frame):
                            try:
                                frame_b64 = base64.b64encode(frame.pixels).decode('ascii')
                            except Exception:
                                return
                            _emit({
                                'type': 'epaper_update',
                                'data': {
                                    'component_id': _comp_id,
                                    'width': _w,
                                    'height': _h,
                                    'frame_b64': frame_b64,
                                    'refresh_ms': _refresh,
                                },
                            })
                            if _busy is not None and _busy >= 0:
                                try:
                                    _lib.qemu_picsimlab_set_pin(_busy + 1, 1)

                                    def _busy_low(_b=_busy):
                                        try:
                                            _lib.qemu_picsimlab_set_pin(_b + 1, 0)
                                        except Exception:
                                            pass

                                    threading.Timer(_refresh / 1000.0, _busy_low).start()
                                except Exception:
                                    pass
                        return _on_flush

                    ctl_family = str(cmd.get('controller_family', 'ssd168x'))
                    if ctl_family == 'uc8159c':
                        slave = _Uc8159cEpaperSlave(
                            component_id=comp_id, width=width, height=height,
                            on_flush=_flush_factory_rt(),
                        )
                    else:
                        slave = _Ssd168xEpaperSlave(
                            component_id=comp_id, width=width, height=height,
                            on_flush=_flush_factory_rt(),
                        )
                    state = {
                        'slave': slave,
                        'dc_pin': int(cmd.get('dc_pin', -1)),
                        'cs_pin': int(cmd.get('cs_pin', -1)),
                        'rst_pin': int(cmd.get('rst_pin', -1)),
                        'busy_pin': busy_pin,
                        'cs_low': False,
                        'dc_high': False,
                        'refresh_ms': refresh_ms,
                        'controller_family': ctl_family,
                    }
                    _epaper_slaves[comp_id] = slave
                    _epaper_state[comp_id] = state
                    sensor_data['epaper_component_id'] = comp_id
                _sensors[gpio] = sensor_data
            _log(f'Sensor {sensor_type} attached on GPIO {gpio}')

        elif c == 'sensor_update':
            gpio = int(cmd['pin'])
            with _sensors_lock:
                sensor = _sensors.get(gpio)
                if sensor:
                    for k, v in cmd.items():
                        if k not in ('cmd', 'pin'):
                            sensor[k] = v
                    stype = sensor.get('type')
                    slave = sensor.get('slave')
                    if stype == 'mpu6050' and slave is not None:
                        slave.update(
                            accel_x=float(sensor.get('accelX', 0)),
                            accel_y=float(sensor.get('accelY', 0)),
                            accel_z=float(sensor.get('accelZ', 1)),
                            gyro_x =float(sensor.get('gyroX',  0)),
                            gyro_y =float(sensor.get('gyroY',  0)),
                            gyro_z =float(sensor.get('gyroZ',  0)),
                            temp   =float(sensor.get('temp',   25.0)),
                        )
                    elif stype == 'bmp280' and slave is not None:
                        slave.update(
                            temperature_c =float(sensor.get('temperature', 25.0)),
                            pressure_hpa  =float(sensor.get('pressure', 1013.25)),
                        )
                    elif stype == 'ds3231' and slave is not None:
                        slave.temperatureC = float(sensor.get('temperature', 25.0))

        elif c == 'sensor_detach':
            gpio = int(cmd['pin'])
            with _sensors_lock:
                sensor = _sensors.pop(gpio, None)
                if sensor and 'i2c_addr' in sensor:
                    _i2c_slaves.pop(sensor['i2c_addr'], None)
                if sensor and 'epaper_component_id' in sensor:
                    cid = sensor['epaper_component_id']
                    _epaper_slaves.pop(cid, None)
                    _epaper_state.pop(cid, None)
            _log(f'Sensor detached from GPIO {gpio}')

        # ── ESP32-CAM frame injection ────────────────────────────────────
        # Pushes a JPEG (or other format) into the QEMU OV2640 device's
        # frame buffer via the velxio_push_camera_frame() symbol exported
        # by the rebuilt libqemu-xtensa. Feature-detected at runtime so
        # this branch is a no-op on a stock library.
        elif c == 'camera_attach':
            _log('camera_attach received (frame source ready)')

        elif c == 'camera_frame':
            try:
                payload = base64.b64decode(cmd.get('b64', ''))
            except Exception as exc:
                _log(f'camera_frame: bad base64: {exc}')
                payload = b''
            # Throttled trace — log every 30th frame so noisy streaming
            # leaves a footprint in the lib_manager log without spamming.
            _camera_frame_count[0] += 1
            n = _camera_frame_count[0]
            if n == 1 or n % 30 == 0:
                _log(f'camera_frame #{n} received ({len(payload)} bytes payload)')
            if payload:
                _push_camera_frame(payload)

        elif c == 'camera_detach':
            _push_camera_frame(b'')   # NULL/0 detaches in the C side

        elif c == 'stop':
            _stopped.set()
            # Request a clean shutdown via the QEMU main-loop thread.
            # qemu_system_shutdown_request() is safe to call from any thread:
            # it posts an event to the main loop which then tears down block
            # devices in the correct AIO context, avoiding the
            # "blk_exp_close_all_type: in_aio_context_home_thread" assertion
            # that fires when qemu_cleanup() is called directly from here.
            if _shutdown_request:
                try:
                    _shutdown_request(3)   # SHUTDOWN_CAUSE_HOST_SIGNAL = 3
                except Exception:
                    pass
            qemu_t.join(timeout=5.0)
            # Clean up temp firmware file
            if firmware_path:
                try:
                    os.unlink(firmware_path)
                except OSError:
                    pass
            os._exit(0)


if __name__ == '__main__':
    main()
