"""
Layer 1 + 2 — static fixtures and frontend metadata.

These two layers always run (no backend, no compile, no QEMU). They
catch regressions where:

  - The reproducer sketch is edited away from the upstream API surface
    (e.g. someone changes `esp_camera_fb_get` to a custom name to make
    the test pass — that defeats the regression).
  - The frontend silently drops `esp32-cam` from BoardKind, the FQBN
    table, or the rendered Web Component's pin list.

Mirrors the layout of test/esp32_cam/test_esp32_cam_blink.py so anyone
familiar with the issue-#129 regression suite reads this fluently.
"""

from __future__ import annotations

import pathlib
import re
import unittest


_THIS_DIR = pathlib.Path(__file__).resolve().parent
_TEST_ROOT = _THIS_DIR.parent
_REPO = _TEST_ROOT.parent.parent
_FRONTEND = _REPO / "frontend" / "src"
_SKETCH = _TEST_ROOT / "sketches" / "camera_init" / "camera_init.ino"


# ── Layer 1 — static reproducer ─────────────────────────────────────────────


class TestCameraSketchSurface(unittest.TestCase):
    """The sketch that drives the live layer must call the upstream API
    verbatim — `esp_camera_init`, `esp_camera_fb_get`, `esp_camera_fb_return`.
    If a contributor "fixes" the test by inlining a different name, the
    regression we care about (the upstream library not working under
    Velxio) is no longer exercised."""

    def test_sketch_exists(self):
        self.assertTrue(
            _SKETCH.is_file(), f"reproducer sketch missing: {_SKETCH}"
        )

    def test_sketch_includes_upstream_header(self):
        text = _SKETCH.read_text(encoding="utf-8")
        self.assertIn(
            '#include "esp_camera.h"', text,
            "sketch must include the upstream header — the whole point of the "
            "shim work is that this exact include keeps working.",
        )

    def test_sketch_calls_init_and_fb_get(self):
        text = _SKETCH.read_text(encoding="utf-8")
        self.assertIn("esp_camera_init(&cfg)", text)
        self.assertIn("esp_camera_fb_get()", text)
        self.assertIn("esp_camera_fb_return(fb)", text)

    def test_sketch_uses_jpeg_qvga_defaults(self):
        """QVGA + JPEG keeps the WS bandwidth in the few-KB-per-frame range
        documented in autosearch/03. If a future change bumps this to VGA
        without updating the bandwidth math, fail loudly."""
        text = _SKETCH.read_text(encoding="utf-8")
        self.assertIn("PIXFORMAT_JPEG", text)
        self.assertIn("FRAMESIZE_QVGA", text)


# ── Layer 2 — frontend metadata ─────────────────────────────────────────────


class TestEsp32CamFrontendMetadata(unittest.TestCase):
    """ESP32-CAM is registered with the right FQBN and the rendered
    Web Component exposes the SCCB pins our sketch relies on. Same idea
    as the equivalent class in test_esp32_cam_blink.py, scoped to camera
    pins (SIOD=26, SIOC=27, XCLK=0, PCLK=22, VSYNC=25, HREF=23)."""

    BOARD_TS = _FRONTEND / "types" / "board.ts"
    ELEMENT = _FRONTEND / "components" / "velxio-components" / "Esp32Element.ts"

    def test_board_kind_present(self):
        text = self.BOARD_TS.read_text(encoding="utf-8")
        self.assertIn("'esp32-cam'", text, "BoardKind union missing 'esp32-cam'")

    def test_fqbn_is_esp32cam_variant(self):
        text = self.BOARD_TS.read_text(encoding="utf-8")
        self.assertRegex(
            text,
            r"'esp32-cam'\s*:\s*'esp32:esp32:esp32cam'",
            "BOARD_KIND_FQBN must point esp32-cam at esp32:esp32:esp32cam",
        )

    def _pin_block(self) -> str:
        text = self.ELEMENT.read_text(encoding="utf-8")
        match = re.search(r"PINS_ESP32_CAM\s*=\s*\[(.*?)\];", text, re.DOTALL)
        self.assertIsNotNone(match, "PINS_ESP32_CAM array not found in element")
        assert match is not None
        return match.group(1)

    def test_element_exposes_already_wired_pins(self):
        """GPIOs already broken-out on the rendered board (existing wiring
        works for these — these are the user-facing GPIOs labelled on
        the AI-Thinker silkscreen)."""
        block = self._pin_block()
        for pin in ("0", "2", "4", "12", "13", "14", "15", "16"):
            self.assertRegex(
                block,
                r"\{\s*name:\s*'%s'" % pin,
                f"ESP32-CAM element missing pin {pin!r}",
            )

    @unittest.expectedFailure
    def test_element_exposes_camera_internal_pins(self):
        """The OV2640 is wired to internal GPIOs that DON'T appear on the
        AI-Thinker silkscreen (they go under-board straight to the
        camera socket): SIOD=26, SIOC=27, PCLK=22, VSYNC=25, HREF=23,
        Y2..Y9 = 5,18,19,21,36,39,34,35.

        For the shim path proposed in autosearch/04, **the user's sketch
        does NOT need these pins to exist on the canvas** — the shim
        skips the SCCB dance and synthesises the frame in firmware-space.
        BUT: a future Path-B implementation that emulates real DVP would
        require these pins to be present so wires can attach.

        Marked expected-failure to document the gap. When/if Path B is
        attempted, flip this to a passing assertion as the first PR step
        — the rendered element must learn these pins before the QEMU
        peripheral has anything to drive."""
        block = self._pin_block()
        for pin in ("22", "23", "25", "26", "27"):
            self.assertRegex(
                block,
                r"\{\s*name:\s*'%s'" % pin,
                f"ESP32-CAM element missing camera-internal pin {pin!r}",
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
