"""End-to-end test of the ``POST /api/compile/`` route's library handling.

The route is the meeting point of:
* Pydantic structural validation (``CompileRequest`` shape and bounds)
* Server-side ``library_validation`` rules (per the SDK contract)
* The ``arduino_cli.compile`` invocation (which actually mounts the
  libraries under ``<sketch_dir>/libraries/<id>/...`` and shells out to
  arduino-cli — replaced here by a stub)

We test the route, not the validator, because the route is where the
HTTP status mapping (400 / 413 / 500) lives. The validator is unit-
tested separately in ``test_library_validation.py``.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import compile as compile_route
from app.services.library_validation import LIBRARY_MAX_FILE_BYTES


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """Build a minimal FastAPI app with only the compile router mounted.

    We replace the arduino-cli wrapper with a stub so the test never
    shells out — its job is to assert the route's wiring (validation,
    forwarding of libraries, status codes), not the build pipeline.
    """
    captured: dict[str, Any] = {}

    async def fake_ensure_core_for_board(_fqbn: str) -> dict[str, Any]:
        return {"needed": False, "installed": True, "core_id": None, "log": ""}

    async def fake_compile(
        files: list[dict],
        board_fqbn: str,
        libraries: list[dict] | None = None,
    ) -> dict[str, Any]:
        captured["files"] = files
        captured["board_fqbn"] = board_fqbn
        captured["libraries"] = libraries
        return {
            "success": True,
            "hex_content": ":00000001FF\n",
            "stdout": "ok",
            "stderr": "",
        }

    monkeypatch.setattr(compile_route.arduino_cli, "ensure_core_for_board", fake_ensure_core_for_board)
    monkeypatch.setattr(compile_route.arduino_cli, "compile", fake_compile)

    app = FastAPI()
    app.include_router(compile_route.router, prefix="/api/compile")

    test_client = TestClient(app)
    test_client.captured = captured  # type: ignore[attr-defined]
    return test_client


def _valid_lib(library_id: str = "TestLib") -> dict[str, Any]:
    return {
        "id": library_id,
        "version": "1.0.0",
        "files": [
            {
                "path": "TestLib.h",
                "content": "#pragma once\nvoid noop();\n",
            }
        ],
    }


# ── Happy path ─────────────────────────────────────────────────────────────


def test_accepts_request_without_libraries(client: TestClient) -> None:
    response = client.post(
        "/api/compile/",
        json={
            "files": [{"name": "sketch.ino", "content": "void setup(){} void loop(){}"}],
            "board_fqbn": "arduino:avr:uno",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert client.captured["libraries"] == []  # type: ignore[attr-defined]


def test_forwards_validated_libraries_to_compiler(client: TestClient) -> None:
    response = client.post(
        "/api/compile/",
        json={
            "files": [{"name": "sketch.ino", "content": "void setup(){} void loop(){}"}],
            "board_fqbn": "arduino:avr:uno",
            "libraries": [_valid_lib("LibA"), _valid_lib("LibB")],
        },
    )
    assert response.status_code == 200
    forwarded = client.captured["libraries"]  # type: ignore[attr-defined]
    assert [lib["id"] for lib in forwarded] == ["LibA", "LibB"]
    assert forwarded[0]["files"][0]["path"] == "TestLib.h"


# ── Validator-driven rejections ────────────────────────────────────────────


def test_rejects_path_traversal_with_400(client: TestClient) -> None:
    bad_lib = {
        "id": "Evil",
        "version": "1.0.0",
        "files": [
            {
                "path": "../../etc/passwd",
                "content": "#pragma once\n",
            }
        ],
    }
    response = client.post(
        "/api/compile/",
        json={
            "files": [{"name": "sketch.ino", "content": "void setup(){} void loop(){}"}],
            "board_fqbn": "arduino:avr:uno",
            "libraries": [bad_lib],
        },
    )
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert "Evil" in detail
    assert "files" not in client.captured  # never reached the compiler  # type: ignore[attr-defined]


def test_rejects_oversized_library_with_413(client: TestClient) -> None:
    # One file at the per-file cap is fine; pile five of them up so the
    # running total exceeds the 2 MB total cap → must surface as 413,
    # not 400 or 500.
    huge = "x" * LIBRARY_MAX_FILE_BYTES
    big_lib = {
        "id": "Heavy",
        "version": "1.0.0",
        "files": [
            {"path": f"part{i}.h", "content": huge} for i in range(5)
        ],
    }
    response = client.post(
        "/api/compile/",
        json={
            "files": [{"name": "sketch.ino", "content": "void setup(){} void loop(){}"}],
            "board_fqbn": "arduino:avr:uno",
            "libraries": [big_lib],
        },
    )
    assert response.status_code == 413
    detail = response.json()["detail"]
    assert "Heavy" in detail


def test_rejects_pydantic_structural_violation_with_422(client: TestClient) -> None:
    """Pydantic catches obviously malformed payloads before our validator
    even sees them — verify we return 422 (FastAPI default), not 500."""
    response = client.post(
        "/api/compile/",
        json={
            "files": [{"name": "sketch.ino", "content": "void setup(){}"}],
            "board_fqbn": "arduino:avr:uno",
            "libraries": [
                {
                    "id": "MissingFiles",
                    "version": "1.0.0",
                    "files": [],  # min_length=1 on the Pydantic model
                }
            ],
        },
    )
    assert response.status_code == 422


def test_rejects_duplicate_library_ids_with_400(client: TestClient) -> None:
    response = client.post(
        "/api/compile/",
        json={
            "files": [{"name": "sketch.ino", "content": "void setup(){}"}],
            "board_fqbn": "arduino:avr:uno",
            "libraries": [_valid_lib("DupLib"), _valid_lib("DupLib")],
        },
    )
    assert response.status_code == 400
    assert "DupLib" in response.json()["detail"]
