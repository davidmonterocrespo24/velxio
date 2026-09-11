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


# ── review follow-ups (2026-09-12): each one a finding the seams review raised ─

def test_wokwi_specs_resolve_by_base_name_and_pins_are_kept():
    specs = compile_route._manifest_specs(["Servo@wokwi:abc123", "ArduinoJson@6.21.5", "  "])
    assert specs == {"Servo", "ArduinoJson@6.21.5"}


def test_a_refusal_never_comes_back_as_2xx(monkeypatch):
    async def _rec(**kw):
        pass

    monkeypatch.setattr(hooks, "_record_compile_hook", _rec)
    monkeypatch.setattr(hooks, "_compile_admission_hook", lambda **kw: {"refuse": {"error": "no"}, "http_status": 200})
    req = compile_route.CompileRequest(files=None, code="x", board_fqbn="arduino:avr:uno")
    _, _, _, refusal = asyncio.run(compile_route._admit_compile(req, FILES, None, None, None))
    assert refusal.status_code == 422


def test_scope_retry_means_the_retry_ran_not_a_scan_all_merge():
    # A plain scan-all build reports manifest_incomplete so the client can
    # suggest a manifest; that is not a retry.
    assert compile_route._scope_of({"manifest_incomplete": True}) is None
    assert compile_route._scope_of({"scope_retry_failed": True})["scope_retry"] is True
    assert compile_route._scope_of({"scope_kind": "lock", "lock_sha": "abc"}) == {"scope_kind": "lock", "lock_sha": "abc"}


def test_health_does_not_mutate_a_shared_probe_dict(monkeypatch):
    shared = {"status": "degraded", "overlay": "pro", "http_status": 503}
    monkeypatch.setattr(hooks, "_health_probe_hook", lambda: shared)
    assert app_main.health_check().status_code == 503
    assert app_main.health_check().status_code == 503, "the second request must see the same status"
    assert shared["http_status"] == 503


def test_effective_scope_rules():
    from app.services.espidf_compiler import effective_scope

    assert effective_scope(None, None) is None, "no manifest: scan-all"
    assert effective_scope(set(), None) is None, "empty manifest, nothing materialised: scan-all as before"
    assert effective_scope({"A"}, None) == {"A"}, "manifest, nothing materialised: the names filter"
    assert effective_scope({"A"}, (Path("/tmp/x"), "tok")) == {"A"}, "2-tuple overlay: names only"
    assert effective_scope({"A"}, (Path("/tmp/x"), "tok", {"closure_names": ["A", "BusIO"]})) == {"A", "BusIO"}, "the closure is admitted"
    assert effective_scope(set(), (Path("/tmp/x"), "closed", {"closure_names": []})) == set(), "an overlay-closed empty scope stays closed"


def test_arduino_cli_closed_scope_reports_the_missing_headers(monkeypatch, tmp_path):
    import subprocess
    from app.services.arduino_cli import ArduinoCLIService

    scope = tmp_path / "sketchbook" / "libraries"
    scope.mkdir(parents=True)
    monkeypatch.setattr(hooks, "_materialize_library_scope_hook", lambda allowed, owner: (scope, "tok"))
    calls = []

    def _run(cmd, *a, **kw):
        calls.append(cmd)

        class R:
            returncode = 1
            stdout = ""
            stderr = "sketch.ino:1:10: fatal error: Adafruit_GFX.h: No such file or directory\n"

        return R()

    monkeypatch.setattr(subprocess, "run", _run)
    svc = ArduinoCLIService()
    monkeypatch.setattr(svc, "ensure_core_for_board", lambda *a, **k: asyncio.sleep(0, result={"needed": False}))
    token = hooks.scope_retry_allowed.set(False)
    try:
        result = asyncio.run(svc.compile([{"name": "sketch.ino", "content": "#include <Adafruit_GFX.h>"}], "arduino:avr:uno", allowed_libraries={"X"}, owner_id=None))
    finally:
        hooks.scope_retry_allowed.reset(token)
    assert result["success"] is False
    assert result["gallery_scope_miss"] == ["Adafruit_GFX.h"]
    assert len([c for c in calls if "compile" in c]) == 1, "no scan-all retry under a closed scope"
