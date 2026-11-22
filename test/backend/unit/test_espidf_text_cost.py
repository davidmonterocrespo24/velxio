"""The ESP32 compiler reads a project's text in time linear in its size.

Before an ESP32 build the compiler reads the project's text several ways: it
rewrites the WiFi credentials for the simulated radios, declares the .ino's
functions before their first use, finds the libraries the code includes, and
reads the build log. Each reading is a regex or a scan. The specs here hand
each one a large text of a shape that reading used to go over more than
once, and bound the CPU time it takes (and, for the copy _blank_noncode
writes, the memory it holds); and they check that each reading finds what
the pattern or function it replaced found, against a copy of that one kept
here, on random text and on the gallery's sketches.
"""
import asyncio
import contextlib
import functools
import random
import re
import sys
import tempfile
import threading
import time
import tracemalloc
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'backend'))

from app.services import espidf_compiler as ec  # noqa: E402

# The CPU seconds one reading of a large text may take. The texts are sized
# so that a reading growing faster than the text would take several times this.
BOUND = 0.5

WIFI = '#include <WiFi.h>\n'
TAIL = '\nvoid setup() {}\nvoid loop() {}\n'
IDF = '#include "esp_wifi.h"\n'
IDF_TAIL = '\nvoid app_main(void) {}\n'


def _compiler() -> ec.ESPIDFCompiler:
    return ec.ESPIDFCompiler.__new__(ec.ESPIDFCompiler)  # no toolchain needed


def _texts(pieces: list[str], count: int, seed: int, longest: int = 30) -> list[str]:
    """`count` random texts, each made of 1 to `longest` of `pieces`."""
    rng = random.Random(seed)
    return [''.join(rng.choice(pieces) for _ in range(rng.randint(1, longest))) for _ in range(count)]


def _spans(matches) -> list:
    return [(m.span(), m.groups()) for m in matches]


_TEMPLATE_ESCAPES = {'n': '\n', 't': '\t', 'r': '\r', '0': '\0'}


@functools.lru_cache(maxsize=1)
def _gallery_sketches() -> tuple[str, ...]:
    """The gallery's sketches: the template literals of frontend/src/data
    that define setup() or app_main(), their escapes decoded."""
    sketches = []
    for path in sorted((REPO / 'frontend' / 'src' / 'data').glob('*.ts')):
        text = path.read_text(encoding='utf-8')
        i = text.find('`')
        while i >= 0:
            j, out = i + 1, []
            while j < len(text) and text[j] != '`':
                if text[j] == '\\' and j + 1 < len(text):
                    out.append(_TEMPLATE_ESCAPES.get(text[j + 1], text[j + 1]))
                    j += 2
                else:
                    out.append(text[j])
                    j += 1
            body = ''.join(out)
            if 'setup(' in body or 'app_main' in body:
                sketches.append(body)
            i = text.find('`', j + 1)
    return tuple(sketches)


def _wifi_sketches() -> list[str]:
    return [s for s in _gallery_sketches() if 'WiFi' in s or 'esp_wifi' in s]


def _rewrite(sources: list[str]) -> tuple[list[str], list[str]]:
    """The SSID rewrite of a project: its sources and the SSIDs it replaced."""
    replaced: list[str] = []
    return _compiler()._normalize_wifi_sources(list(sources), replaced), replaced


class _Spec(unittest.TestCase):

    def assertReadInTime(self, what: str, size: int, read) -> None:
        start = time.process_time()
        read()
        spent = time.process_time() - start
        self.assertLess(spent, BOUND, f'{what}: {spent:.2f} s of CPU for {size} characters')


class TheGallery(unittest.TestCase):

    def test_the_equivalence_specs_read_the_gallery(self):
        self.assertGreater(len(_gallery_sketches()), 100)
        self.assertGreater(len(_wifi_sketches()), 5)


# ── The SSID and password #define names ──────────────────────────────────────

_OLD_SSID_DEFINE = r'(#define\s+(\w*SSID\w*)\s+)"([^"]*)"'
_OLD_IDF_SSID_DEFINE = r'(#define\s+\w*SSID\w*\s+)"([^"]*)"'
_OLD_IDF_PASS_DEFINE = r'(#define\s+\w*(?:PASS|PASSWORD|PSK)\w*\s+)"[^"]*"'


def _old_idf_rewrite(code: str, replaced: list[str]) -> str:
    """_normalize_wifi_for_qemu_idf with the #define patterns it had."""
    def virtual(m):
        return f'{m.group(1)}"{ec._replacing_virtual_ssid(m.group(2), replaced)[0]}"'
    code = re.sub(_OLD_IDF_SSID_DEFINE, virtual, code, flags=re.IGNORECASE)
    code = re.sub(_OLD_IDF_PASS_DEFINE, r'\1""', code, flags=re.IGNORECASE)
    code = re.sub(r'(\.ssid\s*=\s*)"([^"]*)"', virtual, code)
    return re.sub(r'(\.password\s*=\s*)"[^"]*"', r'\1""', code)


_DEFINE_PIECES = ['#define', '#DEFINE', '# define', '#define\t', ' ', '  ', '\t', '\n', '\r', 'WIFI_', 'SSID',
                  'ssid', 'Ssid', 'SSIDSSID', 'PASS', 'pass', 'PASSWORD', 'psk', 'PSK', '_2', 'x', '9', 'é', '"',
                  '"MyHome"', '"a b"', '""', '\\', '#define WIFI_SSID ', '#define SECRET_PASS\t', '.ssid = ',
                  '.password = ', 'S', 'SID']


class TheDefineNames(_Spec):

    def test_a_long_define_name_is_read_once(self):
        c = _compiler()
        for word in ('SSID', 'ssid', 'PASS'):
            name = word * 8000
            for path, code, rewrite in (
                ('Arduino', WIFI + '#define ' + name + TAIL, c._normalize_wifi_for_qemu),
                ('ESP-IDF', IDF + '#define ' + name + IDF_TAIL, c._normalize_wifi_for_qemu_idf),
            ):
                with self.subTest(word=word, path=path):
                    self.assertReadInTime(f'an {path} #define of {word}s', len(code), lambda: rewrite(code))

    def test_the_patterns_match_what_they_replaced(self):
        old = re.compile(_OLD_SSID_DEFINE, re.IGNORECASE)
        for text in _texts(_DEFINE_PIECES, 3000, seed=1000) + list(_gallery_sketches()):
            self.assertEqual(_spans(ec._SSID_DEFINE.finditer(text)), _spans(old.finditer(text)), repr(text))
            new_replaced: list[str] = []
            old_replaced: list[str] = []
            self.assertEqual(_compiler()._normalize_wifi_for_qemu_idf(text, new_replaced),
                             _old_idf_rewrite(text, old_replaced), repr(text))
            self.assertEqual(new_replaced, old_replaced, repr(text))

    def test_the_gallery_is_rewritten_as_before(self):
        after = [_rewrite([s]) for s in _wifi_sketches()]
        with mock.patch.object(ec, '_SSID_DEFINE', re.compile(_OLD_SSID_DEFINE, re.IGNORECASE)):
            before = [_rewrite([s]) for s in _wifi_sketches()]
        self.assertEqual(after, before)


# ── A char variable named ssid ───────────────────────────────────────────────

_OLD_SSID_CHAR_VARIABLE = (
    r'([cC](?:(?i:onst)\s+[cC])?(?i:har)\s*\*?\s*((?i:ssid))\s*\[?\]?\s*=\s*)"([^"]*)"'
)
_CHAR_PIECES = ['char', 'CHAR', 'Char', 'const ', 'CONST\t', 'c', 'C', 'har', 'onst', ' ', '  ', '\t', '\n', '*',
                '**', '[', ']', '[]', '][', 'ssid', 'SSID', 'Ssid', '=', '==', '"', '"x"', '""', 'x', ';', '\\',
                '\x0b', '\xa0']


def _char_declarations(count: int, seed: int) -> list[str]:
    """Declarations of a char variable, most of them close to what the
    pattern matches: random blanks, `*`, brackets, name and value."""
    rng = random.Random(seed)
    blanks = ['', '', ' ', '  ', '\t', '\n', '\x0b', '\xa0', ' \n ']
    texts = []
    for _ in range(count):
        parts = [rng.choice(['char', 'CHAR', 'Char', 'const char', 'CONST\tChar', 'const  char', 'constchar', 'har']),
                 rng.choice(blanks), rng.choice(['', '', '*', '**', '&']), rng.choice(blanks),
                 rng.choice(['ssid', 'SSID', 'Ssid', 'ssid2', 'x']), rng.choice(blanks),
                 rng.choice(['', '', '[', ']', '[]', '][', '[32]', '[ ]', '[]]']), rng.choice(blanks),
                 rng.choice(['=', '=', '=', '==', '']), rng.choice(blanks),
                 rng.choice(['"Home"', '"Home"', '""', '"a b"', '"', 'x', '"x\ny"'])]
        if rng.random() < 0.15:
            del parts[rng.randrange(len(parts))]
        texts.append(rng.choice(['', 'static ', 'x', ';', '"']) + ''.join(parts) + rng.choice(['', ';', '"', ' x']))
    return texts


class TheCharVariable(_Spec):

    def test_the_blanks_around_the_name_are_read_once(self):
        c = _compiler()
        shapes = {
            'blanks on both sides of ssid': WIFI + 'char' + ' ' * 1250 + 'ssid' + ' ' * 1250 + 'x;' + TAIL,
            'blanks after char': WIFI + 'char' + ' ' * 16000 + 'x;' + TAIL,
            'blanks after ssid': WIFI + 'char ssid' + ' ' * 32000 + 'x;' + TAIL,
        }
        for what, code in shapes.items():
            with self.subTest(what):
                self.assertReadInTime(what, len(code), lambda: c._normalize_wifi_for_qemu(code))

    def test_the_pattern_matches_what_it_replaced(self):
        old = re.compile(_OLD_SSID_CHAR_VARIABLE)
        texts = _texts(_CHAR_PIECES, 3000, seed=1001) + _char_declarations(3000, seed=1013) + list(_gallery_sketches())
        for text in texts:
            self.assertEqual(_spans(ec._SSID_CHAR_VARIABLE.finditer(text)), _spans(old.finditer(text)), repr(text))

    def test_the_gallery_is_rewritten_as_before(self):
        after = [_rewrite([s]) for s in _wifi_sketches()]
        with mock.patch.object(ec, '_SSID_CHAR_VARIABLE', re.compile(_OLD_SSID_CHAR_VARIABLE)):
            before = [_rewrite([s]) for s in _wifi_sketches()]
        self.assertEqual(after, before)


# ── The .ino's function declarations ─────────────────────────────────────────

_INO_PIECES = ['a', 'b', 'int', 'void', 'x9', '_', ':', '::', '<', '>', ',', '*', '&', ' ', '\t', '\n', '\n', '\r',
               '(', ')', '{', '}', ';', '=', 'é', '\x1c', '\xa0', '9', 'if', 'template', '"', "'", '#', 'f(', '){',
               'int f(int a) {', 'static ', 'unsigned long ']


class TheInoDeclarations(_Spec):

    def test_lines_that_could_begin_a_return_type_are_read_once(self):
        code = 'a\n' * 8192
        self.assertReadInTime('generate_ino_prototypes', len(code), lambda: ec.generate_ino_prototypes(code))

    def test_the_heads_are_what_the_regex_found(self):
        for text in _texts(_INO_PIECES, 4000, seed=1002, longest=40) + list(_gallery_sketches()):
            for scan in (text, ec._blank_noncode(text)):
                self.assertEqual(_spans(ec._ino_function_heads(scan)), _spans(ec._INO_FUNC_RE.finditer(scan)),
                                 repr(scan))

    def test_the_declarations_are_what_they_were(self):
        texts = _texts(_INO_PIECES, 2000, seed=1003, longest=40) + list(_gallery_sketches())
        after = [ec.generate_ino_prototypes(t) for t in texts]
        with mock.patch.object(ec, '_ino_function_heads', ec._INO_FUNC_RE.finditer):
            before = [ec.generate_ino_prototypes(t) for t in texts]
        self.assertEqual(after, before)


# ── Block comments ───────────────────────────────────────────────────────────

_OLD_BLOCK_COMMENT = re.compile(r'/\*.*?\*/', re.DOTALL)
_COMMENT_PIECES = ['/', '*', '/*', '*/', ' ', 'a', '\n', '/**/', '*/*', '//', '#include <A.h>']


class TheBlockComments(_Spec):

    def test_comments_that_never_close_are_read_once(self):
        c = _compiler()
        code = '/* ' * 13000
        for what, read in (
            ('_strip_comments', lambda: c._strip_comments(code)),
            ('_component_graph_token', lambda: c._component_graph_token(code)),
            ('_detect_external_includes', lambda: c._detect_external_includes(code, set())),
        ):
            with self.subTest(what):
                self.assertReadInTime(what, len(code), read)

    def test_the_comments_dropped_are_the_ones_the_regex_dropped(self):
        c = _compiler()
        for text in _texts(_COMMENT_PIECES, 4000, seed=1004) + list(_gallery_sketches()):
            self.assertEqual(ec._drop_block_comments(text), _OLD_BLOCK_COMMENT.sub(' ', text), repr(text))
            self.assertEqual(c._strip_comments(text),
                             c._PP_COMMENT_LINE_RE.sub(' ', _OLD_BLOCK_COMMENT.sub(' ', text)), repr(text))


# ── The include scanner's #if stack ──────────────────────────────────────────

_OLD_INCLUDE = r'#\s*include\s*(?:<([^>]+)>|"([^"]+)")'


def _old_detect_external_includes(comp, code: str, own_files=None, _raw: bool = False) -> list:
    """_detect_external_includes as it was: comments dropped by the regex,
    the whole #if stack read for every line, and the include regex per line."""
    code = _OLD_BLOCK_COMMENT.sub(' ', code)
    code = comp._PP_COMMENT_LINE_RE.sub(' ', code)
    lines = code.splitlines()
    chain_true = comp._pp_chain_has_true_arm(lines)
    headers: list = []
    own = own_files or set()
    stack: list[tuple[bool, bool, int]] = []
    for _ln, raw in enumerate(lines):
        line = raw.strip()
        if line.startswith('#'):
            dtv = line[1:].lstrip()
            if dtv.startswith(('ifdef', 'ifndef', 'if ', 'if(')):
                if dtv.startswith('ifdef'):
                    live = comp._pp_branch_is_live(dtv[5:])
                    taken = comp._pp_branch_is_provably_true(dtv[5:])
                elif dtv.startswith('ifndef'):
                    idents = comp._PP_IDENT_RE.findall(dtv[6:])
                    live = not any(i in comp._PP_TRUE for i in idents)
                    taken = bool(idents) and all(i in comp._PP_FALSE for i in idents)
                else:
                    live = comp._pp_branch_is_live(dtv[2:])
                    taken = comp._pp_branch_is_provably_true(dtv[2:])
                if chain_true.get(_ln) and not taken:
                    live = False
                stack.append((live, taken, _ln))
                continue
            if dtv.startswith('elif'):
                if stack:
                    _cur, taken, cid = stack[-1]
                    arm_true = comp._pp_branch_is_provably_true(dtv[4:])
                    live = (not taken) and comp._pp_branch_is_live(dtv[4:])
                    if chain_true.get(cid) and not arm_true:
                        live = False
                    stack[-1] = (live, taken or arm_true, cid)
                continue
            if dtv.startswith('else'):
                if stack:
                    _cur, taken, cid = stack[-1]
                    stack[-1] = ((not taken) and not chain_true.get(cid), True, cid)
                continue
            if dtv.startswith('endif'):
                if stack:
                    stack.pop()
                continue
        if not all(live for live, _t, _c in stack):
            continue
        m = re.search(_OLD_INCLUDE, line)
        if not m:
            continue
        h = m.group(1) or m.group(2)
        if _raw:
            headers.append((h, m.group(2) is not None))
            continue
        if h in own or h in comp._BUILTIN_HEADERS or '/' in h:
            continue
        if re.match(r'^(esp_|driver/|soc/|hal/|nvs|rom/)', h):
            continue
        headers.append(h)
    return headers


_DIRECTIVE_LINES = [
    '#if 1', '#if(', '#if defined(ESP8266)', '#if defined(ESP32)', '#ifdef ESP32', '#ifdef ARDUINO_ARCH_AVR',
    '#ifndef ESP32', '#ifndef __AVR__', '#elif defined(ESP32)', '#elif defined(ESP8266)', '#elif 0', '#else',
    '#endif', '#include <A.h>', '#include "B.h"', '#include <esp_x.h>', '#include <c/d.h>', '  #  include <E.h>',
    'x', '', '/* #include <F.h> */', '// #include <G.h>', '#include <#include <H.h>', '#include <', '#include "',
    '#if __has_include(<I.h>)', '#elif __has_include(<J.h>)', 'int x; #include <K.h>', '#include <>',
    '#include ""', '#include <L.h> #include "M.h"', '#include "N.h', '#define X 1', '# else', '#  endif', '#ifdef',
    '/*', '*/', '#include <WiFi.h>', '#include "own.h"',
]


def _directive_soups(count: int, seed: int) -> list[str]:
    rng = random.Random(seed)
    return ['\n'.join(rng.choice(_DIRECTIVE_LINES) for _ in range(rng.randint(1, 25))) for _ in range(count)]


class TheIncludeScanner(_Spec):

    def test_a_deep_if_stack_is_not_read_again_for_every_line(self):
        code = '#if(\n' * 4000 + '\n' * 20000
        self.assertReadInTime('_detect_external_includes', len(code),
                              lambda: _compiler()._detect_external_includes(code, set()))

    def test_the_headers_are_what_the_scanner_found(self):
        c = _compiler()
        own = {'B.h', 'own.h'}
        for text in _directive_soups(3000, seed=1005) + list(_gallery_sketches()):
            self.assertEqual(c._detect_external_includes(text, own), _old_detect_external_includes(c, text, own),
                             repr(text))
            self.assertEqual(c._iter_live_includes(text), _old_detect_external_includes(c, text, _raw=True),
                             repr(text))


# ── The include line ─────────────────────────────────────────────────────────

_INCLUDE_PIECES = ['#', 'include', ' ', '\t', '<', '>', '"', 'a', '.h', '#include <', '#include "', '#include<',
                   '\xa0', '/']


def _old_first_include(line: str):
    m = re.search(_OLD_INCLUDE, line)
    return None if m is None else (m.group(1) or m.group(2), m.group(2) is not None)


class TheIncludeLine(_Spec):

    def test_a_line_of_includes_that_never_close_is_read_once(self):
        c = _compiler()
        code = '#include <' * 8000
        self.assertReadInTime('_detect_external_includes', len(code), lambda: c._detect_external_includes(code, set()))
        self.assertReadInTime('_iter_live_includes', len(code), lambda: c._iter_live_includes(code))

    def test_the_include_is_the_one_the_regex_found(self):
        for line in _texts(_INCLUDE_PIECES, 6000, seed=1006, longest=20):
            self.assertEqual(ec._first_include(line), _old_first_include(line), repr(line))


# ── Assignments to a followed name ───────────────────────────────────────────

_OLD_ASSIGNED_TO = r'(?!\w)\s*(?:\[[^\]\n]*\]\s*)?(?:PROGMEM\s*)?=(?!=)'


@contextlib.contextmanager
def _old_assignments():
    """The SSID rewrite reading assignments the old way: every pattern built
    on _ASSIGNED_TO rebuilt on the old one."""
    def old(p: re.Pattern) -> re.Pattern:
        return re.compile(p.pattern.replace(ec._ASSIGNED_TO, _OLD_ASSIGNED_TO), p.flags)

    with mock.patch.multiple(
        ec,
        _ASSIGNED_TO=_OLD_ASSIGNED_TO,
        _ASSIGNED_NAME=old(ec._ASSIGNED_NAME),
        _NAME_DEFINITIONS=tuple(old(p) for p in ec._NAME_DEFINITIONS),
        _LITERAL_DEFINITIONS=tuple(old(p) for p in ec._LITERAL_DEFINITIONS),
    ):
        yield


def _a_subscript_holds_a_bracket(text: str) -> bool:
    """Some `NAME[...` in `text` whose subscript, up to its first ']' or
    newline, holds a '[': the only text the two readings may differ on."""
    for m in re.finditer(r'\w\s*\[', text):
        rest = text[m.end():]
        stop = min([i for i in (rest.find(']'), rest.find('\n')) if i >= 0] or [len(rest)])
        if '[' in rest[:stop]:
            return True
    return False


_ASSIGN_PIECES = ['ssid', 'net', ' ', '\t', '\n', '[', ']', '[]', '[32]', "'['", '=', '==', '"x"', '"Home"', 'PROGMEM',
                  ';', 'a', '.', '->', 'x[ssid]', 'ssid[', 'char ', '#define ssid "y"\n', ' = net;', '[a[1]]',
                  '[sizeof(b[0])]', 'WiFi.begin(ssid);', 'WiFi.begin(net);']


def _assignment_reading(text: str) -> list:
    defs = ec._Definitions(text)
    out: list = [(n, defs._assignments(n)) for n in ('ssid', 'net', 'a', 'x')]
    out += [_spans(p.finditer(text)) for p in ec._NAME_DEFINITIONS + ec._LITERAL_DEFINITIONS]
    out += [_spans(defs.of(n, ec._LITERAL_DEFINITIONS)) for n in ('ssid', 'net')]
    out.append([m.span() for m in ec._ASSIGNED_NAME.finditer(text)])
    return out


class TheAssignments(_Spec):

    def test_an_open_subscript_is_read_once(self):
        c = _compiler()
        shapes = {
            'one followed name': WIFI + 'void setup(){WiFi.begin(ssid);}\nvoid loop(){}\n' + 'ssid[' * 13000 + '\n',
            'forty followed names': (
                WIFI + 'void setup(){' + ''.join(f'WiFi.begin(n{i});' for i in range(40)) + '}\nvoid loop(){}\n'
                + 'a[' * 24000 + '\n'),
        }
        for what, code in shapes.items():
            with self.subTest(what):
                self.assertReadInTime(what, len(code), lambda: c._normalize_wifi_for_qemu(code))

    def test_assignments_are_read_as_before(self):
        texts = _texts(_ASSIGN_PIECES, 3000, seed=1007, longest=25)
        after = [_assignment_reading(t) for t in texts]
        rewritten_after = [_rewrite([WIFI + t]) for t in texts[:800]]
        with _old_assignments():
            before = [_assignment_reading(t) for t in texts]
            rewritten_before = [_rewrite([WIFI + t]) for t in texts[:800]]
        for t, a, b in zip(texts, after, before):
            if a != b:
                self.assertTrue(_a_subscript_holds_a_bracket(t), repr(t))
        for t, a, b in zip(texts, rewritten_after, rewritten_before):
            if a != b:
                self.assertTrue(_a_subscript_holds_a_bracket(t), repr(t))

    def test_the_gallery_is_read_as_before(self):
        sketches = list(_gallery_sketches())
        after = [(_assignment_reading(s), _rewrite([s])) for s in sketches]
        with _old_assignments():
            before = [(_assignment_reading(s), _rewrite([s])) for s in sketches]
        self.assertEqual(after, before)


# ── WiFiMulti's addAP() calls ────────────────────────────────────────────────

def _old_rewrite_call_args(code: str, name_pattern: str, rewrite) -> str:
    """_rewrite_call_args as it was: a kept call's arguments were read again
    for the calls inside them."""
    out: list[str] = []
    pos = 0
    for m in re.finditer(name_pattern + r'\s*\(', code):
        if m.start() < pos:
            continue
        close = ec._matching_paren(code, m.end() - 1)
        if close < 0:
            break
        replacement = rewrite(code[m.end():close])
        if replacement is None:
            continue
        out.append(code[pos:m.end()])
        out.append(replacement)
        pos = close
    out.append(code[pos:])
    return ''.join(out)


_ADD_AP = r'\b\w+\s*\.\s*addAP'


def _add_ap(args: str) -> str | None:
    """What the SSID rewrite does to addAP()'s arguments, minus the SSID."""
    parts = ec._split_call_args(args)
    return None if not parts[0] else f'<{parts[0]}>, ""'


def _a_kept_call_holds_another(text: str) -> bool:
    """An addAP() call the rewrite keeps (no first argument: code that cannot
    compile) with another addAP( inside its parentheses: the only text the
    two readings may differ on."""
    for m in re.finditer(_ADD_AP + r'\s*\(', text):
        close = ec._matching_paren(text, m.end() - 1)
        if close >= 0 and _add_ap(text[m.end():close]) is None and re.search(_ADD_AP, text[m.end():close]):
            return True
    return False


_CALL_PIECES = ['m.addAP(', 'w . addAP (', 'addAP(', '(', ')', ',', ' ', '"', '"x"', "'", 'a', '\\', '\n', 'm.addAP(,',
                ');']


class TheAddApCalls(_Spec):

    def test_calls_inside_a_kept_call_are_read_once(self):
        k = 1200
        code = ('#include <WiFiMulti.h>\nWiFiMulti m;\nvoid setup(){\n' + 'm.addAP(,' * k + ')' * k
                + ';\n}\nvoid loop(){}\n')
        self.assertReadInTime('_normalize_wifi_for_qemu', len(code), lambda: _compiler()._normalize_wifi_for_qemu(code))

    def test_the_calls_are_rewritten_as_before(self):
        for text in _texts(_CALL_PIECES, 4000, seed=1008, longest=20) + list(_gallery_sketches()):
            new = ec._rewrite_call_args(text, _ADD_AP, _add_ap)
            if new != _old_rewrite_call_args(text, _ADD_AP, _add_ap):
                self.assertTrue(_a_kept_call_holds_another(text), repr(text))


# ── The network a name names ─────────────────────────────────────────────────

def _old_network_of(name: str, networks_of_name: dict, defined_from: dict) -> str | None:
    """_network_of as it was: a walk of the definitions from `name`."""
    networks: set[str] = set()
    seen: set[str] = set()
    todo = [name]
    while todo:
        n = todo.pop()
        if n in seen:
            continue
        seen.add(n)
        networks |= networks_of_name.get(n, set())
        todo.extend(defined_from.get(n, ()))
    return next(iter(networks)) if len(networks) == 1 else None


def _network_of(name: str, leading: dict) -> str | None:
    """_normalize_wifi_sources's _network_of, on _names_leading_to()."""
    networks = [net for net, names in leading.items() if name in names]
    return networks[0] if len(networks) == 1 else None


class TheNetworkOfAName(_Spec):

    def test_each_call_finds_its_network_without_walking_the_definitions(self):
        defs, i = [], 0
        while sum(map(len, defs)) < 32768:
            defs.append(f's=a{i};')
            i += 1
        code = (WIFI + ''.join(defs) + '\nvoid setup(){' + 'WiFi.begin(s);' * (32768 // 14)
                + '}\nvoid loop(){}\n')
        self.assertReadInTime('_normalize_wifi_for_qemu', len(code), lambda: _compiler()._normalize_wifi_for_qemu(code))

    def test_a_name_names_the_networks_it_did(self):
        rng = random.Random(1009)
        names = [f'n{i}' for i in range(10)]
        nets = ['Velxio-GUEST', 'PICSimLabWifi', 'Espressif', 'MasseyWifi']
        for _ in range(3000):
            defined_from = {n: set(rng.sample(names, rng.randint(0, 3))) for n in rng.sample(names, rng.randint(0, 10))}
            networks_of_name = {n: set(rng.sample(nets, rng.randint(1, 2))) for n in rng.sample(names, rng.randint(0, 4))}
            leading = ec._names_leading_to(networks_of_name, defined_from)
            for n in names + ['other']:
                self.assertEqual(_network_of(n, leading), _old_network_of(n, networks_of_name, defined_from),
                                 (n, networks_of_name, defined_from))


# ── Followed names, file by file ─────────────────────────────────────────────

class _EveryName:
    """`names & _EveryName()` is `names`: every source is asked for every
    followed name, as the rewrite did before it read each source's words."""

    def __rand__(self, other):
        return set(other)


_PROJECT_NAMES = [f'n{i}' for i in range(6)] + ['ssid', 'WIFI_SSID']
_PROJECT_SSIDS = ['Home', 'Velxio-GUEST', 'Wokwi-GUEST', 'Other']
_PROJECT_FORMS = ['{A} = {B};', '#define {A} {B}', 'const char* {A} = "{S}";', '#define {A} "{S}"', 'WiFi.begin({A});',
                  'WiFi.begin({A}, "p", 3);', 'String {A} = "{S}";', 'WiFi.softAP({A});', '{A}[8] = "{S}";',
                  'char ssid[] = "{S}";', 'WiFi.begin("{S}", "pw");']


def _projects(count: int, seed: int, forms: list[str] = _PROJECT_FORMS,
              names: list[str] = _PROJECT_NAMES) -> list[list[str]]:
    rng = random.Random(seed)

    def source() -> str:
        return '\n'.join(
            rng.choice(forms).replace('{A}', rng.choice(names))
            .replace('{B}', rng.choice(names)).replace('{S}', rng.choice(_PROJECT_SSIDS))
            for _ in range(rng.randint(1, 12))) + '\n'

    return [[WIFI + source()] + [source() for _ in range(rng.randint(0, 3))] for _ in range(count)]


class TheFollowedNames(_Spec):

    def test_a_source_is_asked_only_for_the_names_it_holds(self):
        calls = ''.join(f'WiFi.begin(n{i});' for i in range(1280))
        sources = [WIFI + 'void setup(){' + calls + '}\nvoid loop(){}\n'] + ['int x;\n'] * 1600
        size = sum(map(len, sources))
        self.assertReadInTime('_normalize_wifi_sources', size, lambda: _compiler()._normalize_wifi_sources(sources, []))

    def test_projects_are_rewritten_as_before(self):
        projects = _projects(1500, seed=1010) + [[s] for s in _gallery_sketches()]
        after = [_rewrite(p) for p in projects]
        with mock.patch.object(ec._Definitions, 'words', lambda self: _EveryName()):
            before = [_rewrite(p) for p in projects]
        self.assertEqual(after, before)


# ── Where a followed name is assigned ────────────────────────────────────────

def _searched_for(source: str, name: str) -> list[int]:
    """Where `name` starts with a value assigned to it, found by a search for
    the name's own text: how _Definitions._assignments found the first names
    it was asked for."""
    n = re.escape(name)
    pattern = n + r'(?<![\w.]' + n + r')(?<!->' + n + r')(?=' + ec._ASSIGNED_TO + r')'
    return [m.start() for m in re.finditer(pattern, source)]


def _old_assignments_of(self, name: str) -> list[int]:
    """_Definitions._assignments as it was: each of the first 32 names a
    source was asked for searched for by its own text, the rest looked up in
    one scan of every assigned name."""
    old = self.__dict__.setdefault('_old', {'searched': {}, 'every': None})
    if old['every'] is None and name not in old['searched']:
        if len(old['searched']) < 32:
            old['searched'][name] = _searched_for(self.source, name)
        else:
            old['every'] = {}
            for m in ec._ASSIGNED_NAME.finditer(self.source):
                old['every'].setdefault(m.group(), []).append(m.start())
    if old['every'] is not None:
        return old['every'].get(name, [])
    return old['searched'][name]


# More ways a name is written next to an '=' or another name: after a
# member's '.' or '->', at either end of a longer word, in a string or a
# comment, compared, split over lines.
_NAME_FORMS = _PROJECT_FORMS + [
    'cfg.{A} = "{S}";', 'p->{A} = "{S}";', 'p -> {A} = {B};', '{A}2 = "{S}";', 'x{A} = {B};', '{A}[{B}] = "{S}";',
    '{A} [32] PROGMEM = "{S}";', 'if ({A} == {B}) {}', 'Serial.println("{A} = {B}");', '// {A} = "{S}"',
    '/* {A} = {B}; */', '{A}\n=\n{B};', 'é{A} = "{S}";', '{A}é = "{S}";', 'String {A} = {B}.c_str();',
    'WiFi.begin({A}.c_str());', '{A}={B};{B}={A};',
]
_NAMES = _PROJECT_NAMES + ['ssid2', 'SSID', 'a', 'aa', 'n1x']


class TheNameLookups(_Spec):

    def test_a_long_name_and_a_word_of_twice_its_letters_are_read_once(self):
        c = _compiler()
        name, word = 'a' * 16000, 'a' * 32000
        shapes = {
            'a long name given to WiFi.begin()': (
                WIFI + 'void g(){WiFi.begin(' + name + ');}\nint ' + word + ';' + TAIL),
            'a long name a #define names': (
                WIFI + '#define S ' + name + '\nvoid g(){WiFi.begin(S);}\nint ' + word + ';' + TAIL),
        }
        for what, code in shapes.items():
            with self.subTest(what):
                self.assertReadInTime(what, len(code), lambda: c._normalize_wifi_for_qemu(code))

    def test_a_long_name_is_looked_up_once(self):
        c = _compiler()
        shapes = {
            'a long name given to another': (
                WIFI + 'void g(){WiFi.begin(s);}\nconst char* s = ' + 'b' * 262144 + ';' + TAIL),
            'a long name a #define names': WIFI + '#define S ' + 'c' * 262144 + '\nvoid g(){WiFi.begin(S);}' + TAIL,
        }
        for what, code in shapes.items():
            with self.subTest(what):
                self.assertReadInTime(what, len(code), lambda: c._normalize_wifi_for_qemu(code))

    def test_no_followed_name_is_made_into_a_pattern(self):
        names = ['home_network_of_this_spec', 'd' * 4096]
        code = (WIFI + ''.join(f'const char* {n} = "Home{i}";\n' for i, n in enumerate(names))
                + 'void g(){' + ''.join(f'WiFi.begin({n});' for n in names) + '}' + TAIL)
        _, replaced = _rewrite([code])
        self.assertEqual(sorted(replaced), ['Home0', 'Home1'], 'both names are followed to their literal')
        patterns = [key[1] for cache in (re._cache, getattr(re, '_cache2', {})) for key in cache]
        for name in names:
            self.assertEqual([p for p in patterns if isinstance(p, str) and name in p], [],
                             f"a pattern holding the name {name[:32]} is in re's cache")

    def test_each_name_is_found_where_a_search_for_it_found_it(self):
        for project in _projects(1000, seed=1016, forms=_NAME_FORMS, names=_NAMES):
            for source in project:
                defs = ec._Definitions(source)
                for name in sorted(defs.words()):
                    self.assertEqual(defs._assignments(name), _searched_for(source, name), (source, name))

    def test_projects_are_rewritten_as_before(self):
        projects = _projects(3000, seed=1017, forms=_NAME_FORMS, names=_NAMES) + [[s] for s in _gallery_sketches()]
        after = [_rewrite(p) for p in projects]
        with mock.patch.object(ec._Definitions, '_assignments', _old_assignments_of):
            before = [_rewrite(p) for p in projects]
        self.assertEqual(after, before)


# ── The build log's transient failures ───────────────────────────────────────

def _old_is_transient_build_failure(result: dict) -> bool:
    if result.get('success'):
        return False
    text = (str(result.get('error') or '') + '\n' + str(result.get('stderr') or '') + '\n'
            + str(result.get('stdout') or '')).lower()
    markers = ('managed_components_list.temp.cmake', 'cmake configure failed', 'sdkconfig.h: no such file',
               'ninja: error', 'cmake error')
    if any(m in text for m in markers):
        return True
    return bool(re.search(r'^\s*failed:[^\n]*bootloader', text, re.M))


_LOG_PIECES = ['\n', '\n', ' ', '\t', '\r', '\x0b', '\x1c', '\xa0', 'failed:', 'FAILED:', 'bootloader', 'x',
               'esp-idf/', 'FAILED: esp-idf/bootloader', 'cmake error']


class TheBuildLog(_Spec):

    def test_blank_lines_are_read_once(self):
        result = {'success': False, 'error': 'ESP-IDF build failed', 'stderr': '\n' * 40000, 'stdout': ''}
        self.assertReadInTime('_is_transient_build_failure', 40000,
                              lambda: ec.ESPIDFCompiler._is_transient_build_failure(result))

    def test_a_failure_is_transient_when_it_was(self):
        for text in _texts(_LOG_PIECES, 6000, seed=1011, longest=25):
            for result in ({'success': False, 'stderr': text}, {'success': False, 'error': 'x', 'stdout': text}):
                self.assertEqual(ec.ESPIDFCompiler._is_transient_build_failure(result),
                                 _old_is_transient_build_failure(result), repr(text))


# ── The legacy translation's handlers ────────────────────────────────────────

_OLD_HANDLER = r'void\s+(\w+)\s*\(\s*\)\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}'
_NEW_HANDLER = r'void\s+(\w+)\s*\(\s*\)\s*\{([^}]*)\}'
_HANDLER_PIECES = ['#include <WebServer.h>\n', 'void ', 'f', 'g', '()', '( )', ' ', '{', '}', '\n', 'x',
                   'server.send(200, "text/html", "<h1>x</h1>");', 'server.on("/", f);',
                   'server.on("/g", HTTP_GET, g);', 'void f() {', 'void g(){']


class TheLegacyHandlers(_Spec):

    def test_handlers_that_never_close_are_read_once(self):
        code = '#include <WebServer.h>\n' + 'void f(){' * 1100
        self.assertReadInTime('_translate_sketch_to_espidf', len(code),
                              lambda: _compiler()._translate_sketch_to_espidf(code))

    def test_the_bodies_are_the_ones_found_before(self):
        for text in _texts(_HANDLER_PIECES, 4000, seed=1012, longest=16):
            self.assertEqual(
                _spans(re.finditer(_NEW_HANDLER, text[:text.rfind('}') + 1], re.DOTALL)),
                _spans(re.finditer(_OLD_HANDLER, text, re.DOTALL)), repr(text))

    def test_a_handler_still_serves_its_page(self):
        sketch = ('#include <WiFi.h>\n#include <WebServer.h>\nWebServer server(80);\n'
                  'void handleRoot() {\n  if (on) { led(); }\n  server.send(200, "text/html", "<h1>Hi</h1>");\n}\n'
                  'void setup() {\n  WiFi.begin("Home", "pw");\n  server.on("/", handleRoot);\n'
                  '  server.begin();\n}\nvoid loop() { server.handleClient(); }\n')
        out = _compiler()._translate_sketch_to_espidf(sketch)
        self.assertIn('static esp_err_t handleRoot_handler(httpd_req_t *req) {', out)
        self.assertIn('.uri = "/",', out)


# ── A scoped build's missing headers ─────────────────────────────────────────

def _old_missing_library_headers(result: dict) -> list[str]:
    text = '\n'.join(str(result.get(k) or '') for k in ('error', 'stderr', 'stdout'))
    headers: list[str] = []
    for m in re.finditer(r'fatal error:\s*([A-Za-z0-9_./+-]+\.h(?:pp)?)\s*:\s*No such file', text):
        h = m.group(1).split('/')[-1]
        if h not in headers:
            headers.append(h)
    return headers


class TheScopedRetry(_Spec):

    @staticmethod
    def _compile_failing_with(log: str, root: Path, libraries: int):
        """compile() of a sketch that names a library, its build stubbed to
        fail with `log`, with `libraries` installed. Returns the result, the
        event loop's CPU seconds and (thread, headers) for each lookup of the
        missing headers."""
        libs = root / 'libraries'
        for i in range(libraries):
            (libs / f'Lib{i:04d}').mkdir(parents=True)
        idf = root / 'esp-idf'
        idf.mkdir()
        c = _compiler()
        c.idf_path = str(idf)
        c.idf5_path = ''
        c.arduino_path = str(idf)
        c.has_arduino = True
        c.arduino5_path = ''
        c.has_arduino5 = False
        c._core_headers_cache = frozenset(c._CORE_ESP32_HEADERS)
        c._find_arduino_libraries_dir = lambda: libs

        async def failed_build(*_args, **_kwargs):
            return {'success': False, 'error': 'ESP-IDF build failed', 'stdout': log, 'stderr': ''}

        c._compile_in_dir = failed_build
        lookups: list[tuple[int, list[str]]] = []
        lookup = c._libraries_for_missing_headers

        def recorded(headers, allowed):
            lookups.append((threading.get_ident(), list(headers)))
            return lookup(headers, allowed)

        c._libraries_for_missing_headers = recorded
        files = [{'name': 'sketch.ino', 'content': '#include <Servo.h>' + TAIL}]
        with mock.patch.object(ec, '_USE_PERSISTENT_DIR', False), \
                mock.patch.object(ec, 'materialize_library_scope', return_value=None):
            start = time.thread_time()
            result = asyncio.run(c.compile(files, 'esp32:esp32:esp32', allowed_libraries={'Servo'}))
            loop_cpu = time.thread_time() - start
        return result, loop_cpu, lookups

    def test_the_libraries_are_looked_up_off_the_event_loop(self):
        log = ''.join(f'sketch.ino:1:10: fatal error: a{i}.h: No such file or directory\n' for i in range(130))
        with tempfile.TemporaryDirectory() as tmp:
            result, loop_cpu, lookups = self._compile_failing_with(log, Path(tmp), 1000)
        self.assertLess(loop_cpu, BOUND, f'the event loop spent {loop_cpu:.2f} s of CPU on a failed scoped build')
        self.assertEqual(len(lookups), 1)
        thread, headers = lookups[0]
        self.assertNotEqual(thread, threading.get_ident(), 'the library lookup ran on the event loop')
        self.assertEqual(headers, [f'a{i}.h' for i in range(32)])
        self.assertEqual(result['missing_headers'], headers)
        self.assertIn('<a0.h>: none of the libraries in this project provides it.', result['error'])

    def test_the_missing_headers_are_the_first_ones_reported(self):
        rng = random.Random(1014)
        forms = ['fatal error: a{}.h: No such file or directory', 'x.cpp:1: fatal error: lib/b{}.hpp: No such file',
                 'error: c{}.h', 'fatal error: d{}.h : No such file']
        for _ in range(2000):
            lines = [rng.choice(forms).format(rng.randint(0, 80)) for _ in range(rng.randint(0, 60))]
            result = {'error': 'x', 'stderr': '\n'.join(lines[: len(lines) // 2]),
                      'stdout': '\n'.join(lines[len(lines) // 2:])}
            self.assertEqual(ec.ESPIDFCompiler._missing_library_headers(result),
                             _old_missing_library_headers(result)[:ec.ESPIDFCompiler._MAX_MISSING_HEADERS])


# ── Lines the include scanner skips ──────────────────────────────────────────

def _old_pp_chain_has_true_arm(comp, lines: list[str]) -> dict[int, bool]:
    """_pp_chain_has_true_arm as it was: every line stripped and looked at."""
    result: dict[int, bool] = {}
    pending: list[list] = []
    for idx, raw in enumerate(lines):
        line = raw.strip()
        if not line.startswith('#'):
            continue
        dtv = line[1:].lstrip()
        if dtv.startswith(('ifdef', 'ifndef', 'if ', 'if(')):
            if dtv.startswith('ifdef'):
                t = comp._pp_branch_is_provably_true(dtv[5:])
            elif dtv.startswith('ifndef'):
                ids = comp._PP_IDENT_RE.findall(dtv[6:])
                t = bool(ids) and all(i in comp._PP_FALSE for i in ids)
            else:
                t = comp._pp_branch_is_provably_true(dtv[2:])
            pending.append([idx, t])
        elif dtv.startswith('elif'):
            if pending:
                pending[-1][1] = pending[-1][1] or comp._pp_branch_is_provably_true(dtv[4:])
        elif dtv.startswith('endif'):
            if pending:
                rec = pending.pop()
                result[rec[0]] = rec[1]
    for rec in pending:
        result[rec[0]] = rec[1]
    return result


class TheScannedLines(_Spec):

    def test_a_line_without_a_hash_is_skipped(self):
        c = _compiler()
        code = '\n' * 1_000_000
        self.assertReadInTime('_detect_external_includes', len(code), lambda: c._detect_external_includes(code, set()))
        with mock.patch.object(ec, '_first_include', wraps=ec._first_include) as first:
            headers = c._detect_external_includes('int x;\n' * 1000 + '#include <A.h>\n', set())
        self.assertEqual(headers, ['A.h'])
        self.assertEqual(first.call_count, 1, 'only the line with a # is read for an #include')

    def test_the_chains_are_what_they_were(self):
        c = _compiler()
        for text in _directive_soups(3000, seed=1015) + list(_gallery_sketches()):
            lines = text.splitlines()
            self.assertEqual(c._pp_chain_has_true_arm(lines), _old_pp_chain_has_true_arm(c, lines), repr(text))


# ── The blanked copy ─────────────────────────────────────────────────────────

def _old_blank_noncode(source: str) -> str:
    """_blank_noncode as it was: the same scan, with every blanked range kept
    in a list until the copy was written at the end."""
    n = len(source)
    find = source.find
    spans: list[tuple[int, int]] = []
    i = 0
    slash = dquote = squote = hash_ = -1
    directive = 0 if ec._DIRECTIVE_START.match(source) else -1
    while True:
        if directive >= 0:
            end = find('\n', directive)
            while end > 0 and source[end - 1] == '\\':
                end = find('\n', end + 1)
            if end < 0:
                spans.append((directive, n))
                break
            spans.append((directive, end))
            i = end + 1
            directive = i if ec._DIRECTIVE_START.match(source, i) else -1
            continue
        if slash < i:
            slash = find('/', i)
            if slash < 0:
                slash = n
        if dquote < i:
            dquote = find('"', i)
            if dquote < 0:
                dquote = n
        if squote < i:
            squote = find("'", i)
            if squote < 0:
                squote = n
        k = min(slash, dquote, squote)
        if hash_ < i:
            hash_ = find('#', i)
            if hash_ < 0:
                hash_ = n
        while hash_ < k:
            j = hash_ - 1
            while j >= 0 and source[j] in ' \t':
                j -= 1
            if j < 0 or source[j] == '\n':
                directive = j + 1
                break
            hash_ = find('#', hash_ + 1)
            if hash_ < 0:
                hash_ = n
        if directive >= 0:
            continue
        if k == n:
            break
        if k == slash:
            after = source[k + 1:k + 2]
            if after == '/':
                end = find('\n', k + 2)
                i = n if end < 0 else end
                spans.append((k, i))
            elif after == '*':
                end = find('*/', k + 2)
                i = n if end < 0 else end + 2
                spans.append((k, i))
            else:
                i = k + 1
            continue
        stop = ec._LITERAL_STOP[source[k]].search
        j = k + 1
        while True:
            m = stop(source, j)
            if m is None:
                spans.append((k + 1, n))
                i = n
                break
            j = m.start()
            if source[j] == '\\':
                j += 2
                continue
            spans.append((k + 1, j))
            i = j + 1
            break
    out: list[str] = []
    pos = 0
    for start, end in spans:
        out.append(source[pos:start])
        part = source[start:end]
        out.append(ec._NOT_NEWLINE.sub(' ', part) if '\n' in part else ' ' * len(part))
        pos = end
    out.append(source[pos:])
    return ''.join(out)


def _peak_memory(read) -> int:
    """The most memory read() holds at once, in bytes, besides what was held
    before it."""
    tracing = tracemalloc.is_tracing()
    if not tracing:
        tracemalloc.start()
    try:
        held = tracemalloc.get_traced_memory()[0]
        tracemalloc.reset_peak()
        read()
        return tracemalloc.get_traced_memory()[1] - held
    finally:
        if not tracing:
            tracemalloc.stop()


# The bytes the blanked copy may hold per character of source while it is
# written: the copy itself takes one, and each blanked range adds a piece of
# the code before it and a slot in the list of pieces. A list of every
# blanked range, kept until the copy was written at the end, held well over
# this on each of these texts.
BYTES_PER_CHARACTER = 32

_BLANK_PIECES = ['\n', ' ', '\t', '\\\n', '/*', '*/', '//', '/', '#', '# ', '"', "'", '\\', 'a', '{', '}',
                 '#define X "a\\nb"', '#define X "a\nb"', 'b' * 254, 'b' * 255, 'b' * 256]


class TheBlankedCopy(_Spec):

    def test_the_copy_is_written_as_the_scan_goes(self):
        for unit in ('"', '"a"', "'a'", '/**/', '//\n', 'x"a"', '"\\a"'):
            source = unit * (65536 // len(unit))
            with self.subTest(repr(unit)):
                peak = _peak_memory(lambda: ec._blank_noncode(source))
                self.assertLess(peak, BYTES_PER_CHARACTER * len(source),
                                f'{unit!r} * {len(source) // len(unit)}: {peak / len(source):.0f} bytes per character')

    def test_the_copy_is_what_it_was(self):
        for text in _texts(_BLANK_PIECES, 5000, seed=1018, longest=40) + list(_gallery_sketches()):
            self.assertEqual(ec._blank_noncode(text), _old_blank_noncode(text), repr(text))


if __name__ == '__main__':
    unittest.main()
