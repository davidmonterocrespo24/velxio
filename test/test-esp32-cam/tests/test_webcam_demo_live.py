"""
End-to-end test for the ESP32-CAM webcam demo. Compiles webcam_demo.ino,
boots it under QEMU via the simulation WebSocket, pushes a synthetic
JPEG frame, then watches the serial output for `frame N: BYTES bytes`
which only prints if `esp_camera_fb_get()` returns a non-NULL fb.

Marks the test PASS when at least one frame echo arrives. Marks FAIL
otherwise — the actionable signal that the descriptor walker / VSYNC
timing / I2S pipeline still has a bug.

Auto-skips if no backend on $VELXIO_BACKEND_URL (default localhost:8001).
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import pathlib
import socket
import sys
import unittest
from urllib.parse import urlparse

_THIS_DIR = pathlib.Path(__file__).resolve().parent
_TEST_ROOT = _THIS_DIR.parent
_SKETCH = _TEST_ROOT / "sketches" / "webcam_demo" / "webcam_demo.ino"

sys.path.insert(0, str(_THIS_DIR))


def _backend_base_url() -> str:
    return os.environ.get("VELXIO_BACKEND_URL", "http://localhost:8001").strip()


def _backend_reachable(timeout: float = 0.5) -> bool:
    url = _backend_base_url()
    if not url:
        return False
    try:
        u = urlparse(url)
        host = u.hostname or "localhost"
        port = u.port or (443 if u.scheme == "https" else 80)
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _ws_url(client_id: str) -> str:
    base = _backend_base_url()
    u = urlparse(base)
    scheme = "wss" if u.scheme == "https" else "ws"
    host = u.hostname or "localhost"
    port = f":{u.port}" if u.port else ""
    return f"{scheme}://{host}{port}/api/simulation/ws/{client_id}"


def _make_minimal_jpeg() -> bytes:
    """Get a JPEG via the project's webcam helper (synthetic by default)."""
    from webcam_helper import get_test_jpeg
    data, _src = get_test_jpeg()
    return data


@unittest.skipUnless(
    _backend_reachable(),
    f"Velxio backend not reachable on {_backend_base_url()}",
)
class TestWebcamDemoLive(unittest.IsolatedAsyncioTestCase):
    COMPILE_TIMEOUT = 300.0
    BOOT_DELAY = 6.0  # Time to compile, boot, run cam_init.
    FB_GET_TIMEOUT = 25.0  # How long to wait for the first fb_get success.

    async def test_fb_get_returns_pushed_frame(self):
        try:
            import httpx           # type: ignore
            import websockets      # type: ignore
        except ImportError as exc:
            self.skipTest(f"missing test deps: {exc}")

        sketch = _SKETCH.read_text(encoding="utf-8")

        # 1. compile via /api/compile/
        async with httpx.AsyncClient(
            base_url=_backend_base_url(), timeout=self.COMPILE_TIMEOUT,
        ) as http:
            res = await http.post("/api/compile/", json={
                "files": [{"name": "webcam_demo.ino", "content": sketch}],
                "board_fqbn": "esp32:esp32:esp32cam",
            })
            self.assertEqual(res.status_code, 200, res.text[:400])
            body = res.json()
            if not body.get("success"):
                err = body.get("error") or body.get("stderr", "")[:600]
                self.skipTest(f"compile failed: {err}")
            firmware_b64 = body.get("binary_content") or body.get("firmware_b64")
            self.assertTrue(firmware_b64, "compile OK but no firmware")

        client_id = f"webcam-demo-test-{int(asyncio.get_event_loop().time() * 1000)}"
        jpeg = _make_minimal_jpeg()

        async with websockets.connect(
            _ws_url(client_id),
            ping_interval=None, max_size=16 * 1024 * 1024,
        ) as ws:
            # 2. boot
            await ws.send(json.dumps({
                "type": "start_esp32",
                "data": {"board": "esp32", "firmware_b64": firmware_b64},
            }))

            # 3. wait for boot
            await asyncio.sleep(self.BOOT_DELAY)

            # 4. attach + push frame repeatedly while watching serial.
            await ws.send(json.dumps({
                "type": "esp32_camera_attach", "data": {},
            }))

            saw_frame = False
            saw_init_ok = False
            transcript = []
            deadline = asyncio.get_event_loop().time() + self.FB_GET_TIMEOUT
            push_task = asyncio.create_task(_push_frames_loop(ws, jpeg))

            try:
                while asyncio.get_event_loop().time() < deadline:
                    remaining = deadline - asyncio.get_event_loop().time()
                    if remaining <= 0:
                        break
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                    except asyncio.TimeoutError:
                        break
                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if msg.get("type") == "serial_output":
                        s = msg.get("data", {}).get("data", "")
                        transcript.append(s)
                        joined = "".join(transcript)
                        if "camera_init ok" in joined:
                            saw_init_ok = True
                        if "frame " in joined and " bytes" in joined:
                            saw_frame = True
                            break
            finally:
                push_task.cancel()
                try:
                    await push_task
                except (asyncio.CancelledError, Exception):
                    pass
                try:
                    await ws.send(json.dumps({"type": "stop_esp32", "data": {}}))
                except Exception:
                    pass

            full_transcript = "".join(transcript)
            print("\n--- SERIAL TRANSCRIPT ---\n", full_transcript[-2000:])
            self.assertTrue(
                saw_init_ok,
                "Camera init did not succeed — bug regressed or compile mismatch",
            )
            self.assertTrue(
                saw_frame,
                f"firmware never printed 'frame N: BYTES bytes ...' within "
                f"{self.FB_GET_TIMEOUT}s. fb_get() likely still NULL. "
                f"Last transcript: ...{full_transcript[-600:]}",
            )


async def _push_frames_loop(ws, jpeg: bytes):
    """Stream the same JPEG ~10 fps for the duration of the test."""
    frame_b64 = base64.b64encode(jpeg).decode("ascii")
    while True:
        try:
            await ws.send(json.dumps({
                "type": "esp32_camera_frame",
                "data": {"fmt": "jpeg", "w": 1, "h": 1, "b64": frame_b64},
            }))
            await asyncio.sleep(0.1)
        except Exception:
            return


if __name__ == "__main__":
    unittest.main(verbosity=2)
