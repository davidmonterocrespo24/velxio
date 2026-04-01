from __future__ import annotations
"""
QemuManager — backend service for Raspberry Pi 3B emulation via QEMU.

Architecture
------------
Each Pi board instance gets:
  - qemu-system-aarch64 process (raspi3b, ARM64)
  - ttyAMA0 (serial0) → TCP socket on a dynamic port → user serial I/O
  - ttyAMA1 (serial1) → TCP socket on a dynamic port → GPIO shim protocol
  - A fresh qcow2 overlay over the base SD image (copy-on-write, discarded on stop)

GPIO shim protocol (ttyAMA1)
----------------------------
  Pi → backend :  "GPIO <bcm_pin> <0|1>\\n"
  backend → Pi  :  "SET <bcm_pin> <0|1>\\n"
"""

import asyncio
import logging
import os
import socket
import subprocess
import tempfile
from typing import Callable, Awaitable

logger = logging.getLogger(__name__)

# ── Paths ────────────────────────────────────────────────────────────────────
IMG_DIR     = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'img')
KERNEL_PATH = os.path.join(IMG_DIR, 'kernel8.img')
DTB_PATH    = os.path.join(IMG_DIR, 'bcm271~1.dtb')
SD_BASE     = os.path.join(IMG_DIR, '2025-12-04-raspios-trixie-armhf.img')


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


EventCallback = Callable[[str, dict], Awaitable[None]]


class PiInstance:
    """State for one running Pi board."""

    def __init__(self, client_id: str, callback: EventCallback):
        self.client_id = client_id
        self.callback  = callback

        # Runtime state
        self.process:      subprocess.Popen | None = None
        self.overlay_path: str | None = None
        self.serial_port:  int = 0   # ttyAMA0 TCP port
        self.gpio_port:    int = 0   # ttyAMA1 TCP port
        self._serial_writer: asyncio.StreamWriter | None = None
        self._gpio_writer:   asyncio.StreamWriter | None = None
        self._tasks: list[asyncio.Task] = []
        self.running = False

    async def emit(self, event_type: str, data: dict) -> None:
        try:
            await self.callback(event_type, data)
        except Exception as e:
            logger.error('emit(%s): %s', event_type, e)


class QemuManager:
    def __init__(self):
        self._instances: dict[str, PiInstance] = {}

    # ── Public API ────────────────────────────────────────────────────────────

    def start_instance(self, client_id: str, board_type: str,  # noqa: ARG002
                       callback: EventCallback) -> None:
        if client_id in self._instances:
            logger.warning('start_instance: %s already running', client_id)
            return
        inst = PiInstance(client_id, callback)
        self._instances[client_id] = inst
        asyncio.create_task(self._boot(inst))

    def stop_instance(self, client_id: str) -> None:
        inst = self._instances.pop(client_id, None)
        if inst:
            asyncio.create_task(self._shutdown(inst))

    def set_pin_state(self, client_id: str, pin: str | int, state: int) -> None:
        """Drive a GPIO pin from outside (e.g. connected Arduino)."""
        inst = self._instances.get(client_id)
        if inst and inst._gpio_writer:
            asyncio.create_task(self._send_gpio(inst, int(pin), bool(state)))

    async def send_serial_bytes(self, client_id: str, data: bytes) -> None:
        inst = self._instances.get(client_id)
        if inst and inst._serial_writer:
            inst._serial_writer.write(data)
            try:
                await inst._serial_writer.drain()
            except Exception as e:
                logger.warning('send_serial_bytes drain: %s', e)

    # ── Boot sequence ─────────────────────────────────────────────────────────

    async def _boot(self, inst: PiInstance) -> None:
        if not self._check_images():
            await inst.emit('error', {'message': 'Missing QEMU boot files (kernel8.img / SD image)'})
            self._instances.pop(inst.client_id, None)
            return

        # Allocate TCP ports for the two serial channels
        inst.serial_port = _find_free_port()
        inst.gpio_port   = _find_free_port()

        # Create overlay qcow2 so the base SD image is never modified
        overlay = tempfile.NamedTemporaryFile(suffix='.qcow2', delete=False)
        overlay.close()
        inst.overlay_path = overlay.name
        try:
            subprocess.run(
                ['qemu-img', 'create', '-f', 'qcow2',
                 '-b', os.path.abspath(SD_BASE), '-F', 'raw',
                 inst.overlay_path],
                check=True, capture_output=True,
            )
            # raspi3b requires SD card size to be a power of 2; resize overlay to 8 GiB
            subprocess.run(
                ['qemu-img', 'resize', inst.overlay_path, '8G'],
                check=True, capture_output=True,
            )
        except subprocess.CalledProcessError as e:
            await inst.emit('error', {'message': f'qemu-img create failed: {e.stderr.decode()}'})
            self._instances.pop(inst.client_id, None)
            return

        # Build QEMU command
        cmd = [
            'qemu-system-aarch64',
            '-M',      'raspi3b',
            '-kernel', os.path.abspath(KERNEL_PATH),
            '-dtb',    os.path.abspath(DTB_PATH),
            '-drive',  f'file={inst.overlay_path},if=sd,format=qcow2',
            '-m',      '1G',
            '-smp',    '4',
            '-nographic',
            # ttyAMA0 → user serial (TCP server, frontend connects)
            '-serial', f'tcp:127.0.0.1:{inst.serial_port},server,nowait',
            # ttyAMA1 → GPIO shim protocol
            '-serial', f'tcp:127.0.0.1:{inst.gpio_port},server,nowait',
            '-append',
            'console=ttyAMA0 root=/dev/mmcblk0p2 rootwait rw '
            'dwc_otg.lpm_enable=0 quiet init=/bin/sh',
        ]

        logger.info('Launching QEMU for %s: %s', inst.client_id, ' '.join(cmd))

        # Use subprocess.Popen via executor — asyncio.create_subprocess_exec requires
        # ProactorEventLoop on Windows but uvicorn may use SelectorEventLoop.
        loop = asyncio.get_running_loop()
        try:
            inst.process = await loop.run_in_executor(
                None,
                lambda: subprocess.Popen(
                    cmd,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    stdin=subprocess.DEVNULL,
                ),
            )
        except FileNotFoundError:
            await inst.emit('error', {'message': 'qemu-system-aarch64 not found in PATH'})
            self._instances.pop(inst.client_id, None)
            return

        inst.running = True
        await inst.emit('system', {'event': 'booting'})

        # Give QEMU a moment to open its TCP sockets
        await asyncio.sleep(2.0)

        # Connect to serial TCP ports
        inst._tasks.append(asyncio.create_task(self._connect_serial(inst)))
        inst._tasks.append(asyncio.create_task(self._connect_gpio(inst)))
        inst._tasks.append(asyncio.create_task(self._watch_stderr(inst)))

    # ── Serial (ttyAMA0) ──────────────────────────────────────────────────────

    async def _connect_serial(self, inst: PiInstance) -> None:
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

    async def _read_serial(self, inst: PiInstance, reader: asyncio.StreamReader) -> None:
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

    # ── GPIO shim (ttyAMA1) ───────────────────────────────────────────────────

    async def _connect_gpio(self, inst: PiInstance) -> None:
        for attempt in range(10):
            try:
                reader, writer = await asyncio.open_connection('127.0.0.1', inst.gpio_port)
                inst._gpio_writer = writer
                logger.info('%s: GPIO shim connected on port %d', inst.client_id, inst.gpio_port)
                await self._read_gpio(inst, reader)
                return
            except (ConnectionRefusedError, OSError):
                await asyncio.sleep(1.0 * (attempt + 1))
        logger.warning('%s: GPIO shim connection failed', inst.client_id)

    async def _read_gpio(self, inst: PiInstance, reader: asyncio.StreamReader) -> None:
        """Parse "GPIO <pin> <state>\n" lines from the Pi GPIO shim."""
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

    async def _handle_gpio_line(self, inst: PiInstance, line: str) -> None:
        # Expected: "GPIO <bcm_pin> <0|1>"
        parts = line.split()
        if len(parts) == 3 and parts[0] == 'GPIO':
            try:
                pin   = int(parts[1])
                state = int(parts[2])
                await inst.emit('gpio_change', {'pin': pin, 'state': state})
            except ValueError:
                pass

    async def _send_gpio(self, inst: PiInstance, pin: int, state: bool) -> None:
        if inst._gpio_writer:
            msg = f'SET {pin} {1 if state else 0}\n'.encode()
            inst._gpio_writer.write(msg)
            try:
                await inst._gpio_writer.drain()
            except Exception as e:
                logger.warning('%s GPIO send: %s', inst.client_id, e)

    # ── QEMU stderr watcher ───────────────────────────────────────────────────

    async def _watch_stderr(self, inst: PiInstance) -> None:
        if not inst.process or not inst.process.stderr:
            return
        loop = asyncio.get_running_loop()
        try:
            while inst.running:
                # readline() blocks until a line or EOF — run in executor so we don't block the loop
                line = await loop.run_in_executor(None, inst.process.stderr.readline)
                if not line:
                    break
                text = line.decode('utf-8', errors='replace').rstrip()
                if text:
                    logger.warning('QEMU[%s] %s', inst.client_id, text)
        except Exception:
            pass
        logger.info('QEMU[%s] process exited', inst.client_id)
        inst.running = False
        await inst.emit('system', {'event': 'exited'})

    # ── Shutdown ──────────────────────────────────────────────────────────────

    async def _shutdown(self, inst: PiInstance) -> None:
        inst.running = False

        for task in inst._tasks:
            task.cancel()
        inst._tasks.clear()

        if inst._gpio_writer:
            try:
                inst._gpio_writer.close()
            except Exception:
                pass
            inst._gpio_writer = None

        if inst._serial_writer:
            try:
                inst._serial_writer.close()
            except Exception:
                pass
            inst._serial_writer = None

        if inst.process:
            loop = asyncio.get_running_loop()
            try:
                inst.process.terminate()
                await asyncio.wait_for(
                    loop.run_in_executor(None, inst.process.wait),
                    timeout=5.0,
                )
            except Exception:
                try:
                    inst.process.kill()
                except Exception:
                    pass
            inst.process = None

        # Delete overlay
        if inst.overlay_path and os.path.exists(inst.overlay_path):
            try:
                os.unlink(inst.overlay_path)
            except Exception:
                pass
            inst.overlay_path = None

        logger.info('PiInstance %s shut down', inst.client_id)

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _check_images(self) -> bool:
        ok = os.path.exists(KERNEL_PATH) and os.path.exists(SD_BASE)
        if not ok:
            logger.error('Missing QEMU images in %s', IMG_DIR)
        return ok


qemu_manager = QemuManager()
