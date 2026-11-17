"""File names a client sends must stay inside the build dir (2026-09-15), and
must not hold a character a build reads as syntax (velxio/velxio-prod#223).

The ESP-IDF Arduino-mode writer and the SPIFFS writer joined the raw name
under a shared build dir as root; the API now refuses '..', absolute paths and
NUL bytes for every lane, while folder prefixes keep working.

arduino-cli puts a sketch source into a recipe's quoted "{source_file}": a
double quote closes it, and a {property} reference in the name is expanded
before the recipe is split. The ESP-IDF build globs the sketch's sources into
a CMake list, where ';' separates elements, and '$' and a backslash are CMake
syntax too. So a double quote, '{', '}', '$', ';', a backslash, a control
character and U+0085/U+2028/U+2029 are refused in a sketch or SPIFFS file
name, the set the hosted product's compile guard refuses. A single quote,
spaces, parentheses, brackets, '&', '@' and '+' keep working.

Run from the repo root:
    python -m pytest test/backend/unit/test_compile_file_names.py -v
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))

from pydantic import ValidationError  # noqa: E402

from app.api.routes.compile import CompileRequest, SketchFile, SpiffsFileBody  # noqa: E402


class FileNameValidationTests(unittest.TestCase):
    def test_plain_names_and_folder_prefixes_are_accepted(self):
        for name in ('sketch.ino', 'main.cpp', 'src/helper.cpp', 'data/config.json'):
            self.assertEqual(SketchFile(name=name, content='').name, name)
            self.assertEqual(SpiffsFileBody(name=name, content_b64='').name, name)

    def test_names_that_leave_the_build_dir_are_refused(self):
        for bad in ('../x.cpp', 'a/../../x.h', '/etc/passwd', '\\\\server\\x', 'C:\\x.cpp', 'a\x00b', '..\\x.h'):
            with self.assertRaises(ValidationError, msg=bad):
                SketchFile(name=bad, content='')
            with self.assertRaises(ValidationError, msg=bad):
                SpiffsFileBody(name=bad, content_b64='')


# Every character refused because a build reads it as syntax, by a label the
# subtest lines show (written as escapes: no invisible character in source).
SYNTAX_CHARACTERS = {
    'double quote': '"',
    'opening brace': '{',
    'closing brace': '}',
    'dollar sign': '$',
    'semicolon': ';',
    'backslash': '\\',
    'U+0001': '\x01',
    'tab': '\t',
    'line feed': '\n',
    'vertical tab': '\x0b',
    'form feed': '\x0c',
    'carriage return': '\r',
    'escape': '\x1b',
    'U+001F': '\x1f',
    'delete': '\x7f',
    'next line U+0085': '\u0085',
    'line separator U+2028': '\u2028',
    'paragraph separator U+2029': '\u2029',
}

# Shaped like the names the #223 reviews built against the library checks: a
# {property} reference arduino-cli expands (in a file and in a folder name), a
# quote that closes "{source_file}", a CMake list separator, CMake expansions,
# and a backslash between folder and file.
SYNTAX_NAME_SHAPES = (
    'p{build.mcu}q.cpp',
    'A{includes}B.c',
    'src/{build.path}/x.cpp',
    'x" "-DX.cpp',
    'a;INCLUDE_DIRS;b.cpp',
    'c$ENV{HOME}.cpp',
    'd${CMAKE_COMMAND}.cpp',
    'src\\helper.cpp',
)

# Names people use that must keep compiling (and keep their SPIFFS files).
EVERYDAY_NAMES = (
    "it's.h",
    "Don't panic/notes.txt",
    'my sketch.ino',
    'helper (copy).cpp',
    'data[1].txt',
    'R&D.h',
    'user@host.txt',
    'a+b.cpp',
    'c++/vector.hpp',
    'src/My Lib (v2)/x.cpp',
    '#notes.txt',
    'a,b=c%d!e~f.txt',
    'caf\u00e9.h',
    '\u6570\u7801\u7ba1.ino',
)

MODELS = (
    ('SketchFile', lambda name: SketchFile(name=name, content='')),
    ('SpiffsFileBody', lambda name: SpiffsFileBody(name=name, content_b64='')),
)


class FileNameSyntaxTests(unittest.TestCase):
    """velxio/velxio-prod#223: a self-host has no compile guard in front of
    the route, so the request check is what keeps these out of a build."""

    def test_a_syntax_character_in_a_file_name_is_refused(self):
        for label, ch in SYNTAX_CHARACTERS.items():
            for model, make in MODELS:
                name = f'a{ch}b.cpp'
                with self.subTest(character=label, model=model):
                    with self.assertRaises(ValidationError, msg=repr(name)):
                        make(name)

    def test_a_syntax_character_in_a_folder_name_is_refused(self):
        for label, ch in SYNTAX_CHARACTERS.items():
            for model, make in MODELS:
                name = f'sr{ch}c/helper.cpp'
                with self.subTest(character=label, model=model):
                    with self.assertRaises(ValidationError, msg=repr(name)):
                        make(name)

    def test_the_review_name_shapes_are_refused(self):
        for name in SYNTAX_NAME_SHAPES:
            for model, make in MODELS:
                with self.subTest(name=name, model=model):
                    with self.assertRaises(ValidationError, msg=repr(name)):
                        make(name)

    def test_the_compile_request_body_refuses_such_a_name(self):
        # FastAPI builds the body of /api/compile/ and /api/compile/start from
        # CompileRequest: the request is answered 422 before anything is built.
        for name in ('p{build.mcu}q.cpp', 'a;b.cpp', 'x"y.cpp'):
            with self.subTest(name=name, field='files'):
                with self.assertRaises(ValidationError):
                    CompileRequest(files=[{'name': name, 'content': ''}])
            with self.subTest(name=name, field='spiffs_files'):
                with self.assertRaises(ValidationError):
                    CompileRequest(spiffs_files=[{'name': name, 'content_b64': ''}])

    def test_the_refusal_names_the_file_without_a_raw_line_break(self):
        # The message reaches the editor and logs: a raw line break in it
        # would split the line it is printed on.
        for ch in ('\n', '\r', '\x1b', '\u0085', '\u2028', '\u2029'):
            name = f'a{ch}b.cpp'
            with self.subTest(character=repr(ch)):
                with self.assertRaises(ValidationError) as caught:
                    SketchFile(name=name, content='')
                msg = caught.exception.errors()[0]['msg']
                self.assertIn(repr(name), msg)
                self.assertNotIn(ch, msg)

    def test_everyday_names_still_pass(self):
        for name in EVERYDAY_NAMES:
            with self.subTest(name=name):
                self.assertEqual(SketchFile(name=name, content='').name, name)
                self.assertEqual(SpiffsFileBody(name=name, content_b64='').name, name)
                self.assertEqual(CompileRequest(files=[{'name': name, 'content': ''}]).files[0].name, name)


if __name__ == '__main__':
    unittest.main()
