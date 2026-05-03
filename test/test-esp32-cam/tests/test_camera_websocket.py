"""
Layer 4 — backend WS route accepts (or, today, *will* accept) the new
camera-frame message types without crashing.

The shim from autosearch/04 introduces three new WebSocket message
types:

  - 'camera_frame'         browser → backend, binary JPEG payload
  - 'esp32_camera_attach'  frontend asks backend to start serving frames
  - 'esp32_camera_detach'  frontend tells backend to drop the queue

This layer mocks the FastAPI WebSocket and asserts the route doesn't
500/raise on those messages. It runs in-process — no live backend, no
QEMU.

Today the route doesn't know the new types yet, so the relevant tests
are written as `unittest.expectedFailure` until the shim ships. That
way pytest goes green on every CI run, but a future contributor adding
the route handler gets a clear "now flip the @expectedFailure off"
signal.
"""

from __future__ import annotations

import importlib
import json
import pathlib
import sys
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

# The backend is not a package on PYTHONPATH by default. Match the same
# bootstrap that test/esp32_cam/test_esp32_cam_blink.py uses so this file
# is invocable from any CWD.
_BACKEND = pathlib.Path(__file__).resolve().parent.parent.parent.parent / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))


def _make_ws(messages: list[dict]) -> MagicMock:
    """Mirror of the helper in test_esp32_cam_blink.py — gives the route a
    receive_text() that yields prepared JSON messages then raises
    WebSocketDisconnect, so the route's `while True` loop terminates."""
    ws = MagicMock()
    ws.accept = AsyncMock()
    msg_iter = iter([json.dumps(m) for m in messages])

    async def receive_text():
        try:
            return next(msg_iter)
        except StopIteration:
            from fastapi.websockets import WebSocketDisconnect
            raise WebSocketDisconnect()

    ws.receive_text = receive_text
    ws.send_text = AsyncMock()
    return ws


class TestCameraWebSocketMessages(unittest.IsolatedAsyncioTestCase):
    """Exercise the simulation WS route with the new message types so that:

    1. **Now (no shim shipped):** the route falls through to the
       "unknown message type" branch silently — i.e. no exception, no
       crash. That keeps the door open for the frontend to start
       sending these messages early without breaking production.

    2. **Once the shim ships:** flip `expectedFailure` off and assert
       the route forwards the payload to `camera_queue.push()` /
       `esp_lib_manager.camera_attach()`. The skeleton is here so the
       diff that lands the shim is small and obvious."""

    async def asyncSetUp(self):
        import app.services.esp_qemu_manager as em_mod
        importlib.reload(em_mod)
        import app.services.esp32_lib_manager as lib_mod
        importlib.reload(lib_mod)
        import app.api.routes.simulation as sim_mod
        importlib.reload(sim_mod)
        self.sim_mod = sim_mod
        self.esp = em_mod.esp_qemu_manager
        self.lib = lib_mod.esp_lib_manager

    async def test_camera_frame_message_does_not_crash_route(self):
        """Send a `camera_frame` JSON message; route must not raise."""
        ws = _make_ws([{
            "type": "camera_frame",
            "data": {"fmt": "jpeg", "w": 320, "h": 240, "b64": "AAAA"},
        }])
        # Patch the start/stop hooks so the loop doesn't try to touch
        # actual QEMU; only the message dispatch matters.
        with patch.object(self.lib, "start_instance", new=AsyncMock()), \
             patch.object(self.lib, "stop_instance",  new=AsyncMock()), \
             patch.object(self.esp, "start_instance"), \
             patch.object(self.esp, "stop_instance"):
            try:
                await self.sim_mod.simulation_websocket(ws, "cam-frame-test")
            except Exception as e:  # pragma: no cover — must not happen
                self.fail(f"unknown msg_type 'camera_frame' crashed route: {e}")

    async def test_camera_attach_message_does_not_crash_route(self):
        ws = _make_ws([{
            "type": "esp32_camera_attach",
            "data": {"board": "esp32-cam"},
        }])
        with patch.object(self.lib, "start_instance", new=AsyncMock()), \
             patch.object(self.lib, "stop_instance",  new=AsyncMock()), \
             patch.object(self.esp, "start_instance"), \
             patch.object(self.esp, "stop_instance"):
            try:
                await self.sim_mod.simulation_websocket(ws, "cam-attach-test")
            except Exception as e:  # pragma: no cover
                self.fail(f"esp32_camera_attach crashed route: {e}")

    @unittest.expectedFailure
    async def test_camera_attach_forwards_to_lib_manager(self):
        """Once the shim lands, this should pass: 'esp32_camera_attach'
        must invoke the equivalent of `esp_lib_manager.camera_attach`."""
        ws = _make_ws([{
            "type": "esp32_camera_attach",
            "data": {"board": "esp32-cam"},
        }])
        with patch.object(self.lib, "camera_attach",
                          new=AsyncMock(), create=True) as cam_attach, \
             patch.object(self.lib, "start_instance", new=AsyncMock()), \
             patch.object(self.lib, "stop_instance",  new=AsyncMock()), \
             patch.object(self.esp, "start_instance"), \
             patch.object(self.esp, "stop_instance"):
            try:
                await self.sim_mod.simulation_websocket(ws, "cam-fwd-test")
            except Exception:
                pass
        cam_attach.assert_awaited()


if __name__ == "__main__":
    unittest.main(verbosity=2)
