"""
Extension hooks for the velxio backend.

Routes that stay in OSS (compile, libraries, simulation, iot_gateway) used to
import directly from `app.core.dependencies`, `app.database.session`,
`app.models.*` and `app.services.metrics`. That made the OSS image impossible
to ship without the auth/DB stack — deleting any of those modules would
crash the route layer at import time.

This module is the seam. OSS routes import only from here. Each hook is a
no-op by default; a private overlay (e.g. velxio-prod's `app.pro`) calls the
`register_*` setter inside its own `register_pro(app)` to plug in a real
implementation. When the overlay is absent, the routes still load and the
hooks just return None / yield no events.

Adding a new extension point: define a Protocol/Callable type, a module-level
slot, a `register_*` setter, and a public callable that invokes the slot if
present. Do NOT import from `app.database`, `app.models`, or `app.services` here.
"""
from __future__ import annotations

import logging
from contextvars import ContextVar
from typing import Any, Awaitable, Callable, Optional

from fastapi import Request, Response

logger = logging.getLogger(__name__)


# ── record_compile ───────────────────────────────────────────────────────────
# Fires once per compile attempt. Overlay implementations own their own DB
# session and decide what to persist. The compile route only knows about
# metadata (user_id, project_id, board fqbn, timing, error classification).

RecordCompileHook = Callable[
    ...,  # accepts the kwargs below; using ... avoids over-constraining overlays
    Awaitable[None],
]

_record_compile_hook: Optional[RecordCompileHook] = None


def register_record_compile(hook: RecordCompileHook) -> None:
    """Install the compile-metric recorder. Called by overlays in register_pro."""
    global _record_compile_hook
    _record_compile_hook = hook


async def record_compile(
    *,
    user_id: Optional[str],
    project_id: Optional[str],
    board_fqbn: str,
    success: bool,
    duration_ms: int,
    error_kind: Optional[str],
    extra: dict,
    request: Any = None,
) -> None:
    """Record a compile event. No-op when no overlay is loaded."""
    if _record_compile_hook is None:
        return
    try:
        await _record_compile_hook(
            user_id=user_id,
            project_id=project_id,
            board_fqbn=board_fqbn,
            success=success,
            duration_ms=duration_ms,
            error_kind=error_kind,
            extra=extra,
            request=request,
        )
    except Exception:
        # A failing metric must never break the compile response.
        logger.exception("record_compile hook failed (swallowed)")


# ── get_current_user_id ───────────────────────────────────────────────────────
# FastAPI dependency: resolves the current user's id from the request (typically
# by decoding a JWT cookie). Returns None for anonymous requests OR when no auth
# overlay is loaded. Routes that need an id but accept anonymous use the
# returned value directly; routes that require auth wrap with require_auth_hook.

GetCurrentUserIdHook = Callable[[Any], Awaitable[Optional[str]]]

_get_current_user_id_hook: Optional[GetCurrentUserIdHook] = None


def register_get_current_user_id(hook: GetCurrentUserIdHook) -> None:
    """Install the auth resolver. Called by overlays in register_pro."""
    global _get_current_user_id_hook
    _get_current_user_id_hook = hook


async def get_current_user_id(request: Request) -> Optional[str]:  # FastAPI dependency
    if _get_current_user_id_hook is None:
        return None
    try:
        return await _get_current_user_id_hook(request)
    except Exception:
        logger.exception("get_current_user_id hook failed (treating as anonymous)")
        return None


# ── get_project_libraries ─────────────────────────────────────────────────────
# Returns the declared library manifest (list of library names) SAVED with a
# project. The ESP-IDF compiler uses it as the resolution SCOPE so a project
# only merges its own declared libraries — never another user's, or another
# project's, stray install in the shared library dir. Sourced authoritatively
# from the project record (not the client), so it is robust regardless of what
# the frontend sends. Returns None for an unknown project, an empty manifest,
# or when no overlay is loaded (→ legacy scan-all).

GetProjectLibrariesHook = Callable[[str], Awaitable[Optional[list[str]]]]

_get_project_libraries_hook: Optional[GetProjectLibrariesHook] = None


def register_get_project_libraries(hook: GetProjectLibrariesHook) -> None:
    """Install the project-manifest resolver. Called by overlays in register_pro."""
    global _get_project_libraries_hook
    _get_project_libraries_hook = hook


async def get_project_libraries(project_id: Optional[str]) -> Optional[list[str]]:
    if _get_project_libraries_hook is None or not project_id:
        return None
    try:
        return await _get_project_libraries_hook(project_id)
    except Exception:
        logger.exception("get_project_libraries hook failed (treating as no manifest)")
        return None


# ── materialize_library_scope ─────────────────────────────────────────────────
# Given a compile's library manifest (the per-board allowed set), materialize a
# per-compile libraries directory the ESP-IDF resolver reads from — instead of
# the single shared global libraries volume. The overlay symlinks each declared
# library from the content-addressed cache (or, while the global volume is being
# retired, the legacy dir as a fallback) into a throwaway dir and returns
# (libraries_dir, content_token). The compiler folds the token into its build-
# variant hash (so a content change resets the build cache) and removes the dir
# after the attempt. Returns None when no overlay is loaded OR the manifest is
# empty -> the compiler uses its single default libraries dir (OSS self-host
# parity / scan-all). SYNC — pure filesystem (symlink creation).

# `owner_id` is the project OWNER's id (NOT the requester's): a shared / embed /
# anonymous compile of someone else's project must resolve THAT user's custom
# (per-user-store) libraries. The overlay treats it as an opaque key; the OSS
# compiler only threads it through. None for unsaved/anon-no-project compiles.
# Returns (libraries_dir, content_token) or, since 2026-09-11, optionally a
# third element: a stats dict ({cache, user, legacy, unresolved,
# unresolved_deps, keys, closure_names, ...}). Consumers index positionally
# and must tolerate both lengths; `closure_names` is what lets the ESP-IDF
# lane honour the transitive closure the overlay materialised.
MaterializeLibraryScopeHook = Callable[[set, Optional[str]], Optional[tuple]]

_materialize_library_scope_hook: Optional[MaterializeLibraryScopeHook] = None


def register_materialize_library_scope(hook: MaterializeLibraryScopeHook) -> None:
    """Install the per-compile library-scope materializer. Called in register_pro."""
    global _materialize_library_scope_hook
    _materialize_library_scope_hook = hook


def materialize_library_scope(
    allowed_libraries: Optional[set], owner_id: Optional[str] = None
) -> Optional[tuple]:
    """Return (libraries_dir, content_token) for the manifest, or None to use the
    compiler's default single libraries dir. Never raises (a failing materializer
    degrades to the default dir)."""
    # `None` is "no manifest" (scan-all). An EMPTY set is a manifest that
    # declares nothing and reaches the overlay as such: it decides whether
    # that means a closed scope (project/gallery-libraries-2026-09, P2.7)
    # or, as today, no scope at all. Before 2026-09-11 `not allowed_libraries`
    # folded the two together and an empty manifest could never be closed.
    if _materialize_library_scope_hook is None or allowed_libraries is None:
        return None
    try:
        return _materialize_library_scope_hook(allowed_libraries, owner_id)
    except Exception:
        logger.exception("materialize_library_scope hook failed (using default libraries dir)")
        return None


# ── resolve_compile_owner ─────────────────────────────────────────────────────
# Resolve WHOSE per-user custom libraries a compile may resolve for a project —
# applying a VISIBILITY gate. A compile of a saved project resolves the OWNER's
# custom libraries (so a shared / embed compile of someone's PUBLIC project still
# finds that owner's uploaded libs), but a requester must NOT be able to pull
# another user's PRIVATE custom libraries by supplying that user's project_id.
# The overlay returns the project owner ONLY when the requester IS the owner OR
# the project is shareable (public / unlisted); otherwise None, and the caller
# falls back to the requester's OWN store. `requester_id` is the authenticated
# caller (None for anon). Returns None for an unknown project or no overlay.

ResolveCompileOwnerHook = Callable[[str, Optional[str]], Awaitable[Optional[str]]]

_resolve_compile_owner_hook: Optional[ResolveCompileOwnerHook] = None


def register_resolve_compile_owner(hook: ResolveCompileOwnerHook) -> None:
    """Install the visibility-gated compile-owner resolver. Called in register_pro."""
    global _resolve_compile_owner_hook
    _resolve_compile_owner_hook = hook


async def resolve_compile_owner(
    project_id: Optional[str], requester_id: Optional[str]
) -> Optional[str]:
    if _resolve_compile_owner_hook is None or not project_id:
        return None
    try:
        return await _resolve_compile_owner_hook(project_id, requester_id)
    except Exception:
        # Fail closed: on any error resolve no foreign owner (caller falls back
        # to the requester's own store), never leak another user's libraries.
        logger.exception("resolve_compile_owner hook failed (treating as requester-only)")
        return None


# ── warm_library ──────────────────────────────────────────────────────────────
# "Install" an index library by WARMING the shared content-addressed cache
# (install into a throwaway sketchbook -> publish to the cache) instead of
# mutating the single shared global libraries volume — so the global dir stops
# growing and can be retired. `requester_id` enforces the anon policy (an
# anonymous user may only use libraries already referenced by an example/project,
# i.e. already cached; warming a fresh uncached lib requires sign-in). Returns a
# result dict ({success, error?, ...}) or None when no overlay is loaded -> the
# OSS route falls back to its legacy arduino-cli global install (self-host parity).

WarmLibraryHook = Callable[..., Awaitable[Optional[dict]]]

_warm_library_hook: Optional[WarmLibraryHook] = None


def register_warm_library(hook: WarmLibraryHook) -> None:
    """Install the cache-warm library installer. Called by overlays in register_pro."""
    global _warm_library_hook
    _warm_library_hook = hook


async def warm_library(
    name: str, version: Optional[str] = None, requester_id: Optional[str] = None
) -> Optional[dict]:
    """Warm an index library into the shared cache. None -> no overlay (the OSS
    route does its legacy global install). Never raises."""
    if _warm_library_hook is None:
        return None
    try:
        return await _warm_library_hook(name=name, version=version, requester_id=requester_id)
    except Exception:
        logger.exception("warm_library hook failed")
        return {"success": False, "error": "Library install failed."}


# ── lifespan startup ──────────────────────────────────────────────────────────
# Overlays that need to run async setup during FastAPI lifespan (DB init,
# table creation, legacy column migrations, etc.) register a coroutine here.
# main.py invokes run_lifespan_startup() once during lifespan; if no overlay
# registered anything, nothing happens.

LifespanStartupHook = Callable[[], Awaitable[None]]

_lifespan_startup_hooks: list[LifespanStartupHook] = []


def register_lifespan_startup(hook: LifespanStartupHook) -> None:
    """Queue a coroutine to run during FastAPI lifespan startup."""
    _lifespan_startup_hooks.append(hook)


async def run_lifespan_startup() -> None:
    """Invoked once by main.py's lifespan. Runs hooks in registration order;
    a failing hook is logged but does not abort the others."""
    for hook in _lifespan_startup_hooks:
        try:
            await hook()
        except Exception:
            logger.exception("lifespan startup hook %r failed (swallowed)", hook)


# ── iot_gateway_gate ──────────────────────────────────────────────────────────
# Decides whether a given request may use the private IoT gateway proxy.
# OSS-default: allow everyone (the gateway is a free feature in the open
# image). A private overlay (velxio-prod) registers a real implementation
# that gates it to paid plans + grandfathered users. Returns None to allow,
# or a `detail` dict that the route turns into a 402 response when blocking.

IotGatewayGateHook = Callable[[Request], Awaitable[Optional[dict]]]

_iot_gateway_gate_hook: Optional[IotGatewayGateHook] = None


def register_iot_gateway_gate(hook: IotGatewayGateHook) -> None:
    """Install the IoT-gateway gate. Called by overlays in register_pro."""
    global _iot_gateway_gate_hook
    _iot_gateway_gate_hook = hook


async def iot_gateway_gate(request: Request) -> Optional[dict]:
    """Return None to allow the gateway request, or a detail dict to block
    it with 402. No-op (allow) when no overlay is loaded."""
    if _iot_gateway_gate_hook is None:
        return None
    try:
        return await _iot_gateway_gate_hook(request)
    except Exception:
        # A failing gate must not take the gateway down — fail open.
        logger.exception("iot_gateway_gate hook failed (allowing request)")
        return None


# ── ws_sim_handler ────────────────────────────────────────────────────────────
# Handles simulation-WebSocket messages the OSS route doesn't itself know about
# (e.g. the Pico W picow_* messages, whose userspace network stack lives in the
# overlay). OSS-default: no handler -> the message is ignored. The overlay
# registers one that dispatches start_picow/stop_picow/picow_packet_out to its
# picow_net manager (and gates start_picow behind a paid plan). Returns True if
# it handled the message, False to let the OSS route fall through.

WsSimHandlerHook = Callable[[Any, str, str, dict, Any], Awaitable[bool]]

# A LIST, not a single slot. Two independent extensions register here now —
# the Pico W network stack and the QEMU board lane (Raspberry Pi Linux +
# STM32) — and with one slot whichever registered last silently erased the
# other. Handlers are tried in registration order and the first one that
# returns True owns the message.
_ws_sim_handler_hooks: list[WsSimHandlerHook] = []


def register_ws_sim_handler(hook: WsSimHandlerHook) -> None:
    """Add a simulation-WS message handler. Called from an extension's
    register hook; may be called more than once by different extensions."""
    if hook not in _ws_sim_handler_hooks:
        _ws_sim_handler_hooks.append(hook)


async def dispatch_ws_sim_message(
    websocket: Any, client_id: str, msg_type: str, msg_data: dict, callback: Any,
) -> bool:
    """Let an extension handle a simulation-WS message. Returns True as soon as
    one claims it, False (the OSS default) when none does."""
    for hook in _ws_sim_handler_hooks:
        try:
            if await hook(websocket, client_id, msg_type, msg_data, callback):
                return True
        except Exception:
            logger.exception("ws_sim_handler hook failed (ignoring message)")
    return False


# ── ws_sim_disconnect ─────────────────────────────────────────────────────────
# Called when a simulation WebSocket goes away, so an extension can tear down
# whatever it started for that client_id. This is not a nicety: a QEMU guest is
# a real child process holding 1-2 GB, and before this hook existed the route
# reached into qemu_manager directly to stop it. With the board lane out of the
# OSS tree there is no such reference left, and without a hook every closed tab
# would leak a guest until the box swapped.

WsSimDisconnectHook = Callable[[str], Awaitable[None]]

_ws_sim_disconnect_hooks: list[WsSimDisconnectHook] = []


def register_ws_sim_disconnect(hook: WsSimDisconnectHook) -> None:
    """Add a simulation-WS disconnect handler."""
    if hook not in _ws_sim_disconnect_hooks:
        _ws_sim_disconnect_hooks.append(hook)


async def dispatch_ws_sim_disconnect(client_id: str) -> None:
    """Tell every extension that this client's simulation WS is gone. Errors
    are logged and swallowed: one failing teardown must not skip the others."""
    for hook in _ws_sim_disconnect_hooks:
        try:
            await hook(client_id)
        except Exception:
            logger.exception("ws_sim_disconnect hook failed (continuing)")


# ── gateway_proxy ─────────────────────────────────────────────────────────────
# Resolves a gateway request for a board the OSS route can't reach itself (the
# Pico W's HTTP server lives in the browser-side lwIP; the overlay proxies into
# it over the WS bridge). OSS-default: no resolver -> None (the route 404s). The
# overlay returns a Response to use, or None to fall through.

GatewayProxyHook = Callable[[str, str, Request], Awaitable[Optional[Response]]]

_gateway_proxy_hook: Optional[GatewayProxyHook] = None


def register_gateway_proxy(hook: GatewayProxyHook) -> None:
    """Install the overlay gateway-proxy resolver. Called in register_pro."""
    global _gateway_proxy_hook
    _gateway_proxy_hook = hook


async def dispatch_gateway_proxy(
    client_id: str, path: str, request: Request,
) -> Optional[Response]:
    """Let an overlay proxy a gateway request (e.g. into the Pico W chip).
    Returns a Response, or None (the OSS default) to fall through to 404."""
    if _gateway_proxy_hook is None:
        return None
    try:
        return await _gateway_proxy_hook(client_id, path, request)
    except Exception:
        logger.exception("gateway_proxy hook failed")
        return None


# ── compile_priority ──────────────────────────────────────────────────────────
# Where a user's compile sits in the build queue. OSS is single-user and has no
# plans, so with no overlay every build is ordinary and the queue is plain FIFO.
# The overlay maps the signed-in user's plan onto the ladder in
# `app.services.build_queue` (PRIORITY_HIGH / MEDIUM / STANDARD) so paid builds
# are admitted first.
#
# Returns {'priority': int, 'tier': str, 'cpu_nice': int | None} or None.
# `tier` is a DISPLAY label the compile-status endpoint echoes back so the
# frontend can say "priority build" vs. offer an upgrade — it is not used for
# any access decision. `cpu_nice` (optional) is the nice level for the build's
# compiler processes: it ranks CPU time between builds that are already
# running and never stops or refuses one; None/absent = inherit. Never return
# queue depth or position from here: those stay server-side (see build_queue).

# Since 2026-09-11 the hook also receives the request (or None): a batch
# caller (the nightly gallery sweep) identifies itself through a header the
# overlay recognises and is queued behind real users. OSS ignores it.
CompilePriorityHook = Callable[..., Awaitable[Optional[dict]]]

_compile_priority_hook: Optional[CompilePriorityHook] = None


def register_compile_priority(hook: CompilePriorityHook) -> None:
    """Install the plan-aware queue-priority resolver. Called in register_pro."""
    global _compile_priority_hook
    _compile_priority_hook = hook


async def compile_priority(user_id: Optional[str], request: Any = None) -> Optional[dict]:
    """Resolve queue priority for a compile. None (the OSS default) means
    'ordinary priority, no plan vocabulary' — the caller supplies it."""
    if _compile_priority_hook is None:
        return None
    try:
        try:
            return await _compile_priority_hook(user_id, request)
        except TypeError:
            # An overlay written against the one-argument contract.
            return await _compile_priority_hook(user_id)
    except Exception:
        # A priority lookup must never cost someone their build. Falling back
        # to ordinary priority just means they queue like everyone else.
        logger.exception("compile_priority hook failed (treating as standard)")
        return None


# ── scope_retry_allowed ───────────────────────────────────────────────────────
# Both compilers retry a failed manifest-scoped build once without the scope
# (scan-all) when the failure is a missing header, so an incomplete manifest
# never regresses a build (P2.3-safety). For an UNMODIFIED gallery compile the
# static tests prove the manifest covers every include, so a retry there can
# only hide a lock bug: the route turns it off per compile through this
# context variable (set inside the job's task so it never leaks across
# requests). Default True = today's behaviour for everyone.
scope_retry_allowed: ContextVar[bool] = ContextVar("scope_retry_allowed", default=True)


# ── health_probe ─────────────────────────────────────────────────────────────
# `/health` is what the compose healthcheck and the deploy gate poll. The OSS
# answer is `{"status": "healthy"}` and nothing else. An overlay that seeds a
# library set at boot registers a probe that returns the PUBLIC payload:
#   {"status": "healthy"|"degraded", "overlay": "pro"|"partial",
#    "libraries": {"ok": bool, "since": <epoch>}, "http_status": 200|503}
# `http_status` 503 while the seed is incomplete keeps the deploy red instead
# of green-with-missing-libraries. `/health` is reachable from the internet,
# so the probe must not put keys, paths or counts in it; those belong to the
# detail probe below, served on an unproxied path only.
HealthProbeHook = Callable[[], Optional[dict]]

_health_probe_hook: Optional[HealthProbeHook] = None


def register_health_probe(hook: HealthProbeHook) -> None:
    """Install the public readiness probe. Called in register_pro."""
    global _health_probe_hook
    _health_probe_hook = hook


def health_probe() -> Optional[dict]:
    """The overlay's public health payload, or None for the OSS default."""
    if _health_probe_hook is None:
        return None
    try:
        return _health_probe_hook()
    except Exception:
        # A probe that throws must read as NOT ready, never as healthy.
        logger.exception("health_probe hook failed (reporting degraded)")
        return {"status": "degraded", "overlay": "partial", "http_status": 503}


HealthDetailHook = Callable[[], Optional[dict]]

_health_detail_hook: Optional[HealthDetailHook] = None


def register_health_detail(hook: HealthDetailHook) -> None:
    """Install the operator-facing health detail (missing keys, gauges)."""
    global _health_detail_hook
    _health_detail_hook = hook


def health_detail() -> Optional[dict]:
    """The full readiness block for `/health/libcache`, or None on OSS."""
    if _health_detail_hook is None:
        return None
    try:
        return _health_detail_hook()
    except Exception:
        logger.exception("health_detail hook failed")
        return {"status": "degraded", "overlay": "partial", "error": "health_detail hook failed"}


# ── scope_fingerprint ────────────────────────────────────────────────────────
# The compile dedup / artifact key used to hash library NAMES, so two builds
# that resolved different BYTES for one name (a re-upload, a version bump, an
# eviction of a sibling) shared a key and the older binary was served. The
# overlay answers with a content-addressed fingerprint of what the manifest
# resolves to (a dry run of materialize_library_scope: cache keys and user
# store tokens, no directory created), or the literal `closed` / `scan-all`.
# None keeps the name-based key: the OSS default.
ScopeFingerprintHook = Callable[[Optional[set], Optional[str]], Optional[str]]

_scope_fingerprint_hook: Optional[ScopeFingerprintHook] = None


def register_scope_fingerprint(hook: ScopeFingerprintHook) -> None:
    """Install the content-addressed scope fingerprint. Called in register_pro."""
    global _scope_fingerprint_hook
    _scope_fingerprint_hook = hook


def scope_fingerprint(allowed_libraries: Optional[set], owner_id: Optional[str]) -> Optional[str]:
    """Fingerprint of the bytes this manifest resolves to, or None (hash names)."""
    if _scope_fingerprint_hook is None:
        return None
    try:
        return _scope_fingerprint_hook(allowed_libraries, owner_id)
    except Exception:
        logger.exception("scope_fingerprint hook failed (hashing names instead)")
        return None


# ── compile_admission ────────────────────────────────────────────────────────
# ONE seam through which the overlay may reshape a compile before it is
# queued: refuse it (server still seeding its libraries; two libraries in the
# scope providing one header with different bytes), or rewrite its scope (an
# unmodified gallery example gets the lock's manifest, a closed scope and no
# scan-all retry). The OSS route only applies what comes back; every rule
# lives in the overlay, which is where the deployment that needs them runs.
#   returns None -> nothing to do (the OSS default)
#   returns {
#     "refuse": {"success": False, "error": str, "stderr": "", ...},  # optional
#     "http_status": int,          # with "refuse"; 200 or 422 or 503
#     "headers": {"Retry-After": "5"},  # optional, with "refuse"
#     "error_kind": str,           # with "refuse"; recorded as the compile's error_kind
#     "allowed_libraries": set,    # optional: replaces the resolved scope
#     "retry_allowed": bool,       # optional: default True
#     "gallery": dict,             # optional: echoed on the job status
#   }
CompileAdmissionHook = Callable[..., Optional[dict]]

_compile_admission_hook: Optional[CompileAdmissionHook] = None


def register_compile_admission(hook: CompileAdmissionHook) -> None:
    """Install the pre-queue admission step. Called in register_pro."""
    global _compile_admission_hook
    _compile_admission_hook = hook


def compile_admission(
    *,
    files: list,
    board_fqbn: str,
    example_id: Optional[str],
    client_manifest: Optional[list],
    allowed_libraries: Optional[set],
    owner_id: Optional[str],
    requester_id: Optional[str],
) -> Optional[dict]:
    """Ask the overlay whether, and how, this compile may proceed."""
    if _compile_admission_hook is None:
        return None
    try:
        return _compile_admission_hook(
            files=files, board_fqbn=board_fqbn, example_id=example_id,
            client_manifest=client_manifest, allowed_libraries=allowed_libraries,
            owner_id=owner_id, requester_id=requester_id,
        )
    except Exception:
        # A broken admission step must never cost anyone their build.
        logger.exception("compile_admission hook failed (admitting as-is)")
        return None


# ── uninstall_library ────────────────────────────────────────────────────────
# On a deployment whose libraries live in a shared content-addressed cache
# plus per-user stores, "uninstall" means: a shared index library is nobody's
# to remove (say so, success=False with a reason), a user's own upload is
# removed and refunded. Without an overlay the route keeps the arduino-cli
# sketchbook uninstall, which is what an OSS self-host wants.
#   returns None -> no overlay, use the legacy path
#   returns {"success": bool, "error": str | None, "stdout": str | None}
UninstallLibraryHook = Callable[[str, Optional[str]], Awaitable[Optional[dict]]]

_uninstall_library_hook: Optional[UninstallLibraryHook] = None


def register_uninstall_library(hook: UninstallLibraryHook) -> None:
    """Install the cache-aware uninstall. Called in register_pro."""
    global _uninstall_library_hook
    _uninstall_library_hook = hook


async def uninstall_library(name: str, requester_id: Optional[str]) -> Optional[dict]:
    """Overlay uninstall result, or None to fall back to arduino-cli."""
    if _uninstall_library_hook is None:
        return None
    try:
        return await _uninstall_library_hook(name, requester_id)
    except Exception:
        logger.exception("uninstall_library hook failed")
        return {"success": False, "error": "Could not uninstall the library right now."}
