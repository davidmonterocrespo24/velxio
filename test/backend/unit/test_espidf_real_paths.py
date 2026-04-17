"""
Diagnostic test: exercises _resolve_library_components with the REAL library
paths on this machine (C:/Users/David/Documents/Arduino/libraries and
C:/Espressif/components/arduino-esp32/libraries).

This reproduces the exact SSD1306 compilation failure and shows exactly what
user_libs/ structure the current code produces.

Run:
    python test/backend/unit/test_espidf_real_paths.py
or:
    python -m pytest test/backend/unit/test_espidf_real_paths.py -v -s
"""

import importlib
import os
import sys
import tempfile
import shutil
import unittest
from pathlib import Path

# Force fresh import — bypass any .pyc cache
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))

# Delete cached module if already imported so we get the live .py file
for key in list(sys.modules.keys()):
    if 'espidf_compiler' in key:
        del sys.modules[key]

from app.services.espidf_compiler import ESPIDFCompiler

# ── Real paths on this machine ────────────────────────────────────────────────
ARDUINO_LIBS = Path.home() / 'Documents' / 'Arduino' / 'libraries'
ESP32_LIBS   = Path('C:/Espressif/components/arduino-esp32/libraries')

SSD1306_SKETCH_HEADERS = ['Wire.h', 'Adafruit_GFX.h', 'Adafruit_SSD1306.h']

# ── SSD1306 sketch (same as the example) ─────────────────────────────────────
SSD1306_SKETCH = """\
// ESP32 — SSD1306 OLED Display (I2C 128×64)
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  display.clearDisplay();
  display.display();
}

void loop() {
  delay(1000);
}
"""


def make_compiler_with_real_paths() -> ESPIDFCompiler:
    comp = ESPIDFCompiler.__new__(ESPIDFCompiler)
    comp.idf_path     = 'C:/Espressif/frameworks/esp-idf-v4.4.7'
    comp.arduino_path = str(ESP32_LIBS.parent)  # C:/Espressif/components/arduino-esp32
    comp.has_arduino  = ESP32_LIBS.parent.is_dir()
    return comp


@unittest.skipIf(
    os.environ.get('CI') == 'true',
    'Requires local Arduino libraries installed on Windows — skipped in CI',
)
class TestRealPathsSSD1306(unittest.TestCase):
    """
    Uses actual library directories on this machine to reproduce the build failure.
    Only runs locally (not in CI) because it needs real Arduino library paths.
    """

    def setUp(self):
        self.comp     = make_compiler_with_real_paths()
        self.tmp      = tempfile.mkdtemp(prefix='velxio_diag_')
        self.user_libs = Path(self.tmp) / 'user_libs'
        self.user_libs.mkdir()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ── Pre-conditions ────────────────────────────────────────────────────────

    def test_prereq_arduino_libs_exists(self):
        self.assertTrue(ARDUINO_LIBS.is_dir(),
                        f'Arduino libs not found at {ARDUINO_LIBS}')

    def test_prereq_gfx_library_installed(self):
        gfx = ARDUINO_LIBS / 'Adafruit_GFX_Library'
        self.assertTrue(gfx.is_dir(),
                        'Adafruit_GFX_Library not installed — install via Library Manager')

    def test_prereq_ssd1306_library_installed(self):
        ssd = ARDUINO_LIBS / 'Adafruit_SSD1306'
        self.assertTrue(ssd.is_dir(),
                        'Adafruit_SSD1306 not installed — install via Library Manager')

    def test_prereq_gfx_header_exists(self):
        h = ARDUINO_LIBS / 'Adafruit_GFX_Library' / 'Adafruit_GFX.h'
        self.assertTrue(h.exists(), f'Adafruit_GFX.h not found at {h}')

    def test_prereq_ssd1306_header_exists(self):
        h = ARDUINO_LIBS / 'Adafruit_SSD1306' / 'Adafruit_SSD1306.h'
        self.assertTrue(h.exists(), f'Adafruit_SSD1306.h not found at {h}')

    # ── Module identity ───────────────────────────────────────────────────────

    def test_loaded_module_has_user_libs_all(self):
        """Verify the LIVE .py file is loaded, not stale .pyc."""
        import inspect
        source = inspect.getsource(ESPIDFCompiler._resolve_library_components)
        self.assertIn('user_libs_all', source,
                      'STALE CODE: _resolve_library_components does not contain '
                      '"user_libs_all" — the old bytecode (.pyc) is being used. '
                      'Kill uvicorn, delete __pycache__, restart.')

    def test_module_file_path(self):
        """Print the actual file being loaded."""
        import app.services.espidf_compiler as mod
        print(f'\n[diag] Loaded module from: {mod.__file__}')
        self.assertIn('espidf_compiler', mod.__file__)

    # ── _detect_external_includes ─────────────────────────────────────────────

    def test_detect_finds_gfx_and_ssd1306(self):
        """Headers from the SSD1306 sketch must all be detected."""
        result = self.comp._detect_external_includes(SSD1306_SKETCH)
        print(f'\n[diag] _detect_external_includes → {result}')
        self.assertIn('Adafruit_GFX.h', result,
                      'Adafruit_GFX.h not detected — it was silently skipped')
        self.assertIn('Adafruit_SSD1306.h', result)
        self.assertIn('Wire.h', result)

    # ── _find_library_for_header ──────────────────────────────────────────────

    def test_find_gfx_in_arduino_libs(self):
        result = self.comp._find_library_for_header('Adafruit_GFX.h', ARDUINO_LIBS)
        print(f'\n[diag] _find_library_for_header(Adafruit_GFX.h) → {result}')
        self.assertIsNotNone(result,
                             f'Adafruit_GFX.h not found in {ARDUINO_LIBS}')

    def test_find_ssd1306_in_arduino_libs(self):
        result = self.comp._find_library_for_header('Adafruit_SSD1306.h', ARDUINO_LIBS)
        print(f'\n[diag] _find_library_for_header(Adafruit_SSD1306.h) → {result}')
        self.assertIsNotNone(result,
                             f'Adafruit_SSD1306.h not found in {ARDUINO_LIBS}')

    def test_find_arduino_libs_dir(self):
        result = self.comp._find_arduino_libraries_dir()
        print(f'\n[diag] _find_arduino_libraries_dir() → {result}')
        self.assertIsNotNone(result, '_find_arduino_libraries_dir() returned None')
        self.assertTrue(result.is_dir())

    # ── _resolve_library_components ───────────────────────────────────────────

    def test_resolve_creates_user_libs_all(self):
        """After resolution, user_libs/ must contain user_libs_all/, NOT separate dirs."""
        arduino_libs = self.comp._find_arduino_libraries_dir()
        esp32_libs   = Path(self.comp.arduino_path) / 'libraries' if self.comp.arduino_path else None

        names, h2c = self.comp._resolve_library_components(
            SSD1306_SKETCH_HEADERS,
            arduino_libs, esp32_libs,
            'arduino-esp32', self.user_libs,
        )

        print(f'\n[diag] component_names  = {names}')
        print(f'[diag] header_to_comp   = {h2c}')
        print(f'[diag] user_libs/ contents:')
        for p in sorted(self.user_libs.rglob('*')):
            print(f'  {p.relative_to(self.user_libs)}')

        self.assertEqual(names, ['user_libs_all'],
                         f'Expected ["user_libs_all"], got {names}.\n'
                         'If names contains "Adafruit_SSD1306" etc., the old code is still running.')

    def test_gfx_header_in_user_libs_all(self):
        """Adafruit_GFX.h must be inside user_libs_all/, not in a separate dir."""
        arduino_libs = self.comp._find_arduino_libraries_dir()
        esp32_libs   = Path(self.comp.arduino_path) / 'libraries' if self.comp.arduino_path else None

        self.comp._resolve_library_components(
            SSD1306_SKETCH_HEADERS,
            arduino_libs, esp32_libs,
            'arduino-esp32', self.user_libs,
        )

        gfx_in_all = self.user_libs / 'user_libs_all' / 'Adafruit_GFX.h'
        gfx_separate = self.user_libs / 'Adafruit_GFX_Library' / 'Adafruit_GFX.h'

        print(f'\n[diag] user_libs_all/Adafruit_GFX.h exists: {gfx_in_all.exists()}')
        print(f'[diag] separate Adafruit_GFX_Library/Adafruit_GFX.h exists: {gfx_separate.exists()}')

        self.assertTrue(gfx_in_all.exists(),
                        'Adafruit_GFX.h NOT in user_libs_all — '
                        'when Adafruit_SSD1306.cpp compiles it cannot find it')
        self.assertFalse(gfx_separate.exists(),
                         'Separate Adafruit_GFX_Library/ dir found — OLD CODE IS RUNNING')

    def test_cmake_lists_both_cpp_files(self):
        """user_libs_all/CMakeLists.txt must list Adafruit_GFX.cpp and Adafruit_SSD1306.cpp."""
        arduino_libs = self.comp._find_arduino_libraries_dir()
        esp32_libs   = Path(self.comp.arduino_path) / 'libraries' if self.comp.arduino_path else None

        self.comp._resolve_library_components(
            SSD1306_SKETCH_HEADERS,
            arduino_libs, esp32_libs,
            'arduino-esp32', self.user_libs,
        )

        cmake_path = self.user_libs / 'user_libs_all' / 'CMakeLists.txt'
        if not cmake_path.exists():
            self.fail('user_libs_all/CMakeLists.txt does not exist — no component was created')

        cmake_text = cmake_path.read_text(encoding='utf-8')
        print(f'\n[diag] user_libs_all/CMakeLists.txt:\n{cmake_text}')

        self.assertIn('Adafruit_GFX.cpp', cmake_text)
        self.assertIn('Adafruit_SSD1306.cpp', cmake_text)
        self.assertIn('INCLUDE_DIRS "."', cmake_text)


if __name__ == '__main__':
    print('=' * 70)
    print('SSD1306 Real-Path Diagnostic Test')
    print(f'Arduino libs : {ARDUINO_LIBS}')
    print(f'ESP32 libs   : {ESP32_LIBS}')
    print('=' * 70)
    unittest.main(verbosity=2)
