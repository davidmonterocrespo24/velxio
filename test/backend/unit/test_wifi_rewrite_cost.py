"""The SSID rewrite costs time linear in the project's size
(velxio/velxio-prod#191, the review of its follow-up).

The rewrite runs before every Arduino build on the backend's only event loop:
while it runs, no other request is served. #191 made it read every file of the
project and follow the names WiFi.begin() is given, and its follow-up checked
each match against a copy of the source with comments and strings blanked.
That copy was made again for every source and every followed name, and making
it was quadratic (it copied the rest of the source at every line start to see
whether the line was a directive). On the production corpus the worst project
(2.5 MB in 11 files) took 15 s; before #191 the rewrite took 0.1 s at most.

These count what the slow parts did, so they do not depend on the machine:
the characters _blank_noncode copies, and the characters handed to it during
a rewrite. A time bound with a wide margin covers the rest.
"""
import random
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'backend'))

from app.services import espidf_compiler as ec  # noqa: E402


class _CountedSource(str):
    """A source that counts the characters indexing and slicing copy out of it."""

    def __getitem__(self, key):
        part = str.__getitem__(self, key)
        self.copied += len(part)
        return part


def _counted(text: str) -> _CountedSource:
    source = _CountedSource(text)
    source.copied = 0
    return source


def _old_blank_noncode(source: str) -> str:
    """_blank_noncode before this fix, the output the new one must keep. Only
    its directive test is written by index here: the original copied the rest
    of the source for it (source[i:].lstrip(' \\t')[:1] == '#')."""
    out = list(source)
    i, n = 0, len(source)
    line_start = True
    while i < n:
        c = source[i]
        j = i
        while line_start and j < n and source[j] in ' \t':
            j += 1
        if line_start and j < n and source[j] == '#':
            while i < n:
                if source[i] == '\n' and source[i - 1] != '\\':
                    break
                if source[i] != '\n':
                    out[i] = ' '
                i += 1
            line_start = True
            i += 1
            continue
        line_start = c == '\n'
        if c == '/' and i + 1 < n and source[i + 1] == '/':
            while i < n and source[i] != '\n':
                out[i] = ' '
                i += 1
            continue
        if c == '/' and i + 1 < n and source[i + 1] == '*':
            out[i] = out[i + 1] = ' '
            i += 2
            while i < n and not (source[i] == '*' and i + 1 < n and source[i + 1] == '/'):
                if source[i] != '\n':
                    out[i] = ' '
                i += 1
            if i < n:
                out[i] = out[i + 1] = ' '
                i += 2
            continue
        if c in ('"', "'"):
            quote = c
            i += 1
            while i < n and source[i] != quote:
                if source[i] == '\\':
                    out[i] = ' '
                    i += 1
                    if i < n and source[i] != '\n':
                        out[i] = ' '
                    i += 1
                    continue
                if source[i] != '\n':
                    out[i] = ' '
                i += 1
            i += 1
            continue
        i += 1
    return ''.join(out)


SKETCH_LINES = (
    '#include <WiFi.h>\n'
    '  #define LED 2 // indented directive \\\n'
    '    continued\n'
    'const char* ssid = "My\\"Home"; // a comment with "quotes" and \'ticks\'\n'
    'char c = \'"\'; int a = 6 / 3; /* block\n'
    ' * comment */ int b = a * 2;\n'
    'void setup(){ Serial.println("#not a directive"); }\n'
)


class TheBlankedCopy(unittest.TestCase):

    def test_blanking_copies_each_character_a_bounded_number_of_times(self):
        """4,000 lines of a sketch: the old scan copied the rest of the source
        at each of them, 214 MB for these 150 KB."""
        source = _counted(SKETCH_LINES * 572)
        blank = ec._blank_noncode(source)
        self.assertEqual(len(blank), len(source))
        self.assertLessEqual(
            source.copied, 3 * len(source),
            f'_blank_noncode copied {source.copied} characters out of a {len(source)}-character source',
        )

    def test_the_blanked_copy_is_what_it_was(self):
        """The same output as before, character for character: the cases the
        scan treats specially, and random text made of the characters it
        stops at."""
        cases = [
            '', '#', '\n#', 'a\n  \t#x\\\ny\nz', '#a\\\r\nb\nc', 'x # y\n# z',
            '"abc', "'", '"a\\', '"a\\"b" c', '/', '/*', '/* x *', '/*/ */ a', '//', '// x\n#y',
            'a /* b */ #c\n#d', '"x\ny" #z\n#w', "'\\n' '#'", SKETCH_LINES,
        ]
        rng = random.Random(191)
        alphabet = '/*"\'\\\n# \tax\r('
        cases += [''.join(rng.choice(alphabet) for _ in range(rng.randint(1, 40))) for _ in range(3000)]
        for text in cases:
            self.assertEqual(ec._blank_noncode(text), _old_blank_noncode(text), repr(text))


def _image_header(index: int, rows: int) -> str:
    """A header of picture data, as the large projects of the corpus carry."""
    data = ',\n'.join(
        '  ' + ', '.join(f'0x{(index * 31 + row * 7 + col) & 0xFF:02X}' for col in range(12))
        for row in range(rows)
    )
    return (f'// image {index}: 96x{rows} pixels\n#pragma once\n#include <Arduino.h>\n'
            f'const unsigned char image_{index}[] PROGMEM = {{\n{data}\n}};\n')


class ALargeProject(unittest.TestCase):
    """Ten 150 KB headers of picture data and a sketch that joins one of 200
    networks, each by its own name: 1.5 MB that follow 200 names."""

    NAMES = 200

    def setUp(self):
        self.headers = [_image_header(i, 2000) for i in range(10)]
        self.sketch = (
            '#include <WiFi.h>\n'
            + ''.join(f'#include "image_{i}.h"\n' for i in range(10))
            + ''.join(f'const char* net_{k} = "Home{k}";\n' for k in range(self.NAMES))
            + 'int choice = 0;\nvoid setup(){\n'
            + ''.join(f'  if (choice == {k}) WiFi.begin(net_{k}, "pw{k}");\n' for k in range(self.NAMES))
            + '}\nvoid loop(){}\n'
        )
        self.sources = [self.sketch] + self.headers
        self.size = sum(len(s) for s in self.sources)

    def test_each_source_is_blanked_at_most_twice(self):
        """The rewrite blanks a source to tell code from text, once, and once
        more if the two forms it always rewrites changed it. It used to blank
        every source again for every name it followed."""
        handed = 0
        blank = ec._blank_noncode

        def counting(source: str) -> str:
            nonlocal handed
            handed += len(source)
            if handed > 2 * self.size:
                raise AssertionError(
                    f'_blank_noncode was handed {handed} characters for a {self.size}-character project')
            return blank(source)

        comp = ec.ESPIDFCompiler.__new__(ec.ESPIDFCompiler)
        replaced: list[str] = []
        with mock.patch.object(ec, '_blank_noncode', side_effect=counting):
            out = comp._normalize_wifi_sources(self.sources, replaced)
        self.assertEqual(out[1:], self.headers)
        self.assertIn('const char* net_7 = "Velxio-GUEST";', out[0])
        self.assertIn('WiFi.begin(net_7, "", 6)', out[0])
        self.assertEqual(sorted(replaced), sorted(f'Home{k}' for k in range(self.NAMES)))

    def test_the_rewrite_stays_under_a_wide_time_bound(self):
        """CPU time, with a wide margin (this takes some 0.1 s): not a
        benchmark, but any part that grew with the number of names times the
        size would cross it."""
        comp = ec.ESPIDFCompiler.__new__(ec.ESPIDFCompiler)
        start = time.process_time()
        out = comp._normalize_wifi_sources(self.sources, [])
        spent = time.process_time() - start
        self.assertIn('WiFi.begin(net_199, "", 6)', out[0])
        self.assertLess(spent, 10.0, f'the rewrite of a {self.size}-character project took {spent:.1f} s')


if __name__ == '__main__':
    unittest.main()
