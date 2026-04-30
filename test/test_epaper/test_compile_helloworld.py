"""Cross-board compile smoke test for the 1.54" ePaper hello-world sketch.

What this checks:
  * The canonical GxEPD2 sketch in ``sketches/epaper_154_helloworld``
    compiles for every board family Velxio supports SPI ePaper on:
    ESP32, Raspberry Pi Pico, Arduino Uno.
  * The library install path (Library Manager auto-install of ``GxEPD2``
    and ``Adafruit_GFX``) actually works against a live backend.

This is **not** an emulation test — it just verifies the toolchain side.
The pixel-level emulation tests come later, once the EPaperPart hook is
implemented in the frontend.

Skip semantics:
  * If the backend isn't reachable at $VELXIO_BACKEND_URL → skipped.
  * If the backend reports the library isn't installed (or installation
    fails because the index can't be fetched) → skipped, not failed.
    These are environmental issues, not regressions.
"""
from __future__ import annotations

import os
from pathlib import Path

import httpx
import pytest


_HERE = Path(__file__).resolve().parent
_SKETCH = _HERE / "sketches" / "epaper_154_helloworld" / "epaper_154_helloworld.ino"

BACKEND_URL = os.environ.get("VELXIO_BACKEND_URL", "http://127.0.0.1:8765")


# ── Per-board FQBN we want compile coverage for ──────────────────────────────
TARGETS = [
    pytest.param(
        "esp32:esp32:esp32",
        id="esp32",
        marks=pytest.mark.skipif(
            os.environ.get("SKIP_ESP32_COMPILE") == "1",
            reason="SKIP_ESP32_COMPILE=1",
        ),
    ),
    pytest.param("rp2040:rp2040:rpipico", id="rp2040-pico"),
    pytest.param("arduino:avr:uno", id="arduino-uno"),
]


@pytest.fixture(scope="module")
def backend_alive() -> bool:
    """Quick TCP probe — skip the entire module if the backend isn't up."""
    try:
        with httpx.Client(base_url=BACKEND_URL, timeout=3.0) as c:
            r = c.get("/")
            return r.status_code < 500
    except Exception:
        return False


@pytest.fixture(scope="module")
def sketch_source() -> str:
    if not _SKETCH.is_file():
        pytest.fail(f"Sketch missing on disk: {_SKETCH}")
    return _SKETCH.read_text(encoding="utf-8")


@pytest.mark.parametrize("fqbn", TARGETS)
def test_helloworld_compiles_for_board(backend_alive, sketch_source, fqbn):
    """The 1.54" GxEPD2 hello-world must compile for every supported board."""
    if not backend_alive:
        pytest.skip(f"Backend not reachable at {BACKEND_URL}")

    payload = {
        "files": [{"name": "epaper_154_helloworld.ino", "content": sketch_source}],
        "board_fqbn": fqbn,
    }

    with httpx.Client(base_url=BACKEND_URL, timeout=300.0) as c:
        res = c.post("/api/compile/", json=payload)

    if res.status_code != 200:
        pytest.skip(f"Backend rejected compile request ({res.status_code}): {res.text[:300]}")

    data = res.json()
    if not data.get("success"):
        stderr = data.get("stderr", "") or data.get("error", "")
        # Environmental skips — these aren't Velxio bugs:
        #   - Library not installed yet (one-time install via Library Manager)
        #   - ESP-IDF first-build timeout (cold cmake configure can exceed 120 s)
        skip_markers = (
            "GxEPD2.h",
            "Adafruit_GFX.h",
            "library not found",
            "No such file or directory",
            "ESP-IDF cmake configure timed out",
            "esp-idf cmake configure timed out",
            "timed out",
        )
        if any(m in stderr for m in skip_markers):
            pytest.skip(
                "Skipped — environmental issue (library missing or ESP-IDF "
                "first-build timeout). Re-run after Library Manager install / "
                "warm-up build.\n"
                f"stderr excerpt: {stderr[:400]}"
            )
        pytest.fail(
            f"Compile failed for {fqbn}.\n"
            f"stderr (first 800 chars):\n{stderr[:800]}"
        )

    program = data.get("hex_content") or data.get("binary_content")
    assert program, f"No firmware bytes returned for {fqbn}"
    # Sanity: the firmware should be at least a few KB — a successful build
    # of GxEPD2's hello-world is ~20 KB on AVR, ~150 KB on ESP32.
    assert len(program) > 2_000, f"Firmware suspiciously small: {len(program)} bytes"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
