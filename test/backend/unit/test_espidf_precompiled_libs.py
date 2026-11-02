"""
Precompiled Arduino libraries in the ESP-IDF sketch build (velxio/velxio-prod#87).

The Arduino library specification lets a library ship archives instead of (or
next to) its sources: `precompiled=true` or `precompiled=full` in
library.properties, and the archives under `src/<build.mcu>/`. arduino-cli
links whatever that folder holds for the board being built (`-L<folder>`, one
`-l` per lib*.a, any other .a as an object), adds the library's `ldflags`, and
for `full` skips the sources when the folder exists. Without the folder it
compiles the sources as it would for any library.

The merged `user_libs_all` component used to copy and compile the sources only,
so a sketch on such a library died at the link: micro_ros_arduino 3.0.0-iron
ships its whole ROS 2 client as src/esp32/libmicroros.a, and an ESP32 sketch on
it stopped with 23 undefined references (rclc_support_init, rcl_publish,
rmw_uros_set_custom_transport, ...), every one defined in that archive.

These tests drive the real resolver on a generic fixture library and read the
CMakeLists it writes. The decision must come from library.properties and the
folder layout, never from a library name.

Run from the repo root:
    python -m pytest test/backend/unit/test_espidf_precompiled_libs.py -v
"""

import inspect
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))

from app.services import espidf_compiler as espidf_mod
from app.services.espidf_compiler import ESPIDFCompiler


def make_compiler() -> ESPIDFCompiler:
    comp = ESPIDFCompiler.__new__(ESPIDFCompiler)
    comp.idf_path = ''
    comp.arduino_path = ''
    comp.has_arduino = False
    comp.idf5_path = ''
    comp.arduino5_path = ''
    comp.has_arduino5 = False
    return comp


def write(path: Path, text: str = '// x') -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')


def write_archive(path: Path, tag: str) -> bytes:
    """A stand-in archive: the tests only follow where it is copied and named."""
    data = b'!<arch>\n' + tag.encode('ascii')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


class PrecompiledBase(unittest.TestCase):
    """A mixed library: open glue compiled from src/, a core shipped per MCU."""

    PROPS = 'name=MixedCore\nversion=1.0.0\nprecompiled=true\narchitectures=*\n'

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

        self.lib = self.arduino_libs / 'mixedcore@1.0.0-0123456789ab'
        write(self.lib / 'library.properties', self.PROPS)
        write(self.lib / 'src' / 'MixedCore.h', 'int mixed_core_answer(void);')
        write(self.lib / 'src' / 'mixed_glue.cpp', '#include "MixedCore.h"')
        self.archives = {
            mcu: write_archive(self.lib / 'src' / mcu / 'libmixedcore.a', mcu)
            for mcu in ('esp32', 'esp32s3', 'esp32c3', 'esp32p4', 'esp32c5', 'cortex-m4')
        }

        # An ordinary library next to it, so the component always has sources
        # of its own unless a test removes them.
        plain = self.arduino_libs / 'PlainLib'
        write(plain / 'library.properties', 'name=PlainLib\narchitectures=*\n')
        write(plain / 'src' / 'PlainLib.h')
        write(plain / 'src' / 'PlainLib.cpp')

    def tearDown(self):
        espidf_mod._PER_LIB_ROOTS = self._saved_roots
        shutil.rmtree(self.tmp)

    def resolve(self, headers, target):
        return self.comp._resolve_library_components(
            headers, self.arduino_libs, self.esp32_libs,
            'arduino-esp32', self.user_libs, idf_target=target,
        )

    @property
    def comp_dir(self) -> Path:
        return self.user_libs / 'user_libs_all'

    def cmake_text(self) -> str:
        return (self.comp_dir / 'CMakeLists.txt').read_text(encoding='utf-8')

    def prebuilt(self) -> list[tuple[str, Path]]:
        """(target, archive on disk) for each add_prebuilt_library()."""
        out = []
        for name, path in re.findall(
            r'add_prebuilt_library\(\s*(\S+)\s+"([^"]+)"', self.cmake_text()
        ):
            path = path.replace('${CMAKE_CURRENT_LIST_DIR}', str(self.comp_dir))
            p = Path(path)
            out.append((name, p if p.is_absolute() else self.comp_dir / p))
        return out

    def linked_items(self) -> list[tuple[str, list[str]]]:
        """(keyword, items) for each target_link_libraries(${COMPONENT_LIB} ...)."""
        out = []
        for kw, items in re.findall(
            r'target_link_libraries\(\$\{COMPONENT_LIB\}\s+(PUBLIC|PRIVATE|INTERFACE)\s+([^)]*)\)',
            self.cmake_text(),
        ):
            out.append((kw, re.findall(r'"([^"]*)"|(\S+)', items)))
        return [(kw, [a or b for a, b in toks]) for kw, toks in out]

    def srcs(self) -> list[str]:
        m = re.search(r'SRCS ([^\n]*)', self.cmake_text())
        return re.findall(r'"([^"]+)"', m.group(1)) if m else []


class TestPrecompiledTrue(PrecompiledBase):
    """precompiled=true: the archive for the target is linked AND the sources build."""

    def test_the_archive_for_the_target_is_linked(self):
        """Fail-before: the CMakeLists named no archive and the link had 23 undefined references."""
        self.resolve(['MixedCore.h'], 'esp32')
        pre = self.prebuilt()
        self.assertEqual(len(pre), 1, f'expected one prebuilt archive, got {pre}')
        name, path = pre[0]
        self.assertTrue(path.is_file(), f'{path} is not in the component')
        self.assertEqual(
            path.read_bytes(), self.archives['esp32'],
            'the archive copied is not the one the library ships for esp32',
        )
        self.assertIn(
            name, [i for _, items in self.linked_items() for i in items],
            f'{name} is declared but never linked to the component',
        )

    def test_each_target_links_its_own_mcu_folder(self):
        """build.mcu is the IDF target for every chip the compiler builds."""
        for target in ('esp32s3', 'esp32c3', 'esp32p4', 'esp32c5'):
            with self.subTest(target=target):
                shutil.rmtree(self.comp_dir, ignore_errors=True)
                self.resolve(['MixedCore.h'], target)
                pre = self.prebuilt()
                self.assertEqual(len(pre), 1, f'{target}: {pre}')
                self.assertEqual(pre[0][1].read_bytes(), self.archives[target])

    def test_other_mcus_archives_are_not_copied(self):
        self.resolve(['MixedCore.h'], 'esp32')
        copied = [p for p in self.comp_dir.rglob('*.a')]
        self.assertEqual(len(copied), 1, f'only the target archive belongs here: {copied}')

    def test_the_sources_still_compile(self):
        """true is a mixed library: arduino-cli always compiles its sources."""
        self.resolve(['MixedCore.h'], 'esp32')
        self.assertTrue(
            any(s.endswith('src/mixed_glue.cpp') for s in self.srcs()),
            f'the open part of the library was dropped: {self.srcs()}',
        )

    def test_the_archive_can_call_back_into_the_component(self):
        """Like IDF's own blobs: the archive requires its component, so a
        callback a library source defines resolves whatever the link order."""
        self.resolve(['MixedCore.h'], 'esp32')
        m = re.search(r'add_prebuilt_library\([^)]*REQUIRES ([^)]*)\)', self.cmake_text())
        self.assertIsNotNone(m, 'the prebuilt library names no REQUIRES')
        reqs = m.group(1).split()
        self.assertIn('${COMPONENT_NAME}', reqs)
        self.assertIn('arduino-esp32', reqs)

    def test_a_target_without_a_folder_links_nothing(self):
        """No src/esp32c6/: arduino-cli says 'not found' and builds the sources."""
        self.resolve(['MixedCore.h'], 'esp32c6')
        self.assertEqual(self.prebuilt(), [])
        self.assertTrue(any(s.endswith('src/mixed_glue.cpp') for s in self.srcs()))

    def test_an_unknown_target_links_nothing(self):
        """A caller that does not name the target gets the old behaviour."""
        self.comp._resolve_library_components(
            ['MixedCore.h'], self.arduino_libs, self.esp32_libs,
            'arduino-esp32', self.user_libs,
        )
        self.assertEqual(self.prebuilt(), [])

    def test_the_legacy_layout_links_it_too(self):
        """VELXIO_PER_LIB_ROOTS=0 interleaves the sources, not the archives."""
        espidf_mod._PER_LIB_ROOTS = False
        self.resolve(['MixedCore.h'], 'esp32')
        pre = self.prebuilt()
        self.assertEqual(len(pre), 1, pre)
        self.assertEqual(pre[0][1].read_bytes(), self.archives['esp32'])

    def test_a_flat_library_keeps_its_archives_beside_its_sources(self):
        """No src/: the source dir is the library root, so is the mcu folder."""
        flat = self.arduino_libs / 'FlatCore'
        write(flat / 'library.properties', 'name=FlatCore\nprecompiled=true\n')
        write(flat / 'FlatCore.h')
        write(flat / 'FlatCore.cpp')
        data = write_archive(flat / 'esp32' / 'libflatcore.a', 'flat')
        self.resolve(['FlatCore.h'], 'esp32')
        pre = self.prebuilt()
        self.assertEqual(len(pre), 1, pre)
        self.assertEqual(pre[0][1].read_bytes(), data)
        self.assertTrue(any(s.endswith('FlatCore.cpp') for s in self.srcs()))

    def test_the_compile_passes_its_target(self):
        """The one real call site must hand the resolver the IDF target."""
        src = inspect.getsource(ESPIDFCompiler._compile_in_dir)
        call = src[src.index('self._resolve_library_components'):]
        call = call[:call.index(')')]
        self.assertIn('idf_target=idf_target', call)


class TestPrecompiledFull(PrecompiledBase):
    """precompiled=full: the archive replaces the sources when it exists."""

    PROPS = 'name=MixedCore\nversion=1.0.0\nprecompiled=full\narchitectures=*\n'

    def test_sources_are_not_compiled_when_the_archive_exists(self):
        self.resolve(['MixedCore.h'], 'esp32')
        self.assertEqual(len(self.prebuilt()), 1)
        self.assertFalse(
            any(s.endswith('src/mixed_glue.cpp') for s in self.srcs()),
            'full + archive: arduino-cli does not compile the sources',
        )
        self.assertTrue(
            list(self.comp_dir.rglob('MixedCore.h')),
            'the headers must still be there for the sketch',
        )

    def test_sources_are_the_fallback_without_the_archive(self):
        self.resolve(['MixedCore.h'], 'esp32c6')
        self.assertEqual(self.prebuilt(), [])
        self.assertTrue(any(s.endswith('src/mixed_glue.cpp') for s in self.srcs()))

    def test_a_component_with_no_sources_links_through_its_interface(self):
        """Only the full library merged: no SRCS, so an INTERFACE library,
        where PUBLIC/PRIVATE is a CMake error."""
        self.resolve(['MixedCore.h'], 'esp32')
        self.assertEqual(self.srcs(), [])
        kws = {kw for kw, _ in self.linked_items()}
        self.assertEqual(kws, {'INTERFACE'}, self.cmake_text())
        self.assertNotIn('PRIVATE', self.cmake_text())
        self.assertNotIn('${COMPONENT_NAME}', self.cmake_text(),
                         'an INTERFACE component has nothing to call back into')


class TestLdflagsAndArchiveNames(PrecompiledBase):

    PROPS = (
        'name=MixedCore\nversion=1.0.0\nprecompiled=true\n'
        'ldflags=-lmixedcore -lm\narchitectures=*\n'
    )

    def test_ldflags_are_added_with_the_folder_on_the_search_path(self):
        self.resolve(['MixedCore.h'], 'esp32')
        flags = [i for kw, items in self.linked_items() if kw == 'INTERFACE' for i in items]
        self.assertIn('-lmixedcore', flags)
        self.assertIn('-lm', flags)
        m = re.search(r'target_link_directories\(\$\{COMPONENT_LIB\}\s+INTERFACE\s+"([^"]+)"\)',
                      self.cmake_text())
        self.assertIsNotNone(m, '-lmixedcore needs the folder on the search path')
        folder = Path(m.group(1).replace('${CMAKE_CURRENT_LIST_DIR}', str(self.comp_dir)))
        self.assertTrue((folder / 'libmixedcore.a').is_file())

    def test_ldflags_need_the_folder_for_the_target(self):
        """arduino-cli applies ldflags only when it found the precompiled folder."""
        self.resolve(['MixedCore.h'], 'esp32c6')
        self.assertNotIn('-lmixedcore', self.cmake_text())
        self.assertNotIn('target_link_directories', self.cmake_text())

    def test_an_archive_without_the_lib_prefix_is_linked_too(self):
        write_archive(self.lib / 'src' / 'esp32' / 'mixed_extra.a', 'extra')
        self.resolve(['MixedCore.h'], 'esp32')
        names = sorted(p.name for _, p in self.prebuilt())
        self.assertEqual(names, ['libmixedcore.a', 'mixed_extra.a'])

    def test_a_flag_that_could_break_out_of_cmake_is_dropped(self):
        write(self.lib / 'library.properties',
              'name=MixedCore\nprecompiled=true\nldflags=-lm ") message(FATAL_ERROR x\n')
        self.resolve(['MixedCore.h'], 'esp32')
        text = self.cmake_text()
        self.assertNotIn('message(', text)
        self.assertIn('"-lm"', text)


class TestNotPrecompiled(PrecompiledBase):
    """An archive alone means nothing: arduino-cli needs precompiled= to link it."""

    PROPS = 'name=MixedCore\nversion=1.0.0\narchitectures=*\n'

    def test_archives_of_an_ordinary_library_are_ignored(self):
        self.resolve(['MixedCore.h'], 'esp32')
        self.assertEqual(self.prebuilt(), [])
        self.assertEqual(list(self.comp_dir.rglob('*.a')), [])

    def test_ordinary_libraries_write_the_same_cmakelists_as_before(self):
        self.resolve(['PlainLib.h'], 'esp32')
        text = self.cmake_text()
        self.assertNotIn('add_prebuilt_library', text)
        self.assertNotIn('target_link_libraries', text)
        self.assertNotIn('target_link_directories', text)


if __name__ == '__main__':
    unittest.main()
