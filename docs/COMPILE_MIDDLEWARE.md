# Compile Middleware

Velxio's compile pipeline runs every sketch through two **independent**
middleware chains — one in the browser (before the HTTP request) and one
in the FastAPI backend (around `arduino-cli`). The chains share a
contract but are wired separately because they protect different things:
the client chain catches sketch transforms that don't need the
filesystem, the server chain catches anything that needs `arduino-cli`'s
view of the world.

| Tier   | Lives in                                              | Public to plugins?                  |
| ------ | ----------------------------------------------------- | ----------------------------------- |
| Client | `frontend/src/simulation/CompileMiddleware.ts`        | Yes (via `@velxio/sdk` `ctx.compile`) |
| Server | `backend/app/services/compile_middleware.py`          | **No** — Core built-ins only until the server-side sandbox ships (PRO-001+) |

The client chain is the one third-party plugins see today. The server
chain is intentionally Core-only: a buggy or malicious server middleware
could trash compiles for every user of the instance, and we don't have
the sandbox to host it yet.

---

## Lifecycle

For both tiers, every compile runs:

```
runPre(files, ctx)        ← FIFO (registration order)
        │
        ▼
arduino-cli  /  axios POST
        │
        ▼
runPost(result, ctx)      ← LIFO (reverse registration order)
```

`runPre` can **transform** the sketch files; `runPost` is **observe-only**.
The asymmetry is deliberate:

- A pre middleware that throws **aborts the compile**. The error bubbles
  to the caller and surfaces as `compile:done { ok: false }`. There is
  no point in invoking `arduino-cli` against a half-transformed sketch.
- A post middleware that throws (or hangs) is **swallowed**. The compile
  result is already the source of truth — observers cannot retroactively
  break a successful build, and a flaky plugin must not block the UI.

LIFO for post mirrors the way decorators wrap function calls: the
middleware registered **last** sees the result first, so wrappers can
unwrap in the order they wrapped.

## Timeout

Each middleware is wrapped in a 5 s timeout (`MIDDLEWARE_TIMEOUT_MS` /
`MIDDLEWARE_TIMEOUT_S`). Crossing the budget:

- in `runPre` → raises and aborts the compile (same path as a
  middleware-thrown exception).
- in `runPost` → logged and skipped, the next middleware still runs.

The timeout is fixed, not per-plugin configurable. A plugin that needs
to do heavy work should hand off to `queueMicrotask` / a worker / a
background API and let the middleware return immediately.

## Built-in: RP2040 Serial → Serial1 redirect

Arduino-Pico (the RP2040 core) exposes the USB CDC port as `Serial` and
the UART0 pins (which Velxio's emulator listens on) as `Serial1`. Without
the redirect, every `Serial.print(...)` written by a user lands on the
USB endpoint and the emulator sees nothing.

The redirect is implemented as a server-tier middleware
(`builtin.rp2040-serial-redirect`) registered automatically by
`get_compile_middleware_registry()`. For any FQBN containing `rp2040`,
the middleware:

1. Promotes the first `.ino` file to `sketch.ino` if no file is already
   named `sketch.ino` (matches arduino-cli's expectation).
2. Prepends `#define Serial Serial1\n` to the resulting `sketch.ino`.

It runs as a **middleware on purpose**. Before this task, the same
transform lived as inline `if "rp2040" in board_fqbn:` branches inside
`arduino_cli.py`. Extracting it gives us:

- A second middleware can layer on top (e.g. a future ESP32 partition
  redirect) without touching the compile orchestrator.
- The transform is unit-testable in isolation (`backend/tests/test_compile_middleware.py`).
- Plugins reading the chain can see what built-ins already ran.

## Registering a middleware (Core only, today)

### Frontend (TypeScript)

```ts
import { getCompileMiddlewareChain } from '@/simulation/CompileMiddleware';

const chain = getCompileMiddlewareChain();

const handle = chain.preWithOwner(
  'client',
  async (files, ctx) => {
    if (!ctx.board.startsWith('arduino:avr:')) return files;
    return files.map((f) =>
      f.name.endsWith('.ino')
        ? { ...f, content: `// auto-injected by my-plugin\n${f.content}` }
        : f,
    );
  },
  'core.my-plugin',
);

// later, e.g. on plugin deactivate:
handle.dispose();
```

`preWithOwner` records the plugin id for diagnostics — when a middleware
throws or times out, the log line names the plugin so the failure can be
attributed without grepping for closures. `pre()` (without owner) is
fine for one-off internal hooks.

### Backend (Python)

```python
from app.services.compile_middleware import (
    CompileMiddleware,
    CompileRequestPayload,
    CompileResultPayload,
    get_compile_middleware_registry,
)


class MyMiddleware:
    name = "core.my-middleware"

    async def before_compile(self, req: CompileRequestPayload) -> CompileRequestPayload:
        return CompileRequestPayload(
            files=req.files,
            board_fqbn=req.board_fqbn,
            notes=[*req.notes, "core.my-middleware ran"],
        )

    async def after_compile(
        self, req: CompileRequestPayload, result: CompileResultPayload
    ) -> CompileResultPayload:
        return result


get_compile_middleware_registry().register(MyMiddleware())
```

Registration happens at import time (e.g. inside `app/main.py` or a
dedicated module that `main.py` imports). The registry refuses duplicate
names — a `ValueError` at boot is preferable to silent shadowing.

## Notes mechanism

`CompileRequestPayload.notes` is a list of strings that middlewares can
append to as they transform the request. It exists so the chain can
record *what it did* without dropping that information into stdout/stderr
(which the user sees as build output). Today the notes are not echoed to
the API response; surfacing them is tracked as a follow-up on CORE-004
and will land alongside SDK-002 (`ctx.compile.afterCompile` payload
shape).

## Testing

Both chains have unit tests covering ordering, error isolation, and
timeout semantics:

- `frontend/src/__tests__/CompileMiddleware.test.ts` (15 tests)
- `backend/tests/test_compile_middleware.py` (15 tests)

Backend tests use `asyncio.run()` per test instead of `pytest-asyncio`
to keep the test dependency surface minimal. Tests that exercise the
timeout path use `monkeypatch` to shrink `MIDDLEWARE_TIMEOUT_S` to
50 ms so the suite stays under a second.

## Why two separate chains?

A single shared chain is tempting but breaks down on three points:

1. **Sandbox boundary**: a client middleware runs in the browser tab
   that owns the editor. A server middleware runs inside the FastAPI
   process that compiles every user's sketch. The trust model and the
   blast radius are completely different.
2. **Available APIs**: client middlewares can talk to the editor store,
   the wires, the canvas. Server middlewares can talk to the
   filesystem and `arduino-cli`. Pretending these are the same surface
   leads to runtime errors that should have been compile-time errors.
3. **Lifecycle**: client middlewares are registered when a plugin
   activates and disposed when it deactivates. Server middlewares are
   registered at process boot and (today) never unregistered.

When the server-side plugin sandbox lands (PRO-001 onward), the server
chain will gain its own owner-tracking and dispose semantics, but the
two chains will still be distinct registries.
