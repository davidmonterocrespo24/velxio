"""Tests for the server-side compile middleware chain.

The chain has two halves with different contracts:

* ``run_before`` is fail-fast — a throwing or timing-out middleware aborts
  the compile and the exception bubbles to the caller.
* ``run_after`` is observe-only — exceptions and timeouts inside individual
  middlewares are swallowed so a buggy plugin can never corrupt a compile
  response.

We avoid ``pytest-asyncio`` because the project doesn't depend on it; each
test wraps its async body in ``asyncio.run`` instead.
"""

from __future__ import annotations

import asyncio

import pytest

from app.services.compile_middleware import (
    CompileMiddlewareRegistry,
    CompileRequestPayload,
    CompileResultPayload,
    Rp2040SerialRedirectMiddleware,
    get_compile_middleware_registry,
    reset_compile_middleware_registry_for_tests,
)


# ── Helpers ────────────────────────────────────────────────────────────────


def _run(coro):
    """Run an async test body without pytest-asyncio."""
    return asyncio.run(coro)


def _empty_request(board: str = "arduino:avr:uno") -> CompileRequestPayload:
    return CompileRequestPayload(files=[], board_fqbn=board)


def _empty_result() -> CompileResultPayload:
    return CompileResultPayload(
        success=True,
        hex_content=":00000001FF",
        stdout="",
        stderr="",
        error=None,
        duration_ms=0.0,
    )


class _RecordingMiddleware:
    """Records call order without mutating the payload."""

    def __init__(self, name: str, log: list[str]) -> None:
        self.name = name
        self._log = log

    async def before_compile(self, req: CompileRequestPayload) -> CompileRequestPayload:
        self._log.append(f"before:{self.name}")
        return req

    async def after_compile(
        self, req: CompileRequestPayload, result: CompileResultPayload
    ) -> CompileResultPayload:
        self._log.append(f"after:{self.name}")
        return result


class _AppendNoteMiddleware:
    """Appends a note to the request — useful for verifying transforms run."""

    def __init__(self, name: str, note: str) -> None:
        self.name = name
        self._note = note

    async def before_compile(self, req: CompileRequestPayload) -> CompileRequestPayload:
        return CompileRequestPayload(
            files=req.files,
            board_fqbn=req.board_fqbn,
            notes=[*req.notes, self._note],
        )

    async def after_compile(
        self, req: CompileRequestPayload, result: CompileResultPayload
    ) -> CompileResultPayload:
        return result


class _RaisingBefore:
    name = "raises-before"

    async def before_compile(self, req: CompileRequestPayload) -> CompileRequestPayload:
        raise RuntimeError("boom-before")

    async def after_compile(
        self, req: CompileRequestPayload, result: CompileResultPayload
    ) -> CompileResultPayload:
        return result


class _RaisingAfter:
    name = "raises-after"

    async def before_compile(self, req: CompileRequestPayload) -> CompileRequestPayload:
        return req

    async def after_compile(
        self, req: CompileRequestPayload, result: CompileResultPayload
    ) -> CompileResultPayload:
        raise RuntimeError("boom-after")


class _SlowMiddleware:
    """Sleeps longer than the registry's per-middleware timeout."""

    def __init__(self, name: str = "slow") -> None:
        self.name = name

    async def before_compile(self, req: CompileRequestPayload) -> CompileRequestPayload:
        await asyncio.sleep(60)
        return req

    async def after_compile(
        self, req: CompileRequestPayload, result: CompileResultPayload
    ) -> CompileResultPayload:
        await asyncio.sleep(60)
        return result


# ── Registry mechanics ─────────────────────────────────────────────────────


def test_register_rejects_duplicate_names():
    reg = CompileMiddlewareRegistry()
    a = _RecordingMiddleware("dup", [])
    b = _RecordingMiddleware("dup", [])
    reg.register(a)
    with pytest.raises(ValueError, match="dup"):
        reg.register(b)


def test_unregister_removes_and_returns_bool():
    reg = CompileMiddlewareRegistry()
    reg.register(_RecordingMiddleware("a", []))
    assert reg.unregister("a") is True
    assert reg.unregister("a") is False
    assert reg.names() == []


def test_len_and_names_track_registry_state():
    reg = CompileMiddlewareRegistry()
    assert len(reg) == 0
    reg.register(_RecordingMiddleware("a", []))
    reg.register(_RecordingMiddleware("b", []))
    assert len(reg) == 2
    assert reg.names() == ["a", "b"]


# ── before_compile semantics ───────────────────────────────────────────────


def test_run_before_runs_middlewares_in_registration_order():
    log: list[str] = []
    reg = CompileMiddlewareRegistry()
    reg.register(_AppendNoteMiddleware("first", "n1"))
    reg.register(_AppendNoteMiddleware("second", "n2"))
    reg.register(_RecordingMiddleware("recorder", log))

    out = _run(reg.run_before(_empty_request()))

    assert out.notes == ["n1", "n2"]
    assert log == ["before:recorder"]


def test_run_before_propagates_middleware_exceptions():
    reg = CompileMiddlewareRegistry()
    reg.register(_RaisingBefore())
    downstream = _RecordingMiddleware("downstream", [])
    reg.register(downstream)

    with pytest.raises(RuntimeError, match="boom-before"):
        _run(reg.run_before(_empty_request()))


def test_run_before_aborts_on_timeout(monkeypatch):
    """A middleware that exceeds the timeout must raise asyncio.TimeoutError."""
    monkeypatch.setattr(
        "app.services.compile_middleware.MIDDLEWARE_TIMEOUT_S", 0.05
    )
    reg = CompileMiddlewareRegistry()
    reg.register(_SlowMiddleware())

    with pytest.raises(asyncio.TimeoutError):
        _run(reg.run_before(_empty_request()))


# ── after_compile semantics ────────────────────────────────────────────────


def test_run_after_runs_in_reverse_registration_order():
    log: list[str] = []
    reg = CompileMiddlewareRegistry()
    reg.register(_RecordingMiddleware("a", log))
    reg.register(_RecordingMiddleware("b", log))
    reg.register(_RecordingMiddleware("c", log))

    _run(reg.run_after(_empty_request(), _empty_result()))

    assert log == ["after:c", "after:b", "after:a"]


def test_run_after_swallows_middleware_exceptions():
    reg = CompileMiddlewareRegistry()
    log: list[str] = []
    # Register the raising one first so that with reverse order the recorder
    # runs after it. This proves the chain keeps going past a thrower.
    reg.register(_RecordingMiddleware("recorder", log))
    reg.register(_RaisingAfter())

    out = _run(reg.run_after(_empty_request(), _empty_result()))

    assert out.success is True
    assert log == ["after:recorder"]


def test_run_after_swallows_timeouts(monkeypatch):
    monkeypatch.setattr(
        "app.services.compile_middleware.MIDDLEWARE_TIMEOUT_S", 0.05
    )
    reg = CompileMiddlewareRegistry()
    log: list[str] = []
    reg.register(_RecordingMiddleware("recorder", log))
    reg.register(_SlowMiddleware())

    # Should resolve, not raise, even though the slow middleware times out.
    out = _run(reg.run_after(_empty_request(), _empty_result()))
    assert out.success is True
    # Recorder still runs (slow registered after recorder, reverse order
    # means slow runs first then times out, then recorder runs).
    assert log == ["after:recorder"]


# ── Built-in: Rp2040SerialRedirectMiddleware ───────────────────────────────


def test_rp2040_redirect_skips_non_rp2040_boards():
    mw = Rp2040SerialRedirectMiddleware()
    req = CompileRequestPayload(
        files=[{"name": "sketch.ino", "content": "void setup(){}"}],
        board_fqbn="arduino:avr:uno",
    )

    out = _run(mw.before_compile(req))

    assert out is req  # unchanged passthrough
    assert out.files[0]["content"] == "void setup(){}"


def test_rp2040_redirect_prepends_define_for_rp2040_boards():
    mw = Rp2040SerialRedirectMiddleware()
    req = CompileRequestPayload(
        files=[{"name": "sketch.ino", "content": "void setup(){}"}],
        board_fqbn="rp2040:rp2040:rpipico",
    )

    out = _run(mw.before_compile(req))

    assert out.files[0]["content"].startswith("#define Serial Serial1\n")
    assert "rp2040: redirected Serial → Serial1" in out.notes


def test_rp2040_redirect_promotes_first_ino_when_no_sketch_ino():
    mw = Rp2040SerialRedirectMiddleware()
    req = CompileRequestPayload(
        files=[
            {"name": "main.ino", "content": "void setup(){}"},
            {"name": "helper.ino", "content": "void helper(){}"},
        ],
        board_fqbn="rp2040:rp2040:rpipico",
    )

    out = _run(mw.before_compile(req))

    # First .ino is promoted to sketch.ino and gets the define
    assert out.files[0]["name"] == "sketch.ino"
    assert out.files[0]["content"].startswith("#define Serial Serial1\n")
    # Second .ino keeps its name and stays untouched
    assert out.files[1]["name"] == "helper.ino"
    assert out.files[1]["content"] == "void helper(){}"


def test_rp2040_redirect_after_is_noop():
    mw = Rp2040SerialRedirectMiddleware()
    req = _empty_request("rp2040:rp2040:rpipico")
    result = _empty_result()

    out = _run(mw.after_compile(req, result))

    assert out is result


# ── Singleton bootstrap ────────────────────────────────────────────────────


def test_singleton_registers_rp2040_builtin_by_default():
    reset_compile_middleware_registry_for_tests()
    reg = get_compile_middleware_registry()
    assert "builtin.rp2040-serial-redirect" in reg.names()


def test_singleton_returns_same_instance_until_reset():
    reset_compile_middleware_registry_for_tests()
    a = get_compile_middleware_registry()
    b = get_compile_middleware_registry()
    assert a is b
    reset_compile_middleware_registry_for_tests()
    c = get_compile_middleware_registry()
    assert c is not a
