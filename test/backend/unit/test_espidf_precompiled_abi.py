"""
A precompiled library archive that cannot be part of this build is refused
with a compile error that names the library and the reason
(velxio/velxio-prod#214).

Since #87 the build links the archives a precompiled library ships for the
chip. micro_ros_arduino 3.0.0-iron's src/esp32/libmicroros.a then linked with
no undefined reference left, and failed on four multiple definitions instead:
__atomic_exchange_8, __atomic_fetch_add_8, __atomic_load_8 and
__atomic_store_8, defined both in the archive and in ESP-IDF 5.5's newlib.
Linked, it would still run wrong: every object in it was compiled by
"GCC: (crosstool-NG esp-2021r2) 8.4.0", the ESP-IDF 4.x toolchain behind
arduino-esp32 2.x, whose time_t is 32 bits (ESP-IDF 5 made it 64), so its
uxr_millis reads tv_nsec at the wrong offset. The user saw four linker lines.

The verdict comes from what the archive is: the toolchain each object records
in its .comment section, and the symbols it defines. Never from a library
name. The archives here are built by the tests themselves (a minimal ELF32
relocatable object in an `ar` archive), so nothing depends on a toolchain.

Run from the repo root:
    python -m pytest test/backend/unit/test_espidf_precompiled_abi.py -v
"""

import asyncio
import shutil
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))

from app.services import espidf_compiler as espidf_mod  # noqa: E402
from app.services.espidf_compiler import ESPIDFCompiler  # noqa: E402

GLOBAL, WEAK = 1, 2
IDF4_GCC = 'GCC: (crosstool-NG esp-2021r2) 8.4.0'
IDF5_GCC = 'GCC: (crosstool-NG esp-14.2.0_20250730) 14.2.0'


def elf_object(symbols: dict[str, int], comment: str | None, machine: int = 94) -> bytes:
    """A 32-bit little-endian relocatable ELF object: a .text, an optional
    .comment and a symbol table defining `symbols` ({name: binding}) in .text."""
    text = b'\x00' * 4
    comment_b = (comment.encode() + b'\x00') if comment else b''
    strtab = b'\x00'
    sym_entries = [b'\x00' * 16]
    for name, bind in symbols.items():
        sym_entries.append(struct.pack('<IIIBBH', len(strtab), 0, 4, (bind << 4) | 2, 0, 1))
        strtab += name.encode() + b'\x00'
    symtab = b''.join(sym_entries)
    names = ['', '.text', '.comment', '.symtab', '.strtab', '.shstrtab']
    shstrtab = b'\x00'
    name_off = {}
    for n in names[1:]:
        name_off[n] = len(shstrtab)
        shstrtab += n.encode() + b'\x00'
    body = bytearray()
    offsets = {}
    for n, data in (('.text', text), ('.comment', comment_b), ('.symtab', symtab),
                    ('.strtab', strtab), ('.shstrtab', shstrtab)):
        while (52 + len(body)) % 4:
            body += b'\x00'
        offsets[n] = 52 + len(body)
        body += data
    while (52 + len(body)) % 4:
        body += b'\x00'
    shoff = 52 + len(body)
    shdrs = [b'\x00' * 40]
    shdrs.append(struct.pack('<IIIIIIIIII', name_off['.text'], 1, 6, 0, offsets['.text'], len(text), 0, 0, 4, 0))
    shdrs.append(struct.pack('<IIIIIIIIII', name_off['.comment'], 1, 0x30, 0, offsets['.comment'], len(comment_b), 0, 0, 1, 1))
    shdrs.append(struct.pack('<IIIIIIIIII', name_off['.symtab'], 2, 0, 0, offsets['.symtab'], len(symtab), 4, 1, 4, 16))
    shdrs.append(struct.pack('<IIIIIIIIII', name_off['.strtab'], 3, 0, 0, offsets['.strtab'], len(strtab), 0, 0, 1, 0))
    shdrs.append(struct.pack('<IIIIIIIIII', name_off['.shstrtab'], 3, 0, 0, offsets['.shstrtab'], len(shstrtab), 0, 0, 1, 0))
    ident = b'\x7fELF' + bytes([1, 1, 1, 0]) + b'\x00' * 8
    header = struct.pack('<16sHHIIIIIHHHHHH', ident, 1, machine, 1, 0, 0, shoff, 0, 52, 0, 0, 40, len(shdrs), 5)
    return header + bytes(body) + b''.join(shdrs)


def ar_archive(members: list[tuple[str, bytes]]) -> bytes:
    """A GNU `ar` archive holding `members` (short names)."""
    out = bytearray(b'!<arch>\n')
    for name, data in members:
        out += f'{name + "/":<16}{0:<12}{0:<6}{0:<6}{644:<8}{len(data):<10}`\n'.encode('ascii')
        out += data
        if len(data) % 2:
            out += b'\n'
    return bytes(out)


def write(path: Path, text: str = '// x') -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')


def make_compiler() -> ESPIDFCompiler:
    comp = ESPIDFCompiler.__new__(ESPIDFCompiler)
    comp.idf_path = ''
    comp.arduino_path = ''
    comp.has_arduino = False
    comp.idf5_path = ''
    comp.arduino5_path = ''
    comp.has_arduino5 = False
    return comp


class PrecompiledAbiBase(unittest.TestCase):
    def setUp(self):
        self._saved_roots = espidf_mod._PER_LIB_ROOTS
        espidf_mod._PER_LIB_ROOTS = True
        self.tmp = Path(tempfile.mkdtemp())
        self.arduino_libs = self.tmp / 'libraries'
        self.esp32_libs = self.tmp / 'esp32_libs'
        self.user_libs = self.tmp / 'user_libs'
        for d in (self.arduino_libs, self.esp32_libs, self.user_libs):
            d.mkdir(parents=True)
        self.comp = make_compiler()

    def tearDown(self):
        espidf_mod._PER_LIB_ROOTS = self._saved_roots
        shutil.rmtree(self.tmp)

    def library(self, members: list[tuple[str, bytes]], version: str = '3.0.0-iron') -> Path:
        lib = self.arduino_libs / f'roslike@{version}-0123456789ab'
        write(lib / 'library.properties',
              f'name=RosLike\nversion={version}\nprecompiled=true\narchitectures=esp32\n')
        write(lib / 'src' / 'RosLike.h', 'int roslike_init(void);')
        write(lib / 'src' / 'glue.cpp', '#include "RosLike.h"')
        archive = lib / 'src' / 'esp32' / 'libroslike.a'
        archive.parent.mkdir(parents=True, exist_ok=True)
        archive.write_bytes(ar_archive(members))
        return lib

    def resolve(self, idf5: bool = True):
        # ESP-IDF 5 is what every build uses unless told otherwise.
        kwargs = {} if idf5 else {'idf5': False}
        return self.comp._resolve_library_components(
            ['RosLike.h'], self.arduino_libs, self.esp32_libs,
            'arduino-esp32', self.user_libs, idf_target='esp32', **kwargs,
        )

    def linked(self) -> bool:
        cmake = self.user_libs / 'user_libs_all' / 'CMakeLists.txt'
        return cmake.is_file() and 'add_prebuilt_library' in cmake.read_text(encoding='utf-8')


class TestRefusedArchives(PrecompiledAbiBase):
    def test_an_archive_built_for_esp_idf_4_is_refused_naming_the_library(self):
        """The #214 archive: the ESP-IDF 4.x toolchain, and its own copies of
        the runtime's 64-bit atomics."""
        self.library([
            ('rcutils.c.obj', elf_object(
                {'rcutils_init': GLOBAL, '__atomic_load_8': GLOBAL, '__atomic_store_8': GLOBAL},
                IDF4_GCC)),
            ('uxr_time.c.obj', elf_object({'uxr_millis': GLOBAL}, IDF4_GCC)),
        ])
        with self.assertRaises(Exception) as ctx:
            self.resolve()
        err = ctx.exception
        self.assertIsInstance(err, espidf_mod.PrecompiledLibraryError)
        summary = str(err)
        self.assertIn('RosLike 3.0.0-iron', summary)
        self.assertIn('ESP-IDF 4', summary)
        self.assertIn('arduino-esp32 2.x', summary)
        self.assertIn('src/esp32/libroslike.a', err.details)
        self.assertIn('8.4.0', err.details)
        self.assertIn('time_t', err.details)
        self.assertIn('__atomic_load_8', err.details)
        self.assertIn('__atomic_store_8', err.details)

    def test_a_current_archive_that_defines_the_runtime_atomics_is_refused(self):
        self.library([
            ('atomics.c.obj', elf_object(
                {'lib_tick': GLOBAL, '__atomic_fetch_add_8': GLOBAL, '__sync_synchronize': GLOBAL},
                IDF5_GCC)),
        ])
        with self.assertRaises(espidf_mod.PrecompiledLibraryError) as ctx:
            self.resolve()
        self.assertIn('RosLike 3.0.0-iron', str(ctx.exception))
        self.assertIn('__atomic_fetch_add_8', ctx.exception.details)
        self.assertIn('__sync_synchronize', ctx.exception.details)
        self.assertNotIn('time_t', ctx.exception.details)


class TestArchivesThatLink(PrecompiledAbiBase):
    def test_a_current_archive_links_as_before(self):
        """A weak copy of a runtime helper yields to the C library's at link."""
        self.library([
            ('core.c.obj', elf_object({'roslike_init': GLOBAL, '__atomic_load_8': WEAK}, IDF5_GCC)),
        ])
        self.resolve()
        self.assertTrue(self.linked())

    def test_an_esp_idf_4_build_takes_an_esp_idf_4_archive(self):
        self.library([('core.c.obj', elf_object({'roslike_init': GLOBAL}, IDF4_GCC))])
        self.resolve(idf5=False)
        self.assertTrue(self.linked())

    def test_an_esp_idf_4_build_takes_an_esp_idf_5_archive_as_before(self):
        """Only with VELXIO_ARDUINO_IDF5=0 or no ESP-IDF 5 installed. No failure
        of it is known, and refusing it by toolchain alone blocked bsec2's S3
        and C3 archives, which linked before #214."""
        self.library([('core.c.obj', elf_object({'roslike_init': GLOBAL}, IDF5_GCC))])
        self.resolve(idf5=False)
        self.assertTrue(self.linked())

    def test_an_archive_without_a_build_record_links_as_before(self):
        """No .comment (a stripped archive) and no runtime helpers: nothing to
        judge by, so the link decides, as before #214."""
        self.library([('core.c.obj', elf_object({'roslike_init': GLOBAL}, None))])
        self.resolve()
        self.assertTrue(self.linked())

    def test_an_archive_that_is_not_elf_links_as_before(self):
        lib = self.library([])
        (lib / 'src' / 'esp32' / 'libroslike.a').write_bytes(b'!<arch>\nnot a real archive')
        self.resolve()
        self.assertTrue(self.linked())


class TestTheCompileSaysSo(PrecompiledAbiBase):
    def test_the_compile_fails_with_the_reason_before_cmake_runs(self):
        self.library([
            ('rcutils.c.obj', elf_object({'rcutils_init': GLOBAL, '__atomic_load_8': GLOBAL}, IDF4_GCC)),
        ])
        comp = make_compiler()
        comp.arduino5_path = str(self.tmp / 'arduino-esp32')
        comp.has_arduino5 = True
        (self.tmp / 'arduino-esp32' / 'libraries').mkdir(parents=True)
        project = self.tmp / 'project'
        shutil.copytree(espidf_mod._TEMPLATE_DIR, project)
        runs = []

        def fake_run(cmd, **kwargs):
            runs.append(cmd[0])
            return espidf_mod._RunResult(1, '', 'should not run')

        files = [{'name': 'sketch.ino',
                  'content': '#include <RosLike.h>\nvoid setup(){ roslike_init(); }\nvoid loop(){}\n'}]
        with mock.patch.object(espidf_mod, '_run_with_streaming', side_effect=fake_run):
            result = asyncio.run(comp._compile_in_dir(
                project, files, 'esp32', arduino_mode=True, use_idf5=True,
                libraries_dir=self.arduino_libs, allowed_libraries={'RosLike'},
            ))
        self.assertFalse(result.get('success'))
        self.assertIn('RosLike 3.0.0-iron', result.get('error', ''))
        self.assertIn('arduino-esp32 2.x', result.get('error', ''))
        self.assertIn('__atomic_load_8', result.get('stderr', ''))
        self.assertEqual(runs, [], 'cmake/ninja ran for a build that cannot link')


if __name__ == '__main__':
    unittest.main()
