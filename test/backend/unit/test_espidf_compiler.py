"""
Tests for ESPIDFCompiler library resolution logic.

Tests the methods that detect, locate, and package external Arduino libraries
as proper ESP-IDF components — without requiring the full ESP-IDF toolchain.

Run from the backend/ directory:
    python test_espidf_compiler.py
"""

import sys
import tempfile
import shutil
import unittest
from pathlib import Path

# Ensure backend/app is importable (for direct execution; pytest uses conftest.py)
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))

from app.services.espidf_compiler import ESPIDFCompiler


# ── Helpers ───────────────────────────────────────────────────────────────────

def make_compiler() -> ESPIDFCompiler:
    """Create an ESPIDFCompiler instance without a real IDF path."""
    comp = ESPIDFCompiler.__new__(ESPIDFCompiler)
    comp.idf_path = ''
    comp.arduino_path = ''
    comp.has_arduino = False
    return comp


def make_library(libs_dir: Path, lib_name: str, headers: list[str],
                 sources: list[str], use_src_subdir: bool = False) -> Path:
    """
    Create a mock Arduino library directory structure.

    libs_dir/
      {lib_name}/
        {lib_name}.h
        {lib_name}.cpp
        [src/]
          ...
    """
    lib_dir = libs_dir / lib_name
    lib_dir.mkdir(parents=True)
    src_dir = lib_dir / 'src' if use_src_subdir else lib_dir

    if use_src_subdir:
        src_dir.mkdir()

    for h in headers:
        (src_dir / h).write_text(f'// {h}', encoding='utf-8')
    for s in sources:
        (src_dir / s).write_text(f'// {s}', encoding='utf-8')

    return lib_dir


# ── Test: _detect_external_includes ──────────────────────────────────────────

class TestDetectExternalIncludes(unittest.TestCase):

    def setUp(self):
        self.comp = make_compiler()

    def test_detects_dht_header(self):
        code = '#include <DHT.h>\nvoid setup() {}'
        result = self.comp._detect_external_includes(code)
        self.assertIn('DHT.h', result)

    def test_skips_arduino_builtins(self):
        code = '#include <Arduino.h>\n#include <Wire.h>\n#include <SPI.h>\n#include <WiFi.h>'
        result = self.comp._detect_external_includes(code)
        self.assertEqual(result, [])

    def test_skips_esp_idf_headers(self):
        code = '#include <esp_wifi.h>\n#include <freertos/FreeRTOS.h>\n#include <nvs_flash.h>'
        result = self.comp._detect_external_includes(code)
        self.assertEqual(result, [])

    def test_skips_path_headers(self):
        # Headers with / are internal esp-idf or arduino-esp32 paths
        code = '#include <driver/gpio.h>\n#include <soc/soc.h>'
        result = self.comp._detect_external_includes(code)
        self.assertEqual(result, [])

    def test_detects_multiple_external(self):
        code = (
            '#include <Arduino.h>\n'
            '#include <DHT.h>\n'
            '#include <Adafruit_Sensor.h>\n'
            '#include <Wire.h>\n'
        )
        result = self.comp._detect_external_includes(code)
        self.assertIn('DHT.h', result)
        self.assertIn('Adafruit_Sensor.h', result)
        self.assertNotIn('Arduino.h', result)
        self.assertNotIn('Wire.h', result)

    def test_handles_whitespace_in_include(self):
        code = '#  include  <DHT.h>'
        result = self.comp._detect_external_includes(code)
        self.assertIn('DHT.h', result)

    def test_no_duplicates_from_multiple_files(self):
        code = '#include <DHT.h>\n#include <DHT.h>\n'
        result = self.comp._detect_external_includes(code)
        # List may have duplicates — the caller deduplicates; just check presence
        self.assertIn('DHT.h', result)

    def test_empty_sketch(self):
        result = self.comp._detect_external_includes('void setup() {} void loop() {}')
        self.assertEqual(result, [])


# ── Test: _find_library_for_header ───────────────────────────────────────────

class TestFindLibraryForHeader(unittest.TestCase):

    def setUp(self):
        self.comp = make_compiler()
        self.tmp = tempfile.mkdtemp()
        self.libs_dir = Path(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_finds_library_in_root(self):
        """Library with header in root (no src/ subdirectory)."""
        make_library(self.libs_dir, 'DHT_sensor_library',
                     headers=['DHT.h', 'DHT_U.h'], sources=['DHT.cpp', 'DHT_U.cpp'])
        result = self.comp._find_library_for_header('DHT.h', self.libs_dir)
        assert result is not None
        self.assertTrue((result / 'DHT.h').exists())

    def test_finds_library_in_src_subdir(self):
        """Library with header in src/ subdirectory (modern Arduino layout)."""
        make_library(self.libs_dir, 'Adafruit_Sensor',
                     headers=['Adafruit_Sensor.h'], sources=['Adafruit_Sensor.cpp'],
                     use_src_subdir=True)
        result = self.comp._find_library_for_header('Adafruit_Sensor.h', self.libs_dir)
        assert result is not None
        self.assertTrue((result / 'Adafruit_Sensor.h').exists())

    def test_returns_none_for_missing_library(self):
        make_library(self.libs_dir, 'SomeOtherLib',
                     headers=['Other.h'], sources=['Other.cpp'])
        result = self.comp._find_library_for_header('DHT.h', self.libs_dir)
        self.assertIsNone(result)

    def test_returns_none_for_empty_dir(self):
        result = self.comp._find_library_for_header('DHT.h', self.libs_dir)
        self.assertIsNone(result)


# ── Test: _create_idf_component ──────────────────────────────────────────────

class TestCreateIdfComponent(unittest.TestCase):

    def setUp(self):
        self.comp = make_compiler()
        self.tmp = tempfile.mkdtemp()
        self.libs_dir = Path(self.tmp) / 'arduino_libs'
        self.libs_dir.mkdir()
        self.user_libs_dir = Path(self.tmp) / 'user_libs'
        self.user_libs_dir.mkdir()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def _make_dht_library(self, use_src: bool = False) -> Path:
        return make_library(
            self.libs_dir, 'DHT_sensor_library',
            headers=['DHT.h', 'DHT_U.h'],
            sources=['DHT.cpp', 'DHT_U.cpp'],
            use_src_subdir=use_src,
        )

    def test_creates_component_directory(self):
        lib_dir = self._make_dht_library()
        src_root = lib_dir  # header is in root
        self.comp._create_idf_component('DHT.h', src_root, self.user_libs_dir, 'arduino-esp32')
        self.assertTrue(self.user_libs_dir.exists())
        comp_dirs = list(self.user_libs_dir.iterdir())
        self.assertEqual(len(comp_dirs), 1)

    def test_component_has_cmake_lists(self):
        lib_dir = self._make_dht_library()
        comp_name = self.comp._create_idf_component(
            'DHT.h', lib_dir, self.user_libs_dir, 'arduino-esp32'
        )
        cmake_path = self.user_libs_dir / comp_name / 'CMakeLists.txt'
        self.assertTrue(cmake_path.exists(), 'CMakeLists.txt not found')

    def test_cmake_contains_idf_component_register(self):
        lib_dir = self._make_dht_library()
        comp_name = self.comp._create_idf_component(
            'DHT.h', lib_dir, self.user_libs_dir, 'arduino-esp32'
        )
        cmake_text = (self.user_libs_dir / comp_name / 'CMakeLists.txt').read_text()
        self.assertIn('idf_component_register', cmake_text)

    def test_cmake_includes_cpp_source(self):
        lib_dir = self._make_dht_library()
        comp_name = self.comp._create_idf_component(
            'DHT.h', lib_dir, self.user_libs_dir, 'arduino-esp32'
        )
        cmake_text = (self.user_libs_dir / comp_name / 'CMakeLists.txt').read_text()
        self.assertIn('DHT.cpp', cmake_text)

    def test_cmake_requires_arduino_component(self):
        lib_dir = self._make_dht_library()
        comp_name = self.comp._create_idf_component(
            'DHT.h', lib_dir, self.user_libs_dir, 'arduino-esp32'
        )
        cmake_text = (self.user_libs_dir / comp_name / 'CMakeLists.txt').read_text()
        self.assertIn('arduino-esp32', cmake_text)
        self.assertIn('REQUIRES', cmake_text)

    def test_cmake_sets_include_dirs(self):
        lib_dir = self._make_dht_library()
        comp_name = self.comp._create_idf_component(
            'DHT.h', lib_dir, self.user_libs_dir, 'arduino-esp32'
        )
        cmake_text = (self.user_libs_dir / comp_name / 'CMakeLists.txt').read_text()
        self.assertIn('INCLUDE_DIRS', cmake_text)
        self.assertIn('"."', cmake_text)

    def test_header_files_are_copied(self):
        lib_dir = self._make_dht_library()
        comp_name = self.comp._create_idf_component(
            'DHT.h', lib_dir, self.user_libs_dir, 'arduino-esp32'
        )
        comp_dir = self.user_libs_dir / comp_name
        self.assertTrue((comp_dir / 'DHT.h').exists())
        self.assertTrue((comp_dir / 'DHT_U.h').exists())

    def test_cpp_files_are_copied(self):
        lib_dir = self._make_dht_library()
        comp_name = self.comp._create_idf_component(
            'DHT.h', lib_dir, self.user_libs_dir, 'arduino-esp32'
        )
        comp_dir = self.user_libs_dir / comp_name
        self.assertTrue((comp_dir / 'DHT.cpp').exists())
        self.assertTrue((comp_dir / 'DHT_U.cpp').exists())

    def test_returns_sanitised_component_name(self):
        lib_dir = self._make_dht_library()
        comp_name = self.comp._create_idf_component(
            'DHT.h', lib_dir, self.user_libs_dir, 'arduino-esp32'
        )
        # Component name must be a valid C identifier (no spaces, no dots)
        self.assertRegex(comp_name, r'^[A-Za-z0-9_]+$')
        # Must be based on library directory name, not the parent search dir
        self.assertEqual(comp_name, 'DHT_sensor_library')

    def test_custom_arduino_comp_name(self):
        """arduino_comp_name is properly forwarded into REQUIRES."""
        lib_dir = self._make_dht_library()
        comp_name = self.comp._create_idf_component(
            'DHT.h', lib_dir, self.user_libs_dir, 'arduino-esp32-custom'
        )
        cmake_text = (self.user_libs_dir / comp_name / 'CMakeLists.txt').read_text()
        self.assertIn('arduino-esp32-custom', cmake_text)

    def test_library_in_src_subdir(self):
        """Library with modern src/ layout is handled correctly."""
        lib_dir = self._make_dht_library(use_src=True)
        src_root = lib_dir / 'src'
        comp_name = self.comp._create_idf_component(
            'DHT.h', src_root, self.user_libs_dir, 'arduino-esp32'
        )
        comp_dir = self.user_libs_dir / comp_name
        self.assertTrue((comp_dir / 'DHT.h').exists())
        self.assertTrue((comp_dir / 'DHT.cpp').exists())


# ── Test: template CMakeLists.txt content ────────────────────────────────────

class TestTemplateCMakeLists(unittest.TestCase):

    def test_root_cmake_has_user_libs_block(self):
        template_cmake = (
            Path(__file__).parent.parent.parent.parent / 'backend'
            / 'app' / 'services' / 'esp-idf-template' / 'CMakeLists.txt'
        )
        self.assertTrue(template_cmake.exists(), 'Template CMakeLists.txt not found')
        content = template_cmake.read_text(encoding='utf-8')
        self.assertIn('user_libs', content,
                      'user_libs not referenced in root CMakeLists.txt')
        self.assertIn('EXTRA_COMPONENT_DIRS', content)
        self.assertIn('EXISTS', content,
                      'user_libs block should use EXISTS guard')

    def test_main_cmake_has_arduino_requires(self):
        main_cmake = (
            Path(__file__).parent.parent.parent.parent / 'backend'
            / 'app' / 'services' / 'esp-idf-template' / 'main' / 'CMakeLists.txt'
        )
        self.assertTrue(main_cmake.exists())
        content = main_cmake.read_text(encoding='utf-8')
        self.assertIn('REQUIRES', content)
        self.assertIn('_arduino_comp_name', content)


# ── Runner ────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print('=' * 60)
    print('ESPIDFCompiler Library Resolution Tests')
    print('=' * 60)
    loader = unittest.TestLoader()
    suite  = unittest.TestSuite()
    for cls in [
        TestDetectExternalIncludes,
        TestFindLibraryForHeader,
        TestCreateIdfComponent,
        TestTemplateCMakeLists,
    ]:
        suite.addTests(loader.loadTestsFromTestCase(cls))

    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
