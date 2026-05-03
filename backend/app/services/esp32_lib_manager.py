"""
EspLibManager — ESP32 emulation via lcgamboa libqemu-xtensa (.dll/.so).

Each call to start_instance() launches a fresh esp32_worker.py subprocess that
loads the DLL in its own address space.  This enables multiple simultaneous
ESP32 emulations without DLL global-state conflicts.

subprocess.Popen is used instead of asyncio.create_subprocess_exec because on
Windows with uvicorn --reload the asyncio ProactorEventLoop child watcher is
not available, causing asyncio subprocess creation to raise NotImplementedError
(which has an empty str() and therefore appears as a blank error message).
Background daemon threads read stdout/stderr and dispatch events back to the
asyncio event loop via asyncio.run_coroutine_threadsafe().

Public API is identical to the previous in-process version so simulation.py
requires no changes.

Activation: set environment variable QEMU_ESP32_LIB to the library path, or
place libqemu-xtensa.dll (Windows) / libqemu-xtensa.so (Linux) beside this
module.

Events emitted via callback(event_type, data):
  system        {event: 'booting'|'booted'|'crash'|'reboot'}
  serial_output {data: str, uart: int}     — UART 0/1/2 text
  gpio_change   {pin: int, state: int}     — real GPIO number (0-39)
  gpio_dir      {pin: int, dir: int}       — 0=input 1=output
  i2c_event     {bus: int, addr: int, event: int, response: int}
  spi_event     {bus: int, event: int, response: int}
  rmt_event     {channel: int, config0: int, value: int,
                 level0: int, dur0: int, level1: int, dur1: int}
  ws2812_update {channel: int, pixels: list[{r,g,b}]}
  ledc_update   {channel: int, duty: int, duty_pct: float}
  error         {message: str}
"""
import asyncio
import base64
import dataclasses
import json
import logging
import os
import pathlib
import subprocess
import sys
import threading
from typing import Callable, Awaitable

logger = logging.getLogger(__name__)

# ── Library path detection ────────────────────────────────────────────────────
_SERVICES_DIR = pathlib.Path(__file__).parent

# Per-platform shared library extension. The build-libqemu CI publishes
# .so for Linux, .dll for Windows MINGW64, .dylib for macOS — and the
# release-download step in Dockerfile.standalone / native installers
# renames the arch-specific asset to the bare name expected here.
if sys.platform == 'win32':
    _LIB_EXT = '.dll'
elif sys.platform == 'darwin':
    _LIB_EXT = '.dylib'
else:
    _LIB_EXT = '.so'

# Xtensa library (ESP32, ESP32-S3)
_LIB_XTENSA_NAME = f'libqemu-xtensa{_LIB_EXT}'
_DEFAULT_LIB_XTENSA = str(_SERVICES_DIR / _LIB_XTENSA_NAME)
LIB_PATH: str = os.environ.get('QEMU_ESP32_LIB', '') or (
    _DEFAULT_LIB_XTENSA if os.path.isfile(_DEFAULT_LIB_XTENSA) else ''
)

# RISC-V library (ESP32-C3)
_LIB_RISCV_NAME = f'libqemu-riscv32{_LIB_EXT}'
_DEFAULT_LIB_RISCV = str(_SERVICES_DIR / _LIB_RISCV_NAME)
LIB_RISCV_PATH: str = os.environ.get('QEMU_RISCV32_LIB', '') or (
    _DEFAULT_LIB_RISCV if os.path.isfile(_DEFAULT_LIB_RISCV) else ''
)

_WORKER_SCRIPT = _SERVICES_DIR / 'esp32_worker.py'

EventCallback = Callable[[str, dict], Awaitable[None]]

# lcgamboa machine names and which DLL each board requires
_MACHINE: dict[str, str] = {
    'esp32':                          'esp32-picsimlab',
    'esp32-s3':                       'esp32s3-picsimlab',
    'esp32-c3':                       'esp32c3-picsimlab',
    'xiao-esp32-c3':                  'esp32c3-picsimlab',
    'aitewinrobot-esp32c3-supermini': 'esp32c3-picsimlab',
}

# Board types that require the RISC-V library instead of the Xtensa one
_RISCV_BOARDS = {'esp32-c3', 'xiao-esp32-c3', 'aitewinrobot-esp32c3-supermini'}


# ── UART buffer ───────────────────────────────────────────────────────────────

class _UartBuffer:
    """Accumulate bytes per UART channel, flush on newline or size limit."""

    def __init__(self, uart_id: int, flush_size: int = 256):
        self.uart_id    = uart_id
        self.flush_size = flush_size
        self._buf: bytearray = bytearray()
        self._lock = threading.Lock()

    def feed(self, byte_val: int) -> str | None:
        """Add one byte. Returns decoded string when a flush occurs, else None."""
        with self._lock:
            self._buf.append(byte_val)
            # Flush on newline, carriage return, period, or max size
            # This ensures progress dots '...' don't buffer endlessly.
            if byte_val in (ord('\n'), ord('\r'), ord('.')) or len(self._buf) >= self.flush_size:
                text = self._buf.decode('utf-8', errors='replace')
                self._buf.clear()
                return text
        return None

    def flush(self) -> str | None:
        """Force-flush any remaining bytes."""
        with self._lock:
            if self._buf:
                text = self._buf.decode('utf-8', errors='replace')
                self._buf.clear()
                return text
        return None


# ── Per-instance state ────────────────────────────────────────────────────────

@dataclasses.dataclass
class _WorkerInstance:
    process:    subprocess.Popen
    stdin_lock: threading.Lock
    callback:   EventCallback
    board_type: str
    uart_bufs:  dict[int, _UartBuffer]
    threads:    list[threading.Thread]
    loop:       asyncio.AbstractEventLoop
    running:    bool = True
    wifi_enabled: bool = False
    wifi_hostfwd_port: int = 0


# ── Manager ───────────────────────────────────────────────────────────────────

class EspLibManager:
    """
    Manages ESP32 emulation — each instance is a separate Python subprocess
    that loads libqemu-xtensa in its own address space.
    """

    def __init__(self):
        self._instances: dict[str, _WorkerInstance] = {}
        self._instances_lock = threading.Lock()

    # ── Availability ──────────────────────────────────────────────────────────

    @staticmethod
    def is_available() -> bool:
        """Returns True if the Xtensa DLL is present (minimum for ESP32/ESP32-S3)."""
        return (
            bool(LIB_PATH)
            and os.path.isfile(LIB_PATH)
            and _WORKER_SCRIPT.exists()
        )

    @staticmethod
    def is_riscv_available() -> bool:
        """Returns True if the RISC-V DLL is present (required for ESP32-C3)."""
        return bool(LIB_RISCV_PATH) and os.path.isfile(LIB_RISCV_PATH)

    # ── Public API ────────────────────────────────────────────────────────────

    def get_instance(self, client_id: str) -> _WorkerInstance | None:
        """Return the worker instance for a client, or None."""
        with self._instances_lock:
            return self._instances.get(client_id)

    async def start_instance(
        self,
        client_id:    str,
        board_type:   str,
        callback:     EventCallback,
        firmware_b64: str | None = None,
        sensors:      list | None = None,
        wifi_enabled: bool = False,
        wifi_hostfwd_port: int = 0,
    ) -> None:
        # Stop any existing instance for this client_id first
        if client_id in self._instances:
            logger.info('start_instance: %s already running — stopping first', client_id)
            await self.stop_instance(client_id)

        if not firmware_b64:
            logger.info('start_instance %s: no firmware — skipping worker launch', client_id)
            return

        machine  = _MACHINE.get(board_type, 'esp32-picsimlab')
        lib_path = LIB_RISCV_PATH if board_type in _RISCV_BOARDS else LIB_PATH
        config   = json.dumps({
            'lib_path':          lib_path,
            'firmware_b64':      firmware_b64,
            'machine':           machine,
            'sensors':           sensors or [],
            'wifi_enabled':      wifi_enabled,
            'wifi_hostfwd_port': wifi_hostfwd_port,
        })

        logger.info('Launching esp32_worker for %s (machine=%s, script=%s, python=%s)',
                    client_id, machine, _WORKER_SCRIPT, sys.executable)
        try:
            await callback('system', {'event': 'booting'})
        except Exception as exc:
            logger.warning('start_instance %s: booting event delivery failed: %s', client_id, exc)

        try:
            proc = subprocess.Popen(
                [sys.executable, str(_WORKER_SCRIPT)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except Exception as exc:
            logger.error('Failed to launch esp32_worker for %s: %r', client_id, exc, exc_info=True)
            await callback('error', {'message': f'Worker launch failed: {type(exc).__name__}: {exc}'})
            return

        # Write config as the first stdin line
        try:
            assert proc.stdin  is not None
            assert proc.stdout is not None
            assert proc.stderr is not None
            proc.stdin.write((config + '\n').encode())
            proc.stdin.flush()
        except Exception as exc:
            logger.error('Failed to write config to esp32_worker %s: %r', client_id, exc)
            proc.kill()
            return

        loop = asyncio.get_running_loop()
        inst = _WorkerInstance(
            process           = proc,
            stdin_lock        = threading.Lock(),
            callback          = callback,
            board_type        = board_type,
            uart_bufs         = {0: _UartBuffer(0), 1: _UartBuffer(1), 2: _UartBuffer(2)},
            threads           = [],
            loop              = loop,
            wifi_enabled      = wifi_enabled,
            wifi_hostfwd_port = wifi_hostfwd_port,
        )

        with self._instances_lock:
            self._instances[client_id] = inst

        t_out = threading.Thread(
            target=self._thread_read_stdout,
            args=(inst, client_id),
            daemon=True,
            name=f'worker-stdout-{client_id[:8]}',
        )
        t_err = threading.Thread(
            target=self._thread_read_stderr,
            args=(inst, client_id),
            daemon=True,
            name=f'worker-stderr-{client_id[:8]}',
        )
        inst.threads = [t_out, t_err]
        t_out.start()
        t_err.start()

    async def stop_instance(self, client_id: str) -> None:
        with self._instances_lock:
            inst = self._instances.pop(client_id, None)
        if not inst:
            return
        inst.running = False

        # Flush any remaining UART bytes
        for buf in inst.uart_bufs.values():
            text = buf.flush()
            if text:
                try:
                    await inst.callback('serial_output', {'data': text, 'uart': buf.uart_id})
                except Exception:
                    pass

        # Ask the worker to stop gracefully
        self._write_cmd(inst, {'cmd': 'stop'})

        # Wait for clean shutdown in a thread to avoid blocking the event loop
        def _wait_and_kill():
            try:
                inst.process.wait(timeout=6.0)
            except subprocess.TimeoutExpired:
                logger.warning('Worker %s did not stop in 6 s — killing', client_id)
                inst.process.kill()
                inst.process.wait()
            except Exception as exc:
                logger.debug('stop_instance %s wait: %s', client_id, exc)

        await asyncio.to_thread(_wait_and_kill)
        logger.info('WorkerInstance %s shut down', client_id)

    def load_firmware(self, client_id: str, firmware_b64: str) -> None:
        """Hot-reload firmware: stop the current worker and start a fresh one."""
        with self._instances_lock:
            inst = self._instances.get(client_id)
        if not inst:
            logger.warning('load_firmware: no instance for %s', client_id)
            return
        board_type = inst.board_type
        callback   = inst.callback

        async def _restart() -> None:
            await self.stop_instance(client_id)
            await asyncio.sleep(0.1)
            await self.start_instance(client_id, board_type, callback, firmware_b64)

        asyncio.ensure_future(_restart())

    # ── GPIO / ADC / UART control ─────────────────────────────────────────────

    def set_pin_state(self, client_id: str, pin: int | str, state_val: int) -> None:
        """Drive a GPIO input pin (real GPIO number 0-39)."""
        with self._instances_lock:
            inst = self._instances.get(client_id)
        if inst and inst.running and inst.process.returncode is None:
            self._write_cmd(inst, {'cmd': 'set_pin', 'pin': int(pin), 'value': state_val})

    async def send_serial_bytes(
        self, client_id: str, data: bytes, uart_id: int = 0
    ) -> None:
        """Send bytes to ESP32 UART RX (uart_id 0/1/2)."""
        with self._instances_lock:
            inst = self._instances.get(client_id)
        if inst and inst.running and inst.process.returncode is None:
            self._write_cmd(inst, {
                'cmd':  'uart_send',
                'uart': uart_id,
                'data': base64.b64encode(data).decode(),
            })

    def set_adc(self, client_id: str, channel: int, millivolts: int) -> None:
        """Set ADC channel voltage in millivolts (0-3300 mV)."""
        with self._instances_lock:
            inst = self._instances.get(client_id)
        if inst and inst.running and inst.process.returncode is None:
            self._write_cmd(inst, {'cmd': 'set_adc', 'channel': channel, 'millivolts': millivolts})

    def set_adc_raw(self, client_id: str, channel: int, raw: int) -> None:
        """Set ADC channel with a 12-bit raw value (0-4095)."""
        with self._instances_lock:
            inst = self._instances.get(client_id)
        if inst and inst.running and inst.process.returncode is None:
            self._write_cmd(inst, {'cmd': 'set_adc_raw', 'channel': channel, 'raw': raw})

    def set_adc_waveform(self, client_id: str, channel: int, samples_b64: str,
                         period_ns: int) -> None:
        """
        Push a periodic 12-bit waveform LUT for an ADC channel to QEMU.

        QEMU stores the samples against its virtual clock and interpolates
        them on every MMIO ADC read — giving ESP32 boards the same per-read
        ADC fidelity AVR and RP2040 have via `onADCRead` monkey-patching.

        An empty `samples_b64` with `period_ns == 0` clears the waveform and
        restores the DC `set_adc` behavior.
        """
        with self._instances_lock:
            inst = self._instances.get(client_id)
        if inst and inst.running and inst.process.returncode is None:
            self._write_cmd(inst, {
                'cmd': 'set_adc_waveform',
                'channel': channel,
                'samples_u12_b64': samples_b64,
                'period_ns': period_ns,
            })

    # ── I2C / SPI device simulation ───────────────────────────────────────────

    def set_i2c_response(self, client_id: str, addr: int, response_byte: int) -> None:
        """Configure the byte returned when ESP32 reads from I2C address addr."""
        with self._instances_lock:
            inst = self._instances.get(client_id)
        if inst and inst.running and inst.process.returncode is None:
            self._write_cmd(inst, {'cmd': 'set_i2c_response', 'addr': addr,
                                   'response': response_byte & 0xFF})

    def set_spi_response(self, client_id: str, response_byte: int) -> None:
        """Configure the MISO byte returned during SPI transfers."""
        with self._instances_lock:
            inst = self._instances.get(client_id)
        if inst and inst.running and inst.process.returncode is None:
            self._write_cmd(inst, {'cmd': 'set_spi_response', 'response': response_byte & 0xFF})

    # ── Generic sensor protocol offloading ──────────────────────────────────

    def sensor_attach(self, client_id: str, sensor_type: str, pin: int,
                      properties: dict) -> None:
        """Register a sensor on a GPIO pin — the worker handles its protocol."""
        with self._instances_lock:
            inst = self._instances.get(client_id)
        if inst and inst.running and inst.process.returncode is None:
            self._write_cmd(inst, {
                'cmd': 'sensor_attach', 'sensor_type': sensor_type,
                'pin': pin, **{k: v for k, v in properties.items()
                               if k not in ('sensor_type', 'pin')},
            })

    def sensor_update(self, client_id: str, pin: int,
                      properties: dict) -> None:
        """Update a sensor's properties (temperature, humidity, distance…)."""
        with self._instances_lock:
            inst = self._instances.get(client_id)
        if inst and inst.running and inst.process.returncode is None:
            self._write_cmd(inst, {
                'cmd': 'sensor_update', 'pin': pin,
                **{k: v for k, v in properties.items() if k != 'pin'},
            })

    def sensor_detach(self, client_id: str, pin: int) -> None:
        """Remove a sensor from a GPIO pin."""
        with self._instances_lock:
            inst = self._instances.get(client_id)
        if inst and inst.running and inst.process.returncode is None:
            self._write_cmd(inst, {'cmd': 'sensor_detach', 'pin': pin})

    # ── ESP32-CAM: OV2640 frame injection ─────────────────────────────────────
    # The QEMU peripheral (hw/misc/esp32_i2s_cam.c) accepts host-pushed
    # frames via velxio_push_camera_frame(). We forward the JPEG/RGB565
    # payload to the worker which calls the ctypes binding. Once the .so
    # is rebuilt with the camera patches, this path delivers the bytes
    # the upstream esp32-camera driver returns from esp_camera_fb_get().

    def camera_attach(self, client_id: str, properties: dict) -> None:
        """Tell the worker a camera is wired (frame source ready)."""
        with self._instances_lock:
            inst = self._instances.get(client_id)
        if inst and inst.running and inst.process.returncode is None:
            self._write_cmd(inst, {
                'cmd': 'camera_attach',
                **{k: v for k, v in properties.items() if k != 'cmd'},
            })

    def camera_frame(self, client_id: str, jpeg_b64: str,
                     fmt: str = 'jpeg', width: int = 0, height: int = 0) -> None:
        """Push a single frame to the worker's QEMU image."""
        with self._instances_lock:
            inst = self._instances.get(client_id)
        if inst and inst.running and inst.process.returncode is None:
            self._write_cmd(inst, {
                'cmd': 'camera_frame',
                'fmt': fmt, 'w': width, 'h': height, 'b64': jpeg_b64,
            })

    def camera_detach(self, client_id: str) -> None:
        """Drop the queued frame and any host-side camera state."""
        with self._instances_lock:
            inst = self._instances.get(client_id)
        if inst and inst.running and inst.process.returncode is None:
            self._write_cmd(inst, {'cmd': 'camera_detach'})

    # ── LEDC polling (no-op: worker polls automatically) ─────────────────────

    async def poll_ledc(self, client_id: str) -> None:
        """No-op: LEDC polling runs inside the worker subprocess."""

    # ── Status ────────────────────────────────────────────────────────────────

    def get_status(self, client_id: str) -> dict:
        """Return runtime status for a client instance."""
        with self._instances_lock:
            inst = self._instances.get(client_id)
        if not inst:
            return {'running': False}
        return {
            'running': True,
            'alive':   inst.process.returncode is None,
            'board':   inst.board_type,
        }

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _write_cmd(self, inst: _WorkerInstance, cmd: dict) -> None:
        """Write one JSON command line to the worker's stdin (thread-safe)."""
        try:
            with inst.stdin_lock:
                assert inst.process.stdin is not None
                inst.process.stdin.write((json.dumps(cmd) + '\n').encode())
                inst.process.stdin.flush()
        except Exception as exc:
            logger.debug('_write_cmd failed: %s', exc)

    def _thread_read_stdout(self, inst: _WorkerInstance, client_id: str) -> None:
        """
        Background daemon thread: reads JSON event lines from the worker's
        stdout and dispatches them to the asyncio callback via
        run_coroutine_threadsafe().
        """
        try:
            assert inst.process.stdout is not None
            for raw in inst.process.stdout:
                raw = raw.strip()
                if not raw:
                    continue
                # With -nographic, serial0 is connected to the stdio mux so
                # qemu_chr_fe_write() writes the raw UART byte to fd 1 just
                # before picsimlab_uart_tx_event emits the JSON line.  Strip
                # any prefix bytes before the JSON object marker.
                idx = raw.find(b'{"type":')
                if idx > 0:
                    raw = raw[idx:]
                elif idx < 0:
                    logger.debug('[%s] ignoring non-JSON worker line: %s',
                                 client_id, raw[:200])
                    continue
                try:
                    event = json.loads(raw)
                except Exception:
                    logger.debug('[%s] bad JSON from worker: %s', client_id, raw[:200])
                    continue

                etype = event.pop('type', '')

                if etype == 'uart_tx':
                    uart_id  = event.get('uart', 0)
                    byte_val = event.get('byte', 0)
                    buf = inst.uart_bufs.get(uart_id)
                    if buf:
                        text = buf.feed(byte_val)
                        if text:
                            self._dispatch(inst, 'serial_output', {
                                'data': text, 'uart': uart_id,
                            })
                            # Parse WiFi/BLE status from UART0 output
                            if uart_id == 0 and inst.wifi_enabled:
                                from app.services.wifi_status_parser import parse_serial_text
                                wifi_evts, ble_evts = parse_serial_text(text)
                                for we in wifi_evts:
                                    self._dispatch(inst, 'wifi_status', dict(we))
                                for be in ble_evts:
                                    self._dispatch(inst, 'ble_status', dict(be))
                elif etype:
                    self._dispatch(inst, etype, event)

        except Exception as exc:
            if inst.running:
                logger.debug('[%s] _thread_read_stdout ended: %s', client_id, exc)
        finally:
            rc = inst.process.returncode
            if rc is None:
                # process stdout closed but process still running
                inst.process.poll()
                rc = inst.process.returncode
            if inst.running and rc is not None:
                logger.warning('[%s] worker exited unexpectedly (code %s)', client_id, rc)
                self._dispatch(inst, 'system', {
                    'event':  'crash',
                    'reason': 'worker_exit',
                    'code':   rc,
                })

    def _thread_read_stderr(self, inst: _WorkerInstance, client_id: str) -> None:
        """Forward worker stderr to backend logs at DEBUG level."""
        try:
            assert inst.process.stderr is not None
            for line in inst.process.stderr:
                logger.info('[worker:%s] %s', client_id,
                            line.decode(errors='replace').rstrip())
        except Exception:
            pass

    def _dispatch(self, inst: _WorkerInstance, etype: str, data: dict) -> None:
        """Schedule inst.callback(etype, data) on the instance's event loop."""
        try:
            coro = inst.callback(etype, data)
            # callback is always an async def, so coro is a Coroutine at runtime.
            # run_coroutine_threadsafe typing requires Coroutine, not Awaitable.
            asyncio.run_coroutine_threadsafe(coro, inst.loop)  # type: ignore[arg-type]
        except Exception as exc:
            logger.debug('_dispatch %s failed: %s', etype, exc)


esp_lib_manager = EspLibManager()
