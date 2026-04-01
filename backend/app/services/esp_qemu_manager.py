from __future__ import annotations
"""
EspQemuManager — backend service for ESP32/ESP32-S3/ESP32-C3 emulation via QEMU.

Architecture
------------
Each ESP32 instance gets:
  - qemu-system-xtensa (ESP32/ESP32-S3) or qemu-system-riscv32 (ESP32-C3) process
  - UART0 → TCP socket on a dynamic port → user serial I/O
  - GPIO chardev → TCP socket on a dynamic port → GPIO pin protocol
  - Firmware loaded as a flash image (-drive if=mtd)

GPIO protocol (chardev socket)
-------------------------------
  QEMU → backend :  "GPIO <pin> <0|1>\\n"
  backend → QEMU  :  "SET <pin> <0|1>\\n"

Board types and QEMU machines
------------------------------
  'esp32'    → qemu-system-xtensa   -M esp32
  'esp32-s3' → qemu-system-xtensa   -M esp32s3
  'esp32-c3' → qemu-system-riscv32  -M esp32c3
"""

import asyncio
import base64
import logging
import os
import socket
import tempfile
import time
from typing import Callable, Awaitable

logger = logging.getLogger(__name__)

# ── QEMU binary paths (configurable via env) ──────────────────────────────────
QEMU_XTENSA   = os.environ.get('QEMU_ESP32_BINARY',  'qemu-system-xtensa')
QEMU_RISCV32  = os.environ.get('QEMU_RISCV32_BINARY', 'qemu-system-riscv32')

# ── Machine names per board type ──────────────────────────────────────────────
_MACHINE: dict[str, tuple[str, str]] = {
    'esp32':    (QEMU_XTENSA,  'esp32'),
    'esp32-s3': (QEMU_XTENSA,  'esp32s3'),
    'esp32-c3': (QEMU_RISCV32, 'esp32c3'),
}

EventCallback = Callable[[str, dict], Awaitable[None]]


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class EspInstance:
    """State for one running ESP32 board."""

    def __init__(self, client_id: str, board_type: str, callback: EventCallback):
        self.client_id  = client_id
        self.board_type = board_type  # 'esp32' | 'esp32-s3' | 'esp32-c3'
        self.callback   = callback

        # Runtime state
        self.process:        asyncio.subprocess.Process | None = None
        self.firmware_path:  str | None = None  # temp file, deleted on stop
        self.serial_port:    int = 0  # UART0 TCP port
        self.gpio_port:      int = 0  # GPIO chardev TCP port
        self._serial_writer: asyncio.StreamWriter | None = None
        self._gpio_writer:   asyncio.StreamWriter | None = None
        self._tasks:         list[asyncio.Task] = []
        self.running:        bool = False

        # Sensor state: gpio_pin → {type, properties..., saw_low, responding}
        self.sensors:  dict[int, dict] = {}

    async def emit(self, event_type: str, data: dict) -> None:
        try:
            await self.callback(event_type, data)
        except Exception as e:
            logger.error('emit(%s): %s', event_type, e)


class EspQemuManager:
    def __init__(self):
        self._instances: dict[str, EspInstance] = {}

    # ── Public API ─────────────────────────────────────────────────────────────

    def start_instance(self, client_id: str, board_type: str,
                       callback: EventCallback,
                       firmware_b64: str | None = None,
                       wifi_enabled: bool = False,
                       wifi_hostfwd_port: int = 0) -> None:
        if client_id in self._instances:
            logger.warning('start_instance: %s already running', client_id)
            return
        if board_type not in _MACHINE:
            logger.error('Unknown ESP32 board type: %s', board_type)
            return
        inst = EspInstance(client_id, board_type, callback)
        self._instances[client_id] = inst
        asyncio.create_task(self._boot(inst, firmware_b64, wifi_enabled, wifi_hostfwd_port))

    def stop_instance(self, client_id: str) -> None:
        inst = self._instances.pop(client_id, None)
        if inst:
            asyncio.create_task(self._shutdown(inst))

    def load_firmware(self, client_id: str, firmware_b64: str,
                      wifi_enabled: bool = False,
                      wifi_hostfwd_port: int = 0) -> None:
        """Hot-reload firmware into a running instance (stop + restart)."""
        inst = self._instances.get(client_id)
        if not inst:
            logger.warning('load_firmware: no instance %s', client_id)
            return
        board_type = inst.board_type
        callback   = inst.callback
        self.stop_instance(client_id)
        # Re-start with new firmware after brief delay for cleanup
        async def _restart() -> None:
            await asyncio.sleep(0.5)
            self.start_instance(client_id, board_type, callback, firmware_b64,
                                wifi_enabled, wifi_hostfwd_port)
        asyncio.create_task(_restart())

    def set_pin_state(self, client_id: str, pin: int | str, state: int) -> None:
        """Drive a GPIO pin from outside (e.g. connected Arduino output)."""
        inst = self._instances.get(client_id)
        if inst and inst._gpio_writer:
            asyncio.create_task(self._send_gpio(inst, int(pin), bool(state)))

    # ── Generic sensor API ──────────────────────────────────────────────────

    def sensor_attach(self, client_id: str, sensor_type: str, pin: int,
                      properties: dict) -> None:
        inst = self._instances.get(client_id)
        if inst:
            inst.sensors[pin] = {
                'type': sensor_type,
                **{k: v for k, v in properties.items()
                   if k not in ('sensor_type', 'pin')},
                'saw_low': False,
                'responding': False,
            }
            logger.info('[%s] Sensor %s attached on GPIO %d',
                        client_id, sensor_type, pin)

    def sensor_update(self, client_id: str, pin: int,
                      properties: dict) -> None:
        inst = self._instances.get(client_id)
        if inst and pin in inst.sensors:
            for k, v in properties.items():
                if k != 'pin':
                    inst.sensors[pin][k] = v

    def sensor_detach(self, client_id: str, pin: int) -> None:
        inst = self._instances.get(client_id)
        if inst:
            inst.sensors.pop(pin, None)

    async def send_serial_bytes(self, client_id: str, data: bytes) -> None:
        inst = self._instances.get(client_id)
        if inst and inst._serial_writer:
            inst._serial_writer.write(data)
            try:
                await inst._serial_writer.drain()
            except Exception as e:
                logger.warning('send_serial_bytes drain: %s', e)

    # ── Boot sequence ──────────────────────────────────────────────────────────

    async def _boot(self, inst: EspInstance, firmware_b64: str | None,
                    wifi_enabled: bool = False, wifi_hostfwd_port: int = 0) -> None:
        # Write firmware to temp file if provided
        firmware_path: str | None = None
        if firmware_b64:
            try:
                firmware_bytes = base64.b64decode(firmware_b64)
                tmp = tempfile.NamedTemporaryFile(suffix='.bin', delete=False)
                tmp.write(firmware_bytes)
                tmp.close()
                firmware_path = tmp.name
                inst.firmware_path = firmware_path
            except Exception as e:
                await inst.emit('error', {'message': f'Failed to decode firmware: {e}'})
                self._instances.pop(inst.client_id, None)
                return

        qemu_bin, machine = _MACHINE[inst.board_type]

        # Allocate TCP port for UART0 serial
        inst.serial_port = _find_free_port()

        # Build QEMU command
        # Note: Espressif QEMU v9.x uses server=on,wait=off syntax
        # GPIO chardev (lcgamboa fork) is not available in the Espressif pre-built binary;
        # serial I/O via TCP is fully functional.
        cmd = [
            qemu_bin,
            '-nographic',
            '-machine', machine,
            # UART0 → TCP (serial I/O)
            '-serial', f'tcp:127.0.0.1:{inst.serial_port},server=on,wait=off',
        ]

        if firmware_path:
            cmd += ['-drive', f'file={firmware_path},if=mtd,format=raw']

        # WiFi NIC (slirp user-mode networking)
        if wifi_enabled:
            nic_model = 'esp32c3_wifi' if 'c3' in machine else 'esp32_wifi'
            nic_arg = f'user,model={nic_model},net=192.168.4.0/24'
            if wifi_hostfwd_port:
                nic_arg += f',hostfwd=tcp::{wifi_hostfwd_port}-192.168.4.2:80'
            cmd += ['-nic', nic_arg]

        logger.info('Launching ESP32 QEMU for %s: %s', inst.client_id, ' '.join(cmd))

        try:
            inst.process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
                stdin=asyncio.subprocess.DEVNULL,
            )
        except FileNotFoundError:
            await inst.emit('error', {'message': f'{qemu_bin} not found in PATH'})
            self._instances.pop(inst.client_id, None)
            return

        inst.running = True
        await inst.emit('system', {'event': 'booting'})

        # Give QEMU a moment to open its TCP socket
        await asyncio.sleep(1.0)

        inst._tasks.append(asyncio.create_task(self._connect_serial(inst)))
        inst._tasks.append(asyncio.create_task(self._watch_stderr(inst)))

    # ── Serial (UART0) ─────────────────────────────────────────────────────────

    async def _connect_serial(self, inst: EspInstance) -> None:
        for attempt in range(10):
            try:
                reader, writer = await asyncio.open_connection('127.0.0.1', inst.serial_port)
                inst._serial_writer = writer
                logger.info('%s: serial connected on port %d', inst.client_id, inst.serial_port)
                await inst.emit('system', {'event': 'booted'})
                await self._read_serial(inst, reader)
                return
            except (ConnectionRefusedError, OSError):
                await asyncio.sleep(1.0 * (attempt + 1))
        await inst.emit('error', {'message': 'Could not connect to QEMU serial port'})

    async def _read_serial(self, inst: EspInstance, reader: asyncio.StreamReader) -> None:
        buf = bytearray()
        while inst.running:
            try:
                chunk = await asyncio.wait_for(reader.read(256), timeout=0.1)
                if not chunk:
                    break
                buf.extend(chunk)
                text = buf.decode('utf-8', errors='replace')
                buf.clear()
                await inst.emit('serial_output', {'data': text})
            except asyncio.TimeoutError:
                continue
            except Exception as e:
                logger.warning('%s serial read: %s', inst.client_id, e)
                break

    # ── GPIO chardev ───────────────────────────────────────────────────────────

    async def _connect_gpio(self, inst: EspInstance) -> None:
        for attempt in range(10):
            try:
                reader, writer = await asyncio.open_connection('127.0.0.1', inst.gpio_port)
                inst._gpio_writer = writer
                logger.info('%s: GPIO chardev connected on port %d', inst.client_id, inst.gpio_port)
                await self._read_gpio(inst, reader)
                return
            except (ConnectionRefusedError, OSError):
                await asyncio.sleep(1.0 * (attempt + 1))
        logger.warning('%s: GPIO chardev connection failed', inst.client_id)

    async def _read_gpio(self, inst: EspInstance, reader: asyncio.StreamReader) -> None:
        """Parse "GPIO <pin> <state>\n" lines from the firmware GPIO bridge."""
        linebuf = b''
        while inst.running:
            try:
                chunk = await asyncio.wait_for(reader.read(256), timeout=0.1)
                if not chunk:
                    break
                linebuf += chunk
                while b'\n' in linebuf:
                    line, linebuf = linebuf.split(b'\n', 1)
                    await self._handle_gpio_line(inst, line.decode('ascii', 'ignore').strip())
            except asyncio.TimeoutError:
                continue
            except Exception as e:
                logger.warning('%s GPIO read: %s', inst.client_id, e)
                break

    async def _handle_gpio_line(self, inst: EspInstance, line: str) -> None:
        # Expected: "GPIO <pin> <0|1>"
        parts = line.split()
        if len(parts) == 3 and parts[0] == 'GPIO':
            try:
                pin   = int(parts[1])
                state = int(parts[2])
                await inst.emit('gpio_change', {'pin': pin, 'state': state})

                # Sensor protocol: dispatch by sensor type
                sensor = inst.sensors.get(pin)
                if sensor is not None and sensor.get('type') == 'dht22':
                    if state == 0 and not sensor.get('responding', False):
                        sensor['saw_low'] = True
                    elif state == 1 and sensor.get('saw_low', False):
                        sensor['saw_low'] = False
                        sensor['responding'] = True
                        asyncio.create_task(
                            self._dht22_respond(inst, pin,
                                                sensor.get('temperature', 25.0),
                                                sensor.get('humidity', 50.0))
                        )
            except ValueError:
                pass

    # ── DHT22 protocol emulation ────────────────────────────────────────────

    @staticmethod
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

    @staticmethod
    def _busy_wait_us(us: int) -> None:
        """Busy-wait for the given number of microseconds using perf_counter_ns."""
        end = time.perf_counter_ns() + us * 1000
        while time.perf_counter_ns() < end:
            pass

    def _dht22_respond_sync(self, inst: EspInstance, gpio_pin: int,
                            temperature: float, humidity: float) -> None:
        """Thread function: inject DHT22 protocol waveform via GPIO SET commands.

        Uses synchronous socket writes + busy-wait to achieve µs-level timing.
        asyncio.sleep() is too coarse (15ms on Windows) for this protocol.
        """
        payload = self._dht22_build_payload(temperature, humidity)

        def _send_pin(state: bool) -> None:
            """Synchronous GPIO write directly on the TCP socket."""
            if inst._gpio_writer and inst._gpio_writer.transport:
                msg = f'SET {gpio_pin} {1 if state else 0}\n'.encode()
                inst._gpio_writer.transport.write(msg)

        try:
            # Preamble: 80 µs LOW → 80 µs HIGH (use 2x margins for QEMU speed)
            _send_pin(False)
            self._busy_wait_us(160)
            _send_pin(True)
            self._busy_wait_us(160)

            # 40 data bits: 50 µs LOW + (26 µs HIGH = 0, 70 µs HIGH = 1)
            # Use 2x margins: 100 µs LOW, 52 µs HIGH (0) / 140 µs HIGH (1)
            for byte_val in payload:
                for b in range(7, -1, -1):
                    bit = (byte_val >> b) & 1
                    _send_pin(False)
                    self._busy_wait_us(100)
                    _send_pin(True)
                    self._busy_wait_us(140 if bit else 52)

            # Final: release line HIGH
            _send_pin(False)
            self._busy_wait_us(100)
            _send_pin(True)
            logger.debug('[%s] DHT22 response sent on GPIO %d', inst.client_id, gpio_pin)
        except Exception as exc:
            logger.warning('[%s] DHT22 respond error on GPIO %d: %s',
                           inst.client_id, gpio_pin, exc)
        finally:
            sensor = inst.sensors.get(gpio_pin)
            if sensor:
                sensor['responding'] = False

    async def _dht22_respond(self, inst: EspInstance, gpio_pin: int,
                             temperature: float, humidity: float) -> None:
        """Run the DHT22 response in a thread for accurate µs timing."""
        import threading
        t = threading.Thread(
            target=self._dht22_respond_sync,
            args=(inst, gpio_pin, temperature, humidity),
            daemon=True,
            name=f'dht22-gpio{gpio_pin}',
        )
        t.start()

    async def _send_gpio(self, inst: EspInstance, pin: int, state: bool) -> None:
        if inst._gpio_writer:
            msg = f'SET {pin} {1 if state else 0}\n'.encode()
            inst._gpio_writer.write(msg)
            try:
                await inst._gpio_writer.drain()
            except Exception as e:
                logger.warning('%s GPIO send: %s', inst.client_id, e)

    # ── QEMU stderr watcher ────────────────────────────────────────────────────

    async def _watch_stderr(self, inst: EspInstance) -> None:
        if not inst.process or not inst.process.stderr:
            return
        try:
            async for line in inst.process.stderr:
                text = line.decode('utf-8', errors='replace').rstrip()
                if text:
                    logger.debug('QEMU[%s] %s', inst.client_id, text)
        except Exception:
            pass
        logger.info('QEMU[%s] process exited', inst.client_id)
        inst.running = False
        await inst.emit('system', {'event': 'exited'})

    # ── Shutdown ───────────────────────────────────────────────────────────────

    async def _shutdown(self, inst: EspInstance) -> None:
        inst.running = False

        for task in inst._tasks:
            task.cancel()
        inst._tasks.clear()

        for writer_attr in ('_gpio_writer', '_serial_writer'):
            writer: asyncio.StreamWriter | None = getattr(inst, writer_attr)
            if writer:
                try:
                    writer.close()
                except Exception:
                    pass
                setattr(inst, writer_attr, None)

        if inst.process:
            try:
                inst.process.terminate()
                await asyncio.wait_for(inst.process.wait(), timeout=5.0)
            except Exception:
                try:
                    inst.process.kill()
                except Exception:
                    pass
            inst.process = None

        # Delete temp firmware file
        if inst.firmware_path and os.path.exists(inst.firmware_path):
            try:
                os.unlink(inst.firmware_path)
            except Exception:
                pass
            inst.firmware_path = None

        logger.info('EspInstance %s shut down', inst.client_id)


esp_qemu_manager = EspQemuManager()
