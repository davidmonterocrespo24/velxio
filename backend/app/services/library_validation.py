"""Server-side validation for plugin-supplied Arduino libraries.

This is a Python port of the rules in ``packages/sdk/src/libraries.ts``. Both
sides validate independently because the wire is the trust boundary — the
client may be a tampered build, so the server cannot accept its assurance
that a payload "already passed" validation. The two validators are kept in
lockstep by a sync test (see ``backend/tests/test_library_validation.py``).

Constants and the regex match the SDK byte-for-byte. If the SDK rules change,
update this file in the same commit.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, List, Sequence

# ── Caps (must mirror SDK) ────────────────────────────────────────────────

LIBRARY_MAX_TOTAL_BYTES = 2_097_152  # 2 MB
LIBRARY_MAX_FILE_BYTES = 524_288  # 512 KB
LIBRARY_MAX_PATH_DEPTH = 8
LIBRARY_ID_MAX = 128
LIBRARY_VERSION_MAX = 32
LIBRARY_PATH_MAX = 256
LIBRARY_FILES_MAX = 512

_SAFE_PATH_RE = re.compile(r"^[A-Za-z0-9_./-]+$")

ALLOWED_EXTENSIONS = frozenset(
    {
        ".h",
        ".hpp",
        ".hh",
        ".c",
        ".cc",
        ".cpp",
        ".cxx",
        ".s",
        ".S",
        ".inc",
        ".ino",
        ".txt",
        ".md",
        ".properties",
    }
)

ALLOWED_PRAGMAS = frozenset(
    {"once", "pack", "GCC", "clang", "message", "warning", "error"}
)


class LibraryValidationError(ValueError):
    """Raised when a library bundle fails server-side validation.

    Carries ``library_id`` so the route handler can build a human-readable
    error message identifying which entry failed without having to inspect
    the payload again. ``http_status`` selects the response code: 413 for
    size violations (server-side resource constraint), 400 for everything
    else (client sent a malformed payload).
    """

    def __init__(self, library_id: str, reason: str, *, http_status: int = 400) -> None:
        super().__init__(f"library {library_id!r} invalid: {reason}")
        self.library_id = library_id
        self.reason = reason
        self.http_status = http_status


@dataclass(frozen=True)
class LibraryFileSpec:
    path: str
    content: str


@dataclass(frozen=True)
class LibrarySpec:
    id: str
    version: str
    files: Sequence[LibraryFileSpec]


def _is_safe_relative_path(path: str) -> bool:
    if path.startswith("/") or path.startswith("\\"):
        return False
    if not _SAFE_PATH_RE.match(path):
        return False
    segments = path.split("/")
    if len(segments) > LIBRARY_MAX_PATH_DEPTH:
        return False
    for seg in segments:
        if seg == "" or seg == "." or seg == "..":
            return False
    return True


def _has_allowed_extension(path: str) -> bool:
    last_dot = path.rfind(".")
    if last_dot < 0:
        return False
    ext = path[last_dot:]
    # Mirrors SDK: case-sensitive primary lookup, case-insensitive fallback.
    # Lets ``.S`` (assembly) coexist with ``.s`` while still accepting ``.CPP``.
    return ext in ALLOWED_EXTENSIONS or ext.lower() in ALLOWED_EXTENSIONS


def _is_preprocessor_clean(content: str) -> bool:
    """Reject ``#include`` paths that escape upward and unknown ``#pragma``s.

    Mirrors the SDK scan exactly. Tolerates everything else (``#define``,
    ``#if``, ``#ifdef``, …) — rejecting them would break legitimate libraries.
    """
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line.startswith("#"):
            continue
        directive = line[1:].lstrip()
        if directive.startswith("include"):
            rest = directive[len("include") :].strip()
            if rest.startswith("<"):
                close = rest.find(">")
                if close < 0:
                    return False
                target = rest[1:close]
                if ".." in target:
                    return False
                continue
            if rest.startswith('"'):
                close = rest.find('"', 1)
                if close < 0:
                    return False
                target = rest[1:close]
                if ".." in target or target.startswith("/"):
                    return False
                continue
            return False  # malformed include
        if directive.startswith("pragma"):
            rest = directive[len("pragma") :].strip()
            match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)", rest)
            head = match.group(1) if match else ""
            if head not in ALLOWED_PRAGMAS:
                return False
    return True


def _validate_id(value: str, field: str, library_id: str) -> None:
    if not isinstance(value, str) or not value:
        raise LibraryValidationError(library_id, f"{field} must be a non-empty string")
    if field == "id" and len(value) > LIBRARY_ID_MAX:
        raise LibraryValidationError(library_id, f"id exceeds {LIBRARY_ID_MAX} chars")
    if field == "version" and len(value) > LIBRARY_VERSION_MAX:
        raise LibraryValidationError(
            library_id, f"version exceeds {LIBRARY_VERSION_MAX} chars"
        )


def validate_library(spec: LibrarySpec) -> LibrarySpec:
    """Validate one library bundle. Raises ``LibraryValidationError`` on failure.

    Validation order matches the SDK to keep error messages consistent
    cross-stack:
      1. id / version shape
      2. file list bounds
      3. per-file size cap (413)
      4. running total bytes cap (413)
      5. path uniqueness, safety, extension
      6. preprocessor scan
    """
    library_id = spec.id or "<unknown>"
    _validate_id(spec.id, "id", library_id)
    _validate_id(spec.version, "version", library_id)

    if not spec.files:
        raise LibraryValidationError(library_id, "files[] cannot be empty")
    if len(spec.files) > LIBRARY_FILES_MAX:
        raise LibraryValidationError(
            library_id, f"files[] length exceeds {LIBRARY_FILES_MAX}"
        )

    seen_paths: set[str] = set()
    total = 0
    for file in spec.files:
        if not isinstance(file.path, str) or not file.path:
            raise LibraryValidationError(library_id, "every file needs a non-empty path")
        if len(file.path) > LIBRARY_PATH_MAX:
            raise LibraryValidationError(
                library_id, f"path {file.path!r} exceeds {LIBRARY_PATH_MAX} chars"
            )
        content = file.content if isinstance(file.content, str) else ""
        if len(content) > LIBRARY_MAX_FILE_BYTES:
            raise LibraryValidationError(
                library_id,
                f"file {file.path!r} is {len(content)} bytes, exceeds the "
                f"{LIBRARY_MAX_FILE_BYTES}-byte per-file cap",
                http_status=413,
            )
        total += len(content)
        if total > LIBRARY_MAX_TOTAL_BYTES:
            raise LibraryValidationError(
                library_id,
                f"total bytes ({total}) exceed the {LIBRARY_MAX_TOTAL_BYTES}-byte cap",
                http_status=413,
            )
        if file.path in seen_paths:
            raise LibraryValidationError(
                library_id, f"duplicate file path {file.path!r}"
            )
        seen_paths.add(file.path)

        if not _is_safe_relative_path(file.path):
            raise LibraryValidationError(
                library_id,
                f"path {file.path!r} is not a safe relative path "
                "(no .., no absolute paths, allowed chars only)",
            )
        if not _has_allowed_extension(file.path):
            raise LibraryValidationError(
                library_id,
                f"path {file.path!r} has an extension that is not allowed for Arduino libraries",
            )
        if not _is_preprocessor_clean(content):
            raise LibraryValidationError(
                library_id, f"file {file.path!r} contains an unsafe preprocessor directive"
            )

    return spec


def validate_libraries(specs: Iterable[LibrarySpec]) -> List[LibrarySpec]:
    """Validate a batch. Stops at the first failure. Also rejects duplicate
    library ids — arduino-cli identifies libraries by folder name, so two
    bundles with the same id would silently overwrite each other on disk.
    """
    seen_ids: set[str] = set()
    out: list[LibrarySpec] = []
    for spec in specs:
        validated = validate_library(spec)
        if validated.id in seen_ids:
            raise LibraryValidationError(
                validated.id,
                "duplicate library id in batch (arduino-cli identifies libraries by folder name)",
            )
        seen_ids.add(validated.id)
        out.append(validated)
    return out
