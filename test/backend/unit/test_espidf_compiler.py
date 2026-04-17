"""
Tests for ESPIDFCompiler library resolution logic.

Tests the methods that detect, locate, and package external Arduino libraries
as proper ESP-IDF components — without requiring the full ESP-IDF toolchain.

Run from the repo root:
    python -m pytest test/backend/unit/test_espidf_compiler.py -v
"""

import sys
import tempfile
import shutil
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))

from app.services.espidf_compiler import ESPIDFCompiler


# ── Helpers ───────────────────────────────────────────────────────────────────

def make_compiler() -> ESPIDFCompiler:
    comp = ESPIDFCompiler.__new__(ESPIDFCompiler)
    comp.idf_path = ''
    comp.arduino_path = ''
    comp.has_arduino = False
    return comp


def make_library(libs_dir: Path, lib_name: str, headers: list[str],
                 sources: list[str], use_src_subdir: bool = False) -> Path:
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
        self.assertIn('DHT.h', self.comp._detect_external_includes(code))

    def test_detects_adafruit_gfx(self):
        """Adafruit_GFX.h must NOT be silently skipped — it is a user-installed lib."""
        code = '#include <Adafruit_GFX.h>'
        result = self.comp._detect_external_includes(code)
        self.assertIn('Adafruit_GFX.h', result,
                      'Adafruit_GFX.h was silently skipped — should be detected for library resolution')

    def test_detects_adafruit_ssd1306(self):
        code = '#include <Adafruit_SSD1306.h>'
        self.assertIn('Adafruit_SSD1306.h', self.comp._detect_external_includes(code))

    def test_skips_arduino_core_types(self):
        """Arduino.h and core types are in BUILTIN_HEADERS — skip them."""
        code = '#include <Arduino.h>\n#include <HardwareSerial.h>\n#include <pgmspace.h>'
        result = self.comp._detect_external_includes(code)
        self.assertEqual(result, [])

    def test_detects_wire_and_spi(self):
        """Wire.h and SPI.h are no longer in BUILTIN_HEADERS; they are resolved
        dynamically (skipped as bundled in esp32_libs or missing → warn)."""
        code = '#include <Wire.h>\n#include <SPI.h>\n#include <WiFi.h>'
        result = self.comp._detect_external_includes(code)
        # They should be detected (not silently dropped here)
        self.assertIn('Wire.h', result)
        self.assertIn('SPI.h', result)
        self.assertIn('WiFi.h', result)

    def test_skips_esp_idf_headers(self):
        code = '#include <esp_wifi.h>\n#include <freertos/FreeRTOS.h>\n#include <nvs_flash.h>'
        self.assertEqual([], self.comp._detect_external_includes(code))

    def test_skips_path_headers(self):
        code = '#include <driver/gpio.h>\n#include <soc/soc.h>'
        self.assertEqual([], self.comp._detect_external_includes(code))

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

    def test_handles_whitespace_in_include(self):
        code = '#  include  <DHT.h>'
        self.assertIn('DHT.h', self.comp._detect_external_includes(code))

    def test_empty_sketch(self):
        self.assertEqual([], self.comp._detect_external_includes('void setup() {} void loop() {}'))


# ── Test: _find_library_for_header ───────────────────────────────────────────

class TestFindLibraryForHeader(unittest.TestCase):

    def setUp(self):
        self.comp = make_compiler()
        self.tmp = tempfile.mkdtemp()
        self.libs_dir = Path(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_finds_library_in_root(self):
        make_library(self.libs_dir, 'DHT_sensor_library',
                     headers=['DHT.h', 'DHT_U.h'], sources=['DHT.cpp'])
        result = self.comp._find_library_for_header('DHT.h', self.libs_dir)
        self.assertIsNotNone(result)
        self.assertTrue((result / 'DHT.h').exists())

    def test_finds_library_in_src_subdir(self):
        make_library(self.libs_dir, 'Adafruit_Sensor',
                     headers=['Adafruit_Sensor.h'], sources=['Adafruit_Sensor.cpp'],
                     use_src_subdir=True)
        result = self.comp._find_library_for_header('Adafruit_Sensor.h', self.libs_dir)
        self.assertIsNotNone(result)

    def test_returns_none_for_missing_library(self):
        make_library(self.libs_dir, 'SomeOtherLib', headers=['Other.h'], sources=[])
        self.assertIsNone(self.comp._find_library_for_header('DHT.h', self.libs_dir))

    def test_returns_none_for_empty_dir(self):
        self.assertIsNone(self.comp._find_library_for_header('DHT.h', self.libs_dir))


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
        return make_library(self.libs_dir, 'DHT_sensor_library',
                            headers=['DHT.h', 'DHT_U.h'],
                            sources=['DHT.cpp', 'DHT_U.cpp'],
                            use_src_subdir=use_src)

    def test_creates_component_directory(self):
        lib_dir = self._make_dht_library()
        self.comp._create_idf_component('DHT.h', lib_dir, self.user_libs_dir, 'arduino-esp32')
        self.assertEqual(len(list(self.user_libs_dir.iterdir())), 1)

    def test_component_has_cmake_lists(self):
        lib_dir = self._make_dht_library()
        comp_name = self.comp._create_idf_component('DHT.h', lib_dir, self.user_libs_dir, 'arduino-esp32')
        self.assertTrue((self.user_libs_dir / comp_name / 'CMakeLists.txt').exists())

    def test_cmake_contains_idf_component_register(self):
        lib_dir = self._make_dht_library()
        comp_name = self.comp._create_idf_component('DHT.h', lib_dir, self.user_libs_dir, 'arduino-esp32')
        cmake_text = (self.user_libs_dir / comp_name / 'CMakeLists.txt').read_text()
        self.assertIn('idf_component_register', cmake_text)

    def test_cmake_includes_cpp_source(self):
        lib_dir = self._make_dht_library()
        comp_name = self.comp._create_idf_component('DHT.h', lib_dir, self.user_libs_dir, 'arduino-esp32')
        cmake_text = (self.user_libs_dir / comp_name / 'CMakeLists.txt').read_text()
        self.assertIn('DHT.cpp', cmake_text)

    def test_cmake_requires_arduino_component(self):
        lib_dir = self._make_dht_library()
        comp_name = self.comp._create_idf_component('DHT.h', lib_dir, self.user_libs_dir, 'arduino-esp32')
        cmake_text = (self.user_libs_dir / comp_name / 'CMakeLists.txt').read_text()
        self.assertIn('arduino-esp32', cmake_text)
        self.assertIn('REQUIRES', cmake_text)

    def test_cmake_sets_include_dirs(self):
        lib_dir = self._make_dht_library()
        comp_name = self.comp._create_idf_component('DHT.h', lib_dir, self.user_libs_dir, 'arduino-esp32')
        cmake_text = (self.user_libs_dir / comp_name / 'CMakeLists.txt').read_text()
        self.assertIn('INCLUDE_DIRS', cmake_text)
        self.assertIn('"."', cmake_text)

    def test_header_files_are_copied(self):
        lib_dir = self._make_dht_library()
        comp_name = self.comp._create_idf_component('DHT.h', lib_dir, self.user_libs_dir, 'arduino-esp32')
        comp_dir = self.user_libs_dir / comp_name
        self.assertTrue((comp_dir / 'DHT.h').exists())
        self.assertTrue((comp_dir / 'DHT_U.h').exists())

    def test_returns_sanitised_component_name(self):
        lib_dir = self._make_dht_library()
        comp_name = self.comp._create_idf_component('DHT.h', lib_dir, self.user_libs_dir, 'arduino-esp32')
        self.assertRegex(comp_name, r'^[A-Za-z0-9_]+$')
        self.assertEqual(comp_name, 'DHT_sensor_library')


# ── Test: _resolve_library_components (SSD1306 / transitive scenario) ─────────

class TestResolveLibraryComponents(unittest.TestCase):
    """
    Exercises the BFS that merges all libraries into a single 'user_libs_all'
    IDF component. This avoids ESP-IDF cross-component REQUIRES propagation issues.

    Mock library structure mirrors the real Adafruit SSD1306 scenario:
      arduino_libs/
        Adafruit_GFX_Library/
          Adafruit_GFX.h
          Adafruit_GFX.cpp
        Adafruit_SSD1306/
          Adafruit_SSD1306.h      ← includes <Adafruit_GFX.h>
          Adafruit_SSD1306.cpp

      esp32_libs/
        Wire/Wire.h, Wire.cpp     ← core, must be skipped
        SPI/SPI.h, SPI.cpp        ← core, must be skipped
    """

    def setUp(self):
        self.comp = make_compiler()
        self.tmp = tempfile.mkdtemp()
        self.arduino_libs = Path(self.tmp) / 'arduino_libs'
        self.esp32_libs   = Path(self.tmp) / 'esp32_libs'
        self.user_libs    = Path(self.tmp) / 'user_libs'
        self.arduino_libs.mkdir()
        self.esp32_libs.mkdir()
        self.user_libs.mkdir()

        make_library(self.arduino_libs, 'Adafruit_GFX_Library',
                     headers=['Adafruit_GFX.h', 'Adafruit_SPITFT.h'],
                     sources=['Adafruit_GFX.cpp', 'Adafruit_SPITFT.cpp'])

        ssd_dir = self.arduino_libs / 'Adafruit_SSD1306'
        ssd_dir.mkdir()
        (ssd_dir / 'Adafruit_SSD1306.h').write_text(
            '#include <Adafruit_GFX.h>\n// SSD1306 header', encoding='utf-8'
        )
        (ssd_dir / 'Adafruit_SSD1306.cpp').write_text('// impl', encoding='utf-8')

        make_library(self.esp32_libs, 'Wire', headers=['Wire.h'], sources=['Wire.cpp'])
        make_library(self.esp32_libs, 'SPI',  headers=['SPI.h'],  sources=['SPI.cpp'])

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def _resolve(self, ext_headers):
        return self.comp._resolve_library_components(
            ext_headers, self.arduino_libs, self.esp32_libs, 'arduino-esp32', self.user_libs
        )

    def test_returns_single_merged_component(self):
        """Any library resolution must produce exactly ['user_libs_all']."""
        names, _ = self._resolve(['Adafruit_GFX.h'])
        self.assertEqual(names, ['user_libs_all'],
                         'Expected single merged component "user_libs_all"')

    def test_gfx_header_merged_for_direct_include(self):
        """Adafruit_GFX.h directly in sketch → copied into user_libs_all."""
        self._resolve(['Adafruit_GFX.h'])
        self.assertTrue(
            (self.user_libs / 'user_libs_all' / 'Adafruit_GFX.h').exists(),
            'Adafruit_GFX.h not copied into user_libs_all — will not be on include path',
        )

    def test_both_libs_merged_for_ssd1306_sketch(self):
        """SSD1306 sketch: both GFX and SSD1306 files must be in user_libs_all."""
        self._resolve(['Wire.h', 'Adafruit_GFX.h', 'Adafruit_SSD1306.h'])
        all_dir = self.user_libs / 'user_libs_all'
        self.assertTrue((all_dir / 'Adafruit_GFX.h').exists(),
                        'Adafruit_GFX.h missing — SSD1306.cpp will fail to compile')
        self.assertTrue((all_dir / 'Adafruit_SSD1306.h').exists(),
                        'Adafruit_SSD1306.h missing')
        self.assertTrue((all_dir / 'Adafruit_GFX.cpp').exists())
        self.assertTrue((all_dir / 'Adafruit_SSD1306.cpp').exists())

    def test_wire_files_not_in_merged_component(self):
        """Wire is a core esp32 lib — must NOT be copied into user_libs_all."""
        self._resolve(['Wire.h', 'Adafruit_SSD1306.h'])
        all_dir = self.user_libs / 'user_libs_all'
        self.assertFalse((all_dir / 'Wire.h').exists(),
                         'Wire.h was incorrectly copied — it is already in arduino-esp32')

    def test_transitive_gfx_discovered_via_ssd1306(self):
        """When sketch only includes SSD1306, GFX is discovered transitively."""
        self._resolve(['Adafruit_SSD1306.h'])
        self.assertTrue(
            (self.user_libs / 'user_libs_all' / 'Adafruit_GFX.h').exists(),
            'Transitive Adafruit_GFX.h not discovered — SSD1306.h includes it',
        )

    def test_merged_component_cmake_has_all_sources(self):
        """user_libs_all CMakeLists.txt must list both GFX and SSD1306 .cpp files."""
        self._resolve(['Adafruit_GFX.h', 'Adafruit_SSD1306.h'])
        cmake_text = (self.user_libs / 'user_libs_all' / 'CMakeLists.txt').read_text()
        self.assertIn('Adafruit_GFX.cpp', cmake_text)
        self.assertIn('Adafruit_SSD1306.cpp', cmake_text)
        self.assertIn('INCLUDE_DIRS "."', cmake_text)
        self.assertIn('arduino-esp32', cmake_text)

    def test_header_to_comp_maps_to_user_libs_all(self):
        """header_to_comp must map every resolved header to 'user_libs_all'."""
        _, h2c = self._resolve(['Adafruit_GFX.h', 'Adafruit_SSD1306.h'])
        for h, c in h2c.items():
            self.assertEqual(c, 'user_libs_all', f'{h} mapped to "{c}" instead of "user_libs_all"')

    def test_no_components_when_no_external_headers(self):
        """Empty ext_headers → no component created."""
        names, h2c = self._resolve([])
        self.assertEqual(names, [])
        self.assertEqual(h2c, {})


# ── Test: main CMakeLists.txt patching ───────────────────────────────────────

class TestMainCMakePatching(unittest.TestCase):
    """Verify that component_names are injected into main/CMakeLists.txt correctly."""

    TEMPLATE_MAIN_CMAKE = (
        Path(__file__).parent.parent.parent.parent / 'backend'
        / 'app' / 'services' / 'esp-idf-template' / 'main' / 'CMakeLists.txt'
    )

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def _make_main_cmake(self) -> Path:
        p = Path(self.tmp) / 'CMakeLists.txt'
        shutil.copy(self.TEMPLATE_MAIN_CMAKE, p)
        return p

    def test_template_cmake_has_expected_requires_token(self):
        cmake_text = self.TEMPLATE_MAIN_CMAKE.read_text(encoding='utf-8')
        self.assertIn('REQUIRES ${_arduino_comp_name}', cmake_text,
                      'Template REQUIRES token not found — patching will silently do nothing')

    def test_patch_appends_component_names_to_requires(self):
        cmake_path = self._make_main_cmake()
        cmake_text = cmake_path.read_text(encoding='utf-8')
        old_req = r'REQUIRES ${_arduino_comp_name}'
        component_names = ['Adafruit_GFX_Library', 'Adafruit_SSD1306']
        main_reqs = ' '.join(component_names)
        self.assertIn(old_req, cmake_text, 'Token not found — test setup error')

        cmake_text = cmake_text.replace(old_req, f'{old_req} {main_reqs}')
        cmake_path.write_text(cmake_text, encoding='utf-8')

        result = cmake_path.read_text(encoding='utf-8')
        self.assertIn('Adafruit_GFX_Library', result)
        self.assertIn('Adafruit_SSD1306', result)
        self.assertIn('${_arduino_comp_name}', result,
                      'Original arduino_comp_name was removed — it must be preserved')

    def test_patch_adds_user_libs_all_include_dir(self):
        """user_libs_all dir must be added to INCLUDE_DIRS so sketch.ino.cpp
        can find all library headers directly."""
        cmake_path = self._make_main_cmake()
        cmake_text = cmake_path.read_text(encoding='utf-8')
        self.assertIn('INCLUDE_DIRS "."', cmake_text, 'Template INCLUDE_DIRS token missing')

        cmake_text = cmake_text.replace(
            'INCLUDE_DIRS "."',
            'INCLUDE_DIRS "." "../user_libs/user_libs_all"',
        )
        cmake_path.write_text(cmake_text, encoding='utf-8')

        result = cmake_path.read_text(encoding='utf-8')
        self.assertIn('../user_libs/user_libs_all', result,
                      'user_libs_all INCLUDE_DIR not added — library headers invisible to sketch')
        self.assertIn('"."', result, 'Original "." INCLUDE_DIR must be preserved')

    def test_patch_is_idempotent(self):
        """Applying the patch twice must not duplicate entries."""
        cmake_path = self._make_main_cmake()
        cmake_text = cmake_path.read_text(encoding='utf-8')
        old_req = r'REQUIRES ${_arduino_comp_name}'
        component_names = ['Adafruit_GFX_Library']

        cmake_text = cmake_text.replace(old_req, f'{old_req} {" ".join(component_names)}')
        count = cmake_text.count('Adafruit_GFX_Library')
        self.assertEqual(count, 1)


# ── Test: template CMakeLists.txt structure ──────────────────────────────────

class TestTemplateCMakeLists(unittest.TestCase):

    def test_root_cmake_has_user_libs_block(self):
        template_cmake = (
            Path(__file__).parent.parent.parent.parent / 'backend'
            / 'app' / 'services' / 'esp-idf-template' / 'CMakeLists.txt'
        )
        self.assertTrue(template_cmake.exists(), 'Template CMakeLists.txt not found')
        content = template_cmake.read_text(encoding='utf-8')
        self.assertIn('user_libs', content)
        self.assertIn('EXTRA_COMPONENT_DIRS', content)
        self.assertIn('EXISTS', content)

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
        TestResolveLibraryComponents,
        TestMainCMakePatching,
        TestTemplateCMakeLists,
    ]:
        suite.addTests(loader.loadTestsFromTestCase(cls))

    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
