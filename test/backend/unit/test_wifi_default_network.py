"""The network a sketch's unknown SSID becomes is the one every text names
(velxio/velxio-prod#177).

The simulated radios (the QEMU fork and the in-browser engines) beacon four
open networks. A sketch that names one of them keeps it; any other SSID (the
author's home network) is rewritten on the way to the emulator. That default
used to be "Espressif" on channel 5, while the MicroPython shim, the IoT
gateway's help, the gallery and the docs all name Velxio-GUEST: a C++ sketch
written for the home network printed "Connecting to Espressif", and nothing
said why. The rewrite also went unreported: only the backend log saw it.

Now the default is Velxio-GUEST on channel 6 for every language, and the
compile log says when the build swapped an SSID, as the MicroPython shim does
on the serial monitor.
"""
import asyncio
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'backend'))

from app.services import espidf_compiler as ec  # noqa: E402


def _compiler() -> ec.ESPIDFCompiler:
    return ec.ESPIDFCompiler.__new__(ec.ESPIDFCompiler)  # no toolchain needed


def _fake_toolchain(cmd, cwd=None, env=None, timeout=None, progress_callback=None, nice=None):
    """cmake configures, ninja fails on the user's code: the compile stops
    right after the build step, with every file it wrote still in main/."""
    build = Path(cwd)
    if Path(cmd[0]).name == 'cmake':
        (build / 'CMakeCache.txt').write_text('cache', encoding='utf-8')
        (build / 'build.ninja').write_text('rules', encoding='utf-8')
        return ec._RunResult(0, '-- Configuring done', '')
    return ec._RunResult(1, 'FAILED: user code\n', '')


def _build(files: list[dict], *, pure_idf: bool = False) -> tuple[Path, list[str], tempfile.TemporaryDirectory]:
    """Run the real _compile_in_dir on `files` with the toolchain faked.
    Returns the project's main/ dir, the progress lines, and the temp dir."""
    td = tempfile.TemporaryDirectory()
    root = Path(td.name)
    project = root / 'p' / 'project'
    shutil.copytree(ec._TEMPLATE_DIR, project)
    (project / 'build').mkdir()
    (root / 'libs').mkdir()
    lines: list[str] = []
    with mock.patch.object(ec, '_run_with_streaming', side_effect=_fake_toolchain):
        asyncio.run(ec.ESPIDFCompiler()._compile_in_dir(
            project, files, 'esp32',
            progress_callback=lines.append,
            arduino_mode=not pure_idf, use_idf5=True, pure_idf=pure_idf,
            libraries_dir=root / 'libs',
        ))
    return project / 'main', lines, td


class TheDefaultNetwork(unittest.TestCase):

    def test_an_unknown_ssid_becomes_velxio_guest_on_its_channel(self):
        self.assertEqual(ec._virtual_ssid('MyHomeNet'), ('Velxio-GUEST', 6))

    def test_the_default_is_a_network_every_radio_beacons(self):
        self.assertIn(ec._QEMU_WIFI_SSID, ec._VIRTUAL_WIFI_NETWORKS)
        self.assertEqual(ec._VIRTUAL_WIFI_NETWORKS[ec._QEMU_WIFI_SSID], ec._QEMU_WIFI_CHANNEL)

    def test_cpp_builds_and_the_micropython_shim_fall_back_to_the_same_network(self):
        """The shim redirects an unknown SSID to EMULATED_WIFI_SSIDS[0]."""
        board_ts = (REPO / 'frontend/src/types/board.ts').read_text(encoding='utf-8')
        listed = re.search(r'EMULATED_WIFI_SSIDS\s*=\s*\[\s*\'([^\']+)\'', board_ts)
        self.assertIsNotNone(listed)
        self.assertEqual(ec._QEMU_WIFI_SSID, listed.group(1))

    def test_a_home_network_in_wifi_begin(self):
        out = _compiler()._normalize_wifi_for_qemu(
            '#include <WiFi.h>\nvoid setup(){ WiFi.begin("MyHomeNet", "hunter2"); }')
        self.assertIn('WiFi.begin("Velxio-GUEST", "", 6)', out)
        self.assertNotIn('MyHomeNet', out)

    def test_a_home_network_in_a_pure_idf_project(self):
        out = _compiler()._normalize_wifi_for_qemu_idf('#define WIFI_SSID "MyHomeNet"\n')
        self.assertIn('#define WIFI_SSID "Velxio-GUEST"', out)


class TheCompileLogSaysSo(unittest.TestCase):

    def _notes(self, lines: list[str]) -> list[str]:
        return [ln for ln in lines if 'not part of the emulated network' in ln]

    def test_a_rewritten_ssid_is_reported_in_the_compile_log(self):
        main, lines, td = _build([{'name': 'sketch.ino', 'content': (
            '#include <WiFi.h>\n'
            'void setup(){ Serial.begin(115200); WiFi.begin("MyHomeNet", "hunter2"); }\n'
            'void loop(){}\n'
        )}])
        self.addCleanup(td.cleanup)
        self.assertIn('WiFi.begin("Velxio-GUEST", "", 6)',
                      (main / 'sketch.ino.cpp').read_text(encoding='utf-8'))
        self.assertEqual(self._notes(lines), [
            '[velxio] SSID "MyHomeNet" is not part of the emulated network; '
            'this build connects to "Velxio-GUEST" instead (open, no password)\n',
        ])

    def test_a_simulated_network_needs_no_note(self):
        _, lines, td = _build([{'name': 'sketch.ino', 'content': (
            '#include <WiFi.h>\nvoid setup(){ WiFi.begin("MasseyWifi", "pw"); }\nvoid loop(){}\n'
        )}])
        self.addCleanup(td.cleanup)
        self.assertEqual(self._notes(lines), [])

    def test_wokwi_guest_is_an_alias_not_a_rewrite(self):
        _, lines, td = _build([{'name': 'sketch.ino', 'content': (
            '#include <WiFi.h>\nvoid setup(){ WiFi.begin("Wokwi-GUEST", "", 6); }\nvoid loop(){}\n'
        )}])
        self.addCleanup(td.cleanup)
        self.assertEqual(self._notes(lines), [])

    def test_each_ssid_is_named_once(self):
        _, lines, td = _build([{'name': 'sketch.ino', 'content': (
            '#include <WiFi.h>\nconst char* ssid = "Cafe";\n'
            'void setup(){ WiFi.begin(ssid, "x"); WiFi.begin("Cafe"); WiFi.begin("Office", "y"); }\n'
            'void loop(){}\n'
        )}])
        self.addCleanup(td.cleanup)
        self.assertEqual(self._notes(lines), [
            '[velxio] SSID "Cafe" is not part of the emulated network; '
            'this build connects to "Velxio-GUEST" instead (open, no password)\n',
            '[velxio] SSID "Office" is not part of the emulated network; '
            'this build connects to "Velxio-GUEST" instead (open, no password)\n',
        ])

    def test_a_pure_idf_project_is_reported_too(self):
        main, lines, td = _build([{'name': 'main.c', 'content': (
            '#include "esp_wifi.h"\n#define WIFI_SSID "MyHomeNet"\n#define WIFI_PASS "x"\n'
            'void app_main(void) { esp_wifi_init(0); }\n'
        )}], pure_idf=True)
        self.addCleanup(td.cleanup)
        self.assertIn('#define WIFI_SSID "Velxio-GUEST"', (main / 'main.c').read_text(encoding='utf-8'))
        self.assertEqual(len(self._notes(lines)), 1)
        self.assertIn('"MyHomeNet"', self._notes(lines)[0])


if __name__ == '__main__':
    unittest.main()
