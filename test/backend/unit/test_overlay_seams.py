"""
The seams the pro overlay plugs into (project/gallery-libraries-2026-09,
P2.OSS-hooks). Every one has a default that reproduces the behaviour before
the seam existed, and every one applies the overlay's decision when a hook is
registered. Nothing here knows a rule; the rules live in the overlay.
"""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest

from app.core import hooks  # noqa: E402
from app.api.routes import compile as compile_route  # noqa: E402
from app import main as app_main  # noqa: E402


FILES = [{"name": "sketch.ino", "content": "void setup(){} void loop(){}"}]


# ── the manifest is three-state and keeps its pins ───────────────────────────

def test_manifest_specs_three_state():
    assert compile_route._manifest_specs(None) is None
    assert compile_route._manifest_specs([]) == set()
    assert compile_route._manifest_specs(["DHT sensor library@1.4.4", " Adafruit BusIO ", ""]) == {
        "DHT sensor library@1.4.4", "Adafruit BusIO",
    }


def test_empty_manifest_reaches_the_materialiser_none_does_not(monkeypatch):
    seen = []
    monkeypatch.setattr(hooks, "_materialize_library_scope_hook", lambda allowed, owner: seen.append(allowed) or None)
    assert hooks.materialize_library_scope(None, None) is None
    assert seen == []
    hooks.materialize_library_scope(set(), None)
    assert seen == [set()]


# ── the job key follows the overlay's fingerprint when there is one ──────────

def test_job_key_hashes_the_fingerprint_instead_of_names():
    k = compile_route._job_key
    a = k(FILES, "esp32:esp32:esp32", libraries=["A"], owner_id="u1", scope_fingerprint="fp-1")
    b = k(FILES, "esp32:esp32:esp32", libraries=["B"], owner_id="u2", scope_fingerprint="fp-1")
    c = k(FILES, "esp32:esp32:esp32", libraries=["A"], owner_id="u1", scope_fingerprint="fp-2")
    assert a == b, "same resolved bytes -> one build, whatever the names or the owner"
    assert a != c, "different resolved bytes -> different build"
    # No fingerprint (OSS): the names still matter, as before.
    assert k(FILES, "esp32:esp32:esp32", libraries=["A"]) != k(FILES, "esp32:esp32:esp32", libraries=["B"])


# ── admission: default admits as-is; a refusal is a CompileResult-shaped body ─

def test_admission_default_is_a_no_op(monkeypatch):
    monkeypatch.setattr(hooks, "_compile_admission_hook", None)
    req = compile_route.CompileRequest(files=None, code="void setup(){}", board_fqbn="arduino:avr:uno")
    allowed, retry, gallery, refusal = asyncio.run(
        compile_route._admit_compile(req, FILES, {"X"}, "owner", "user")
    )
    assert (allowed, retry, gallery, refusal) == ({"X"}, True, None, None)


def test_admission_refusal_is_recorded_and_shaped_for_the_client(monkeypatch):
    recorded = []

    async def _rec(**kw):
        recorded.append(kw)

    monkeypatch.setattr(hooks, "_record_compile_hook", _rec)
    monkeypatch.setattr(
        hooks, "_compile_admission_hook",
        lambda **kw: {
            "refuse": {"error": "DHT.h is provided by two libraries", "ambiguous_headers": {"DHT.h": ["a", "b"]}},
            "http_status": 422, "error_kind": "ambiguous_header",
        },
    )
    req = compile_route.CompileRequest(files=None, code="x", board_fqbn="esp32:esp32:esp32", example_id="ex")
    _, _, _, refusal = asyncio.run(compile_route._admit_compile(req, FILES, {"a", "b"}, None, "user"))
    assert refusal is not None and refusal.status_code == 422
    body = json.loads(refusal.body)
    assert body["success"] is False and body["stderr"] == ""
    assert body["error"].startswith("DHT.h")
    assert body["ambiguous_headers"] == {"DHT.h": ["a", "b"]}
    assert recorded and recorded[0]["error_kind"] == "ambiguous_header"
    assert recorded[0]["extra"]["refused"] is True and recorded[0]["extra"]["example_id"] == "ex"


def test_admission_can_rewrite_the_scope_and_close_the_retry(monkeypatch):
    monkeypatch.setattr(
        hooks, "_compile_admission_hook",
        lambda **kw: {"allowed_libraries": {"Lock A", "Lock B"}, "retry_allowed": False,
                      "gallery": {"example_id": kw["example_id"], "unmodified": True, "reason": "subset"}},
    )
    req = compile_route.CompileRequest(files=None, code="x", board_fqbn="esp32:esp32:esp32", example_id="ex")
    allowed, retry, gallery, refusal = asyncio.run(compile_route._admit_compile(req, FILES, None, None, None))
    assert refusal is None
    assert allowed == {"Lock A", "Lock B"} and retry is False
    assert gallery == {"example_id": "ex", "unmodified": True, "reason": "subset"}


def test_a_broken_admission_hook_admits_as_is(monkeypatch):
    def _boom(**kw):
        raise RuntimeError("overlay bug")

    monkeypatch.setattr(hooks, "_compile_admission_hook", _boom)
    assert hooks.compile_admission(files=FILES, board_fqbn="x", example_id=None, client_manifest=None,
                                   allowed_libraries=None, owner_id=None, requester_id=None) is None


# ── the retry flag is a context variable, default on ─────────────────────────

def test_scope_retry_allowed_defaults_to_true():
    assert hooks.scope_retry_allowed.get() is True


# ── /health: one word on OSS, the probe's payload and status with an overlay ─

def test_health_default_is_unchanged(monkeypatch):
    monkeypatch.setattr(hooks, "_health_probe_hook", None)
    assert app_main.health_check() == {"status": "healthy"}


def test_health_reports_the_probe_and_its_status(monkeypatch):
    monkeypatch.setattr(
        hooks, "_health_probe_hook",
        lambda: {"status": "degraded", "overlay": "pro", "libraries": {"ok": False, "since": 1.0}, "http_status": 503},
    )
    resp = app_main.health_check()
    assert resp.status_code == 503
    body = json.loads(resp.body)
    assert body == {"status": "degraded", "overlay": "pro", "libraries": {"ok": False, "since": 1.0}}


def test_a_probe_that_throws_reads_as_not_ready(monkeypatch):
    def _boom():
        raise RuntimeError("seed state unreadable")

    monkeypatch.setattr(hooks, "_health_probe_hook", _boom)
    assert app_main.health_check().status_code == 503


def test_health_libcache_default(monkeypatch):
    monkeypatch.setattr(hooks, "_health_detail_hook", None)
    assert app_main.health_libcache() == {"status": "healthy", "overlay": "oss"}


# ── compile_priority: the request reaches a new-style hook, old hooks still work ─

def test_compile_priority_passes_the_request_and_tolerates_old_hooks(monkeypatch):
    calls = []

    async def new_style(user_id, request):
        calls.append(("new", user_id, request))
        return {"priority": 5, "tier": "batch"}

    async def old_style(user_id):
        calls.append(("old", user_id))
        return {"priority": 0, "tier": "pro"}

    monkeypatch.setattr(hooks, "_compile_priority_hook", new_style)
    assert asyncio.run(hooks.compile_priority("u", "REQ")) == {"priority": 5, "tier": "batch"}
    monkeypatch.setattr(hooks, "_compile_priority_hook", old_style)
    assert asyncio.run(hooks.compile_priority("u", "REQ")) == {"priority": 0, "tier": "pro"}
    assert calls == [("new", "u", "REQ"), ("old", "u")]


# ── uninstall: the overlay answers first; None falls back to arduino-cli ─────

def test_uninstall_default_is_none(monkeypatch):
    monkeypatch.setattr(hooks, "_uninstall_library_hook", None)
    assert asyncio.run(hooks.uninstall_library("X", "u")) is None


def test_uninstall_overlay_answer_wins(monkeypatch):
    async def _hook(name, requester):
        return {"success": False, "error": f"{name} is shared; nothing to remove"}

    monkeypatch.setattr(hooks, "_uninstall_library_hook", _hook)
    assert asyncio.run(hooks.uninstall_library("DHT", "u"))["error"].startswith("DHT is shared")


# ── the artifact cache ages from built_at, not from the last read ────────────

def test_artifact_ages_from_built_at(tmp_path, monkeypatch):
    monkeypatch.setattr(compile_route, "ARTIFACT_CACHE_DIR", tmp_path)
    monkeypatch.setattr(compile_route, "ARTIFACT_CACHE_MAX_AGE_S", 100)
    old = tmp_path / "old.json"
    old.write_text(json.dumps({"success": True, "built_at": time.time() - 1000}))
    assert compile_route._artifact_load("old") is None and not old.exists()
    fresh = tmp_path / "fresh.json"
    fresh.write_text(json.dumps({"success": True, "built_at": time.time() - 10}))
    assert compile_route._artifact_load("fresh")["success"] is True
    # A read must not rejuvenate it: built_at is what ages it.
    assert compile_route._artifact_load("fresh")["built_at"] < time.time() - 5
    legacy = tmp_path / "legacy.json"
    legacy.write_text(json.dumps({"success": True}))
    assert compile_route._artifact_load("legacy") == {"success": True}


def test_artifact_store_stamps_built_at(tmp_path, monkeypatch):
    monkeypatch.setattr(compile_route, "ARTIFACT_CACHE_DIR", tmp_path)
    compile_route._artifact_store_sync("k", {"success": True, "stdout": "log", "hex_content": "x"})
    data = json.loads((tmp_path / "k.json").read_text())
    assert abs(data["built_at"] - time.time()) < 5
