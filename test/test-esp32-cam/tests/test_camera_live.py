"""
Layer 5 — live compile + WebSocket end-to-end.

Mirrors test/esp32_cam/test_esp32_cam_blink.py's live layer:

  1. POST the camera_init.ino sketch to /api/compile/.
  2. Open the simulation WebSocket and send `start_esp32`.
  3. Push a synthetic JPEG frame as a `camera_frame` message.
  4. Wait for serial output reporting `got frame: N bytes` with N>0.

Auto-skips if no backend is reachable on $VELXIO_BACKEND_URL — same
behaviour as the blink layer so this file stays green offline.

Today, even with a backend running, the test will *expectedly* fail at
step 4 because the shim isn't shipped yet. That's the regression
contract: a green Layer 5 means the camera-emulation pipeline works
end-to-end. A red Layer 5 with the precise stage that fails (compile?
boot? frame delivery? serial echo?) tells the contributor exactly where
the implementation is incomplete.

Marked `@unittest.expectedFailure` until the shim ships. Once it does,
flip the decorator off in the same diff that lands the shim — that's
the obvious atomic change.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import pathlib
import socket
import unittest
from urllib.parse import urlparse


_THIS_DIR = pathlib.Path(__file__).resolve().parent
_TEST_ROOT = _THIS_DIR.parent
_SKETCH = _TEST_ROOT / "sketches" / "camera_init" / "camera_init.ino"


def _backend_base_url() -> str:
    return os.environ.get("VELXIO_BACKEND_URL", "").strip()


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
    except Exception:
        return False


def _ws_url(client_id: str) -> str:
    base = _backend_base_url() or "http://localhost:8001"
    u = urlparse(base)
    scheme = "wss" if u.scheme == "https" else "ws"
    host = u.hostname or "localhost"
    port = f":{u.port}" if u.port else ""
    return f"{scheme}://{host}{port}/api/simulation/ws/{client_id}"


def _make_test_jpeg() -> bytes:
    """Smallest possible valid JPEG so we can ship the test with no fixture
    files. Generated once with PIL, embedded as base64 to keep the test
    self-contained. Decodes to a 1×1 pure-white pixel — proves the
    transport, not the visual fidelity (the live webcam path uses real
    JPEGs from the canvas; this test only validates plumbing)."""
    # 1x1 white JPEG, hand-crafted minimal payload (~125 bytes)
    return base64.b64decode(
        "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////"
        "////////////////////////////////////////////////////2wBDAf//////////////"
        "//////////////////////////////////////////////////////////////////////8A"
        "AEQgAAQABAwEiAAIRAQMRAf/EABQAAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAA"
        "AAAAAAAAAP/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oA"
        "DAMBAAIRAxEAPwA/Ahf//Z"
    )


@unittest.skipUnless(
    _backend_reachable(),
    "Velxio backend not reachable on $VELXIO_BACKEND_URL. Start one with: "
    "cd backend && uvicorn app.main:app --port 8001",
)
class TestCameraLiveCompileAndFrameRoundTrip(unittest.IsolatedAsyncioTestCase):
    """Compile the camera_init sketch, boot it under QEMU, push a JPEG
    over the WebSocket, and assert serial output reports the right
    `len`. Currently expected-failure until the firmware shim is in
    place."""

    COMPILE_TIMEOUT = 300.0
    SERIAL_TIMEOUT = 30.0

    @unittest.expectedFailure
    async def test_camera_fb_get_returns_pushed_frame(self):
        try:
            import httpx           # type: ignore
            import websockets      # type: ignore
        except ImportError as exc:
            self.skipTest(f"missing test deps: {exc}")

        sketch = _SKETCH.read_text(encoding="utf-8")
        sketch_name = _SKETCH.name

        # 1. compile
        async with httpx.AsyncClient(
            base_url=_backend_base_url(), timeout=self.COMPILE_TIMEOUT,
        ) as http:
            res = await http.post("/api/compile/", json={
                "files": [{"name": sketch_name, "content": sketch}],
                "board_fqbn": "esp32:esp32:esp32cam",
            })
            self.assertEqual(
                res.status_code, 200,
                f"/api/compile/ HTTP {res.status_code}: {res.text[:400]}",
            )
            body = res.json()
            if not body.get("success"):
                # Without the shim, even *compiling* the sketch may need
                # the upstream library installed. Skip gracefully so this
                # path doesn't masquerade as a regression.
                self.skipTest(
                    f"backend cannot compile camera_init.ino on this runner "
                    f"(probably missing esp32-camera library or shim): "
                    f"{(body.get('error') or body.get('stderr', ''))[:600]}"
                )
            firmware_b64 = body.get("binary_content") or body.get("firmware_b64")
            self.assertTrue(firmware_b64, "compile ok but firmware missing")

        # 2. boot via WS
        client_id = (
            f"esp32-cam-frame-test-"
            f"{int(asyncio.get_event_loop().time() * 1000)}"
        )
        url = _ws_url(client_id)
        jpeg = _make_test_jpeg()
        target_len = len(jpeg)

        async with websockets.connect(
            url, ping_interval=None, max_size=16 * 1024 * 1024,
        ) as ws:
            await ws.send(json.dumps({
                "type": "start_esp32",
                "data": {"board": "esp32-cam", "firmware_b64": firmware_b64},
            }))

            # 3. push a frame after a brief boot delay
            await asyncio.sleep(2.0)
            await ws.send(json.dumps({
                "type": "esp32_camera_attach",
                "data": {"board": "esp32-cam"},
            }))
            await ws.send(json.dumps({
                "type": "camera_frame",
                "data": {
                    "fmt": "jpeg", "w": 1, "h": 1,
                    "b64": base64.b64encode(jpeg).decode(),
                },
            }))

            # 4. read serial until we see the size echoed back
            saw_size = False
            try:
                deadline = (
                    asyncio.get_event_loop().time() + self.SERIAL_TIMEOUT
                )
                accumulated = io.StringIO()
                while asyncio.get_event_loop().time() < deadline:
                    remaining = deadline - asyncio.get_event_loop().time()
                    if remaining <= 0:
                        break
                    raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if msg.get("type") == "serial_output":
                        accumulated.write(msg.get("data", {}).get("data", ""))
                        if f"got frame: {target_len} bytes" in accumulated.getvalue():
                            saw_size = True
                            break
            except asyncio.TimeoutError:
                pass
            finally:
                try:
                    await ws.send(json.dumps({"type": "stop_esp32", "data": {}}))
                except Exception:
                    pass

        self.assertTrue(
            saw_size,
            f"firmware did not echo the pushed frame size ({target_len} bytes) "
            f"within {self.SERIAL_TIMEOUT}s — either the shim isn't installed "
            f"yet (current expected state) or the WS->shim path is broken.",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
