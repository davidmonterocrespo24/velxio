"""
Starts, stops and reloads of one QEMU ESP32 client, when they overlap (#182).

Every worker counts against the caps of app.services.esp32_qemu_access, so
the managers must never run a worker they no longer track: one that nobody
stops keeps its process alive and its slot taken until the server restarts.

The lib manager tests launch a stand-in for the worker process (FakeProc), so
they exercise the manager's own bookkeeping without libqemu.
"""
import asyncio
import io
import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch


CAP_ENV = 'VELXIO_ESP32_QEMU_MAX_INSTANCES'


class FakeProc:
    """What subprocess.Popen returns for a worker that runs until stopped."""

    def __init__(self, registry: list, *args, **kwargs):
        self.stdin = io.BytesIO()
        self.stdout = io.BytesIO(b'')
        self.stderr = io.BytesIO(b'')
        self.returncode = None
        self.stopped = False
        registry.append(self)

    def wait(self, timeout=None):
        self.returncode = 0
        self.stopped = True
        return 0

    def kill(self):
        self.returncode = -9
        self.stopped = True

    def poll(self):
        return self.returncode


class _LibCase(unittest.IsolatedAsyncioTestCase):

    def setUp(self):
        import app.services.esp32_lib_manager as lib_mod
        from app.services import esp32_qemu_access as acc

        self.lib_mod = lib_mod
        self.acc = acc
        self.mgr = lib_mod.EspLibManager()
        self.procs: list[FakeProc] = []
        popen = patch.object(lib_mod.subprocess, 'Popen',
                             side_effect=lambda *a, **k: FakeProc(self.procs, *a, **k))
        popen.start()
        self.addCleanup(popen.stop)
        env = patch.dict(os.environ, {}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        acc.register_esp32_qemu_gate(None)
        acc._reserved.clear()
        self.addCleanup(acc._reserved.clear)

    def alive(self) -> list[FakeProc]:
        return [p for p in self.procs if not p.stopped]

    async def settle(self, seconds: float = 0.4) -> None:
        await asyncio.sleep(seconds)

    async def start(self, client_id: str = 'c', callback=None) -> None:
        await self.mgr.start_instance(client_id, 'esp32', callback or AsyncMock(), 'AAAA')


class TestLibManagerOverlaps(_LibCase):

    async def test_a_burst_of_reloads_leaves_one_worker(self):
        """Frames that arrive together each scheduled a restart, and each
        restart launched a worker; the table kept the last one."""
        await self.start()
        for _ in range(6):
            self.mgr.load_firmware('c', 'AAAA')
        await self.settle()
        self.assertEqual(len(self.alive()), 1, f'{len(self.alive())} workers alive')
        self.assertIs(self.mgr.get_instance('c').process, self.alive()[0])

    async def test_a_reload_scheduled_before_the_socket_closed_starts_nothing(self):
        """The socket's cleanup stops the client; a restart already scheduled
        must not launch a worker afterwards, with no socket left to stop it."""
        await self.start()
        self.mgr.load_firmware('c', 'AAAA')
        await self.mgr.stop_instance('c')
        await self.settle()
        self.assertEqual(self.alive(), [])
        self.assertIsNone(self.mgr.get_instance('c'))
        self.assertEqual(self.mgr.client_ids(), [])

    async def test_two_overlapping_starts_of_one_client_leave_one_worker(self):
        """A start awaits the booting event before it launches."""
        async def slow_callback(event, data):
            await asyncio.sleep(0.05)

        await asyncio.gather(self.start(callback=slow_callback),
                             self.start(callback=slow_callback))
        await self.settle(0.1)
        self.assertEqual(len(self.alive()), 1, f'{len(self.alive())} workers alive')

    async def test_a_stop_during_a_start_wins(self):
        booting = asyncio.Event()
        go_on = asyncio.Event()

        async def callback(event, data):
            if data.get('event') == 'booting':
                booting.set()
                await go_on.wait()

        starting = asyncio.ensure_future(self.start(callback=callback))
        await booting.wait()
        stopping = asyncio.ensure_future(self.mgr.stop_instance('c'))
        await asyncio.sleep(0)
        go_on.set()
        await asyncio.gather(starting, stopping)
        self.assertEqual(self.alive(), [])
        self.assertIsNone(self.mgr.get_instance('c'))

    async def test_a_reload_keeps_the_slot_of_the_worker_it_replaces(self):
        """Between stopping the old worker and registering the new one the
        client holds no worker, and the cap must still count it."""
        os.environ[CAP_ENV] = '1'
        await self.start()
        reloaded = asyncio.Event()
        go_on = asyncio.Event()
        inst = self.mgr.get_instance('c')

        async def callback(event, data):
            if data.get('event') == 'booting':
                reloaded.set()
                await go_on.wait()

        inst.callback = callback
        with patch('app.services.esp32_qemu_access.running_clients',
                   side_effect=lambda: set(self.mgr.client_ids())):
            self.mgr.load_firmware('c', 'AAAA')
            await reloaded.wait()
            self.assertIsNone(self.mgr.get_instance('c'))   # the old one is gone
            refused = await self.acc.admit(MagicMock(), 'd', 'esp32')
            go_on.set()
            await self.settle(0.2)
        self.assertIsNotNone(refused, 'another client took the slot mid-reload')
        self.assertEqual(refused.code, 'esp32_qemu_busy')
        self.assertEqual(len(self.alive()), 1)
        self.assertEqual(self.acc.active_clients() - set(self.mgr.client_ids()), set())

    async def test_reloading_a_client_with_no_worker_does_nothing(self):
        self.mgr.load_firmware('nobody', 'AAAA')
        await self.settle(0.2)
        self.assertEqual(self.procs, [])
        self.assertEqual(self.acc.active_clients(), set())

    async def test_the_bookkeeping_does_not_grow_with_finished_clients(self):
        for i in range(5):
            await self.start(f'c{i}')
            await self.mgr.stop_instance(f'c{i}')
        self.assertEqual(self.mgr._client_locks, {})
        self.assertEqual(self.mgr._latest, {})


class TestSubprocessFallbackOverlaps(unittest.IsolatedAsyncioTestCase):
    """The fallback (no libqemu) launches qemu-system-* itself."""

    def setUp(self):
        from app.services import esp32_qemu_access as acc
        from app.services.esp_qemu_manager import EspQemuManager

        self.acc = acc
        self.mgr = EspQemuManager()
        acc._reserved.clear()
        self.addCleanup(acc._reserved.clear)

    async def test_a_stop_while_qemu_launches_stops_that_qemu(self):
        launched = asyncio.Event()
        go_on = asyncio.Event()
        proc = MagicMock()
        proc.wait = AsyncMock(return_value=0)

        async def slow_exec(*cmd, **kwargs):
            launched.set()
            await go_on.wait()
            return proc

        with patch('asyncio.create_subprocess_exec', side_effect=slow_exec):
            self.mgr.start_instance('c', 'esp32', AsyncMock(), firmware_b64=None)
            await launched.wait()
            self.mgr.stop_instance('c')
            go_on.set()
            await asyncio.sleep(0.2)
        proc.terminate.assert_called()
        self.assertEqual(self.mgr.client_ids(), [])

    async def test_a_reload_scheduled_before_the_socket_closed_starts_nothing(self):
        from app.services.esp_qemu_manager import EspInstance

        self.mgr._instances['c'] = EspInstance('c', 'esp32', AsyncMock())
        with patch.object(self.mgr, '_boot', new=AsyncMock()) as boot, \
             patch.object(self.mgr, '_shutdown', new=AsyncMock()):
            self.mgr.load_firmware('c', 'AAAA')
            self.mgr.stop_instance('c')
            await asyncio.sleep(0.7)
        boot.assert_not_called()
        self.assertEqual(self.mgr.client_ids(), [])
        self.assertEqual(self.acc.active_clients(), set())

    async def test_a_reload_still_restarts_the_client(self):
        from app.services.esp_qemu_manager import EspInstance

        self.mgr._instances['c'] = EspInstance('c', 'esp32', AsyncMock())
        with patch.object(self.mgr, '_boot', new=AsyncMock()) as boot, \
             patch.object(self.mgr, '_shutdown', new=AsyncMock()):
            self.mgr.load_firmware('c', 'AAAA')
            self.assertIn('c', self.acc.active_clients())   # held through the restart
            await asyncio.sleep(0.7)
        boot.assert_called_once()
        self.assertEqual(self.mgr.client_ids(), ['c'])


if __name__ == '__main__':
    unittest.main()
