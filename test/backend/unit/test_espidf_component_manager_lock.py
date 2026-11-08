"""The ESP-IDF component manager fetches one build at a time, and a managed
component it left without its hash file is fetched again (velxio/velxio-prod#215).

Real failure (staging, 2026-11-08, right after a deploy): two compiles of two
NEW build variants started within seconds. The first configure of a variant
has the component manager download the project's managed components into its
cache (~/.cache/Espressif/ComponentManager, shared by every build) and copy
them into the variant's managed_components/. Both downloaded esp-dsp into the
same cache directory; one copied while the other re-extracted it, and the
copy died with shutil.Error, leaving managed_components/espressif__esp-dsp
with 156 of its 497 files and no .component_hash. From then on every compile
of that variant failed at cmake ("File .component_hash or CHECKSUMS.json for
component "espressif/esp-dsp" in the managed components directory does not
exist or cannot be parsed") until the copy was deleted by hand.

These drive the real _compile_in_dir with cmake and ninja faked: the fake
cmake plays the component manager (copy what is missing, refuse a copy
without its hash file), the fake ninja fails on the user's code so the
compile stops right after the build step.

Run from the repo root:
    python -m pytest test/backend/unit/test_espidf_component_manager_lock.py -v
"""

import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from unittest import mock

BACKEND = Path(__file__).parent.parent.parent.parent / 'backend'
sys.path.insert(0, str(BACKEND))

from app.services import espidf_compiler as ec  # noqa: E402

# The component manager's own words on staging (build.cmake wraps them).
_HASH_FILE_ERROR = '''CMake Error at /opt/esp-idf-v5/tools/cmake/build.cmake:631 (message):
  ERROR: File .component_hash or CHECKSUMS.json for component
  "espressif/esp-dsp" in the managed components directory does not exist or
  cannot be parsed.  These files are used by the component manager for
  component integrity checks.  If they exist in the component source, please
  ask the component maintainer to remove them.

Call Stack (most recent call first):
  /opt/esp-idf-v5/tools/cmake/project.cmake:752 (idf_build_process)
  CMakeLists.txt:20 (project)
'''

_USER_ERROR = 'FAILED: esp-idf/main/CMakeFiles/__idf_main.dir/main.c.obj\nmain.c:1:1: error: user code\n'

# What the fake registry holds: two components, their files and hash.
_REGISTRY = {
    'espressif__esp-dsp': ['CMakeLists.txt', 'idf_component.yml', 'modules/dotprod/test/t1.c',
                           'modules/dotprod/test/t2.c', 'modules/fft/dsps_fft2r.c'],
    'espressif__cjson': ['CMakeLists.txt', 'idf_component.yml', 'cJSON/cJSON.c'],
}
_HASH = 'ed9ac175' * 8  # a valid SHA256 shape


def _copy_component(managed: Path, name: str) -> None:
    """What the component manager does for a component it has to fetch."""
    dest = managed / name
    for rel in _REGISTRY[name]:
        p = dest / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(f'// {name}/{rel}\n', encoding='utf-8')
    (dest / '.component_hash').write_text(_HASH + '\n', encoding='utf-8')


def _broken_copies(managed: Path) -> list[str]:
    if not managed.is_dir():
        return []
    return sorted(d.name for d in managed.iterdir()
                  if d.is_dir() and not (d / '.component_hash').is_file())


class _FakeToolchain:
    """cmake + ninja for _compile_in_dir. cmake refuses a managed component
    without its hash file (exactly like component manager 3.1.2) and copies
    the missing ones; ninja re-runs that check (RERUN_CMAKE) and otherwise
    fails on the user's code."""

    def __init__(self, hold_s: float = 0.0, shared: Path | None = None):
        self.hold_s = hold_s
        self.shared = shared
        self.cmake_runs: list[tuple[str, float, float]] = []
        self.overlap = False
        self._inside = 0

    def __call__(self, cmd, cwd=None, env=None, timeout=None, progress_callback=None, nice=None):
        build = Path(cwd)
        project = build.parent
        managed = project / 'managed_components'
        if Path(cmd[0]).name == 'cmake':
            t0 = time.monotonic()
            self._inside += 1
            if self._inside > 1:
                self.overlap = True
            marker = None
            if self.shared is not None:
                marker = self.shared / f'inside-{os.getpid()}-{id(build)}'
                if any(self.shared.glob('inside-*')):
                    (self.shared / f'overlap-{os.getpid()}').write_text('1')
                marker.write_text('1')
            try:
                (build / 'CMakeCache.txt').write_text('cache', encoding='utf-8')
                time.sleep(self.hold_s)
                if _broken_copies(managed):
                    return ec._RunResult(1, '', _HASH_FILE_ERROR)
                managed.mkdir(exist_ok=True)
                for name in _REGISTRY:
                    if not (managed / name).exists():
                        _copy_component(managed, name)
                (build / 'build.ninja').write_text('rules', encoding='utf-8')
                return ec._RunResult(0, '-- Configuring done', '')
            finally:
                self._inside -= 1
                if marker is not None:
                    marker.unlink(missing_ok=True)
                self.cmake_runs.append((str(project), t0, time.monotonic()))
        if _broken_copies(managed):
            return ec._RunResult(1, '[0/1] Re-running CMake...\n' + _HASH_FILE_ERROR, '')
        return ec._RunResult(1, _USER_ERROR, '')


_FILES = [{'name': 'main.c', 'content': 'void app_main(void) {}\n'}]


def _new_project(root: Path, name: str) -> Path:
    project = root / name / 'project'
    shutil.copytree(ec._TEMPLATE_DIR, project)
    (project / 'build').mkdir()
    return project


async def _compile(compiler, project: Path) -> dict:
    return await compiler._compile_in_dir(
        project, _FILES, 'esp32', pure_idf=True, arduino_mode=False, use_idf5=True,
    )


class _CacheEnv(unittest.TestCase):
    """Every test points the component manager's cache (and so the lock) at a
    temp dir: nothing here may touch the real ~/.cache/Espressif."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.cache = self.root / 'cm-cache'
        patcher = mock.patch.dict(os.environ, {'IDF_COMPONENT_CACHE_PATH': str(self.cache)})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self._tmp.cleanup)
        self.compiler = ec.ESPIDFCompiler()


class ConcurrentFirstConfigureTests(_CacheEnv):
    def test_two_cold_variants_configure_one_after_the_other(self):
        fake = _FakeToolchain(hold_s=0.3)
        a = _new_project(self.root, 'v_a')
        b = _new_project(self.root, 'v_b')

        async def run():
            return await asyncio.gather(_compile(self.compiler, a), _compile(self.compiler, b))

        with mock.patch.object(ec, '_run_with_streaming', side_effect=fake):
            results = asyncio.run(run())

        for r in results:
            self.assertIn('user code', str(r.get('error')), r)
        self.assertEqual(len(fake.cmake_runs), 2)
        self.assertFalse(
            fake.overlap,
            f'two first configures ran at once: {fake.cmake_runs}',
        )
        for name in ('v_a', 'v_b'):
            self.assertEqual(_broken_copies(self.root / name / 'project' / 'managed_components'), [])

    def test_the_lock_holds_across_processes(self):
        """Two server processes (or a replica) share the cache: the lock is a
        file lock in the cache directory, not an in-process one."""
        shared = self.root / 'shared'
        shared.mkdir()
        child = self.root / 'child.py'
        child.write_text(textwrap.dedent(f'''
            import asyncio, sys, time
            from pathlib import Path
            from unittest import mock
            sys.path.insert(0, {str(BACKEND)!r})
            sys.path.insert(0, {str(Path(__file__).parent)!r})
            from app.services import espidf_compiler as ec
            import test_espidf_component_manager_lock as spec
            shared = Path({str(shared)!r})
            me = sys.argv[1]
            project = Path(sys.argv[2])
            (shared / f'ready-{{me}}').write_text('1')
            deadline = time.monotonic() + 60
            while len(list(shared.glob('ready-*'))) < 2 and time.monotonic() < deadline:
                time.sleep(0.01)
            fake = spec._FakeToolchain(hold_s=0.8, shared=shared)
            with mock.patch.object(ec, '_run_with_streaming', side_effect=fake):
                r = asyncio.run(spec._compile(ec.ESPIDFCompiler(), project))
            (shared / f'result-{{me}}').write_text(str(r.get('error')))
        '''), encoding='utf-8')
        env = dict(os.environ, IDF_COMPONENT_CACHE_PATH=str(self.cache))
        procs = [
            subprocess.Popen(
                [sys.executable, str(child), tag, str(_new_project(self.root, f'v_{tag}'))],
                env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            )
            for tag in ('one', 'two')
        ]
        outputs = [p.communicate(timeout=180)[0].decode(errors='replace') for p in procs]
        for p, out in zip(procs, outputs):
            self.assertEqual(p.returncode, 0, out[-2000:])
        for tag in ('one', 'two'):
            self.assertIn('user code', (shared / f'result-{tag}').read_text())
        self.assertEqual(
            sorted(p.name for p in shared.glob('overlap-*')), [],
            'the two processes ran their first configure at the same time',
        )

    def test_a_warm_complete_variant_does_not_wait_for_a_fetch(self):
        """The lock is for configures that fetch: a warm variant whose managed
        components are all in place configures (VELXIO_ESPIDF_ALWAYS_CONFIGURE)
        while another build holds the lock."""
        fake = _FakeToolchain()
        warm = _new_project(self.root, 'v_warm')
        with mock.patch.object(ec, '_run_with_streaming', side_effect=fake):
            asyncio.run(_compile(self.compiler, warm))  # first configure, fetches

            async def run():
                async with ec._component_manager_lock(ec._component_cache_dir(os.environ)):
                    return await asyncio.wait_for(_compile(self.compiler, warm), timeout=20)

            with mock.patch.object(ec, '_ALWAYS_CONFIGURE', True):
                r = asyncio.run(run())
        self.assertIn('user code', str(r.get('error')))
        self.assertEqual(len(fake.cmake_runs), 2)


class BrokenManagedComponentTests(_CacheEnv):
    def test_a_copy_left_without_its_hash_file_is_fetched_again(self):
        """The #215 variant: its first configure died mid-copy (cmake had
        written CMakeCache.txt, never build.ninja) and left esp-dsp partial."""
        fake = _FakeToolchain()
        project = _new_project(self.root, 'v_b9d636fcfd28')
        managed = project / 'managed_components'
        _copy_component(managed, 'espressif__cjson')
        partial = managed / 'espressif__esp-dsp' / 'modules' / 'dotprod' / 'test'
        partial.mkdir(parents=True)
        (partial / 't1.c').write_text('// half copied\n', encoding='utf-8')
        (project / 'build' / 'CMakeCache.txt').write_text('cache', encoding='utf-8')
        intact = (managed / 'espressif__cjson' / 'cJSON' / 'cJSON.c').stat().st_ino

        with mock.patch.object(ec, '_run_with_streaming', side_effect=fake):
            first = asyncio.run(_compile(self.compiler, project))
            second = asyncio.run(_compile(self.compiler, project))

        for r in (first, second):
            self.assertIn('user code', str(r.get('error')), r)
        self.assertEqual(_broken_copies(managed), [])
        self.assertTrue((managed / 'espressif__esp-dsp' / 'CMakeLists.txt').is_file())
        # Only the broken copy was fetched again.
        self.assertEqual((managed / 'espressif__cjson' / 'cJSON' / 'cJSON.c').stat().st_ino, intact)

    def test_a_warm_variant_whose_copy_lost_its_hash_file_reconfigures(self):
        fake = _FakeToolchain()
        project = _new_project(self.root, 'v_warm')
        with mock.patch.object(ec, '_run_with_streaming', side_effect=fake):
            asyncio.run(_compile(self.compiler, project))
            dsp = project / 'managed_components' / 'espressif__esp-dsp'
            (dsp / '.component_hash').unlink()
            (dsp / 'modules' / 'fft' / 'dsps_fft2r.c').unlink()
            r = asyncio.run(_compile(self.compiler, project))
        self.assertIn('user code', str(r.get('error')), r)
        self.assertEqual(_broken_copies(project / 'managed_components'), [])
        self.assertTrue((dsp / 'modules' / 'fft' / 'dsps_fft2r.c').is_file())

    def test_which_copies_count_as_broken(self):
        managed = self.root / 'managed_components'
        _copy_component(managed, 'espressif__cjson')
        (managed / 'espressif__esp-dsp').mkdir()
        bad_hash = managed / 'espressif__mdns'
        bad_hash.mkdir()
        (bad_hash / '.component_hash').write_text('not a hash\n', encoding='utf-8')
        (managed / 'stray.txt').write_text('a file, not a component', encoding='utf-8')
        self.assertEqual(
            sorted(p.name for p in ec._broken_managed_components(managed.parent)),
            ['espressif__esp-dsp', 'espressif__mdns'],
        )
        self.assertEqual(ec._broken_managed_components(self.root / 'nowhere'), [])

    def test_the_hash_file_message_names_the_component(self):
        self.assertEqual(ec._corrupt_managed_component(_HASH_FILE_ERROR), 'espressif/esp-dsp')


class CacheDirTests(unittest.TestCase):
    def test_the_lock_lives_with_the_component_managers_cache(self):
        self.assertEqual(
            ec._component_cache_dir({'IDF_COMPONENT_CACHE_PATH': '/srv/cm', 'HOME': '/root'}),
            Path('/srv/cm'),
        )
        if not sys.platform.startswith(('win', 'darwin')):
            self.assertEqual(
                ec._component_cache_dir({'HOME': '/root'}),
                Path('/root/.cache/Espressif/ComponentManager'),
            )
            self.assertEqual(
                ec._component_cache_dir({'HOME': '/root', 'XDG_CACHE_HOME': '/xdg'}),
                Path('/xdg/Espressif/ComponentManager'),
            )


if __name__ == '__main__':
    unittest.main()
