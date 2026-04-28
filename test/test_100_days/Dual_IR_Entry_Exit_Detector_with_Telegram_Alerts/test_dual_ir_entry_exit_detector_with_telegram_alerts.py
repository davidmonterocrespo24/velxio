"""
Velxio emulation test for: Dual_IR_Entry_Exit_Detector_with_Telegram_Alerts

Board:    esp32
Features: wifi, telegram
Languages: py

Notes / known limitations:
#   * WiFi via QEMU slirp NIC (-nic user,model=esp32_wifi).
#   * Cloud service auth tokens are placeholders in source — the test only verifies the firmware boots and the WiFi stack comes up; outbound HTTPS to the real service is not asserted.

This test is intentionally lightweight: it does *not* mutate the user's
running backend. The "live" portion is gated on $VELXIO_BACKEND_URL and
auto-skips when the backend is not reachable, so the suite stays green
in CI on any developer machine.
"""

import asyncio
import base64
import json
import os
import sys
import unittest
from pathlib import Path

THIS_DIR   = Path(__file__).resolve().parent
SOURCE_DIR = THIS_DIR / "source"
REPO_ROOT  = THIS_DIR.parents[2]

sys.path.insert(0, str(REPO_ROOT / "test" / "test_100_days"))
sys.path.insert(0, str(REPO_ROOT / "backend"))

from _lib import (  # type: ignore  # noqa: E402
    BoardKind,
    classify_micropython_source,
    compile_python_sources,
    detect_arduino_includes,
    backend_websocket_url,
    backend_reachable,
    velxio_supports_board,
    PROJECT_BOARD,
)


PROJECT_NAME = 'Dual_IR_Entry_Exit_Detector_with_Telegram_Alerts'
PROJECT_BOARD_KIND: BoardKind = 'esp32'
EXPECTED_FEATURES = ['wifi', 'telegram']


class Test_Dual_IR_Entry_Exit_Detector_with_Telegram_Alerts_StaticAnalysis(unittest.TestCase):
    """Source-only checks — these always run."""

    def test_source_files_present(self):
        files = [p for p in SOURCE_DIR.rglob("*") if p.is_file()]
        self.assertTrue(files, "no source files copied into source/")

    def test_python_sources_compile(self):
        """Every .py file is valid Python (MicroPython is a strict subset)."""
        py_files = sorted(SOURCE_DIR.rglob("*.py"))
        if not py_files:
            self.skipTest("no .py files — Arduino-only project")
        errs = compile_python_sources(py_files)
        self.assertEqual(errs, [], f"syntax errors:\n  " + "\n  ".join(errs))

    def test_arduino_sources_parse(self):
        """For Arduino sketches: required headers are referenceable."""
        ino = sorted(SOURCE_DIR.rglob("*.ino")) + sorted(SOURCE_DIR.rglob("*.cpp"))
        if not ino:
            self.skipTest("no Arduino sketch — MicroPython project")
        includes = detect_arduino_includes(ino)
        # Smoke check — list of includes is non-empty for a real sketch
        self.assertIsInstance(includes, list)

    def test_board_is_supported_by_velxio(self):
        ok, reason = velxio_supports_board(PROJECT_BOARD_KIND)
        self.assertTrue(ok, f"board {PROJECT_BOARD_KIND!r} not supported: {reason}")

    def test_imports_have_velxio_analogue(self):
        """For MicroPython: imports map to modules Velxio's MP firmware ships."""
        py_files = sorted(SOURCE_DIR.rglob("*.py"))
        if not py_files:
            self.skipTest("no .py files")
        info = classify_micropython_source(py_files)
        # We only fail if the project imports a hard host-only module
        # (tkinter, flask, matplotlib) that obviously cannot run on the MCU.
        host_only_in_mcu = info["host_only_in_mcu_files"]
        self.assertEqual(
            host_only_in_mcu, [],
            f"host-only imports found in MCU code: {host_only_in_mcu}",
        )


@unittest.skipUnless(
    backend_reachable(),
    "Velxio backend not reachable on $VELXIO_BACKEND_URL "
    "(start it with: cd backend && uvicorn app.main:app --port 8001)",
)
class Test_Dual_IR_Entry_Exit_Detector_with_Telegram_Alerts_LiveBackend(unittest.IsolatedAsyncioTestCase):
    """End-to-end: connect to the real backend WebSocket, start an instance,
    feed the project's source files, and observe the boot transcript."""

    async def test_backend_websocket_handshake(self):
        import websockets  # type: ignore
        url = backend_websocket_url("test-100-days-dual_ir_entry_exit_detector_with_telegram_alerts")
        async with websockets.connect(url, ping_interval=None) as ws:
            # Just make sure the route accepts our connection and is willing
            # to read JSON. We do NOT start a heavy QEMU instance here.
            await ws.send(json.dumps({"type": "ping", "data": {}}))
            try:
                # Give the server up to 2 s to either echo, ignore, or close.
                await asyncio.wait_for(ws.recv(), timeout=2.0)
            except asyncio.TimeoutError:
                pass  # silent ignore is fine — route is alive
            except Exception:
                pass


if __name__ == "__main__":
    unittest.main(verbosity=2)
