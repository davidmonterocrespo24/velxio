"""The SSID rewrite reads every file of the project and follows the name
WiFi.begin() is given (velxio/velxio-prod#191).

The radios broadcast a fixed set of open networks, so the build swaps a
sketch's home SSID for one of them. It used to look at the .ino tabs only,
and only at a char variable named exactly `ssid` or a #define with SSID in its
name. The pattern the book recommends, and Arduino's own examples use, keeps
the credentials in a header:

    // secrets.h
    #define SECRET_SSID "MyHome"
    #define SECRET_PASS "hunter2"

That header reached the build untouched; WiFi.begin(SECRET_SSID, "") then
hunted for "MyHome", which no radio beacons, and the board never joined.
`const char* WIFI_SSID`, `char ssid[32]`, a String and WiFiMulti.addAP()
kept the home network the same way.

These drive the real _compile_in_dir with cmake and ninja faked and read the
files the build wrote into main/.
"""
import asyncio
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'backend'))

from app.services import espidf_compiler as ec  # noqa: E402


def _fake_toolchain(cmd, cwd=None, env=None, timeout=None, progress_callback=None, nice=None):
    build = Path(cwd)
    if Path(cmd[0]).name == 'cmake':
        (build / 'CMakeCache.txt').write_text('cache', encoding='utf-8')
        (build / 'build.ninja').write_text('rules', encoding='utf-8')
        return ec._RunResult(0, '-- Configuring done', '')
    return ec._RunResult(1, 'FAILED: user code\n', '')


class _Build(unittest.TestCase):
    """Compile `files` in Arduino mode; self.main is the project's main/."""

    def build(self, files: list[dict], custom_wifi_ssids: list[str] | None = None) -> None:
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        root = Path(td.name)
        project = root / 'p' / 'project'
        shutil.copytree(ec._TEMPLATE_DIR, project)
        (project / 'build').mkdir()
        (root / 'libs').mkdir()
        self.lines: list[str] = []
        with mock.patch.object(ec, '_run_with_streaming', side_effect=_fake_toolchain):
            asyncio.run(ec.ESPIDFCompiler()._compile_in_dir(
                project, files, 'esp32', progress_callback=self.lines.append,
                arduino_mode=True, use_idf5=True, libraries_dir=root / 'libs',
                custom_wifi_ssids=custom_wifi_ssids,
            ))
        self.main = project / 'main'

    def text(self, name: str) -> str:
        return (self.main / name).read_text(encoding='utf-8')

    def notes(self) -> list[str]:
        return [ln for ln in self.lines if 'not part of the emulated network' in ln]


SKETCH_WITH_SECRETS = (
    '#include <WiFi.h>\n'
    '#include "secrets.h"\n'
    'void setup(){ Serial.begin(115200); WiFi.begin(SECRET_SSID, SECRET_PASS); }\n'
    'void loop(){}\n'
)
SECRETS_H = '#define SECRET_SSID "MyHome"\n#define SECRET_PASS "hunter2"\n'


class ASecretsHeader(_Build):

    def test_the_header_the_book_recommends(self):
        self.build([
            {'name': 'sketch.ino', 'content': SKETCH_WITH_SECRETS},
            {'name': 'secrets.h', 'content': SECRETS_H},
        ])
        self.assertIn('#define SECRET_SSID "Velxio-GUEST"', self.text('secrets.h'))
        self.assertNotIn('MyHome', self.text('secrets.h'))
        # The password goes at the call (the networks are open), and the
        # channel hint follows the name to the network it now names.
        self.assertIn('WiFi.begin(SECRET_SSID, "", 6)', self.text('sketch.ino.cpp'))
        self.assertEqual(len(self.notes()), 1)
        self.assertIn('"MyHome"', self.notes()[0])

    def test_arduinos_own_form_through_a_char_array(self):
        """WiFiNINA's examples: char ssid[] = SECRET_SSID; WiFi.begin(ssid, pass)."""
        self.build([
            {'name': 'sketch.ino', 'content': (
                '#include <WiFi.h>\n#include "arduino_secrets.h"\n'
                'char ssid[] = SECRET_SSID;\nchar pass[] = SECRET_PASS;\n'
                'void setup(){ WiFi.begin(ssid, pass); }\nvoid loop(){}\n'
            )},
            {'name': 'arduino_secrets.h', 'content': SECRETS_H},
        ])
        self.assertIn('#define SECRET_SSID "Velxio-GUEST"', self.text('arduino_secrets.h'))
        self.assertIn('WiFi.begin(ssid, "", 6)', self.text('sketch.ino.cpp'))

    def test_a_simulated_network_in_the_header_is_kept(self):
        self.build([
            {'name': 'sketch.ino', 'content': SKETCH_WITH_SECRETS},
            {'name': 'secrets.h', 'content': '#define SECRET_SSID "MasseyWifi"\n#define SECRET_PASS ""\n'},
        ])
        self.assertIn('#define SECRET_SSID "MasseyWifi"', self.text('secrets.h'))
        self.assertIn('WiFi.begin(SECRET_SSID, "", 10)', self.text('sketch.ino.cpp'))
        self.assertEqual(self.notes(), [])

    def test_a_cpp_file_that_joins_the_network(self):
        self.build([
            {'name': 'sketch.ino', 'content': '#include "net.h"\nvoid setup(){ net_start(); }\nvoid loop(){}\n'},
            {'name': 'net.h', 'content': 'void net_start();\n'},
            {'name': 'net.cpp', 'content': (
                '#include <WiFi.h>\n#include "net.h"\n'
                'void net_start(){ WiFi.begin("MyHome", "hunter2"); }\n'
            )},
        ])
        self.assertIn('WiFi.begin("Velxio-GUEST", "", 6)', self.text('net.cpp'))

    def test_a_project_with_its_own_access_points_is_left_alone(self):
        self.build([
            {'name': 'sketch.ino', 'content': SKETCH_WITH_SECRETS},
            {'name': 'secrets.h', 'content': SECRETS_H},
        ], custom_wifi_ssids=['MyHome'])
        self.assertEqual(self.text('secrets.h'), SECRETS_H)
        self.assertEqual(self.notes(), [])


class TheNameWiFiBeginIsGiven(_Build):

    def _sketch(self, decl: str, begin: str) -> str:
        return (f'#include <WiFi.h>\n{decl}\nconst char* WIFI_PASS = "hunter2";\n'
                f'void setup(){{ {begin}; }}\nvoid loop(){{}}\n')

    def test_a_pointer_named_wifi_ssid(self):
        self.build([{'name': 'sketch.ino', 'content': self._sketch(
            'const char* WIFI_SSID = "MyHome";', 'WiFi.begin(WIFI_SSID, WIFI_PASS)')}])
        out = self.text('sketch.ino.cpp')
        self.assertIn('const char* WIFI_SSID = "Velxio-GUEST";', out)
        self.assertIn('WiFi.begin(WIFI_SSID, "", 6)', out)

    def test_a_sized_char_array(self):
        self.build([{'name': 'sketch.ino', 'content': self._sketch(
            'char ssid[32] = "MyHome";', 'WiFi.begin(ssid, WIFI_PASS)')}])
        self.assertIn('char ssid[32] = "Velxio-GUEST";', self.text('sketch.ino.cpp'))

    def test_a_string_passed_through_c_str(self):
        self.build([{'name': 'sketch.ino', 'content': self._sketch(
            'String network = "MyHome";', 'WiFi.begin(network.c_str(), WIFI_PASS)')}])
        out = self.text('sketch.ino.cpp')
        self.assertIn('String network = "Velxio-GUEST";', out)
        self.assertIn('WiFi.begin(network.c_str(), "", 6)', out)

    def test_a_static_constexpr_declaration(self):
        self.build([{'name': 'sketch.ino', 'content': self._sketch(
            'static constexpr char kNet[] = "MyHome";', 'WiFi.begin(kNet, WIFI_PASS)')}])
        self.assertIn('static constexpr char kNet[] = "Velxio-GUEST";', self.text('sketch.ino.cpp'))

    def test_an_assignment_in_setup(self):
        self.build([{'name': 'sketch.ino', 'content': (
            '#include <WiFi.h>\nconst char* net;\n'
            'void setup(){ net = "MyHome"; WiFi.begin(net, "pw"); }\nvoid loop(){}\n'
        )}])
        self.assertIn('net = "Velxio-GUEST";', self.text('sketch.ino.cpp'))

    def test_a_comparison_is_not_an_assignment(self):
        self.build([{'name': 'sketch.ino', 'content': (
            '#include <WiFi.h>\nString net = "Velxio-GUEST";\n'
            'void setup(){ WiFi.begin(net.c_str()); if (net == "MyHome") Serial.println("home"); }\n'
            'void loop(){}\n'
        )}])
        self.assertIn('if (net == "MyHome")', self.text('sketch.ino.cpp'))

    def test_an_access_points_own_name_is_not_touched(self):
        """WiFi.softAP() names the network the board creates: not ours to swap."""
        self.build([{'name': 'sketch.ino', 'content': (
            '#include <WiFi.h>\nconst char* ap_ssid = "MyESP32AP";\n'
            'const char* sta_ssid = "MyHome";\n'
            'void setup(){ WiFi.softAP(ap_ssid, "12345678"); WiFi.begin(sta_ssid, "pw"); }\n'
            'void loop(){}\n'
        )}])
        out = self.text('sketch.ino.cpp')
        self.assertIn('const char* ap_ssid = "MyESP32AP";', out)
        self.assertIn('const char* sta_ssid = "Velxio-GUEST";', out)


class WiFiMulti(_Build):

    def test_add_ap_joins_a_network_on_the_air(self):
        self.build([{'name': 'sketch.ino', 'content': (
            '#include <WiFi.h>\n#include <WiFiMulti.h>\nWiFiMulti wifiMulti;\n'
            'void setup(){ wifiMulti.addAP("MyHome", "hunter2"); wifiMulti.addAP("MasseyWifi", "x"); }\n'
            'void loop(){ wifiMulti.run(); }\n'
        )}])
        out = self.text('sketch.ino.cpp')
        self.assertIn('wifiMulti.addAP("Velxio-GUEST", "")', out)
        self.assertIn('wifiMulti.addAP("MasseyWifi", "")', out)
        self.assertNotIn('hunter2', out)

    def test_add_ap_follows_its_name_too(self):
        self.build([
            {'name': 'sketch.ino', 'content': (
                '#include <WiFiMulti.h>\n#include "secrets.h"\nWiFiMulti multi;\n'
                'void setup(){ multi.addAP(SECRET_SSID, SECRET_PASS); }\nvoid loop(){ multi.run(); }\n'
            )},
            {'name': 'secrets.h', 'content': SECRETS_H},
        ])
        self.assertIn('#define SECRET_SSID "Velxio-GUEST"', self.text('secrets.h'))
        self.assertIn('multi.addAP(SECRET_SSID, "")', self.text('sketch.ino.cpp'))



class TheBoardsOwnAccessPoint(_Build):
    """WiFi.softAP(NAME) names the network the board creates. That name is the
    sketch's to choose: it is no network to join, and the compile log must not
    say it was swapped for one."""

    def test_arduinos_access_point_example(self):
        """arduino-esp32's WiFiAccessPoint example: `const char *ssid = "yourAP";`."""
        sketch = ('#include <WiFi.h>\nconst char *ssid = "yourAP";\nconst char *password = "yourPassword";\n'
                  'void setup(){ WiFi.softAP(ssid, password); }\nvoid loop(){}\n')
        self.build([{'name': 'sketch.ino', 'content': sketch}])
        self.assertIn('const char *ssid = "yourAP";', self.text('sketch.ino.cpp'))
        self.assertEqual(self.notes(), [])

    def test_an_access_point_named_in_a_header(self):
        self.build([
            {'name': 'sketch.ino', 'content': (
                '#include <WiFi.h>\n#include "config.h"\n'
                'void setup(){ WiFi.softAP(AP_SSID, AP_PASS); }\nvoid loop(){}\n'
            )},
            {'name': 'config.h', 'content': '#define AP_SSID "Workshop"\n#define AP_PASS "12345678"\n'},
        ])
        self.assertIn('#define AP_SSID "Workshop"', self.text('config.h'))
        self.assertEqual(self.notes(), [])

    def test_a_board_that_is_both_keeps_its_own_network_and_joins_ours(self):
        self.build([
            {'name': 'sketch.ino', 'content': (
                '#include <WiFi.h>\n#include "config.h"\n'
                'void setup(){ WiFi.mode(WIFI_AP_STA); WiFi.softAP(AP_SSID); WiFi.begin(STA_SSID, STA_PASS); }\n'
                'void loop(){}\n'
            )},
            {'name': 'config.h', 'content': (
                '#define AP_SSID "Workshop"\n#define STA_SSID "MyHome"\n#define STA_PASS "hunter2"\n'
            )},
        ])
        config = self.text('config.h')
        self.assertIn('#define AP_SSID "Workshop"', config)
        self.assertIn('#define STA_SSID "Velxio-GUEST"', config)
        self.assertIn('WiFi.begin(STA_SSID, "", 6)', self.text('sketch.ino.cpp'))
        self.assertEqual(len(self.notes()), 1)
        self.assertIn('"MyHome"', self.notes()[0])


class TheChannelHint(_Build):

    def test_a_name_that_names_two_networks_gets_no_hint(self):
        """A hint scans one channel only: the wrong one would hide the network."""
        self.build([{'name': 'sketch.ino', 'content': (
            '#include <WiFi.h>\nconst char* net = "MasseyWifi";\n'
            'void setup(){ if (digitalRead(4)) net = "PICSimLabWifi"; WiFi.begin(net, "pw"); }\n'
            'void loop(){}\n'
        )}])
        out = self.text('sketch.ino.cpp')
        self.assertIn('WiFi.begin(net, "")', out)
        self.assertEqual(self.notes(), [])

    def test_a_name_defined_from_another_in_a_header(self):
        self.build([
            {'name': 'sketch.ino', 'content': (
                '#include <WiFi.h>\n#include "net.h"\n'
                'void setup(){ WiFi.begin(MY_NET, ""); }\nvoid loop(){}\n'
            )},
            {'name': 'net.h', 'content': '#define HOME_NETWORK "MasseyWifi"\n#define MY_NET HOME_NETWORK\n'},
        ])
        self.assertIn('WiFi.begin(MY_NET, "", 10)', self.text('sketch.ino.cpp'))


class WiFiDetection(unittest.TestCase):

    def test_wifimulti_alone_is_a_wifi_sketch(self):
        """WiFiMulti.h includes WiFi.h. Judged WiFi-less, the QEMU worker would
        leave the radio out and the firmware would fault at its first touch of
        the MAC (issue #260)."""
        comp = ec.ESPIDFCompiler.__new__(ec.ESPIDFCompiler)
        self.assertTrue(comp._detect_wifi_usage('#include <WiFiMulti.h>\nWiFiMulti m;\n'))
        self.assertFalse(comp._detect_wifi_usage('#include <Wire.h>\nvoid setup(){}\n'))


if __name__ == '__main__':
    unittest.main()
