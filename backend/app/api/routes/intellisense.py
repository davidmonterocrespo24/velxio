"""Intellisense symbol server.

Serves editor symbol tables (classes, public methods, constants, enum values)
for the Arduino libraries a host actually has. Extraction is done by the
dependency-free scanner in app.services.symbol_extract, which also mirrors
the pro overlay's cache naming rules; this module never imports app.pro.

Two library layouts answer this endpoint, in that order:

  1. The content-addressed library cache (VELXIO_LIBCACHE_DIR, default
     /var/velxio/libcache — entry dirs named `<norm_name>@<norm_version>-
     <sha12>`). Immutable by construction, so a scan cached under an entry
     name can never go stale and the response is safe to cache hard.
  2. A plain arduino-cli sketchbook `libraries/` dir — what Velxio Desktop's
     sidecar and a self-host have. Entry dirs are named after the library and
     the version lives in library.properties, and they are MUTABLE (`lib
     upgrade` rewrites one in place), so scans are keyed by a cheap content
     stamp instead of by the dir name.

A host with neither simply 404s and the editor degrades to the engine's
embedded catalog.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path
from typing import NamedTuple, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from app.services.symbol_extract import (
    _entry_version_key,
    _read_props,
    find_cache_entry,
    library_headers,
    norm_name,
    norm_version,
    parse_spec,
    scan_library,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# Entry dir names are content-addressed (sha12 suffix), so the payload for a
# given spec resolution can be cached hard by browsers/proxies.
_CACHE_HEADERS = {"Cache-Control": "public, max-age=86400"}


class _Source(NamedTuple):
    """One library layout this endpoint can answer from. `content_addressed`
    is the whole difference: it decides how an entry is found, how its scan is
    keyed, and where the scan cache is written."""

    root: Path
    content_addressed: bool


def _cache_root() -> Path:
    """Resolved per-request so tests (and container reconfigs) can point the
    endpoint elsewhere via the environment."""
    return Path(os.environ.get("VELXIO_LIBCACHE_DIR", "/var/velxio/libcache"))


# arduino-cli's own sketchbook, asked once and remembered: on the desktop
# sidecar nobody sets an env var for it, and guessing ~/Arduino is wrong on
# the platforms where the default is ~/Documents/Arduino. Whatever arduino-cli
# answers is by definition the dir the compile resolves libraries from.
_CLI_PROBE_TTL_S = 600
_cli_probe: tuple[float, Optional[Path]] = (0.0, None)


def _cli_sketchbook() -> Optional[Path]:
    global _cli_probe
    ts, cached = _cli_probe
    now = time.time()
    if ts and now - ts < _CLI_PROBE_TTL_S:
        return cached
    found: Optional[Path] = None
    try:
        out = subprocess.run(
            ["arduino-cli", "config", "get", "directories.user"],
            capture_output=True, text=True, timeout=5,
        )
        if out.returncode == 0:
            p = Path(out.stdout.strip().strip('"'))
            if p.is_dir():
                found = p
    except (OSError, subprocess.SubprocessError):
        pass  # no arduino-cli on PATH (web image is fine — it has the cache)
    _cli_probe = (now, found)
    return found


def _sketchbook_libraries() -> Optional[Path]:
    """The `libraries/` dir of the local sketchbook, or None.

    VELXIO_SYMBOL_LIBRARIES_DIR names the libraries dir itself (the explicit
    override, for a host that keeps its libraries somewhere unusual); the
    sketchbook env vars name its parent; arduino-cli is asked last but knows
    best. The home-dir guesses are only reached when arduino-cli cannot be
    run at all.
    """
    direct = os.environ.get("VELXIO_SYMBOL_LIBRARIES_DIR")
    if direct and Path(direct).is_dir():
        return Path(direct)
    for env in ("ARDUINO_DIRECTORIES_USER", "VELXIO_FALLBACK_SKETCHBOOK"):
        val = os.environ.get(env)
        if val and (Path(val) / "libraries").is_dir():
            return Path(val) / "libraries"
    probed = _cli_sketchbook()
    if probed is not None and (probed / "libraries").is_dir():
        return probed / "libraries"
    home = Path.home()
    for rel in ("Arduino/libraries", "Documents/Arduino/libraries"):
        if (home / rel).is_dir():
            return home / rel
    return None


def _sources() -> list[_Source]:
    """The layouts to try, best first. The sketchbook is skipped when it
    resolves to the cache itself: the pro overlay points arduino-cli's
    sketchbook at `<cache>/../cache-sketchbook/libraries`, a symlink to the
    cache root, and scanning it twice under two shapes buys nothing."""
    out: list[_Source] = []
    cache = _cache_root()
    if cache.is_dir():
        out.append(_Source(cache, True))
    libs = _sketchbook_libraries()
    if libs is not None:
        try:
            same = any(s.root.resolve() == libs.resolve() for s in out)
        except OSError:
            same = False
        if not same:
            out.append(_Source(libs, False))
    return out


def _stamp(entry: Path) -> str:
    """Content fingerprint of a MUTABLE library dir: file count, total size and
    newest mtime over the tree, stat only — no reads. Changes whenever
    arduino-cli installs or upgrades the library, which is what lets a scan be
    cached on disk without ever going stale."""
    newest = 0.0
    total = 0
    count = 0
    for parent, dirs, files in os.walk(entry):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for f in files:
            try:
                st = os.stat(os.path.join(parent, f))
            except OSError:
                continue
            count += 1
            total += st.st_size
            newest = max(newest, st.st_mtime)
    raw = f"{count}:{total}:{newest:.6f}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


def _entry_key(src: _Source, entry: Path) -> str:
    """Cache key for one entry's scan. A content-addressed entry IS its key;
    a sketchbook folder gets the same `<norm_name>@<norm_version>-<12 hex>`
    shape built from its properties plus the content stamp."""
    if src.content_addressed:
        return entry.name
    props = _read_props(entry)
    name = norm_name(props.get("name", "")) or norm_name(entry.name) or "lib"
    return f"{name}@{norm_version(props.get('version', ''))}-{_stamp(entry)}"


def _symbols_dir(src: _Source) -> Path:
    """Where scans are persisted. Inside the cache root for the cache; beside
    the sketchbook's `libraries/` for a sketchbook, so nothing Velxio writes
    ever lands where arduino-cli looks for libraries."""
    if src.content_addressed:
        return src.root / ".symbols"
    return src.root.parent / ".velxio-symbols"


def _entries(src: _Source) -> list[Path]:
    try:
        return sorted(
            d for d in src.root.iterdir() if d.is_dir() and not d.name.startswith(".")
        )
    except OSError:
        return []


def _find_entry(src: _Source, name: str, version: Optional[str]) -> Optional[Path]:
    if src.content_addressed:
        return find_cache_entry(src.root, name, version)
    # A sketchbook folder is matched on library.properties `name=` (or the
    # folder name), and the version is a PREFERENCE, not a filter: the local
    # build compiles against whatever is installed, so answering with the
    # installed version beats 404ing because the project pinned another one.
    want = norm_name(name)
    if not want:
        return None
    fallback: Optional[Path] = None
    for d in _entries(src):
        props = _read_props(d)
        if norm_name(props.get("name", "")) != want and norm_name(d.name) != want:
            continue
        if version is None or norm_version(props.get("version", "")) == norm_version(version):
            return d
        if fallback is None:
            fallback = d
    return fallback


def _write_symbol_cache(sym_file: Path, payload: dict) -> None:
    """Atomically persist a scan result (tmp file + rename). Failures are
    logged and ignored — the response was already computed."""
    try:
        sym_file.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(sym_file.parent), prefix=".tmp-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(payload, f)
            os.replace(tmp, sym_file)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except OSError as e:
        logger.warning("[intellisense] symbol cache write failed for %s: %s", sym_file, e)


def _payload_for(src: _Source, entry: Path) -> dict:
    """Cached scan of one entry (the same disk cache get_symbols uses)."""
    sym_file = _symbols_dir(src) / f"{_entry_key(src, entry)}.json"
    if sym_file.is_file():
        try:
            return json.loads(sym_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
    payload = scan_library(entry)
    _write_symbol_cache(sym_file, payload)
    return payload


_TYPE_INDEX_NAME = "_types.json"
_TYPE_INDEX_MAX_AGE_S = 6 * 3600
_MAX_BASES = 8


def _index_key(src: _Source, entries: list[Path]) -> str:
    """Fingerprint of the whole source. Entry keys already move whenever any
    library's bytes change, so an index built under this key describes exactly
    the libraries present."""
    joined = ",".join(_entry_key(src, e) for e in entries)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:12]


def _type_index(src: _Source) -> dict[str, str]:
    """owner-class name -> entry dir name, over the whole source. Built by
    scanning every entry once (each scan is itself disk-cached), persisted
    next to the scans and rebuilt when the source's fingerprint moves or the
    index ages out. When two entries declare the same class (a library and
    its fork, or two versions), the newest entry for the alphabetically-first
    library wins -- deterministic and, for the common case of one library per
    class, irrelevant."""
    idx_file = _symbols_dir(src) / _TYPE_INDEX_NAME
    entries = _entries(src)
    key = _index_key(src, entries)
    if idx_file.is_file():
        try:
            cached = json.loads(idx_file.read_text(encoding="utf-8"))
            fresh = (time.time() - idx_file.stat().st_mtime) < _TYPE_INDEX_MAX_AGE_S
            if fresh and cached.get("index_key") == key:
                return cached["types"]
        except (OSError, ValueError, KeyError):
            pass

    # Many classes are declared by more than one cached library: the real
    # one plus forks and bundles that vendor a copy (PubSubClient ships inside
    # "ESP8266 Microgear", NTPClient inside "ESP8266 Weather Station",
    # AccelStepper inside "Arduino Learning Board"). Pick, per class:
    #   1. the library whose normalized name equals the class name, else
    #   2. the library declaring the MOST members of that class (the
    #      canonical copy is the complete one; vendored copies are trimmed),
    #   3. ties: alphabetical, deterministic.
    best: dict[str, tuple[int, int, str]] = {}  # owner -> (name_match, member_count, entry) with a sortable key
    by_name: dict[str, list[Path]] = {}
    for entry in entries:
        # Cache entries carry the version in the dir name, so several map to
        # one library; a sketchbook holds one dir per library already.
        by_name.setdefault(entry.name.partition("@")[0], []).append(entry)
    for lib_name in sorted(by_name):
        newest = sorted(by_name[lib_name], key=_entry_version_key, reverse=True)[0]
        try:
            payload = _payload_for(src, newest)
        except Exception as e:  # noqa: BLE001 - one bad library must not kill the index
            logger.warning("[intellisense] type index: skipping %s: %s", newest.name, e)
            continue
        counts: dict[str, int] = {}
        for sym in payload.get("symbols", []):
            owner = sym.get("owner")
            if owner:
                counts[owner] = counts.get(owner, 0) + 1
        for owner, n in counts.items():
            name_match = 1 if norm_name(owner) == norm_name(lib_name) else 0
            candidate = (name_match, n, newest.name)
            cur = best.get(owner)
            # higher name_match, then higher count, then (already alphabetical
            # by iteration order) keep the first
            if cur is None or (candidate[0], candidate[1]) > (cur[0], cur[1]):
                best[owner] = candidate
    types = {owner: entry for owner, (_, _, entry) in best.items()}
    _write_symbol_cache(idx_file, {"index_key": key, "types": types})
    return types


@router.get("/catalog")
def get_catalog() -> JSONResponse:
    """Installed library names, versions and headers for include completion."""
    libraries = []
    seen: set[tuple[str, str]] = set()
    for source in _sources():
        for entry in _entries(source):
            if not (entry / "library.properties").is_file():
                continue
            props = _read_props(entry)
            name = props.get("name") or entry.name
            version = props.get("version", "")
            key = norm_name(name), norm_version(version)
            if key in seen:
                continue
            seen.add(key)
            architectures = [value.strip() for value in props.get("architectures", "*").split(",")]
            libraries.append({
                "name": name, "version": version, "headers": library_headers(entry),
                "architectures": architectures,
            })
    return JSONResponse({"libraries": libraries}, headers={"Cache-Control": "no-cache"})


@router.get("/type/{name}")
def get_type_members(name: str, library: str | None = None) -> JSONResponse:
    """Members of one class/struct, whichever library declares it.

    This is the long-tail path that is safe for completion quality: the
    engine calls it only after tree-sitter has resolved a receiver to a
    declared type that the embedded catalog does not know (`PubSubClient
    client(espClient); client.` -> PubSubClient), and it returns ONLY that
    type's members -- never a library's module-level constants or macros,
    which are what made feeding whole library sets into the candidate pool
    measurably worse. Payload shape matches /symbols/ so the engine's
    RemoteSymbolCache can store it unchanged."""
    sources = _sources()
    if not sources:
        raise HTTPException(status_code=404, detail="no library source available")
    if not re.fullmatch(r"[A-Za-z_]\w{0,80}", name):
        raise HTTPException(status_code=400, detail="not a type name")

    for src in sources:
        types = None if library else _type_index(src)
        if library:
            entry = _find_entry(src, *parse_spec(library))
        else:
            entry_name = types.get(name)
            entry = src.root / entry_name if entry_name else None
        if entry is None or not entry.is_dir():
            continue  # stale index for this source; try the next
        payload = _payload_for(src, entry)
        if library and not any(s.get("name") == name or s.get("owner") == name for s in payload.get("symbols", [])):
            continue
        break
    else:
        raise HTTPException(status_code=404, detail=f"no installed library declares {name}")

    # Own members first, then the inheritance chain, breadth-first, each base
    # resolved through the same index (it may live in another library:
    # Adafruit_SH1106G -> Adafruit_SH110X -> Adafruit_GrayOLED -> Adafruit_GFX
    # crosses two). Members are re-owned to the requested type so the editor
    # sees one flat class; `bases` lists the chain so a host that already
    # embeds one of them (Adafruit_GFX is curated client-side) can dedupe.
    symbols: list[dict] = []
    seen_names: set[str] = set()
    chain: list[str] = []
    queue = [(name, payload)]
    visited = {name}
    while queue and len(chain) < _MAX_BASES:
        cur, cur_payload = queue.pop(0)
        if cur != name:
            chain.append(cur)
        for sym in cur_payload.get("symbols", []):
            if sym.get("owner") != cur or sym["name"] in seen_names:
                continue
            seen_names.add(sym["name"])
            out = dict(sym)
            out["owner"] = name
            if cur != name:
                out["inheritedFrom"] = cur
            symbols.append(out)
        cls = next(
            (s for s in cur_payload.get("symbols", []) if s.get("kind") == "class" and s.get("name") == cur),
            None,
        )
        for base in (cls or {}).get("bases", []):
            if base in visited:
                continue
            visited.add(base)
            if types is None:
                types = _type_index(src)
            base_entry = types.get(base)
            if base_entry and (src.root / base_entry).is_dir():
                queue.append((base, _payload_for(src, src.root / base_entry)))
            else:
                # Not in this source (a core class like Print/Stream, or an
                # embedded one like Adafruit_GFX): still report it so the
                # host can supply the members itself.
                chain.append(base)

    return JSONResponse(
        content={
            "id": payload.get("id") or entry.name,
            "triggers": payload.get("triggers", []),
            "type": name,
            "bases": chain,
            "symbols": symbols,
        },
        headers=_CACHE_HEADERS,
    )


@router.get("/symbols/{spec}")
def get_symbols(spec: str) -> JSONResponse:
    """Symbol table for one library. `spec` is `Name@Version` or a bare
    `Name` (which resolves to the newest version present). Names and versions
    are normalized with the same rules the cache uses, so `Adafruit GFX
    Library@1.12.6` and `adafruitgfxlibrary@1.12.6` hit the same entry."""
    name, version = parse_spec(spec)
    sources = _sources()
    if not sources:
        raise HTTPException(status_code=404, detail="no library source available")
    for src in sources:
        entry = _find_entry(src, name, version)
        if entry is not None:
            return JSONResponse(content=_payload_for(src, entry), headers=_CACHE_HEADERS)
    raise HTTPException(status_code=404, detail=f"library not installed: {spec}")
