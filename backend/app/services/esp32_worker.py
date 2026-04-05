from __future__ import annotations
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
    _i2c_responses: dict[int, int] = {}     # 7-bit addr → response byte
    _spi_response   = [0xFF]                # MISO byte for SPI transfers
    _rmt_decoders:  dict[int, _RmtDecoder] = {}
    _uart0_buf      = bytearray()           # accumulate UART0 for crash detection
    _reboot_count   = [0]
    _crashed        = [False]
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

    def _busy_wait_us(us: int) -> None:
        """Busy-wait for the given number of microseconds using perf_counter_ns."""
        end = time.perf_counter_ns() + us * 1000
        while time.perf_counter_ns() < end:
            pass

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

    # ── DHT22 sync-based response ────────────────────────────────────────────
    # Instead of driving pins from a separate Python thread (which requires
    # cross-thread qemu_picsimlab_set_pin calls — unsafe because the QEMU
    # iothread mutex is commented out), we drive pins synchronously from
    # within the GPIO_IN read sync callback.
    #
    # Every digitalRead() in the firmware's expectPulse() loop triggers a
    # sync event: _on_dir_change(slot=-1, direction=-1).  By counting these
    # syncs and toggling the pin at the right moments, we inject the DHT22
    # waveform perfectly synchronized with QEMU execution.
    #
    # The Adafruit DHT library decodes bits by comparing highCycles vs
    # lowCycles counts — only the RATIO matters, not absolute values.
    # So we use the raw µs values as sync counts (e.g. 80 syncs for 80µs),
    # which preserves the correct ratios.

    _dht22_sync: list[dict | None] = [None]  # mutable container for nonlocal access

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

    def _dht22_sync_step() -> None:
        """Advance the DHT22 sync response by one GPIO_IN read.

        Called on the QEMU thread from the GPIO_IN read sync handler.
        Each call corresponds to one digitalRead() in the firmware's
        expectPulse() loop.
        """
        state = _dht22_sync[0]
        if state is None:
            return

        state['count'] += 1
        phase_idx = state['phase_idx']
        phases = state['phases']

        if phase_idx >= len(phases):
            # All phases done — clean up immediately
            _dht22_sync_cleanup(state)
            return

        target, pin_value = phases[phase_idx]
        if state['count'] >= target:
            lib.qemu_picsimlab_set_pin(state['slot'], pin_value)
            state['total_syncs'] += state['count']
            state['count'] = 0
            state['phase_idx'] += 1
            # If that was the last phase, clean up now — the firmware's
            # expectPulse() loop ends after the last data bit, so no more
            # syncs will arrive to trigger cleanup later.
            if state['phase_idx'] >= len(phases):
                _dht22_sync_cleanup(state)

    def _dht22_sync_cleanup(state: dict) -> None:
        """Clean up after DHT22 sync response completes."""
        gpio_pin = state['gpio']
        total = state['total_syncs']
        with _sensors_lock:
            sensor = _sensors.get(gpio_pin)
            if sensor:
                sensor['responding'] = False
        _dht22_sync[0] = None
        _log(f'DHT22 sync respond done gpio={gpio_pin} '
             f'total_syncs={total} phases={len(state["phases"])}')
        _emit({'type': 'system', 'event': 'dht22_diag',
               'gpio': gpio_pin, 'status': 'ok',
               'total_syncs': total})

    def _hcsr04_respond(trig_pin: int, echo_pin: int, distance_cm: float) -> None:
        """Thread function: inject the HC-SR04 echo pulse via qemu_picsimlab_set_pin."""
        echo_slot = echo_pin + 1  # identity pinmap: slot = gpio + 1
        # Echo pulse width = distance_cm * 58 µs (speed of sound round trip)
        echo_us = max(100, int(distance_cm * 58))

        try:
            # Wait for TRIG pulse to finish + propagation delay (~600 µs)
            _busy_wait_us(600)
            # Drive ECHO HIGH
            lib.qemu_picsimlab_set_pin(echo_slot, 1)
            # Hold ECHO HIGH for distance-proportional duration
            _busy_wait_us(echo_us)
            # Drive ECHO LOW
            lib.qemu_picsimlab_set_pin(echo_slot, 0)
        except Exception as exc:
            _log(f'HC-SR04 respond error on TRIG {trig_pin} ECHO {echo_pin}: {exc}')
        finally:
            with _sensors_lock:
                sensor = _sensors.get(trig_pin)
                if sensor:
                    sensor['responding'] = False

    # ── 5. ctypes callbacks (called from QEMU thread) ─────────────────────────

    def _on_pin_change(slot: int, value: int) -> None:
        if _stopped.is_set():
            return
        gpio = int(_PINMAP[slot]) if 1 <= slot <= _GPIO_COUNT else slot
        _emit({'type': 'gpio_change', 'pin': gpio, 'state': value})

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
            # HC-SR04: detect TRIG going HIGH (firmware sends 10µs pulse)
            if value == 1 and not sensor.get('responding', False):
                sensor['responding'] = True
                echo_pin = int(sensor.get('echo_pin', gpio + 1))
                distance = float(sensor.get('distance', 40.0))
                threading.Thread(
                    target=_hcsr04_respond,
                    args=(gpio, echo_pin, distance),
                    daemon=True,
                    name=f'hcsr04-gpio{gpio}',
                ).start()

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
                # GPIO_IN read sync — advance DHT22 response if active
                if _dht22_sync[0] is not None:
                    _dht22_sync_step()
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
                        _dht22_sync[0] = {
                            'gpio': gpio,
                            'slot': slot,
                            'phases': phases,
                            'phase_idx': 0,
                            'count': 0,
                            'total_syncs': 0,
                        }
                        _log(f'DHT22 sync armed gpio={gpio} '
                             f'temp={temp} hum={hum} '
                             f'phases={len(phases)} payload={payload}')
        gpio = int(_PINMAP[slot]) if 1 <= slot <= _GPIO_COUNT else slot
        _emit({'type': 'gpio_dir', 'pin': gpio, 'dir': direction})

    def _on_uart_tx(uart_id: int, byte_val: int) -> None:
        if _stopped.is_set():
            return
        _emit({'type': 'uart_tx', 'uart': uart_id, 'byte': byte_val})
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

    def _on_i2c_event(bus_id: int, addr: int, event: int) -> int:
        """Synchronous — must return immediately; called from QEMU thread."""
        resp = _i2c_responses.get(addr, 0)
        if not _stopped.is_set():
            _emit({'type': 'i2c_event', 'bus': bus_id, 'addr': addr,
                   'event': event, 'response': resp})
        return resp

    def _on_spi_event(bus_id: int, event: int) -> int:
        """Synchronous — must return immediately; called from QEMU thread."""
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
            _sensors[gpio] = {
                'type': sensor_type,
                **{k: v for k, v in s.items() if k not in ('sensor_type', 'pin')},
                'saw_low': False,
                'responding': False,
            }
        _log(f'Pre-registered sensor {sensor_type} on GPIO {gpio}')
    _sensors_ready.set()

    _emit({'type': 'system', 'event': 'booted'})
    _log(f'QEMU started: machine={machine} firmware={firmware_path}')
    _log(f'QEMU args: {[a.decode() for a in args_list]}')

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

        elif c == 'uart_send':
            data = base64.b64decode(cmd['data'])
            buf  = (ctypes.c_uint8 * len(data))(*data)
            lib.qemu_picsimlab_uart_receive(int(cmd.get('uart', 0)), buf, len(data))

        elif c == 'set_i2c_response':
            _i2c_responses[int(cmd['addr'])] = int(cmd['response']) & 0xFF

        elif c == 'set_spi_response':
            _spi_response[0] = int(cmd['response']) & 0xFF

        elif c == 'sensor_attach':
            gpio = int(cmd['pin'])
            sensor_type = cmd.get('sensor_type', '')
            with _sensors_lock:
                _sensors[gpio] = {
                    'type': sensor_type,
                    **{k: v for k, v in cmd.items()
                       if k not in ('cmd', 'pin', 'sensor_type')},
                    'saw_low': False,
                    'responding': False,
                }
            _log(f'Sensor {sensor_type} attached on GPIO {gpio}')

        elif c == 'sensor_update':
            gpio = int(cmd['pin'])
            with _sensors_lock:
                sensor = _sensors.get(gpio)
                if sensor:
                    for k, v in cmd.items():
                        if k not in ('cmd', 'pin'):
                            sensor[k] = v

        elif c == 'sensor_detach':
            gpio = int(cmd['pin'])
            with _sensors_lock:
                _sensors.pop(gpio, None)
            _log(f'Sensor detached from GPIO {gpio}')

        elif c == 'stop':
            _stopped.set()
            # Signal QEMU to shut down. The assertion that fires on Windows
            # ("Bail out!") is non-fatal — glib just logs it and continues.
            try:
                lib.qemu_cleanup()
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
