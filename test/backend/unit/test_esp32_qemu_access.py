"""
Who may start an ESP32 on the server's QEMU lane, and how many at once (#182).

`start_esp32` carries firmware that then runs on the server, in a libqemu
worker process. The route admits each start through
app.services.esp32_qemu_access: a global cap on concurrent workers
(VELXIO_ESP32_QEMU_MAX_INSTANCES) and, when an overlay installs one, a gate
that decides who may start one at all.

The route-level tests drive the real simulation_websocket with a fake socket
and fill the managers' instance tables directly, so they exercise the shipped
route rather than a copy of its decision.
"""
import json
import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch


CAP_ENV = 'VELXIO_ESP32_QEMU_MAX_INSTANCES'


def _make_ws(messages: list[dict]):
    """A WebSocket that yields `messages`, then disconnects, recording what
    the route sends back."""
    ws = MagicMock()
    ws.accept = AsyncMock()
    ws.cookies = {}
    pending = iter([json.dumps(m) for m in messages])

    async def receive_text():
        try:
            return next(pending)
        except StopIteration:
            from fastapi.websockets import WebSocketDisconnect
            raise WebSocketDisconnect()

    ws.receive_text = receive_text
    ws.send_text = AsyncMock()
    return ws


def _sent(ws) -> list[dict]:
    return [json.loads(c.args[0]) for c in ws.send_text.call_args_list]


def _start_message() -> dict:
    return {'type': 'start_esp32', 'data': {'board': 'esp32', 'firmware_b64': 'AAAA'}}


class _RouteCase(unittest.IsolatedAsyncioTestCase):
    """The shipped route, with both managers' start/stop replaced."""

    def setUp(self):
        import app.api.routes.simulation as sim
        import app.services.esp32_lib_manager as lib_mod
        import app.services.esp_qemu_manager as sub_mod

        self.sim = sim
        self.lib = lib_mod.esp_lib_manager
        self.sub = sub_mod.esp_qemu_manager
        self._env = patch.dict(os.environ, {}, clear=False)
        self._env.start()
        os.environ.pop(CAP_ENV, None)
        self.addCleanup(self._env.stop)
        # Whatever another test left in the singletons' tables.
        self._saved_lib = dict(self.lib._instances)
        self._saved_sub = dict(self.sub._instances)
        self.lib._instances.clear()
        self.sub._instances.clear()
        self.addCleanup(self._restore_tables)
        self._reset_access()

    def _restore_tables(self):
        self.lib._instances.clear()
        self.lib._instances.update(self._saved_lib)
        self.sub._instances.clear()
        self.sub._instances.update(self._saved_sub)
        self._reset_access()

    @staticmethod
    def _reset_access():
        try:
            from app.services import esp32_qemu_access as acc
        except ImportError:
            return
        acc.register_esp32_qemu_gate(None)
        acc._reserved.clear()

    async def _run(self, client_id: str, messages: list[dict], *, lib_start=None):
        ws = _make_ws(messages)
        lib_start = lib_start or AsyncMock()
        with patch.object(self.lib, 'is_available', return_value=True), \
             patch.object(self.lib, 'start_instance', new=lib_start), \
             patch.object(self.lib, 'stop_instance', new=AsyncMock()), \
             patch.object(self.sub, 'start_instance') as sub_start, \
             patch.object(self.sub, 'stop_instance'):
            await self.sim.simulation_websocket(ws, client_id)
        return ws, lib_start, sub_start


class TestStartIsAdmitted(_RouteCase):

    async def test_a_start_beyond_the_cap_is_refused_with_words(self):
        """The cap counts workers of OTHER clients. At the cap the start is
        refused with a sentence the Serial Monitor can show, and no worker is
        launched."""
        os.environ[CAP_ENV] = '1'
        self.lib._instances['someone-else'] = MagicMock()
        ws, lib_start, sub_start = await self._run('me', [_start_message()])
        lib_start.assert_not_called()
        sub_start.assert_not_called()
        errors = [m for m in _sent(ws) if m['type'] == 'error']
        self.assertEqual(len(errors), 1, _sent(ws))
        self.assertEqual(errors[0]['data'].get('code'), 'esp32_qemu_busy')
        self.assertIn('busy', errors[0]['data']['message'])

    async def test_the_subprocess_fallback_counts_too(self):
        os.environ[CAP_ENV] = '1'
        self.sub._instances['someone-else'] = MagicMock()
        ws, lib_start, _ = await self._run('me', [_start_message()])
        lib_start.assert_not_called()
        self.assertTrue(any(m['type'] == 'error' for m in _sent(ws)))

    async def test_a_restart_by_the_same_client_is_not_counted(self):
        """Run while running restarts the same client's worker: it must not
        be refused by its own slot."""
        os.environ[CAP_ENV] = '1'
        self.lib._instances['me'] = MagicMock()
        ws, lib_start, _ = await self._run('me', [_start_message()])
        lib_start.assert_awaited_once()
        self.assertFalse(any(m['type'] == 'error' for m in _sent(ws)))

    async def test_under_the_cap_the_start_goes_through(self):
        os.environ[CAP_ENV] = '3'
        self.lib._instances['a'] = MagicMock()
        ws, lib_start, _ = await self._run('me', [_start_message()])
        lib_start.assert_awaited_once()
        self.assertEqual(lib_start.call_args.args[:2], ('me', 'esp32'))

    async def test_the_overlay_gate_refusal_reaches_the_client(self):
        from app.services import esp32_qemu_access as acc
        from app.services.board_access import BoardAccessDenial

        seen = []

        async def gate(websocket, client_id, board):
            seen.append((client_id, board))
            return BoardAccessDenial('Sign in first.', code='esp32_qemu_signin')

        acc.register_esp32_qemu_gate(gate)
        ws, lib_start, sub_start = await self._run('me', [_start_message()])
        self.assertEqual(seen, [('me', 'esp32')])
        lib_start.assert_not_called()
        sub_start.assert_not_called()
        errors = [m for m in _sent(ws) if m['type'] == 'error']
        self.assertEqual(errors[0]['data'], {'message': 'Sign in first.', 'code': 'esp32_qemu_signin'})

    async def test_a_gate_that_raises_refuses_the_start(self):
        """Fail closed: the gate decides who runs code on the server."""
        from app.services import esp32_qemu_access as acc

        async def gate(websocket, client_id, board):
            raise RuntimeError('database down')

        acc.register_esp32_qemu_gate(gate)
        ws, lib_start, _ = await self._run('me', [_start_message()])
        lib_start.assert_not_called()
        errors = [m for m in _sent(ws) if m['type'] == 'error']
        self.assertEqual(errors[0]['data'].get('code'), 'esp32_qemu_check_failed')

    async def test_the_reservation_is_released_after_the_start(self):
        """Even when the start itself blows up."""
        from app.services import esp32_qemu_access as acc

        boom = AsyncMock(side_effect=RuntimeError('worker launch failed'))
        await self._run('me', [_start_message()], lib_start=boom)
        self.assertEqual(acc.active_clients(), set())


class TestAdmission(unittest.IsolatedAsyncioTestCase):
    """The module on its own: reservation, cap value, gate contract."""

    def setUp(self):
        from app.services import esp32_qemu_access as acc
        import app.services.esp32_lib_manager as lib_mod
        import app.services.esp_qemu_manager as sub_mod

        self.acc = acc
        self.lib = lib_mod.esp_lib_manager
        self.sub = sub_mod.esp_qemu_manager
        self._env = patch.dict(os.environ, {}, clear=False)
        self._env.start()
        os.environ.pop(CAP_ENV, None)
        self.addCleanup(self._env.stop)
        saved = (dict(self.lib._instances), dict(self.sub._instances))
        self.lib._instances.clear()
        self.sub._instances.clear()

        def restore():
            self.lib._instances.clear()
            self.lib._instances.update(saved[0])
            self.sub._instances.clear()
            self.sub._instances.update(saved[1])
            acc.register_esp32_qemu_gate(None)
            acc._reserved.clear()

        self.addCleanup(restore)
        acc.register_esp32_qemu_gate(None)
        acc._reserved.clear()

    async def test_starts_that_arrive_together_cannot_overshoot_the_cap(self):
        """The lib manager registers its worker only after an await, so
        without a reservation N concurrent starts all saw an empty table."""
        os.environ[CAP_ENV] = '1'
        self.assertIsNone(await self.acc.admit(MagicMock(), 'a', 'esp32'))
        refused = await self.acc.admit(MagicMock(), 'b', 'esp32')
        self.assertIsNotNone(refused)
        self.assertEqual(refused.code, 'esp32_qemu_busy')
        self.acc.release('a')
        self.assertIsNone(await self.acc.admit(MagicMock(), 'b', 'esp32'))

    async def test_zero_means_no_cap(self):
        os.environ[CAP_ENV] = '0'
        for i in range(50):
            self.lib._instances[f'c{i}'] = MagicMock()
        self.assertIsNone(await self.acc.admit(MagicMock(), 'me', 'esp32'))

    def test_default_cap_scales_with_the_cpus(self):
        with patch('os.cpu_count', return_value=6):
            self.assertEqual(self.acc.max_instances(), 12)
        with patch('os.cpu_count', return_value=1):
            self.assertEqual(self.acc.max_instances(), 4)
        with patch('os.cpu_count', return_value=None):
            self.assertEqual(self.acc.max_instances(), 4)

    def test_a_bad_cap_value_falls_back_to_the_default(self):
        os.environ[CAP_ENV] = 'lots'
        with patch('os.cpu_count', return_value=6):
            self.assertEqual(self.acc.max_instances(), 12)
        os.environ[CAP_ENV] = '-3'
        self.assertEqual(self.acc.max_instances(), 0)

    async def test_the_gate_sees_who_asks_before_the_cap_is_counted(self):
        """A refused gate never takes a slot."""
        from app.services.board_access import BoardAccessDenial

        async def gate(websocket, client_id, board):
            return BoardAccessDenial('no', code='x')

        self.acc.register_esp32_qemu_gate(gate)
        self.assertIsNotNone(await self.acc.admit(MagicMock(), 'a', 'esp32'))
        self.assertEqual(self.acc.active_clients(), set())

    async def test_a_gate_answer_that_is_not_a_denial_still_refuses(self):
        async def gate(websocket, client_id, board):
            return False

        self.acc.register_esp32_qemu_gate(gate)
        refused = await self.acc.admit(MagicMock(), 'a', 'esp32')
        self.assertIsNotNone(refused)
        self.assertEqual(refused.code, 'esp32_qemu_check_failed')

    def test_active_clients_are_both_managers_plus_reservations(self):
        self.lib._instances['l'] = MagicMock()
        self.sub._instances['s'] = MagicMock()
        self.acc.hold('r')
        self.assertEqual(self.acc.active_clients(), {'l', 's', 'r'})
        self.assertEqual(self.acc.running_clients(), {'l', 's'})


if __name__ == '__main__':
    unittest.main()
