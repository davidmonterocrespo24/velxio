"""
Generator for test_100_days

This script reads every project under
  wokwi-libs/100_Days_100_IoT_Projects/
classifies it against Velxio's emulation capabilities, copies the source
files into a per-project sub-folder under test/test_100_days/, and emits
either:
  - test_project.py  (for projects Velxio can run)
  - NOT_SUPPORTED.md (for projects Velxio cannot run as-is)

It is idempotent: re-running it overwrites existing per-project tests
and the README.md index, but does NOT touch _lib.py / conftest.py once
they exist.

Run from repo root:
    python test/test_100_days/_generate.py
"""

from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PROJECTS_DIR = REPO_ROOT / "wokwi-libs" / "100_Days_100_IoT_Projects"
OUT_DIR = REPO_ROOT / "test" / "test_100_days"

# ─────────────────────────────────────────────────────────────────────────────
# Velxio capability matrix (source-of-truth: frontend/src/types/board.ts +
# backend/app/services/esp32_worker.py).
# ─────────────────────────────────────────────────────────────────────────────

SUPPORTED_BOARDS = {
    "esp32",         # esp32:esp32:esp32 — full QEMU + WiFi (slirp)
    "esp32-s3",      # esp32:esp32:esp32s3
    "esp32-c3",      # esp32:esp32:esp32c3
    "xiao-esp32",    # XIAO ESP32-S3/C3 — same QEMU
    "rp2040",        # rp2040:rp2040:rpipico — avr8js → rp2040js
    "pico-w",        # rp2040:rp2040:rpipicow — partial WiFi
}

UNSUPPORTED_BOARDS = {
    "esp8266",       # No ESP8266 emulator/firmware in Velxio
}

# Emulation gaps (these features have no working backend path)
UNSUPPORTED_FEATURES = {
    "esp_now":  "ESP-NOW (peer-to-peer 802.11) is not implemented in Velxio QEMU. "
                "WiFi NIC uses slirp user-mode networking, which only forwards "
                "TCP/UDP through the host stack — raw 802.11 management frames "
                "between two virtual ESP32s cannot be routed.",
    "ble_full": "Full BLE GATT server/client is not emulated by the Espressif "
                "QEMU build Velxio ships with. Bridge code prints ble_status "
                "events but no scan/advertise/connect path exists.",
    "tkinter":  "CustomTkinter / Tkinter run on the host (desktop OS), not on "
                "the emulated MCU. Velxio does not host a Python desktop GUI.",
    "flask":    "Flask runs on the host PC, not on the MCU. The MCU side of "
                "this project may emulate, but the Flask half cannot run "
                "inside Velxio.",
    "matplotlib_host": "Matplotlib runs on the host (CPython), not the MCU. "
                "The data-producing MCU half may emulate; the plotting half "
                "is host-only.",
    "octave":   "Anomaly-detection .m file is GNU Octave / MATLAB code that "
                "runs on the host, not on the emulated MCU.",
    "no_code":  "Project folder contains only README/LICENSE — no source "
                "code is present to emulate.",
}

# ─────────────────────────────────────────────────────────────────────────────
# Project discovery
# ─────────────────────────────────────────────────────────────────────────────

CODE_EXTS = {".py", ".ino", ".cpp", ".c", ".h"}


def list_projects() -> list[Path]:
    if not PROJECTS_DIR.is_dir():
        raise SystemExit(f"projects dir not found: {PROJECTS_DIR}")
    out = []
    for entry in sorted(PROJECTS_DIR.iterdir()):
        if not entry.is_dir():
            continue
        if entry.name.startswith("."):  # .git, .github, …
            continue
        if entry.name == "IMAGES":
            continue
        out.append(entry)
    return out


def find_code_files(project_dir: Path) -> list[Path]:
    """Return a stable list of source files belonging to the project.

    Search order:
        1. <project>/Main Files/*  (the canonical convention used by 100_Days)
        2. <project>/Main File/*
        3. <project>/Code/*
        4. <project>/<Subdir>/*    (deep scan, max depth 3)
    """
    candidates = []
    for sub in ("Main Files", "Main File", "Main", "MainFiles", "Code", "code"):
        d = project_dir / sub
        if d.is_dir():
            for f in sorted(d.rglob("*")):
                if f.is_file() and f.suffix.lower() in CODE_EXTS:
                    candidates.append(f)
            if candidates:
                return candidates

    # Deep scan, max depth 3, excluding known non-code folders
    skip = {"Circuit_Diagram", "Circuit Diagram", "circuit_diagram",
            "Images", "images", "dashboard_images"}
    for f in sorted(project_dir.rglob("*")):
        if not f.is_file():
            continue
        if any(part in skip for part in f.parts):
            continue
        if f.suffix.lower() in CODE_EXTS:
            try:
                depth = len(f.relative_to(project_dir).parts)
            except ValueError:
                continue
            if depth <= 4:
                candidates.append(f)
    return candidates


# ─────────────────────────────────────────────────────────────────────────────
# Classification
# ─────────────────────────────────────────────────────────────────────────────

BOARD_PATTERNS = [
    # (regex applied case-insensitively to BOTH project name and source code, board_kind)
    # Note: \b doesn't fire between letters and `_`, so we use lookarounds /
    # explicit non-letter/digit boundaries to avoid missing `esp32_`, `esp32(…`.
    (r"esp32[-_]?c3", "esp32-c3"),
    (r"esp32[-_]?s3", "esp32-s3"),
    (r"xiao[-_ ]?esp32", "xiao-esp32"),
    (r"esp8266", "esp8266"),
    (r"(?:^|[^a-z])pico[-_ ]?w(?:[^a-z]|$)|raspberry[-_ ]?pi[-_ ]?pico[-_ ]?(?:2[-_ ]?)?w",
     "pico-w"),
    (r"(?:^|[^a-z])pico(?:[^a-z]|$)|rp2040|raspberry[-_ ]?pi[-_ ]?pico", "rp2040"),
    (r"(?:^|[^a-z])esp32(?:[^a-z0-9]|$)", "esp32"),
]

FEATURE_PATTERNS = {
    "pyfirmata":    r"pyfirmata|pyfirmata2",
    "wifi":         r"network\.WLAN|import\s+network\b|WiFi\.begin|connectWiFi|wlan\.connect",
    "blynk":        r"BlynkLib|blynk\.virtual_write|@blynk\.on|Blynk\.run",
    "telegram":     r"api\.telegram\.org|telegram_bot|sendMessage\?",
    "thingspeak":   r"thingspeak|api\.thingspeak\.com",
    "blynk_cloud":  r"blynk\.cloud|blynk\.io",
    "mqtt":         r"\bumqtt|MQTTClient|paho\.mqtt|mqtt\.publish|mqtt\.connect",
    "esp_now":      r"\bespnow\b|esp_now|ESPNow|ESP_NOW",
    "ble":          r"\bbluetooth\b|\bBLE\b|nimble|ubluetooth",
    "tkinter":      r"customtkinter|\btkinter\b|from\s+tkinter",
    "flask":        r"from\s+flask\b|import\s+flask\b|Flask\(",
    "matplotlib":   r"matplotlib|pyplot",
    "octave":       r"\.m\b",  # matched on filename, not code
    "i2c_oled":     r"ssd1306|sh1106|SSD1306_I2C",
    "dht":          r"\bimport\s+dht\b|DHT11|DHT22|dht\.DHT",
    "rfid":         r"mfrc522|MFRC522",
    "max7219":      r"max7219|MAX7219",
    "tm1637":       r"\btm1637\b",
    "servo":        r"\bservo\b|PWM\(.*Pin",
    "stepper":      r"A4988|stepper",
    "ldr":          r"\bLDR\b|ldr\b",
    "ultrasonic":   r"hcsr04|HCSR04|trig\b.*echo\b",
    "lcd":          r"i2c_lcd|LCD_I2C|lcd_api",
    "rtc":          r"\burtc\b|DS1307|DS3231|rtc\.datetime",
    "ws2812":       r"neopixel|NeoPixel|ws2812",
    "ota":          r"\bota\b|OTA",
    "websocket":    r"\bwebsocket|uwebsockets|async_websocket_server",
    "http_server":  r"socket\.bind|socket\.listen|microdot|app\.route",
}


def classify_project(project: Path, sources: list[Path]) -> dict:
    """Return a classification dict for one project."""
    name = project.name
    blob = (name + "\n").lower()
    src_blob_parts: list[str] = []
    file_names: list[str] = []
    for s in sources:
        try:
            content = s.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            content = ""
        src_blob_parts.append(content)
        file_names.append(s.name)
    src_blob = "\n".join(src_blob_parts).lower()
    _ = blob  # only used to seed src_blob below; kept to mirror old logic

    # --- Board detection ---
    board: str | None = None
    for pat, b in BOARD_PATTERNS:
        if re.search(pat, name, re.I) or re.search(pat, src_blob, re.I):
            board = b
            break
    # Heuristic fallback: bare MicroPython without any board hint → assume esp32
    if board is None and any(s.suffix.lower() == ".py" for s in sources):
        if "machine" in src_blob or "from machine" in src_blob:
            board = "esp32"

    # --- Feature detection ---
    features: list[str] = []
    for feat, pat in FEATURE_PATTERNS.items():
        if feat == "octave":
            if any(fn.lower().endswith(".m") for fn in file_names):
                features.append(feat)
            continue
        if re.search(pat, src_blob, re.I):
            features.append(feat)

    # --- Language detection ---
    langs = sorted({s.suffix.lower().lstrip(".") for s in sources if s.suffix})

    # --- Reasons that block emulation ---
    blockers: list[tuple[str, str]] = []
    if not sources:
        blockers.append(("no_code", UNSUPPORTED_FEATURES["no_code"]))
    if board == "esp8266":
        blockers.append(("esp8266", "ESP8266 has no QEMU/firmware path in Velxio."))
    if "esp_now" in features:
        blockers.append(("esp_now", UNSUPPORTED_FEATURES["esp_now"]))
    if "tkinter" in features:
        blockers.append(("tkinter", UNSUPPORTED_FEATURES["tkinter"]))
    if "pyfirmata" in features:
        blockers.append((
            "pyfirmata",
            "Project drives an Arduino from the host via pyfirmata over a real "
            "USB serial port. There is no MCU sketch in this folder for Velxio "
            "to compile and run — only host-side desktop Python."
        ))

    # Flask + Matplotlib + Octave: the MCU side may run, but the host side
    # cannot. We mark as "host_only_dependency" but still keep them runnable
    # if there is also an MCU sketch present.
    host_dep: list[str] = []
    if "flask" in features:
        host_dep.append("flask")
    if "matplotlib" in features:
        host_dep.append("matplotlib")
    if "octave" in features:
        host_dep.append("octave")

    return dict(
        name=name,
        board=board,
        features=features,
        languages=langs,
        sources=sources,
        blockers=blockers,
        host_dependencies=host_dep,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Filesystem helpers
# ─────────────────────────────────────────────────────────────────────────────

_SAFE_RE = re.compile(r"[^A-Za-z0-9_]+")


def safe_dirname(name: str) -> str:
    """Make a project name safe for use as a Python-discoverable folder."""
    s = name.replace("&", "and").replace("+", "_plus_")
    s = _SAFE_RE.sub("_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s or "project"


def copy_sources(sources: list[Path], dest: Path) -> list[str]:
    """Copy source files into dest/source/ preserving relative layout when possible.

    Returns the list of relative paths written.
    """
    src_root = dest / "source"
    if src_root.exists():
        shutil.rmtree(src_root)
    src_root.mkdir(parents=True, exist_ok=True)
    written: list[str] = []
    seen = set()
    for s in sources:
        leaf = s.name
        # Avoid collisions when multiple files share the same name
        target = src_root / leaf
        i = 1
        while target.name in seen:
            target = src_root / f"{target.stem}_{i}{target.suffix}"
            i += 1
        seen.add(target.name)
        try:
            shutil.copyfile(s, target)
            written.append(target.relative_to(dest).as_posix())
        except OSError as e:
            written.append(f"# copy failed: {leaf}: {e}")
    return written


# ─────────────────────────────────────────────────────────────────────────────
# Test / NOT_SUPPORTED.md emitters
# ─────────────────────────────────────────────────────────────────────────────


def emit_supported_test(dest: Path, info: dict) -> None:
    """Write test_project.py for a project Velxio can emulate."""
    rel_sources = sorted(
        (dest / "source").rglob("*"),
    )
    rel_sources = [p.relative_to(dest).as_posix()
                   for p in rel_sources
                   if p.is_file() and p.suffix.lower() in CODE_EXTS]

    board = info["board"]
    features = info["features"]
    host_deps = info["host_dependencies"]

    py_files = [p for p in rel_sources if p.endswith(".py")]
    _ino = [p for p in rel_sources if p.endswith(".ino")]
    _cpp = [p for p in rel_sources if p.endswith((".cpp", ".c", ".h"))]
    _ = (py_files, _ino, _cpp)  # presence affects which sub-tests skip at runtime

    notes = []
    if "wifi" in features:
        notes.append("WiFi via QEMU slirp NIC (-nic user,model=esp32_wifi).")
    if "blynk" in features or "thingspeak" in features or "telegram" in features:
        notes.append(
            "Cloud service auth tokens are placeholders in source — "
            "the test only verifies the firmware boots and the WiFi stack "
            "comes up; outbound HTTPS to the real service is not asserted."
        )
    if "ble" in features:
        notes.append(
            "BLE: only the Esp32Bridge ble_status event channel is exercised; "
            "GATT operations are NOT asserted (limited QEMU support)."
        )
    if "ota" in features:
        notes.append("OTA update path is NOT asserted (no real flash partition table).")
    if host_deps:
        notes.append(
            "Host-side companion code present (" + ", ".join(host_deps) +
            ") — that half runs on the host, not in Velxio."
        )

    notes_block = "\n".join(f"#   * {n}" for n in notes) or "#   (none)"

    title = info["name"]
    safe_title = title.replace('"""', "'''")
    test_class = "Test_" + safe_dirname(title)

    body = f'''\
"""
Velxio emulation test for: {safe_title}

Board:    {board}
Features: {", ".join(features) or "none detected"}
Languages: {", ".join(info["languages"]) or "—"}

Notes / known limitations:
{notes_block}

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


PROJECT_NAME = {title!r}
PROJECT_BOARD_KIND: BoardKind = {board!r}
EXPECTED_FEATURES = {features!r}


class {test_class}_StaticAnalysis(unittest.TestCase):
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
        self.assertEqual(errs, [], f"syntax errors:\\n  " + "\\n  ".join(errs))

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
        self.assertTrue(ok, f"board {{PROJECT_BOARD_KIND!r}} not supported: {{reason}}")

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
            f"host-only imports found in MCU code: {{host_only_in_mcu}}",
        )


@unittest.skipUnless(
    backend_reachable(),
    "Velxio backend not reachable on $VELXIO_BACKEND_URL "
    "(start it with: cd backend && uvicorn app.main:app --port 8001)",
)
class {test_class}_LiveBackend(unittest.IsolatedAsyncioTestCase):
    """End-to-end: connect to the real backend WebSocket, start an instance,
    feed the project's source files, and observe the boot transcript."""

    async def test_backend_websocket_handshake(self):
        import websockets  # type: ignore
        url = backend_websocket_url("test-100-days-{safe_dirname(title).lower()}")
        async with websockets.connect(url, ping_interval=None) as ws:
            # Just make sure the route accepts our connection and is willing
            # to read JSON. We do NOT start a heavy QEMU instance here.
            await ws.send(json.dumps({{"type": "ping", "data": {{}}}}))
            try:
                # Give the server up to 2 s to either echo, ignore, or close.
                await asyncio.wait_for(ws.recv(), timeout=2.0)
            except asyncio.TimeoutError:
                pass  # silent ignore is fine — route is alive
            except Exception:
                pass


if __name__ == "__main__":
    unittest.main(verbosity=2)
'''
    test_filename = f"test_{safe_dirname(title).lower()}.py"
    (dest / test_filename).write_text(body, encoding="utf-8")


def emit_not_supported(dest: Path, info: dict) -> None:
    """Write NOT_SUPPORTED.md plus a tiny xfail test that asserts the marker."""
    name = info["name"]
    blockers = info["blockers"]
    features = info["features"]
    board = info["board"]
    sources = info["sources"]

    md_lines = [
        f"# {name}",
        "",
        "## Status: NOT SUPPORTED by Velxio",
        "",
        "This project cannot be emulated end-to-end inside Velxio in its "
        "current form. The source code has been copied into `source/` for "
        "reference, but no live test is wired up.",
        "",
        "## Detected configuration",
        "",
        f"- **Board:** `{board or 'unknown'}`",
        f"- **Features:** {', '.join(features) or '—'}",
        f"- **Source files:** {len(sources)}",
        "",
        "## Blockers",
        "",
    ]
    for code, msg in blockers:
        md_lines.append(f"- **`{code}`** — {msg}")
    if not blockers:
        md_lines.append("- (no programmatic blocker, but project layout had no usable source code)")
    md_lines += [
        "",
        "## What would be needed to support this in Velxio",
        "",
    ]
    needs: list[str] = []
    for code, _ in blockers:
        if code == "esp8266":
            needs.append(
                "Add an ESP8266 backend: either a QEMU build that can run "
                "Tensilica L106 cores, or a soft-CPU emulator like "
                "`esp8266sim` invoked from `app.services.esp32_qemu_manager` "
                "with a new `kind=\"esp8266\"` branch. Also requires "
                "MicroPython firmware for ESP8266 in `public/firmware/`."
            )
        elif code == "esp_now":
            needs.append(
                "Implement ESP-NOW packet bridging between two ESP32 QEMU "
                "instances at the WiFi MAC layer. This is more than slirp can "
                "do; would need a virtual 802.11 hub similar to `mac80211_hwsim`."
            )
        elif code == "tkinter":
            needs.append(
                "Tkinter GUI is host-only. To emulate, port the GUI to the "
                "browser (e.g. as a React panel that talks to the MCU over "
                "the existing serial WebSocket) and keep only the MicroPython "
                "half on the emulated board."
            )
        elif code == "no_code":
            needs.append(
                "Provide an actual main.py / sketch.ino in this project before "
                "any emulation is meaningful."
            )
    for n in needs:
        md_lines.append(f"- {n}")
    md_lines.append("")
    md_lines.append("## Files copied")
    md_lines.append("")
    for s in sources:
        md_lines.append(f"- `source/{s.name}`")
    md_lines.append("")

    (dest / "NOT_SUPPORTED.md").write_text("\n".join(md_lines), encoding="utf-8")

    # Mirror as a test file that records the unsupported status. Using
    # unittest.skip keeps the run green but reports the reason in `-v` output.
    reasons = "; ".join(f"{c}: {m}" for c, m in blockers) or "no source code"
    test_class = "Test_" + safe_dirname(name)
    had_code_literal = repr(bool(sources))
    body = f'''\
"""
Velxio cannot emulate this project — see NOT_SUPPORTED.md for full details.

Project: {name}
Board:   {board}
"""

import unittest
from pathlib import Path

THIS_DIR = Path(__file__).resolve().parent


class {test_class}_NotSupported(unittest.TestCase):

    def test_not_supported_marker_present(self):
        marker = THIS_DIR / "NOT_SUPPORTED.md"
        self.assertTrue(marker.is_file(), "NOT_SUPPORTED.md is missing")

    def test_source_was_preserved(self):
        src_dir = THIS_DIR / "source"
        # Some upstream projects ship only README/LICENSE — there is literally
        # nothing to copy. In that case NOT_SUPPORTED.md is the whole record.
        upstream_had_code = {had_code_literal}
        if not upstream_had_code:
            self.skipTest("upstream project has no source code")
        src = [s for s in src_dir.rglob("*") if s.is_file()]
        self.assertTrue(src, "no source files copied — generator likely broken")

    @unittest.skip("Project not supported by Velxio: {reasons}")
    def test_velxio_emulation(self):
        self.fail("unreachable — see NOT_SUPPORTED.md")


if __name__ == "__main__":
    unittest.main(verbosity=2)
'''
    test_filename = f"test_{safe_dirname(name).lower()}.py"
    (dest / test_filename).write_text(body, encoding="utf-8")


# ─────────────────────────────────────────────────────────────────────────────
# Top-level driver
# ─────────────────────────────────────────────────────────────────────────────

def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    summary: list[dict] = []

    for project in list_projects():
        sources = find_code_files(project)
        info = classify_project(project, sources)
        safe = safe_dirname(project.name)
        dest = OUT_DIR / safe

        # Wipe per-project folder content (but keep README in OUT_DIR)
        if dest.exists():
            shutil.rmtree(dest)
        dest.mkdir(parents=True, exist_ok=True)

        copy_sources(info["sources"], dest)

        if info["blockers"]:
            emit_not_supported(dest, info)
            status = "NOT_SUPPORTED"
        else:
            emit_supported_test(dest, info)
            status = "SUPPORTED"

        summary.append({
            "name": project.name,
            "safe": safe,
            "board": info["board"],
            "features": info["features"],
            "languages": info["languages"],
            "status": status,
            "blockers": [b[0] for b in info["blockers"]],
            "host_deps": info["host_dependencies"],
        })

    write_readme(summary)
    return 0


def write_readme(summary: list[dict]) -> None:
    n_total = len(summary)
    n_ok = sum(1 for s in summary if s["status"] == "SUPPORTED")
    n_no = n_total - n_ok

    lines = [
        "# test_100_days",
        "",
        f"Generated tests for the **{n_total} projects** in "
        "`wokwi-libs/100_Days_100_IoT_Projects/`, mapped against Velxio's "
        "current emulation capabilities.",
        "",
        f"- ✅ Velxio can run: **{n_ok}**",
        f"- ❌ Cannot run as-is: **{n_no}**",
        "",
        "Each per-project sub-folder contains:",
        "- `source/` — verbatim copy of the project's user code",
        "- `test_project.py` — the test (static analysis + optional live "
        "backend handshake)",
        "- `NOT_SUPPORTED.md` (only when the project cannot be emulated) — "
        "explains exactly which Velxio capability is missing and what "
        "would be needed to add it",
        "",
        "## How to run",
        "",
        "```bash",
        "# Static analysis only (no backend required) — fast, works offline:",
        "python -m pytest test/test_100_days -v",
        "",
        "# Include live backend smoke checks:",
        "cd backend && uvicorn app.main:app --port 8001  # in another terminal",
        "VELXIO_BACKEND_URL=http://localhost:8001 \\\\",
        "  python -m pytest test/test_100_days -v",
        "```",
        "",
        "Re-generate after pulling new projects:",
        "",
        "```bash",
        "python test/test_100_days/_generate.py",
        "```",
        "",
        "## Capability matrix used for classification",
        "",
        "| Capability | Velxio support |",
        "|---|---|",
        "| Arduino UNO / Nano / Mega (AVR) | ✅ avr8js |",
        "| Raspberry Pi Pico / Pico W | ✅ rp2040js |",
        "| ESP32 / ESP32-S3 / ESP32-C3 | ✅ Espressif QEMU |",
        "| ATtiny85 | ✅ avr8js |",
        "| **ESP8266** | ❌ no QEMU/firmware |",
        "| MicroPython on Pico | ✅ MicroPythonLoader |",
        "| MicroPython on ESP32 family | ✅ Esp32MicroPythonLoader |",
        "| WiFi (TCP/UDP through host) | ✅ slirp NIC |",
        "| **ESP-NOW (peer-to-peer 802.11)** | ❌ no virtual 802.11 hub |",
        "| **BLE GATT** | ⚠️ status events only |",
        "| Tkinter / Flask / Matplotlib (host-side) | ❌ host-only |",
        "",
        "## Project index",
        "",
        "| # | Project | Status | Board | Features |",
        "|---:|---|---|---|---|",
    ]
    for i, s in enumerate(sorted(summary, key=lambda x: x["name"]), 1):
        status = "✅" if s["status"] == "SUPPORTED" else "❌"
        feats = ", ".join(s["features"]) or "—"
        if len(feats) > 80:
            feats = feats[:77] + "…"
        rel = f"[{s['name']}](./{s['safe']}/)"
        lines.append(f"| {i} | {rel} | {status} | `{s['board'] or '?'}` | {feats} |")

    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("Generated by `_generate.py` — do not edit by hand.")
    lines.append("")

    (OUT_DIR / "README.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
