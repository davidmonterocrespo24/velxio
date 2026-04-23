"""Server-side validation rules for plugin Arduino libraries (SDK-004b).

The Python validator in ``app.services.library_validation`` is a port of
the Zod rules in ``packages/sdk/src/libraries.ts``. Both validators run
independently — the wire is the trust boundary, so a tampered client
cannot vouch for its payload. These tests pin every rule to its
exit code (400 vs 413) so the SDK and the backend stay in lockstep
and the frontend can rely on the status code to drive UI.

If ``packages/sdk/src/libraries.ts`` changes, update both files in the
same commit and update the cases below.
"""

from __future__ import annotations

import pytest

from app.services.library_validation import (
    LIBRARY_MAX_FILE_BYTES,
    LIBRARY_MAX_TOTAL_BYTES,
    LibraryFileSpec,
    LibrarySpec,
    LibraryValidationError,
    validate_libraries,
    validate_library,
)


_DEFAULT_FILES: list[tuple[str, str]] = [("TestLib.h", "#pragma once\nvoid noop();\n")]


def _spec(
    *,
    library_id: str = "TestLib",
    version: str = "1.0.0",
    files: list[tuple[str, str]] | None = None,
) -> LibrarySpec:
    # ``None`` means "use the default header"; an explicit empty list passes
    # through so we can exercise the empty-files branch from a test.
    chosen = _DEFAULT_FILES if files is None else files
    return LibrarySpec(
        id=library_id,
        version=version,
        files=tuple(LibraryFileSpec(path=p, content=c) for p, c in chosen),
    )


# ── Happy path ─────────────────────────────────────────────────────────────


def test_accepts_minimal_header() -> None:
    spec = _spec()
    out = validate_library(spec)
    assert out is spec


def test_accepts_nested_path_under_depth_cap() -> None:
    spec = _spec(files=[("src/sub/dir/Header.h", "#pragma once\n")])
    validate_library(spec)


def test_accepts_allowed_pragmas() -> None:
    content = (
        "#pragma once\n"
        "#pragma GCC diagnostic ignored \"-Wall\"\n"
        "#pragma message \"hi\"\n"
        "void f();\n"
    )
    validate_library(_spec(files=[("TestLib.h", content)]))


def test_accepts_includes_with_safe_targets() -> None:
    content = '#include "subdir/header.h"\n#include <Arduino.h>\nvoid f();\n'
    validate_library(_spec(files=[("TestLib.h", content)]))


# ── id / version shape (400) ───────────────────────────────────────────────


def test_rejects_empty_id() -> None:
    with pytest.raises(LibraryValidationError) as exc_info:
        validate_library(_spec(library_id=""))
    assert exc_info.value.http_status == 400


def test_rejects_empty_version() -> None:
    with pytest.raises(LibraryValidationError) as exc_info:
        validate_library(_spec(version=""))
    assert exc_info.value.http_status == 400


# ── files[] bounds (400) ───────────────────────────────────────────────────


def test_rejects_empty_files_list() -> None:
    with pytest.raises(LibraryValidationError) as exc_info:
        validate_library(_spec(files=[]))
    assert exc_info.value.http_status == 400


def test_rejects_duplicate_paths() -> None:
    with pytest.raises(LibraryValidationError) as exc_info:
        validate_library(
            _spec(files=[("TestLib.h", "#pragma once\n"), ("TestLib.h", "x")])
        )
    assert "duplicate" in exc_info.value.reason.lower()
    assert exc_info.value.http_status == 400


# ── path safety (400) ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "bad_path",
    [
        "../etc/passwd",
        "/etc/passwd",
        "\\Windows\\System32\\evil.h",
        "src/../../escape.h",
        "src//double-slash.h",  # empty segment from `//`
        "src/has space.h",
        "src/has?question.h",
    ],
)
def test_rejects_unsafe_paths(bad_path: str) -> None:
    with pytest.raises(LibraryValidationError) as exc_info:
        validate_library(_spec(files=[(bad_path, "#pragma once\n")]))
    assert exc_info.value.http_status == 400


def test_rejects_path_depth_over_cap() -> None:
    # 9 segments — one over the depth cap of 8
    deep = "/".join(["dir"] * 9) + ".h"
    with pytest.raises(LibraryValidationError) as exc_info:
        validate_library(_spec(files=[(deep, "#pragma once\n")]))
    assert exc_info.value.http_status == 400


def test_rejects_unknown_extension() -> None:
    with pytest.raises(LibraryValidationError) as exc_info:
        validate_library(_spec(files=[("Suspect.exe", "binary")]))
    assert exc_info.value.http_status == 400


# ── preprocessor scan (400) ────────────────────────────────────────────────


def test_rejects_include_with_dotdot_quoted() -> None:
    bad = '#include "../etc/passwd"\n'
    with pytest.raises(LibraryValidationError) as exc_info:
        validate_library(_spec(files=[("Header.h", bad)]))
    assert exc_info.value.http_status == 400


def test_rejects_include_with_dotdot_angle() -> None:
    bad = "#include <../escape.h>\n"
    with pytest.raises(LibraryValidationError) as exc_info:
        validate_library(_spec(files=[("Header.h", bad)]))
    assert exc_info.value.http_status == 400


def test_rejects_include_with_absolute_quoted_path() -> None:
    bad = '#include "/etc/shadow"\n'
    with pytest.raises(LibraryValidationError) as exc_info:
        validate_library(_spec(files=[("Header.h", bad)]))
    assert exc_info.value.http_status == 400


def test_rejects_unknown_pragma() -> None:
    bad = "#pragma sketchy_directive on\nvoid f();\n"
    with pytest.raises(LibraryValidationError) as exc_info:
        validate_library(_spec(files=[("Header.h", bad)]))
    assert exc_info.value.http_status == 400


def test_tolerates_define_and_if_directives() -> None:
    content = (
        "#pragma once\n"
        "#define TESTLIB_OK 1\n"
        "#ifndef ARDUINO\n"
        "#error build only on Arduino\n"
        "#endif\n"
        "void f();\n"
    )
    validate_library(_spec(files=[("Header.h", content)]))


# ── size caps (413 — Payload Too Large) ────────────────────────────────────


def test_rejects_oversized_single_file() -> None:
    huge = "/" * (LIBRARY_MAX_FILE_BYTES + 1)
    with pytest.raises(LibraryValidationError) as exc_info:
        validate_library(_spec(files=[("Header.h", huge)]))
    assert exc_info.value.http_status == 413


def test_rejects_total_bytes_over_cap() -> None:
    # Five files at the per-file cap = 2_621_440 bytes > 2 MB total cap.
    # Each individual file stays at the per-file ceiling, so only the
    # running-total guard can trip — exactly what we want to assert.
    chunk = "x" * LIBRARY_MAX_FILE_BYTES
    files = [(f"f{i}.h", chunk) for i in range(5)]
    total = sum(len(c) for _, c in files)
    assert total > LIBRARY_MAX_TOTAL_BYTES
    with pytest.raises(LibraryValidationError) as exc_info:
        validate_library(_spec(files=files))
    assert exc_info.value.http_status == 413


# ── batch behaviour ────────────────────────────────────────────────────────


def test_batch_rejects_duplicate_ids() -> None:
    with pytest.raises(LibraryValidationError) as exc_info:
        validate_libraries([_spec(library_id="DupLib"), _spec(library_id="DupLib")])
    assert "duplicate" in exc_info.value.reason.lower()
    assert exc_info.value.http_status == 400


def test_batch_returns_specs_in_order() -> None:
    specs = [_spec(library_id="A"), _spec(library_id="B"), _spec(library_id="C")]
    out = validate_libraries(specs)
    assert [s.id for s in out] == ["A", "B", "C"]


def test_batch_first_failure_short_circuits() -> None:
    with pytest.raises(LibraryValidationError) as exc_info:
        validate_libraries(
            [
                _spec(library_id="Good"),
                _spec(library_id="Bad", files=[("../escape.h", "x")]),
                _spec(library_id="NeverReached"),
            ]
        )
    assert exc_info.value.library_id == "Bad"


# ── error metadata ─────────────────────────────────────────────────────────


def test_error_carries_library_id_and_reason() -> None:
    with pytest.raises(LibraryValidationError) as exc_info:
        validate_library(_spec(library_id="NamedLib", files=[("../bad.h", "x")]))
    assert exc_info.value.library_id == "NamedLib"
    assert "safe relative path" in exc_info.value.reason.lower()
