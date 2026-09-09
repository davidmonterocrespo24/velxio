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
               {"type": "gpio_pull",    "pin": N,  "pull": V}   # 0=none 1=up 2=down
               {"type": "uart_tx",      "uart": N, "byte": V}
               {"type": "ledc_duty",    "channel": N, "duty_pct": F}
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
import queue
import re
import sys
import tempfile
import threading
import time

# DHT22 reply model: what arms it and how the frame is paced on the guest's
# clock (issue #291). Same fallback dance as the slave modules below.
try:
    from app.services.esp32_dht22 import (
        Dht22Reply as _Dht22Reply,
        Dht22Trigger as _Dht22Trigger,
        coerce_number as _dht22_num,
        dht22_payload as _dht22_payload_bytes,
        dht11_payload as _dht11_payload_bytes,
        dht22_phases as _dht22_phases,
    )
except ImportError:
    import importlib.util as _ilu_dht, pathlib as _pl_dht, sys as _sys_dht
    _spec_dht = _ilu_dht.spec_from_file_location(
        'esp32_dht22', _pl_dht.Path(__file__).parent / 'esp32_dht22.py')
    _mod_dht = _ilu_dht.module_from_spec(_spec_dht)  # type: ignore[arg-type]
    _sys_dht.modules['esp32_dht22'] = _mod_dht
    _spec_dht.loader.exec_module(_mod_dht)  # type: ignore[union-attr]
    _Dht22Reply = _mod_dht.Dht22Reply            # type: ignore[assignment]
    _Dht22Trigger = _mod_dht.Dht22Trigger        # type: ignore[assignment]
    _dht22_num = _mod_dht.coerce_number          # type: ignore[assignment]
    _dht22_payload_bytes = _mod_dht.dht22_payload  # type: ignore[assignment]
    _dht11_payload_bytes = _mod_dht.dht11_payload  # type: ignore[assignment]
    _dht22_phases = _mod_dht.dht22_phases        # type: ignore[assignment]

# IR envelope model: the demodulator's output, paced in real guest time (the
# DHT22 player's per-read cap is wrong for a 50 us sampling ISR — see
# esp32_ir.py). Same fallback dance as above.
try:
    from app.services.esp32_ir import (
        IrReply as _IrReply,
        envelope_phases as _ir_envelope_phases,
        nec_pulses as _ir_nec_pulses,
    )
except ImportError:
    import importlib.util as _ilu_ir, pathlib as _pl_ir, sys as _sys_ir
    _spec_ir = _ilu_ir.spec_from_file_location(
        'esp32_ir', _pl_ir.Path(__file__).parent / 'esp32_ir.py')
    _mod_ir = _ilu_ir.module_from_spec(_spec_ir)  # type: ignore[arg-type]
    _sys_ir.modules['esp32_ir'] = _mod_ir
    _spec_ir.loader.exec_module(_mod_ir)  # type: ignore[union-attr]
    _IrReply = _mod_ir.IrReply                       # type: ignore[assignment]
    _ir_envelope_phases = _mod_ir.envelope_phases    # type: ignore[assignment]
    _ir_nec_pulses = _mod_ir.nec_pulses              # type: ignore[assignment]

# I2C slave state machines — extracted to a standalone module for testability
try:
    from app.services.esp32_i2c_slaves import (
        MPU6050Slave as _MPU6050Slave,
        BMP280Slave  as _BMP280Slave,
        DS1307Slave  as _DS1307Slave,
        DS3231Slave  as _DS3231Slave,
        I2CWriteSink as _I2CWriteSink,
        ProxySlave   as _ProxySlave,
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
    _ProxySlave   = _mod.ProxySlave    # type: ignore[assignment]

# SPI slaves (Phase 1: SSD168x ePaper). Same fallback dance — when the worker
# runs as a subprocess from backend/ the package import won't resolve.
try:
    from app.services.esp32_spi_slaves import (
        Ssd168xEpaperSlave as _Ssd168xEpaperSlave,
        Uc8159cEpaperSlave as _Uc8159cEpaperSlave,
        Uc8179EpaperSlave as _Uc8179EpaperSlave,
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
    _Uc8179EpaperSlave = _mod.Uc8179EpaperSlave  # type: ignore[assignment]

# microSD SD-over-SPI slave (synchronous, returns MISO per byte). Same fallback.
try:
    from app.services.esp32_sd_slave import SdSpiSlave as _SdSpiSlave
except ImportError:
    import importlib.util as _ilu_sd, pathlib as _pl_sd, sys as _sys_sd
    _spec_sd = _ilu_sd.spec_from_file_location(
        'esp32_sd_slave', _pl_sd.Path(__file__).parent / 'esp32_sd_slave.py')
    _mod_sd = _ilu_sd.module_from_spec(_spec_sd)  # type: ignore[arg-type]
    _sys_sd.modules['esp32_sd_slave'] = _mod_sd
    _spec_sd.loader.exec_module(_mod_sd)  # type: ignore[union-attr]
    _SdSpiSlave = _mod_sd.SdSpiSlave  # type: ignore[assignment]

# ─── stdout helpers ──────────────────────────────────────────────────────────

_stdout_lock = threading.Lock()

# _emit is called from QEMU callback context (the iothread — _on_uart_tx fires
# per UART byte). A blocking stdout write there freezes the ENTIRE guest when
# the parent's pipe fills (64 KB) because the reader stalls: observed as an
# intermittent boot hang right after the ROM log (~the point where the
# accumulated JSON events cross the pipe capacity). Decouple with a bounded
# queue + dedicated writer thread so QEMU never blocks on stdout. Under
# extreme backpressure we drop events (counted, reported on stderr) — losing
# telemetry beats freezing the emulated CPU.
_emit_q: 'queue.Queue[dict | None]' = queue.Queue(maxsize=20000)
_emit_dropped = 0


def _emit(obj: dict) -> None:
    """Queue one JSON event line for stdout (never blocks QEMU callbacks)."""
    global _emit_dropped
    try:
        _emit_q.put_nowait(obj)
    except queue.Full:
        _emit_dropped += 1
        if _emit_dropped % 1000 == 1:
            sys.stderr.write(f'[esp32_worker] WARNING: stdout backpressure, '
                             f'{_emit_dropped} events dropped\n')
            sys.stderr.flush()


def _emit_writer_loop() -> None:
    """Drain the event queue to stdout. Runs on its own thread for the whole
    worker lifetime; a None sentinel (posted at shutdown) ends the loop."""
    while True:
        obj = _emit_q.get()
        if obj is None:
            return
        lines = [json.dumps(obj)]
        done = False
        # Opportunistically batch whatever else is queued into one write.
        try:
            while True:
                nxt = _emit_q.get_nowait()
                if nxt is None:
                    done = True
                    break
                lines.append(json.dumps(nxt))
        except queue.Empty:
            pass
        with _stdout_lock:
            sys.stdout.write('\n'.join(lines) + '\n')
            sys.stdout.flush()
        if done:
            return


threading.Thread(target=_emit_writer_loop, name='emit-writer', daemon=True).start()


def _log(msg: str) -> None:
    """Write a debug message to stderr (invisible to parent's stdout reader)."""
    sys.stderr.write(f'[esp32_worker] {msg}\n')
    sys.stderr.flush()


# ─── GPIO pinmap (identity: slot i → GPIO i-1) ──────────────────────────────
# ESP32 has 40 GPIOs (0-39), ESP32-C3 only has 22 (0-21).
# The pinmap is rebuilt after reading config (see main()), defaulting to ESP32.

# QEMU machines whose SoC model instantiates a WiFi MAC. The S3 machine does
# not (hw/xtensa/esp32s3.c never calls qemu_find_nic_info), so it must not be
# handed a NIC — see the radio block in start().
_WIFI_MACHINES = {'esp32-picsimlab'}


# The classic ESP32's WiFi MAC, at its DPORT address and at the APB alias the
# IDF driver actually uses (0x3ff73000 - DR_REG_DPORT_APB_BASE + APB_REG_BASE).
# One page each, matching the region hw/misc/esp32_wifi.c maps.
_WIFI_MAC_RANGES = ((0x3ff73000, 0x3ff74000), (0x60033000, 0x60034000))


def wifi_nic_arg(machine: str, wifi_enabled: bool,
                 hostfwd_port: int = 0) -> str | None:
    """The `-nic` value for this machine, or None if it models no radio.

    The radio is attached whether or not the sketch appears to use it, because
    a real ESP32 has one either way. It used to be conditional on wifi_enabled,
    which made a source-scanning GUESS load-bearing: the fork only instantiates
    the MAC when a NIC is present (`qemu_find_nic_info(TYPE_ESP32_WIFI)` in
    hw/xtensa/esp32.c), so a sketch the scanner misread as WiFi-less ran on a
    machine with nothing mapped at DR_REG_WIFI_BASE. The firmware's first
    register touch then took an unmapped-peripheral fault — `Guru Meditation
    Error (LoadStorePIFAddrError)`, EXCVADDR 0x60033c00 — which reads as a
    Velxio crash and says nothing about WiFi. That is issue #260, and one bad
    guess was all it took.

    Measured before making it unconditional, on a sketch that never touches
    WiFi: boot time, guest-clock-vs-real-time and container CPU all unchanged
    over 4 paired runs. The AP's beacon timer runs on QEMU_CLOCK_REALTIME —
    the reason -icount is off for Xtensa — but idle beacons cost nothing here.

    `wifi_enabled` still gates the host forward, which exposes the GUEST's
    server to the host and so belongs to a sketch that actually serves.
    """
    if 'c3' in machine:
        model = 'esp32c3_wifi'
    elif machine in _WIFI_MACHINES:
        model = 'esp32_wifi'
    else:
        # The S3 machine models no radio (hw/xtensa/esp32s3.c never looks for
        # the NIC), so handing it one would leave an unconsumed netdev.
        return None
    arg = f'user,model={model},net=192.168.4.0/24'
    if wifi_enabled and hostfwd_port:
        arg += f',hostfwd=tcp::{hostfwd_port}-192.168.4.15:80'
    return arg


def _explain_pif_fault(chunk: bytes) -> str | None:
    """Turn a LoadStorePIFAddrError dump into a sentence about what it means.

    The panic reports an address and nothing else, so a user reading it has no
    way to know the chip was reaching for a peripheral this machine does not
    model. A week of debugging went into issue #260 for exactly that reason.
    Returns the line to print once EXCVADDR has been seen, or None if this
    chunk does not carry it yet.
    """
    m = re.search(rb'EXCVADDR\s*:\s*0x([0-9a-fA-F]+)', chunk)
    if not m:
        return None
    addr = int(m.group(1), 16)
    where = ('the WiFi MAC' if any(lo <= addr < hi for lo, hi in _WIFI_MAC_RANGES)
             else 'a peripheral')
    return (f'\r\n[velxio] That panic is not a bug in your sketch: the firmware '
            f'read {where} at 0x{addr:08x}, which this emulated machine does not '
            f'provide. Nothing is mapped there, so the CPU faulted.\r\n')


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
# Synchronous GPIO Matrix routing callback. Fires on every guest write
# to GPIO_FUNCx_OUT_SEL_CFG_REG with the full 9-bit signal_id; replaces
# the 100 ms poll path in _refresh_signal_routing() once the prod
# burn-in window confirms parity. Requires libqemu-{xtensa,riscv32}
# 1.1.0+; older binaries omit the field and the placeholder runs.
_GPIO_MATRIX_CB = ctypes.CFUNCTYPE(None,        ctypes.c_int, ctypes.c_int)
# Batched write-only SPI: (id, const uint8_t *mosi, int len). Collapses the
# per-byte picsimlab_spi_event ctypes crossing for TFT-style bulk writes.
# Trailing field — older libqemu builds (without the C-side batch path) simply
# never call it and fall back to per-byte picsimlab_spi_event.
_SPI_BATCH = ctypes.CFUNCTYPE(None, ctypes.c_uint8, ctypes.POINTER(ctypes.c_uint8), ctypes.c_int)


class _CallbacksT(ctypes.Structure):
    _fields_ = [
        ('picsimlab_write_pin',         _WRITE_PIN),
        ('picsimlab_dir_pin',           _DIR_PIN),
        ('picsimlab_i2c_event',         _I2C_EVENT),
        ('picsimlab_spi_event',         _SPI_EVENT),
        ('picsimlab_uart_tx_event',     _UART_TX),
        ('pinmap',                      ctypes.c_void_p),
        ('picsimlab_rmt_event',         _RMT_EVENT),
        ('picsimlab_gpio_matrix_cb',    _GPIO_MATRIX_CB),
        ('picsimlab_spi_event_batch',   _SPI_BATCH),
    ]


# ─── RMT / WS2812 NeoPixel decoder ───────────────────────────────────────────

def _decode_rmt_item(value: int) -> tuple[int, int, int, int]:
    """Unpack a 32-bit RMT item → (level0, duration0, level1, duration1).

    The layout is duration0[14:0], level0[15], duration1[30:16], level1[31] —
    duration0 lives in the LOW half (IDF's rmt_symbol_word_t, and the legacy
    rmt_item32_t before it). The two halves used to be read mirrored, so on a
    WS2812 symbol — whose second half is always the low period, level1 = 0 —
    `level0` came out 0 for every item and the bit classifier below, which is
    gated on level0 == 1, never appended a single bit.
    """
    duration0 =  value        & 0x7FFF
    level0    = (value >> 15) & 1
    duration1 = (value >> 16) & 0x7FFF
    level1    = (value >> 31) & 1
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
        level0, dur0, _level1, dur1 = _decode_rmt_item(value)

        # Reset pulse (both durations zero) signals end of frame
        if dur0 == 0 and dur1 == 0:
            pix = list(self._pixels)
            self._pixels.clear()
            self._bits.clear()
            return pix or None

        # Classify the bit by comparing the two halves of its own symbol, not
        # against an absolute tick count. A WS2812 '1' is high-longer-than-low
        # and a '0' is high-shorter-than-low whatever resolution the driver
        # picked — the in-browser engine decodes it exactly this way. The old
        # fixed threshold of 48 ticks was an order of magnitude off for the two
        # drivers in this image, which both build symbols at 10 MHz with 8 ticks
        # for a 1 and 4 for a 0, so every bit classified as 0: a black strip.
        if level0 == 1 and dur0 > 0:
            self._bits.append(1 if dur0 > dur1 else 0)

        # Every 24 bits → one GRB pixel → convert to RGB
        while len(self._bits) >= 24:
            g = self._bits_to_byte(self._bits, 0)
            r = self._bits_to_byte(self._bits, 8)
            b = self._bits_to_byte(self._bits, 16)
            self._pixels.append({'r': r, 'g': g, 'b': b})
            self._bits = self._bits[24:]

        return None


# ─── Main ─────────────────────────────────────────────────────────────────────

# ── -icount policy ────────────────────────────────────────────────────────────
# Instruction-driven guest time on the Xtensa machines is opt-in per run,
# because it makes the boot ~3x slower (MicroPython banner at 20 s with
# shift 4, 35 s with shift 3, 7 s without). What needs it: a MicroPython
# single-wire sensor driver times its pulses in microseconds with 100 us
# timeouts, and without -icount this guest reads a GPIO only every 40-90 us of
# host time (each read exits into a Python callback), so a 26 us pulse cannot
# be observed at all. Under -icount shift 4 a read costs ~0.9 us of guest time
# and the DHT22 decoded 21/21 frames over 75 s (issue #291). Shift 5 halves the
# boot again but its ~40 us per-frame hiccup flipped a '0' bit (checksum error).
#
# Arduino runs keep the fast boot: Adafruit's DHT.h counts reads and the
# HC-SR04 echo is timed on the guest clock, both fine at host time. WiFi keeps
# -icount off: the AP beacon timer runs on QEMU_CLOCK_REALTIME (issue #260).
ICOUNT_SHIFT_C3 = 3
ICOUNT_SHIFT_LINE_SENSORS = 4
LINE_SENSOR_TYPES = ('dht22', 'dht11', 'hc-sr04', 'ir-nec')


def icount_shift_for_run(machine: str, wifi_enabled: bool, sensors: list,
                         firmware_is_upy: bool) -> int | None:
    """The `-icount` shift for this run, or None to leave guest time on host time."""
    if 'c3' in machine:
        return ICOUNT_SHIFT_C3
    if wifi_enabled or not firmware_is_upy:
        return None
    if not any(str(s.get('sensor_type', '')) in LINE_SENSOR_TYPES for s in sensors):
        return None
    return ICOUNT_SHIFT_LINE_SENSORS


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
    sd_card_cfg       = cfg.get('sd_card')  # {'image_b64': ...} when a microSD is wired

    # microSD card (SD-over-SPI). The frontend builds a FAT16 image (auto-copied
    # project files + paid uploads) and ships it here; SdSpiSlave serves it
    # synchronously over the SPI bus (returns MISO per byte). Single-device on
    # the bus for now — CS gating is a later refinement.
    _sd_slave = None
    if sd_card_cfg and sd_card_cfg.get('image_b64'):
        try:
            _sd_slave = _SdSpiSlave(base64.b64decode(sd_card_cfg['image_b64']))
            _log('[sd] microSD attached')
        except Exception as _e:  # noqa: BLE001
            _log(f'[sd] failed to attach microSD: {_e!r}')

    # Adjust GPIO pinmap based on chip: ESP32-C3 has only 22 GPIOs; the
    # ESP32-S3 has 49 (GPIO0..48). The identity pinmap's length is what
    # picsimlab_wire_gpio iterates, so the S3 needs 49 for pins 40..48 to be
    # wired to the host (bank-1 named outputs in the widened esp32_gpio model).
    if 'c3' in machine:
        _build_pinmap(22)
    elif 's3' in machine:
        _build_pinmap(49)

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

    # Host threads must hold the Big QEMU Lock around anything that can raise
    # a guest interrupt (uart_receive, set_pin with an armed GPIO ISR, camera
    # frames): TCG aborts the whole process otherwise — `tcg_handle_interrupt:
    # assertion failed: (bql_locked())`, issue #273.
    #
    # QEMU renamed the lock across the 8.2/9.x line: the legacy
    # qemu_mutex_lock_iothread_impl/qemu_mutex_unlock_iothread became
    # bql_lock_impl/bql_unlock (same signatures). This resolution only ever
    # tried the LEGACY names, so against the current fork it silently resolved
    # to None and every "locked" path — uart_send included — has been running
    # unlocked since the QEMU base moved. The crash a rotary-encoder ISR
    # produced (#273) was the first path noisy enough to expose it. Try the
    # modern names first, keep the legacy pair as fallback for old prebuilts.
    _lock_iothread = None
    _unlock_iothread = None
    for lock_name, unlock_name in (
        ('bql_lock_impl', 'bql_unlock'),
        ('qemu_mutex_lock_iothread_impl', 'qemu_mutex_unlock_iothread'),
    ):
        try:
            _lock_iothread = getattr(lib, lock_name)
            _lock_iothread.restype = None
            _lock_iothread.argtypes = [ctypes.c_char_p, ctypes.c_int]
            _unlock_iothread = getattr(lib, unlock_name)
            _unlock_iothread.restype = None
            _unlock_iothread.argtypes = []
            break
        except AttributeError:
            _lock_iothread = None
            _unlock_iothread = None
    if _lock_iothread is None:
        # Without the lock every injection is a coin-flip abort; say so once
        # instead of letting the next encoder click read as a random crash.
        _log('BQL lock symbols not found in libqemu — host-injected '
             'interrupts (GPIO ISRs, UART RX) may abort QEMU; rebuild the '
             'fork with bql_lock_impl/bql_unlock exported.')

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
        # The compiler trims trailing 0xFF padding before serializing (issue
        # #101 — full 4 MB images blew nginx buffers). Re-pad here so QEMU's
        # MTD layer sees a valid power-of-2 flash size.
        # Imported via fallback because this file runs as a subprocess and
        # `app.*` is not on sys.path; mirrors the esp32_i2c_slaves pattern
        # at the top of the file.
        try:
            from app.services.esp32_flash_image import (  # type: ignore[import-not-found]
                firmware_is_micropython, pad_to_flash_size)
        except ImportError:
            import importlib.util as _ilu, pathlib as _pl
            _spec = _ilu.spec_from_file_location(
                'esp32_flash_image',
                _pl.Path(__file__).parent / 'esp32_flash_image.py',
            )
            _mod = _ilu.module_from_spec(_spec)  # type: ignore[arg-type]
            _spec.loader.exec_module(_mod)  # type: ignore[union-attr]
            pad_to_flash_size = _mod.pad_to_flash_size
            firmware_is_micropython = _mod.firmware_is_micropython
        fw_bytes = pad_to_flash_size(base64.b64decode(firmware_b64))
        firmware_is_upy = firmware_is_micropython(fw_bytes)
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

    # Deterministic instruction counting for stable timers. Always on for the
    # ESP32-C3 (RISC-V needs deterministic timing to boot); on the Xtensa
    # machines only for the runs that need it, see icount_shift_for_run().
    icount_shift = icount_shift_for_run(machine, wifi_enabled, initial_sensors, firmware_is_upy)
    if icount_shift is not None:
        args_list.extend([b'-icount', str(icount_shift).encode()])
        if 'c3' not in machine:
            _log(f'-icount {icount_shift}: MicroPython run with a line sensor, '
                 'guest time is instruction-driven (boot takes ~3x longer)')
    elif firmware_is_upy and wifi_enabled and any(
            str(s.get('sensor_type', '')) in LINE_SENSOR_TYPES for s in initial_sensors):
        _log('line sensor on a MicroPython run that uses WiFi: -icount stays off '
             '(issue #260), so a pulse-timing driver will time out on it')

    # ── WiFi NIC (slirp user-mode networking) ──────────────────────────────
    # Always present on machines that model a radio — see wifi_nic_arg().
    nic_arg = wifi_nic_arg(machine, wifi_enabled, wifi_hostfwd_port)
    if nic_arg:
        args_list.extend([b'-nic', nic_arg.encode()])
        _log(f'WiFi radio attached (sketch wants WiFi: {wifi_enabled}): -nic {nic_arg}')
    elif wifi_enabled:
        _log(f'WiFi requested but machine {machine} models no radio — '
             'the sketch will fault if it touches the MAC')

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
    # Must match wasm_chip_runtime.CHIP_UART; defined locally because that
    # module is imported lazily (the worker may run without app.services on
    # sys.path, see the ImportError fallback below).
    CHIP_UART = 1
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
    # A LoadStorePIFAddrError is always the guest touching a peripheral this
    # machine does not model, but the panic dump says only "memory". The
    # address arrives a few lines after the cause, so the cause is latched
    # here until EXCVADDR shows up. See _explain_pif_fault.
    _PIF_STR        = b'LoadStorePIFAddrError'
    _pif_pending    = [False]

    # ── Signal routing (GPIO Matrix mirror) ───────────────────────────────
    # The SignalRouter owns the per-GPIO routing table that the firmware
    # writes through `GPIO_FUNCx_OUT_SEL_CFG_REG[x]`. We currently fill it
    # by polling `gpio_out_sel[40]` once every 100 ms in the LEDC poll
    # thread (and diffing); the C-side plugin will gain a synchronous
    # callback in a future bump that turns the poll into a push without
    # touching this code path.
    #
    # The old `_ledc_gpio_map: dict[int, int]` (channel → gpio) has been
    # subsumed by the router's reverse index — call
    # `_signal_router.pins_for_signal(SIG_LEDC_*+channel)` instead.
    #
    # `app.*` is not on sys.path inside this subprocess; mirror the same
    # importlib fallback pattern used for esp32_flash_image (further down
    # this file) so the worker can find its sibling modules without
    # depending on the backend's package layout.
    try:
        from app.services.signal_router import SignalRouter  # type: ignore[import-not-found] # noqa: E402
        from app.services.esp32_signals import (  # type: ignore[import-not-found] # noqa: E402
            ledc_signal_for_channel,
            SIG_LEDC_HS_CH0_OUT_IDX,
            SIG_LEDC_LS_CH_LAST,
            rmt_signal_base,
        )
    except ImportError:
        import importlib.util as _ilu, pathlib as _pl
        _here = _pl.Path(__file__).parent
        for _name in ('signal_router', 'esp32_signals'):
            _spec = _ilu.spec_from_file_location(_name, _here / f'{_name}.py')
            _mod = _ilu.module_from_spec(_spec)  # type: ignore[arg-type]
            _spec.loader.exec_module(_mod)        # type: ignore[union-attr]
            sys.modules[_name] = _mod
        SignalRouter = sys.modules['signal_router'].SignalRouter
        ledc_signal_for_channel = sys.modules['esp32_signals'].ledc_signal_for_channel
        SIG_LEDC_HS_CH0_OUT_IDX = sys.modules['esp32_signals'].SIG_LEDC_HS_CH0_OUT_IDX
        SIG_LEDC_LS_CH_LAST = sys.modules['esp32_signals'].SIG_LEDC_LS_CH_LAST
        rmt_signal_base = sys.modules['esp32_signals'].rmt_signal_base
    _signal_router = SignalRouter()
    _rmt_sig_base = rmt_signal_base(machine)

    def _gpio_for_rmt_channel(channel: int) -> int | None:
        """Which GPIO an RMT TX channel is routed to, or None.

        The decoded pixels are useless to the frontend without this: a NeoPixel
        PART on the canvas is keyed by its DIN pin, and the channel number
        cannot reach one, so every ws2812_update was delivered to nobody.

        Read straight from the GPIO matrix rather than the SignalRouter, whose
        snapshot deliberately keeps only the LEDC signal window.
        """
        if _rmt_sig_base is None:
            return None
        want = _rmt_sig_base + channel
        try:
            out_sel_ptr = lib.qemu_picsimlab_get_internals(2)
            if not out_sel_ptr:
                return None
            out_sel = (ctypes.c_uint32 * _GPIO_COUNT).from_address(out_sel_ptr)
            for gpio_pin in range(_GPIO_COUNT):
                if (int(out_sel[gpio_pin]) & 0xFF) == want:
                    return gpio_pin
        except Exception:  # noqa: BLE001
            return None
        return None

    def _refresh_signal_routing() -> None:
        """Scan `gpio_out_sel[40]` and reconcile the SignalRouter.

        Emits `gpio_routing` for every routing that changed since the
        last scan and `gpio_routing_clear` for routings that disappeared,
        so the frontend's mirror stays in lock-step without re-sending
        the whole table.  Idempotent: a scan with no changes emits no
        events.

        Called every 100 ms from the LEDC poll thread.  Also called
        eagerly from the 0x5000 LEDC duty callback so the first duty
        write after `ledcAttachPin` doesn't race the periodic poll.
        """
        try:
            out_sel_ptr = lib.qemu_picsimlab_get_internals(2)
            if not out_sel_ptr:
                return
            out_sel = (ctypes.c_uint32 * 40).from_address(out_sel_ptr)
            snapshot: dict[int, int] = {}
            for gpio_pin in range(40):
                signal_id = int(out_sel[gpio_pin]) & 0xFF
                # 0..71 / 88..255 are signal sources velxio doesn't
                # model yet; include them in the snapshot only if the
                # firmware actively routed them so future peripherals
                # can opt in without code changes here.
                if SIG_LEDC_HS_CH0_OUT_IDX <= signal_id <= SIG_LEDC_LS_CH_LAST:
                    snapshot[gpio_pin] = signal_id
            changed, cleared = _signal_router.replace_snapshot(snapshot)
            for gpio_pin, signal_id in changed:
                _emit({'type': 'gpio_routing',
                       'gpio': gpio_pin,
                       'signal_id': signal_id})
            for gpio_pin in cleared:
                _emit({'type': 'gpio_routing_clear', 'gpio': gpio_pin})
        except Exception:
            pass

    # GPIO pull-up / pull-down state, keyed by GPIO number → 0=none 1=up 2=down.
    # Diff-based like the SignalRouter snapshot so we only emit real changes.
    _pull_state: dict[int, int] = {}

    def _refresh_pin_pulls() -> None:
        """Scan IO_MUX FUN_WPU/FUN_WPD bits and emit `gpio_pull` on change.

        The ESP32's internal pull resistors are configured per pad in the
        IO_MUX register: FUN_WPU (bit 8) enables the pull-up, FUN_WPD
        (bit 7) the pull-down. The frontend needs this to model
        INPUT_PULLUP / INPUT_PULLDOWN — without it an input wired to a
        button-to-GND floats to 0 V in the SPICE solve and reads LOW even
        at idle, so the canonical active-low button never works. The
        `muxgpios[40]` array is exposed read-only via get_internals(3) and
        is indexed by GPIO number. Idempotent + diff-based; runs every
        100 ms from the LEDC poll thread (off the QEMU iothread, so the
        _emit here can't stall the guest the way _on_gpio_matrix would).
        """
        # RTC-capable GPIOs route their pull through the RTC_IO peripheral
        # (RTC pad RUE/RDE bits), not IO_MUX — so a button on GPIO4/15/etc.
        # with INPUT_PULLUP is invisible in muxgpios. Read both and let RTC win
        # for its pads. Map: GPIO -> (rtcio word index, RUE bit, RDE bit), from
        # the esp32 rtc_gpio_desc table (TOUCH_PADn / PDAC / XTAL_32K pads).
        rtc_map = {
            0: (0x98 >> 2, 27, 28), 2: (0x9c >> 2, 27, 28), 4: (0x94 >> 2, 27, 28),
            12: (0xa8 >> 2, 27, 28), 13: (0xa4 >> 2, 27, 28), 14: (0xac >> 2, 27, 28),
            15: (0xa0 >> 2, 27, 28), 25: (0x84 >> 2, 27, 28), 26: (0x88 >> 2, 27, 28),
            27: (0xb0 >> 2, 27, 28), 32: (0x8c >> 2, 22, 23), 33: (0x8c >> 2, 27, 28),
        }
        try:
            pulls: dict[int, int] = {}
            iomux_ptr = lib.qemu_picsimlab_get_internals(3)  # QEMU_INTERNAL_IOMUX_GPIOS
            if iomux_ptr:
                # The exposed array is indexed by GPIO and sized per chip:
                # classic muxgpios[40], S3 iomux regs[49] (GPIO0..48). A
                # fixed 40 here missed S3 GPIO40-48 pulls entirely.
                n_gpio = _GPIO_COUNT
                mux = (ctypes.c_uint32 * n_gpio).from_address(iomux_ptr)
                for gpio_pin in range(n_gpio):
                    reg = int(mux[gpio_pin])
                    pulls[gpio_pin] = 1 if (reg >> 8) & 1 else (2 if (reg >> 7) & 1 else 0)
            rtcio_ptr = lib.qemu_picsimlab_get_internals(10)  # QEMU_INTERNAL_RTCIO
            if rtcio_ptr:
                rtc = (ctypes.c_uint32 * 256).from_address(rtcio_ptr)
                for gpio_pin, (idx, ub, db) in rtc_map.items():
                    reg = int(rtc[idx])
                    rtc_pull = 1 if (reg >> ub) & 1 else (2 if (reg >> db) & 1 else 0)
                    if rtc_pull:
                        pulls[gpio_pin] = rtc_pull  # RTC pad pull is authoritative
            for gpio_pin, pull in pulls.items():
                if _pull_state.get(gpio_pin, 0) != pull:
                    _pull_state[gpio_pin] = pull
                    _emit({'type': 'gpio_pull', 'pin': gpio_pin, 'pull': pull})
        except Exception:
            pass

    # Sensor state: gpio_pin → {type, properties..., saw_low, responding}
    _sensors: dict[int, dict] = {}
    _sensors_lock = threading.Lock()

    # ── Matrix keypad (server-side row/column emulation) ─────────────────────
    # A 4×4 membrane keypad scan is µs-timing-critical: firmware drives one
    # row LOW and reads the columns back within the same loop pass — far
    # faster than the browser↔QEMU round trip, so the matrix must be
    # emulated HERE. The frontend attaches a 'matrix-keypad' sensor with the
    # row/col GPIO lists and streams the pressed-key set; _on_dir_change /
    # _on_pin_change recompute the column levels synchronously (both run on
    # the QEMU thread, so qemu_picsimlab_set_pin lands before the firmware's
    # digitalRead() that follows its digitalWrite(row, LOW)).
    #
    # Active-row model (validated live against the alarm-keypad project):
    # neither the write-pin nor the dir callback alone is reliable across
    # passes — the write callback only fires when the OUTPUT LATCH changes
    # (after the first pass the latch stays LOW, so re-driving the row is a
    # no-change write), and the row's level while INPUT is not modelled. What
    # IS delivered every pass is the ENABLE toggle: pinMode(OUTPUT) → dir=1,
    # pinMode(INPUT) → dir=0. Since a matrix scan drives exactly one row at a
    # time and the latch is LOW during the scan window, "the row whose dir
    # went 1 most recently" IS the active row. The write hook stays as a
    # belt-and-braces trigger for the first pass (latch 1→0).
    _keypad_by_row: dict[int, dict] = {}   # row gpio → keypad state dict
    _keypad_cols_owned: set[int] = set()   # col gpios driven by the worker

    def _keypad_install(gpio: int, sensor_data: dict) -> None:
        rows = [int(r) for r in sensor_data.get('rows', [])]
        cols = [int(cg) for cg in sensor_data.get('cols', [])]
        # Idempotent: the canvas effect re-attaches on unrelated re-renders
        # (boards[] mutates with serial output). Same wiring => keep the
        # existing state dict — wiping it would drop pressed keys mid-scan.
        existing = _keypad_by_row.get(rows[0]) if rows else None
        if (existing is not None and existing['rows'] == rows
                and existing['cols'] == cols):
            sensor_data['keypad'] = existing
            return
        kp = {
            'rows': rows, 'cols': cols,
            'pressed': set(),               # {(row_idx, col_idx)}
            'active_row': -1,               # index of the row being scanned
            'col_level': [1] * len(cols),   # last level applied per col
        }
        sensor_data['keypad'] = kp
        for r in rows:
            _keypad_by_row[r] = kp
        for cg in cols:
            _keypad_cols_owned.add(cg)
        # Idle columns HIGH — firmware scans them as INPUT_PULLUP.
        for cg in cols:
            lib.qemu_picsimlab_set_pin(cg + 1, 1)
        _log(f'matrix-keypad installed rows={rows} cols={cols} (anchor gpio={gpio})')

    def _keypad_uninstall(sensor_data: dict) -> None:
        kp = sensor_data.get('keypad')
        if not kp:
            return
        for r in kp['rows']:
            _keypad_by_row.pop(r, None)
        for cg in kp['cols']:
            _keypad_cols_owned.discard(cg)
            lib.qemu_picsimlab_set_pin(cg + 1, 1)

    def _keypad_recompute(kp: dict) -> None:
        cols, pressed = kp['cols'], kp['pressed']
        active = kp.get('active_row', -1)
        for j, cg in enumerate(cols):
            lvl = 0 if (active >= 0 and (active, j) in pressed) else 1
            if kp['col_level'][j] != lvl:
                kp['col_level'][j] = lvl
                lib.qemu_picsimlab_set_pin(cg + 1, lvl)

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

    # ── DHT22 ────────────────────────────────────────────────────────────────
    # The model is esp32_dht22.py (trigger, phases, guest-time pacing). This is
    # the glue: the guest clock, the pad, the sync-handler shape, and a settle
    # timer for drivers that stop reading before the tail of the frame is out.
    try:
        _qemu_clock_get_ns = lib.qemu_clock_get_ns
        _qemu_clock_get_ns.restype = ctypes.c_int64
        _qemu_clock_get_ns.argtypes = [ctypes.c_int]
        _QEMU_CLOCK_VIRTUAL = 1  # enum QEMUClockType, qemu/timer.h

        def _guest_now_us() -> float:
            """The guest's own clock, in us: what esp_timer / micros() count.
            Instruction-driven under -icount (the C3, and the runs picked by
            icount_shift_for_run), host time while the VM runs otherwise;
            either way it is the clock the guest measures our pulses with."""
            return _qemu_clock_get_ns(_QEMU_CLOCK_VIRTUAL) / 1000.0
    except AttributeError:
        _log('libqemu does not export qemu_clock_get_ns; DHT22 pacing uses host time')

        def _guest_now_us() -> float:
            return time.perf_counter_ns() / 1000.0

    class _Dht22Handler:
        """Sync-handler shape over a Dht22Reply: one step per GPIO_IN read."""

        def __init__(self, reply, gpio: int, sensor: dict, how: str) -> None:
            self.reply = reply
            self._gpio = gpio
            self._sensor = sensor
            self._how = how

        def step(self) -> bool:
            if self.reply.done:
                return True
            if self.reply.step():
                self._finish()
                return True
            return False

        def _finish(self) -> None:
            with _sensors_lock:
                if self._sensor.get('_dht22_reply') is self.reply:
                    self._sensor['responding'] = False
            d = self.reply.diag()
            _log(f'DHT22 frame done gpio={self._gpio} ({self._how}) {d}')
            _emit({'type': 'system', 'event': 'dht22_diag', 'gpio': self._gpio,
                   'status': 'ok', 'release': self._how, **d})

    def _dht22_settle_later(reply, sensor: dict, gpio: int) -> None:
        """A read-counting driver returns on the last falling edge and never
        reads again, so the tail LOW would sit on the pad until the next start.
        Once the guest has gone quiet, release the line from a host thread
        under the BQL (which also keeps step() from running concurrently)."""
        if _lock_iothread is None or _unlock_iothread is None:
            return

        def _settle(last_reads: int) -> None:
            if _stopped.is_set() or reply.done:
                return
            with _sensors_lock:
                if sensor.get('_dht22_reply') is not reply:
                    return
            if reply.reads != last_reads:
                # The guest is still polling: the frame is in progress. Under
                # -icount a frame is ~3000 reads at ~90 us of host time each,
                # so "quiet" is measured in reads, never in host time.
                _later(reply.reads)
                return
            _lock_iothread(b'esp32_worker.py:dht22_settle', 0)
            try:
                acted = reply.settle()
            finally:
                _unlock_iothread()
            if acted:
                with _sensors_lock:
                    if sensor.get('_dht22_reply') is reply:
                        sensor['responding'] = False
                _log(f'DHT22 line released by the settle timer gpio={gpio} '
                     f'phase={reply.phase} {reply.diag()}')

        def _later(last_reads: int) -> None:
            t = threading.Timer(0.03, _settle, args=(last_reads,))
            t.daemon = True
            t.start()

        _later(reply.reads)

    def _dht22_trigger(sensor: dict):
        trig = sensor.get('_dht22_trigger')
        if trig is None:
            trig = sensor['_dht22_trigger'] = _Dht22Trigger()
        return trig

    def _dht22_arm(gpio: int, slot: int, sensor: dict, how: str) -> None:
        """Start a frame on `slot`. A frame still in flight is replaced: the
        guest can only issue a new start after abandoning the previous read."""
        temp = _dht22_num(sensor.get('temperature'), 25.0)
        hum = _dht22_num(sensor.get('humidity'), 50.0)
        # Same frame timing, different payload: the DHT11 sends whole units.
        payload = (_dht11_payload_bytes(temp, hum)
                   if sensor.get('type') == 'dht11'
                   else _dht22_payload_bytes(temp, hum))
        old = sensor.get('_dht22_reply')
        if old is not None and not old.done:
            _sync_handlers[:] = [h for h in _sync_handlers
                                 if getattr(h, 'reply', None) is not old]
            _log(f'DHT22 frame restarted gpio={gpio} at phase {old.phase}')
        reply = _Dht22Reply(
            _dht22_phases(payload),
            lambda level: lib.qemu_picsimlab_set_pin(slot, level),
            _guest_now_us,
        )
        with _sensors_lock:
            sensor['_dht22_reply'] = reply
            sensor['responding'] = True
        _sync_handlers.append(_Dht22Handler(reply, gpio, sensor, how))
        _dht22_settle_later(reply, sensor, gpio)
        _log(f'DHT22 armed ({how}) gpio={gpio} temp={temp} hum={hum} payload={payload}')

    # ── Infrared ─────────────────────────────────────────────────────────────
    # The model is esp32_ir.py (the envelope, paced on the guest clock). This is
    # the glue: the pad, the sync-handler shape, and the host ticker that covers
    # a decoder using a pin-change interrupt instead of reading the pin.
    class _IrHandler:
        """Sync-handler shape over an IrReply: one advance per GPIO_IN read."""

        def __init__(self, reply, gpio: int, how: str) -> None:
            self.reply = reply
            self._gpio = gpio
            self._how = how

        def step(self) -> bool:
            if self.reply.done:
                self._finish()
                return True
            if self.reply.advance():
                self._finish()
                return True
            return False

        def _finish(self) -> None:
            with _sensors_lock:
                sensor = _sensors.get(self._gpio)
                if sensor is not None and sensor.get('_ir_reply') is self.reply:
                    sensor['responding'] = False
            d = self.reply.diag()
            _log(f'IR frame done gpio={self._gpio} ({self._how}) {d}')
            _emit({'type': 'system', 'event': 'ir_frame', 'gpio': self._gpio,
                   'status': 'ok', 'source': self._how, **d})

    def _ir_tick_later(reply, gpio: int) -> None:
        """Advance the frame from a host thread, under the BQL.

        A polling decoder is already covered by the GPIO_IN read path, and it
        is the better one — a read is the only instant the guest can observe
        the pad. This exists for the decoder that attaches a pin-change
        interrupt and never reads the pin at all: nothing would advance its
        frame, the pad would sit on its first phase, and the sketch would wait
        for an edge that never came. The BQL keeps this off the QEMU thread's
        toes; `advance()` is idempotent about being called from both.
        """
        if _lock_iothread is None or _unlock_iothread is None:
            return

        def _tick() -> None:
            if _stopped.is_set() or reply.done:
                return
            _lock_iothread(b'esp32_worker.py:ir_tick', 0)
            try:
                finished = reply.advance()
            finally:
                _unlock_iothread()
            if finished:
                with _sensors_lock:
                    sensor = _sensors.get(gpio)
                    if sensor is not None and sensor.get('_ir_reply') is reply:
                        sensor['responding'] = False
                _log(f'IR frame done gpio={gpio} (host tick) {reply.diag()}')
                return
            _later()

        def _later() -> None:
            # 1 ms of host time. A NEC bit is 560 us of GUEST time, and the
            # guest runs at or below real time, so this never under-samples the
            # envelope; when the guest polls, the read path is finer anyway.
            t = threading.Timer(0.001, _tick)
            t.daemon = True
            t.start()

        _later()

    def _ir_arm(gpio: int, sensor: dict, pulses, how: str) -> None:
        """Put one envelope on `gpio`. A frame still going out is left alone:
        two transmissions on top of each other garble both, which is what
        happens in the room too."""
        slot = gpio + 1
        old = sensor.get('_ir_reply')
        if old is not None and not old.done:
            _log(f'IR frame ignored gpio={gpio}: one is still going out')
            return
        phases = _ir_envelope_phases(pulses)
        if not phases:
            return
        reply = _IrReply(
            phases,
            lambda level: lib.qemu_picsimlab_set_pin(slot, level),
            _guest_now_us,
        )
        with _sensors_lock:
            sensor['_ir_reply'] = reply
            sensor['responding'] = True
        _sync_handlers.append(_IrHandler(reply, gpio, how))
        _ir_tick_later(reply, gpio)
        _log(f'IR armed ({how}) gpio={gpio} phases={len(phases)}')

    def _ir_pulses_for(sensor: dict):
        """What to transmit: the train the canvas carried, else the sensor's
        own address and command. Read fresh each time — an air frame carries
        its own train and the NEXT press must not replay the last one."""
        raw = sensor.pop('pulses', None)
        if isinstance(raw, list) and raw:
            out = []
            for i, item in enumerate(raw):
                if isinstance(item, dict):
                    us = float(item.get('us', 0) or 0)
                    level = 1 if int(item.get('level', 0)) == 1 else 0
                else:
                    # A flat [markUs, spaceUs, ...] array, mark first.
                    us = float(item or 0)
                    level = 1 if i % 2 == 0 else 0
                if us > 0:
                    out.append((level, us))
            if out:
                return out
        return _ir_nec_pulses(
            int(_dht22_num(sensor.get('address'), 0.0)),
            int(_dht22_num(sensor.get('command'), 0x45)),
        )

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
            until echo_us of GUEST time have elapsed (_guest_now_us: QEMU's
            virtual clock, the one micros() / time_pulse_us read), then set
            LOW.  Without -icount that clock is host time; under -icount it is
            instruction-driven and host time would be off by 100x.

        Guard: guest-clock timeouts replace step-count limits.  A step-count
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
            self._arm_start_us  = _guest_now_us()
            self._echo_start_us = 0.0

        def step(self) -> bool:
            self._total_steps += 1

            if self._state == 'armed':
                if self._total_steps <= self._SKIP_COUNT:
                    return False
                # Check armed timeout (handler never entered 'high')
                arm_us = int(_guest_now_us() - self._arm_start_us)
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
                self._echo_start_us = _guest_now_us()
                self._state = 'high'
                return False

            elif self._state == 'high':
                elapsed_us = int(_guest_now_us() - self._echo_start_us)
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
        # Matrix keypad: a row LATCH changed — only fires on actual latch
        # transitions (first pass 1→0), so it complements the per-pass dir
        # trigger below rather than replacing it.
        _kp = _keypad_by_row.get(gpio)
        if _kp is not None:
            try:
                _idx = _kp['rows'].index(gpio)
            except ValueError:
                _idx = -1
            if _idx >= 0:
                if (value & 1) == 0:
                    _kp['active_row'] = _idx
                elif _kp.get('active_row', -1) == _idx:
                    _kp['active_row'] = -1
                _keypad_recompute(_kp)
        # Flush pending SPI bytes BEFORE announcing this pin change so the
        # frontend processes them under the pin state (e.g. the ILI9341 DC line)
        # that was in effect when they were sent. With CS events gated off for
        # pure-display sims, this — plus the buffer cap / timer — is what keeps
        # the SPI byte stream correctly ordered against the DC gpio_change on the
        # single WS channel (the per-CS flush used to do it).
        with _spi_buf_lock:
            _flush_spi_batch_locked()
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

        if stype in ('dht22', 'dht11'):
            # A level the guest wrote while the pad is an output (QEMU reports
            # no others). The LOW is the start signal; a 1 after it is the
            # open-drain release, how MicroPython's dht driver lets go of the
            # line (issue #291). The push-pull release, pinMode(INPUT), arrives
            # in _on_dir_change instead.
            if _dht22_trigger(sensor).on_write(value & 1):
                _dht22_arm(gpio, slot, sensor, 'open-drain release')

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

                # Refresh the GPIO Matrix snapshot first so the routing
                # is current — emits any gpio_routing events the
                # frontend needs to update its SignalRouter mirror
                # BEFORE the duty arrives.
                _refresh_signal_routing()

                # New canonical event (SignalRouter consumer): channel +
                # duty only, no gpio.  The frontend resolves channel →
                # signal_id → pins via its mirror.
                _emit({'type': 'ledc_duty',
                       'channel': ledc_ch,
                       'duty_pct': intensity})
            return

        # ── DHT22: the push-pull release arrives as a direction change ───
        if slot >= 1:
            gpio = int(_PINMAP[slot]) if slot <= _GPIO_COUNT else slot
            # Matrix keypad: rows toggle OUTPUT(scan)/INPUT(idle) every pass,
            # and the ENABLE toggle is the one signal delivered EVERY pass
            # (the latch write is a no-change after the first pass). dir=1
            # marks this row as the actively scanned one; dir=0 releases it.
            _kp = _keypad_by_row.get(gpio)
            if _kp is not None and direction in (0, 1):
                try:
                    _idx = _kp['rows'].index(gpio)
                except ValueError:
                    _idx = -1
                if _idx >= 0:
                    if direction == 1:
                        _kp['active_row'] = _idx
                    elif _kp.get('active_row', -1) == _idx:
                        _kp['active_row'] = -1
                    _keypad_recompute(_kp)
            with _sensors_lock:
                sensor = _sensors.get(gpio)
            if sensor is not None and sensor.get('type') in ('dht22', 'dht11') and direction in (0, 1):
                # The push-pull release: the pad went INPUT after the LOW.
                if _dht22_trigger(sensor).on_direction(direction == 1):
                    _dht22_arm(gpio, slot, sensor, 'input release')
        gpio = int(_PINMAP[slot]) if 1 <= slot <= _GPIO_COUNT else slot
        _emit({'type': 'gpio_dir', 'pin': gpio, 'dir': direction})

    def _on_uart_tx(uart_id: int, byte_val: int) -> None:
        if _stopped.is_set():
            return
        _emit({'type': 'uart_tx', 'uart': uart_id, 'byte': byte_val})
        # Dispatch to any custom-chip runtimes that declared a UART, but only
        # from CHIP_UART. UART0 is the serial monitor: feeding it to a chip
        # means the chip receives the sketch's own console output, and the
        # chip's replies land in the monitor as garbage. Chips live on
        # Serial1, which is what the browser bridge does too.
        # The chip's on_rx_byte callback runs synchronously in this thread.
        if uart_id == CHIP_UART:
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
                if _PIF_STR in chunk:
                    _pif_pending[0] = True
                elif _pif_pending[0]:
                    note = _explain_pif_fault(chunk)
                    if note:
                        _pif_pending[0] = False
                        _emit({'type': 'serial_output', 'data': note, 'uart': 0})
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
            _emit({'type': 'ws2812_update', 'channel': channel,
                   'pin': _gpio_for_rmt_channel(channel), 'pixels': pixels})

    def _on_gpio_matrix(gpio: int, signal_id: int) -> None:
        """Synchronous GPIO Matrix routing event from libqemu 1.1.0+.

        Critical: this fires on QEMU's iothread, hundreds of times during
        early boot (bootloader + IDF init configure every GPIO Matrix
        slot). It MUST NOT do anything that can block the iothread —
        most importantly NOT _emit() over the stdout pipe, because if
        the manager's reader is even briefly stalled, the pipe fills,
        write() blocks, the iothread freezes, and the entire guest
        stops (symptom: ESP32 boot stops at "entry 0x400805e4" with no
        Arduino setup() output).

        So this callback ONLY mutates the in-memory SignalRouter
        snapshot. The 10 Hz poll thread (_refresh_signal_routing) is
        the sole emitter of gpio_routing / gpio_routing_clear events.
        The callback's only benefit over the poll alone is reducing
        the worst-case routing-to-emit latency from ~100 ms to one
        poll tick, AND keeping the snapshot dict warm so the next
        poll's diff is cheaper.
        """
        if _stopped.is_set():
            return
        try:
            sid_lo = signal_id & 0xFF
            if signal_id == 0x100:
                _signal_router.clear_routing(gpio)
            elif SIG_LEDC_HS_CH0_OUT_IDX <= sid_lo <= SIG_LEDC_LS_CH_LAST:
                _signal_router.update_routing(gpio, sid_lo)
            # Other signal_id values fall outside what the frontend
            # SignalRouter currently cares about; future peripherals
            # extend the range above.
        except Exception:
            # Iothread callback — never raise, never block.
            pass

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

            slave_type_name = type(slave).__name__
            if slave_type_name == 'MPU6050Slave':
                seq = _i2c_event_seq
                n   = seq[addr] = seq.get(addr, 0) + 1
                _log(f'I2C #{n:03d} bus={bus_id} addr=0x{addr:02x} {op_name} {note}')
            elif slave_type_name != 'I2CWriteSink':
                # I2CWriteSink fires per-byte for display drivers (SSD1306,
                # PCF8574). A 1024-byte writevto (oled.show()) generates
                # ~1025 events. Logging each one + emitting a WS message
                # blocks the QEMU thread long enough that the firmware's
                # ESP-IDF I2C ISR re-enters and trips IWDT on the SECOND
                # consecutive show() call. Skip the verbose per-event log
                # and WS trace for write-only sinks — the user-visible
                # OLED render is what matters, not byte-level tracing.
                _log(f'I2C bus={bus_id} addr=0x{addr:02x} event=0x{event:04x} '
                     f'op={op_name} result=0x{result:02x} slave={slave_type_name}')
            # Emit trace event to WebSocket so JS test can observe I2C traffic.
            # Skip for I2CWriteSink (display data dumps) — see comment above.
            if not _stopped.is_set() and slave_type_name != 'I2CWriteSink':
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

    # SPI byte batching — emitting one WS message per byte saturates the
    # uvicorn → frontend pipe and caps tft.drawRGBBitmap at < 1 fps even
    # for tiny previews. Buffer the MOSI bytes here and flush as a single
    # base64-encoded `spi_batch` message when:
    #   1. CS goes HIGH (transaction ended) — only fires when the firmware
    #      uses the SPI peripheral's hardware CS line. If CS is bit-banged
    #      via digitalWrite (the default for many Adafruit-style drivers
    #      on ESP32), this trigger never fires and we fall back to (2)+(3).
    #   2. Buffer crosses _SPI_BATCH_FLUSH_AT bytes (safety cap for big
    #      transactions).
    #   3. _spi_flush_timer fires every _SPI_BATCH_PERIOD_MS regardless —
    #      catches the GPIO-CS case so partial batches don't sit in the
    #      buffer forever between transactions. Without this, after a few
    #      drawRGBBitmap calls the firmware advances faster than the
    #      buffer fills, and frames stop appearing on the screen.
    # MISO is still returned synchronously per byte from _spi_response[0]
    # because the QEMU master writes can't wait. Frontend Esp32Bridge
    # unpacks the batch and replays each byte through onSpiByte.
    _spi_byte_buf       = bytearray()
    _spi_buf_lock       = threading.Lock()
    _SPI_BATCH_FLUSH_AT = 4096
    _SPI_BATCH_PERIOD_S = 0.05   # 50 ms → 20 fps cadence ceiling

    def _flush_spi_batch_locked():
        if _spi_byte_buf and not _stopped.is_set():
            b64 = base64.b64encode(bytes(_spi_byte_buf)).decode('ascii')
            _emit({'type': 'spi_batch', 'b64': b64})
            _spi_byte_buf.clear()

    def _sync_cs_events():
        """Tell QEMU whether to forward SPI chip-select toggles to us. Only
        ePaper / custom-chip SPI slaves consume CS; pure-display sims (DC pin +
        batched data) do not, so turning CS off there removes ~9k C->Python
        crossings/sec for a TFT redraw. No-op on older libqemu builds without
        the symbol (CS events stay on, as before)."""
        try:
            lib.qemu_picsimlab_enable_spi_cs_events(
                1 if (_epaper_state or _chip_spi_runtimes) else 0)
        except Exception:
            pass

    def _spi_flush_timer_loop():
        """Background thread: flushes any pending SPI bytes every
        _SPI_BATCH_PERIOD_S so partial transactions reach the frontend
        even when the firmware drives CS via GPIO and we never see a
        SPI peripheral CS-high event."""
        while not _stopped.is_set():
            _stopped.wait(_SPI_BATCH_PERIOD_S)
            if _stopped.is_set():
                break
            with _spi_buf_lock:
                _flush_spi_batch_locked()

    threading.Thread(
        target=_spi_flush_timer_loop, daemon=True,
        name='esp32-spi-batch-flush',
    ).start()

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
        # microSD — serve SD-over-SPI synchronously, returning the card's MISO
        # for this byte (the read path the firmware polls).
        if _sd_slave is not None and op == 0x00:
            try:
                return _sd_slave.transfer(mosi) & 0xFF
            except Exception as e:
                _log(f'[sd spi_event] error: {e!r}')
        resp = _spi_response[0]
        if _stopped.is_set():
            return resp
        # ── Batching path (replaces the per-byte _emit) ─────────────────
        if op == 0x00:
            # Byte transfer — append to buffer, flush if oversized.
            with _spi_buf_lock:
                _spi_byte_buf.append(mosi)
                if len(_spi_byte_buf) >= _SPI_BATCH_FLUSH_AT:
                    _flush_spi_batch_locked()
        else:
            # CS-line change. Flush any pending bytes from the previous
            # transaction so the frontend processes them before the
            # (rare) CS-state event itself. Then forward the CS event
            # via the legacy spi_event channel for chips that observe
            # CS state (e.g. ePaper, custom chips that subscribe to it).
            with _spi_buf_lock:
                _flush_spi_batch_locked()
            _emit({'type': 'spi_event', 'bus': bus_id, 'event': event, 'response': resp})
        return resp

    def _on_spi_batch(bus_id: int, mosi_ptr, length: int) -> None:
        """Batched write-only SPI transfer — the whole MOSI buffer arrives in a
        single call instead of one picsimlab_spi_event per byte. libqemu only
        invokes this for rx==0 (MISO-ignored) transfers on the host SPI shim, so
        nothing is returned. Mirrors the per-byte _on_spi_event side effects in
        bulk: custom-chip runtimes first, then ePaper, then the spi_batch buffer.
        This is the path that removes ~150k C->Python crossings/frame for TFTs."""
        if length <= 0 or _stopped.is_set():
            return
        try:
            data = ctypes.string_at(mosi_ptr, length)
        except Exception:
            return
        # Custom-chip SPI runtimes get first dibs (replay per byte; the chip's
        # MISO return is discarded because this transfer is write-only).
        if _chip_spi_runtimes:
            rt = _chip_spi_runtimes[0]
            for mb in data:
                try:
                    rt.spi_transfer_byte(mb)
                except Exception as e:
                    _log(f'[custom-chip spi_batch] error: {e!r}')
            return
        # ePaper SSD168x: feed each byte under the current DC to every active
        # slave (DC is constant for a write-only transaction).
        if _epaper_state:
            any_active = False
            for st in _epaper_state.values():
                if st['cs_low']:
                    any_active = True
                    slave = st['slave']
                    dc = st['dc_high']
                    for mb in data:
                        try:
                            slave.feed(mb, dc)
                        except Exception as e:
                            _log(f'[epaper spi_batch] error: {e!r}')
            if any_active:
                return
        # microSD — capture bulk write-only data (e.g. the 512-byte block sent
        # after CMD24). MISO is discarded on this path; the slave still advances.
        if _sd_slave is not None:
            try:
                for mb in data:
                    _sd_slave.feed(mb)
            except Exception as e:
                _log(f'[sd spi_batch] error: {e!r}')
            return
        # Fast path: bulk-append to the spi_batch buffer (same buffer/flush the
        # per-byte path uses, so frontend ordering is unchanged).
        with _spi_buf_lock:
            _spi_byte_buf.extend(data)
            if len(_spi_byte_buf) >= _SPI_BATCH_FLUSH_AT:
                _flush_spi_batch_locked()

    # Keep callback struct alive (prevent GC from freeing ctypes closures)
    _cbs_ref = _CallbacksT(
        picsimlab_write_pin      = _WRITE_PIN(_on_pin_change),
        picsimlab_dir_pin        = _DIR_PIN(_on_dir_change),
        picsimlab_i2c_event      = _I2C_EVENT(_on_i2c_event),
        picsimlab_spi_event      = _SPI_EVENT(_on_spi_event),
        picsimlab_uart_tx_event  = _UART_TX(_on_uart_tx),
        pinmap                   = ctypes.cast(_PINMAP, ctypes.c_void_p).value,
        picsimlab_rmt_event      = _RMT_EVENT(_on_rmt_event),
        picsimlab_gpio_matrix_cb = _GPIO_MATRIX_CB(_on_gpio_matrix),
        picsimlab_spi_event_batch = _SPI_BATCH(_on_spi_batch),
    )
    lib.qemu_picsimlab_register_callbacks(ctypes.byref(_cbs_ref))
    # Log whether the new symbol is present in this libqemu build.
    # Older binaries (pre-1.1.0) silently fall back to the 100 ms
    # poll path; the WS event shape is identical either way.
    try:
        if hasattr(lib, 'picsimlab_gpio_matrix_cb'):
            _log('[gpio-matrix] libqemu 1.1.0+ detected; callback path active '
                 '(poll thread runs as a safety net during burn-in)')
        else:
            _log('[gpio-matrix] libqemu <1.1.0; using poll path only')
    except Exception:
        pass

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
            if sensor_type == 'matrix-keypad':
                _keypad_install(gpio, sensor_data)
            # For I2C sensors, also create the slave state machine immediately
            # so _on_i2c_event can find it when the firmware's Wire.begin() runs.
            elif sensor_type == 'mpu6050':
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
                # ePaper panel: backend decodes SPI traffic and emits
                # `epaper_update` events with the latched framebuffer.  The
                # `controller_family` payload field selects the decoder
                # ('ssd168x' or 'uc8159c') and ALSO determines the BUSY
                # polarity, because the two controller families use opposite
                # active levels in GxEPD2:
                #
                #   SSD168x family (1.54 / 2.13 / 2.9 / 4.2"):
                #     `_busy_level = HIGH` → BUSY=HIGH means "busy",
                #                            BUSY=LOW means "ready".
                #
                #   UltraChip family — UC8159c (5.65" ACeP) and UC8179/GD7965
                #   (7.5" 800x480): `_busy_level = LOW` → BUSY=LOW means "busy",
                #                            BUSY=HIGH means "ready".
                #
                # Pick the IDLE level per family and (a) seed the pin to IDLE
                # at registration so the firmware's first `_waitBusy()` —
                # which runs inside `_PowerOn()` / `_InitDisplay()` BEFORE any
                # frame is sent — sees "ready" and proceeds, and (b) use that
                # polarity when pulsing on frame flush below.
                comp_id = str(s.get('component_id', f'epaper-{gpio}'))
                width = int(s.get('width', 200))
                height = int(s.get('height', 200))
                refresh_ms = int(s.get('refresh_ms', 50))
                busy_pin = int(s.get('busy_pin', -1))
                # Read controller_family early; default to ssd168x for
                # back-compat with old frontends that didn't send it.
                ctl_family_early = str(s.get('controller_family', 'ssd168x'))
                # UltraChip controllers (uc8159c, uc8179) idle BUSY HIGH; the
                # SSD168x family idles BUSY LOW.
                busy_idle_level = 1 if ctl_family_early in ('uc8159c', 'uc8179') else 0
                busy_busy_level = 1 - busy_idle_level
                if busy_pin is not None and busy_pin >= 0:
                    try:
                        lib.qemu_picsimlab_set_pin(busy_pin + 1, busy_idle_level)
                    except Exception:
                        pass

                def _flush_factory(_comp_id=comp_id,
                                   _w=width, _h=height,
                                   _refresh=refresh_ms,
                                   _busy=busy_pin,
                                   _busy_busy=busy_busy_level,
                                   _busy_idle=busy_idle_level,
                                   _lib=lib):
                    """Build an on_flush callback bound to this slave's
                    component_id so the WS event can route to the right panel.
                    Pulses BUSY to its "busy" level for refresh_ms, then back
                    to "ready" — polarity per controller family (see above)."""
                    def _on_flush(frame):
                        try:
                            frame_b64 = base64.b64encode(frame.pixels).decode('ascii')
                        except Exception:
                            return
                        # NOTE: emit FLAT (fields at top level), like every other
                        # worker event. The backend's qemu_callback re-wraps the
                        # post-'type' payload under 'data' (simulation.py), so a
                        # nested 'data' here would double-wrap and the frontend's
                        # msg.data.component_id would be undefined (panel never
                        # renders). This was the long-standing "ESP32 ePaper is
                        # blank" bug.
                        _emit({
                            'type': 'epaper_update',
                            'component_id': _comp_id,
                            'width': _w,
                            'height': _h,
                            'frame_b64': frame_b64,
                            'refresh_ms': _refresh,
                        })
                        if _busy is not None and _busy >= 0:
                            try:
                                _lib.qemu_picsimlab_set_pin(_busy + 1, _busy_busy)

                                def _busy_idle_cb(_b=_busy, _lvl=_busy_idle):
                                    try:
                                        _lib.qemu_picsimlab_set_pin(_b + 1, _lvl)
                                    except Exception:
                                        pass

                                threading.Timer(_refresh / 1000.0, _busy_idle_cb).start()
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
                elif ctl_family == 'uc8179':
                    slave = _Uc8179EpaperSlave(
                        component_id=comp_id, width=width, height=height,
                        on_flush=_flush_factory(),
                    )
                else:
                    _is_bwr = 'bwr' in str(s.get('panel_kind', '')).lower()
                    slave = _Ssd168xEpaperSlave(
                        component_id=comp_id, width=width, height=height,
                        on_flush=_flush_factory(), is_bwr=_is_bwr,
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
                _sync_cs_events()
                sensor_data['epaper_component_id'] = comp_id
                _log(f"[epaper:{ctl_family}] registered '{comp_id}' "
                     f"({width}x{height}) "
                     f"DC={state['dc_pin']} CS={state['cs_pin']} "
                     f"RST={state['rst_pin']} BUSY={state['busy_pin']}")
            elif sensor_type in ('ssd1306', 'pcf8574', 'i2c-write-sink'):
                # 'i2c-write-sink' is the generic form: any write-only device
                # whose rendering lives in the browser (the Grove display
                # chips) is ACKed here and its bytes echoed as i2c_transaction.
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
                            _sync_cs_events()
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
    # Now that the initial components are registered, tell QEMU whether to
    # forward SPI CS toggles (only ePaper/custom-chip need them).
    _sync_cs_events()
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
                # Reconcile the GPIO Matrix mirror first; any routing
                # changes since the last poll are emitted as
                # `gpio_routing` events so frontend's SignalRouter is
                # in sync before duty updates land.
                _refresh_signal_routing()
                # Reconcile internal pull-up/down config (INPUT_PULLUP etc.)
                # so the frontend's netlist can add the matching resistor.
                _refresh_pin_pulls()
                for ch in range(16):
                    duty_pct = float(arr[ch])
                    if abs(duty_pct - _last_duty[ch]) < 0.01:
                        continue
                    _last_duty[ch] = duty_pct
                    if duty_pct > 0:
                        rounded = round(duty_pct, 2)
                        _emit({'type': 'ledc_duty',
                               'channel': ch,
                               'duty_pct': rounded})
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
            # Keypad-owned columns are driven synchronously by
            # _keypad_recompute; a stale async gpio_in from the browser's
            # generic matrix simulation must not clobber them.
            #
            # Must hold the QEMU IO-thread lock, same as uart_send below: with
            # attachInterrupt() armed on this pin, the injected edge raises the
            # GPIO interrupt into the guest CPU from THIS thread, and QEMU
            # aborts the whole process on it — `tcg_handle_interrupt: assertion
            # failed: (bql_locked())`, issue #273. A pin without an armed
            # interrupt never walked that path, which is why every ordinary
            # button and sensor worked while a rotary encoder ISR died on the
            # first real edge.
            if int(cmd['pin']) not in _keypad_cols_owned:
                if _lock_iothread:
                    _lock_iothread(b'esp32_worker.py:set_pin', 0)
                try:
                    lib.qemu_picsimlab_set_pin(int(cmd['pin']) + 1, int(cmd['value']))
                finally:
                    if _unlock_iothread:
                        _unlock_iothread()

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
                if sensor_type == 'matrix-keypad':
                    _keypad_install(gpio, sensor_data)
                elif sensor_type == 'ir-nec':
                    # A demodulator's output idles HIGH and the host owns it:
                    # nothing on the canvas or in the guest may drive this pad.
                    # Seeded here rather than on the first frame, because a
                    # decoder samples the line from the moment it starts and a
                    # pad left at 0 reads as a transmission that never ends.
                    try:
                        lib.qemu_picsimlab_set_pin(gpio + 1, 1)
                    except Exception:
                        pass
                elif sensor_type == 'mpu6050':
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
                elif sensor_type in ('ssd1306', 'pcf8574', 'i2c-write-sink'):
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
                            # Emit FLAT (see the _init_sensors path) — the backend
                            # re-wraps under 'data', so a nested 'data' here would
                            # double-wrap and the frontend would never render.
                            _emit({
                                'type': 'epaper_update',
                                'component_id': _comp_id,
                                'width': _w,
                                'height': _h,
                                'frame_b64': frame_b64,
                                'refresh_ms': _refresh,
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
                    elif ctl_family == 'uc8179':
                        slave = _Uc8179EpaperSlave(
                            component_id=comp_id, width=width, height=height,
                            on_flush=_flush_factory_rt(),
                        )
                    else:
                        _is_bwr = 'bwr' in str(cmd.get('panel_kind', '')).lower()
                        slave = _Ssd168xEpaperSlave(
                            component_id=comp_id, width=width, height=height,
                            on_flush=_flush_factory_rt(), is_bwr=_is_bwr,
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
                    _sync_cs_events()
                    sensor_data['epaper_component_id'] = comp_id
                _sensors[gpio] = sensor_data
            _log(f'Sensor {sensor_type} attached on GPIO {gpio}')

        elif c == 'sensor_update':
            gpio = int(cmd['pin'])
            # Frames to arm once the lock is back off. `_sensors_lock` is a
            # plain Lock and `_ir_arm` takes it itself, so arming from inside
            # the block below would deadlock the command thread on the first
            # button press.
            _ir_pending: list = []
            with _sensors_lock:
                sensor = _sensors.get(gpio)
                if sensor:
                    for k, v in cmd.items():
                        if k not in ('cmd', 'pin'):
                            sensor[k] = v
                    stype = sensor.get('type')
                    slave = sensor.get('slave')
                    if stype == 'ir-nec':
                        # A trigger key's VALUE CHANGING is the transmission,
                        # whatever the new value is. It has to be a change and
                        # not a presence: the frontend's hosted path merges the
                        # whole record into every update, so the key is present
                        # on every slider tick and a model that fired on
                        # presence would transmit once per tick.
                        fired = False
                        for _k in ('seq', 'send'):
                            if _k not in cmd:
                                continue
                            if cmd[_k] != sensor.get('_ir_seen_' + _k):
                                fired = True
                            sensor['_ir_seen_' + _k] = cmd[_k]
                        if fired:
                            _ir_pending.append((gpio, _ir_pulses_for(sensor)))
                    elif stype == 'matrix-keypad':
                        kp = sensor.get('keypad')
                        if kp is not None and 'pressed' in cmd:
                            kp['pressed'] = {
                                (int(rc[0]), int(rc[1]))
                                for rc in (cmd.get('pressed') or [])
                            }
                            # Same rule as set_pin above: this runs on the
                            # command thread and drives column pins a sketch
                            # may have interrupts on. The recompute calls from
                            # QEMU callbacks (pin write/dir sync) must NOT
                            # take the lock — they already hold it and the BQL
                            # is not recursive — so the lock lives at the
                            # THREAD boundary, not inside _keypad_recompute.
                            if _lock_iothread:
                                _lock_iothread(b'esp32_worker.py:keypad', 0)
                            try:
                                _keypad_recompute(kp)
                            finally:
                                if _unlock_iothread:
                                    _unlock_iothread()
                    elif stype == 'mpu6050' and slave is not None:
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
                    elif stype == 'custom-chip':
                        # Live control values (chip.json `controls`) land on
                        # the chip runtime's attr store; the running WASM
                        # re-reads them on every vx_attr_read.
                        rt = sensor.get('runtime')
                        new_attrs = cmd.get('attrs')
                        if rt is not None and isinstance(new_attrs, dict):
                            try:
                                rt.update_attrs({
                                    str(k): float(v) for k, v in new_attrs.items()
                                    if isinstance(v, (int, float))
                                })
                            except Exception as e:
                                _log(f'[custom-chip] attr update failed: {e!r}')

            for _g, _p in _ir_pending:
                with _sensors_lock:
                    _s = _sensors.get(_g)
                if _s is not None:
                    _ir_arm(_g, _s, _p, 'canvas')

        elif c == 'sensor_detach':
            gpio = int(cmd['pin'])
            with _sensors_lock:
                sensor = _sensors.pop(gpio, None)
                if sensor and sensor.get('type') == 'matrix-keypad':
                    _keypad_uninstall(sensor)
                if sensor and 'i2c_addr' in sensor:
                    _i2c_slaves.pop(sensor['i2c_addr'], None)
                if sensor and 'epaper_component_id' in sensor:
                    cid = sensor['epaper_component_id']
                    _epaper_slaves.pop(cid, None)
                    _epaper_state.pop(cid, None)
            _log(f'Sensor detached from GPIO {gpio}')

        # ── Cross-board I2C proxy slave ──────────────────────────────────
        # Installed by the frontend when an ESP32 board is wired across
        # the I2C bus to a peer board (Uno, Pico, …) that owns a virtual
        # device.  The frontend snapshots the device's register state and
        # pushes it here; we install a ProxySlave at the address so the
        # ESP32 firmware's Wire master reads succeed inside QEMU.
        elif c == 'proxy_i2c_register':
            i2c_addr = int(cmd.get('addr', 0)) & 0x7F
            try:
                regs = base64.b64decode(cmd.get('regs_b64', ''))
            except Exception as exc:
                _log(f'proxy_i2c_register: bad base64: {exc}')
                regs = b''
            # Pass _emit so writes from the ESP32 firmware get forwarded
            # back to the frontend as `proxy_i2c_complete` events.  The
            # frontend then replays the byte sequence on the actual
            # peer I2CDevice so its state (PCF8574 latch, SSD1306
            # GDDRAM, memory device registers …) stays in sync.
            _i2c_slaves[i2c_addr] = _ProxySlave(i2c_addr, regs, emit_fn=_emit)
            _log(f'proxy_i2c registered at 0x{i2c_addr:02x} ({len(regs)} bytes)')

        elif c == 'proxy_i2c_update':
            i2c_addr = int(cmd.get('addr', 0)) & 0x7F
            try:
                regs = base64.b64decode(cmd.get('regs_b64', ''))
            except Exception as exc:
                _log(f'proxy_i2c_update: bad base64: {exc}')
                regs = b''
            slave = _i2c_slaves.get(i2c_addr)
            if slave is not None and hasattr(slave, 'update_registers'):
                slave.update_registers(regs)
                _log(f'proxy_i2c updated at 0x{i2c_addr:02x} ({len(regs)} bytes)')

        elif c == 'proxy_i2c_unregister':
            i2c_addr = int(cmd.get('addr', 0)) & 0x7F
            popped = _i2c_slaves.pop(i2c_addr, None)
            if popped is not None:
                _log(f'proxy_i2c unregistered at 0x{i2c_addr:02x}')

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
            # Drain any queued events (crash/system notifications) before the
            # hard exit — the emit writer is a daemon thread and would lose
            # the tail otherwise. The sentinel ends its loop.
            try:
                _emit_q.put_nowait(None)
                for t in threading.enumerate():
                    if t.name == 'emit-writer':
                        t.join(timeout=2.0)
            except Exception:
                pass
            os._exit(0)


if __name__ == '__main__':
    main()
