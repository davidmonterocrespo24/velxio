"""
Velxio cannot emulate this project — see NOT_SUPPORTED.md for full details.

Project: ESP8266_DHT11_Live_Graph_(MicroPython_+_Matplotlib)
Board:   esp8266
"""

import unittest
from pathlib import Path

THIS_DIR = Path(__file__).resolve().parent


class Test_ESP8266_DHT11_Live_Graph_MicroPython_plus_Matplotlib_NotSupported(unittest.TestCase):

    def test_not_supported_marker_present(self):
        marker = THIS_DIR / "NOT_SUPPORTED.md"
        self.assertTrue(marker.is_file(), "NOT_SUPPORTED.md is missing")

    def test_source_was_preserved(self):
        src_dir = THIS_DIR / "source"
        # Some upstream projects ship only README/LICENSE — there is literally
        # nothing to copy. In that case NOT_SUPPORTED.md is the whole record.
        upstream_had_code = True
        if not upstream_had_code:
            self.skipTest("upstream project has no source code")
        src = [s for s in src_dir.rglob("*") if s.is_file()]
        self.assertTrue(src, "no source files copied — generator likely broken")

    @unittest.skip("Project not supported by Velxio: esp8266: ESP8266 has no QEMU/firmware path in Velxio.")
    def test_velxio_emulation(self):
        self.fail("unreachable — see NOT_SUPPORTED.md")


if __name__ == "__main__":
    unittest.main(verbosity=2)
