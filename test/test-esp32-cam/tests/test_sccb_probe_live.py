"""
Phase-1 live test — proves the QEMU OV2640 SCCB device answers the
chip-id dance.

Mirrors test_camera_live.py but exercises the simpler `sccb_probe.ino`
sketch, which only uses the ESP32 hardware I²C controller. No I²S, no
DMA, no DVP — so a failure here unambiguously points at our SCCB
device implementation.

@unittest.expectedFailure until Phase 1 lands. Flip off in the same
PR that ships hw/i2c/esp32_ov2640.c. See
autosearch/07_ov2640_sccb_spec.md for the register table the device
must implement to make this test pass.
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import socket
import unittest
from urllib.parse import urlparse


_THIS_DIR = pathlib.Path(__file__).resolve().parent
_TEST_ROOT = _THIS_DIR.parent
_SKETCH = _TEST_ROOT / "sketches" / "sccb_probe" / "sccb_probe.ino"


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


@unittest.skipUnless(
    _backend_reachable(),
    "Velxio backend not reachable on $VELXIO_BACKEND_URL",
)
class TestSccbProbeLive(unittest.IsolatedAsyncioTestCase):

    COMPILE_TIMEOUT = 300.0
    SERIAL_TIMEOUT = 25.0

    async def test_ov2640_chip_id_returned(self):
        """Compile sccb_probe.ino, boot it under QEMU, scan serial for
        the four-byte chip-id signature. The exact bytes 0x26 0x42 0xa2
        0x7f are spec'd in autosearch/07 — anything else means the
        device misbehaves.

        Phase 1 deliverable: PASSING since the OV2640 SCCB device shipped
        in libqemu-xtensa. See wokwi-libs/qemu-lcgamboa/hw/i2c/esp32_ov2640.c."""
        try:
            import httpx           # type: ignore
            import websockets      # type: ignore
        except ImportError as exc:
            self.skipTest(f"missing test deps: {exc}")

        sketch = _SKETCH.read_text(encoding="utf-8")
        sketch_name = _SKETCH.name

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
                self.skipTest(
                    f"compile failure: "
                    f"{(body.get('error') or body.get('stderr', ''))[:600]}"
                )
            firmware_b64 = body.get("binary_content") or body.get("firmware_b64")
            self.assertTrue(firmware_b64)

        client_id = (
            f"esp32-cam-sccb-test-"
            f"{int(asyncio.get_event_loop().time() * 1000)}"
        )
        url = _ws_url(client_id)

        async with websockets.connect(
            url, ping_interval=None, max_size=4 * 1024 * 1024,
        ) as ws:
            await ws.send(json.dumps({
                "type": "start_esp32",
                "data": {"board": "esp32-cam", "firmware_b64": firmware_b64},
            }))

            saw_chip_id = False
            saw_detected = False
            buf = ""
            try:
                deadline = asyncio.get_event_loop().time() + self.SERIAL_TIMEOUT
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
                        buf += msg.get("data", {}).get("data", "")
                        if "PID=0x26 VER=0x42 MIDH=0xA2 MIDL=0x7F" in buf:
                            saw_chip_id = True
                        if "OV2640 detected" in buf:
                            saw_detected = True
                        if saw_chip_id and saw_detected:
                            break
            except asyncio.TimeoutError:
                pass
            finally:
                try:
                    await ws.send(json.dumps({"type": "stop_esp32", "data": {}}))
                except Exception:
                    pass

        self.assertTrue(
            saw_chip_id,
            f"firmware never printed the OV2640 chip-id (looked for "
            f"'PID=0x26 VER=0x42 MIDH=0xA2 MIDL=0x7F'). Buffered serial: "
            f"{buf[:400]}",
        )
        self.assertTrue(
            saw_detected,
            "firmware printed wrong chip-id bytes — device emulation "
            "returns the wrong values",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
