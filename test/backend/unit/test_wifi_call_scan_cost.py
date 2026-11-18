"""The SSID rewrite's call scan reads each character a bounded number of
times, however the calls are nested or left open (velxio/velxio-prod#191, the
review of its fix-up).

The rewrite runs before every Arduino build on the backend's only event loop.
_call_args, which collects the arguments of every WiFi.begin(), addAP() and
WiFi.softAP() call, ran _matching_paren from every match: it scanned again
the calls nested inside another's arguments, and it did not stop at a call
that never closes, so a crafted sketch made it quadratic. 48 KB of unclosed
`WiFi.begin(` took 17 s of the event loop (0.012 s before #191), 26 KB of
unclosed `WiFi.softAP(` 5 s, and 2,000 nested calls 10 s. It now reads the
calls the way _rewrite_calls does.

This counts the characters _matching_paren reads, so it does not depend on
the machine.
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'backend'))

from app.services import espidf_compiler as ec  # noqa: E402

N = 5000
SHAPES = {
    'unclosed WiFi.begin(': '#include <WiFi.h>\n' + 'WiFi.begin(\n' * N,
    'nested WiFi.begin(': '#include <WiFi.h>\nvoid setup(){' + 'WiFi.begin(' * N + 'x' + ')' * N + ';}\n',
    'unclosed WiFi.softAP(': '#include <WiFi.h>\nvoid setup(){WiFi.begin("a");}\n' + 'WiFi.softAP(\n' * N,
}


class TheCallScan(unittest.TestCase):

    def test_each_character_is_scanned_a_bounded_number_of_times(self):
        for shape, src in SHAPES.items():
            with self.subTest(shape=shape):
                scanned = 0
                real = ec._matching_paren

                def counting(code, open_idx):
                    nonlocal scanned
                    close = real(code, open_idx)
                    scanned += (len(code) if close < 0 else close + 1) - open_idx
                    if scanned > 4 * len(src):
                        raise AssertionError(
                            f'{shape}: the call scan read {scanned} characters of a {len(src)}-character source'
                        )
                    return close

                comp = ec.ESPIDFCompiler.__new__(ec.ESPIDFCompiler)
                with mock.patch.object(ec, '_matching_paren', side_effect=counting):
                    comp._normalize_wifi_sources([src], [])

    def test_the_calls_a_sketch_makes_are_still_all_read(self):
        code = (
            'WiFi.begin("Home", "pw");\n'
            'WiFi.begin(ssid, pass);\n'
            'if (x) WiFi.begin(net.c_str());\n'
        )
        self.assertEqual(
            ec._call_args(code, r'\bWiFi\s*\.\s*begin'),
            ['"Home", "pw"', 'ssid, pass', 'net.c_str()'],
        )


if __name__ == '__main__':
    unittest.main()
