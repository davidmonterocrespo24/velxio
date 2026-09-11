"""The scope report seam: an overlay's materialiser may return a third
element describing HOW the manifest resolved; the hook wrapper parks it in
the `scope_stats` context variable and the compile route's `_scope_of`
copies the known keys into the compile row, the result's own keys winning.
OSS registers nothing, so the variable stays None and nothing changes."""
from __future__ import annotations

from pathlib import Path

from app.core import hooks


def _reset(monkeypatch):
    monkeypatch.setattr(hooks, "_materialize_library_scope_hook", None)
    hooks.scope_stats.set(None)


def test_two_element_tuple_leaves_the_report_unset(monkeypatch, tmp_path):
    _reset(monkeypatch)
    hooks.register_materialize_library_scope(lambda allowed, owner: (tmp_path, "tok"))
    assert hooks.materialize_library_scope({"X"}, None) == (tmp_path, "tok")
    assert hooks.scope_stats.get() is None


def test_three_element_tuple_parks_the_report(monkeypatch, tmp_path):
    _reset(monkeypatch)
    report = {"scope_kind": "scoped", "locked_miss": ["x@1-abc"], "lock_sha": "deadbeef0000", "tokens": ["a"]}
    hooks.register_materialize_library_scope(lambda allowed, owner: (tmp_path, "tok", report))
    scope = hooks.materialize_library_scope({"X"}, "owner")
    assert scope[0] == tmp_path and scope[2] is report
    assert hooks.scope_stats.get() is report


def test_scope_of_merges_report_and_result(monkeypatch):
    from app.api.routes.compile import _scope_of

    _reset(monkeypatch)
    hooks.scope_stats.set({"scope_kind": "scoped", "lock_sha": "abc", "pinned_miss": [], "tokens": ["ignored"]})
    out = _scope_of({"scope_kind": "closed", "scope_retry_failed": True})
    assert out == {"scope_kind": "closed", "lock_sha": "abc", "scope_retry": True}
    hooks.scope_stats.set(None)
    assert _scope_of({}) is None


def test_no_manifest_never_calls_the_hook(monkeypatch, tmp_path):
    _reset(monkeypatch)
    calls: list = []
    hooks.register_materialize_library_scope(lambda allowed, owner: calls.append(allowed) or (tmp_path, "t", {"scope_kind": "scoped"}))
    assert hooks.materialize_library_scope(None, None) is None
    assert calls == [] and hooks.scope_stats.get() is None
    assert Path(tmp_path).is_dir()
