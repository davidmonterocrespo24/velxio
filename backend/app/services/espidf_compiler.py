"""
ESP-IDF Compilation Service for ESP32 targets.

Replaces arduino-cli for ESP32/ESP32-C3 compilation.  User Arduino sketches
are compiled using ESP-IDF (with optional Arduino-as-component) to produce
firmware that boots reliably in the lcgamboa QEMU fork.

The key difference vs arduino-cli: ESP-IDF gives control over bootloader,
sdkconfig, and flash mapping — all of which must be QEMU-compatible.

Two compilation modes:
  1. Arduino-as-component: Full Arduino API (WiFi.h, WebServer.h, etc.)
     compiled through idf.py.  Requires ARDUINO_ESP32_PATH env var.
  2. Pure ESP-IDF: Translates common Arduino patterns to ESP-IDF C APIs.
     Fallback when Arduino component is not installed.
"""
import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import shutil
import string
import subprocess
import tempfile
import threading
import time
from collections import deque
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable, Optional

from app.core.hooks import materialize_library_scope, scope_retry_allowed

logger = logging.getLogger(__name__)

# Per-task timing of the LAST compile() call: how long it waited for its build
# dir, whether the configure was skipped, and how long cmake / ninja ran. The
# compile route reads it right after `await compile()` (same asyncio task, so
# the ContextVar is visible) and folds it into the usage metric. Kept out of
# the result dict on purpose: the result is what the client receives, and the
# wait behind another build is an operator number, not a user one.
build_timing: ContextVar[Optional[dict]] = ContextVar('espidf_build_timing', default=None)


def _timing_note(**fields) -> None:
    current = build_timing.get() or {}
    current.update(fields)
    build_timing.set(current)


# Set VELXIO_ESPIDF_ALWAYS_CONFIGURE=1 to run `cmake` before every ninja run
# (the pre-2026-09 behaviour) without rebuilding the image. The default lets a
# warm build dir go straight to ninja, which re-runs cmake by itself when a
# configure input changed (build.ninja's RERUN_CMAKE rule).
_ALWAYS_CONFIGURE = (
    os.environ.get('VELXIO_ESPIDF_ALWAYS_CONFIGURE', '')
    in ('1', 'true', 'True', 'yes')
)


def _write_if_changed(path: Path, text: str) -> bool:
    """Write `text` to `path` only when the bytes differ. Returns True if written.

    Every generated file that cmake lists as a configure dependency
    (partitions.csv, velxio_board.cmake, a component's CMakeLists.txt) must go
    through here: an unconditional write bumps the mtime, and ninja's
    RERUN_CMAKE rule then re-runs the whole configure for a file that did not
    change. That configure is 60% of a warm ESP32 build (measured 2026-09-04).
    """
    try:
        if path.exists() and path.read_text(encoding='utf-8') == text:
            return False
    except (OSError, UnicodeDecodeError):
        pass
    path.write_text(text, encoding='utf-8')
    return True


# Location of the ESP-IDF project template (relative to this file)
_TEMPLATE_DIR = Path(__file__).parent / 'esp-idf-template'

# ── Persistent build dir ─────────────────────────────────────────────────────
# Cold ESP-IDF compiles rebuild ~1480 base objects (FreeRTOS, lwIP, esp_wifi,
# libsodium, …). The default tempfile.TemporaryDirectory flow gave each compile
# a fresh path under /tmp/espidf_<random>/, which baked into -I and
# -fmacro-prefix-map flags and made ccache 0% effective (different cwd → hash
# miss every time). With the persistent dir, /var/lib/velxio-build/<target>/
# is a stable anchor: ninja's incremental cache + ccache hits combine to bring
# warm compiles down to ~5-30s.
#
# Concurrent compiles in the SAME variant dir would corrupt it; they're
# serialised by _variant_lock below (one lock per variant, or per replica of a
# variant). Different variants of one target, and different targets, run in
# parallel up to the build queue's slot count.
#
# Set VELXIO_PERSISTENT_BUILD_DIR=0 to fall back to the legacy tempfile flow
# without rebuilding the image (escape hatch if the persistent dir misbehaves
# in production).
_BUILD_ROOT = Path(os.environ.get('VELXIO_BUILD_ROOT', '/var/lib/velxio-build'))
_USE_PERSISTENT_DIR = (
    os.environ.get('VELXIO_PERSISTENT_BUILD_DIR', '1')
    not in ('0', 'false', 'False', '')
)


# ── Per-library include roots (Arduino-faithful layout) ──────────────────────
# The merged `user_libs_all` component used to copy every library's files into
# ONE interleaved tree and then put EVERY directory that held a file on the
# component's public INCLUDE_DIRS. That is the root cause of the header-shadow
# bug class: a library's private internals — FastLED's host-test
# `src/platforms/stub/Arduino.h`, its `src/fl/stl/asio/http/http_parser.h`,
# LovyanGFX's `src/lgfx/internal/limits.h` — landed on the global -I and
# hijacked `#include`s issued by OTHER libraries, by the arduino-esp32 core and
# by ESP-IDF itself. Every fix was another name in `_SHADOW_STD_HEADERS`, i.e.
# chasing symptoms: the denylist grows with every library that ships a
# generically-named internal header.
#
# arduino-cli — the resolver every other Velxio board family already delegates
# to — shares one global -I list too, but adds exactly ONE directory per
# library: `<lib>/src` for the recursive layout, `<lib>` for the legacy flat
# one, never a subdirectory (its header index is non-recursive, so
# `src/sub/foo.h` is only ever reachable as `<sub/foo.h>`). `utility/` stays
# private to the library that owns it. arduino-esp32 does the same as an IDF
# component: one public include dir per bundled library.
#
# So: keep the single component — a component per library would trade this bug
# for REQUIRES-order shadowing (IDF exports component includes as plain -I,
# never -isystem) plus IDF-component name collisions — but give each library
# its own subtree and publish only its include root.
#
# Set VELXIO_PER_LIB_ROOTS=0 to fall back to the legacy interleaved layout
# without rebuilding the image (rollback hatch).
_PER_LIB_ROOTS = (
    os.environ.get('VELXIO_PER_LIB_ROOTS', '1')
    not in ('0', 'false', 'False', '')
)


# Directories a library ships that are never compiled: documentation and
# support material per the Arduino library spec. Headers found ONLY here do
# not get to add dependencies to the build (see the transitive scan below).
_SUPPORT_ONLY_DIRS = frozenset({
    'extras', 'examples', 'example', 'test', 'tests', 'docs', 'doc',
    'benchmark', 'benchmarks', 'fuzz', 'fuzzing', 'ci',
})

# A compiled source reaching into one of those dirs, e.g. FirebaseJson's
# `#include "extras/print/printf.h"` or FastLED's unity build.
_SUPPORT_INCLUDE_RE = re.compile(
    r'#\s*include\s*[<"][^">]*\b(?:%s)/' % '|'.join(sorted(_SUPPORT_ONLY_DIRS)),
    re.IGNORECASE,
)


def _sanitise_lib_dirname(name: str) -> str:
    """Component-relative directory name for a library.

    Cache folder names carry `@version-hash` suffixes (`fastled@3.10.5-017d…`)
    and user libs can be named anything; keep the characters that are safe in a
    path AND inside a quoted CMake string, fold the rest.
    """
    safe = re.sub(r'[^A-Za-z0-9_.@-]', '_', name).strip('.')
    return safe or 'lib'


def _idf_version_signature() -> str:
    """Snapshot of the ESP-IDF + arduino-esp32 toolchain version. Used to
    invalidate persistent build dirs after an upstream submodule bump (the
    cached object files on disk are no longer ABI-compatible)."""
    parts = []
    idf_version_file = Path('/opt/esp-idf/version.txt')
    if idf_version_file.exists():
        parts.append(idf_version_file.read_text(encoding='utf-8').strip())
    arduino_version_file = Path('/opt/arduino-esp32/version.txt')
    if arduino_version_file.exists():
        parts.append(arduino_version_file.read_text(encoding='utf-8').strip())
    if not parts:
        # Fall back to mtime of the IDF tree root — coarse but stable per
        # image build.
        try:
            parts.append(str(int(Path('/opt/esp-idf').stat().st_mtime)))
        except OSError:
            parts.append('unknown')
    return '|'.join(parts)


# Type for live progress callback. Called from a worker thread for every
# stdout/stderr line as the build runs. Implementations should be cheap and
# thread-safe (callers commonly stash lines into a dict shared with the main
# event loop). Exceptions raised from the callback are swallowed so a faulty
# UI hook can never break the build.
ProgressCallback = Callable[[str], None]


@dataclass
class _RunResult:
    """Drop-in replacement for the fields we read off subprocess.CompletedProcess."""
    returncode: int
    stdout: str
    stderr: str


def _nice_preexec(nice: int | None):
    """preexec_fn that lowers the child's CPU priority. None = inherit.

    The API and the simulation WebSockets share the box with the compilers;
    a positive nice keeps them responsive under a full CPU, and a per-job
    value lets the overlay rank a paid build's processes above an anonymous
    one's (weights 1024 vs 110 between nice 0 and nice 10) without ever
    stopping or interrupting anyone.
    """
    if not nice or os.name == 'nt':
        return None

    def _apply() -> None:
        try:
            os.nice(int(nice))
        except OSError:
            pass
    return _apply


def _run_with_streaming(
    cmd: list[str],
    *,
    cwd: str,
    env: dict[str, str],
    timeout: float,
    progress_callback: Optional[ProgressCallback],
    nice: int | None = None,
) -> _RunResult:
    """Run `cmd` synchronously and stream stdout + stderr line-by-line.

    Behaves like subprocess.run(capture_output=True, text=True) but invokes
    `progress_callback(line)` for every line as it arrives. When
    progress_callback is None this falls back to a single subprocess.run call
    so we don't pay the threading cost on the unit-test path that doesn't
    care about live output.

    Raises subprocess.TimeoutExpired on timeout (matches the existing flow).
    """
    preexec = _nice_preexec(nice)
    if progress_callback is None:
        cp = subprocess.run(
            cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout,
            preexec_fn=preexec,
        )
        return _RunResult(returncode=cp.returncode, stdout=cp.stdout, stderr=cp.stderr)

    proc = subprocess.Popen(
        cmd,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,  # line-buffered
        preexec_fn=preexec,
    )
    stdout_lines: list[str] = []
    stderr_lines: list[str] = []

    def _drain(stream, sink: list[str]) -> None:
        try:
            for line in iter(stream.readline, ''):
                sink.append(line)
                try:
                    progress_callback(line)
                except Exception:
                    # A faulty progress sink must never break the build.
                    pass
        finally:
            try:
                stream.close()
            except Exception:
                pass

    t_out = threading.Thread(target=_drain, args=(proc.stdout, stdout_lines), daemon=True)
    t_err = threading.Thread(target=_drain, args=(proc.stderr, stderr_lines), daemon=True)
    t_out.start()
    t_err.start()

    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        # Give drain threads a chance to flush before we raise.
        t_out.join(timeout=2)
        t_err.join(timeout=2)
        raise

    t_out.join(timeout=5)
    t_err.join(timeout=5)
    return _RunResult(
        returncode=proc.returncode,
        stdout=''.join(stdout_lines),
        stderr=''.join(stderr_lines),
    )


# How many distinct build variants to keep per target before LRU-evicting the
# coldest. Each variant is a full ESP-IDF build tree (~240 MB). Distinct
# variants = distinct (board options x resolved library set). The global ccache
# means an evicted-then-rebuilt variant warms up in seconds.
# Was 12. Each variant is a FULL ~1 GB build tree holding its own copies of
# the same ESP-IDF component objects, so 46 of them had grown to 25 GB while
# ccache - the cache that actually serves EVERY target and variant - sat
# capped at 8 GB, permanently full (99.97%, 153 evictions, 47% hit rate).
# Fewer trees, a bigger shared cache: a variant that gets evicted rebuilds
# quickly FROM ccache, but a ccache miss recompiles from source.
_MAX_BUILD_VARIANTS = 6


def _max_build_variants(idf_target: str) -> int:
    """Variant cap for one target: VELXIO_BUILD_VARIANTS_<TARGET> (e.g.
    VELXIO_BUILD_VARIANTS_ESP32), else VELXIO_BUILD_VARIANTS, else the module
    default. Per target because the hot target on velxio.dev rotates through
    10 distinct variants in half an hour while the others idle at two."""
    for name in (f'VELXIO_BUILD_VARIANTS_{idf_target.upper()}', 'VELXIO_BUILD_VARIANTS'):
        raw = os.environ.get(name, '').strip()
        if raw:
            try:
                return max(1, min(64, int(raw)))
            except ValueError:
                logger.warning(f'[espidf] {name}={raw!r} is not an integer; ignored')
    return _MAX_BUILD_VARIANTS


# ── Replicas of a hot variant ────────────────────────────────────────────────
# Two compiles that hash to the SAME variant serialise on its lock, and on
# velxio.dev the dominant configuration (the default esp32 blink, no
# libraries) is 78% of all ESP-IDF builds: the second heavy slot spent its time
# holding a slot while waiting for the first one's directory. A replica is a
# second full copy of the variant (`v_<hash>_r1`), configured on first use and
# then as warm as the original, with its own lock. A compile picks the first
# replica whose lock is free. Replicas are only CREATED after the variant has
# been found busy a few times in a short window, so a one-off library
# combination never earns a second 400 MB tree.
def _variant_replicas() -> int:
    raw = os.environ.get('VELXIO_BUILD_VARIANT_REPLICAS', '').strip()
    if not raw:
        return 1
    try:
        return max(1, min(8, int(raw)))
    except ValueError:
        logger.warning(f'[espidf] VELXIO_BUILD_VARIANT_REPLICAS={raw!r} is not an integer; using 1')
        return 1


_REPLICA_COLLISION_THRESHOLD = 3     # busy hits before a new replica is created
_REPLICA_COLLISION_WINDOW_S = 600.0  # ...within this many seconds
_VARIANT_COLLISIONS: dict[str, deque] = {}
#: Lock keys of replicas being built in the background right now. A replica
#: is warmed by a background compile of the SAME sources (so its configure
#: matches the variant) rather than by the user's job that hit the collision:
#: a cold build is 30-75 s and that job would rather wait a few seconds for
#: the original. While warming, the replica is neither picked nor re-created.
_WARMING_REPLICAS: set[str] = set()
_BACKGROUND_TASKS: set = set()


def _note_variant_collision(base_key: str) -> bool:
    """Record that every replica of `base_key` was busy. True when the streak
    is long enough to justify creating the next replica."""
    now = time.monotonic()
    hits = _VARIANT_COLLISIONS.setdefault(base_key, deque())
    hits.append(now)
    while hits and now - hits[0] > _REPLICA_COLLISION_WINDOW_S:
        hits.popleft()
    return len(hits) >= _REPLICA_COLLISION_THRESHOLD


def _variant_dir_name(variant_key: str, replica: int = 0) -> str:
    safe = ''.join(c for c in variant_key if c.isalnum() or c in '-_')[:40] or 'default'
    return 'v_' + safe + (f'_r{replica}' if replica else '')


def _variant_lock_key(idf_target: str, variant_key: str, replica: int = 0) -> str:
    base = f'{idf_target}/{variant_key}'
    return base if not replica else f'{base}/r{replica}'


_VARIANT_DIR_RE = re.compile(r'^v_(.+?)(?:_r(\d+))?$')


def _lock_key_for_variant_dir(idf_target: str, dirname: str) -> str | None:
    """Inverse of _variant_dir_name: the lock key a `v_*` directory is built
    under, so eviction can tell whether someone is compiling in it."""
    m = _VARIANT_DIR_RE.match(dirname)
    if not m:
        return None
    return _variant_lock_key(idf_target, m.group(1), int(m.group(2) or 0))


# One compile at a time per build variant. The build queue bounds how many
# compiles run at once, not WHERE they run: two requests that hash to the same
# variant (the deploy gate's smoke fired the S3 OLED example twice, 13 s
# apart) shared one project dir, and the second configure walked into the
# first one's half-copied managed component. The component manager then
# reported it "corrupted" on every later attempt, and that variant was dead
# until someone deleted it by hand (2026-09-03).
_VARIANT_LOCKS: dict[str, asyncio.Lock] = {}
_VARIANT_LOCKS_GUARD = threading.Lock()


def _variant_lock(key: str) -> asyncio.Lock:
    """The lock that serialises compiles inside one persistent build variant."""
    with _VARIANT_LOCKS_GUARD:
        lock = _VARIANT_LOCKS.get(key)
        if lock is None:
            lock = _VARIANT_LOCKS[key] = asyncio.Lock()
        return lock


_CORRUPT_COMPONENT_RE = re.compile(
    r'The downloaded component "([^"]+)"\s+is\s+corrupted', re.IGNORECASE
)


def _corrupt_managed_component(stderr: str | None) -> str | None:
    """Name of the managed component the IDF component manager refused as
    corrupted (its message wraps across lines), or None for any other cmake
    failure."""
    m = _CORRUPT_COMPONENT_RE.search(stderr or '')
    return m.group(1) if m else None


def _heal_corrupt_managed_components(project_dir: Path, build_dir: Path) -> bool:
    """Drop the variant's managed_components/ (the component manager copies
    them back from its own intact cache on the next configure) and the cmake
    cache that recorded them. Returns True when there was something to drop."""
    removed = False
    managed = project_dir / 'managed_components'
    if managed.exists():
        shutil.rmtree(managed, ignore_errors=True)
        removed = True
    cache = build_dir / 'CMakeCache.txt'
    if cache.exists():
        cache.unlink(missing_ok=True)
        removed = True
    return removed


def _evict_cold_variants(target_dir: Path, keep: int, idf_target: str | None = None) -> None:
    """LRU-evict variant dirs (``v_*``) beyond ``keep``, coldest mtime first.

    Never evicts a variant whose lock is held: with two compiles of one target
    running at once (different variants, or replicas of one), the coldest
    sibling by mtime can be the one a long cold build is still writing into.
    Its mtime is stamped at prepare time and again when its build finishes
    (see _attempt), so a variant only looks cold once it has been idle.
    """
    try:
        variants = [
            d for d in target_dir.iterdir()
            if d.is_dir() and d.name.startswith('v_')
        ]
    except OSError:
        return
    if len(variants) <= keep:
        return
    target = idf_target or target_dir.name

    def _busy(d: Path) -> bool:
        key = _lock_key_for_variant_dir(target, d.name)
        if key is None:
            return False
        with _VARIANT_LOCKS_GUARD:
            lock = _VARIANT_LOCKS.get(key)
        return bool(lock is not None and lock.locked())

    variants.sort(key=lambda d: d.stat().st_mtime if d.exists() else 0.0)
    excess = len(variants) - keep
    for d in variants:
        if excess <= 0:
            break
        if _busy(d):
            logger.info(f'[espidf] not evicting {d.name}: a compile holds its lock')
            continue
        logger.info(f'[espidf] LRU-evicting cold build variant {d.name}')
        shutil.rmtree(d, ignore_errors=True)
        excess -= 1


def _ninja_parallelism_args() -> list[str]:
    """`-j N` / `-l L` for ninja from VELXIO_NINJA_JOBS / VELXIO_NINJA_LOAD_LIMIT.

    Unset (the OSS default) leaves ninja's own choice, nproc + 2. velxio.dev
    runs two heavy slots on 6 vCPU, where two such ninjas plus the light lane
    measured 34 runnable compiler threads at peak; the deployment caps them
    in docker-compose.yml. `-l` throttles on the 1-minute load average, so a
    build alone still gets the whole box.
    """
    args: list[str] = []
    raw_jobs = os.environ.get('VELXIO_NINJA_JOBS', '').strip()
    if raw_jobs:
        try:
            jobs = int(raw_jobs)
            if jobs > 0:
                args += ['-j', str(jobs)]
        except ValueError:
            logger.warning(f'[espidf] VELXIO_NINJA_JOBS={raw_jobs!r} is not an integer; ignored')
    raw_load = os.environ.get('VELXIO_NINJA_LOAD_LIMIT', '').strip()
    if raw_load:
        try:
            load = float(raw_load)
            if load > 0:
                args += ['-l', str(load)]
        except ValueError:
            logger.warning(f'[espidf] VELXIO_NINJA_LOAD_LIMIT={raw_load!r} is not a number; ignored')
    return args


_CONFIGURE_TROUBLE_MARKERS = (
    'CMake Error',
    'ninja: error',
    'missing and no known rule to make it',
    'error: loading \'build.ninja\'',
)


def _ninja_failure_wants_configure(result: _RunResult) -> bool:
    """True when a failed ninja run on a warm dir looks like a configure
    problem (cmake re-run failed, an input vanished, a manifest changed) rather
    than a compiler error in the user's code. The fast path falls back to the
    explicit configure exactly once on these."""
    text = (result.stdout or '') + '\n' + (result.stderr or '')
    if _corrupt_managed_component(text):
        return True
    return any(marker in text for marker in _CONFIGURE_TROUBLE_MARKERS)


def _ninja_log_step_count(build_dir: 'str | Path') -> int:
    """Number of completed build steps recorded in ``build_dir/.ninja_log``
    (0 when absent/unreadable). Diagnostics only — used to say how far a
    timed-out build got."""
    try:
        with open(Path(build_dir) / '.ninja_log', encoding='utf-8', errors='replace') as fh:
            return max(0, sum(1 for _ in fh) - 1)  # first line is the header
    except OSError:
        return 0


# ── .ino prototype generation ────────────────────────────────────────────────
# arduino-cli runs ctags over the sketch and injects forward declarations so
# the classic Arduino idiom — helpers defined AFTER setup()/loop() that use
# them — compiles. This pipeline writes sketch.ino.cpp itself and never did,
# so every such sketch died with "'foo' was not declared in this scope".
# This is a conservative ctags stand-in: it only emits prototypes for
# top-level, single-signature-line function definitions and skips anything
# ambiguous (templates, methods, default args, function-pointer params).

_INO_CTRL_KEYWORDS = frozenset((
    'if', 'else', 'for', 'while', 'switch', 'do', 'return', 'sizeof',
    'catch', 'case', 'new', 'delete', 'throw', 'goto',
))

_INO_FUNC_RE = re.compile(
    r'^[ \t]*([A-Za-z_][A-Za-z0-9_:<>,\*&\s]*?[\s\*&])'   # return type part
    r'([A-Za-z_]\w*)'                                      # function name
    r'[ \t]*\(([^;{}()]*)\)'                               # params (no nesting)
    r'[ \t\r\n]*\{',
    re.M,
)


def _blank_noncode(source: str) -> str:
    """Return a same-length copy with comments, string/char literals and
    preprocessor lines replaced by spaces (newlines preserved), so brace
    counting and signature matching never trip on their contents."""
    out = list(source)
    i, n = 0, len(source)
    line_start = True
    while i < n:
        c = source[i]
        if line_start and source[i:].lstrip(' \t')[:1] == '#':
            # blank the whole preprocessor line (incl. continuations)
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


def generate_ino_prototypes(source: str) -> str:
    """Insert forward declarations for top-level function definitions right
    before the first one, followed by a #line directive so compiler error
    line numbers keep matching the un-inserted text. Returns the source
    unchanged when nothing safe to declare is found."""
    scan = _blank_noncode(source)

    # depth prefix: depth[i] = brace depth just before scan[i]
    depths = []
    d = 0
    for ch in scan:
        depths.append(d)
        if ch == '{':
            d += 1
        elif ch == '}':
            d = max(0, d - 1)

    protos: list[str] = []
    seen: set[str] = set()
    first_pos: int | None = None
    for m in _INO_FUNC_RE.finditer(scan):
        sig_start = m.start()
        if depths[m.end() - 1] != 0:
            continue  # method body / nested — the '{' must open at depth 0
        rtype = ' '.join(m.group(1).split())
        name = m.group(2)
        params = ' '.join(m.group(3).split())
        if not rtype or name in _INO_CTRL_KEYWORDS:
            continue
        first_tok = rtype.split()[0] if rtype.split() else ''
        if first_tok in _INO_CTRL_KEYWORDS:
            continue
        if '::' in rtype or '::' in name or 'operator' in rtype:
            continue  # class methods / operators declare themselves
        if '<' in rtype or '>' in rtype or 'template' in rtype.split():
            continue  # templated heads/returns — never guess those
        if '=' in params or '{' in params:
            continue  # default args would be re-stated -> hard error
        # a `template<...>` head on a preceding line makes a bare prototype wrong
        lookback = scan[max(0, sig_start - 160):sig_start]
        if re.search(r'template\s*<[^<>]*>\s*$', lookback):
            continue
        proto = f'{rtype} {name}({params});'
        if proto not in seen:
            seen.add(proto)
            protos.append(proto)
        if first_pos is None:
            first_pos = sig_start

    if not protos or first_pos is None:
        return source

    insert_line = source.count('\n', 0, first_pos) + 1
    block = (
        '// Velxio: auto-generated forward declarations (.ino semantics)\n'
        + '\n'.join(protos)
        + f'\n#line {insert_line}\n'
    )
    return source[:first_pos] + block + source[first_pos:]


# The toolchain-change wipe below removes EVERY variant of a target. It used
# to be safe by construction (prepare ran on the event loop, so two compiles
# could not interleave in it); now that prepare runs in a worker thread, two
# first-after-restart compiles of one target must not both decide to wipe.
_TARGET_SENTINEL_GUARD = threading.Lock()

# Where prepare stashes the previous build's generated user_libs CMakeLists so
# the merge can hand the regenerated file its old mtime when the bytes are
# identical (it is a configure dependency; a fresh mtime re-runs cmake).
_USERLIBS_CMAKE_STASH = '.velxio-userlibs-cmake.prev'
# The two configure inputs under main/ get the same treatment: prepare wipes
# main/ and restores it from the template, so both come back with a fresh
# mtime every build even when their bytes are the previous build's.
_MAIN_CMAKE_STASH = '.velxio-main-cmake.prev'
_MANIFEST_STASH = '.velxio-manifest.prev'


def _stash_for_next_build(src: Path, stash: Path) -> None:
    """Keep a copy of a configure input (bytes AND mtime) before main/ is
    wiped, or drop the stale stash when the input did not exist this time."""
    try:
        if src.is_file():
            shutil.copy2(src, stash)  # copy2 keeps the mtime
        else:
            stash.unlink(missing_ok=True)
    except OSError:
        pass


def _restore_mtime_if_unchanged(path: Path, stash: Path) -> bool:
    """Give a regenerated configure input its previous mtime when its bytes
    did not change, so ninja's RERUN_CMAKE rule does not see it as new.

    Returns True when the bytes DIFFER from the stashed copy (or there was no
    stash): the caller then knows the configure has to run.
    """
    try:
        if not stash.is_file():
            return True
        if stash.read_text(encoding='utf-8') != path.read_text(encoding='utf-8'):
            return True
        st = stash.stat()
        os.utime(path, (st.st_atime, st.st_mtime))
        return False
    except (OSError, UnicodeDecodeError):
        return True


def _prepare_persistent_project_dir(
    idf_target: str,
    variant_key: str = 'default',
    replica: int = 0,
) -> Path:
    """Return a persistent project dir for (idf_target, variant_key), created
    from the template on first use and with the per-compile parts (main/,
    user_libs/) reset each call so a previous sketch doesn't leak into the next.

    Each distinct ``variant_key`` gets its OWN dir with its OWN ``build/`` that
    is NEVER wiped/reconfigured for a different config. The caller folds the
    board options AND the resolved library set into the key, so two compiles
    that would produce a different ESP-IDF component graph never share a build/.
    Sharing one build/ across configs caused intermittent cmake-configure
    failures, stale-object false positives, and nested-build breakage (a wiped+
    reconfigured dir loses ESP-IDF managed-component temp files). Same variant
    -> same dir -> warm ninja incremental + ccache. Cold variant -> fresh build,
    fast via the global ccache. The variant set is LRU-bounded per target.
    """
    target_dir = _BUILD_ROOT / idf_target
    target_dir.mkdir(parents=True, exist_ok=True)

    # Wipe ALL variants for this target if the toolchain changed (cached .o
    # files are no longer ABI-compatible).
    with _TARGET_SENTINEL_GUARD:
        sentinel = target_dir / '.idf_version'
        current_signature = _idf_version_signature()
        if sentinel.exists() and sentinel.read_text(encoding='utf-8').strip() != current_signature:
            logger.info(f'[espidf] toolchain version changed; wiping {target_dir}')
            shutil.rmtree(target_dir, ignore_errors=True)
            target_dir.mkdir(parents=True, exist_ok=True)
        sentinel.write_text(current_signature, encoding='utf-8')

    # One-time cleanup of the pre-variant layout (target_dir/project) so it
    # doesn't orphan ~240 MB after the upgrade to per-variant dirs.
    legacy_project = target_dir / 'project'
    if legacy_project.exists():
        shutil.rmtree(legacy_project, ignore_errors=True)
        (target_dir / '.options_hash').unlink(missing_ok=True)

    variant_dir = target_dir / _variant_dir_name(variant_key, replica)
    project_dir = variant_dir / 'project'

    if not project_dir.exists():
        variant_dir.mkdir(parents=True, exist_ok=True)
        shutil.copytree(_TEMPLATE_DIR, project_dir)
    else:
        # Reset per-compile parts only; keep build/ (warm for this variant).
        # copytree preserves the template's mtimes, so main/CMakeLists.txt
        # does NOT look new to ninja after this; the user's sources do, which
        # is exactly what has to recompile.
        # Both configure inputs under main/ are regenerated per build (the
        # CMakeLists patched for user_libs_all / IDF components, the managed
        # components manifest written from the sketch's includes). Keep the
        # previous build's copies so _compile_in_dir can hand back the old
        # mtime when the bytes match - and force the configure when the
        # manifest changed, which ninja cannot see (see _sync_managed_components).
        _stash_for_next_build(
            project_dir / 'main' / 'CMakeLists.txt', project_dir / _MAIN_CMAKE_STASH,
        )
        _stash_for_next_build(
            project_dir / 'main' / 'idf_component.yml', project_dir / _MANIFEST_STASH,
        )
        shutil.rmtree(project_dir / 'main', ignore_errors=True)
        shutil.copytree(_TEMPLATE_DIR / 'main', project_dir / 'main')
        _stash_for_next_build(
            project_dir / 'user_libs' / 'user_libs_all' / 'CMakeLists.txt',
            project_dir / _USERLIBS_CMAKE_STASH,
        )
        shutil.rmtree(project_dir / 'user_libs', ignore_errors=True)

    # Mark this variant most-recently-used, then LRU-evict the coldest.
    try:
        os.utime(variant_dir, None)
    except OSError:
        pass
    _evict_cold_variants(target_dir, keep=_max_build_variants(idf_target), idf_target=idf_target)

    return project_dir

# Static IP that matches slirp DHCP range (first client = x.x.x.15)
_STATIC_IP = '192.168.4.15'
_GATEWAY_IP = '192.168.4.2'
_NETMASK = '255.255.255.0'

# SSID the QEMU WiFi AP broadcasts.
# Must match one of the access_point_info entries in esp32_wifi_ap.c
# (the lcgamboa QEMU fork). "Espressif" is on channel 5 in that array.
_QEMU_WIFI_SSID = 'Espressif'
_QEMU_WIFI_CHANNEL = 5


def effective_scope(allowed: set[str] | None, scope: tuple | None) -> set[str] | None:
    """The allow-list the merge filters by, given the manifest and what the
    overlay materialised for it.

    - No manifest (None): scan-all, as always.
    - A manifest with a materialised scope dir: the dir IS the allow-list, so
      the manifest names plus the transitive closure the overlay reported
      (third tuple element, `closure_names`) are all admitted. Before
      2026-09-11 only the bare names were, every depends= entry was "not
      found", and only the scan-all retry rescued the build.
    - An EMPTY manifest with no scope dir (the overlay did not materialise
      one): scan-all, exactly as an empty manifest behaved before it could
      be told apart from a missing one. Closing the scope for `[]` is the
      overlay's decision, expressed by materialising an empty dir.
    """
    if allowed is None:
        return None
    scope_dir = scope[0] if scope else None
    if scope_dir is None:
        return allowed if allowed else None
    stats = scope[2] if len(scope) > 2 and isinstance(scope[2], dict) else None
    closure = set(stats.get('closure_names') or []) if stats else set()
    return allowed | closure


class ESPIDFCompiler:
    """Compile Arduino sketches using ESP-IDF for QEMU-compatible output."""

    # Instance attributes resolved in __init__ (declared here so type
    # checkers see them without inferring through the discovery logic).
    idf_path: str          # pinned ESP-IDF v4.4.7 tree (Arduino fallback)
    idf5_path: str         # ESP-IDF v5.x tree (family default + only C6)
    arduino_path: str      # arduino-esp32 2.x core (IDF 4.4-based)
    arduino5_path: str     # arduino-esp32 3.x core (IDF 5.x-based)
    has_arduino: bool      # a usable 2.x core was found
    has_arduino5: bool     # a usable 3.x core was found

    def __init__(self):
        self.idf_path = os.environ.get('IDF_PATH', '')
        self.arduino_path = os.environ.get('ARDUINO_ESP32_PATH', '')
        self.has_arduino = bool(self.arduino_path) and os.path.isdir(self.arduino_path)

        # Try common locations on Windows dev machines
        if not self.idf_path:
            for candidate in [
                r'C:\Espressif\frameworks\esp-idf-v4.4.7',
                r'C:\esp\esp-idf',
                '/opt/esp-idf',
            ]:
                if os.path.isdir(candidate):
                    self.idf_path = candidate
                    break

        # Auto-detect the 2.x Arduino core (IDF 4.4-based) if not explicitly
        # set. This is the core used for Arduino sketches on the v4.4.7
        # fallback path (esp32/s2/s3/c3).
        if self.idf_path and not self.has_arduino:
            for candidate in [
                r'C:\Espressif\components\arduino-esp32',
                os.path.join(self.idf_path, '..', 'components', 'arduino-esp32'),
                '/opt/arduino-esp32',
            ]:
                if os.path.isdir(candidate):
                    self.arduino_path = os.path.abspath(candidate)
                    self.has_arduino = True
                    break

        # ── ESP-IDF v5.x root (IDF5-only targets: ESP32-C6) ─────────────
        # The pinned v4.4.7 tree has no esp32c6 target, so C6 builds resolve
        # a separate IDF v5.x install. Kept independent of self.idf_path so
        # the classic targets keep building against the known-good 4.4 tree.
        self.idf5_path = os.environ.get('IDF5_PATH', '')
        if not self.idf5_path:
            candidates5: list[str] = []
            win55 = Path(r'C:\Espressif5.5\frameworks')
            if win55.is_dir():
                # Newest first when several v5 frameworks are installed.
                candidates5 += sorted(
                    (str(p) for p in win55.glob('esp-idf-v5*')), reverse=True
                )
            candidates5.append('/opt/esp-idf-v5')
            for candidate in candidates5:
                if os.path.isdir(candidate):
                    self.idf5_path = candidate
                    break

        if self.idf_path:
            logger.info(f'[espidf] IDF_PATH={self.idf_path}')
            if self.has_arduino:
                logger.info(f'[espidf] Arduino component: yes ({self.arduino_path})')
            else:
                logger.info('[espidf] Arduino component: no (pure ESP-IDF fallback)')
        else:
            logger.warning('[espidf] IDF_PATH not set — ESP-IDF compilation unavailable')
        if self.idf5_path:
            logger.info(f'[espidf] IDF v5.x (esp32c6): {self.idf5_path}')
        else:
            logger.info('[espidf] IDF v5.x not found — esp32c6 compilation unavailable')

        # ── arduino-esp32 3.x core (IDF 5.x-based) ──────────────────────
        # A separate install used for Arduino sketches on the v5.x path —
        # the ONLY core that can build esp32c6 .ino sketches. Discovered
        # under the v5 install's components/ (or ARDUINO_ESP32_5_PATH).
        # Kept independent of the 2.x core so both remain available and the
        # pipeline picks per build.
        self.arduino5_path = os.environ.get('ARDUINO_ESP32_5_PATH', '')
        if not self.arduino5_path:
            for candidate in [
                r'C:\Espressif5.5\components\arduino-esp32',
                (os.path.join(os.path.dirname(self.idf5_path), '..',
                              'components', 'arduino-esp32')
                 if self.idf5_path else ''),
                '/opt/arduino-esp32-3',
            ]:
                if candidate and os.path.isdir(candidate):
                    self.arduino5_path = os.path.abspath(candidate)
                    break
        self.has_arduino5 = (
            bool(self.arduino5_path) and os.path.isdir(self.arduino5_path)
        )
        if self.has_arduino5:
            logger.info(f'[espidf] arduino-esp32 3.x core (IDF5): {self.arduino5_path}')
        else:
            logger.info('[espidf] arduino-esp32 3.x core: no (C6 .ino unavailable)')

    @property
    def available(self) -> bool:
        """Whether ESP-IDF toolchain is available."""
        return bool(self.idf_path) and os.path.isdir(self.idf_path)

    # Targets that only exist in ESP-IDF v5.x — the pinned v4.4.7 tree
    # predates them, so they build against idf5_path instead of idf_path.
    _IDF5_TARGETS: frozenset[str] = frozenset({'esp32c6', 'esp32p4', 'esp32c5'})

    # Flash offset where each chip's boot ROM expects the 2nd-stage
    # bootloader. ESP32 / ESP32-S2 use 0x1000; every newer chip (S3, C2,
    # C3, C6, H2) boots from 0x0, so that is the default for unlisted
    # targets. (A future P4/C5 entry would be 0x2000.)
    _BOOTLOADER_OFFSETS: dict[str, int] = {
        'esp32': 0x1000,
        'esp32s2': 0x1000,
        'esp32p4': 0x2000,
        'esp32c5': 0x2000,
    }

    # The esp-hosted-mcu sync-RPC race, fixed at source.
    #
    # Upstream 2.12.12 mints RPC uids and claims sync-response table slots
    # with no locking. Two tasks issuing sync RPCs in the same instant
    # cross-wire: the losing waiter re-reads a slot the winner already
    # cleared and asserts inside hosted_destroy_semaphore(NULL), which
    # panics the core the Arduino event task runs on -- so a P4 sketch
    # associates, gets a DHCP lease, and never sees WL_CONNECTED. Real
    # boards dodge it by jitter; the deterministic engine hits it every
    # run (project/espressif-devkits-2026-08/STATUS.md, 2026-08-26, and
    # patches/esp-hosted-2.12.12-sync-rpc-race.patch in that directory).
    #
    # Managed components are hash-checked and self-restoring, so the patch
    # cannot live in managed_components/. The component manager's own
    # documented escape hatch is a project-local copy in components/,
    # which overrides the managed one. This runs after the configure that
    # fetches dependencies; when it creates the override, the caller must
    # re-run configure so the build system picks the new component dir up.
    _ESP_HOSTED_RACE_FIXES: list[tuple[str, str]] = [
        (
            'static int set_async_resp_callback(ctrl_cmd_t *app_req,'
            ' rpc_rsp_cb_t resp_cb, void *timer_hdl);',
            'static int set_async_resp_callback(ctrl_cmd_t *app_req,'
            ' rpc_rsp_cb_t resp_cb, void *timer_hdl);\n'
            'static portMUX_TYPE velxio_sync_slot_mux ='
            ' portMUX_INITIALIZER_UNLOCKED;',
        ),
        (
            '\tuid++;\n'
            '\t// handle rollover in uid value\n'
            '\tif (!uid)\n'
            '\t\tuid++;\n'
            '\tapp_req->uid = uid;',
            '\tportENTER_CRITICAL(&velxio_sync_slot_mux);'
            ' /* Velxio: atomic uid mint */\n'
            '\tuid++;\n'
            '\t// handle rollover in uid value\n'
            '\tif (!uid)\n'
            '\t\tuid++;\n'
            '\tapp_req->uid = uid;\n'
            '\tportEXIT_CRITICAL(&velxio_sync_slot_mux);',
        ),
        (
            '\t\tfor (i = 0; i < MAX_SYNC_RPC_TRANSACTIONS; i++) {\n'
            '\t\t\tif (!sync_rsp_table[i].uid) {\n'
            '\t\t\t\tESP_LOGD(TAG, "Register sync sem %p for uid %ld",'
            ' app_req->rx_sem, app_req->uid);\n'
            '\t\t\t\tsync_rsp_table[i].uid = app_req->uid;\n'
            '\t\t\t\tsync_rsp_table[i].sem = app_req->rx_sem;\n'
            '\t\t\t\treturn CALLBACK_SET_SUCCESS;\n'
            '\t\t\t}\n'
            '\t\t}',
            '\t\t/* Velxio: claim the slot under the mux */\n'
            '\t\tportENTER_CRITICAL(&velxio_sync_slot_mux);\n'
            '\t\tfor (i = 0; i < MAX_SYNC_RPC_TRANSACTIONS; i++) {\n'
            '\t\t\tif (!sync_rsp_table[i].uid) {\n'
            '\t\t\t\tsync_rsp_table[i].uid = app_req->uid;\n'
            '\t\t\t\tsync_rsp_table[i].sem = app_req->rx_sem;\n'
            '\t\t\t\tportEXIT_CRITICAL(&velxio_sync_slot_mux);\n'
            '\t\t\t\tESP_LOGD(TAG, "Register sync sem %p for uid %ld",'
            ' app_req->rx_sem, app_req->uid);\n'
            '\t\t\t\treturn CALLBACK_SET_SUCCESS;\n'
            '\t\t\t}\n'
            '\t\t}\n'
            '\t\tportEXIT_CRITICAL(&velxio_sync_slot_mux);',
        ),
        (
            '\tfor (i = 0; i < MAX_SYNC_RPC_TRANSACTIONS; i++) {\n'
            '\t\tif (sync_rsp_table[i].uid == app_req->uid) {\n'
            '\t\t\tret = g_h.funcs->_h_get_semaphore(sync_rsp_table[i].sem,'
            ' SEC_TO_MILLISEC(timeout_sec));\n'
            '\t\t\tif (g_h.funcs->_h_destroy_semaphore(sync_rsp_table[i].sem)) {\n'
            '\t\t\t\tESP_LOGE(TAG, "read sem rx for resp[0x%x] destroy failed",'
            ' exp_resp_msg_id);\n'
            '\t\t\t}\n'
            '\t\t\t// clear table entry\n'
            '\t\t\tsync_rsp_table[i].uid = 0;\n'
            '\t\t\tsync_rsp_table[i].sem = NULL;\n'
            '\t\t\treturn ret;\n'
            '\t\t}\n'
            '\t}',
            '\t{\n'
            '\t\t/* Velxio: read under the mux, wait on a LOCAL copy,'
            ' clear before destroy */\n'
            '\t\tvoid *velxio_my_sem = NULL;\n'
            '\t\tportENTER_CRITICAL(&velxio_sync_slot_mux);\n'
            '\t\tfor (i = 0; i < MAX_SYNC_RPC_TRANSACTIONS; i++) {\n'
            '\t\t\tif (sync_rsp_table[i].uid == app_req->uid) {\n'
            '\t\t\t\tvelxio_my_sem = sync_rsp_table[i].sem;\n'
            '\t\t\t\tbreak;\n'
            '\t\t\t}\n'
            '\t\t}\n'
            '\t\tportEXIT_CRITICAL(&velxio_sync_slot_mux);\n'
            '\t\tif (velxio_my_sem) {\n'
            '\t\t\tret = g_h.funcs->_h_get_semaphore(velxio_my_sem,'
            ' SEC_TO_MILLISEC(timeout_sec));\n'
            '\t\t\tportENTER_CRITICAL(&velxio_sync_slot_mux);\n'
            '\t\t\tif (sync_rsp_table[i].uid == app_req->uid) {\n'
            '\t\t\t\tsync_rsp_table[i].uid = 0;\n'
            '\t\t\t\tsync_rsp_table[i].sem = NULL;\n'
            '\t\t\t}\n'
            '\t\t\tportEXIT_CRITICAL(&velxio_sync_slot_mux);\n'
            '\t\t\tif (g_h.funcs->_h_destroy_semaphore(velxio_my_sem)) {\n'
            '\t\t\t\tESP_LOGE(TAG, "read sem rx for resp[0x%x] destroy failed",'
            ' exp_resp_msg_id);\n'
            '\t\t\t}\n'
            '\t\t\treturn ret;\n'
            '\t\t}\n'
            '\t}',
        ),
        (
            '\tfor (i = 0; i < MAX_SYNC_RPC_TRANSACTIONS; i++) {\n'
            '\t\tif (sync_rsp_table[i].uid == app_resp->uid) {\n'
            '\t\t\treturn g_h.funcs->_h_post_semaphore(sync_rsp_table[i].sem);\n'
            '\t\t}\n'
            '\t}',
            '\t/* Velxio: post inside the mux so the waiter cannot'
            ' clear-and-destroy meanwhile */\n'
            '\tportENTER_CRITICAL(&velxio_sync_slot_mux);\n'
            '\tfor (i = 0; i < MAX_SYNC_RPC_TRANSACTIONS; i++) {\n'
            '\t\tif (sync_rsp_table[i].uid == app_resp->uid &&'
            ' sync_rsp_table[i].sem) {\n'
            '\t\t\tint velxio_post_ret ='
            ' g_h.funcs->_h_post_semaphore(sync_rsp_table[i].sem);\n'
            '\t\t\tportEXIT_CRITICAL(&velxio_sync_slot_mux);\n'
            '\t\t\treturn velxio_post_ret;\n'
            '\t\t}\n'
            '\t}\n'
            '\tportEXIT_CRITICAL(&velxio_sync_slot_mux);',
        ),
    ]

    def _override_esp_hosted_with_race_fix(self, project_dir: Path) -> bool:
        """Create the patched components/ override for esp_hosted.

        Returns True when the override was CREATED this call (the caller
        must re-run cmake configure so the new component dir is picked up);
        False when it already exists or there is nothing to patch.
        """
        managed = project_dir / 'managed_components' / 'espressif__esp_hosted'
        override = project_dir / 'components' / 'espressif__esp_hosted'
        if override.exists():
            return False
        if not managed.exists():
            return False

        rpc_core = (
            managed / 'host' / 'drivers' / 'rpc' / 'core' / 'rpc_core.c'
        )
        try:
            source = rpc_core.read_text(encoding='utf-8')
        except OSError:
            logger.warning('[espidf] esp_hosted override: rpc_core.c unreadable')
            return False

        for old, _new in self._ESP_HOSTED_RACE_FIXES:
            if old not in source:
                # A different esp_hosted version: the anchors moved. Do NOT
                # guess -- build unpatched and say so, loudly, so the pin
                # bump gets a deliberate re-port instead of a silent no-op.
                logger.warning(
                    '[espidf] esp_hosted race patch anchors not found — '
                    'component version changed? building UNPATCHED'
                )
                return False

        override.parent.mkdir(exist_ok=True)
        shutil.copytree(managed, override)
        for old, new in self._ESP_HOSTED_RACE_FIXES:
            source = source.replace(old, new, 1)
        (override / 'host' / 'drivers' / 'rpc' / 'core' / 'rpc_core.c').write_text(
            source, encoding='utf-8'
        )
        # The hash file belongs to the managed copy's lifecycle, not ours.
        (override / '.component_hash').unlink(missing_ok=True)
        logger.info('[espidf] esp_hosted sync-RPC race patch applied (components/ override)')
        return True

    def _is_esp32c3(self, board_fqbn: str) -> bool:
        """Return True if FQBN targets ESP32-C3 (RISC-V)."""
        return 'esp32c3' in board_fqbn or 'esp32-c3' in board_fqbn

    def _is_esp32c6(self, board_fqbn: str) -> bool:
        """Return True if FQBN targets ESP32-C6 (RISC-V, IDF v5.x only)."""
        f = board_fqbn.lower()
        return 'esp32c6' in f or 'esp32-c6' in f

    def _is_esp32p4(self, board_fqbn: str) -> bool:
        """Return True if FQBN targets ESP32-P4 (RISC-V, IDF v5.x only)."""
        f = board_fqbn.lower()
        return 'esp32p4' in f or 'esp32-p4' in f

    def _is_esp32c5(self, board_fqbn: str) -> bool:
        """Return True if FQBN targets ESP32-C5 (RISC-V, IDF v5.x only)."""
        f = board_fqbn.lower()
        return 'esp32c5' in f or 'esp32-c5' in f

    def _idf_root(self, use_idf5: bool) -> str:
        """The ESP-IDF tree a compile builds against."""
        return self.idf5_path if use_idf5 else self.idf_path

    def _use_idf5(self, idf_target: str, arduino_mode: bool) -> bool:
        """Decide which IDF major this compile builds against.

        Policy: IDF v5.x is THE toolchain for the whole ESP32 family
        (esp32 / s2 / s3 / c3 / c6); the pinned v4.4.7 tree is legacy.

        - esp32c6 only exists in v5.x → always v5.
        - Arduino-as-component builds are tied to the core's IDF. When an
          arduino-esp32 3.x core (IDF 5.x based — 3.3.x pairs with IDF
          5.5) is installed, Arduino sketches build on v5 with it. Without
          a 3.x core they FALL BACK to v4.4.7 + the 2.x core (which is IDF
          4.4-based). Escape hatches: VELXIO_ARDUINO_IDF5=0 forces the
          v4.4 path even when a 3.x core exists; =1 forces v5.
        - Pure-IDF builds (user code defines app_main) use v5 whenever the
          v5 install exists, and fall back to v4.4 when it doesn't (OSS
          self-host without the v5 install).
        """
        if idf_target in self._IDF5_TARGETS:
            return True
        has_idf5 = bool(self.idf5_path) and os.path.isdir(self.idf5_path)
        if arduino_mode:
            override = os.environ.get('VELXIO_ARDUINO_IDF5', '')
            if override in ('1', 'true', 'True'):
                return has_idf5
            if override in ('0', 'false', 'False'):
                return False
            # Auto: prefer v5 + the 3.x core when both are present.
            return has_idf5 and self.has_arduino5
        return has_idf5

    def _arduino_path_for(self, use_idf5: bool) -> str:
        """The arduino-esp32 core a build uses: the 3.x core on v5, the
        2.x core on v4.4 — falling back to whichever exists if the
        preferred one is absent."""
        if use_idf5:
            return self.arduino5_path or self.arduino_path
        return self.arduino_path or self.arduino5_path

    def _arduino_supports_target(self, idf_target: str) -> bool:
        """True when SOME installed arduino-esp32 core can build this IDF
        target as Arduino-as-component.

        IDF5-only targets (esp32c6) need an arduino-esp32 3.x core (IDF
        5.x based) — the 2.x core has no such target. Classic targets
        (esp32/s2/s3/c3) build with either core. When no usable core
        exists for the target the sketch is refused with a structured
        error rather than being pattern-translated into something it
        isn't.
        """
        if idf_target == 'esp32c5':
            # No arduino-esp32 core supports the C5 yet — IDF-native only.
            return False
        if idf_target in self._IDF5_TARGETS:
            return self.has_arduino5
        return self.has_arduino or self.has_arduino5

    def _arduino_core_version(self, arduino_path: Optional[str] = None) -> Optional[str]:
        """Best-effort version of an arduino-esp32 core (package.json
        ``version``), for user-facing messages. Defaults to the 2.x core."""
        path = arduino_path or self.arduino_path
        if not path:
            return None
        try:
            with open(
                os.path.join(path, 'package.json'), encoding='utf-8'
            ) as fh:
                return json.load(fh).get('version')
        except (OSError, ValueError):
            return None

    @staticmethod
    def _contains_app_main(code: str) -> bool:
        """True when the code defines its own ESP-IDF entry point
        (``void app_main(void)``) — i.e. it is a plain ESP-IDF program
        rather than an Arduino setup()/loop() sketch."""
        return bool(re.search(r'\bvoid\s+app_main\s*\(', code))

    def _is_esp32s3(self, board_fqbn: str) -> bool:
        """Return True if FQBN targets ESP32-S3 (Xtensa LX7).

        Most S3 FQBNs contain 'esp32s3' (esp32s3, XIAO_ESP32S3 uppercase — the
        lowercased substring test still matches), but a few S3 boards use a
        variant name that doesn't: Arduino Nano ESP32 = nano_nora, M5 Cardputer/
        StampS3 = m5stack_cardputer / m5stack_stamps3, so those are matched
        explicitly. Without this every S3 board compiled for the 'esp32' (LX6)
        target and could not boot the esp32s3 QEMU machine.
        """
        f = board_fqbn.lower()
        if 'esp32s3' in f:
            return True
        return any(v in f for v in ('nano_nora', 'm5stack_cardputer', 'm5stack_stamps3', 'm5stamp_s3'))

    # Cache: boards.txt is a few hundred KB and never changes at runtime.
    _variant_cache: dict = {}

    @staticmethod
    def _fqbn_board_id_and_options(board_fqbn: str) -> tuple[str, dict]:
        """Split an arduino FQBN into (board_id, menu-option dict).

        arduino-cli syntax: ``vendor:arch:board_id[:Menu1=val1,Menu2=val2]``.
        The espidf lane must understand the 4-part option-suffix form too,
        not just plain 3-part FQBNs — the C3-LCDkit board def pins
        ``CDCOnBoot=cdc`` this way (the real kit has no UART bridge; its only
        console is the USB Serial/JTAG port). Menu keys a caller does not
        recognise are simply ignored.
        """
        parts = board_fqbn.split(':')
        opts: dict = {}
        if len(parts) >= 4 and parts[3]:
            for kv in parts[3].split(','):
                if '=' in kv:
                    k, v = kv.split('=', 1)
                    opts[k.strip()] = v.strip()
            board_id = parts[2]
        else:
            board_id = parts[-1]
        return board_id.split('?')[0].strip(), opts

    def _arduino_variant(self, board_fqbn: str, idf_target: str) -> str:
        """The Arduino VARIANT for this FQBN, from arduino-esp32's boards.txt.

        Without this every board builds against ``variants/<chip>/``, i.e. as a
        generic dev-kit, and the board's own pin names never exist: a XIAO
        sketch dies on ``D1``, an M5 sketch on its silk names. Since those are
        exactly the sketches people copy from vendor wikis, the emulator has to
        get this right to be believable.

        boards.txt is the authority (``<board>.build.variant=<variant>``), so it
        is read rather than guessed; anything not found falls back to the chip,
        which is the previous behaviour.
        """
        board_id, _ = self._fqbn_board_id_and_options(board_fqbn)
        if not board_id:
            return idf_target
        key = (board_id, idf_target)
        if key in self._variant_cache:
            return self._variant_cache[key]

        variant = idf_target
        # The 3.x core first: it is the one the IDF5 targets build against.
        roots = [
            r
            for r in (
                os.environ.get('ARDUINO_ESP32_V3_PATH', '/opt/arduino-esp32-3'),
                os.environ.get('ARDUINO_ESP32_PATH', '/opt/arduino-esp32'),
            )
            if r
        ]
        for root in roots:
            boards_txt = Path(root) / 'boards.txt'
            if not boards_txt.is_file():
                continue
            try:
                text = boards_txt.read_text(encoding='utf-8', errors='ignore')
            except OSError:
                continue
            needle = f'{board_id}.build.variant='
            for line in text.splitlines():
                if line.startswith(needle):
                    found = line.split('=', 1)[1].strip()
                    if found:
                        variant = found
                    break
            if variant != idf_target:
                break

        if variant == idf_target and board_id != idf_target:
            logger.info(
                f'[espidf] no build.variant for {board_id} in boards.txt; '
                f'falling back to {idf_target}'
            )
        self._variant_cache[key] = variant
        return variant

    _board_flags_cache: dict = {}

    def _arduino_board_flags(self, board_fqbn: str) -> dict:
        """USB/identity flags for this FQBN from arduino-esp32's boards.txt.

        Returns {'board': str|None, 'cdc_on_boot': bool}:
        - ``board``: the ``<id>.build.board`` name — arduino-cli defines
          ``ARDUINO_<board>`` from it and vendor sketches #ifdef on it.
        - ``cdc_on_boot``: ``<id>.build.cdc_on_boot=1`` — on real hardware
          ``Serial`` is then the USB CDC, not UART0. Boards like the XIAO
          ESP32S3 expose UART0's default RX pin (GPIO44) as a plain Dx pin,
          so building them with Serial on UART0 is not just unfaithful: a
          pinMode() on that pin tears the UART driver down mid-sketch.

        A ``CDCOnBoot`` menu option in the FQBN suffix overrides the board's
        boards.txt default, mirroring arduino-cli
        (``<id>.menu.CDCOnBoot.cdc.build.cdc_on_boot=1``): the C3-LCDkit pins
        ``esp32:esp32:esp32c3:CDCOnBoot=cdc`` so its console matches the real
        kit, which only exposes the USB Serial/JTAG port.
        """
        board_id, menu_opts = self._fqbn_board_id_and_options(board_fqbn)
        if board_id in self._board_flags_cache:
            return self._apply_menu_overrides(self._board_flags_cache[board_id], menu_opts)
        flags = {'board': None, 'cdc_on_boot': False}
        roots = [
            r
            for r in (
                os.environ.get('ARDUINO_ESP32_V3_PATH', '/opt/arduino-esp32-3'),
                os.environ.get('ARDUINO_ESP32_PATH', '/opt/arduino-esp32'),
            )
            if r
        ]
        for root in roots:
            boards_txt = Path(root) / 'boards.txt'
            if not boards_txt.is_file():
                continue
            try:
                text = boards_txt.read_text(encoding='utf-8', errors='ignore')
            except OSError:
                continue
            for line in text.splitlines():
                if line.startswith(f'{board_id}.build.board='):
                    flags['board'] = line.split('=', 1)[1].strip() or None
                elif line.startswith(f'{board_id}.build.cdc_on_boot='):
                    flags['cdc_on_boot'] = line.split('=', 1)[1].strip() == '1'
            if flags['board'] is not None:
                break
        self._board_flags_cache[board_id] = flags
        return self._apply_menu_overrides(flags, menu_opts)

    @staticmethod
    def _apply_menu_overrides(flags: dict, menu_opts: dict) -> dict:
        """Overlay FQBN menu options on the boards.txt base flags.

        Only ``CDCOnBoot`` is understood today (``cdc`` -> 1, ``default`` ->
        the boards.txt value). Returns a copy so the per-board cache never
        holds an override.
        """
        cdc = menu_opts.get('CDCOnBoot')
        if cdc == 'cdc':
            return {**flags, 'cdc_on_boot': True}
        return flags

    def _idf_target(self, board_fqbn: str) -> str:
        """Map FQBN to IDF_TARGET."""
        if self._is_esp32c3(board_fqbn):
            return 'esp32c3'
        if self._is_esp32c6(board_fqbn):
            return 'esp32c6'
        if self._is_esp32s3(board_fqbn):
            return 'esp32s3'
        if self._is_esp32p4(board_fqbn):
            return 'esp32p4'
        if self._is_esp32c5(board_fqbn):
            return 'esp32c5'
        # Default to esp32 (Xtensa LX6) for the original ESP32 / ESP32-S2
        return 'esp32'

    def _sync_managed_components(self, project_dir: Path, deps: dict) -> bool:
        """Declare extra ESP-IDF managed components for the `main` component.

        The template ships no idf_component.yml, so every managed component the
        build sees today arrives transitively through arduino-esp32's own
        manifest. Anything it does not depend on has to be asked for explicitly;
        the component manager then fetches it into managed_components/ during the
        cmake configure and caches it in the build dir for later runs.

        Returns True when the manifest differs from the previous build's in
        this dir (created, removed, or other components). The caller MUST then
        run the configure explicitly: the component manager only fetches during
        a configure, and ninja's RERUN_CMAKE rule lists the manifests that
        existed at the LAST configure - a manifest created after it is not an
        input ninja knows about, so a warm dir would go straight to compiling
        and die on "esp_camera.h: No such file or directory" with the
        dependency declared right there in the log (2026-09-05, XIAO ESP32S3).
        When the bytes match, the manifest gets its previous mtime back so a
        warm camera variant skips the configure like a bare one does.
        """
        manifest = project_dir / 'main' / 'idf_component.yml'
        stash = project_dir / _MANIFEST_STASH
        if not deps:
            # prepare restored main/ from the template, which ships no
            # manifest; one present here is the user's own (pure-IDF mode
            # writes their files into main/ by name). Report whether the
            # previous build's manifest differs from this one, or existed.
            if manifest.is_file():
                return _restore_mtime_if_unchanged(manifest, stash)
            return stash.is_file()
        lines = ['# Auto-generated by Velxio — components the sketch needs that the',
                 '# Arduino core does not pull in by itself.',
                 'dependencies:']
        for name in sorted(deps):
            lines.append(f'  {name}: "{deps[name]}"')
        manifest.write_text('\n'.join(lines) + '\n', encoding='utf-8')
        changed = _restore_mtime_if_unchanged(manifest, stash)
        logger.info(
            '[espidf] Declared managed components: %s%s',
            ', '.join(sorted(deps)),
            ' (new for this build dir; configure required)' if changed else '',
        )
        return changed

    def _component_graph_token(self, code: str) -> str:
        """Components the sketch pulls into the ESP-IDF graph by #include:
        registry (managed) components and IDF-tree components main must
        REQUIRE. Folded into the build-dir identity so a camera sketch never
        shares a configured build/ with a bare one; '' when there are none,
        which keeps every existing variant's hash as it was."""
        managed = sorted(self._detect_managed_components(code))
        idf_comps = sorted(self._detect_idf_components(code))
        if not managed and not idf_comps:
            return ''
        return 'mc:' + ','.join(managed) + '|ic:' + ','.join(idf_comps)

    # include -> managed component (name, version). Each of these headers
    # ships in a registry component that neither the template nor
    # arduino-esp32's own manifest depends on, so a sketch using it dies
    # with "No such file or directory" unless the dependency is declared
    # (the esp_camera.h lesson, generalized for the Espressif devkit
    # boards' display/touch stacks).
    _MANAGED_COMPONENT_INCLUDES: tuple[tuple[str, str, str], ...] = (
        (r'esp_camera\.h', 'espressif/esp32-camera', '^2.0.4'),
        (r'esp_lcd_st77916\.h', 'espressif/esp_lcd_st77916', '*'),
        (r'esp_lcd_touch_cst816s\.h', 'espressif/esp_lcd_touch_cst816s', '*'),
        (r'esp_lcd_gc9a01\.h', 'espressif/esp_lcd_gc9a01', '*'),
        (r'esp_lcd_ek79007\.h', 'espressif/esp_lcd_ek79007', '*'),
        # The building blocks Espressif's OWN board demos are made of — the
        # C3-LCDkit knob_panel drives its WS2812 through led_strip and its
        # EC11 through knob+button, the P4 devkit's panel is a GT911, and
        # every audio demo on the VoCat/P4 goes through esp_codec_dev. A
        # visitor pasting official example code hit "No such file or
        # directory" on all four.
        (r'led_strip\.h', 'espressif/led_strip', '*'),
        (r'iot_button\.h', 'espressif/button', '*'),
        (r'iot_knob\.h', 'espressif/knob', '*'),
        (r'esp_lcd_touch_gt911\.h', 'espressif/esp_lcd_touch_gt911', '*'),
        (r'esp_codec_dev\.h', 'espressif/esp_codec_dev', '*'),
        # LVGL and its BSP glue: every official board demo's UI is built on
        # them, so without these a visitor cannot paste a single screen of
        # esp-dev-kits code. The dependency is only declared when the source
        # includes the header, so nothing else pays for the bigger build.
        (r'lvgl\.h', 'lvgl/lvgl', '*'),
        (r'esp_lvgl_port\.h', 'espressif/esp_lvgl_port', '*'),
    )

    def _strip_comments(self, code: str) -> str:
        """A commented-out #include is not an include (same rule the library
        scanner applies); without this a `// #include "esp_camera.h"` left in
        a sketch fetched the camera component and, now, cost the sketch its
        own build variant."""
        code = self._PP_COMMENT_BLOCK_RE.sub(' ', code)
        return self._PP_COMMENT_LINE_RE.sub(' ', code)

    def _detect_managed_components(self, code: str) -> dict:
        """Managed components the source explicitly #includes."""
        code = self._strip_comments(code)
        deps: dict[str, str] = {}
        for pattern, name, version in self._MANAGED_COMPONENT_INCLUDES:
            if re.search(r'#include\s*[<"]' + pattern + r'[">]', code):
                deps[name] = version
        return deps

    # IDF components that ship INSIDE the IDF tree (not the registry) and are
    # NOT on an Arduino sketch's include path by default. arduino-esp32 3.x
    # keeps most of its requires PRIVATE, so a sketch that includes one of
    # these dies with "No such file or directory" while the very same header
    # resolves fine from a user library (whose merged component requires it).
    # Hit while writing the ESP32-S3-EYE camera example: esp_lcd_panel_io.h
    # compiled only when an unrelated Adafruit library happened to be present.
    _IDF_COMPONENT_INCLUDES: tuple[tuple[str, str], ...] = (
        (r'esp_lcd_panel_io\.h', 'esp_lcd'),
        (r'esp_lcd_panel_ops\.h', 'esp_lcd'),
        (r'esp_lcd_panel_vendor\.h', 'esp_lcd'),
        (r'esp_lcd_types\.h', 'esp_lcd'),
        (r'esp_lcd_mipi_dsi\.h', 'esp_lcd'),
        (r'esp_cache\.h', 'esp_mm'),
        (r'esp_ldo_regulator\.h', 'esp_hw_support'),
        (r'esp_psram\.h', 'esp_psram'),
    )

    def _detect_idf_components(self, code: str) -> list[str]:
        """IDF-tree components the source #includes, that exist in this IDF."""
        code = self._strip_comments(code)
        wanted: list[str] = []
        for pattern, comp in self._IDF_COMPONENT_INCLUDES:
            if comp in wanted:
                continue
            if not re.search(r'#include\s*[<"]' + pattern + r'[">]', code):
                continue
            if self.idf_path and os.path.isdir(
                os.path.join(self.idf_path, 'components', comp)
            ):
                wanted.append(comp)
        return wanted

    def _detect_camera_usage(self, code: str) -> bool:
        """Does the sketch use the ESP32 camera driver?

        `esp_camera.h` does NOT ship with the Arduino core: it lives in the
        `espressif/esp32-camera` managed component, which arduino-esp32's own
        idf_component.yml does not depend on. So a camera sketch compiles fine
        everywhere else and dies here with "esp_camera.h: No such file or
        directory" — which is exactly what both ESP32-CAM examples did.
        """
        return bool(re.search(r'#include\s*[<"]esp_camera\.h[">]', code))

    def _detect_wifi_usage(self, code: str) -> bool:
        """Check if sketch uses WiFi."""
        return bool(re.search(r'#include\s*[<"]WiFi\.h[">]|WiFi\.begin\(', code))

    def _detect_idf_wifi_usage(self, code: str) -> bool:
        """Pure ESP-IDF mode: does the project use the esp_wifi stack?"""
        return bool(re.search(r'#include\s*[<"]esp_wifi\.h[">]|esp_wifi_init\s*\(', code))

    def _normalize_wifi_for_qemu_idf(self, code: str) -> str:
        """
        Pure ESP-IDF variant of _normalize_wifi_for_qemu. IDF projects set
        credentials via `#define WIFI_SSID "..."` or wifi_config_t designated
        initializers (`.ssid = "..."`, `.password = "..."`). Rewrite the
        common literal forms so the firmware associates with the open AP the
        QEMU fork broadcasts (_QEMU_WIFI_SSID); anything more dynamic
        (strcpy into the struct at runtime) is left alone and simply won't
        connect.
        """
        code = re.sub(
            r'(#define\s+\w*SSID\w*\s+)"[^"]*"',
            rf'\1"{_QEMU_WIFI_SSID}"',
            code,
            flags=re.IGNORECASE,
        )
        code = re.sub(
            r'(#define\s+\w*(?:PASS|PASSWORD|PSK)\w*\s+)"[^"]*"',
            r'\1""',
            code,
            flags=re.IGNORECASE,
        )
        code = re.sub(r'(\.ssid\s*=\s*)"[^"]*"', rf'\1"{_QEMU_WIFI_SSID}"', code)
        code = re.sub(r'(\.password\s*=\s*)"[^"]*"', r'\1""', code)
        return code

    def _detect_webserver_usage(self, code: str) -> bool:
        """Check if sketch uses WebServer."""
        return bool(re.search(
            r'#include\s*[<"]WebServer\.h[">]|#include\s*[<"]ESP8266WebServer\.h[">]|WebServer\s+\w+',
            code
        ))

    def _normalize_wifi_for_qemu(self, code: str) -> str:
        """
        Normalize WiFi SSID/password/channel in Arduino sketches for QEMU.

        QEMU's WiFi AP broadcasts _QEMU_WIFI_SSID on _QEMU_WIFI_CHANNEL with open auth.
        This method rewrites the user's sketch so that:
          - Any SSID string literal → _QEMU_WIFI_SSID
          - Password → "" (open auth)
          - Channel → _QEMU_WIFI_CHANNEL
        The user's editor still shows their original code; only the compiled
        binary is modified.
        """
        if not self._detect_wifi_usage(code):
            return code

        # 1) Replace SSID variable definitions:
        #    const char* ssid = "anything" → _QEMU_WIFI_SSID
        #    char ssid[] = "anything"      → _QEMU_WIFI_SSID
        #    #define WIFI_SSID "anything"   → _QEMU_WIFI_SSID
        code = re.sub(
            r'((?:const\s+)?char\s*\*?\s*ssid\s*\[?\]?\s*=\s*)"[^"]*"',
            rf'\1"{_QEMU_WIFI_SSID}"',
            code,
            flags=re.IGNORECASE
        )
        code = re.sub(
            r'(#define\s+\w*SSID\w*\s+)"[^"]*"',
            rf'\1"{_QEMU_WIFI_SSID}"',
            code,
            flags=re.IGNORECASE
        )

        # 2) Normalize WiFi.begin() calls:
        #    WiFi.begin("X")           → WiFi.begin(_QEMU_WIFI_SSID, "", _QEMU_WIFI_CHANNEL)
        #    WiFi.begin("X", "pass")   → WiFi.begin(_QEMU_WIFI_SSID, "", _QEMU_WIFI_CHANNEL)
        #    WiFi.begin(ssid, pass, N) → WiFi.begin(ssid, "", _QEMU_WIFI_CHANNEL)
        #    WiFi.begin(ssid)          → WiFi.begin(ssid, "", _QEMU_WIFI_CHANNEL)

        def _rewrite_wifi_begin(m: re.Match) -> str:
            args = m.group(1)
            parts = [a.strip() for a in args.split(',')]
            ssid_arg = parts[0]
            # If SSID is a string literal, force to _QEMU_WIFI_SSID
            if ssid_arg.startswith('"'):
                ssid_arg = f'"{_QEMU_WIFI_SSID}"'
            return f'WiFi.begin({ssid_arg}, "", {_QEMU_WIFI_CHANNEL})'

        code = re.sub(
            r'WiFi\.begin\s*\(([^)]+)\)',
            _rewrite_wifi_begin,
            code
        )

        logger.info('[espidf] WiFi normalized: SSID→%s, channel→%d, open auth', _QEMU_WIFI_SSID, _QEMU_WIFI_CHANNEL)
        return code

    def _translate_sketch_to_espidf(self, sketch_code: str) -> str:
        """
        Translate an Arduino WiFi+WebServer sketch to pure ESP-IDF C code.

        This handles the common pattern:
          - WiFi.begin("ssid", "pass") → esp_wifi_start() with static IP
          - WebServer server(80) + server.on("/", handler) → esp_http_server
          - digitalWrite/pinMode → gpio_set_level/gpio_set_direction

        Returns C source code for sketch_translated.c
        """
        uses_wifi = self._detect_wifi_usage(sketch_code)
        uses_webserver = self._detect_webserver_usage(sketch_code)

        # Extract route handlers from server.on() calls
        routes = []
        handler_bodies = {}
        if uses_webserver:
            # Match: server.on("/path", handler_func)
            # or:    server.on("/path", HTTP_GET, handler_func)
            for m in re.finditer(
                r'server\.on\(\s*"([^"]+)"\s*,\s*(?:HTTP_\w+\s*,\s*)?(\w+)\s*\)',
                sketch_code
            ):
                routes.append((m.group(1), m.group(2)))

            # Extract handler function bodies
            # Match: void handler_name() { ... server.send(...) ... }
            handler_bodies = {}
            for m in re.finditer(
                r'void\s+(\w+)\s*\(\s*\)\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}',
                sketch_code,
                re.DOTALL
            ):
                fname = m.group(1)
                body = m.group(2)
                # Extract server.send() content
                send_match = re.search(
                    r'server\.send\s*\(\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*"([^"]*)"',
                    body
                )
                if not send_match:
                    # Try multi-line string or variable
                    send_match = re.search(
                        r'server\.send\s*\(\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*(\w+)',
                        body
                    )
                if send_match:
                    handler_bodies[fname] = {
                        'status': send_match.group(1),
                        'content_type': send_match.group(2),
                        'content': send_match.group(3),
                    }

        # Build the translated C source
        lines = []
        lines.append('/* Auto-translated from Arduino sketch to ESP-IDF */')
        lines.append('')

        if uses_wifi:
            lines.append(f'#define WIFI_SSID "{_QEMU_WIFI_SSID}"')
            lines.append('#define WIFI_PASS ""')
            lines.append(f'#define STATIC_IP "{_STATIC_IP}"')
            lines.append(f'#define GATEWAY_IP "{_GATEWAY_IP}"')
            lines.append(f'#define NETMASK "{_NETMASK}"')
            lines.append('')

        # Generate HTML content variables from handler bodies
        for fname, info in handler_bodies.items():
            content = info['content']
            if content.startswith('"') or content.startswith("'"):
                content = content.strip('"').strip("'")
            lines.append(f'static const char *{fname}_html = "{content}";')
        lines.append('')

        # Generate ESP-IDF HTTP handlers
        if uses_webserver:
            for path, handler_name in routes:
                info = handler_bodies.get(handler_name, {})
                ct = info.get('content_type', 'text/html')
                lines.append(f'static esp_err_t {handler_name}_handler(httpd_req_t *req) {{')
                lines.append(f'    httpd_resp_set_type(req, "{ct}");')
                if handler_name in handler_bodies:
                    lines.append(f'    return httpd_resp_send(req, {handler_name}_html, HTTPD_RESP_USE_STRLEN);')
                else:
                    lines.append(f'    return httpd_resp_send(req, "OK", 2);')
                lines.append('}')
                lines.append('')

        # Generate webserver start function
        if uses_webserver:
            lines.append('static void start_webserver(void) {')
            lines.append('    httpd_config_t config = HTTPD_DEFAULT_CONFIG();')
            lines.append('    httpd_handle_t server = NULL;')
            lines.append('    if (httpd_start(&server, &config) == ESP_OK) {')
            for path, handler_name in routes:
                uri_var = handler_name + '_uri'
                lines.append(f'        httpd_uri_t {uri_var} = {{')
                lines.append(f'            .uri = "{path}",')
                lines.append(f'            .method = HTTP_GET,')
                lines.append(f'            .handler = {handler_name}_handler')
                lines.append(f'        }};')
                lines.append(f'        httpd_register_uri_handler(server, &{uri_var});')
            lines.append('    }')
            lines.append('}')
            lines.append('')

        # WiFi event handler + init
        if uses_wifi:
            lines.append('static EventGroupHandle_t s_wifi_event_group;')
            lines.append('#define WIFI_CONNECTED_BIT BIT0')
            lines.append('')
            lines.append('static void wifi_event_handler(void *arg, esp_event_base_t base,')
            lines.append('                               int32_t id, void *data) {')
            lines.append('    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START)')
            lines.append('        esp_wifi_connect();')
            lines.append('    else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED)')
            lines.append('        esp_wifi_connect();')
            lines.append('    else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP)')
            lines.append('        xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);')
            lines.append('}')
            lines.append('')
            lines.append('static void wifi_init_sta(void) {')
            lines.append('    s_wifi_event_group = xEventGroupCreate();')
            lines.append('    esp_netif_init();')
            lines.append('    esp_event_loop_create_default();')
            lines.append('    esp_netif_t *sta = esp_netif_create_default_wifi_sta();')
            lines.append('    esp_netif_dhcpc_stop(sta);')
            lines.append('    esp_netif_ip_info_t ip_info;')
            lines.append('    ip_info.ip.addr = ipaddr_addr(STATIC_IP);')
            lines.append('    ip_info.gw.addr = ipaddr_addr(GATEWAY_IP);')
            lines.append('    ip_info.netmask.addr = ipaddr_addr(NETMASK);')
            lines.append('    esp_netif_set_ip_info(sta, &ip_info);')
            lines.append('    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();')
            lines.append('    esp_wifi_init(&cfg);')
            lines.append('    esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,')
            lines.append('        &wifi_event_handler, NULL, NULL);')
            lines.append('    esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,')
            lines.append('        &wifi_event_handler, NULL, NULL);')
            lines.append('    wifi_config_t wifi_config = {')
            lines.append('        .sta = {')
            lines.append('            .ssid = WIFI_SSID,')
            lines.append('            .password = WIFI_PASS,')
            lines.append('            .threshold.authmode = WIFI_AUTH_OPEN,')
            lines.append('        },')
            lines.append('    };')
            lines.append('    esp_wifi_set_mode(WIFI_MODE_STA);')
            lines.append('    esp_wifi_set_config(WIFI_IF_STA, &wifi_config);')
            lines.append('    esp_wifi_start();')
            lines.append('}')
            lines.append('')

        # app_main
        lines.append('void app_main(void) {')
        if uses_wifi:
            lines.append('    esp_err_t ret = nvs_flash_init();')
            lines.append('    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {')
            lines.append('        nvs_flash_erase();')
            lines.append('        nvs_flash_init();')
            lines.append('    }')
            lines.append('    wifi_init_sta();')
            lines.append('    vTaskDelay(pdMS_TO_TICKS(3000));')
        if uses_webserver:
            lines.append('    start_webserver();')
        lines.append('    while (1) {')
        lines.append('        vTaskDelay(pdMS_TO_TICKS(1000));')
        lines.append('    }')
        lines.append('}')

        return '\n'.join(lines) + '\n'

    def _find_arduino_libraries_dir(self) -> Path | None:
        """Find the Arduino global user-libraries directory (installed via arduino-cli).

        P2.1h: when the pro overlay sets VELXIO_FALLBACK_LIBRARIES_DIR (the
        content-addressed cache root, itself a valid libraries dir whose children
        are library folders), prefer it — so the no-manifest scan + the scan-all
        retry resolve from the cache instead of the shared global volume, letting
        the global volume be retired. Unset (OSS self-host) -> legacy global.
        """
        candidates: list[Path] = []
        _fb = os.environ.get('VELXIO_FALLBACK_LIBRARIES_DIR')
        if _fb:
            candidates.append(Path(_fb))
        candidates += [
            Path.home() / 'Arduino' / 'libraries',
            Path.home() / 'Documents' / 'Arduino' / 'libraries',
            Path('/root/Arduino/libraries'),              # Docker / CI as root
            Path('/home/user/Arduino/libraries'),
            Path('/Arduino/libraries'),
        ]
        # Also check arduino-cli's data directory
        for base in [
            Path.home() / '.arduino15',
            Path('/root/.arduino15'),
            Path('/home/user/.arduino15'),
        ]:
            candidates.append(base / 'libraries')

        for c in candidates:
            if c.is_dir():
                logger.info(f'[espidf] Arduino libraries dir: {c}')
                return c
        logger.warning('[espidf] Arduino libraries dir not found')
        return None

    # Headers that will NEVER appear in any Arduino library directory:
    #   - C/C++ standard library headers
    #   - Arduino core API types compiled directly into arduino-esp32 (not installable)
    #
    # Everything else (Wire.h, SPI.h, WiFi.h, Adafruit_GFX.h, …) is resolved
    # dynamically: user-installed libs → IDF component; arduino-esp32 bundled
    # libs → skip (already compiled in); not found → warning.
    _BUILTIN_HEADERS = frozenset({
        # C standard library
        'math.h', 'stdint.h', 'stdio.h', 'stdlib.h', 'string.h', 'stdarg.h',
        'stddef.h', 'stdbool.h', 'float.h', 'limits.h', 'assert.h',
        'ctype.h', 'errno.h', 'inttypes.h', 'locale.h', 'setjmp.h',
        'signal.h', 'time.h', 'wchar.h', 'wctype.h',
        # C++ standard library wrappers and STL.
        # MUST be marked built-in — otherwise the user_libs bundler resolves
        # them against /root/Arduino/libraries/ArduinoSTL (an AVR-only
        # uClibc++ port) and drags in complex.cpp / vector.cpp / …, none of
        # which compile against ESP-IDF's libstdc++.
        'cstdint', 'cstddef', 'cstdio', 'cstdlib', 'cstring', 'cmath',
        'cassert', 'cctype', 'cerrno', 'cfloat', 'climits', 'clocale',
        'csetjmp', 'csignal', 'cstdarg', 'ctime', 'cwchar', 'cwctype',
        'cinttypes',
        'algorithm', 'array', 'atomic', 'bitset', 'chrono', 'codecvt',
        'complex', 'condition_variable', 'deque', 'exception', 'fstream',
        'functional', 'future', 'initializer_list', 'iomanip', 'ios',
        'iosfwd', 'iostream', 'istream', 'iterator', 'limits', 'list',
        'locale', 'map', 'memory', 'mutex', 'new', 'numeric', 'optional',
        'ostream', 'queue', 'random', 'ratio', 'regex', 'set', 'sstream',
        'stack', 'stdexcept', 'streambuf', 'string', 'string_view',
        'system_error', 'thread', 'tuple', 'type_traits', 'typeindex',
        'typeinfo', 'unordered_map', 'unordered_set', 'utility', 'valarray',
        'variant', 'vector', 'any',
        # Arduino core types — part of arduino-esp32 source, not installable libraries
        'Arduino.h', 'HardwareSerial.h', 'Stream.h', 'Print.h', 'WString.h',
        'pgmspace.h', 'IPAddress.h',
    })

    # Core arduino-esp32 bundled libraries — already compiled into the IDF component,
    # must NOT be duplicated as separate user_libs components.
    _CORE_ESP32_LIBS: frozenset[str] = frozenset({
        'Wire', 'SPI', 'WiFi', 'EEPROM', 'SD', 'FS',
        'LittleFS', 'SPIFFS', 'WebServer', 'HTTPClient',
        'WiFiClientSecure', 'BluetoothSerial', 'BLE',
        'Preferences', 'Update', 'Ticker',
    })

    # Headers that ship inside the arduino-esp32 core but don't live in a
    # standalone library dir (so _find_library_for_header can't resolve
    # them). They're already compiled into the core — pulled transitively
    # by WiFi/WebServer/etc. — so a "not found" warning for them is a
    # false positive. Treated as core-provided, not "may fail".
    _CORE_ESP32_HEADERS: frozenset[str] = frozenset({
        'Udp.h', 'IPAddress.h', 'Client.h', 'Server.h', 'Stream.h',
        'Print.h', 'Printable.h', 'WiFiUdp.h', 'WiFiClient.h',
        'WiFiServer.h', 'WiFiType.h', 'esp_wifi.h',
        # Platform headers that do NOT exist in the arduino-esp32 core, so
        # the core-tree scan can't discover them, yet carry names generic
        # enough that some random installed library owns a file by that
        # name. Resolving one drags that whole library into user_libs_all
        # and its sources then fail on THEIR own missing includes.
        #
        # Reported 2026-08-03 (nikas79): ESPAsyncWebServer includes <Hash.h>
        # (an ESP8266-core header, guarded for that platform) and the global
        # scan resolved it to `stemihexapod/src/Hash.h` — a hexapod-robot
        # library — whose Serial.cpp / Hash.cpp / Server.cpp /
        # BluetoothLowEnergy.cpp / ExpansionDriver.cpp then broke every
        # ESP32 build with errors naming libraries the user never installed.
        'Hash.h', 'Serial.h', 'HardwareSerial.h', 'WString.h',
        'WCharacter.h', 'binary.h', 'pins_arduino.h', 'Esp.h',
        # FreeRTOS kernel headers. ESP-IDF ships FreeRTOS and puts its
        # include dir on the path, so a library writing `#include <task.h>`
        # or `<FreeRTOS.h>` means IDF's. The qualified spelling
        # (freertos/FreeRTOS.h) is already dropped by the scan's slash rule;
        # the BARE one used to resolve against the shared cache, where the
        # only owners are an Arduino FreeRTOS port (wrong platform: ESP32
        # has its own) and, for FreeRTOS.h alone, ESP32 BLE Arduino. That is
        # how AsyncTCP's `#include <FreeRTOS.h>` pulled in esp32blearduino,
        # whose src/FreeRTOS.h then failed on 'ringbuf_type_t', breaking
        # every ESPAsyncWebServer build.
        'FreeRTOS.h', 'task.h', 'semphr.h', 'portmacro.h', 'projdefs.h',
        'event_groups.h', 'message_buffer.h', 'stream_buffer.h', 'timers.h',
        'portable.h', 'queue.h', 'croutine.h', 'mpu_wrappers.h',
        'StackMacros.h', 'stack_macros.h', 'deprecated_definitions.h',
    })

    # Config headers the PROJECT is meant to supply, never a library.
    #
    # LVGL's sources do `#include "lv_conf.h"` behind `#if !LV_CONF_SKIP`.
    # The include scan is textual and does not evaluate that guard, so the
    # header is queued even for a build that defines LV_CONF_SKIP=1 and will
    # never read it. Resolving it against the shared library dir then finds
    # whichever installed library vendors its own copy -- Adafruit LvGL Glue
    # ships one written for LVGL v7 -- and merges that ENTIRE library. Its
    # sources fail against the LVGL v8 that the sketch actually uses
    # ("lv_fs_drv_t has no member named 'user_data'", "'file_t' was not
    # declared"), so a sketch whose only LVGL include is <lvgl.h> dies with a
    # wall of errors naming a library the user never asked for. Same failure
    # shape as the Hash.h -> stemihexapod case above. Reported 2026-08-28.
    #
    # A project that DOES ship its own lv_conf.h is unaffected: sketch files
    # are copied into the build's own source dir and found there, not through
    # this library scan.
    _PROJECT_SUPPLIED_HEADERS: frozenset[str] = frozenset({
        'lv_conf.h', 'lv_drv_conf.h', 'user_config.h', 'user_setup.h',
        'sdkconfig.h', 'zconf.h',
    })

    # ...and the general shape of one. Config headers are named by convention
    # across the whole Arduino ecosystem, and one live build showed SIX of
    # them being resolved against the shared library dir in a single compile
    # (sdkconfig.h, lv_conf.h, lv_conf_kconfig.h, lv_rt_thread_conf.h,
    # User_Config.h, zconf.h) — six chances to merge a library nobody asked
    # for.
    _CONFIG_HEADER_SUFFIXES: tuple[str, ...] = ('conf.h', 'config.h', '_setup.h')

    @classmethod
    def _is_project_config_header(cls, header: str) -> bool:
        """Is this a build-configuration header rather than a library API?

        Why skipping the library scan for these is SAFE rather than merely
        convenient: once a library is merged, its own headers are on the
        include path, so a config header shipped BY the library that asks for
        it resolves at compile time without any lookup. The lookup can
        therefore only ever pull in a DIFFERENT library — which for a config
        header is never what the project meant. If the header really is
        missing the compiler says so, naming it, instead of dying inside the
        sources of a library the sketch never mentioned.
        """
        name = Path(header).name.lower()
        return name in cls._PROJECT_SUPPLIED_HEADERS or name.endswith(
            cls._CONFIG_HEADER_SUFFIXES
        )

    # Basenames of C/C++ standard headers. A user library that ships a private
    # header with one of these names (e.g. LovyanGFX's src/lgfx/internal/
    # limits.h, algorithm.h, memory.h, alloca.h) must NOT put that directory on
    # the global -I path: doing so shadows the toolchain header for the WHOLE
    # build. Concretely, FreeRTOS/portmacro.h does `#include <limits.h>` inside
    # an `extern "C"` block (reached via Arduino.h), and if it resolves to
    # LovyanGFX's limits.h — which pulls the C++ <limits> — the compile dies
    # with "template specialization with C linkage". Libraries reach these
    # private headers through file-relative includes (`#include "../internal/
    # limits.h"`), so the directory is never needed on -I. See
    # `_generate_merged_component` where dirs holding these are excluded.
    _SHADOW_STD_HEADERS: frozenset[str] = frozenset({
        'limits.h', 'stdio.h', 'stdlib.h', 'string.h', 'math.h', 'assert.h',
        'ctype.h', 'errno.h', 'time.h', 'stddef.h', 'stdint.h', 'setjmp.h',
        'signal.h', 'locale.h', 'wchar.h', 'stdbool.h', 'stdarg.h', 'float.h',
        'algorithm.h', 'memory.h', 'alloca.h', 'new.h',
        # Not a C standard header, but the same shadowing mechanism: FastLED
        # ships a host-test stub `src/platforms/stub/Arduino.h`. With that dir
        # on the global -I, any OTHER merged library's `#include <Arduino.h>`
        # (e.g. U8g2lib.cpp) resolves to the stub instead of the arduino-esp32
        # core — 'yield' undeclared, and fl::string pollutes String overload
        # resolution inside the core's WString.h. FastLED itself only reaches
        # the stub via the file-relative "platforms/stub/Arduino.h", which
        # still resolves with the directory off -I.
        'arduino.h',
        # Same story with an IDF component header: IDF's esp_http_server.h
        # does #include <http_parser.h> (the http_parser component's enum
        # with HTTP_GET/HTTP_POST/...). FastLED ships its own
        # fl/stl/asio/http/http_parser.h and references it path-qualified
        # only, so keep its directory off -I or the IDF include resolves to
        # FastLED's file and every httpd_method_t use fails to compile.
        'http_parser.h',
    })

    # arduino-esp32 uses a single library architecture id ("esp32") across
    # every chip variant (esp32 / esp32c3 / esp32s3 ...). A library whose
    # library.properties declares architectures= without "esp32" or "*" is
    # built for another platform and must not be pulled into an ESP32 build.
    _ESP32_LIB_ARCH = 'esp32'

    def _core_provided_headers(self) -> frozenset[str]:
        """Header filenames provided by the arduino-esp32 core itself
        (its `cores/` tree plus every bundled library under `libraries/`).

        These are compiled into the arduino-esp32 IDF component, so a user
        library must NEVER shadow them — even when a lib installed in
        ~/Arduino/libraries happens to ship a file by the same name. The
        canonical break this guards against: `WiFiEspAT/src/WiFi.h` (an
        ESP8266 AT-modem library) shadowing the core `WiFi.h`, which drags
        `EspAtDrv.cpp` into the build where its `const char OK[]` /
        `const char STATUS[]` collide with ESP-IDF's
        `enum STATUS { ...OK... }` in rom/ets_sys.h and the compile fails.

        Computed once from the core tree and cached. Always unions the
        static `_CORE_ESP32_HEADERS` fallback so the guard still holds even
        when the core path is unknown (e.g. translation-only mode).
        """
        cached = getattr(self, '_core_headers_cache', None)
        if cached is not None:
            return cached
        headers: set[str] = set(self._CORE_ESP32_HEADERS)
        # Union both installed cores (2.x and 3.x) so the guard holds
        # whichever one a given build selects.
        for core_path in {self.arduino_path, getattr(self, 'arduino5_path', '')}:
            root = Path(core_path) if core_path else None
            if not (root and root.is_dir()):
                continue
            for sub in ('cores', 'libraries'):
                base = root / sub
                if not base.is_dir():
                    continue
                for pattern in ('*.h', '*.hpp'):
                    for f in base.rglob(pattern):
                        headers.add(f.name)
        result = frozenset(headers)
        self._core_headers_cache = result
        logger.info('[espidf] core-provided header set: %d headers', len(result))
        return result

    @staticmethod
    def _parse_library_properties(lib_root: Path) -> dict[str, str]:
        """Best-effort parse of an Arduino library.properties into a dict."""
        props: dict[str, str] = {}
        try:
            text = (lib_root / 'library.properties').read_text(
                encoding='utf-8', errors='ignore'
            )
        except OSError:
            return props
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, _, value = line.partition('=')
            props[key.strip().lower()] = value.strip()
        return props

    def _library_supports_esp32(self, lib_root: Path) -> bool:
        """True if the library may be used on the ESP32 platform.

        A missing/empty `architectures` field means "all architectures"
        (the Arduino default), so we allow it. Only libraries that
        explicitly enumerate architectures WITHOUT esp32/* are rejected —
        those are written for another platform and would not compile.
        """
        arch = self._parse_library_properties(lib_root).get('architectures', '').strip()
        if not arch:
            return True
        arches = {a.strip().lower() for a in arch.split(',') if a.strip()}
        # 'all' is a common non-spec synonym for '*' (e.g. LiquidCrystal_I2C
        # 2.0.0 declares architectures=all) — treating it as unknown skipped
        # the most popular I2C LCD library on every ESP32 build (issue #257).
        return '*' in arches or 'all' in arches or self._ESP32_LIB_ARCH in arches

    @staticmethod
    def _norm_lib_name(name: str) -> str:
        """Normalise a library name for manifest matching: lowercased, only
        alphanumerics. So "Adafruit GFX Library", "Adafruit_GFX_Library" and
        "adafruitgfxlibrary" all compare equal — the Library Manager display
        name and the on-disk folder name differ only by separators/case.

        A manifest entry may carry an install/pin suffix after '@'
        ("M5GFX@0.2.26-df5ac6900fe7", "Lib@wokwi:hash"); only the base name
        identifies the library on disk, so the suffix is stripped before
        normalising — otherwise a pinned entry never matches its own folder
        and the compiler treats the lib as undeclared."""
        return ''.join(ch for ch in (name or '').split('@', 1)[0].lower() if ch.isalnum())

    def _library_in_manifest(self, lib_root: Path, allowed_norm: set[str]) -> bool:
        """True if this library is in the project's declared manifest.
        Matches on the on-disk folder name OR the library.properties `name=`
        (the Library Manager display name), both normalised."""
        if self._norm_lib_name(lib_root.name) in allowed_norm:
            return True
        props_name = self._parse_library_properties(lib_root).get('name', '')
        return bool(props_name) and self._norm_lib_name(props_name) in allowed_norm

    def _find_manifest_library_for_header(
        self, header: str, libs_dir: Path, allowed_norm: set[str]
    ) -> Path | None:
        """Like _find_library_for_header, but returns the source root of the
        first library that provides `header` AND is in the project manifest.
        Returns None when no DECLARED library provides the header — so a stray
        same-named lib in the shared dir is never picked up."""
        for lib_dir in sorted(libs_dir.iterdir()):
            if not lib_dir.is_dir():
                continue
            for src_root in (lib_dir, lib_dir / 'src'):
                if (src_root / header).exists() and self._library_in_manifest(
                    lib_dir, allowed_norm
                ):
                    return src_root
        return None

    @staticmethod
    def _missing_library_headers(result: dict) -> list[str]:
        """Extract the header filenames a failed compile reported as missing
        (`fatal error: X.h: No such file or directory`). De-duped, basename
        only. Used to decide whether a manifest-scoped failure is a missing-
        dependency case worth retrying with scan-all."""
        text = '\n'.join(
            str(result.get(k) or '') for k in ('error', 'stderr', 'stdout')
        )
        headers: list[str] = []
        for m in re.finditer(
            r'fatal error:\s*([A-Za-z0-9_./+-]+\.h(?:pp)?)\s*:\s*No such file',
            text,
        ):
            h = m.group(1).split('/')[-1]
            if h not in headers:
                headers.append(h)
        return headers

    @staticmethod
    def _is_transient_build_failure(result: dict) -> bool:
        """True if a failed compile looks like infrastructure flakiness (cmake
        configure, ESP-IDF nested bootloader / managed-components, a missing
        generated sdkconfig.h, a failed CORE esp-idf object) rather than the
        user's sketch. Such failures hit occasionally on a cold variant build
        and clear on a retry — and are NEVER caused by user code, so retrying
        is safe."""
        if result.get('success'):
            return False
        text = (
            str(result.get('error') or '') + '\n'
            + str(result.get('stderr') or '') + '\n'
            + str(result.get('stdout') or '')
        ).lower()
        markers = (
            'managed_components_list.temp.cmake',
            'cmake configure failed',
            'sdkconfig.h: no such file',
            'ninja: error',
            'esp-idf/bootloader',
            'cmake error',
        )
        return any(m in text for m in markers)

    def _suggest_libraries_for_headers(self, headers: list[str]) -> dict:
        """For each missing header, the installed libraries that provide it
        (by Library Manager display name, else folder name). Returns
        {header: [candidate names]} so a manifest can be completed."""
        arduino_libs = self._find_arduino_libraries_dir()
        out: dict[str, list[str]] = {}
        if not arduino_libs or not arduino_libs.is_dir():
            return out
        for h in headers:
            cands: list[str] = []
            for lib_dir in sorted(arduino_libs.iterdir()):
                if not lib_dir.is_dir():
                    continue
                for src_root in (lib_dir, lib_dir / 'src'):
                    if (src_root / h).exists():
                        name = self._parse_library_properties(lib_dir).get('name') or lib_dir.name
                        if name not in cands:
                            cands.append(name)
                        break
            if cands:
                out[h] = cands
        return out

    def _resolve_library_components(
        self,
        ext_headers: list[str],
        arduino_libs: Path | None,
        esp32_libs: Path | None,
        arduino_comp_name: str,
        user_libs_dir: Path,
        allowed_libraries: set[str] | None = None,
        merged_libs: dict[str, str] | None = None,
        denied: set[str] | None = None,
        speculative_out: set[str] | None = None,
    ) -> tuple[list[str], dict[str, str]]:
        """
        BFS over ext_headers (and transitive includes) to discover all external
        Arduino libraries and merge them into a single 'user_libs_all' IDF component.

        `allowed_libraries` (P2 — project library manifest / scope): when not
        None, a USER-installed library (from arduino_libs) is merged only if its
        name is in this set. This makes the project's declared manifest the
        resolution SCOPE — the compiler never picks up an unrelated library from
        the shared dir (another user's install, or a same-named clash). When
        None (no manifest supplied) the behaviour is the legacy scan-all, so
        existing callers and un-migrated projects are unaffected. Core
        arduino-esp32 libs and bundled esp32_libs are always allowed (they are
        platform-provided, not user installs).

        Layout (see the _PER_LIB_ROOTS note at module scope): every library is
        copied into its OWN subtree of the component and exports exactly ONE
        include root — `<lib>/src`, or `<lib>` for the flat legacy layout, with
        `utility/` kept PRIVATE. That is arduino-cli's model, and the reason a
        library's private internals can no longer hijack another library's (or
        the core's, or ESP-IDF's) `#include`s. One component is deliberate: a
        component per library would swap this failure mode for REQUIRES-order
        shadowing plus IDF component-name collisions, and buys no caching that
        ccache does not already provide.

        Search priority per header:
          1. arduino_libs (user-installed via Library Manager) → merge into component
          2. esp32_libs   (bundled with arduino-esp32) → skip core libs (Wire, SPI, …);
             merge non-core libs (e.g. Adafruit libs shipped with arduino-esp32)
          3. not found → warning only

        Returns:
            component_names  — ['user_libs_all'] if any lib found, else []
            header_to_comp   — every resolved header → 'user_libs_all'
        """
        logger.info(f'[espidf] ext_headers detected: {ext_headers}')
        logger.info(f'[espidf] arduino_libs: {arduino_libs}')
        logger.info(f'[espidf] esp32_libs: {esp32_libs}')

        # P2 manifest scope: normalise the allowed set once (None = scan-all).
        # A manifest entry may carry a pin ("Lib@1.2.3", "Lib@wokwi:<hash>");
        # the name filter compares library names, so split the pin off here.
        allowed_norm: set[str] | None = (
            {self._norm_lib_name(a.split('@', 1)[0]) for a in allowed_libraries}
            if allowed_libraries is not None else None
        )
        if allowed_norm is not None:
            # `or set()` only narrows the Optional for type checkers —
            # allowed_norm being non-None implies allowed_libraries is too.
            logger.info(
                f'[espidf] library manifest scope active: '
                f'{sorted(allowed_libraries or set())}'
            )

        comp_dir = user_libs_dir / 'user_libs_all'
        comp_dir.mkdir(exist_ok=True)

        cpp_files: list[str] = []
        seen_names: set[str] = set()
        header_to_comp: dict[str, str] = {}
        found_any = False

        # Per-library bookkeeping for the Arduino-faithful layout
        # (see _PER_LIB_ROOTS):
        #   lib_include_roots — ONE component-relative include root per library,
        #                       in resolution order (arduino-cli's -I order).
        #   lib_priv_roots    — legacy-layout `utility/` dirs. PRIVATE so they
        #                       reach the library sources that need them without
        #                       entering the sketch's namespace, exactly as
        #                       arduino-cli scopes them to that library's units.
        #   root_header_owner — root header basename -> first library that
        #                       published it, for collision reporting.
        #   lib_prefix_by_name— library dir name -> unique sanitised subdir.
        lib_include_roots: list[str] = []
        lib_priv_roots: list[str] = []
        root_header_owner: dict[str, str] = {}
        lib_prefix_by_name: dict[str, str] = {}
        used_prefixes: set[str] = set()

        headers_to_resolve: list[str] = list(ext_headers)
        # Headers the SKETCH itself included. The config-header guard below
        # applies only to transitively-discovered ones: a direct include is an
        # explicit statement of intent and stays resolvable.
        direct_headers: set[str] = set(ext_headers)
        # Headers the SKETCH itself includes (vs transitive pulls found by
        # re-scanning copied library headers). The architecture guard is
        # advisory for these: the user explicitly asked for the library, and
        # many AVR-declared libs are pure Wire/SPI code that compiles fine on
        # ESP32 — skipping them produced a bare "No such file or directory"
        # (issue #257). Transitive pulls keep the HARD guard: that is the
        # path that dragged SAMD-only Adafruit_ZeroDMA into ESP32 builds.
        direct_headers: set[str] = set(ext_headers)
        resolved_headers: set[str] = set()

        while headers_to_resolve:
            header = headers_to_resolve.pop(0)
            if header in resolved_headers:
                continue
            resolved_headers.add(header)

            # Core-first. arduino-esp32 core headers (WiFi.h, Wire.h, SPI.h,
            # WebServer.h, HTTPClient.h, ...) are compiled into the
            # arduino-esp32 component. They must NEVER resolve to a user
            # library, even when an installed lib ships a same-named file
            # (e.g. WiFiEspAT/src/WiFi.h). Resolving to it would merge that
            # foreign library and break the build. Skip resolution entirely
            # and let the core provide the header.
            if header in self._core_provided_headers():
                logger.info(
                    f'[espidf] <{header}> is provided by the arduino-esp32 core '
                    f'— never resolving against user libraries'
                )
                continue

            # Build-configuration headers pulled in TRANSITIVELY. See
            # _is_project_config_header: resolving these against the shared
            # library dir drags in whatever unrelated library happens to
            # vendor a copy, and that library's sources then fail on their own
            # API in a build that never asked for them.
            if header not in direct_headers and self._is_project_config_header(header):
                logger.info(
                    f'[espidf] <{header}> is a build-config header pulled in '
                    f'transitively — not resolving it against user libraries'
                )
                continue

            # P2 manifest scope. When a manifest is supplied, resolve the header
            # to the DECLARED library that provides it — not the first-
            # alphabetical lib in the shared dir. Several installed libs may
            # ship the same header name (e.g. DHT118266, DHT_sensor_library,
            # servodht11 all have DHT.h); the legacy first-match would pick a
            # stray. The manifest both picks the right lib AND excludes
            # undeclared ones (another user's install, a clash). No manifest =
            # legacy first-match (unchanged).
            if not (arduino_libs and arduino_libs.is_dir()):
                src_root = None
            elif allowed_norm is not None:
                src_root = self._find_manifest_library_for_header(
                    header, arduino_libs, allowed_norm
                )
            else:
                src_root = self._find_library_for_header(header, arduino_libs)

            # Architecture guard. A user lib that resolves the header but
            # whose library.properties declares architectures= without
            # esp32/* is written for a different platform (AVR-only AT-modem
            # shims, etc.) and would not compile against ESP-IDF. Drop it.
            if src_root is not None:
                _lib_root = src_root.parent if src_root.name == 'src' else src_root
                if not self._library_supports_esp32(_lib_root):
                    if header in direct_headers:
                        logger.warning(
                            f'[espidf] <{header}> resolved to "{_lib_root.name}" whose '
                            f'library.properties architectures exclude esp32 — merging '
                            f'anyway because the sketch includes it directly (a real '
                            f'compile error beats "No such file")'
                        )
                    else:
                        logger.warning(
                            f'[espidf] <{header}> resolved to "{_lib_root.name}" but its '
                            f'library.properties architectures exclude esp32 — skipping '
                            f'(transitive pull, not included by the sketch)'
                        )
                        src_root = None

            # Tracks the "resolved to a core lib that's already compiled into
            # the arduino-esp32 component" case, so we don't fall through to
            # the scary "not found — build may fail" warning below for a
            # header that WAS found (just not as a mergeable user lib).
            is_core_provided = False

            if src_root is None and esp32_libs and esp32_libs.is_dir():
                esp32_root = self._find_library_for_header(header, esp32_libs)
                if esp32_root:
                    lib_name = esp32_root.parent.name if esp32_root.name == 'src' else esp32_root.name
                    if lib_name in self._CORE_ESP32_LIBS:
                        is_core_provided = True
                        logger.info(
                            f'[espidf] <{header}> provided by arduino-esp32 core '
                            f'("{lib_name}") — already compiled in, not merging'
                        )
                    else:
                        logger.info(f'[espidf] <{header}> found in esp32_libs as "{lib_name}", merging')
                        src_root = esp32_root

            if src_root:
                lib_dir_name = src_root.parent.name if src_root.name == 'src' else src_root.name
                if denied and lib_dir_name in denied:
                    # Quarantined by a previous attempt: this library's own
                    # sources are what failed the build, and nothing the sketch
                    # named asked for it. See _quarantine_from_error.
                    logger.warning(
                        f'[espidf] <{header}> resolves to quarantined '
                        f'"{lib_dir_name}" — not merging'
                    )
                    continue
                if speculative_out is not None and header not in direct_headers:
                    # Merged for a header the SKETCH never wrote. If the build
                    # dies inside such a library, dropping it is safe: no line
                    # of the user's code asked for it.
                    speculative_out.add(lib_dir_name)
                logger.info(f'[espidf] Merging "{lib_dir_name}" into user_libs_all for <{header}>')
                found_any = True
                header_to_comp[header] = 'user_libs_all'
                if merged_libs is not None:
                    # Report the DISPLAY name (library.properties name=, the
                    # one the Library Manager shows) so the frontend can
                    # auto-declare it in the project manifest. Cache folder
                    # names carry a @version-hash suffix — strip it.
                    _lib_root = src_root.parent if src_root.name == 'src' else src_root
                    _props_name = self._parse_library_properties(_lib_root).get('name', '')
                    merged_libs[header] = _props_name or lib_dir_name.split('@', 1)[0]

                # Preserve directory structure while merging libraries.
                # Skip non-buildable directories like examples, tests, docs.
                lib_root = src_root.parent if src_root.name == 'src' else src_root
                has_src_layout = (lib_root / 'src').is_dir()
                text_included = self._text_included_sources(lib_root)

                excluded_dirs = {
                    '.git', '.github', '.vscode', '__pycache__',
                    'docs', 'doc', 'example', 'examples', 'test', 'tests',
                    'ci', 'fuzz', 'fuzzing', 'benchmark', 'benchmarks',
                }
                # `extras/` is header-only in the merge: FastLED's unity build
                # (src/fl/build/extras+.cpp) does #include
                # "extras/_build.cpp.hpp", so dropping the whole dir breaks the
                # build with "No such file". Its opt-in shims are all
                # .cpp.hpp/.h fragments; copy those, but never compile a
                # .c/.cpp that happens to live there (extras/ traditionally
                # holds repo-only content).
                header_only_dirs = {'extras'}

                def _should_include(rel_path: Path) -> bool:
                    parts = rel_path.parts
                    # A dir named test/examples/docs/... at the REPO level is
                    # repo-only content: fully excluded. The same name NESTED
                    # inside src/ is library code — FastLED has src/fl/test/
                    # whose _build.cpp.hpp the unity build #includes — so
                    # nested matches are demoted to header-only (fragments
                    # copied, sources never compiled) instead of dropped.
                    if parts[0].lower() in excluded_dirs and len(parts) > 1:
                        return False
                    nested_junk = any(
                        p.lower() in excluded_dirs for p in parts[1:-1]
                    )
                    if not has_src_layout and nested_junk:
                        return False
                    if (rel_path.suffix.lower() in ('.c', '.cpp')
                            and (nested_junk
                                 or any(p.lower() in header_only_dirs
                                        for p in parts[:-1]))):
                        return False
                    # Copy compiled sources (.c/.cpp) AND every flavour of header
                    # or text-included fragment. `.inl`/`.inc`/`.ipp`/`.tcc` are
                    # `#include`d verbatim from a sibling source (e.g. M5Unified's
                    # `#include "BMI270_config.inl"`), so dropping them breaks the
                    # build with "No such file or directory" even though the file
                    # ships with the library.
                    if rel_path.suffix.lower() not in (
                        '.h', '.hpp', '.hh', '.hxx', '.c', '.cpp',
                        '.inl', '.inc', '.ipp', '.tcc',
                    ):
                        return False
                    if has_src_layout:
                        # A src/-layout library (Arduino 1.5+ recursive) compiles
                        # src/** and nothing else. Root-level HEADERS are still
                        # copied — harmless, and the root is not on -I anyway —
                        # but a root-level .c/.cpp is not part of the library.
                        # arduino-cli never builds it; we did, and FastLED ships
                        # a developer scratch file there (test_rmt.cpp) that pokes
                        # the ESP32-classic RMT register layout and does not
                        # compile on an S3. That single stray file failed the
                        # build even with FastLED as the ONLY merged library.
                        # Cache-wide this is 3 of 1232 libraries and all three
                        # are junk: fastled/test_rmt.cpp, onewirehub/main.cpp
                        # (a desktop smoke file), seeedarduinombedtls/mbedtls.c
                        # (whose entire content is "// Empty file").
                        if len(parts) == 1 and rel_path.suffix.lower() in ('.c', '.cpp'):
                            return False
                        return parts[0] == 'src' or len(parts) == 1
                    # Non-src-layout libs (Adafruit_GFX, etc.) keep auxiliary
                    # headers in subdirs like Fonts/ or gfxfont/. Anything not
                    # already excluded (docs/examples/tests handled above) is
                    # presumed to be buildable source.
                    return True

                # Destination subtree. Per-library roots keep each library in
                # its OWN directory, so two libraries shipping the same
                # relative path can no longer collapse into a single
                # silently-picked copy; legacy mode interleaves them under the
                # component root (first-resolved wins).
                first_copy = lib_dir_name not in lib_prefix_by_name
                if _PER_LIB_ROOTS:
                    if first_copy:
                        _prefix = _sanitise_lib_dirname(lib_dir_name)
                        if _prefix in used_prefixes:
                            _n = 2
                            while f'{_prefix}_{_n}' in used_prefixes:
                                _n += 1
                            _prefix = f'{_prefix}_{_n}'
                        used_prefixes.add(_prefix)
                        lib_prefix_by_name[lib_dir_name] = _prefix
                    lib_prefix = lib_prefix_by_name[lib_dir_name]
                    dest_root = comp_dir / lib_prefix
                else:
                    lib_prefix = ''
                    lib_prefix_by_name.setdefault(lib_dir_name, '')
                    dest_root = comp_dir

                for f in lib_root.rglob('*'):
                    if not f.is_file():
                        continue
                    rel_path = f.relative_to(lib_root)
                    if not _should_include(rel_path):
                        continue
                    # Track file by its COMPONENT-relative path: it preserves
                    # structure, and in legacy mode it is also the cross-library
                    # dedup key.
                    rel_key = str(rel_path).replace('\\', '/')
                    file_key = f'{lib_prefix}/{rel_key}' if lib_prefix else rel_key
                    if file_key not in seen_names:
                        dest = dest_root / rel_path
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(f, dest)
                        seen_names.add(file_key)
                    if f.suffix in ('.cpp', '.c') and file_key not in cpp_files:
                        # A source the library #includes as text is a fragment,
                        # not a translation unit. Copy it (the includer needs
                        # the file on disk) but never hand it to the compiler.
                        rel_l = rel_key.lower()
                        if any(
                            rel_l == t or rel_l.endswith('/' + t)
                            for t in text_included
                        ):
                            logger.debug(
                                f'[espidf] "{lib_dir_name}": {rel_key} is text-included '
                                f'— copied, not compiled'
                            )
                            continue
                        cpp_files.append(file_key)

                if _PER_LIB_ROOTS and first_copy:
                    # arduino-cli's `SourceDir`: `<lib>/src` for the recursive
                    # layout, `<lib>` for the flat legacy one. Nothing else.
                    lib_include_roots.append(
                        f'{lib_prefix}/src' if has_src_layout else lib_prefix
                    )
                    if not has_src_layout and (lib_root / 'utility').is_dir():
                        lib_priv_roots.append(f'{lib_prefix}/utility')
                    # With one include root per library these root-level headers
                    # are the ONLY ones that can still shadow anything, so they
                    # must not be silent — the Arduino IDE reports the same
                    # thing as "Multiple libraries were found for X.h".
                    _src_dir = (lib_root / 'src') if has_src_layout else lib_root
                    try:
                        for _entry in sorted(_src_dir.iterdir()):
                            if not _entry.is_file():
                                continue
                            if _entry.suffix.lower() not in ('.h', '.hpp', '.hh', '.hxx'):
                                continue
                            _owner = root_header_owner.setdefault(_entry.name, lib_dir_name)
                            if _owner != lib_dir_name:
                                logger.warning(
                                    f'[espidf] header collision: <{_entry.name}> is '
                                    f'published by both "{_owner}" and '
                                    f'"{lib_dir_name}" — "{_owner}" wins (its '
                                    f'include root comes first)'
                                )
                            if _entry.name.lower() in self._SHADOW_STD_HEADERS:
                                logger.warning(
                                    f'[espidf] "{lib_dir_name}" publishes '
                                    f'{_entry.name} at its include root — that '
                                    f'shadows the toolchain/core header for every '
                                    f'library in this build'
                                )
                    except OSError:
                        pass

                # Scan newly copied headers for transitive includes.
                # Use rglob so libs with `src/` layout (e.g. GxEPD2, ArduinoJson)
                # are scanned recursively — otherwise their headers live under
                # `src/`/subdirs and we'd miss every transitive include. Scan
                # ALL header extensions (.h/.hpp/.hh/.hxx/.inc): C++ libs like
                # M5Unified put the transitive `#include <M5GFX.h>` in a .hpp,
                # so a `*.h`-only scan silently drops that dependency.
                # Per-library roots let this scan the library that was JUST
                # copied instead of re-walking every library merged so far —
                # same result (resolved_headers dedups), a fraction of the I/O.
                #
                # Support dirs (extras/, examples/, test/, docs/) are NOT part
                # of the compilation unit — their sources are already excluded
                # above (header_only_dirs / excluded_dirs). Their HEADERS were
                # still scanned, and that is how a build could acquire a
                # dependency nothing in it asked for: Adafruit_GC9A01A ships
                # extras/Adafruit_Arcada_FeatherM4.h, that file includes
                # <arcadatype.h>, and a plain ESP32-S3 sketch with two includes
                # ended up merging 26 libraries and failing inside Adafruit
                # Arcada, a SAMD-only library it never mentioned (2026-09).
                #
                # A handful of libraries DO reach into extras/ for real
                # (FirebaseJson's src/json/FirebaseJson.h, FastLED's unity
                # build), so support headers are held back rather than dropped
                # and released only when a compiled source actually includes a
                # path under one of those dirs.
                if self._SCAN_REACHABLE:
                    # Walk the library's include graph from its entry points.
                    # Resolve against the ORIGINAL tree (lib_root), not the
                    # copy: the copy is a filtered subset, and under the
                    # VELXIO_PER_LIB_ROOTS=0 hatch comp_dir interleaves every
                    # merged library, so "the file next to this one" would
                    # mean another library's file.
                    walked = self._walk_library_includes(
                        lib_root, has_src_layout, _should_include
                    )
                    new_ext = [h for h in walked if h not in resolved_headers]
                    headers_to_resolve.extend(new_ext)
                    logger.info(
                        f'[espidf] "{lib_dir_name}": include walk -> '
                        f'{len(walked)} external header(s), {len(new_ext)} new'
                    )
                    continue

                scan_root = dest_root if _PER_LIB_ROOTS else comp_dir
                deferred_support: list[str] = []
                for lib_file in scan_root.rglob('*'):
                    if lib_file.suffix.lower() not in ('.h', '.hpp', '.hh', '.hxx', '.inc'):
                        continue
                    try:
                        rel_parts = lib_file.relative_to(scan_root).parts[:-1]
                    except ValueError:
                        rel_parts = ()
                    in_support = any(
                        p.lower() in _SUPPORT_ONLY_DIRS for p in rel_parts
                    )
                    sink = deferred_support if in_support else headers_to_resolve
                    try:
                        lib_content = lib_file.read_text(encoding='utf-8', errors='ignore')
                        for th in self._detect_external_includes(lib_content):
                            if th not in resolved_headers:
                                sink.append(th)
                    except OSError:
                        pass
                if deferred_support:
                    if self._support_dirs_are_reachable(scan_root):
                        headers_to_resolve.extend(deferred_support)
                    else:
                        logger.info(
                            f'[espidf] "{lib_dir_name}": held back '
                            f'{len(deferred_support)} transitive include(s) found '
                            f'only under support dirs (extras/, examples/, ...) — '
                            f'no compiled source in the library reaches into them'
                        )
            elif is_core_provided or header in self._CORE_ESP32_HEADERS:
                # Resolved to an arduino-esp32 core lib, or a known core
                # header that lives inside the core (not a standalone lib
                # dir). Already compiled in — not a "build may fail" case.
                if header in self._CORE_ESP32_HEADERS:
                    logger.info(
                        f'[espidf] <{header}> is an arduino-esp32 core header — '
                        f'already compiled in, not merging'
                    )
            else:
                logger.warning(f'[espidf] Library for <{header}> not found — build may fail')

        if not found_any:
            return [], {}

        srcs_line = 'SRCS ' + ' '.join(f'"{f}"' for f in sorted(cpp_files)) if cpp_files else ''

        # Generate INCLUDE_DIRS from the directory structure of copied files.
        # Use PurePosixPath so paths stay forward-slashed on Windows — CMake
        # parses backslashes as string escapes (e.g. "src\bitmaps" → invalid \b).
        # Directories that ship a header shadowing a C/C++ standard header must
        # be kept OFF the global -I path (see `_SHADOW_STD_HEADERS`) — otherwise
        # a stray `#include <limits.h>` deep in FreeRTOS resolves to the
        # library's copy and breaks the build. The files stay copied so the
        # owning library's file-relative includes still resolve.
        priv_include_dirs_line = ''
        if _PER_LIB_ROOTS:
            # ONE include root per library, in resolution order. This is the
            # whole fix: a library's internals stay reachable by its own sources
            # through file-relative includes, and by nobody else. No denylist
            # needed for subdirectories because no subdirectory is ever exported.
            include_dirs_line = 'INCLUDE_DIRS ' + ' '.join(
                f'"{d}"' for d in ['.'] + lib_include_roots
            )
            if lib_priv_roots:
                priv_include_dirs_line = 'PRIV_INCLUDE_DIRS ' + ' '.join(
                    f'"{d}"' for d in lib_priv_roots
                )
            logger.info(
                f'[espidf] include roots ({len(lib_include_roots)} librar'
                f'{"y" if len(lib_include_roots) == 1 else "ies"}): '
                f'{lib_include_roots}'
                + (f' | private: {lib_priv_roots}' if lib_priv_roots else '')
            )
        else:
            # Legacy interleaved layout: every directory holding a copied file
            # is exported, minus the hand-maintained shadow denylist.
            shadow_dirs: set[str] = set()
            for file_key in seen_names:
                if PurePosixPath(file_key).name.lower() in self._SHADOW_STD_HEADERS:
                    parent = str(PurePosixPath(file_key).parent)
                    if parent and parent != '.':
                        shadow_dirs.add(parent)

            include_dirs: set[str] = {'.'}
            for file_key in seen_names:
                parent = str(PurePosixPath(file_key).parent)
                if parent and parent != '.' and parent not in shadow_dirs:
                    include_dirs.add(parent)

            if shadow_dirs:
                logger.info(
                    f'[espidf] kept {len(shadow_dirs)} dir(s) off -I to avoid '
                    f'shadowing standard headers: {sorted(shadow_dirs)}'
                )

            include_dirs_line = 'INCLUDE_DIRS ' + ' '.join(
                f'"{d}"' for d in sorted(include_dirs)
            )

        # LovyanGFX's Bus_EPD.cpp (e-paper bus, compiled unconditionally as part
        # of the M5GFX merge) includes <esp_lcd_panel_io.h>, which is provided by
        # the IDF `esp_lcd` component. Add it to REQUIRES so its headers land on
        # the include path. Guard on the component existing so builds on an IDF
        # without it (esp_lcd landed in IDF 4.4) are unaffected.
        extra_requires = ''
        if self.idf_path and os.path.isdir(
            os.path.join(self.idf_path, 'components', 'esp_lcd')
        ):
            extra_requires = ' esp_lcd'
        # Arduino libraries include IDF headers directly (<nvs.h>,
        # <esp_efuse.h>, <driver/...>, ...). Under IDF 4.4 those arrived
        # transitively through the arduino component's PUBLIC requires; the
        # arduino-esp32 3.x / IDF v5 pairing keeps most of its requires
        # PRIVATE, so the merged user-libs component died one missing header
        # at a time (nvs.h, then esp_efuse.h, ... — M5GFX/M5Unified touch
        # several). Require the standard set Arduino-facing libraries lean
        # on, guarded on existence so both IDF generations stay happy.
        # The tail of the list covers headers Arduino IDE exposes through the
        # core's global include path but a merged IDF component must REQUIRE
        # explicitly — FastLED 3.10 alone pulls <esp_http_server.h> (fl/net),
        # <esp_cache.h> (esp_mm), <esp_heap_caps.h> (heap), <esp_ota_ops.h>
        # (app_update), <esp_bt.h> (bt), <esp_psram.h>, and esp_hw_support /
        # esp_rom / log / esp_system headers from its RMT/I2S drivers. All
        # entries stay guarded on the component existing in the IDF tree.
        for _comp in ('nvs_flash', 'efuse', 'esp_timer', 'driver',
                      'spi_flash', 'esp_adc', 'esp_wifi', 'esp_event',
                      'esp_netif', 'esp_partition', 'esp_http_server',
                      'http_parser', 'esp_mm', 'esp_hw_support', 'heap',
                      'esp_system', 'esp_rom', 'log', 'app_update', 'bt',
                      'esp_psram', 'esp_pm'):
            for _root in filter(None, (self.idf5_path, self.idf_path)):
                if os.path.isdir(os.path.join(_root, 'components', _comp)):
                    extra_requires += f' {_comp}'
                    break

        # LovyanGFX (the engine inside M5GFX) uses alloca()/memcpy_P/memcmp_P
        # without a prior declaration — its C utility files (lgfx_pngle.c, qoi …)
        # call the PROGMEM aliases but never include pgmspace.h, so the flat
        # IDF-component merge trips over an implicit declaration. Map them to
        # always-available equivalents (identical to pgmspace.h, so redefinition
        # is benign) so C++ graphics libs compile as a merged component.
        #
        # ONLY when this component actually compiles something. With no SRCS,
        # idf_component_register() builds an INTERFACE library, and PRIVATE (or
        # PUBLIC) on an INTERFACE target is a hard CMake error:
        #   target_compile_definitions may only set INTERFACE properties on
        #   INTERFACE targets
        # which killed the whole configure step before a single file was
        # compiled. That is the state a HEADER-ONLY library leaves us in —
        # ArduinoJson is the common one — and it is why installing it made every
        # ESP32 build fail while a library with its own .cpp (LiquidCrystal_I2C)
        # was fine. The definitions exist for this component's own C sources, so
        # with no sources there is nothing to define.
        defs_block = ''
        if cpp_files:
            defs_block = (
                '# PROGMEM aliases for library C sources that use them undeclared.\n'
                'target_compile_definitions(${COMPONENT_LIB} PRIVATE'
                ' alloca=__builtin_alloca memcpy_P=memcpy memcmp_P=memcmp)\n'
            )

        # The -Werror relaxations the main component gets, for the same reason
        # but stronger: these are LIBRARY sources the user cannot even edit.
        # M5Stack's own MahonyAHRS.cpp (the fast inverse square root reading a
        # float through a long*) fails under -Werror=uninitialized, which made
        # installing the vendor's library kill every build that used it. Same
        # INTERFACE-library caveat as defs_block: no sources, no options.
        warns_block = ''
        if cpp_files:
            warns_block = (
                '# User libraries must compile as they do in the Arduino IDE.\n'
                'target_compile_options(${COMPONENT_LIB} PRIVATE\n'
                '    -Wno-error=comment -Wno-error=parentheses -Wno-error=sign-compare\n'
                '    -Wno-error=narrowing -Wno-error=write-strings\n'
                '    -Wno-error=missing-field-initializers -Wno-error=reorder\n'
                '    -Wno-error=unused-variable -Wno-error=unused-but-set-variable\n'
                '    -Wno-error=format -Wno-error=format-overflow\n'
                '    -Wno-error=format-truncation -Wno-error=maybe-uninitialized\n'
                '    -Wno-error=misleading-indentation -Wno-error=unused-function\n'
                '    -Wno-error=char-subscripts -Wno-error=array-bounds\n'
                '    -Wno-error=uninitialized)\n'
            )

        _priv_cmake_line = (
            f'    {priv_include_dirs_line}\n' if priv_include_dirs_line else ''
        )
        cmake_content = (
            '# Auto-generated by Velxio — user libraries as one IDF component.\n'
            '# Each library keeps its own subtree and exports exactly ONE include\n'
            '# root (<lib>/src, or <lib> for the flat legacy layout), matching\n'
            "# arduino-cli's resolution semantics. Library internals stay\n"
            '# reachable through file-relative includes and never enter another\n'
            "# library's — or the core's — include path.\n"
            'idf_component_register(\n'
            f'    {srcs_line}\n'
            f'    {include_dirs_line}\n'
            f'{_priv_cmake_line}'
            f'    REQUIRES {arduino_comp_name}{extra_requires}\n'
            ')\n'
            f'{defs_block}'
            f'{warns_block}'
        )
        cmake_path = comp_dir / 'CMakeLists.txt'
        cmake_path.write_text(cmake_content, encoding='utf-8')
        # The component's CMakeLists.txt is a configure dependency. The tree
        # was wiped at prepare (a scan-all variant may resolve a different
        # library set per sketch, so stale files must never survive), but the
        # library files themselves come back through copy2 with their cache
        # mtimes, and this file is the only one ninja would see as new. Give
        # it back its previous mtime when the bytes did not change, so a warm
        # variant with libraries skips the configure like a bare one does.
        _restore_mtime_if_unchanged(
            cmake_path, comp_dir.parent.parent / _USERLIBS_CMAKE_STASH,
        )
        logger.info(
            f'[espidf] user_libs_all: {len(cpp_files)} source files, '
            f'{len(header_to_comp)} resolved headers'
        )
        return ['user_libs_all'], header_to_comp

    # Platform macros we can decide with certainty when scanning a source
    # for #include directives. Everything NOT listed here is unknown, and an
    # expression mentioning an unknown identifier is treated as LIVE — the
    # scanner must never hide a header the compiler will really need.
    _PP_TRUE = frozenset({
        'ESP32', 'ESP_PLATFORM', 'ARDUINO_ARCH_ESP32',
    })
    _PP_FALSE = frozenset({
        'ESP8266', 'ARDUINO_ARCH_ESP8266', '__AVR__', 'ARDUINO_ARCH_AVR',
        'ARDUINO_ARCH_SAMD', 'ARDUINO_ARCH_SAM', 'ARDUINO_ARCH_STM32',
        'ARDUINO_ARCH_RENESAS', 'ARDUINO_ARCH_RP2040', 'ARDUINO_ARCH_MBED',
        'TARGET_RP2040', 'TARGET_RP2350', 'PICO_RP2040', 'PICO_RP2350',
        'CORE_TEENSY', '__MBED__', '__SAMD51__', '__SAM3X8E__',
        'ARDUINO_ARCH_NRF52', 'NRF52', 'TARGET_ESP8266',
        # arduino-esp32 defines USE_TINYUSB only for the TinyUSB CDC mode
        # (ARDUINO_USB_MODE=0). We hardcode ARDUINO_USB_MODE=1 (hardware CDC)
        # on every board, so it is never defined here. Adafruit_NeoPixel.h
        # guards `#include <Adafruit_TinyUSB.h>` on it, which is how a plain
        # NeoPixel sketch merged a library that cannot build in this image.
        'USE_TINYUSB',
    })
    # A has_include INVOCATION is a library-availability PROBE, not a
    # dependency: `#if __has_include(<X.h>)` asks "did the user install X?".
    # Answering "yes" by merging X makes the probe true for the real
    # compiler — we manufacture our own premise, and drag in the library and
    # every one of its sources. During the scan the answer is 0.
    #
    # The open paren is REQUIRED. `#if defined __has_include` (GxEPD2) and
    # `#ifdef __has_include` (lvgl) test whether the compiler SUPPORTS the
    # operator; those must stay live. 27 cached libraries use that form.
    # The `\w*` prefix catches vendor wrappers spelled differently, such as
    # FastLED's `FL_HAS_INCLUDE(x)` -> `__has_include(x)`.
    _PP_HAS_INCLUDE_RE = re.compile(r'\b\w*has_include\s*\(', re.IGNORECASE)
    _PP_IDENT_RE = re.compile(r'[A-Za-z_][A-Za-z_0-9]*')
    _PP_COMMENT_BLOCK_RE = re.compile(r'/\*.*?\*/', re.DOTALL)
    _PP_COMMENT_LINE_RE = re.compile(r'//[^\n]*')

    @classmethod
    def _pp_strip_has_include(cls, expr: str) -> str:
        """Replace every `has_include(...)` invocation with the literal 0.

        Substitution, NOT "the condition mentions has_include so it is dead":
        ESPAsyncWebServer.h:9 is
        `#if !defined(HOST) || __has_include(<lwip/tcpbase.h>)`, and killing
        that branch kills the whole header. Substituting gives
        `!defined(HOST) || 0`, which stays live. Correct either way.
        """
        out: list[str] = []
        i = 0
        while True:
            m = cls._PP_HAS_INCLUDE_RE.search(expr, i)
            if not m:
                out.append(expr[i:])
                break
            out.append(expr[i:m.start()])
            depth = 1
            j = m.end()
            while j < len(expr) and depth:
                if expr[j] == '(':
                    depth += 1
                elif expr[j] == ')':
                    depth -= 1
                j += 1
            if depth:           # unbalanced — leave the text alone
                out.append(expr[m.start():])
                break
            out.append('0')
            i = j
        return ''.join(out)

    def _pp_branch_is_live(self, expr: str) -> bool:
        """Best-effort evaluation of a #if / #elif condition.

        Returns False ONLY when every identifier in the expression is a
        platform macro we know is undefined on ESP32 (so the branch is
        provably dead here). Anything else — unknown macros, arithmetic,
        version checks — is reported LIVE. Being wrong in the LIVE
        direction only costs us the old behaviour; being wrong the other
        way would hide a genuinely needed library.
        """
        expr = self._pp_strip_has_include(expr)
        # Read the condition as a top-level OR of AND-terms; it is dead only
        # when EVERY term is false. This split is what lets
        # `!defined(HOST) || 0` stay live (one live term is enough) while
        # `FL_HAS_INCLUDE(<X>) && defined(ESP32)` dies (one false conjunct
        # sinks the term, whatever else it says).
        for term in expr.split('||'):
            # A conjunct that is EXACTLY the substituted 0 makes the term
            # false. Compared literally after stripping parens so `!0` — a
            # negated probe, which is TRUE — never matches.
            if any(c.strip().strip('()').strip() == '0' for c in term.split('&&')):
                continue
            idents = [
                i for i in self._PP_IDENT_RE.findall(term)
                if i not in ('defined', 'ifdef', 'ifndef')
            ]
            if not idents:
                return True                   # arithmetic/unknown -> live
            if any(i in self._PP_TRUE for i in idents):
                return True
            if not all(i in self._PP_FALSE for i in idents):
                return True                   # something unrecognised -> live
        return False

    def _pp_branch_is_provably_true(self, expr: str) -> bool:
        """True only when EVERY identifier is a macro known-true on ESP32 —
        the only case where the #elif/#else siblings are provably dead.

        This must stay distinct from _pp_branch_is_live: an UNKNOWN condition
        is treated as live for scanning, but it must NOT mark the branch
        chain as taken. GxEPD2 guards its GFX base class as
        `#if ENABLE_GxEPD2_GFX ... #elif ... #else #include <Adafruit_GFX.h>`
        with ENABLE_GxEPD2_GFX defaulting to 0 — treating the unknown #if as
        taken pruned the #else, silently dropped the Adafruit_GFX dependency
        and broke every GxEPD2 e-paper example (found by the gallery compile
        smoke, 2026-08-15).

        A has_include probe is never provably true either, which is what keeps
        FastLED's `#else` fallback (clockless_fake.hpp) scanned."""
        expr = self._pp_strip_has_include(expr)
        idents = [
            i for i in self._PP_IDENT_RE.findall(expr)
            if i not in ('defined', 'ifdef', 'ifndef')
        ]
        return bool(idents) and all(i in self._PP_TRUE for i in idents)

    @staticmethod
    def _support_dirs_are_reachable(scan_root: Path) -> bool:
        """True when a COMPILED file in this library includes a path under a
        support dir (extras/, examples/, ...).

        Only then may headers that live exclusively in those dirs contribute
        transitive dependencies to the build. Rare: 33 of the 1232 cached
        libraries ship headers there at all, and only a few of those (the
        Firebase family, FastLED) actually reach into them.
        """
        for f in scan_root.rglob('*'):
            if f.suffix.lower() not in ('.h', '.hpp', '.hh', '.hxx', '.inc', '.c', '.cpp'):
                continue
            try:
                parts = f.relative_to(scan_root).parts[:-1]
            except ValueError:
                parts = ()
            if any(p.lower() in _SUPPORT_ONLY_DIRS for p in parts):
                continue
            try:
                if _SUPPORT_INCLUDE_RE.search(f.read_text(encoding='utf-8', errors='ignore')):
                    return True
            except OSError:
                continue
        return False

    # A wrong guess can cascade: dropping one speculative library reveals the
    # next. Bounded because each round costs a build — though only on a build
    # that is red without it, and ccache makes the rebuilds incremental.
    _MAX_QUARANTINE_ROUNDS = int(os.environ.get('VELXIO_MAX_QUARANTINE_ROUNDS', '3'))

    # Rollback hatch, mirroring _PER_LIB_ROOTS. Off = the legacy scan that
    # reads every header in the library in isolation.
    _SCAN_REACHABLE = os.environ.get('VELXIO_LIB_SCAN_REACHABLE', '1') not in (
        '0', 'false', 'False', ''
    )

    def _walk_library_includes(
        self, lib_root: Path, has_src_layout: bool, is_source: 'Callable[[Path], bool]'
    ) -> list[str]:
        """External headers a library really needs, by walking its include graph.

        The old scan rglob'd every header in the library and read each one in
        ISOLATION. That charges the build for dependencies of files the
        compiler never opens, and — worse — it cannot see a guard that lives
        one file up. FastLED is the case that forced this:

            src/platforms/adafruit/clockless.cpp.hpp:7
                #if FL_HAS_INCLUDE(<Adafruit_NeoPixel.h>)
                #include "platforms/adafruit/clockless_real.hpp"
            src/platforms/adafruit/clockless_real.hpp:10
                #include <Adafruit_NeoPixel.h>          <- no guard here

        clockless_real.hpp is only reachable from inside that probe, but read
        standalone it looks like an unconditional dependency. An eight-LED
        blink merged fifteen libraries and died inside Adafruit TinyUSB.

        ENTRY POINTS are the compiled sources UNION every header directly at
        the library's include root. The header half is load-bearing, not
        decoration: entering only from sources reaches nothing at all in a
        header-only library (ArduinoJson has no .cpp) and loses
        <Adafruit_GFX.h> from GxEPD2, which is precisely the regression this
        file records for 2026-08-15.

        INTERNAL RESOLUTION mirrors what GCC does under the one-root-per-
        library -I layout (_PER_LIB_ROOTS):
          1. quoted form only: the includer's own directory, which always
             wins for "..." whatever -I says;
          2. either form: the library's single exported include root;
          3. flat layout only: utility/, the other root such libraries get.
        A spec that resolves inside the library contributes NOTHING external:
        it is the library's own file, not a dependency. That is the
        generalised form of "a library's own header is not external", which
        is how FastLED's `#include "lib8tion.h"` used to resolve to UncleRus
        (an unrelated sensor bundle scoring higher on architectures=esp32).
        """
        include_root = lib_root / 'src' if has_src_layout else lib_root
        extra_roots = [] if has_src_layout else [lib_root / 'utility']

        def resolve_internal(from_file: Path, spec: str, quoted: bool) -> Path | None:
            cands = []
            if quoted:
                cands.append(from_file.parent / spec)
            cands.append(include_root / spec)
            cands.extend(r / spec for r in extra_roots)
            for c in cands:
                try:
                    # lvgl writes `../../../../src/...` chains that, unnormalised,
                    # grow until the OS refuses the name (ENAMETOOLONG).
                    real = Path(os.path.normpath(str(c)))
                    real.relative_to(lib_root)      # never escape the library
                    if real.is_file():
                        return real
                except (ValueError, OSError):
                    continue
            return None

        entries: list[Path] = []
        for f in lib_root.rglob('*'):
            if not f.is_file():
                continue
            try:
                rel = f.relative_to(lib_root)
            except ValueError:
                continue
            if not is_source(rel):
                continue
            if f.suffix.lower() in ('.c', '.cpp'):
                entries.append(f)
        if include_root.is_dir():
            for f in include_root.iterdir():
                if f.is_file() and f.suffix.lower() in (
                    '.h', '.hpp', '.hh', '.hxx', '.inc', '.inl', '.ipp', '.tcc'
                ):
                    entries.append(f)

        external: list[str] = []
        seen_ext: set[str] = set()
        visited: set[Path] = set()
        queue = list(dict.fromkeys(entries))
        while queue:
            cur = queue.pop()
            if cur in visited:
                continue
            visited.add(cur)
            try:
                code = cur.read_text(encoding='utf-8', errors='ignore')
            except OSError:
                continue
            for spec, quoted in self._iter_live_includes(code):
                target = resolve_internal(cur, spec, quoted)
                if target is not None:
                    if target not in visited:
                        queue.append(target)
                    continue
                name = self._external_header_name(spec)
                if name and name not in seen_ext:
                    seen_ext.add(name)
                    external.append(name)
        return external

    @staticmethod
    def _quarantine_from_error(result: dict, speculative: set[str]) -> list[str]:
        """Speculatively-merged libraries the build actually died inside.

        Reads only DIAGNOSTIC lines — `...: error:` / `fatal error:` — for a
        path under `user_libs/user_libs_all/<libdir>/`. Scanning the whole
        output would be wrong: the failing compiler command line is echoed
        into it, and every merged library appears there as a `-I` flag, so a
        blob-wide match would quarantine the entire build including the
        library the sketch actually asked for.

        Returns the ones that were resolver guesses (merged for a header the
        sketch never wrote). An error in the sketch, in the core, or in a
        library the user named yields an empty list — those are real errors
        and must surface untouched.
        """
        if not speculative:
            return []
        blob = '\n'.join(
            str(result.get(k) or '') for k in ('error', 'stderr', 'stdout')
        )
        if not blob.strip():
            return []
        found: list[str] = []
        for line in blob.splitlines():
            if 'error:' not in line:
                continue
            for m in re.finditer(r'user_libs_all/([^/\s:]+)/', line):
                name = m.group(1)
                if name in speculative and name not in found:
                    found.append(name)
        return found

    _TEXT_INCLUDED_SRC_RE = re.compile(
        r'#\s*include\s*[<"]([^">]+\.(?:c|cpp))[">]', re.IGNORECASE
    )

    @classmethod
    def _text_included_sources(cls, lib_root: Path) -> set[str]:
        """Source files this library #includes as TEXT, as lowercase suffixes
        of their path ("extensions/smooth_font.cpp", "smooth_font.cpp").

        Such a file is NOT a translation unit and must never be compiled on
        its own. TFT_eSPI.cpp ends with `#include "Extensions/Smooth_font.cpp"`
        and that file opens with `void TFT_eSPI::loadFont(...)` — no includes,
        no class declaration. Compiled standalone it dies with
        "'TFT_eSPI' has not been declared", which is how the most popular
        display library on the site was red on the S3.

        Evidence-based rather than a layout rule: MySensors keeps REAL sources
        in core/ and text-includes them too, so "only the root and utility/"
        would have been both too blunt and, for MySensors, accidentally right
        for the wrong reason. 41 of the 1232 cached libraries do this, over
        407 references.
        """
        out: set[str] = set()
        for f in lib_root.rglob('*'):
            if not f.is_file() or f.suffix.lower() not in (
                '.h', '.hpp', '.hh', '.hxx', '.c', '.cpp', '.inc', '.inl'
            ):
                continue
            try:
                text = f.read_text(encoding='utf-8', errors='ignore')
            except OSError:
                continue
            for m in cls._TEXT_INCLUDED_SRC_RE.finditer(text):
                out.add(m.group(1).replace('\\', '/').lower())
        return out

    def _pp_chain_has_true_arm(self, lines: list[str]) -> dict[int, bool]:
        """Map each chain (keyed by the line index of its `#if`) to whether any
        of its arms is provably true for this target. See the call site."""
        result: dict[int, bool] = {}
        pending: list[list] = []          # [if_line, has_true]
        for idx, raw in enumerate(lines):
            line = raw.strip()
            if not line.startswith('#'):
                continue
            dtv = line[1:].lstrip()
            if dtv.startswith(('ifdef', 'ifndef', 'if ', 'if(')):
                if dtv.startswith('ifdef'):
                    t = self._pp_branch_is_provably_true(dtv[5:])
                elif dtv.startswith('ifndef'):
                    ids = self._PP_IDENT_RE.findall(dtv[6:])
                    t = bool(ids) and all(i in self._PP_FALSE for i in ids)
                else:
                    t = self._pp_branch_is_provably_true(dtv[2:])
                pending.append([idx, t])
            elif dtv.startswith('elif'):
                if pending:
                    pending[-1][1] = (
                        pending[-1][1] or self._pp_branch_is_provably_true(dtv[4:])
                    )
            elif dtv.startswith('endif'):
                if pending:
                    rec = pending.pop()
                    result[rec[0]] = rec[1]
        for rec in pending:               # unterminated chain (truncated file)
            result[rec[0]] = rec[1]
        return result

    def _iter_live_includes(self, code: str) -> list[tuple[str, bool]]:
        """Every `#include` in a branch that is not provably dead on ESP32,
        as (spec, quoted). Verbatim spec: slashes kept, nothing filtered.

        Split out of _detect_external_includes so the reachability walk can
        FOLLOW internal edges. That scanner drops any spec containing '/'
        (they are esp-idf internals as far as it cares), but a library's own
        `#include "platforms/adafruit/clockless_real.hpp"` is exactly how the
        walk gets from one of its files to the next.
        """
        return self._detect_external_includes(code, _raw=True)  # type: ignore[return-value]

    def _detect_external_includes(
        self, code: str, own_files: set[str] | None = None, _raw: bool = False
    ) -> list[str]:
        """Library header names an ESP32 build could really need.

        BOTH include forms count. Arduino treats `#include "Lib.h"` and
        `#include <Lib.h>` alike for libraries, and vendors' own examples lean
        on the quoted form — M5Stack ships `#include "M5Cardputer.h"` in theirs.
        Only scanning the angled form meant such a sketch never reached the
        library resolver at all and died on `fatal error: M5Cardputer.h: No
        such file`, while the very same sketch with angle brackets built fine.
        `own_files` are the sketch's own file names; a quoted include naming one
        of them is a project-local header, not a library.

        Preprocessor-aware: includes that only exist inside a branch which
        is provably dead on ESP32 are skipped. Without this, the scanner
        reported headers the compiler never sees, and each one was resolved
        against the ~1000 installed libraries — dragging an unrelated
        library (and ALL of its sources) into user_libs_all.

        The canonical break, reported 2026-08-03: ESPAsyncWebServer has
        `#if defined(ESP8266) ... #include <Hash.h> ... #endif`. Hash.h was
        resolved to stemi-hexapod's src/Hash.h (a hexapod-robot library),
        whose Serial.cpp / Server.cpp / BluetoothLowEnergy.cpp then failed
        on their own missing includes, breaking every ESP32 build in that
        project with errors naming libraries the user never installed.
        """
        # Comments first: a commented-out include is not an include.
        code = self._PP_COMMENT_BLOCK_RE.sub(' ', code)
        code = self._PP_COMMENT_LINE_RE.sub(' ', code)

        lines = code.splitlines()
        # PRE-PASS: for each #if/#elif/#else chain, does ANY arm evaluate
        # provably true for this target? Platform dispatch is written as one
        # long chain and the arm we take is rarely the first:
        #
        #   #if defined(FL_IS_ARM_LPC)      <- unknown, scanned live today
        #   #elif defined(NRF51)            <- unknown, scanned live today
        #   ... eight more foreign platforms ...
        #   #elif defined(ESP32)            <- PROVABLY TRUE: the one we take
        #
        # A single forward pass can only prune arms AFTER a taken one, so
        # FastLED's whole ARM tree was walked and `<FreeRTOS.h>` (an ARM RTOS
        # port header) resolved to esp32blearduino, whose src/FreeRTOS.h then
        # failed to compile. Knowing the chain has a true arm lets the arms
        # BEFORE it be pruned too — exactly one arm of a chain is ever taken,
        # and we know which.
        chain_true = self._pp_chain_has_true_arm(lines)

        headers: list[str] = []
        own = own_files or set()
        # (this_branch_live, any_branch_taken_yet, chain id = line of its #if)
        stack: list[tuple[bool, bool, int]] = []
        for _ln, raw in enumerate(lines):
            line = raw.strip()
            if line.startswith('#'):
                dtv = line[1:].lstrip()
                if dtv.startswith(('ifdef', 'ifndef', 'if ', 'if(')):
                    # `taken` gates whether LATER #elif/#else arms are dead.
                    # It must be set only by PROVABLY-true conditions: an
                    # unknown #if is scanned as live, but its #else must stay
                    # live too — the real compiler may well take it (the
                    # GxEPD2 ENABLE_GxEPD2_GFX default-0 pattern).
                    if dtv.startswith('ifdef'):
                        live = self._pp_branch_is_live(dtv[5:])
                        taken = self._pp_branch_is_provably_true(dtv[5:])
                    elif dtv.startswith('ifndef'):
                        # #ifndef X is live unless X is known-defined here,
                        # and provably TRUE when X is known-undefined.
                        idents = self._PP_IDENT_RE.findall(dtv[6:])
                        live = not any(i in self._PP_TRUE for i in idents)
                        taken = bool(idents) and all(i in self._PP_FALSE for i in idents)
                    else:
                        live = self._pp_branch_is_live(dtv[2:])
                        taken = self._pp_branch_is_provably_true(dtv[2:])
                    # Some LATER arm of this chain is the one we take.
                    if chain_true.get(_ln) and not taken:
                        live = False
                    stack.append((live, taken, _ln))
                    continue
                if dtv.startswith('elif'):
                    if stack:
                        _cur, taken, cid = stack[-1]
                        arm_true = self._pp_branch_is_provably_true(dtv[4:])
                        live = (not taken) and self._pp_branch_is_live(dtv[4:])
                        if chain_true.get(cid) and not arm_true:
                            live = False
                        stack[-1] = (live, taken or arm_true, cid)
                    continue
                if dtv.startswith('else'):
                    if stack:
                        _cur, taken, cid = stack[-1]
                        # A chain with a provably-true arm never reaches its
                        # #else, whether or not that arm came first.
                        stack[-1] = ((not taken) and not chain_true.get(cid), True, cid)
                    continue
                if dtv.startswith('endif'):
                    if stack:
                        stack.pop()
                    continue
            if not all(live for live, _t, _c in stack):
                continue  # inside a branch that is dead on ESP32
            m = re.search(r'#\s*include\s*(?:<([^>]+)>|"([^"]+)")', line)
            if not m:
                continue
            h = m.group(1) or m.group(2)
            if _raw:
                # The walk wants the spec exactly as written, plus its form.
                headers.append((h, m.group(2) is not None))
                continue
            if h in own:
                continue
            if h in self._BUILTIN_HEADERS:
                continue
            # Skip paths with / (esp-idf internal headers like freertos/FreeRTOS.h)
            if '/' in h:
                continue
            # Skip headers that look like esp-idf internal (prefix pattern)
            if re.match(r'^(esp_|driver/|soc/|hal/|nvs|rom/)', h):
                continue
            headers.append(h)
        return headers

    def _external_header_name(self, spec: str) -> str | None:
        """The library header a spec names, or None when it is not one.

        The same filters _detect_external_includes applies at the end of its
        scan, factored out so the walk can apply them only to the specs that
        did NOT resolve inside the library.
        """
        if spec in self._BUILTIN_HEADERS:
            return None
        if '/' in spec:
            return None
        if re.match(r'^(esp_|driver/|soc/|hal/|nvs|rom/)', spec):
            return None
        return spec

    def _find_library_for_header(self, header: str, libs_dir: Path) -> Path | None:
        """
        Search libs_dir for a library that provides `header`, preferring the
        best-named candidate instead of the first alphabetical one.

        First-alphabetical was how <Servo.h> (6 providers in the live cache)
        could resolve to a random lib that merely ships a same-named file,
        and how generic headers landed on unrelated libraries. Scoring:

          +100  normalized library name == normalized header stem
                ("Servo.h" -> the lib actually named Servo/ESP32Servo...)
           +40  library.properties architectures lists esp32 explicitly
                (purpose-built beats a wildcard/absent declaration)
           +20  library name CONTAINS the header stem, minus a length
                penalty so "servo" outranks "simpleservoesp32"

        Alphabetical remains the final tie-break so resolution stays
        deterministic. Libraries with score 0 still resolve (legacy
        behaviour) — this only changes WHICH provider wins when several
        exist.
        """
        stem = self._norm_lib_name(Path(header).stem)
        best: tuple[float, str, Path] | None = None
        for lib_dir in sorted(libs_dir.iterdir()):
            if not lib_dir.is_dir():
                continue
            src_root = None
            for cand in (lib_dir, lib_dir / 'src'):
                if (cand / header).exists():
                    src_root = cand
                    break
            if src_root is None:
                continue
            # Folder names in the shared cache look like "esp32servo@3.2.1-<hash>"
            # — strip the version suffix before comparing.
            folder = lib_dir.name.split('@', 1)[0]
            props = self._parse_library_properties(lib_dir)
            names = {self._norm_lib_name(folder)}
            if props.get('name'):
                names.add(self._norm_lib_name(props['name']))
            score = 0.0
            if stem and stem in names:
                score += 100
            arch = {a.strip().lower() for a in props.get('architectures', '').split(',') if a.strip()}
            if self._ESP32_LIB_ARCH in arch:
                score += 40
            if stem and score < 100 and any(stem in n for n in names if n):
                shortest = min((len(n) for n in names if stem in n), default=0)
                score += max(5.0, 20.0 - (shortest - len(stem)) * 0.5)
            if best is None or score > best[0]:
                best = (score, lib_dir.name, src_root)
        return best[2] if best else None

    def _create_idf_component(
        self,
        header: str,
        src_root: Path,
        user_libs_dir: Path,
        arduino_comp_name: str,
    ) -> str:
        """
        Create a proper ESP-IDF component for a library in user_libs_dir.

        Each library becomes user_libs/<comp_name>/ with its own CMakeLists.txt
        that calls idf_component_register(). This is the correct ESP-IDF way to
        include third-party code and properly handles include paths so that
        internal library includes like #include "utility/xyz.h" work correctly.

        Returns the component directory name (used in REQUIRES of main).
        """
        # Sanitise name: use the library directory name, not the header name
        # src_root may be the library root OR lib/src/ — handle both cases
        lib_dir_name = src_root.parent.name if src_root.name == 'src' else src_root.name
        safe_name = re.sub(r'[^A-Za-z0-9_]', '_', lib_dir_name)
        comp_dir = user_libs_dir / safe_name
        comp_dir.mkdir(parents=True, exist_ok=True)

        # Preserve the original library layout for actual buildable library code
        # while skipping repo-only content such as examples, tests, and CI files.
        lib_root = src_root.parent if src_root.name == 'src' else src_root
        include_dirs: set[str] = {'.'}
        cpp_files: set[str] = set()
        copied_any = False

        has_src_layout = (lib_root / 'src').is_dir()
        excluded_dirs = {
            '.git',
            '.github',
            '.vscode',
            '__pycache__',
            'docs',
            'doc',
            'example',
            'examples',
            'test',
            'tests',
            'ci',
            'fuzz',
            'fuzzing',
            'benchmark',
            'benchmarks',
        }
        # Same header-only treatment of extras/ as _generate_merged_component:
        # unity builds may #include "extras/..." fragments.
        header_only_dirs = {'extras'}

        def should_include(relative_path: Path) -> bool:
            parts = relative_path.parts
            if any(part.lower() in excluded_dirs for part in parts[:-1]):
                return False
            if (relative_path.suffix.lower() in ('.c', '.cpp')
                    and any(p.lower() in header_only_dirs
                            for p in parts[:-1])):
                return False
            if relative_path.suffix not in ('.h', '.hpp', '.c', '.cpp'):
                return False

            if has_src_layout:
                # Same rule as _should_include: src/** is the library, a
                # root-level .c/.cpp is not (see the note there).
                if len(parts) == 1 and relative_path.suffix.lower() in ('.c', '.cpp'):
                    return False
                return parts[0] == 'src' or len(parts) == 1

            return len(parts) == 1 or parts[0].lower() == 'utility'

        for f in lib_root.rglob('*'):
            if not f.is_file():
                continue
            rel_path = f.relative_to(lib_root)
            if not should_include(rel_path):
                continue
            dest = comp_dir / rel_path
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dest)
            copied_any = True
            include_dirs.add(str(rel_path.parent).replace('\\', '/'))
            if f.suffix in ('.cpp', '.c'):
                cpp_files.add(str(rel_path).replace('\\', '/'))

        if not copied_any:
            raise ValueError(f'No buildable source files found in library {lib_dir_name}')

        # Generate CMakeLists.txt for this component
        include_dirs.discard('.')
        ordered_include_dirs = ['.'] + sorted(d for d in include_dirs if d and d != '.')

        if cpp_files:
            srcs_line = 'SRCS ' + ' '.join(f'"{f}"' for f in sorted(cpp_files))
        else:
            srcs_line = '# header-only library'

        include_dirs_line = 'INCLUDE_DIRS ' + ' '.join(
            f'"{include_dir}"' for include_dir in ordered_include_dirs
        )

        cmake_content = (
            f'# Auto-generated by Velxio for library: {lib_dir_name}\n'
            f'idf_component_register(\n'
            f'    {srcs_line}\n'
            f'    {include_dirs_line}\n'
            f'    REQUIRES {arduino_comp_name}\n'
            f')\n'
        )
        (comp_dir / 'CMakeLists.txt').write_text(cmake_content, encoding='utf-8')

        logger.info(
            f'[espidf] Created IDF component "{safe_name}" for <{header}>'
            f' ({len(cpp_files)} source file(s))'
        )
        return safe_name

    def _discover_espressif_win(
        self, idf_path: Optional[str] = None
    ) -> tuple[str | None, str | None]:
        """Locate the Espressif install (tools root + registered Python venv).

        The official Windows offline installer writes ``esp_idf.json`` at the
        install root recording ``idfToolsPath`` and the exact python venv for
        each installed IDF version. Parsing it lets a backend launched from ANY
        shell (no ``export.ps1``) still find the cross-compilers and the
        confgen venv. Returns ``(tools_root, python_env_dir)``; either may be
        ``None`` if it can't be resolved. Windows only.

        ``idf_path`` selects WHICH install to discover (each IDF root ships
        its own ``esp_idf.json`` two levels up); defaults to the pinned 4.4
        tree for backwards compatibility.
        """
        idf_path = idf_path or self.idf_path
        candidate_roots: list[str] = []
        if idf_path:
            # Installer layout: <root>/frameworks/esp-idf-vX  →  <root>
            candidate_roots.append(
                os.path.abspath(os.path.join(idf_path, '..', '..'))
            )
        candidate_roots.append(r'C:\Espressif')

        for root in candidate_roots:
            cfg = os.path.join(root, 'esp_idf.json')
            if not os.path.isfile(cfg):
                continue
            try:
                with open(cfg, 'r', encoding='utf-8') as fh:
                    data = json.load(fh)
            except Exception as e:  # noqa: BLE001 — best-effort discovery
                logger.warning(f'[espidf] could not parse {cfg}: {e}')
                continue
            tools_root = data.get('idfToolsPath') or root
            py_env: str | None = None
            installed = data.get('idfInstalled') or {}
            want = os.path.normcase(os.path.abspath(idf_path)) if idf_path else None
            for info in installed.values():
                ipath = (info.get('path') or '').rstrip('/\\')
                pexe = info.get('python') or ''
                if not pexe:
                    continue
                # python.exe lives at <env>/Scripts/python.exe → <env>
                env_dir = os.path.dirname(os.path.dirname(pexe))
                if want and ipath and os.path.normcase(os.path.abspath(ipath)) == want:
                    py_env = env_dir  # exact IDF match wins
                    break
                if py_env is None:
                    py_env = env_dir  # first registered as fallback
            return tools_root, py_env

        # No metadata found: derive the root from IDF_PATH.
        if idf_path:
            return os.path.abspath(os.path.join(idf_path, '..', '..')), None
        return r'C:\Espressif', None

    def _build_env(
        self,
        idf_target: str,
        use_idf5: Optional[bool] = None,
        arduino_mode: Optional[bool] = None,
        pure_idf: bool = False,
    ) -> dict:
        """Build environment dict for ESP-IDF subprocess.

        Per-compile IDF selection (see _use_idf5): pure-IDF builds default
        to the v5.x install for the whole family; Arduino-as-component
        builds fall back to the pinned v4.4.7 install their 2.x core is
        built for. Everything derived from the IDF root — tools root,
        python venv, toolchain PATH — follows that choice.

        ``pure_idf`` is the user's LANGUAGE mode (issue #139), a different
        axis from ``arduino_mode``: it raises VELXIO_PURE_SKETCH so
        main/CMakeLists.txt compiles the user's own app_main() sources
        instead of the Arduino sketch wrapper. Both drop
        ARDUINO_ESP32_PATH, but a target that merely lacks an arduino-esp32
        core (arduino_mode False) still hands a SKETCH to the legacy
        translator — it must not take the pure glob.
        """
        # A pure-IDF build is never Arduino-as-component, whatever the target
        # supports: the template CMake pulls the arduino-esp32 component in as
        # soon as ARDUINO_ESP32_PATH exists, so leaving it set would compile
        # the Arduino core into a build that has no sketch at all.
        if pure_idf:
            arduino_mode = False
        if arduino_mode is None:
            arduino_mode = self._arduino_supports_target(idf_target)
        if use_idf5 is None:
            use_idf5 = self._use_idf5(idf_target, arduino_mode)
        env = os.environ.copy()
        idf_path = self._idf_root(use_idf5) or self.idf_path
        is_idf5 = use_idf5
        env['IDF_PATH'] = idf_path
        env['IDF_TARGET'] = idf_target

        if arduino_mode:
            # Pick the core matching the chosen IDF major: 3.x on v5,
            # 2.x on v4.4.
            env['ARDUINO_ESP32_PATH'] = self._arduino_path_for(use_idf5)
            # arduino-esp32 3.x refuses to configure unless the IDF version
            # is within its supported window; the 3.3.x/IDF-5.5.4 pair is,
            # but keep this defensive so a future minor bump doesn't hard-
            # fail the configure before we notice.
            env['ARDUINO_SKIP_IDF_VERSION_CHECK'] = '1'
        else:
            # The project template switches to Arduino-as-component whenever
            # ARDUINO_ESP32_PATH is defined — make sure an ambient value
            # can't drag a pure-IDF build (or an unsupported target such as
            # esp32c6 with no 3.x core) into that mode.
            env.pop('ARDUINO_ESP32_PATH', None)
        if pure_idf:
            # Only the explicit language mode takes the pure glob; see the
            # docstring for why arduino_mode alone must not.
            env['VELXIO_PURE_SKETCH'] = '1'

        # On Windows, ESP-IDF uses its own Python venv and out-of-PATH tools.
        # We self-configure so a backend launched from a plain shell (no
        # export.ps1) still compiles. The tricky part on multi-install boxes:
        # ambient IDF_TOOLS_PATH / IDF_PYTHON_ENV_PATH can point at a DIFFERENT
        # IDF version than IDF_PATH (e.g. IDF_TOOLS_PATH=C:\Espressif5.5 while we
        # build with the 4.4 install under C:\Espressif). So we trust the
        # per-install metadata (esp_idf.json) and VALIDATE every candidate root
        # actually contains a matching xtensa toolchain before using it.
        # os.name goes through str() ONLY so type checkers pinned to a
        # single platform (typeshed types os.name as Literal['nt'] under
        # Windows analysis) keep the Linux/Docker branch below reachable —
        # this backend deploys on both. Runtime behaviour is identical.
        if str(os.name) == 'nt':
            # A backend launched from Git Bash inherits MSYSTEM, and ESP-IDF
            # 5.x's idf_tools.py fatals on its mere presence ("MSys/Mingw is
            # not supported") during cmake's python-dependency check. The
            # build subprocess is a plain Windows process either way — scrub
            # the variable so the launching shell can't poison the build.
            env.pop('MSYSTEM', None)

            discovered_root, registered_py = self._discover_espressif_win(idf_path)

            # ── Python venv (confgen / kconfiglib) ──
            # The installer-registered venv is version-matched and authoritative;
            # prefer it over an ambient IDF_PYTHON_ENV_PATH that may be stale
            # (this box's env var points at the broken py3.10). Only fall back to
            # the override / derived paths when no registered venv exists.
            if is_idf5:
                # Known-good recipe for the v5.x install: it ships NO
                # python_env of its own (idfInstalled is empty in its
                # esp_idf.json), and the 4.4 py3.10 venv on this layout has
                # the v5.x core requirements pip-installed into it. Ambient
                # IDF_PYTHON_ENV_PATH is not trusted here — it points at
                # whatever the 4.4 flow last used.
                py_candidates: tuple[str | None, ...] = (
                    os.environ.get('IDF5_PYTHON_ENV_PATH'),
                    registered_py,
                    r'C:\Espressif\python_env\idf4.4_py3.10_env',
                )
            else:
                py_candidates = (
                    registered_py,
                    os.environ.get('IDF_PYTHON_ENV_PATH'),
                    os.path.join(os.path.dirname(idf_path), '..',
                                 'python_env', 'idf4.4_py3.10_env'),
                    r'C:\Espressif\python_env\idf4.4_py3.10_env',
                )
            for cand in py_candidates:
                if cand and os.path.isdir(cand):
                    py_venv = cand
                    break
            else:
                py_venv = None
            if py_venv:
                env['PATH'] = os.path.join(py_venv, 'Scripts') + os.pathsep + env.get('PATH', '')
                env['VIRTUAL_ENV'] = py_venv
                if is_idf5:
                    # IDF 5.x cmake honours IDF_PYTHON_ENV_PATH when picking
                    # its interpreter — pin it so an ambient 4.4-era value
                    # can't win over the resolved venv.
                    env['IDF_PYTHON_ENV_PATH'] = py_venv

            # ── Cross-compilers + build tools ──
            # Pick the first candidate root that actually holds the toolchain
            # THIS target compiles with (validates against version mismatch);
            # if none does, take the first existing dir so at least host tools
            # resolve. The old xtensa-only glob wrongly rejected RISC-V-only
            # roots such as the v5.x install used for esp32c6.
            xtensa_glob = 'tools/xtensa-esp32-elf/*/xtensa-esp32-elf/bin'
            if idf_target in ('esp32c3', 'esp32c6', 'esp32p4', 'esp32c5'):
                required_globs: tuple[str, ...] = (
                    'tools/riscv32-esp-elf/*/riscv32-esp-elf/bin',
                )
            else:
                # IDF 4.4 ships per-chip xtensa toolchains; 5.x unifies them
                # under xtensa-esp-elf.
                required_globs = (
                    xtensa_glob,
                    'tools/xtensa-esp-elf/*/xtensa-esp-elf/bin',
                )
            if is_idf5:
                # v5.x targets must resolve against the v5.x root only:
                # ambient IDF_TOOLS_PATH / C:\Espressif hold 4.4-era
                # toolchains that would pass the riscv glob but cannot
                # build IDF 5.x sources.
                root_candidates = [
                    discovered_root,
                    os.path.abspath(os.path.join(idf_path, '..', '..')) if idf_path else None,
                ]
            else:
                root_candidates = [
                    discovered_root,
                    os.environ.get('IDF_TOOLS_PATH'),
                    os.path.abspath(os.path.join(idf_path, '..', '..')) if idf_path else None,
                    r'C:\Espressif',
                    os.path.expanduser(r'~\.espressif'),
                ]
            tools_path = None
            first_existing = None
            for cand in root_candidates:
                if not cand or not os.path.isdir(cand):
                    continue
                if first_existing is None:
                    first_existing = cand
                if any(any(Path(cand).glob(g)) for g in required_globs):
                    tools_path = cand
                    break
            tools_path = tools_path or first_existing

            if tools_path:
                env['IDF_TOOLS_PATH'] = tools_path
                # Note: ninja and ccache live directly under tools/<name>/<ver>/
                # (no bin/ subdir), so the generic tools/*/*/bin glob misses
                # them — enumerate them explicitly. Order: put toolchains first.
                prepend: list[str] = []
                for pattern in (
                    xtensa_glob,
                    'tools/xtensa-esp-elf/*/xtensa-esp-elf/bin',
                    'tools/riscv32-esp-elf/*/riscv32-esp-elf/bin',
                    'tools/cmake/*/bin',
                    'tools/ninja/*',
                    'tools/ccache/*',
                    'tools/ccache/*/*',  # windows: ccache/<ver>/ccache-<ver>-windows-64/
                    'tools/*/*/bin',
                ):
                    for d in Path(tools_path).glob(pattern):
                        if d.is_dir() and (any(d.glob('*.exe')) or pattern != 'tools/ccache/*/*'):
                            prepend.append(str(d))
                # De-duplicate while preserving order.
                seen: set[str] = set()
                ordered = [d for d in prepend if not (d in seen or seen.add(d))]
                if ordered:
                    env['PATH'] = os.pathsep.join(ordered) + os.pathsep + env['PATH']
        else:
            # Linux/Docker: explicitly add toolchain bin dirs to PATH so cmake
            # can find the cross-compilers even when the process wasn't started
            # with export.sh (e.g. after a uvicorn restart or in tests).
            tools_path = os.environ.get('IDF_TOOLS_PATH', os.path.expanduser('~/.espressif'))
            env['IDF_TOOLS_PATH'] = tools_path
            if os.path.isdir(tools_path):
                # Pin the IDF Python venv. Without IDF_PYTHON_ENV_PATH, IDF's
                # cmake derives the venv dir name from the SYSTEM python
                # version — which in the docker image can differ from the
                # python the venv was built with (the image ships
                # idf5.5_py3.10_env; a py3.12 system python makes cmake look
                # for idf5.5_py3.12_env and fail with "python doesn't
                # exist"). Glob the env matching the chosen IDF major
                # instead of trusting the name derivation.
                ver_prefix = 'idf5.' if is_idf5 else 'idf4.'
                # Newest first: when several envs exist (e.g. a stale one
                # from an older base image beside the freshly created one),
                # the highest python version is the one the image can run.
                for venv in sorted(Path(tools_path).glob(f'python_env/{ver_prefix}*_env'),
                                   reverse=True):
                    if (venv / 'bin' / 'python').exists():
                        env['IDF_PYTHON_ENV_PATH'] = str(venv)
                        # We invoke cmake DIRECTLY (not through idf.py), and
                        # IDF's cmake resolves its PYTHON property as the bare
                        # `python` from PATH — IDF_PYTHON_ENV_PATH alone is
                        # ignored in that flow. Prepend the venv's bin so the
                        # bare name resolves to the venv interpreter (this is
                        # what made "interface_version: invalid choice" persist:
                        # the SYSTEM python's ancient idf-component-manager was
                        # answering instead of the venv's).
                        env['PATH'] = (str(venv / 'bin') + os.pathsep
                                       + env.get('PATH', ''))
                        env['VIRTUAL_ENV'] = str(venv)
                        break
                extra_paths: list[str] = []
                # Xtensa toolchain: ESP32/S2 -> xtensa-esp32-elf,
                # ESP32-S3 -> xtensa-esp32s3-elf (IDF 4.4), unified on 5.x.
                for tc_dir in Path(tools_path).glob('tools/xtensa-esp32-elf/*/xtensa-esp32-elf/bin'):
                    extra_paths.append(str(tc_dir))
                for tc_dir in Path(tools_path).glob('tools/xtensa-esp32s3-elf/*/xtensa-esp32s3-elf/bin'):
                    extra_paths.append(str(tc_dir))
                for tc_dir in Path(tools_path).glob('tools/xtensa-esp-elf/*/xtensa-esp-elf/bin'):
                    extra_paths.append(str(tc_dir))
                # RISC-V toolchain (ESP32-C3)
                for tc_dir in Path(tools_path).glob('tools/riscv32-esp-elf/*/riscv32-esp-elf/bin'):
                    extra_paths.append(str(tc_dir))
                # cmake / ninja / ccache — ninja and ccache have no bin/ subdir,
                # so the tools/*/*/bin glob below misses them; add explicitly.
                for tool_dir in Path(tools_path).glob('tools/cmake/*/bin'):
                    extra_paths.append(str(tool_dir))
                for tool_dir in Path(tools_path).glob('tools/ninja/*'):
                    if tool_dir.is_dir():
                        extra_paths.append(str(tool_dir))
                for tool_dir in Path(tools_path).glob('tools/ccache/*'):
                    if tool_dir.is_dir():
                        extra_paths.append(str(tool_dir))
                for tool_dir in Path(tools_path).glob('tools/ccache/*/*'):
                    if tool_dir.is_dir() and any(tool_dir.glob('ccache*')):
                        extra_paths.append(str(tool_dir))
                # ESP-IDF host tools (esptool, partition_table, etc.)
                for tool_dir in Path(tools_path).glob('tools/*/*/bin'):
                    extra_paths.append(str(tool_dir))
                # De-duplicate while preserving order.
                _seen: set[str] = set()
                extra_paths = [d for d in extra_paths if not (d in _seen or _seen.add(d))]
                # Both IDF generations install their toolchains under the SAME
                # tools root (riscv32-esp-elf/esp-2021r2... for 4.4 next to
                # esp-14.2.0... for 5.5). Whichever glob order put first won
                # the PATH race — the C6 build failed its tool-version check
                # against the 8.4 GCC, and classic builds died mid-compile on
                # newlib header mismatches. Order by the versions the CHOSEN
                # IDF tree declares in its tools.json instead.
                preferred_versions: set[str] = set()
                try:
                    with open(os.path.join(idf_path, 'tools', 'tools.json'),
                              encoding='utf-8') as fh:
                        for tool in json.load(fh).get('tools', []):
                            for v in tool.get('versions', []):
                                if v.get('status') == 'recommended' and v.get('name'):
                                    preferred_versions.add(str(v['name']))
                except (OSError, ValueError):
                    pass
                if preferred_versions:
                    extra_paths.sort(
                        key=lambda p: 0 if any(v in p for v in preferred_versions) else 1)
                if extra_paths:
                    env['PATH'] = os.pathsep.join(extra_paths) + os.pathsep + env.get('PATH', '')

        return env

    # ── Board options → sdkconfig / partition translation ───────────────
    # Per-board ESP32 build options arrive as a loose dict from the
    # frontend. _normalize_options validates the known keys and fills in
    # defaults; _render_sdkconfig and _render_partition_csv then turn the
    # normalised dict into the two files cmake reads at configure time.

    # Schemes available in the UI. Each CSV is a verbatim copy of the
    # arduino-esp32 partition table layout for that name. Keys must match
    # ESP32PartitionScheme on the frontend.
    _PARTITION_CSVS: dict[str, str] = {
        # Velxio's historical default: single huge factory app, no OTA.
        # Picking this as the fallback keeps pre-feature projects byte-for-byte
        # compatible (compiled apps stayed under 3 MB).
        'huge_app': (
            '# Name,   Type, SubType, Offset,  Size, Flags\n'
            'nvs,      data, nvs,     0x9000,  0x5000,\n'
            'otadata,  data, ota,     0xe000,  0x2000,\n'
            'app0,     app,  ota_0,   0x10000, 0x300000,\n'
            'spiffs,   data, spiffs,  0x310000,0xE0000,\n'
            'coredump, data, coredump,0x3F0000,0x10000,\n'
        ),
        'default': (
            '# Name,   Type, SubType, Offset,  Size, Flags\n'
            'nvs,      data, nvs,     0x9000,  0x5000,\n'
            'otadata,  data, ota,     0xe000,  0x2000,\n'
            'app0,     app,  ota_0,   0x10000, 0x140000,\n'
            'app1,     app,  ota_1,   0x150000,0x140000,\n'
            'spiffs,   data, spiffs,  0x290000,0x150000,\n'
            'coredump, data, coredump,0x3E0000,0x10000,\n'
        ),
        'defaults_ffat': (
            '# Name,   Type, SubType, Offset,  Size, Flags\n'
            'nvs,      data, nvs,     0x9000,  0x5000,\n'
            'otadata,  data, ota,     0xe000,  0x2000,\n'
            'app0,     app,  ota_0,   0x10000, 0x140000,\n'
            'app1,     app,  ota_1,   0x150000,0x140000,\n'
            'ffat,     data, fat,     0x290000,0x150000,\n'
            'coredump, data, coredump,0x3E0000,0x10000,\n'
        ),
        'min_spiffs': (
            '# Name,   Type, SubType, Offset,  Size, Flags\n'
            'nvs,      data, nvs,     0x9000,  0x5000,\n'
            'otadata,  data, ota,     0xe000,  0x2000,\n'
            'app0,     app,  ota_0,   0x10000, 0x1E0000,\n'
            'app1,     app,  ota_1,   0x1F0000,0x1E0000,\n'
            'spiffs,   data, spiffs,  0x3D0000,0x20000,\n'
            'coredump, data, coredump,0x3F0000,0x10000,\n'
        ),
        'min_ffat': (
            '# Name,   Type, SubType, Offset,  Size, Flags\n'
            'nvs,      data, nvs,     0x9000,  0x5000,\n'
            'otadata,  data, ota,     0xe000,  0x2000,\n'
            'app0,     app,  ota_0,   0x10000, 0x1E0000,\n'
            'app1,     app,  ota_1,   0x1F0000,0x1E0000,\n'
            'ffat,     data, fat,     0x3D0000,0x20000,\n'
            'coredump, data, coredump,0x3F0000,0x10000,\n'
        ),
        'no_ota': (
            '# Name,   Type, SubType, Offset,  Size, Flags\n'
            'nvs,      data, nvs,     0x9000,  0x5000,\n'
            'otadata,  data, ota,     0xe000,  0x2000,\n'
            'app0,     app,  ota_0,   0x10000, 0x200000,\n'
            'spiffs,   data, spiffs,  0x210000,0x1E0000,\n'
            'coredump, data, coredump,0x3F0000,0x10000,\n'
        ),
        'no_fs': (
            '# Name,   Type, SubType, Offset,  Size, Flags\n'
            'nvs,      data, nvs,     0x9000,  0x5000,\n'
            'otadata,  data, ota,     0xe000,  0x2000,\n'
            'app0,     app,  ota_0,   0x10000, 0x1F0000,\n'
            'app1,     app,  ota_1,   0x200000,0x1F0000,\n'
            'coredump, data, coredump,0x3F0000,0x10000,\n'
        ),
        'large_spiffs': (
            '# Name,   Type, SubType, Offset,  Size, Flags\n'
            'nvs,      data, nvs,     0x9000,  0x5000,\n'
            'otadata,  data, ota,     0xe000,  0x2000,\n'
            'app0,     app,  ota_0,   0x10000, 0x1E0000,\n'
            'spiffs,   data, spiffs,  0x1F0000,0x200000,\n'
            'coredump, data, coredump,0x3F0000,0x10000,\n'
        ),
        'rainmaker': (
            '# Name,   Type, SubType, Offset,  Size, Flags\n'
            'nvs,      data, nvs,     0x9000,  0x4000,\n'
            'otadata,  data, ota,     0xd000,  0x2000,\n'
            'phy_init, data, phy,     0xf000,  0x1000,\n'
            'app0,     app,  ota_0,   0x10000, 0x1E0000,\n'
            'app1,     app,  ota_1,   0x1F0000,0x1E0000,\n'
            'fctry,    data, nvs,     0x3D0000,0x6000,\n'
            'coredump, data, coredump,0x3F0000,0x10000,\n'
        ),
    }

    # Known option defaults — used to backfill missing keys so older clients
    # (or callers without the feature wired up) still get a build.
    _DEFAULT_OPTIONS: dict[str, str | int | bool] = {
        'partitionScheme': 'huge_app',  # historical Velxio default
        'cpuFreqMHz': 240,
        'flashMode': 'dio',
        'flashSize': '4MB',
        'flashFreqMHz': '40',
        'psram': 'disabled',
        'coreDebugLevel': 'none',
        'eraseFlashOnUpload': False,
        'eventsRunOnCore': 1,
        'arduinoRunsOnCore': 1,
    }

    _VALID_VALUES: dict[str, set] = {
        'partitionScheme': set(_PARTITION_CSVS.keys()),
        'cpuFreqMHz': {240, 160, 80, 40, 20, 10},
        'flashMode': {'qio', 'dio', 'qout', 'dout'},
        'flashSize': {'4MB', '8MB', '16MB'},
        'flashFreqMHz': {'80', '40'},
        'psram': {'disabled', 'enabled', 'opi'},
        'coreDebugLevel': {'none', 'error', 'warn', 'info', 'debug', 'verbose'},
        'eventsRunOnCore': {0, 1},
        'arduinoRunsOnCore': {0, 1},
    }

    _DEBUG_LEVEL_NUMBER: dict[str, int] = {
        'none': 0,
        'error': 1,
        'warn': 2,
        'info': 3,
        'debug': 4,
        'verbose': 5,
    }

    _FLASH_SIZE_BYTES: dict[str, int] = {
        '4MB': 4 * 1024 * 1024,
        '8MB': 8 * 1024 * 1024,
        '16MB': 16 * 1024 * 1024,
    }

    def _normalize_options(
        self,
        opts: dict | None,
        idf_target: str,
        board_fqbn: str | None = None,
    ) -> dict:
        """Fill missing keys with defaults, validate enums, strip
        target-incompatible keys (e.g. PSRAM on C3).

        Raises ValueError on an unknown enum value — caller turns this into
        a user-visible compile error.
        """
        normalized: dict = {**self._DEFAULT_OPTIONS}
        if opts:
            for k, v in opts.items():
                if k not in self._DEFAULT_OPTIONS:
                    continue
                if k in self._VALID_VALUES and v not in self._VALID_VALUES[k]:
                    raise ValueError(
                        f"Invalid board option {k}={v!r}; "
                        f"expected one of {sorted(self._VALID_VALUES[k])}"
                    )
                normalized[k] = v

        # ESP32-C3 / ESP32-C6 have no external PSRAM controller — silently
        # disable so a stale field from an upgraded project doesn't trip up
        # the build. P4/C5 modules DO carry PSRAM, but the in-browser engines
        # run without it for now (the P4 engine models PSRAM as optional and
        # firmware built with SPIRAM would fail honestly on a board that does
        # not declare it) — keep it off until the engines validate it.
        if idf_target in ('esp32c3', 'esp32c6', 'esp32c5'):
            normalized['psram'] = 'disabled'

        # The P4-Function-EV module always carries 32 MB AP-hex PSRAM and
        # esp_lcd allocates DSI framebuffers from it unconditionally - the
        # board's flagship peripheral needs it. Default ON unless the
        # request explicitly says otherwise (the UI only sends the field
        # once the user opens the board-options modal).
        if idf_target == 'esp32p4' and 'psram' not in (opts or {}):
            normalized['psram'] = 'enabled'

        # ESP32-C3 / ESP32-C6 top out at 160 MHz — clamp the historical 240
        # default (and any stale higher value) instead of failing the build.
        # (On C3 the 240 choice was always an unknown kconfig symbol that
        # 4.4's kconfgen silently ignored, leaving the chip at its 160
        # default — the clamp makes that explicit and v5.x-clean.)
        if idf_target in ('esp32c3', 'esp32c6') and int(normalized['cpuFreqMHz']) > 160:
            normalized['cpuFreqMHz'] = 160

        # OPI PSRAM (octal) is an S3-only mode. Downgrade to 'enabled' on
        # classic Xtensa so users who switched boards mid-project don't get
        # a stuck build.
        if normalized['psram'] == 'opi' and idf_target != 'esp32s3':
            normalized['psram'] = 'enabled'

        # The Arduino VARIANT this board builds against (F7.6). Without it the
        # sdkconfig template falls back to the generic chip variant, and boards
        # like the XIAO ESP32S3 lose their identity: no Dx pin names, and
        # CDC_ON_BOOT stays off so `Serial` lands on UART0 — whose default RX
        # is GPIO44, the very pin the XIAO exposes as D7. A sketch doing
        # pinMode(D7, ...) then has the peripheral manager tear the UART0
        # driver down and every print after it is silently dropped (measured
        # on the Round Display clock example: setup prints out, loop mute).
        if board_fqbn:
            normalized['arduinoVariant'] = self._arduino_variant(board_fqbn, idf_target)

        return normalized

    # sdkconfig.defaults.in is written against IDF v4.4 + the 2.x Arduino
    # core. On a v5 PURE-IDF build the Arduino component options, the ARDUHAL
    # log level, and the Bluedroid stack (only ever needed by Arduino BLE
    # sketches) aren't wanted, and IDF 5.0 renamed ESP_TASK_WDT →
    # ESP_TASK_WDT_EN. Dropping them keeps kconfgen output clean instead of
    # spraying "unknown kconfig symbol" warnings into every build log. On a
    # v5 ARDUINO build (3.x core present) the Arduino/BT symbols ARE valid
    # (the 3.x component's Kconfig defines them) so only the WDT rename and
    # the target-specific drops apply.
    _IDF5_PUREIDF_DROP_PREFIXES: tuple[str, ...] = (
        'CONFIG_ARDUHAL_',
        'CONFIG_AUTOSTART_ARDUINO',
        'CONFIG_ARDUINO_',
        'CONFIG_BT_',
        'CONFIG_BTDM_',
    )

    def _idf5_drop_prefixes_for(
        self, idf_target: str, arduino_mode: bool = False
    ) -> tuple[str, ...]:
        """Prefixes to strip from the rendered defaults for a v5.x build.

        Pure-IDF builds drop the Arduino/Bluedroid options (invalid without
        the component). Per-target: C3/C6 have no PSRAM controller and top
        out at 160 MHz (single-core → the Arduino running-core options also
        don't exist); the 26 MHz flash-frequency choice only exists on
        classic ESP32.
        """
        drops: tuple[str, ...] = ()
        if not arduino_mode:
            drops += self._IDF5_PUREIDF_DROP_PREFIXES
        elif idf_target in ('esp32c3', 'esp32c6', 'esp32c5'):
            # Arduino v5 on a single-core RISC-V chip: the running-core
            # options are hidden by `depends on !FREERTOS_UNICORE`, so drop
            # just those two (keep the rest of the Arduino/BT symbols).
            drops += (
                'CONFIG_ARDUINO_RUNNING_CORE',
                'CONFIG_ARDUINO_EVENT_RUNNING_CORE',
            )
        if idf_target in ('esp32c3', 'esp32c6', 'esp32c5'):
            drops += (
                'CONFIG_SPIRAM',
                'CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ_240',
            )
        if idf_target == 'esp32p4':
            # The P4's CPU-frequency kconfig choices (360/400) do not overlap
            # the classic 240/160/80/40 set the template renders — drop the
            # whole group and let IDF's own default stand. SPIRAM renders
            # with the P4's own hex-mode symbols (see the PSRAM chunk).
            drops += (
                'CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ',
            )
        if idf_target != 'esp32':
            drops += ('CONFIG_ESPTOOLPY_FLASHFREQ_26M',)
        return drops

    def _fixup_sdkconfig_for_idf5(
        self, rendered: str, idf_target: str, arduino_mode: bool = False
    ) -> str:
        """Adapt the rendered v4.4-era defaults to an IDF v5.x build (see
        ``_idf5_drop_prefixes_for``)."""
        drops = self._idf5_drop_prefixes_for(idf_target, arduino_mode)
        lines: list[str] = []
        for line in rendered.splitlines():
            if line.startswith(drops):
                continue
            # IDF 5.0 split ESP_TASK_WDT into ESP_TASK_WDT_EN (compile the
            # implementation) and ESP_TASK_WDT_INIT (auto-start at boot).
            # The v4.4 template's `=n` used to become `EN=n`, which compiles
            # the API out entirely — every sketch calling esp_task_wdt_add/
            # reset (Firebase's ESP32 client does internally) died at link
            # with "undefined reference to esp_task_wdt_*". Keep the intent
            # (no watchdog running under emulation) while linking the API:
            # compile it in, never auto-start it.
            if line.startswith('CONFIG_ESP_TASK_WDT='):
                lines.append('CONFIG_ESP_TASK_WDT_EN=y')
                lines.append('CONFIG_ESP_TASK_WDT_INIT=n')
                continue
            lines.append(line)
        return '\n'.join(lines) + '\n'

    def _render_sdkconfig(
        self,
        normalized: dict,
        template_dir: Path,
        idf_target: str = 'esp32',
        use_idf5: Optional[bool] = None,
        arduino_mode: bool = False,
    ) -> str:
        """Render sdkconfig.defaults from the .in template + normalised opts."""
        template_path = template_dir / 'sdkconfig.defaults.in'
        template_text = template_path.read_text(encoding='utf-8')

        # ── Flash mode (exactly one of QIO/DIO/QOUT/DOUT) ─────────────
        flash_mode = normalized['flashMode']
        flash_mode_lines = '\n'.join(
            f'CONFIG_ESPTOOLPY_FLASHMODE_{m.upper()}={"y" if m == flash_mode else "n"}'
            for m in ('qio', 'dio', 'qout', 'dout')
        )

        # ── Flash frequency ────────────────────────────────────────────
        flash_freq = normalized['flashFreqMHz']
        flash_freq_lines = '\n'.join(
            f'CONFIG_ESPTOOLPY_FLASHFREQ_{f}M={"y" if f == flash_freq else "n"}'
            for f in ('80', '40', '26', '20')
        )

        # ── Flash size ─────────────────────────────────────────────────
        flash_size = normalized['flashSize']
        flash_size_lines_list = [
            f'CONFIG_ESPTOOLPY_FLASHSIZE_{s}={"y" if s == flash_size else "n"}'
            for s in ('2MB', '4MB', '8MB', '16MB')
        ]
        flash_size_lines_list.append(f'CONFIG_ESPTOOLPY_FLASHSIZE="{flash_size}"')
        flash_size_lines = '\n'.join(flash_size_lines_list)

        # ── CPU frequency ──────────────────────────────────────────────
        cpu_freq = int(normalized['cpuFreqMHz'])
        cpu_lines = [
            f'CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ_{f}='
            f'{"y" if f == cpu_freq else "n"}'
            for f in (240, 160, 80, 40)
        ]
        cpu_lines.append(f'CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ={cpu_freq}')
        cpu_freq_lines = '\n'.join(cpu_lines)

        # ── PSRAM ──────────────────────────────────────────────────────
        psram_mode = normalized['psram']
        psram_chunks: list[str] = []
        if psram_mode == 'disabled':
            psram_chunks.append('CONFIG_SPIRAM=n')
        elif idf_target == 'esp32p4':
            # The P4 has its own Kconfig.spiram: 16-line AP hex is the only
            # line mode, and the classic speed/mode symbols (80M, QUAD/OCT)
            # do not exist — emitting them breaks kconfgen. 200M is the
            # tree's default and rev0-safe (250M needs rev >= 3).
            psram_chunks.append('CONFIG_SPIRAM=y')
            psram_chunks.append('CONFIG_SPIRAM_USE_MALLOC=y')
            psram_chunks.append('CONFIG_SPIRAM_MODE_HEX=y')
            psram_chunks.append('CONFIG_SPIRAM_SPEED_200M=y')
            # The boot-time memory test walks the WHOLE 32 MB before app_main;
            # on emulated silicon that is tens of millions of guest accesses of
            # pure startup latency ("Disable this for slightly faster startup",
            # Kconfig.spiram.common). The RAM is modelled, not physical - there
            # is nothing to find.
            psram_chunks.append('CONFIG_SPIRAM_MEMTEST=n')
        else:
            psram_chunks.append('CONFIG_SPIRAM=y')
            psram_chunks.append('CONFIG_SPIRAM_USE_MALLOC=y')
            psram_chunks.append('CONFIG_SPIRAM_SPEED_80M=y')
            psram_chunks.append('CONFIG_SPIRAM_MEMTEST=n')  # see the P4 note
            if psram_mode == 'opi':
                psram_chunks.append('CONFIG_SPIRAM_MODE_OCT=y')
            else:
                psram_chunks.append('CONFIG_SPIRAM_MODE_QUAD=y')
        psram_lines = '\n'.join(psram_chunks)

        substitutions = {
            'FLASH_MODE_LINES': flash_mode_lines,
            'FLASH_FREQ_LINES': flash_freq_lines,
            'FLASH_SIZE_LINES': flash_size_lines,
            'CPU_FREQ_LINES': cpu_freq_lines,
            'PSRAM_LINES': psram_lines,
            'ARDUHAL_LOG_LEVEL': str(
                self._DEBUG_LEVEL_NUMBER[normalized['coreDebugLevel']]
            ),
            'ARDUINO_VARIANT': normalized.get('arduinoVariant') or idf_target,
            'ARDUINO_RUNNING_CORE': str(normalized['arduinoRunsOnCore']),
            'ARDUINO_EVENT_RUNNING_CORE': str(normalized['eventsRunOnCore']),
        }

        rendered = string.Template(template_text).safe_substitute(substitutions)
        if use_idf5 is None:
            use_idf5 = idf_target in self._IDF5_TARGETS
        if use_idf5:
            rendered = self._fixup_sdkconfig_for_idf5(
                rendered, idf_target, arduino_mode
            )
        if idf_target == 'esp32p4':
            # The in-browser esp32p4js engine runs the ONLY published P4 mask
            # ROM (rev0), and from silicon v3.0 IDF switches ROM symbol tables
            # (esp32p4.rom.eco5.ld moves rom_spiflash_legacy_data) — firmware
            # built for v3 reads a flash descriptor the rev0 ROM never wrote
            # and rejects every partition. Pin the build to rev0 so images
            # boot on the engine (project/esp32p4-js-emulator/STATUS.md).
            rendered += (
                '\n# Velxio: esp32p4js runs the rev0 mask ROM\n'
                'CONFIG_ESP32P4_SELECTS_REV_LESS_V3=y\n'
                'CONFIG_ESP32P4_REV_MIN_0=y\n'
                # esp_hosted ships an interactive CLI (a REPL on the serial
                # console) enabled by default. On a cloud-compiled sketch it
                # is worse than useless: its "host>" prompt interleaves with
                # the user's own serial output, and its console task polls a
                # UART that in the emulator never blocks, pinning one HP core
                # at priority 23 and defeating the engine's idle fast-forward
                # (project/espressif-devkits-2026-08/STATUS.md, round
                # 2026-08-25/26).
                '# Velxio: no interactive REPL on a cloud-built sketch\n'
                'CONFIG_ESP_HOSTED_CLI_ENABLED=n\n'
            )
        return rendered

    def _render_partition_csv(self, scheme: str) -> str:
        """Return the partition table CSV for the given scheme name."""
        csv = self._PARTITION_CSVS.get(scheme)
        if csv is None:
            # Unknown scheme — should not happen because _normalize_options
            # validates, but fall back to the historical layout so the build
            # still succeeds rather than crashing.
            logger.warning(f'[espidf] Unknown partition scheme {scheme!r}, using huge_app')
            csv = self._PARTITION_CSVS['huge_app']
        return csv

    @staticmethod
    def _parse_partition_csv(csv_text: str) -> list[dict]:
        """Parse a partition table CSV into a list of dicts. Handles the
        comma-separated arduino-esp32 format with arbitrary whitespace.
        """
        entries: list[dict] = []
        for line in csv_text.splitlines():
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            cols = [c.strip() for c in line.split(',')]
            if len(cols) < 5:
                continue
            try:
                offset = int(cols[3], 16) if cols[3] else 0
                size = int(cols[4], 16) if cols[4] else 0
            except ValueError:
                continue
            entries.append({
                'name': cols[0],
                'type': cols[1],
                'subtype': cols[2],
                'offset': offset,
                'size': size,
            })
        return entries

    def _find_filesystem_partition(self, csv_text: str) -> Optional[dict]:
        """Return the SPIFFS or FATFS partition entry, or None."""
        for e in self._parse_partition_csv(csv_text):
            if e['type'] == 'data' and e['subtype'] in ('spiffs', 'fat'):
                return e
        return None

    def _locate_mkspiffs(self) -> Optional[str]:
        """Find the mkspiffs binary. Returns None when unavailable so the
        build can proceed (with an empty FS partition).

        Search order:
          1. $MKSPIFFS_PATH (explicit override)
          2. $IDF_TOOLS_PATH/tools/mkspiffs/*/mkspiffs/mkspiffs[.exe]
          3. shutil.which('mkspiffs')
        """
        override = os.environ.get('MKSPIFFS_PATH')
        if override and os.path.isfile(override):
            return override

        idf_tools = os.environ.get('IDF_TOOLS_PATH')
        if idf_tools:
            for sub in Path(idf_tools, 'tools', 'mkspiffs').glob('*/mkspiffs/mkspiffs*'):
                if sub.is_file():
                    return str(sub)

        found = shutil.which('mkspiffs')
        if found:
            return found

        return None

    def _build_spiffs_image(
        self,
        project_dir: Path,
        spiffs_files: list[dict],
        partition_size_bytes: int,
    ) -> Optional[Path]:
        """Materialise uploaded files into a SPIFFS partition image.

        Returns the path to spiffs.bin, or None if mkspiffs is unavailable
        / the file set is empty. The caller places the bin at the SPIFFS
        offset (looked up from partitions.csv) when merging the flash image.

        Raises ValueError when the inputs are oversized — the route layer
        turns this into a 4xx-shaped CompileResponse for the UI.
        """
        if not spiffs_files:
            return None
        if partition_size_bytes <= 0:
            raise ValueError(
                'Selected partition scheme has no SPIFFS/FATFS region — '
                'remove the uploaded files or pick a scheme with a filesystem.'
            )

        mkspiffs = self._locate_mkspiffs()
        if mkspiffs is None:
            logger.warning(
                '[espidf] mkspiffs not found — uploaded SPIFFS files will be '
                'ignored at flash time. Set MKSPIFFS_PATH or install mkspiffs '
                'into IDF_TOOLS_PATH.'
            )
            return None

        spiffs_data_dir = project_dir / 'spiffs_data'
        if spiffs_data_dir.exists():
            shutil.rmtree(spiffs_data_dir)
        spiffs_data_dir.mkdir(parents=True)

        total_bytes = 0
        for entry in spiffs_files:
            name = entry['name']
            data = base64.b64decode(entry['content_b64'])
            total_bytes += len(data)
            # mkspiffs uses the on-disk filename as the in-flash path so
            # write subdirs literally rather than smuggling slashes into
            # the name. Strip any leading slash to avoid escaping the dir.
            safe_path = name.lstrip('/').lstrip('\\')
            dest = spiffs_data_dir / safe_path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)

        # Block size 4096, page size 256 — matches the arduino-esp32
        # defaults so the in-flash image is readable by SPIFFS.begin().
        spiffs_bin = project_dir / 'spiffs.bin'
        cmd = [
            mkspiffs,
            '-c', str(spiffs_data_dir),
            '-b', '4096',
            '-p', '256',
            '-s', str(partition_size_bytes),
            str(spiffs_bin),
        ]
        logger.info(
            f'[espidf] mkspiffs: {len(spiffs_files)} files, '
            f'{total_bytes} bytes payload, {partition_size_bytes} byte partition'
        )

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if result.returncode != 0:
            raise ValueError(
                f'mkspiffs failed (rc={result.returncode}): '
                f'{result.stderr.strip() or result.stdout.strip()}'
            )

        return spiffs_bin

    def _merge_flash_image(
        self,
        build_dir: Path,
        idf_target: str,
        flash_size_bytes: int = 4 * 1024 * 1024,
        spiffs_bin: Optional[Path] = None,
        spiffs_offset: int = 0,
    ) -> Path:
        """Merge bootloader + partitions + app (+ optional SPIFFS) into a
        flash image sized to match the user's Flash Size option. The
        bootloader lands at the per-target ROM offset (0x1000 on classic
        ESP32/S2, 0x0 on S3/C3/C6 — see ``_BOOTLOADER_OFFSETS``)."""
        FLASH_SIZE = flash_size_bytes
        flash = bytearray(b'\xff' * FLASH_SIZE)

        bootloader_offset = self._BOOTLOADER_OFFSETS.get(idf_target, 0x0)

        # ESP-IDF build output paths
        bootloader = build_dir / 'bootloader' / 'bootloader.bin'
        partitions = build_dir / 'partition_table' / 'partition-table.bin'
        app = build_dir / 'velxio-sketch.bin'

        if not app.exists():
            # Try alternate names
            for pattern in ['*.bin']:
                candidates = [f for f in build_dir.glob(pattern)
                              if 'bootloader' not in f.name and 'partition' not in f.name]
                if candidates:
                    app = candidates[0]
                    break

        files_found = {
            'bootloader': bootloader.exists(),
            'partitions': partitions.exists(),
            'app': app.exists(),
        }
        logger.info(f'[espidf] Merge files: {files_found}')

        if not all(files_found.values()):
            missing = [k for k, v in files_found.items() if not v]
            raise FileNotFoundError(f'Missing binaries for merge: {missing}')

        last_used = 0
        placements: list[tuple[int, Path]] = [
            (bootloader_offset, bootloader),
            (0x8000, partitions),
            (0x10000, app),
        ]
        if spiffs_bin is not None and spiffs_offset > 0:
            placements.append((spiffs_offset, spiffs_bin))

        for offset, path in placements:
            data = path.read_bytes()
            if offset + len(data) > FLASH_SIZE:
                raise ValueError(
                    f'Partition {path.name} ({len(data)} bytes at 0x{offset:X}) '
                    f'overflows the selected flash size ({FLASH_SIZE} bytes). '
                    f'Pick a larger Flash Size or a partition scheme with a '
                    f'smaller app/data region.'
                )
            flash[offset:offset + len(data)] = data
            last_used = max(last_used, offset + len(data))
            logger.info(f'[espidf] Placed {path.name} at 0x{offset:04X} ({len(data)} bytes)')

        # Trim the trailing 0xFF padding before serializing.
        #
        # Keeping the full 4 MB flash image here gives a ~5.5 MB base64 JSON
        # response that nginx / Cloudflare can choke on (issue #101 — user
        # saw "No response from server"). The frontend stores the trimmed
        # bytes and the backend pads back to the QEMU flash size at the
        # bridge layer right before mtd attach. Lossless: bytes after
        # last_used are 0xFF by construction, so re-padding restores the
        # original image byte-for-byte.
        merged_path = build_dir / 'merged_flash.bin'
        merged_path.write_bytes(bytes(flash[:last_used]))
        logger.info(
            f'[espidf] Merged flash image (trimmed): {merged_path.stat().st_size} bytes '
            f'(would have been {FLASH_SIZE} bytes unpadded)'
        )
        return merged_path

    @staticmethod
    def _pick_replica(idf_target: str, eff_hash: str) -> tuple[int, int | None]:
        """(replica to build in, replica to warm in the background or None).

        The first replica whose lock is free wins (0 first: it always exists).
        When every existing copy is busy the compile queues on replica 0, and
        after a short streak of such collisions (so a rare variant never gets
        a second tree) the NEXT replica is created by a background build.
        """
        max_replicas = _variant_replicas()
        target_dir = _BUILD_ROOT / idf_target
        existing: list[int] = []
        for n in range(max_replicas):
            key = _variant_lock_key(idf_target, eff_hash, n)
            if n == 0 or (
                key not in _WARMING_REPLICAS
                and (target_dir / _variant_dir_name(eff_hash, n)).is_dir()
            ):
                existing.append(n)
        for n in existing:
            if not _variant_lock(_variant_lock_key(idf_target, eff_hash, n)).locked():
                return n, None
        base_key = _variant_lock_key(idf_target, eff_hash)
        nxt = len(existing)
        warm = None
        if (
            nxt < max_replicas
            and _variant_lock_key(idf_target, eff_hash, nxt) not in _WARMING_REPLICAS
            and _note_variant_collision(base_key)
        ):
            warm = nxt
        return 0, warm

    def _warm_replica_in_background(
        self, replica: int, idf_target: str, eff_hash: str,
        files: list[dict], board_fqbn: str, **compile_kwargs,
    ) -> None:
        """Build replica `replica` of this variant from the same sources, off
        to the side, at low CPU priority, so the next collision finds a warm
        copy. Nothing waits on it; a failure only means no replica."""
        key = _variant_lock_key(idf_target, eff_hash, replica)
        if key in _WARMING_REPLICAS:
            return
        _WARMING_REPLICAS.add(key)
        logger.info(f'[espidf] every replica of {idf_target}/{eff_hash} is busy; warming replica {replica} in the background')

        async def _warm() -> None:
            try:
                result = await self.compile(
                    files, board_fqbn, progress_callback=None,
                    cpu_nice=10, _force_replica=replica, **compile_kwargs,
                )
                logger.info(
                    f'[espidf] replica {replica} of {idf_target}/{eff_hash} warmed '
                    f'(success={result.get("success")})'
                )
            except Exception:
                logger.exception(f'[espidf] warming replica {replica} of {idf_target}/{eff_hash} failed')
            finally:
                _WARMING_REPLICAS.discard(key)

        task = asyncio.create_task(_warm())
        _BACKGROUND_TASKS.add(task)
        task.add_done_callback(_BACKGROUND_TASKS.discard)

    async def compile(
        self,
        files: list[dict],
        board_fqbn: str,
        progress_callback: Optional[ProgressCallback] = None,
        board_options: dict | None = None,
        spiffs_files: list[dict] | None = None,
        allowed_libraries: set[str] | None = None,
        owner_id: str | None = None,
        pure_idf: bool = False,
        custom_wifi_ssids: list[str] | None = None,
        cpu_nice: int | None = None,
        _force_replica: int | None = None,
    ) -> dict:
        """
        Compile Arduino sketch using ESP-IDF.

        `custom_wifi_ssids` non-empty = the project carries its own access
        point parts: the WiFi normalization below stands down entirely (no
        SSID rewrite, no channel forcing) — the user's airspace is exactly
        what they typed, typos included, which is now the truthful outcome.

        Returns dict compatible with ArduinoCLIService.compile():
            success, binary_content (base64), binary_type, stdout, stderr, error

        Build dir layout:
        - With VELXIO_PERSISTENT_BUILD_DIR=1 (default): a per-target dir at
          /var/lib/velxio-build/<idf_target>/project/ is reused across compiles.
          ninja's incremental cache + ccache hits combine to bring warm
          compiles down to ~5-30s.
        - With VELXIO_PERSISTENT_BUILD_DIR=0: legacy tempfile.TemporaryDirectory
          flow. Every compile rebuilds from scratch.

        The caller (routes/compile.py:_compile_job) holds a per-target
        asyncio.Lock for the duration of this call, so the persistent dir
        is never accessed by two compiles at once.

        progress_callback (optional): if provided, called from a worker
        thread for every stdout/stderr line as cmake and ninja run. Used
        by the async compile path to expose live build output to clients
        polling /api/compile/status/{job_id}.

        board_options (optional): per-board ESP32 build options from the
        UI (Partition Scheme, CPU Frequency, Flash Mode, PSRAM, etc.).
        Missing keys fall back to historical defaults so AVR/RP2040 callers
        and pre-feature clients still get a working build. Note that
        SPIFFS files are NOT folded into the cache-invalidation hash —
        only sdkconfig-affecting options are — because the SPIFFS image is
        rebuilt on every compile anyway and folding it in would burn the
        C/C++ ninja cache on every file edit.

        pure_idf: pure ESP-IDF language mode (issue #139). The user's files
        ARE the IDF main component sources (they provide app_main()); the
        arduino-esp32 component is left out of the build entirely and
        Arduino library resolution is skipped. Gets its own persistent
        build-dir variant via the eff_hash fold below.
        """
        if not self.available:
            return {
                'success': False,
                'error': 'ESP-IDF toolchain not found. Set IDF_PATH environment variable.',
                'stdout': '',
                'stderr': '',
            }

        idf_target = self._idf_target(board_fqbn)

        # IDF5-only targets (esp32c6) need their own toolchain install —
        # the pinned v4.4.7 tree that `available` checks has no such target.
        # (Other targets merely PREFER v5 and quietly fall back to v4.4 when
        # the v5 install is absent — see _use_idf5.)
        if idf_target in self._IDF5_TARGETS:
            idf5 = self.idf5_path
            if not idf5 or not os.path.isdir(idf5):
                return {
                    'success': False,
                    'error': (
                        f'{idf_target} requires ESP-IDF v5.x, which is not '
                        f'installed on this server (the pinned v4.4.7 '
                        f'toolchain has no {idf_target} target). Install an '
                        f'ESP-IDF v5.x and point IDF5_PATH at its root.'
                    ),
                    'stdout': '',
                    'stderr': '',
                }

        logger.info(f'[espidf] Compiling for {idf_target} (FQBN: {board_fqbn})')
        logger.info(f'[espidf] Files: {[f["name"] for f in files]}')

        try:
            normalized_opts = self._normalize_options(board_options, idf_target, board_fqbn)
        except ValueError as exc:
            return {
                'success': False,
                'error': str(exc),
                'stdout': '',
                'stderr': '',
            }

        options_hash = hashlib.sha256(
            json.dumps(normalized_opts, sort_keys=True).encode()
        ).hexdigest()[:12]

        # External-include set of the sketch — a stable proxy for "which
        # libraries this compile resolves". Folded into the per-attempt build
        # hash below so the persistent build/ is reset (via the tested
        # _prepare_persistent_project_dir wipe) whenever the library set
        # changes between compiles. Without this, the shared build/ caches a
        # cmake config + ninja graph + ccache objects for the PREVIOUS lib set,
        # which causes intermittent "cmake configure failed" and stale-object
        # false positives when a different project/manifest compiles next.
        _sketch_text = '\n'.join(f.get('content', '') for f in files)
        _own_names = {Path(str(f.get('name') or '')).name for f in files}
        _core_hdrs = self._core_provided_headers()
        _ext_inc_token = ','.join(sorted(
            h for h in set(self._detect_external_includes(_sketch_text, _own_names))
            if h not in _core_hdrs
        ))
        # esp_camera.h and friends never reach _ext_inc_token (the esp_ prefix
        # marks IDF-internal headers), yet they change the component graph:
        # the manifest they add pulls a registry component into the build.
        # Give those sketches their own variant, the same way a different
        # library set gets one. Empty for the common sketch, on purpose, so
        # every existing warm variant keeps its hash across this change.
        _components_token = self._component_graph_token('\n'.join(
            str(f.get('content', '')) for f in files
            if str(f.get('name', '')).endswith(('.ino', '.cpp', '.c', '.h', '.hpp'))
        ))

        # Per-compile mode decision (see _use_idf5). Decided HERE — not in
        # _compile_in_dir — because it picks the IDF major, which everything
        # downstream depends on: build env, sdkconfig rendering, and the
        # build-dir identity (a v4.4 and a v5 build must never share a
        # configured build/).
        _primary_src = next(
            (f['content'] for f in files if f['name'].endswith('.ino')),
            files[0]['content'] if files else '',
        )
        arduino_mode = (
            self._arduino_supports_target(idf_target)
            and not self._contains_app_main(_primary_src)
            # The explicit ESP-IDF language mode (#139) is the user SAYING
            # their code is a pure IDF app; it outranks the app_main sniff.
            and not pure_idf
        )
        use_idf5 = self._use_idf5(idf_target, arduino_mode)
        logger.info(
            f'[espidf] mode={"arduino" if arduino_mode else "pure-idf"} '
            f'idf={"v5 (" + self.idf5_path + ")" if use_idf5 else "v4.4 (" + self.idf_path + ")"}'
        )

        async def _attempt(
            allowed: set[str] | None,
            denied: set[str] | None = None,
            speculative: set[str] | None = None,
        ) -> dict:
            # P2.1e — materialize a per-compile library scope: the manifest's
            # libs symlinked from the content-addressed cache (with a legacy-dir
            # fallback for any not yet cached). A no-op overlay / scan-all
            # fallback (allowed=None) returns None -> the compiler uses the
            # single default libraries dir. The scope's content token is folded
            # into the build-dir hash so a content change (cache vs legacy, or a
            # cache update) gets its own clean build dir — and the throwaway
            # scope dir is removed after the attempt (its files were already
            # copied into the build's user_libs_all by _compile_in_dir).
            scope = materialize_library_scope(allowed, owner_id)
            scope_dir = scope[0] if scope else None
            scope_token = scope[1] if scope else ''
            # The materialiser walks depends= and symlinks the transitive
            # closure into the scope dir, and reports it as a third element.
            # Until 2026-09-11 the merge below still filtered by the bare
            # manifest names, so every closure entry was "not found" and only
            # the scan-all retry rescued the build. When a scope dir exists it
            # IS the allow-list (what the arduino-cli lane already does by
            # pointing the sketchbook at it); the build-variant token keeps
            # hashing the manifest so no variant moves.
            effective_allowed = effective_scope(allowed, scope)
            # Fold the effective library set + resolved content into the build-dir
            # hash. A different manifest, the scan-all fallback (allowed=None), or
            # changed lib CONTENT gets its own clean build dir — resetting at
            # _prepare time (before any cmake), the well-tested wipe path.
            _libs_token = (
                ('m:' + ','.join(sorted(allowed)) + ('|s:' + scope_token if scope_token else ''))
                if allowed is not None else 'scanall'
            )
            # Pure ESP-IDF mode gets its own build-dir variant: same bytes
            # compiled with vs without the arduino-esp32 component produce
            # entirely different cmake graphs + objects.
            _lang_token = '|lang:pure' if pure_idf else ''
            eff_hash = hashlib.sha256(
                (
                    options_hash + '|' + _libs_token + '|i:' + _ext_inc_token
                    # A v4.4 and a v5 build (or arduino vs pure-IDF) must
                    # never share a configured build/ — the cmake cache and
                    # every object file are tied to the IDF tree.
                    + f'|idf:{5 if use_idf5 else 4}|ard:{int(arduino_mode)}'
                    # The user-libs layout changes every object path and the
                    # component's include list, so the two modes must never
                    # share a configured build/ (stale objects + cmake cache).
                    + f'|libroots:{int(_PER_LIB_ROOTS)}'
                    + _lang_token
                    + (f'|c:{_components_token}' if _components_token else '')
                ).encode()
            ).hexdigest()[:12]
            try:
                if _USE_PERSISTENT_DIR:
                    # Prepare AND build under the variant lock: prepare wipes main/ and
                    # user_libs, and the configure populates managed_components/ - neither
                    # survives a second compile landing in the same dir mid-way.
                    if _force_replica is not None:
                        replica = _force_replica
                    else:
                        replica, warm = self._pick_replica(idf_target, eff_hash)
                        if warm is not None:
                            self._warm_replica_in_background(
                                warm, idf_target, eff_hash, files, board_fqbn,
                                board_options=board_options,
                                allowed_libraries=allowed, owner_id=owner_id,
                                pure_idf=pure_idf, custom_wifi_ssids=custom_wifi_ssids,
                            )
                    lock_key = _variant_lock_key(idf_target, eff_hash, replica)
                    wait_t0 = time.monotonic()
                    async with _variant_lock(lock_key):
                        waited = time.monotonic() - wait_t0
                        _timing_note(
                            variant_wait_ms=int(waited * 1000),
                            replica=replica,
                            variant=f'{idf_target}/{eff_hash}',
                        )
                        if waited > 0.5:
                            logger.info(
                                f'[espidf] waited {waited:.1f}s for build dir '
                                f'{lock_key} (replica {replica})'
                            )
                        # Prepare does rmtree + copytree on a 100-500 MB tree
                        # and the LRU eviction: off the event loop, or every
                        # WebSocket frame on the box stalls behind it.
                        project_dir = await asyncio.to_thread(
                            _prepare_persistent_project_dir, idf_target, eff_hash, replica,
                        )
                        logger.info(f'[espidf] Using persistent build dir: {project_dir}')
                        try:
                            return await self._compile_in_dir(
                                project_dir, files, idf_target,
                                progress_callback, normalized_opts, spiffs_files,
                                allowed_libraries=effective_allowed, libraries_dir=scope_dir,
                                arduino_mode=arduino_mode, use_idf5=use_idf5,
                                pure_idf=pure_idf, board_fqbn=board_fqbn,
                                custom_wifi_ssids=custom_wifi_ssids,
                                denied_libraries=denied, speculative_out=speculative,
                                cpu_nice=cpu_nice,
                            )
                        finally:
                            # Re-stamp at the END of the build too: eviction
                            # sorts by this, and a long build must not be the
                            # coldest sibling because it started long ago.
                            try:
                                os.utime(project_dir.parent, None)
                            except OSError:
                                pass
                with tempfile.TemporaryDirectory(prefix='espidf_') as temp_dir:
                    project_dir = Path(temp_dir) / 'project'
                    shutil.copytree(_TEMPLATE_DIR, project_dir)
                    logger.info(f'[espidf] Using ephemeral build dir: {project_dir}')
                    return await self._compile_in_dir(
                        project_dir, files, idf_target,
                        progress_callback, normalized_opts, spiffs_files,
                        allowed_libraries=effective_allowed, libraries_dir=scope_dir,
                        arduino_mode=arduino_mode, use_idf5=use_idf5,
                        pure_idf=pure_idf, board_fqbn=board_fqbn,
                        custom_wifi_ssids=custom_wifi_ssids,
                        cpu_nice=cpu_nice,
                    )
            finally:
                if scope_dir is not None:
                    # rmtree unlinks the symlinks, never their cache/legacy targets.
                    shutil.rmtree(scope_dir.parent, ignore_errors=True)

        async def _attempt_safe(
            allowed: set[str] | None,
            denied: set[str] | None = None,
            speculative: set[str] | None = None,
        ) -> dict:
            # Retry ONCE on a clearly-transient infrastructure failure (cmake /
            # nested bootloader / managed-components / sdkconfig) — never on a
            # user-code error. These hit occasionally on a cold variant build;
            # a retry resumes the now-warmer build dir and succeeds. Cheap via
            # ccache + ninja incremental.
            r = await _attempt(allowed, denied, speculative)
            if not r.get('success') and self._is_transient_build_failure(r):
                logger.warning('[espidf] transient build failure; retrying once')
                r2 = await _attempt(allowed, denied, speculative)
                if r2.get('success') or not self._is_transient_build_failure(r2):
                    return r2
            return r

        # Pure ESP-IDF mode never resolves Arduino libraries — force the
        # no-manifest path (the manifest names Arduino libs, which don't
        # exist in a pure IDF build).
        speculative_libs: set[str] = set()
        result = await _attempt_safe(
            None if pure_idf else allowed_libraries, speculative=speculative_libs
        )

        # Graceful fallback (P2). A manifest-scoped compile that fails because a
        # header isn't in the manifest (an undeclared / transitive dependency)
        # retries once with scan-all, so a project with an incomplete manifest
        # still compiles instead of regressing — and we report the gap so the
        # manifest can be auto-completed (P2.4) or the user prompted to add the
        # missing library. The caller holds the per-target lock for this whole
        # method, so the retry safely reuses the same build dir.
        if allowed_libraries is not None and not pure_idf and not result.get('success'):
            missing = self._missing_library_headers(result)
            if missing and not scope_retry_allowed.get():
                # The overlay closed this scope (an unmodified gallery compile
                # whose manifest is proven complete): a retry could only hide
                # a lock bug. Say what went missing instead.
                result['gallery_scope_miss'] = sorted(missing)
                logger.error(
                    f'[espidf] scoped compile missing {missing} and the scan-all retry '
                    f'is disabled for this compile (closed scope)'
                )
                missing = []
            if missing:
                logger.warning(
                    f'[espidf] scoped compile missing {missing} (not in manifest) — '
                    f'retrying scan-all'
                )
                retry = await _attempt_safe(None)
                if retry.get('success'):
                    retry['manifest_incomplete'] = True
                    retry['manifest_suggested_libraries'] = (
                        self._suggest_libraries_for_headers(missing)
                    )
                    return retry
                # Both failed. The retry saw every installed library, so ITS
                # error is the sketch's real one — the scoped attempt stops at
                # the first undeclared transitive dependency, which is an
                # artifact of the scope, not of the sketch. Prefer it whenever
                # it carries text; fall through to the scoped result otherwise.
                if str(retry.get('error') or retry.get('stderr') or '').strip():
                    retry['scope_retry_failed'] = True
                    result = retry

        # Quarantine (2026-09). A speculative merge that fails the build is
        # dropped and the build retried once. "Speculative" = merged for a
        # header the SKETCH never wrote, so no line of the user's code asked
        # for it, and it is a resolver guess. When the guess is wrong the user
        # gets an error from inside a library they never named:
        #   FastLED -> (a `__has_include` probe) -> Adafruit_NeoPixel
        #           -> (`#ifdef USE_TINYUSB`)     -> Adafruit TinyUSB
        #           -> "'CONFIG_TINYUSB_MSC_BUFSIZE' was not declared"
        # No static rule catches every such guess: three separate idioms
        # (has_include probes, opt-in feature macros, foreign-platform trees)
        # each needed their own fix, and the cascade found a fourth path every
        # time. This is the fail-soft that does not need to be clairvoyant.
        # Cost: one extra build, and only on a build that is red today.
        # The quarantine may only IMPROVE things. If dropping a speculative
        # library does not produce a green build, the original failure is the
        # honest one to report: the retry's error is an artifact of our own
        # drop. ESPAsyncWebServer is the case that proved it — AsyncTCP is a
        # real, required dependency, it was named in the first build's errors
        # alongside a genuine offender, and dropping it turned a compile error
        # into "fatal error: AsyncTCP.h: No such file", which hides the actual
        # problem behind one we caused.
        original = result
        quarantined: list[str] = []
        rounds = 0
        while (
            not result.get('success')
            and not pure_idf
            and rounds < self._MAX_QUARANTINE_ROUNDS
        ):
            offenders = [
                o for o in self._quarantine_from_error(result, speculative_libs)
                if o not in quarantined
            ]
            if not offenders:
                break
            quarantined.extend(offenders)
            rounds += 1
            logger.warning(
                f'[espidf] build failed inside speculatively-merged '
                f'{offenders} — dropping and rebuilding '
                f'(round {rounds}/{self._MAX_QUARANTINE_ROUNDS})'
            )
            attempt = await _attempt_safe(
                None if pure_idf else allowed_libraries,
                denied=set(quarantined),
            )
            if attempt.get('success'):
                attempt['quarantined_libraries'] = list(quarantined)
                return attempt
            if not str(attempt.get('error') or '').strip():
                break
            # Keep going (the next round reads THIS attempt's errors), but the
            # reported failure stays the original one.
            result = attempt
        return original

    async def _compile_in_dir(
        self,
        project_dir: Path,
        files: list[dict],
        idf_target: str,
        progress_callback: Optional[ProgressCallback] = None,
        board_options: dict | None = None,
        spiffs_files: list[dict] | None = None,
        allowed_libraries: set[str] | None = None,
        libraries_dir: Path | None = None,
        arduino_mode: Optional[bool] = None,
        use_idf5: Optional[bool] = None,
        pure_idf: bool = False,
        board_fqbn: str | None = None,
        custom_wifi_ssids: list[str] | None = None,
        denied_libraries: set[str] | None = None,
        speculative_out: set[str] | None = None,
        cpu_nice: int | None = None,
    ) -> dict:
        """Inner compile body: writes sketch + libs into `project_dir`,
        runs cmake + ninja, merges binaries. Caller is responsible for
        creating `project_dir` (with the template tree already copied in)
        and for managing its lifecycle (persistent vs tempfile).

        ``arduino_mode`` / ``use_idf5`` are decided by compile(); the
        defensive defaults below only serve direct test callers.

        pure_idf: the user's files are the IDF main component sources
        (app_main entry point) — no Arduino wrap, no Arduino libraries.
        The template's main/CMakeLists.txt picks its pure branch via the
        VELXIO_PURE_SKETCH env var set in _build_env.
        """
        # board_options is already normalised by compile() — defensive in
        # case _compile_in_dir is called directly from a test path.
        if board_options is None:
            board_options = self._normalize_options(None, idf_target)
        if arduino_mode is None:
            arduino_mode = self._arduino_supports_target(idf_target) and not pure_idf
        if use_idf5 is None:
            use_idf5 = self._use_idf5(idf_target, arduino_mode)

        # Render sdkconfig.defaults from the templated .in file using the
        # user's options. Overwrites the static file copied from the
        # template tree. Doing this BEFORE cmake configure means the new
        # CONFIG_* lines reach kconfig on its first read.
        rendered_sdkconfig = self._render_sdkconfig(
            board_options, _TEMPLATE_DIR, idf_target,
            use_idf5=use_idf5, arduino_mode=arduino_mode,
        )
        if pure_idf:
            # Without the arduino-esp32 component the CONFIG_ARDUINO_* /
            # CONFIG_AUTOSTART_ARDUINO symbols don't exist. kconfig only
            # warns on unknown symbols, but strip them so the generated
            # sdkconfig stays honest about what the build contains.
            rendered_sdkconfig = '\n'.join(
                line for line in rendered_sdkconfig.splitlines()
                if not line.startswith(('CONFIG_ARDUINO', 'CONFIG_AUTOSTART_ARDUINO'))
            ) + '\n'
        defaults_path = project_dir / 'sdkconfig.defaults'
        prev_defaults = (
            defaults_path.read_text(encoding='utf-8') if defaults_path.exists() else None
        )
        if prev_defaults != rendered_sdkconfig:
            defaults_path.write_text(rendered_sdkconfig, encoding='utf-8')
        # A defaults change drops the generated sdkconfig below, and a missing
        # sdkconfig is a missing configure input: ninja refuses to regenerate
        # ("needed by build.ninja, missing"), so that case must run cmake
        # explicitly. First build of a variant has no build.ninja anyway.
        force_configure = prev_defaults is not None and prev_defaults != rendered_sdkconfig
        # Set by _sync_managed_components below (one call per mode branch).
        manifest_changed = False


        # ESP-IDF only SEEDS sdkconfig from sdkconfig.defaults when sdkconfig is
        # ABSENT. Persistent build dirs live in the build volume and keep a
        # stale sdkconfig across image rebuilds, so a defaults change (a new
        # CONFIG_* shipped in the template, or different board options) would
        # otherwise never reach kconfig. Drop the generated sdkconfig when the
        # rendered defaults change so kconfig re-seeds from them on configure.
        # NOTHING may run between the defaults write above and this unlink: a
        # crash in between leaves defaults==rendered with a stale sdkconfig,
        # and the next run then never re-seeds (measured: the board_fqbn
        # NameError left CONSOLE_SECONDARY stale in a persistent dir).
        if prev_defaults is not None and prev_defaults != rendered_sdkconfig:
            (project_dir / 'sdkconfig').unlink(missing_ok=True)
            (project_dir / 'sdkconfig.old').unlink(missing_ok=True)

        # Board identity defines (velxio_board.cmake, included OPTIONAL by the
        # template's top CMakeLists BEFORE project() so they reach EVERY
        # component — `Serial`'s mapping is decided inside the arduino core's
        # own sources, a sketch-only define cannot move it). Going through a
        # file instead of an env var makes it a configure dependency: CMake
        # re-runs when it changes, env vars it silently ignores.
        board_cmake_lines = ['# generated by espidf_compiler — do not edit']
        if arduino_mode and not pure_idf and board_fqbn:
            flags = self._arduino_board_flags(board_fqbn)
            if flags['board']:
                macro = re.sub(r'[^A-Z0-9_]', '_', str(flags['board']).upper())
                board_cmake_lines.append(
                    f'add_compile_definitions(ARDUINO_{macro})'
                )
            if flags['cdc_on_boot']:
                # USB_MODE is FORCED to 1 (HWCDC over USB-Serial-JTAG, the
                # boards.txt "USBMode=hwcdc" menu choice) even when the board's
                # default is 0 (USB-OTG/TinyUSB): the engine models the
                # Serial-JTAG console; the OTG device stack it does not.
                board_cmake_lines.append(
                    'add_compile_definitions(ARDUINO_USB_CDC_ON_BOOT=1 ARDUINO_USB_MODE=1)'
                )
        board_cmake = '\n'.join(board_cmake_lines) + '\n'
        board_cmake_path = project_dir / 'velxio_board.cmake'
        prev_board_cmake = (
            board_cmake_path.read_text(encoding='utf-8') if board_cmake_path.exists() else None
        )
        if prev_board_cmake != board_cmake:
            board_cmake_path.write_text(board_cmake, encoding='utf-8')

        # Generate partitions.csv per the selected scheme.
        partition_csv = self._render_partition_csv(board_options['partitionScheme'])
        _write_if_changed(project_dir / 'partitions.csv', partition_csv)

        # Get sketch content — Arduino tab semantics: EVERY .ino is part of
        # the sketch. The main file (literal sketch.ino, else the first .ino
        # sent) comes first so its globals are visible to the other tabs,
        # and the rest are concatenated after it in alphabetical order —
        # exactly what arduino-cli/the IDE do. #line markers keep compiler
        # diagnostics pointing at the real file/line of each tab.
        ino_files = [f for f in files if f['name'].endswith('.ino')]
        main_content = ''
        if ino_files:
            main_ino = next(
                (f for f in ino_files if f['name'] == 'sketch.ino'),
                ino_files[0],
            )
            rest = sorted(
                (f for f in ino_files if f is not main_ino),
                key=lambda f: f['name'],
            )
            main_content = '\n'.join(
                f'#line 1 "{f["name"]}"\n{f["content"]}'
                for f in [main_ino] + rest
            )
        if not main_content and files:
            main_content = files[0]['content']

        # ── QEMU WiFi compatibility ──────────────────────────────────────
        # QEMU's WiFi AP broadcasts "Velxio-GUEST" on channel 6.
        # We normalize ANY user SSID → "Velxio-GUEST", enforce channel 6,
        # and use open auth (empty password) so the connection always works.
        # Detect WiFi BEFORE normalization so the flag reflects the original sketch.
        # header -> display name of the library the resolver merged for it.
        # Declared at function scope: the success return reads it for EVERY
        # build mode, but only the Arduino-sketch branch fills it. Declaring
        # it inside that branch broke pure ESP-IDF compiles with
        # UnboundLocalError at the result step (2026-08-05 regression).
        merged_libs_report: dict[str, str] = {}
        _all_text = '\n'.join(f.get('content', '') for f in files)
        if pure_idf:
            has_wifi = self._detect_idf_wifi_usage(_all_text)
        else:
            # Scan the WHOLE project, not just the entry sketch. A header that
            # includes WiFi.h is as much a WiFi project as an .ino that does,
            # and judging it WiFi-less used to be fatal: the QEMU worker then
            # left the radio out of the machine and the firmware's first touch
            # of the MAC panicked with LoadStorePIFAddrError (issue #260).
            # The pure-IDF branch above always read every file; this one had
            # been reading only main_content.
            has_wifi = self._detect_wifi_usage(_all_text)
            # Normalization still rewrites only the entry sketch: it edits
            # string literals in place, and the SSID that matters is the one
            # WiFi.begin() is called with.
            if not custom_wifi_ssids:
                main_content = self._normalize_wifi_for_qemu(main_content)

        # Arduino-as-component only when compile() decided so: the core must
        # support the target (esp32c6 needs an arduino-esp32 3.x core the
        # server doesn't ship) AND the code must be an actual sketch (plain
        # ESP-IDF programs with their own app_main build pure-IDF on v5).
        # Which arduino core this build uses (3.x on v5, 2.x on v4.4).
        arduino_core_path = self._arduino_path_for(use_idf5) if arduino_mode else ''

        if pure_idf:
            # Pure ESP-IDF mode (issue #139): the user's files ARE the main
            # component sources — app_main() entry point, IDF APIs, compiled
            # by the template CMake's VELXIO_PURE_SKETCH glob branch. No
            # Arduino wrap, no velxio_compat.h, no Arduino libraries.
            main_dir = project_dir / 'main'
            # Template / other-mode leftovers must not reach the pure glob
            # (main.cpp would drag in setup()/loop() references; a stale
            # sketch.ino.cpp would redefine symbols). Deleted BEFORE writing
            # so a user file with the same name wins.
            for leftover in ('main.c', 'main.cpp', 'sketch.ino.cpp', 'sketch_translated.c'):
                (main_dir / leftover).unlink(missing_ok=True)
            wrote_any = False
            for f in files:
                # basename() the client-supplied name so it can't escape main/
                name = PurePosixPath(str(f.get('name') or '').replace('\\', '/')).name
                if not name:
                    continue
                content = f.get('content', '')
                if has_wifi:
                    if not custom_wifi_ssids:
                        content = self._normalize_wifi_for_qemu_idf(content)
                (main_dir / name).write_text(content, encoding='utf-8')
                wrote_any = True
            if not wrote_any:
                return {
                    'success': False,
                    'error': 'No source files provided.',
                    'stdout': '',
                    'stderr': '',
                }
            # Registry components the sources #include (esp_lcd_st77916 for
            # the VoCat display example, etc.) — same resolution the arduino
            # branch gets; without the manifest the header simply does not
            # exist and the build dies at the first #include.
            pure_src = '\n'.join(
                str(f.get('content', '')) for f in files if str(f.get('name', '')).endswith(
                    ('.ino', '.cpp', '.c', '.h', '.hpp')
                )
            )
            manifest_changed = self._sync_managed_components(
                project_dir, self._detect_managed_components(pure_src),
            )
        elif arduino_mode:
            # Arduino-as-component mode: copy sketch as .cpp
            sketch_cpp = project_dir / 'main' / 'sketch.ino.cpp'
            # Prepend Arduino.h, and — ONLY on the 2.x core — velxio_compat.h,
            # which shims the 3.x LEDC API (ledcAttach, …) onto 2.0.17. On the
            # 3.x core those APIs are real functions, so including the shim
            # would REDEFINE ledcAttach (its `#if !defined(ledcAttach)` guard
            # doesn't fire — a function isn't a macro) and break the build.
            compat_include = '' if use_idf5 else '#include "velxio_compat.h"\n'
            if '#include' not in main_content or 'Arduino.h' not in main_content:
                main_content = (
                    '#include "Arduino.h"\n' + compat_include + main_content
                )
            elif compat_include:
                main_content = main_content.replace(
                    '#include "Arduino.h"',
                    '#include "Arduino.h"\n' + compat_include.rstrip('\n'),
                    1,
                )
            # arduino-cli injects ctags prototypes; this path must too, or
            # helpers defined after loop() fail with "not declared in this
            # scope". Applied AFTER the prepends so #line stays accurate.
            main_content = generate_ino_prototypes(main_content)
            sketch_cpp.write_text(main_content, encoding='utf-8')

            # Copy additional files (.h, .cpp)
            for f in files:
                if not f['name'].endswith('.ino'):
                    (project_dir / 'main' / f['name']).write_text(
                        f['content'], encoding='utf-8'
                    )

            # Remove the pure-C main to avoid conflict
            main_c = project_dir / 'main' / 'main.c'
            if main_c.exists():
                main_c.unlink()
            sketch_translated = project_dir / 'main' / 'sketch_translated.c'
            if sketch_translated.exists():
                sketch_translated.unlink()

            # ── Resolve external Arduino libraries as IDF components ──────
            # arduino-cli installs libraries in ~/Arduino/libraries/ but the
            # ESP-IDF build system does not scan that path. We create a
            # user_libs/ directory where each external library becomes a
            # proper ESP-IDF component with its own CMakeLists.txt and
            # INCLUDE_DIRS. The root CMakeLists.txt (template) adds user_libs
            # to EXTRA_COMPONENT_DIRS so ESP-IDF discovers them automatically.
            #
            # Scan the .ino AND every user-supplied .h/.hpp/.c/.cpp so
            # transitive includes inside project headers (e.g. Common.h
            # → <ESP32Servo.h>) are picked up. Previously only main_content
            # was scanned, so libs only referenced from project headers
            # never reached _resolve_library_components and the build
            # died with "fatal error: ESP32Servo.h: No such file".
            own_names = {PurePosixPath(str(_f.get('name') or '').replace('\\', '/')).name
                         for _f in files}
            ext_headers_set: set[str] = set(
                self._detect_external_includes(main_content, own_names)
            )
            for _f in files:
                if _f.get('name', '').endswith(('.h', '.hpp', '.ino', '.c', '.cpp')):
                    ext_headers_set.update(
                        self._detect_external_includes(_f.get('content', ''), own_names)
                    )
            ext_headers = list(ext_headers_set)
            component_names: list[str] = []
            # merged_libs_report (function scope) is fed back to the client
            # on scan-all success so the project manifest can be
            # auto-completed (79% of projects compile with an empty manifest
            # today; this migrates them one green build at a time).
            # arduino-esp32 component name (directory basename of ARDUINO_ESP32_PATH)
            arduino_comp_name = Path(arduino_core_path).name if arduino_core_path else 'arduino-esp32'

            if ext_headers:
                user_libs_dir = project_dir / 'user_libs'
                user_libs_dir.mkdir(exist_ok=True)

                esp32_libs   = Path(arduino_core_path) / 'libraries' if arduino_core_path else None
                # P2.1e — when a per-compile library scope was materialized (the
                # manifest's libs symlinked from the content-addressed cache, with
                # a legacy-dir fallback), resolve from THAT instead of the shared
                # global volume. Falls back to the single global dir for scan-all
                # / OSS self-host.
                arduino_libs = libraries_dir or self._find_arduino_libraries_dir()

                # Heavy sync filesystem work (BFS header resolution + copying
                # thousands of library files — FastLED alone takes minutes).
                # Run it off the event loop like cmake/ninja below, or the
                # loop starves: /compile/start responses never flush and the
                # client dies on its 30s timeout while the build is fine.
                component_names, _ = await asyncio.to_thread(
                    self._resolve_library_components,
                    ext_headers, arduino_libs, esp32_libs,
                    arduino_comp_name, user_libs_dir,
                    allowed_libraries=allowed_libraries,
                    merged_libs=merged_libs_report,
                    denied=denied_libraries,
                    speculative_out=speculative_out,
                )

            # Patch main/CMakeLists.txt — REQUIRES and INCLUDE_DIRS for user_libs_all.
            # The single merged component means one entry covers all external headers.
            if component_names:  # always ['user_libs_all'] when any lib was found
                cmake_path = project_dir / 'main' / 'CMakeLists.txt'
                cmake_text = cmake_path.read_text(encoding='utf-8')

                for old_req in [r'REQUIRES ${_arduino_comp_name}', f'REQUIRES {arduino_comp_name}']:
                    if old_req in cmake_text:
                        cmake_text = cmake_text.replace(
                            old_req, f'{old_req} user_libs_all'
                        )
                        break

                cmake_text = cmake_text.replace(
                    'INCLUDE_DIRS "."',
                    'INCLUDE_DIRS "." "../user_libs/user_libs_all"',
                )

                cmake_path.write_text(cmake_text, encoding='utf-8')
                logger.info('[espidf] Patched main CMakeLists: REQUIRES += user_libs_all, INCLUDE_DIRS += user_libs_all')

            # esp_camera.h used to come free: arduino-esp32 2.x shipped a precompiled
            # SDK with esp32-camera bundled under tools/sdk/<target>/include. The 3.x
            # component does NOT, and its manifest does not depend on it either, so the
            # move to 3.x silently broke every camera sketch with "esp_camera.h: No such
            # file or directory". Ask for it explicitly; the component manager fetches it
            # during the cmake configure and caches it in the build dir.
            sketch_src = '\n'.join(
                f.get('content', '') for f in files if str(f.get('name', '')).endswith(
                    ('.ino', '.cpp', '.c', '.h', '.hpp')
                )
            )
            manifest_changed = self._sync_managed_components(
                project_dir, self._detect_managed_components(sketch_src),
            )

            # Same idea for components that live in the IDF tree rather than the
            # registry: they need to be in main's REQUIRES or the sketch cannot
            # see their headers.
            idf_comps = self._detect_idf_components(sketch_src)
            if idf_comps:
                cmake_path = project_dir / 'main' / 'CMakeLists.txt'
                cmake_text = cmake_path.read_text(encoding='utf-8')
                missing = [c for c in idf_comps if c not in cmake_text]
                if missing:
                    for old_req in [
                        r'REQUIRES ${_arduino_comp_name}',
                        f'REQUIRES {arduino_comp_name}',
                    ]:
                        if old_req in cmake_text:
                            cmake_text = cmake_text.replace(
                                old_req, old_req + ' ' + ' '.join(missing), 1
                            )
                            cmake_path.write_text(cmake_text, encoding='utf-8')
                            logger.info(
                                f'[espidf] main REQUIRES += {" ".join(missing)} '
                                '(IDF components the sketch includes)'
                            )
                            break
        else:
            # Pure ESP-IDF mode (no Arduino component usable for this
            # target). Remove Arduino main.cpp to avoid conflict.
            main_cpp = project_dir / 'main' / 'main.cpp'
            if main_cpp.exists():
                main_cpp.unlink()

            # Pure-IDF sources need the same include->component resolution the
            # arduino branch gets (e.g. the VoCat display example includes
            # esp_lcd_st77916.h from the component registry).
            idf_src = '\n'.join(
                f.get('content', '') for f in files if str(f.get('name', '')).endswith(
                    ('.ino', '.cpp', '.c', '.h', '.hpp')
                )
            )
            manifest_changed = self._sync_managed_components(
                project_dir, self._detect_managed_components(idf_src),
            )

            if self._contains_app_main(main_content):
                # The user's code is already a plain ESP-IDF program —
                # compile it verbatim (the template's main.c #includes
                # sketch_translated.c).
                (project_dir / 'main' / 'sketch_translated.c').write_text(
                    main_content, encoding='utf-8'
                )
                logger.info(
                    '[espidf] app_main detected — compiling as plain ESP-IDF C'
                )
            elif self.has_arduino:
                # An Arduino core IS installed, it just cannot build this
                # target (arduino-esp32 2.x has no esp32c6 support). Refuse
                # honestly instead of pattern-translating the sketch into
                # something that doesn't do what the user wrote.
                core_ver = self._arduino_core_version() or 'unknown'
                return {
                    'success': False,
                    'error': (
                        f'Arduino sketches are not supported on {idf_target} '
                        f'yet: the installed arduino-esp32 core '
                        f'(v{core_ver}) has no {idf_target} support — that '
                        f'needs arduino-esp32 3.x (ESP-IDF 5.x based), which '
                        f'is not installed on this server. Meanwhile you can '
                        f'write the program as plain ESP-IDF C: define '
                        f'`void app_main(void)` and use IDF APIs '
                        f'(driver/gpio.h, freertos/task.h, ...) — those '
                        f'compile and run today.'
                    ),
                    'stdout': '',
                    'stderr': '',
                }
            else:
                # Legacy fallback: no Arduino component installed at all —
                # translate the common Arduino WiFi/WebServer patterns.
                translated = self._translate_sketch_to_espidf(main_content)
                (project_dir / 'main' / 'sketch_translated.c').write_text(
                    translated, encoding='utf-8'
                )

        # Build using cmake + ninja (more portable than idf.py on Windows)
        build_dir = project_dir / 'build'
        build_dir.mkdir(exist_ok=True)

        # main/CMakeLists.txt is a configure input too. It came back from the
        # template at prepare and was patched above (user_libs_all, IDF
        # components), so its bytes usually equal the previous build's while
        # its mtime says "new" - and ninja then re-runs the whole configure.
        # Measured 2026-09-05 on the prod volume: every warm variant with a
        # library reconfigured on every build (build.ninja 20-40 s younger
        # than the freshly patched file), so the warm skip only ever paid off
        # for bare sketches. Hand the file its previous mtime when unchanged.
        # This runs BEFORE the source-set bump below so that bump still wins.
        _restore_mtime_if_unchanged(
            project_dir / 'main' / 'CMakeLists.txt', project_dir / _MAIN_CMAKE_STASH,
        )

        # The template's main/CMakeLists.txt globs main/*.c and *.cpp without
        # CONFIGURE_DEPENDS (ESP-IDF evaluates component CMakeLists in script
        # mode, where it is rejected), so cmake only re-globs on a configure.
        # Record the set of compilable sources per build; when it differs from
        # the last build's, bump main/CMakeLists.txt so ninja's RERUN_CMAKE
        # rule re-runs cmake and the new (or removed) file reaches the graph.
        main_dir = project_dir / 'main'
        try:
            source_set = '\n'.join(sorted(
                p.name for p in main_dir.iterdir() if p.suffix in ('.c', '.cpp')
            ))
        except OSError:
            source_set = ''
        source_marker = project_dir / '.velxio-sources'
        prev_source_set = (
            source_marker.read_text(encoding='utf-8') if source_marker.exists() else None
        )
        if prev_source_set != source_set:
            source_marker.write_text(source_set, encoding='utf-8')
            if prev_source_set is not None:
                try:
                    os.utime(main_dir / 'CMakeLists.txt', None)
                except OSError:
                    pass
                logger.info('[espidf] source set changed; cmake will re-glob main/')

        # A warm build dir skips the explicit configure: ninja re-runs cmake by
        # itself when any configure input changed (partitions.csv,
        # velxio_board.cmake, sdkconfig, every CMakeLists.txt, the managed
        # components' manifests). Measured 2026-09-04: the configure was 18 of
        # the 25 s of a warm esp32 build under load, and ninja then ran ~10
        # steps. VELXIO_ESPIDF_ALWAYS_CONFIGURE=1 restores the old behaviour.
        #
        # Ninja only knows the inputs the LAST configure saw. A main manifest
        # that did not exist then (this sketch is the first in the dir to
        # need a registry component) is invisible to it, so that case runs
        # the configure explicitly; so does a manifest that went away, since
        # a missing input is not something to rely on ninja regenerating.
        if manifest_changed:
            force_configure = True
        configure_skipped = (
            not _ALWAYS_CONFIGURE
            and not force_configure
            and (build_dir / 'build.ninja').is_file()
            and (build_dir / 'CMakeCache.txt').is_file()
        )
        if (
            configure_skipped and idf_target == 'esp32p4' and arduino_mode
            and (project_dir / 'managed_components' / 'espressif__esp_hosted').is_dir()
            and not (project_dir / 'components' / 'espressif__esp_hosted').is_dir()
        ):
            # The first configure fetched esp_hosted but the patched override
            # was never adopted (an earlier attempt died in between): only the
            # explicit path below creates and reconfigures it.
            configure_skipped = False

        env = self._build_env(
            idf_target, use_idf5=use_idf5, arduino_mode=arduino_mode,
            pure_idf=pure_idf,
        )

        # Step 1: cmake configure
        cmake_cmd = [
            'cmake',
            '-G', 'Ninja',
            '-Wno-dev',
            f'-DIDF_TARGET={idf_target}',
            '-DCMAKE_BUILD_TYPE=Release',
            f'-DSDKCONFIG_DEFAULTS={project_dir / "sdkconfig.defaults"}',
            # IDF re-validates its python env on every configure (~1s of a
            # ~9s configure). The image pins that env at build time and the
            # entrypoint has already exercised it, so tell IDF it was checked
            # externally - the same escape hatch idf.py uses for itself.
            '-DPYTHON_DEPS_CHECKED=1',
            str(project_dir),
        ]

        # ccache: ESP-IDF's tools/cmake/project.cmake enables ccache iff
        # the CMake variable `CCACHE_ENABLE` is truthy. We don't go through
        # `idf.py` (which would translate the env var for us), so wire it
        # in here. Default ON; set IDF_CCACHE_ENABLE=0 in the env to
        # bypass without rebuilding the image.
        if os.environ.get('IDF_CCACHE_ENABLE', '1') not in ('0', 'false', 'False', ''):
            cmake_cmd.append('-DCCACHE_ENABLE=1')

        # IDF 5.x configure does more work per cold run (component manager,
        # per-target tool checks) — give it more headroom than the 4.4 flow.
        cmake_timeout = 300 if use_idf5 else 120

        def _run_cmake():
            return _run_with_streaming(
                cmake_cmd,
                cwd=str(build_dir),
                env=env,
                timeout=cmake_timeout,
                progress_callback=progress_callback,
                nice=cpu_nice,
            )

        cmake_result = _RunResult(returncode=0, stdout='', stderr='')

        async def _configure() -> dict | None:
            """The explicit cmake configure. Returns an error result, or None."""
            nonlocal cmake_result
            logger.info(f'[espidf] cmake: {" ".join(cmake_cmd)}')
            configure_t0 = time.monotonic()
            try:
                cmake_result = await asyncio.to_thread(_run_cmake)
            except subprocess.TimeoutExpired:
                logger.error(
                    f'[espidf] cmake configure timed out after {cmake_timeout}s '
                    f'in {build_dir}'
                )
                return {
                    'success': False,
                    'error': f'ESP-IDF cmake configure timed out ({cmake_timeout}s)',
                    'stdout': '',
                    'stderr': '',
                }

            if cmake_result.returncode != 0:
                # A managed component left half-copied by an interrupted or
                # concurrent configure makes the component manager refuse the
                # whole variant for good ("is corrupted"). The copy in its own
                # cache is intact, so drop the variant's copies and configure
                # once more instead of failing every compile of this variant
                # until the dir is deleted by hand.
                corrupt = _corrupt_managed_component(cmake_result.stderr)
                if corrupt and _heal_corrupt_managed_components(project_dir, build_dir):
                    logger.warning(
                        f'[espidf] managed component "{corrupt}" corrupted in '
                        f'{project_dir}; dropped managed_components/ and reconfiguring'
                    )
                    try:
                        cmake_result = await asyncio.to_thread(_run_cmake)
                    except subprocess.TimeoutExpired:
                        return {
                            'success': False,
                            'error': f'ESP-IDF cmake reconfigure timed out ({cmake_timeout}s)',
                            'stdout': '',
                            'stderr': '',
                        }
            if cmake_result.returncode != 0:
                logger.error(f'[espidf] cmake failed:\n{cmake_result.stderr}')
                return {
                    'success': False,
                    'error': 'ESP-IDF cmake configure failed',
                    'stdout': cmake_result.stdout,
                    'stderr': cmake_result.stderr,
                }

            # The configure above fetched managed components; give esp32p4 its
            # patched esp_hosted override, and reconfigure once when it appears
            # so the build system adopts the components/ dir.
            if idf_target == 'esp32p4' and arduino_mode:
                if self._override_esp_hosted_with_race_fix(project_dir):
                    try:
                        cmake_result = await asyncio.to_thread(_run_cmake)
                    except subprocess.TimeoutExpired:
                        return {
                            'success': False,
                            'error': f'ESP-IDF cmake reconfigure timed out ({cmake_timeout}s)',
                            'stdout': '',
                            'stderr': '',
                        }
                    if cmake_result.returncode != 0:
                        logger.error(
                            f'[espidf] reconfigure after esp_hosted override failed:\n'
                            f'{cmake_result.stderr}'
                        )
                        return {
                            'success': False,
                            'error': 'ESP-IDF reconfigure after esp_hosted override failed',
                            'stdout': cmake_result.stdout,
                            'stderr': cmake_result.stderr,
                        }
            _timing_note(configure_ms=int((time.monotonic() - configure_t0) * 1000))
            return None

        if configure_skipped:
            logger.info('[espidf] warm build dir: skipping cmake configure')
            if progress_callback is not None:
                try:
                    progress_callback('[velxio] build dir is warm; skipping cmake configure\n')
                except Exception:
                    pass
        else:
            configure_error = await _configure()
            if configure_error is not None:
                return configure_error
        _timing_note(configure_skipped=configure_skipped)

        # Step 2: ninja build
        ninja_cmd = ['ninja'] + _ninja_parallelism_args()
        logger.info(f'[espidf] Building with {" ".join(ninja_cmd)}...')

        # Cold ESP-IDF builds with external Arduino libraries (e.g. Adafruit
        # BMP280 + BusIO + Unified Sensor → ~1480 build steps) regularly take
        # 5-7 minutes on modest hardware. 300s used to cut them off at 98%;
        # bump to 600s so first-run cold compiles complete. Subsequent
        # builds reuse ninja's cache and finish in seconds.
        NINJA_TIMEOUT_S = 600

        def _run_ninja():
            return _run_with_streaming(
                ninja_cmd,
                cwd=str(build_dir),
                env=env,
                timeout=NINJA_TIMEOUT_S,
                progress_callback=progress_callback,
                nice=cpu_nice,
            )

        ninja_t0 = time.monotonic()
        try:
            ninja_result = await asyncio.to_thread(_run_ninja)
            if (
                configure_skipped
                and ninja_result.returncode != 0
                and _ninja_failure_wants_configure(ninja_result)
            ):
                # The fast path trusted the warm dir and ninja's own cmake
                # re-run could not cope (a deleted input, a corrupted managed
                # component, a stale cache). Do what the slow path would have
                # done from the start, once, then build again.
                logger.warning(
                    '[espidf] ninja could not regenerate the warm build dir; '
                    'falling back to an explicit configure'
                )
                _timing_note(configure_fallback=True)
                configure_error = await _configure()
                if configure_error is not None:
                    return configure_error
                ninja_result = await asyncio.to_thread(_run_ninja)
        except subprocess.TimeoutExpired:
            # Silent before — a 600s failure left no server-side trace at all,
            # so a slow-box incident (2026-08-17: cold S3 variant, ccache
            # missing on every object) had to be reconstructed from the
            # variant's .ninja_log. Say where it happened and how far it got.
            done_steps = _ninja_log_step_count(build_dir)
            logger.error(
                f'[espidf] ninja build timed out after {NINJA_TIMEOUT_S}s in '
                f'{build_dir} ({done_steps} steps logged)'
            )
            return {
                'success': False,
                # ninja is incremental and the variant dir persists: the
                # objects built so far are kept, so retrying picks up where
                # this attempt stopped instead of starting over.
                'error': (
                    f'ESP-IDF build timed out ({NINJA_TIMEOUT_S}s) — the partial '
                    f'build is kept; compile again to resume where it stopped'
                ),
                'stdout': '',
                'stderr': '',
            }

        _timing_note(ninja_ms=int((time.monotonic() - ninja_t0) * 1000))
        all_stdout = cmake_result.stdout + '\n' + ninja_result.stdout
        all_stderr = cmake_result.stderr + '\n' + ninja_result.stderr

        # Filter out expected but ugly warnings from stderr (e.g. absent git, cmake deprecation)
        filtered_stderr_lines = []
        for line in all_stderr.splitlines():
            if 'fatal: not a git repository' in line:
                continue
            if 'CMake Deprecation Warning' in line:
                continue
            if 'Compatibility with CMake' in line:
                continue
            filtered_stderr_lines.append(line)
        all_stderr = '\n'.join(filtered_stderr_lines)

        if ninja_result.returncode != 0:
            # Extract the actual compiler errors from ninja's stdout.
            # Ninja prints failed job blocks in stdout:
            #   FAILED: path/to/file.obj
            #   <compiler command>
            #   sketch.ino.cpp:5:10: fatal error: DHT.h: No such file or directory
            #   compilation terminated.
            #   ninja: build stopped: subcommand failed.
            stdout_lines = ninja_result.stdout.split('\n')
            error_lines: list[str] = []
            in_failed_block = False
            for line in stdout_lines:
                stripped = line.strip()
                if stripped.startswith('FAILED:') or stripped == 'ninja: build stopped: subcommand failed.':
                    in_failed_block = True
                    error_lines.append(line)
                    continue
                # Next [N/M] progress line ends the block
                if in_failed_block and stripped.startswith('[') and '/' in stripped and ']' in stripped:
                    in_failed_block = False
                if in_failed_block:
                    error_lines.append(line)
                elif ': error:' in line or 'fatal error:' in line.lower():
                    # Explicit compiler error outside a FAILED block
                    error_lines.append(line)

            extracted = '\n'.join(l for l in error_lines if l.strip())

            # First non-FAILED, non-command error line → short summary for toolbar
            summary = 'ESP-IDF build failed'
            for l in error_lines:
                s = l.strip()
                if s and not s.startswith('FAILED:') and not s.startswith('ninja:') and not s.startswith('/') and 'error:' in s.lower():
                    summary = s
                    break
            if summary == 'ESP-IDF build failed' and error_lines:
                # Fall back to first non-empty error line
                for l in error_lines:
                    if l.strip() and not l.strip().startswith('FAILED:'):
                        summary = l.strip()
                        break

            # Put extracted errors in stderr so the console highlights them
            combined_stderr = (extracted + '\n\n' + all_stderr).strip() if extracted else all_stderr

            logger.error(f'[espidf] ninja build failed (stdout):\n{ninja_result.stdout[-4000:]}')
            logger.error(f'[espidf] ninja build failed (stderr):\n{ninja_result.stderr[-2000:]}')
            return {
                'success': False,
                'error': summary,
                'stdout': all_stdout,
                'stderr': combined_stderr,
            }

        # Step 3: Build the SPIFFS partition image (if files were uploaded
        # and the partition scheme has a filesystem region). Skipped silently
        # when mkspiffs isn't installed — see _build_spiffs_image.
        flash_size_bytes = self._FLASH_SIZE_BYTES.get(
            board_options['flashSize'], 4 * 1024 * 1024,
        )
        fs_partition = self._find_filesystem_partition(partition_csv)
        spiffs_bin: Optional[Path] = None
        spiffs_offset = 0
        if spiffs_files:
            try:
                spiffs_bin = self._build_spiffs_image(
                    project_dir,
                    spiffs_files,
                    fs_partition['size'] if fs_partition else 0,
                )
            except ValueError as exc:
                return {
                    'success': False,
                    'error': str(exc),
                    'stdout': all_stdout,
                    'stderr': all_stderr,
                }
            if spiffs_bin is not None and fs_partition is not None:
                spiffs_offset = fs_partition['offset']

        # Step 4: Merge binaries into flash image
        try:
            merged_path = self._merge_flash_image(
                build_dir, idf_target,
                flash_size_bytes=flash_size_bytes,
                spiffs_bin=spiffs_bin,
                spiffs_offset=spiffs_offset,
            )
        except FileNotFoundError as exc:
            return {
                'success': False,
                'error': f'Binary merge failed: {exc}',
                'stdout': all_stdout,
                'stderr': all_stderr,
            }
        except ValueError as exc:
            return {
                'success': False,
                'error': str(exc),
                'stdout': all_stdout,
                'stderr': all_stderr,
            }

        binary_b64 = base64.b64encode(merged_path.read_bytes()).decode('ascii')
        logger.info(f'[espidf] Compilation successful — {len(binary_b64) // 1024} KB (base64), has_wifi={has_wifi}')

        result_ok: dict = {
            'success': True,
            'hex_content': None,
            'binary_content': binary_b64,
            'binary_type': 'bin',
            'has_wifi': has_wifi,
            'stdout': all_stdout,
            'stderr': all_stderr,
        }
        # Scan-all build (no manifest): tell the client exactly which
        # libraries the build really used, shaped like the existing
        # manifest_suggested_libraries ({header: [candidates]}) so one
        # consumer handles both this and the incomplete-manifest retry.
        if allowed_libraries is None and merged_libs_report:
            result_ok['manifest_incomplete'] = True
            result_ok['manifest_suggested_libraries'] = {
                h: [name] for h, name in merged_libs_report.items()
            }
        return result_ok


# Singleton instance
espidf_compiler = ESPIDFCompiler()
