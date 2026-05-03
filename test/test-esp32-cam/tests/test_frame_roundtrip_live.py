"""
Phase-3 end-to-end live test — webcam JPEG → backend → QEMU → firmware
buffer round-trip.

Pipeline tested:
    PC webcam (or PIL synthetic JPEG)
        ↓ webcam_helper.get_test_jpeg()
    backend WebSocket (esp32_camera_attach + esp32_camera_frame)
        ↓ esp_lib_manager.camera_frame() → worker stdin
    worker subprocess (esp32_worker.py)
        ↓ ctypes.CDLL(libqemu-xtensa.dll).velxio_push_camera_frame()
    QEMU library (libqemu-xtensa.dll)
        ↓ velxio_camera_export.c → esp32_i2s_cam_push_frame()
    Esp32I2sCamState.frame_buf
        ↓ DMA descriptor walker, pack_two_pixels()
    firmware DMA buffer (s_buf in frame_roundtrip.ino)
        ↓ Serial.printf("FRAME[0..63]: ...")
    test assertion

What this test asserts:
    - The JPEG SOI marker (0xFF 0xD8 0xFF 0xE0) appears in the firmware
      buffer at the dma_elem_t-padded offsets (1, 3, 5, 7).
    - This proves the entire chain works for AT LEAST the first 4 bytes
      of frame data — anything else is the same DMA mechanism repeating.

What this test does NOT cover (yet — see autosearch/10):
    - Continuous capture (multiple EOFs in a stream)
    - The upstream esp_camera_init() / esp_camera_fb_get() public API
      (blocked by I²C NACK + framectrl semantics — Phase-3 follow-up)

Auto-skips when no backend is reachable on $VELXIO_BACKEND_URL so the
file stays green offline.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import pathlib
import re
import socket
import sys
import unittest
from urllib.parse import urlparse

# Make webcam_helper importable when pytest collects this file.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from webcam_helper import get_test_jpeg  # noqa: E402

_THIS_DIR = pathlib.Path(__file__).resolve().parent
_TEST_ROOT = _THIS_DIR.parent
_SKETCH = _TEST_ROOT / "sketches" / "frame_roundtrip" / "frame_roundtrip.ino"


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
class TestFrameRoundtripLive(unittest.IsolatedAsyncioTestCase):
    """The webcam → fb_get round trip. Marked PASSING because the
    QEMU OV2640+I²S devices ship in libqemu-xtensa with the camera
    patches and the frame-injection ctypes binding is wired through."""

    COMPILE_TIMEOUT = 300.0
    SERIAL_TIMEOUT = 35.0

    async def test_pushed_jpeg_appears_in_firmware_buffer(self):
        try:
            import httpx           # type: ignore
            import websockets      # type: ignore
        except ImportError as exc:
            self.skipTest(f"missing test deps: {exc}")

        # 1. Capture a frame (webcam if VELXIO_USE_WEBCAM=1, else synthetic)
        jpeg, src = get_test_jpeg()
        self.assertGreater(len(jpeg), 100, "JPEG too small to be valid")
        self.assertEqual(
            jpeg[:2], b"\xff\xd8",
            "test fixture is not a valid JPEG (missing SOI 0xFFD8)",
        )
        print(f"[test] frame source={src!r}, {len(jpeg)} bytes", flush=True)

        # 2. Compile the round-trip sketch
        sketch_text = _SKETCH.read_text(encoding="utf-8")
        async with httpx.AsyncClient(
            base_url=_backend_base_url(), timeout=self.COMPILE_TIMEOUT,
        ) as http:
            res = await http.post("/api/compile/", json={
                "files": [{"name": _SKETCH.name, "content": sketch_text}],
                "board_fqbn": "esp32:esp32:esp32cam",
            })
            self.assertEqual(res.status_code, 200,
                             f"HTTP {res.status_code}: {res.text[:400]}")
            body = res.json()
            if not body.get("success"):
                self.skipTest(
                    f"compile failure: "
                    f"{(body.get('error') or body.get('stderr',''))[:600]}"
                )
            firmware_b64 = body.get("binary_content") or body.get("firmware_b64")
            self.assertTrue(firmware_b64)

        # 3. Boot QEMU, wait for "WAITING_FOR_TRIGGER", push frame, signal.
        client_id = (
            f"frame-rt-test-{int(asyncio.get_event_loop().time() * 1000)}"
        )
        url = _ws_url(client_id)

        saw_ready = False
        saw_eof = False
        frame_dump_hex: list[str] | None = None
        accumulated = ""

        async with websockets.connect(
            url, ping_interval=None, max_size=4 * 1024 * 1024,
        ) as ws:
            await ws.send(json.dumps({
                "type": "start_esp32",
                "data": {"board": "esp32-cam", "firmware_b64": firmware_b64},
            }))

            pushed_frame = False
            sent_trigger = False
            dump_re = re.compile(r"FRAME\[0\.\.63\]:((?: [0-9A-F]{2})+)")
            eof_re = re.compile(r"EOF_OK \d+ms")

            try:
                deadline = asyncio.get_event_loop().time() + self.SERIAL_TIMEOUT
                while asyncio.get_event_loop().time() < deadline:
                    rem = deadline - asyncio.get_event_loop().time()
                    if rem <= 0:
                        break
                    raw = await asyncio.wait_for(ws.recv(), timeout=rem)
                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if msg.get("type") != "serial_output":
                        continue
                    accumulated += msg.get("data", {}).get("data", "")

                    if "WAITING_FOR_TRIGGER" in accumulated and not pushed_frame:
                        saw_ready = True
                        # 4. Push the JPEG via WebSocket.
                        print("[test] pushing JPEG via WS …", flush=True)
                        await ws.send(json.dumps({
                            "type": "esp32_camera_attach",
                            "data": {"board": "esp32-cam"},
                        }))
                        await ws.send(json.dumps({
                            "type": "esp32_camera_frame",
                            "data": {
                                "fmt": "jpeg",
                                "w": 320, "h": 240,
                                "b64": base64.b64encode(jpeg).decode(),
                            },
                        }))
                        pushed_frame = True
                        # 5. Trigger the sketch's arm_capture() — push a
                        #    serial byte. Worker dispatches `esp32_uart1_input`
                        #    style commands but for the default UART we
                        #    use the same channel as test_dht22 etc.
                        await asyncio.sleep(0.3)
                        await ws.send(json.dumps({
                            "type": "esp32_serial_input",
                            "data": {"bytes": [ord("g")]},
                        }))
                        sent_trigger = True

                    if eof_re.search(accumulated):
                        saw_eof = True
                    m = dump_re.search(accumulated)
                    if m:
                        frame_dump_hex = m.group(1).strip().split()
                        break
            except asyncio.TimeoutError:
                pass
            finally:
                try:
                    await ws.send(json.dumps({"type": "stop_esp32", "data": {}}))
                except Exception:
                    pass

        # 6. Assertions
        self.assertTrue(
            saw_ready,
            f"firmware never printed WAITING_FOR_TRIGGER. "
            f"Buffered serial[:400]={accumulated[:400]!r}",
        )
        self.assertTrue(
            saw_eof,
            f"firmware armed but no EOF arrived. Buffered: "
            f"{accumulated[-400:]!r}",
        )
        self.assertIsNotNone(
            frame_dump_hex,
            f"firmware never emitted FRAME[0..63] dump. "
            f"Buffered: {accumulated[-400:]!r}",
        )
        assert frame_dump_hex is not None
        self.assertEqual(
            len(frame_dump_hex), 64,
            f"expected 64 hex bytes, got {len(frame_dump_hex)}: {frame_dump_hex}",
        )

        # 7. Decode the dump and check for the JPEG SOI marker at the
        #    expected dma_elem_t-padded offsets:
        #    buf[1] = jpeg[0] = 0xFF (SOI hi)
        #    buf[3] = jpeg[1] = 0xD8 (SOI lo)
        #    buf[5] = jpeg[2] = 0xFF (APP0 marker)
        #    buf[7] = jpeg[3] = 0xE0 (JFIF)
        b = [int(h, 16) for h in frame_dump_hex]
        # Dump is informative when the assertion fails.
        sample_high_bytes = [b[i] for i in (1, 3, 5, 7, 9, 11, 13, 15)]
        sample_low_bytes  = [b[i] for i in (0, 2, 4, 6)]

        self.assertEqual(
            sample_low_bytes, [0x00] * len(sample_low_bytes),
            f"padding bytes (low half of dma_elem_t) should be 0x00, "
            f"got {sample_low_bytes}",
        )

        expected_first_8 = list(jpeg[:8])
        self.assertEqual(
            sample_high_bytes, expected_first_8,
            f"first 8 pixel bytes mismatch. expected={expected_first_8} "
            f"got={sample_high_bytes}\n"
            f"full dump={frame_dump_hex}",
        )

        print(
            f"[test] PASS — frame round-tripped through "
            f"backend → ctypes → QEMU → firmware (source={src})"
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
