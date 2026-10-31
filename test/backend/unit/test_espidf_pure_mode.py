"""
Tests for the pure ESP-IDF language mode (issue #139).

Covers the pieces that don't need the ESP-IDF toolchain: the build env
switch, the QEMU WiFi normalization for IDF-style code, the IDF wifi
detection, and the compile-job dedup key variance.

Run from the repo root:
    python -m pytest test/backend/unit/test_espidf_pure_mode.py -v
"""

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))

from app.services.espidf_compiler import ESPIDFCompiler, _QEMU_WIFI_SSID
from app.api.routes import compile as compile_module


def make_compiler(has_arduino: bool = True) -> ESPIDFCompiler:
    comp = ESPIDFCompiler.__new__(ESPIDFCompiler)
    comp.idf_path = '/opt/esp-idf'
    comp.arduino_path = '/opt/arduino-esp32' if has_arduino else ''
    comp.has_arduino = has_arduino
    # Per-compile IDF selection: _build_env picks the IDF tree and the
    # matching arduino-esp32 core, so a bare __new__ object needs the v5
    # half of that pair too. Only a v4.4 + 2.x core is declared here, which
    # keeps these tests on the legacy path and leaves the choice itself to
    # the tests that actually cover it.
    comp.idf5_path = ''
    comp.arduino5_path = ''
    comp.has_arduino5 = False
    return comp


class TestBuildEnvPureMode(unittest.TestCase):

    def setUp(self):
        self.comp = make_compiler(has_arduino=True)

    def test_arduino_mode_sets_arduino_path(self):
        env = self.comp._build_env('esp32')
        self.assertEqual(env.get('ARDUINO_ESP32_PATH'), '/opt/arduino-esp32')
        self.assertNotIn('VELXIO_PURE_SKETCH', env)

    def test_pure_mode_drops_arduino_and_flags_pure(self):
        env = self.comp._build_env('esp32', pure_idf=True)
        self.assertNotIn('ARDUINO_ESP32_PATH', env)
        self.assertEqual(env.get('VELXIO_PURE_SKETCH'), '1')

    def test_pure_mode_overrides_inherited_arduino_path(self):
        """The uvicorn process env carries ARDUINO_ESP32_PATH in Docker —
        pure mode must strip the inherited copy too, or the template CMake
        would still pick the Arduino branch."""
        os.environ['ARDUINO_ESP32_PATH'] = '/opt/arduino-esp32'
        try:
            env = self.comp._build_env('esp32', pure_idf=True)
            self.assertNotIn('ARDUINO_ESP32_PATH', env)
        finally:
            del os.environ['ARDUINO_ESP32_PATH']


class TestIdfWifiDetection(unittest.TestCase):

    def setUp(self):
        self.comp = make_compiler()

    def test_detects_esp_wifi_include(self):
        self.assertTrue(self.comp._detect_idf_wifi_usage('#include "esp_wifi.h"'))
        self.assertTrue(self.comp._detect_idf_wifi_usage('#include <esp_wifi.h>'))

    def test_detects_esp_wifi_init_call(self):
        code = 'wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();\nesp_wifi_init(&cfg);'
        self.assertTrue(self.comp._detect_idf_wifi_usage(code))

    def test_ignores_plain_gpio_project(self):
        code = '#include "driver/gpio.h"\nvoid app_main(void) {}'
        self.assertFalse(self.comp._detect_idf_wifi_usage(code))


class TestIdfWifiNormalization(unittest.TestCase):

    def setUp(self):
        self.comp = make_compiler()

    def test_define_ssid_rewritten(self):
        code = '#define WIFI_SSID "MyHomeNetwork"\n#define WIFI_PASS "hunter2"'
        out = self.comp._normalize_wifi_for_qemu_idf(code)
        self.assertIn(f'#define WIFI_SSID "{_QEMU_WIFI_SSID}"', out)
        self.assertIn('#define WIFI_PASS ""', out)

    def test_designated_initializers_rewritten(self):
        code = (
            'wifi_config_t wifi_config = {\n'
            '    .sta = {\n'
            '        .ssid = "MyHomeNetwork",\n'
            '        .password = "hunter2",\n'
            '    },\n'
            '};'
        )
        out = self.comp._normalize_wifi_for_qemu_idf(code)
        self.assertIn(f'.ssid = "{_QEMU_WIFI_SSID}"', out)
        self.assertIn('.password = ""', out)
        self.assertNotIn('MyHomeNetwork', out)
        self.assertNotIn('hunter2', out)

    def test_virtual_ssid_is_kept_in_idf_mode(self):
        code = 'wifi_config_t c = { .sta = { .ssid = "Velxio-GUEST", .password = "" } };\nesp_wifi_init(0);'
        out = self.comp._normalize_wifi_for_qemu_idf(code)
        self.assertIn('.ssid = "Velxio-GUEST"', out)

    def test_wokwi_guest_maps_to_the_simulator_guest_network(self):
        code = 'wifi_config_t c = { .sta = { .ssid = "Wokwi-GUEST", .password = "" } };\nesp_wifi_init(0);'
        out = self.comp._normalize_wifi_for_qemu_idf(code)
        self.assertIn('.ssid = "Velxio-GUEST"', out)
        self.assertNotIn('Wokwi-GUEST', out)

    def test_non_wifi_code_untouched(self):
        code = '#include "driver/gpio.h"\nvoid app_main(void) { }\n'
        self.assertEqual(self.comp._normalize_wifi_for_qemu_idf(code), code)


class WifiNormalizationArduinoTests(unittest.TestCase):
    """Arduino sketches: the simulated networks survive, home networks become the default one."""

    def setUp(self):
        self.comp = make_compiler()
        self.norm = self.comp._normalize_wifi_for_qemu

    def test_home_network_literal_becomes_the_default_network(self):
        out = self.norm('#include <WiFi.h>\nvoid setup(){ WiFi.begin("MyHomeNet", "hunter2"); }')
        self.assertIn('WiFi.begin("Espressif", "", 5)', out)

    def test_virtual_network_literal_is_kept_with_its_channel(self):
        out = self.norm('#include <WiFi.h>\nvoid setup(){ WiFi.begin("MasseyWifi", "pw"); }')
        self.assertIn('WiFi.begin("MasseyWifi", "", 10)', out)

    def test_wokwi_guest_becomes_the_simulator_guest_network(self):
        out = self.norm('#include <WiFi.h>\nvoid setup(){ WiFi.begin("Wokwi-GUEST", "", 6); }')
        self.assertIn('WiFi.begin("Velxio-GUEST", "", 6)', out)
        self.assertNotIn('Wokwi-GUEST', out)

    def test_named_ssid_keeps_the_virtual_network_and_hints_its_channel(self):
        code = ('#include <WiFi.h>\nconst char* ssid = "Velxio-GUEST";\nconst char* password = "x";\n'
                'void setup(){ WiFi.begin(ssid, password); }')
        out = self.norm(code)
        self.assertIn('const char* ssid = "Velxio-GUEST";', out)
        self.assertIn('WiFi.begin(ssid, "", 6)', out)

    def test_define_ssid_of_a_home_network_is_rewritten_and_hinted(self):
        code = ('#include <WiFi.h>\n#define WIFI_SSID "MyHomeNet"\n#define WIFI_PASS "x"\n'
                'void setup(){ WiFi.begin(WIFI_SSID, WIFI_PASS); }')
        out = self.norm(code)
        self.assertIn('#define WIFI_SSID "Espressif"', out)
        self.assertIn('WiFi.begin(WIFI_SSID, "", 5)', out)

    def test_nested_call_in_the_ssid_argument_survives(self):
        code = '#include <WiFi.h>\nString net = "Velxio-GUEST";\nvoid setup(){ WiFi.begin(net.c_str(), "pw"); }'
        out = self.norm(code)
        self.assertIn('WiFi.begin(net.c_str(), "")', out)

    def test_reconnect_without_arguments_is_untouched(self):
        code = '#include <WiFi.h>\nvoid loop(){ if (WiFi.status() != WL_CONNECTED) WiFi.begin(); }'
        self.assertEqual(self.norm(code), code)

    def test_parenthesis_inside_a_string_argument_does_not_end_the_call(self):
        code = '#include <WiFi.h>\nvoid setup(){ WiFi.begin("Cafe (2G)", "pw"); Serial.println("after"); }'
        out = self.norm(code)
        self.assertIn('WiFi.begin("Espressif", "", 5); Serial.println("after");', out)



class TestJobKeyLanguageVariance(unittest.TestCase):

    FILES = [{'name': 'main.c', 'content': 'void app_main(void) {}'}]

    def test_language_changes_key(self):
        k_arduino = compile_module._job_key(self.FILES, 'esp32:esp32:esp32')
        k_espidf = compile_module._job_key(
            self.FILES, 'esp32:esp32:esp32', language='espidf',
        )
        self.assertNotEqual(k_arduino, k_espidf)

    def test_explicit_arduino_keeps_historical_key(self):
        """language='arduino' and language=None must hash identically so
        pre-feature clients keep dedupping against new-client submissions."""
        k_none = compile_module._job_key(self.FILES, 'esp32:esp32:esp32')
        k_arduino = compile_module._job_key(
            self.FILES, 'esp32:esp32:esp32', language='arduino',
        )
        self.assertEqual(k_none, k_arduino)

    def test_espidf_key_is_stable(self):
        k1 = compile_module._job_key(self.FILES, 'esp32:esp32:esp32', language='espidf')
        k2 = compile_module._job_key(self.FILES, 'esp32:esp32:esp32', language='espidf')
        self.assertEqual(k1, k2)


if __name__ == '__main__':
    unittest.main()


class ManagedComponentDetectionTests(unittest.TestCase):
    """The registry components a sketch's #includes must pull in.

    The template ships no idf_component.yml, so a header that lives in a
    managed component and is not on this list dies at "No such file or
    directory" — which is exactly what official Espressif board-demo code
    did for led_strip / button / knob / GT911 / esp_codec_dev.
    """

    def setUp(self) -> None:
        self.comp = make_compiler()

    def test_official_demo_components_are_declared(self) -> None:
        cases = {
            '#include "led_strip.h"': 'espressif/led_strip',
            '#include "iot_button.h"': 'espressif/button',
            '#include "iot_knob.h"': 'espressif/knob',
            '#include "esp_lcd_touch_gt911.h"': 'espressif/esp_lcd_touch_gt911',
            '#include "esp_codec_dev.h"': 'espressif/esp_codec_dev',
            '#include "esp_camera.h"': 'espressif/esp32-camera',
            '#include "esp_lcd_gc9a01.h"': 'espressif/esp_lcd_gc9a01',
            '#include "esp_lcd_st77916.h"': 'espressif/esp_lcd_st77916',
            '#include "esp_lcd_touch_cst816s.h"': 'espressif/esp_lcd_touch_cst816s',
            '#include "esp_lcd_ek79007.h"': 'espressif/esp_lcd_ek79007',
            '#include "lvgl.h"': 'lvgl/lvgl',
            '#include "esp_lvgl_port.h"': 'espressif/esp_lvgl_port',
        }
        for line, component in cases.items():
            with self.subTest(line=line):
                self.assertIn(component, self.comp._detect_managed_components(line))

    def test_angle_bracket_form_counts_too(self) -> None:
        deps = self.comp._detect_managed_components('#include <led_strip.h>')
        self.assertIn('espressif/led_strip', deps)

    def test_unrelated_source_declares_nothing(self) -> None:
        src = '#include <stdio.h>\n#include "driver/gpio.h"\nvoid app_main(void) {}'
        self.assertEqual(self.comp._detect_managed_components(src), {})

    def test_a_similarly_named_header_does_not_match(self) -> None:
        # "my_led_strip.h" is the user's own file, not the registry component.
        deps = self.comp._detect_managed_components('#include "my_led_strip.h"')
        self.assertEqual(deps, {})
