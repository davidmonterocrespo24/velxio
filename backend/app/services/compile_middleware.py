"""Backend-side compile middleware chain.

The chain transforms the sketch files list before arduino-cli runs and
observes the compile output afterwards. Built-in transforms (like the
RP2040 ``Serial → Serial1`` redirect) live here so plugins can see the
contract they'll eventually consume.

Two hooks per middleware:

* ``before_compile(req) -> req`` runs in registration order. Each middleware
  receives the (possibly transformed) request and returns the next one.
  A throwing middleware aborts the chain — the exception surfaces as a
  compile failure.
* ``after_compile(req, result) -> result`` runs in **reverse** registration
  order (LIFO). It's observe-only — exceptions are logged and swallowed,
  never propagated. Timeouts are enforced per-middleware.

Middlewares are NOT exposed to third-party plugins yet. Plugin authors
will interact with the client-tier middleware (``@velxio/sdk``) until the
server-side sandbox ships (see task PRO-001+).
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

logger = logging.getLogger(__name__)

MIDDLEWARE_TIMEOUT_S = 5.0


@dataclass
class CompileRequestPayload:
    """Mutable bag that middlewares transform."""

    files: list[dict[str, str]]
    board_fqbn: str
    notes: list[str] = field(default_factory=list)


@dataclass
class CompileResultPayload:
    """What middlewares observe after the compile finishes."""

    success: bool
    hex_content: str | None
    stdout: str
    stderr: str
    error: str | None
    duration_ms: float


@runtime_checkable
class CompileMiddleware(Protocol):
    """Server-side middleware contract.

    Implementations must be side-effect free outside of the request payload.
    The ``name`` field is used for logging and for uniqueness enforcement in
    the registry (duplicate registration raises).
    """

    name: str

    async def before_compile(
        self, req: CompileRequestPayload
    ) -> CompileRequestPayload: ...

    async def after_compile(
        self,
        req: CompileRequestPayload,
        result: CompileResultPayload,
    ) -> CompileResultPayload: ...


class CompileMiddlewareRegistry:
    """Process-wide registry of compile middlewares.

    Thread-safety note: arduino-cli compiles run inside the FastAPI event
    loop, so registration happens at import time and mutation from request
    handlers is not supported (and not needed).
    """

    def __init__(self) -> None:
        self._middlewares: list[CompileMiddleware] = []

    def register(self, middleware: CompileMiddleware) -> None:
        if any(m.name == middleware.name for m in self._middlewares):
            raise ValueError(
                f"CompileMiddleware already registered: {middleware.name!r}"
            )
        self._middlewares.append(middleware)

    def unregister(self, name: str) -> bool:
        for i, m in enumerate(self._middlewares):
            if m.name == name:
                del self._middlewares[i]
                return True
        return False

    def names(self) -> list[str]:
        return [m.name for m in self._middlewares]

    def __len__(self) -> int:
        return len(self._middlewares)

    async def run_before(
        self, req: CompileRequestPayload
    ) -> CompileRequestPayload:
        current = req
        for middleware in self._middlewares:
            try:
                current = await asyncio.wait_for(
                    middleware.before_compile(current),
                    timeout=MIDDLEWARE_TIMEOUT_S,
                )
            except asyncio.TimeoutError:
                logger.error(
                    "[compile] before_compile(%s) timed out after %ss — aborting",
                    middleware.name,
                    MIDDLEWARE_TIMEOUT_S,
                )
                raise
            except Exception:
                logger.exception(
                    "[compile] before_compile(%s) raised — aborting",
                    middleware.name,
                )
                raise
        return current

    async def run_after(
        self,
        req: CompileRequestPayload,
        result: CompileResultPayload,
    ) -> CompileResultPayload:
        current = result
        for middleware in reversed(self._middlewares):
            try:
                current = await asyncio.wait_for(
                    middleware.after_compile(req, current),
                    timeout=MIDDLEWARE_TIMEOUT_S,
                )
            except asyncio.TimeoutError:
                logger.warning(
                    "[compile] after_compile(%s) timed out — skipped",
                    middleware.name,
                )
            except Exception:
                logger.exception(
                    "[compile] after_compile(%s) raised — skipped",
                    middleware.name,
                )
        return current


# ── Built-in middlewares ───────────────────────────────────────────────────


class Rp2040SerialRedirectMiddleware:
    """Rewrites the main sketch so ``Serial`` refers to ``Serial1`` on RP2040.

    The Arduino-Pico core exposes the USB CDC port as ``Serial`` and the
    UART0 pins as ``Serial1``. Velxio wires RP2040 emulation to UART0, so
    the redirect makes user sketches talk to the emulator-visible pins
    without forcing authors to know the difference.
    """

    name = "builtin.rp2040-serial-redirect"

    async def before_compile(
        self, req: CompileRequestPayload
    ) -> CompileRequestPayload:
        if "rp2040" not in req.board_fqbn:
            return req
        has_sketch_ino = any(f["name"] == "sketch.ino" for f in req.files)
        new_files: list[dict[str, str]] = []
        promoted = False
        for entry in req.files:
            name = entry["name"]
            content = entry["content"]
            target_name = name
            if (
                not has_sketch_ino
                and name.endswith(".ino")
                and not promoted
            ):
                target_name = "sketch.ino"
                promoted = True
            if target_name == "sketch.ino":
                content = "#define Serial Serial1\n" + content
            new_files.append({"name": target_name, "content": content})
        return CompileRequestPayload(
            files=new_files,
            board_fqbn=req.board_fqbn,
            notes=[*req.notes, "rp2040: redirected Serial → Serial1"],
        )

    async def after_compile(
        self,
        req: CompileRequestPayload,  # noqa: ARG002 — middleware contract
        result: CompileResultPayload,
    ) -> CompileResultPayload:
        return result


# ── Singleton + bootstrap ──────────────────────────────────────────────────

_registry: CompileMiddlewareRegistry | None = None


def get_compile_middleware_registry() -> CompileMiddlewareRegistry:
    global _registry
    if _registry is None:
        reg = CompileMiddlewareRegistry()
        reg.register(Rp2040SerialRedirectMiddleware())
        _registry = reg
    return _registry


def reset_compile_middleware_registry_for_tests() -> None:
    """Pytest helper — clears process state between tests."""

    global _registry
    _registry = None
