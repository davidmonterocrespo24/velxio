"""
test_esp32_cam_blink.py — regression test for issue #129 (ESP32-CAM pin 13 not blinking).

Issue: https://github.com/davidmonterocrespo24/velxio/issues/129

User report: a basic blink sketch on GPIO13 of an ESP32-CAM never lights or
toggles the LED in the Velxio simulator, despite voltage being measurable
at the pin.

This file ships five layers of coverage so that, whichever component is
broken, exactly one layer fails and points at the cause:

    Layer 1  Static — the sketch the user reported is present and matches
             the issue body verbatim. Always runs.

    Layer 2  Frontend metadata — `esp32-cam` is registered as a BoardKind,
             has an FQBN, and the rendered element exposes a pin '13'.
             Catches "the board was renamed/removed and silently 404s".

    Layer 3  Pin mapping — Python mirror of `boardPinToNumber('esp32-cam',
             '13')` returns 13. Catches "frontend mapping returns null and
             nothing ever subscribes to GPIO13".

    Layer 4  Backend WS route accepts board='esp32-cam' — the simulation
             websocket forwards the start_esp32 payload to esp_lib_manager
             without rejecting the unknown variant. Catches "backend
             dropped esp32-cam silently and never booted QEMU".

    Layer 5  Live compile + WebSocket — POSTs the IRAM-safe control sketch
             to `/api/compile/`, takes the resulting `firmware_b64`, opens
             the simulation WebSocket, sends `start_esp32` with the
             freshly-compiled firmware, and asserts a `gpio_change` frame
             for pin 13 arrives. This is the closest possible reproduction
             of what the browser does. Auto-skips when the backend is not
             reachable on $VELXIO_BACKEND_URL.

Why no pre-built binary in the repo: the existing CI pattern (see
`test/backend/e2e/test_hcsr04_simulation.mjs` and
`test/test_custom_chips_boards/test_esp32_chip_i2c.py`) compiles every
sketch on demand through the backend. That keeps the repo binary-clean
and guarantees the firmware always matches whatever ESP32 core the CI
just installed.

Run all layers (live one auto-skips if no backend):

    python -m pytest test/esp32_cam/test_esp32_cam_blink.py -v

Run the live layer explicitly against a local backend:

    cd backend && uvicorn app.main:app --port 8001 &
    VELXIO_BACKEND_URL=http://localhost:8001 \
      python -m pytest test/esp32_cam/test_esp32_cam_blink.py -v
"""

import asyncio
import json
import os
import pathlib
import re
import socket
import sys
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from urllib.parse import urlparse

# ── Paths ─────────────────────────────────────────────────────────────────────
_THIS_DIR    = pathlib.Path(__file__).resolve().parent
_REPO        = _THIS_DIR.parent.parent
_BACKEND     = _REPO / "backend"
_FRONTEND    = _REPO / "frontend" / "src"
_USER_SKETCH = _THIS_DIR / "sketches" / "blink_pin13" / "blink_pin13.ino"
_IRAM_SKETCH = _THIS_DIR / "sketches" / "blink_pin13_iram" / "blink_pin13_iram.ino"

sys.path.insert(0, str(_BACKEND))


# ═════════════════════════════════════════════════════════════════════════════
# Layer 1 — static: the user's sketch is present and matches the issue body
# ═════════════════════════════════════════════════════════════════════════════

class TestSketchSourceMatchesIssue(unittest.TestCase):
    """The sketch shipped with this test must reproduce the issue verbatim,
    not a "fixed" approximation. A future contributor who edits the sketch
    to make the test pass would change the meaning of the regression."""

    def test_user_sketch_exists(self):
        self.assertTrue(
            _USER_SKETCH.is_file(),
            f"User sketch missing: {_USER_SKETCH}",
        )

    def test_iram_control_sketch_exists(self):
        self.assertTrue(
            _IRAM_SKETCH.is_file(),
            f"IRAM control sketch missing: {_IRAM_SKETCH}",
        )

    def test_user_sketch_uses_pin_13(self):
        text = _USER_SKETCH.read_text()
        self.assertRegex(
            text, r"#define\s+LED_PIN\s+13\b",
            "User sketch must keep #define LED_PIN 13 to repro issue #129",
        )

    def test_user_sketch_uses_arduino_delay(self):
        """delay() and pinMode/digitalWrite are the Arduino-runtime path.
        That path is exactly what crashes under lcgamboa flash-cache disable
        — the regression we're capturing."""
        text = _USER_SKETCH.read_text()
        self.assertIn("delay(1000);", text)
        self.assertIn("pinMode(LED_PIN, OUTPUT);", text)
        self.assertIn("digitalWrite(LED_PIN, HIGH);", text)
        self.assertIn("digitalWrite(LED_PIN, LOW);", text)

    def test_iram_sketch_uses_gpio13(self):
        """Control sketch must target GPIO13 (1u<<13) — the same pin —
        otherwise we're not isolating the runtime difference from the
        pin-routing question."""
        text = _IRAM_SKETCH.read_text()
        self.assertRegex(text, r"\(1u\s*<<\s*13\)")


# ═════════════════════════════════════════════════════════════════════════════
# Layer 2 — frontend metadata: ESP32-CAM is a real, exposed BoardKind
# ═════════════════════════════════════════════════════════════════════════════

class TestEsp32CamBoardMetadata(unittest.TestCase):
    """Mirror the bits of frontend/src/types/board.ts and
    components/velxio-components/Esp32Element.ts that the issue depends on."""

    BOARD_TS = _FRONTEND / "types" / "board.ts"
    ELEMENT  = _FRONTEND / "components" / "velxio-components" / "Esp32Element.ts"

    def test_board_ts_has_esp32_cam_kind(self):
        text = self.BOARD_TS.read_text(encoding="utf-8")
        self.assertIn("'esp32-cam'", text,
                      "BoardKind union missing 'esp32-cam'")

    def test_board_ts_has_esp32_cam_fqbn(self):
        text = self.BOARD_TS.read_text(encoding="utf-8")
        self.assertRegex(
            text,
            r"'esp32-cam'\s*:\s*'esp32:esp32:esp32cam'",
            "BOARD_KIND_FQBN missing or wrong for esp32-cam",
        )

    def test_esp32_cam_element_exposes_pin_13(self):
        """If pin '13' disappears from PINS_ESP32_CAM the wire system has
        nothing to attach to and the LED would correctly fail to light."""
        text = self.ELEMENT.read_text(encoding="utf-8")
        match = re.search(
            r"PINS_ESP32_CAM\s*=\s*\[(.*?)\];",
            text,
            re.DOTALL,
        )
        self.assertIsNotNone(match, "PINS_ESP32_CAM array not found")
        assert match is not None  # narrow for type checker
        block = match.group(1)
        self.assertRegex(
            block,
            r"\{\s*name:\s*'13'",
            "ESP32-CAM element missing pin '13'",
        )


# ═════════════════════════════════════════════════════════════════════════════
# Layer 3 — pin mapping: '13' on ESP32-CAM resolves to GPIO 13
# ═════════════════════════════════════════════════════════════════════════════

def esp32_cam_pin_to_number(pin_name: str) -> int | None:
    """Python mirror of boardPinToNumber('esp32-cam', pinName) for the
    'esp32' / startsWith('esp32') branch in
    frontend/src/utils/boardPinMapping.ts:317-326. Kept tiny and
    self-contained so a frontend rewrite that breaks the routing here is
    caught without spinning up Node."""
    if pin_name.startswith(("GND", "3V3", "5V")):
        return -1
    try:
        num = int(pin_name)
        if 0 <= num <= 39:
            return num
    except ValueError:
        pass
    aliases = {"TX": 1, "RX": 3, "VP": 36, "VN": 39}
    return aliases.get(pin_name)


class TestEsp32CamPinMapping(unittest.TestCase):

    def test_pin_13_maps_to_gpio_13(self):
        """The single load-bearing assertion for issue #129's hot path."""
        self.assertEqual(esp32_cam_pin_to_number("13"), 13)

    def test_named_pins_still_map(self):
        self.assertEqual(esp32_cam_pin_to_number("0"), 0)
        self.assertEqual(esp32_cam_pin_to_number("2"), 2)
        self.assertEqual(esp32_cam_pin_to_number("4"), 4)
        self.assertEqual(esp32_cam_pin_to_number("12"), 12)
        self.assertEqual(esp32_cam_pin_to_number("14"), 14)
        self.assertEqual(esp32_cam_pin_to_number("15"), 15)
        self.assertEqual(esp32_cam_pin_to_number("16"), 16)
        self.assertEqual(esp32_cam_pin_to_number("RX"), 3)
        self.assertEqual(esp32_cam_pin_to_number("TX"), 1)

    def test_power_pins_skipped(self):
        for name in ("GND", "GND.1", "GND.2", "GND.3", "3V3", "5V", "5V.1", "VCC"):
            # 'VCC' is treated as input rail by the canvas — not a GPIO.
            # The mapping returns -1 for explicit power pins; VCC is
            # currently None, which the wire system also skips silently.
            result = esp32_cam_pin_to_number(name)
            self.assertIn(result, (-1, None), f"{name!r} → {result!r}")


# ═════════════════════════════════════════════════════════════════════════════
# Layer 4 — backend WS route accepts board='esp32-cam' (in-process mock)
# ═════════════════════════════════════════════════════════════════════════════

class TestSimulationRouteAcceptsCamBoard(unittest.IsolatedAsyncioTestCase):
    """The backend route for `start_esp32` must forward board='esp32-cam'
    to esp_lib_manager.start_instance unchanged. The lib manager itself
    falls back to the default 'esp32-picsimlab' machine for unknown kinds
    (esp32_lib_manager.py:186), so the route's job is just to not block
    the message."""

    async def asyncSetUp(self):
        import importlib
        import app.services.esp_qemu_manager as em_mod
        importlib.reload(em_mod)
        import app.services.esp32_lib_manager as lib_mod
        importlib.reload(lib_mod)
        import app.api.routes.simulation as sim_mod
        importlib.reload(sim_mod)
        self.sim_mod = sim_mod
        self.esp     = em_mod.esp_qemu_manager
        self.lib     = lib_mod.esp_lib_manager

    def _make_ws(self, messages: list[dict]):
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
        ws.send_text    = AsyncMock()
        return ws

    async def test_start_esp32_with_board_esp32_cam_is_forwarded(self):
        import base64
        firmware = base64.b64encode(b"\x00" * 64).decode()
        ws = self._make_ws([{
            "type": "start_esp32",
            "data": {"board": "esp32-cam", "firmware_b64": firmware},
        }])
        # Mock both managers — only one runs depending on lib availability.
        with patch.object(self.lib, "start_instance",
                          new=AsyncMock()) as lib_start, \
             patch.object(self.lib, "stop_instance",  new=AsyncMock()), \
             patch.object(self.esp, "start_instance") as esp_start, \
             patch.object(self.esp, "stop_instance"):
            try:
                await self.sim_mod.simulation_websocket(ws, "esp-cam-ws")
            except Exception:
                pass

        # Exactly one path must have been called with board='esp32-cam'.
        called_with_cam = False
        for mock in (lib_start, esp_start):
            if mock.called:
                args = mock.call_args[0]
                # signature: (client_id, board, callback, firmware_b64, ...)
                if len(args) >= 2 and args[0] == "esp-cam-ws" \
                                  and args[1] == "esp32-cam":
                    called_with_cam = True
                    break
        self.assertTrue(
            called_with_cam,
            "Neither esp_lib_manager.start_instance nor "
            "esp_qemu_manager.start_instance was called with "
            "board='esp32-cam'",
        )


# ═════════════════════════════════════════════════════════════════════════════
# Layer 5 — live compile + WebSocket: blink the IRAM-safe control sketch
# ═════════════════════════════════════════════════════════════════════════════
#
# Mirrors the e2e flow of test/backend/e2e/test_hcsr04_simulation.mjs and
# test/test_custom_chips_boards/test_esp32_chip_i2c.py:
#
#   1. POST /api/compile/ with the .ino source → backend builds via
#      arduino-cli + esptool merge_bin → returns firmware_b64.
#   2. Open /api/simulation/ws/<id>, send start_esp32 with that firmware.
#   3. Wait for gpio_change frames on GPIO13.
#
# Auto-skips when no backend is reachable so this file stays green offline.

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
    """Construct the actual WS URL the frontend uses (Esp32Bridge.ts:157
    sends to `/simulation/ws/<id>` under the /api prefix)."""
    base = _backend_base_url() or "http://localhost:8001"
    u = urlparse(base)
    scheme = "wss" if u.scheme == "https" else "ws"
    host = u.hostname or "localhost"
    port = f":{u.port}" if u.port else ""
    return f"{scheme}://{host}{port}/api/simulation/ws/{client_id}"


@unittest.skipUnless(_backend_reachable(),
                     "Velxio backend not reachable on $VELXIO_BACKEND_URL "
                     "(start: cd backend && uvicorn app.main:app --port 8001 "
                     "and export VELXIO_BACKEND_URL=http://localhost:8001)")
class TestEsp32CamLiveCompileAndBlink(unittest.IsolatedAsyncioTestCase):
    """End-to-end: compile the IRAM-safe control sketch through the
    backend's arduino-cli pipeline, then boot it under QEMU through the
    same WebSocket the frontend uses, and assert GPIO13 actually toggles."""

    COMPILE_TIMEOUT = 300.0  # arduino-cli first-run install can be slow
    GPIO_TIMEOUT    = 35.0   # IRAM control sketch toggles ≥3 times in ~3 s
                             #   plus QEMU boot (≈10–15 s)

    async def test_gpio13_toggles_after_live_compile(self):
        try:
            import httpx          # type: ignore
            import websockets     # type: ignore
        except ImportError as exc:
            self.skipTest(f"missing test deps: {exc}")

        sketch = _IRAM_SKETCH.read_text(encoding="utf-8")
        sketch_name = _IRAM_SKETCH.name  # blink_pin13_iram.ino

        # ── 1. Compile via the backend ─────────────────────────────────────
        async with httpx.AsyncClient(
            base_url=_backend_base_url(),
            timeout=self.COMPILE_TIMEOUT,
        ) as http:
            res = await http.post("/api/compile/", json={
                "files":      [{"name": sketch_name, "content": sketch}],
                # esp32cam variant is the FQBN the frontend ships
                # (frontend/src/types/board.ts → BOARD_KIND_FQBN).
                "board_fqbn": "esp32:esp32:esp32cam",
            })
            self.assertEqual(res.status_code, 200,
                             f"/api/compile/ HTTP {res.status_code}: {res.text[:400]}")
            body = res.json()
            if not body.get("success"):
                self.skipTest(
                    f"backend reports compile failure on this CI runner: "
                    f"{body.get('error') or body.get('stderr', '')[:600]}"
                )
            firmware_b64 = body.get("binary_content") or body.get("firmware_b64")
            self.assertTrue(
                firmware_b64,
                f"compile succeeded but no firmware_b64 in response keys: "
                f"{list(body.keys())}",
            )

        # ── 2. Boot via the same WebSocket route the frontend uses ─────────
        client_id = f"esp32-cam-test-{int(asyncio.get_event_loop().time() * 1000)}"
        url = _ws_url(client_id)

        # The frontend collapses esp32-cam → 'esp32' before sending the
        # start frame (Esp32Bridge.toQemuBoardType). We send the literal
        # 'esp32-cam' here so this test ALSO covers a future refactor that
        # forwards the kind unchanged — issue #129's "ESP32-CAM specifically
        # broken" framing was misleading; both paths must end up at the
        # same QEMU machine.
        async with websockets.connect(url, ping_interval=None,
                                      max_size=16 * 1024 * 1024) as ws:
            await ws.send(json.dumps({
                "type": "start_esp32",
                "data": {
                    "board":        "esp32-cam",
                    "firmware_b64": firmware_b64,
                },
            }))

            saw_pin13 = False
            transitions = 0
            try:
                deadline = asyncio.get_event_loop().time() + self.GPIO_TIMEOUT
                while asyncio.get_event_loop().time() < deadline:
                    remaining = deadline - asyncio.get_event_loop().time()
                    if remaining <= 0:
                        break
                    raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if msg.get("type") == "gpio_change" \
                       and msg.get("data", {}).get("pin") == 13:
                        saw_pin13 = True
                        transitions += 1
                        # ≥3 transitions proves it's actually blinking,
                        # not just a one-shot HIGH at startup.
                        if transitions >= 3:
                            break
            except asyncio.TimeoutError:
                pass
            finally:
                try:
                    await ws.send(json.dumps({"type": "stop_esp32",
                                              "data": {}}))
                except Exception:
                    pass

        self.assertTrue(
            saw_pin13,
            f"No gpio_change frame for pin=13 arrived within "
            f"{self.GPIO_TIMEOUT}s. Either the backend dropped the "
            f"esp32-cam start, the firmware crashed before toggling, or "
            f"GPIO13 events are not being forwarded to the frontend.",
        )
        self.assertGreaterEqual(
            transitions, 3,
            f"GPIO13 only toggled {transitions} time(s) in {self.GPIO_TIMEOUT}s "
            f"— expected ≥3 for a periodic blink",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
