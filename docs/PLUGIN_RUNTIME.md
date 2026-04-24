# Plugin Runtime (Web Worker sandbox)

This doc covers the runtime that loads and executes a Velxio Pro plugin —
the boundary between the trusted editor (host) and the untrusted plugin code
(guest). It is for contributors to the Core. Plugin authors should read the
SDK API surface in `packages/sdk/src/` instead.

The runtime lives at `frontend/src/plugins/runtime/`:

| File | Responsibility |
|---|---|
| `rpc.ts` | Transport-agnostic RPC over `postMessage` |
| `proxy.ts` | Callback / Disposable proxying across the boundary |
| `pluginWorker.ts` | Bootstraps a worker: verifies bundle, calls `activate(ctx)` |
| `ContextStub.ts` | Worker-side `PluginContext` that forwards to the host via RPC |
| `PluginHost.ts` | Host-side dispatcher that runs each `ctx.*` call against the in-process registries |
| `PluginManager.ts` | Singleton lifecycle: load / unload / list, hot reload aware |
| `index.ts` | Public barrel for the editor shell |

---

## Threat model

Plugins are arbitrary JavaScript downloaded from a CDN. The guarantees the
runtime provides:

1. **No DOM, no `window`, no cookies.** Guest code runs in a Worker. It
   cannot reach `document`, `localStorage`, the React tree, or the auth
   store.
2. **No undeclared network.** `fetch` is a host-mediated RPC; the manifest's
   `permissions` and host-side allowlist gate every call. Direct `fetch`
   inside the worker is blocked by the production CSP.
3. **No bundle tampering.** A bundle whose SHA-256 disagrees with the
   manifest's `integrity` field is rejected before `import()`.
4. **No starvation of the simulator.** Host → worker traffic is
   fire-and-forget with a bounded queue. A blocked or crashed plugin cannot
   slow the AVR/SPICE loops. (See [Performance contract](#performance-contract).)
5. **Bounded liveness.** A worker that fails 2 consecutive 10 s pings is
   terminated automatically.

Out of scope (yet — see [Deferred work](#deferred-work)):

- Per-plugin CPU quota inside the worker (Workers don't expose a quota API;
  we rely on the queue + ping checks).
- Network-egress cost accounting / rate limits per plugin.
- Per-plugin memory ceiling.

---

## Lifecycle

```
PluginManager.load(manifest, { bundleUrl, integrity })
        │
        ├─ workerFactory.create()        ← new Worker(...) in prod;
        │                                  MessageChannel stub in tests
        │
        ├─ new PluginHost({ manifest, worker, services })
        │       │
        │       ├─ wraps the worker in an RpcChannel
        │       ├─ wires fetch/event/log handlers
        │       └─ creates an in-process PluginContext
        │              (the SAME factory used by built-in plugins)
        │
        ├─ handshake: post { kind: 'init', manifest, bundleUrl, integrity }
        │             wait for { kind: 'ready' } or { kind: 'init-error' }
        │             reject after initTimeoutMs (default 10 000 ms)
        │
        └─ entry.status = 'active'

PluginManager.unload(id)
        │
        └─ host.terminate()
              │
              ├─ stop pings, drop event subs, dispose context
              ├─ drain the host-side disposable table (LIFO)
              ├─ rpc.dispose() (rejects pending requests with RpcDisposedError)
              └─ worker.terminate()
```

`load()` is **idempotent** — calling it twice with the same `manifest.id`
unloads the prior version first. This gives hot-reload semantics for free
when the editor refreshes a plugin during development.

---

## RPC protocol (`rpc.ts`)

`RpcChannel` is the only thing that touches `postMessage`. Everything else
is plain method calls on top of it.

### Wire format

Five message kinds, all JSON-cloneable:

```ts
{ kind: 'request',         id: number, method: string, args: unknown[] }
{ kind: 'response',        id: number, result?: unknown, error?: SerializedError }
{ kind: 'event',           topic: string, payload: unknown }
{ kind: 'invoke-callback', cbId: number, args: unknown[] }
{ kind: 'dispose',         dispId: number }
{ kind: 'log',             level: 'debug'|'info'|'warn'|'error', message, args }
{ kind: 'ping' } / { kind: 'pong' }
```

### Backpressure & coalescing

Pre-flush, every send is appended to an in-memory queue (default capacity
1024). On the next microtask a single drain ships everything via
`postMessage`. Two policies kick in if the simulator outpaces the worker:

- **Coalescing** — `pin:change` events with the same `(componentId, pinName)`
  collapse to the *latest* value. Coalesced count is exposed via
  `getStats().coalesced`.
- **Oldest-drop** — when the queue is full, the oldest pending item is
  evicted and `getStats().dropped` increments. The optional `onDrop` hook
  lets the host surface a red badge in the *Installed Plugins* panel.

These two policies together preserve principle #0 from `task_plan/README.md`:
**the simulator never waits on a plugin**.

### Errors across the boundary

`serializeError` flattens an `Error` to `{ name, message, stack? }`.
`deserializeError` rehydrates it on the other side, mapping known names back
to their classes (`TypeError`, `RangeError`, ...). Unknown names get a
generic `Error` with the original `name` preserved on the instance. This is
why the runtime test for permission denial matches by `name`, not by
`instanceof` — the SDK class identity does not survive a structured clone.

### Liveness

`PluginHost` schedules a ping every `pingIntervalMs` (default 10 s). Two
consecutive missed pongs (so ~20 s of silence) → `terminate()`. Tests pass
`pingIntervalMs: 0` to disable.

---

## Callback / Disposable proxying (`proxy.ts`)

`PluginContext` methods take callbacks (`commands.register({ run })`,
`events.on('pin:change', fn)`) and return `Disposable` handles. Functions
do not survive `postMessage`, so the runtime substitutes opaque ids:

```
worker side                                          host side
───────────                                          ─────────
ctx.commands.register({                              dispatch('commands.register', [{
  id: 'hello',           ─── stripFunctions ───►       id: 'hello',
  title: 'Hi',                                         title: 'Hi',
  run: () => alert(...)                                run: { __cb: 7 }
})                                                   }])

handle.dispose()         ───── postMessage ────►     hostDisposables.get(disp).dispose()
                          { kind: 'dispose',
                            dispId: 12 }
```

`HandleTable<T>` is the small generic that owns id ↔ value mappings on each
side. Two tables exist:

- **callback table** — guest-owned. `worker.cbTable.put(fn)` returns an id;
  `host` later sends `invoke-callback { cbId, args }` and the worker bounces
  into the original `fn`. Cleared on dispose.
- **disposable table** — host-owned. The host returns `{ __disp: id }` for
  every API call that produced a host-side `Disposable`. The worker wraps
  those in a `WorkerDisposableStore` so `handle.dispose()` from guest code
  fires a `dispose { dispId }` message.

The `WorkerDisposableStore` mirrors `HostDisposableStore` semantics: LIFO
unwind, fault-isolated dispose, late-arrival policy (disposing after
terminate is a silent no-op, not a throw).

---

## What the host *actually* runs

`PluginHost.dispatch(method, args)` is a switch on dotted method name
(`'commands.register'`, `'events.on'`, ...) that **delegates to the
existing in-process `PluginContext`** built by `createPluginContext()`.
This is deliberate:

- The semantics of permissions, settings migration, locale fallback,
  storage namespacing, command dedup, etc. live in the host registries
  and are exhaustively tested at the registry level.
- The runtime is then *pure transport*. Adding a new SDK method requires
  zero new permission logic — it just needs a `case` in the dispatcher.

When the in-process call throws (e.g. `PermissionDeniedError`), the throw
serializes, crosses the boundary, and rejects the worker-side promise with
the rehydrated error name preserved.

### DOM-bound APIs (deferred)

A handful of `PluginContext` methods accept render callbacks that need DOM
access:

- `partSimulations.attachEvents(callback)` — DOM event attach
- `panels.render(domNode)` — host hands the plugin an `HTMLElement`
- `canvasOverlays.render(svgNode)` — same for `<svg>`

Functions cannot reach into the worker's address space, and DOM nodes
cannot leave the main thread. The runtime accepts these calls, logs a
one-time warning, and returns a no-op `Disposable`. **CORE-006b** tracks
the actual implementation: a declarative `render.kind: 'svg'` schema, plus
an opt-in `Web Component` registration for richer panels.

---

## Performance contract

This runtime is the load-bearing implementation of principle #0. The
non-negotiables:

| Concern | Mechanism |
|---|---|
| Host never awaits worker for events | `emitEvent` is sync; queue + microtask flush are local |
| `pin:change` storm doesn't queue forever | `defaultCoalesceKey` collapses by `(componentId, pinName)` |
| Slow worker doesn't unbound memory | 1024-entry queue, oldest-drop, drop counter exposed |
| Crashed worker doesn't hang the host | Ping/pong + terminate after 2 missed |
| Plugin throw doesn't crash the editor | Every dispatch / event handler is `try/catch` |

The benchmark gates that enforce this live in `frontend/bench/eventbus.bench.ts`
and (for runtime) the budgets in `docs/PERFORMANCE.md`. **BENCH-AVR-04
with N plugins** is tracked under CORE-006b.

---

## Testing

Two suites exercise the runtime end-to-end without spawning a real Worker:

- `frontend/src/__tests__/plugin-runtime-rpc.test.ts` — wraps two
  `MessagePort`s and verifies wire-level behaviour (round-trip, timeout,
  late-response, coalescing, oldest-drop, ping, dispose).
- `frontend/src/__tests__/plugin-runtime-host.test.ts` — pairs
  `PluginHost` with `buildContextStub()` over a `MessageChannel` to
  exercise commands, permissions, storage, settings, events, and
  termination from end to end.
- `frontend/src/__tests__/plugin-runtime-pentest.test.ts` —
  surface-contract pentest (CORE-006b step 1, see next section).

The pattern (`endpointFor(port)` + `port.start()` + a `WorkerLike` shim)
is what production tests against new SDK methods should follow.

---

## Pentest suite (CORE-006b step 1)

`frontend/src/__tests__/plugin-runtime-pentest.test.ts` is the security
gate that new SDK methods must not break. It verifies the
`PluginContext` surface contract — the only handle `activate(ctx)`
receives — against eight vectors:

| # | What the plugin tries | How the runtime refuses |
|---|---|---|
| 1 | Reach `document`/`window`/`parent`/`top`/`frames` via `ctx` | Keys are `undefined`; UI registry handles return `{ dispose }` only, never a DOM node |
| 2 | Reach `localStorage`/`sessionStorage`/`indexedDB` via `ctx` | Keys are `undefined`; `userStorage.get/set` reject with `PermissionDeniedError` without `storage.user.read`/`write` |
| 3 | Read cookies or set `credentials: 'include'` | No `cookie`/`headers`/`credentials` on `ctx`; `ScopedFetch` always overrides with `credentials: 'omit'` |
| 4 | Reach `eval`/`Function`/`require`/`process` | Keys are `undefined` |
| 5 | Exfiltrate via `fetch('https://malo.com', …)` | `HttpAllowlistDeniedError`; plain `http://` is rejected even if allowlisted; **allowlist is closure-frozen at activation** (mutating `manifest.http` later does not widen) |
| 6 | Call a gated entry point without the permission | `PermissionDeniedError` (for sync gates); for RPC-dispatched registrations (`settings.declare`, `commands.register`, …) the host registry never receives the entry |
| 7 | Register a handler that throws on every invocation | Registration still succeeds; the throw is caught on execute and the host stays operational |
| 8 | Dispose/terminate from plugin A to mess with plugin B | Per-plugin UI registries are independent `Map`-backed instances; A's dispose and A's `terminate()` do not touch B |

### Why surface-contract and not worker-globalThis

The original CORE-006b §4 spec read `globalThis.document` inside a
worker and asserted `ReferenceError`. In jsdom unit tests the "worker"
is a `MessagePort` in the same realm as the test file, so
`globalThis.document` IS present — asserting otherwise would mean
maintaining a synthetic environment that no longer reflects the
production Worker. The guarantee that matters is **what a plugin can
reach through the SDK it was handed**, which is what this suite
covers. The orthogonal browser-enforced guarantee (Worker globalThis
shape + `connect-src` blocking egress at the network layer) is
validated by the strict CSP rollout in **CORE-006b step 2**.

### Why `settings.declare` denial is tested host-side

`ContextStub.settings.declare` wraps the RPC call in `wrapDisposable`,
which returns a `Disposable` synchronously and `.catch`es the
promise — the plugin never sees the rejection. This is intentional:
plugin authors don't `await` every `register*` call. To test
fail-closed, the pentest calls, flushes microtasks, and asserts
`getSettingsRegistry().get(pluginId) === undefined`. That is the
correct shape for any future pentest against an RPC-dispatched
registration (`commands.register`, `components.register`, …).

### Adding a new vector

When a new SDK method lands that could leak a capability, add a
`describe('pentest · vector N: …')` block that:

1. `spawn({ perms, allowlist, fetchImpl })` a fixture with the
   minimum permissions needed to exercise the method.
2. Invoke the method with a hostile argument (monkey-patched manifest,
   leaked key, etc.).
3. Assert the denial shape: either a typed error on the plugin side,
   or an absence on the host side.

Fail-closed is the rule: if the test accidentally passes because the
method returned a resolved Promise with an undefined body, that is a
false negative — inspect what actually got registered on the host.

---

## Fetch egress + rate-limit (CORE-006b step 6)

`PluginHost` accounts every `ctx.fetch` call and caps per-plugin
throughput. Stats feed the Installed Plugins UI and the rate-limit
throws a typed SDK error plugin authors can catch.

### Counters

`host.getStats().fetch: PluginFetchStats`:

```ts
interface PluginFetchStats {
  readonly requests: number;       // accepted calls (may have succeeded or thrown later)
  readonly bytesOut: number;       // sum of approximateBodyBytes(init.body) over requests
  readonly bytesIn: number;        // sum of response.byteLength over successful responses
  readonly rateLimitHits: number;  // calls refused by the sliding-window limiter
}
```

Semantics chosen so the counters are unambiguous:

- A call accepted by the limiter increments `requests` + `bytesOut`.
  Allowlist denial, permission denial, 5xx, network error — all still
  count as `requests` (the host committed real work).
- Only completed responses contribute to `bytesIn`.
- A call **refused** by the limiter increments `rateLimitHits` **only**.
  It does NOT count towards `requests` (we never tried to send it) —
  so `requests` maps to "plugin-observable workload the host did on
  its behalf."

### Default budget

```ts
export const DEFAULT_FETCH_RATE_LIMIT = { maxRequests: 60, windowMs: 60_000 };
```

60 requests per rolling minute per plugin. Override via
`new PluginHost({ manifest, worker, services, fetchRateLimit: {...} })`
— the host enforces the cap, **manifests can NOT widen it**. Set
`maxRequests: Infinity` to disable (test paths only).

### RateLimitExceededError

Thrown by `ctx.fetch` on refusal. Fields:

```ts
{
  name: 'RateLimitExceededError',
  pluginId: string,
  maxRequests: number,
  windowMs: number,
  retryAfterMs: number,  // oldest stamp + windowMs - now (1ms floor)
}
```

`retryAfterMs` is the exact moment the oldest in-window call ages out —
a plugin author can schedule a single retry timer instead of
busy-looping.

### Sliding window vs token bucket

`FetchRateLimiter` keeps a deque of request timestamps. `consume(now)`
evicts everything older than `now - windowMs` from the head, refuses
if `length >= maxRequests`, otherwise stamps. Deque beats token bucket
here because `retryAfterMs` is precisely calculable — no guesswork
for the plugin author.

### Body byte estimation

`approximateBodyBytes(body)` (exported for direct unit testing):

- `string` → `.length` (ASCII-exact, UTF-8 underestimate — accepted)
- `ArrayBuffer` → `.byteLength`
- typed-array view (Uint8Array, etc.) → `.byteLength`
- `Blob` → `.size`
- `URLSearchParams` → `.toString().length`
- `FormData`, `ReadableStream`, unknown → `0` (no cheap introspection)
- Headers are **not** counted — the signal we care about is body size
  for exfiltration-scale egress.

Under jsdom's `MessagePort` polyfill, `Uint8Array` does not survive
`postMessage` (arrives as a plain `Object` with integer keys — a
known jsdom limitation). The integration test exercises only the
string path; `approximateBodyBytes` is exported so every shape gets a
direct unit test without the MessagePort round-trip.

### Typed error fields survive RPC

The rate-limit error (and every other typed SDK error) now preserves
its custom fields across the RPC boundary. `SerializedError` carries
an optional `data?: Record<string, unknown>` populated from
`Object.keys(err)` (skipping `name`/`message`/`stack`/`cause`), and
`deserializeError` re-applies them on the remote side. This means
tests can assert

```ts
await expect(ctx.fetch(...)).rejects.toMatchObject({
  name: 'RateLimitExceededError',
  pluginId: 'my.plugin',
  maxRequests: 3,
  retryAfterMs: 3000,
});
```

which is the natural shape. Before this extension, only `.name` and
`.message` survived — subclass fields were silently lost by
`structuredClone`.

**Rule** (unchanged from CORE-006b step 1): always match typed errors
by `.name`, never by `instanceof` — SDK class identity does not
survive `structuredClone` even with this extension. The data fields
are rehydrated onto a plain `Error`, not onto the original subclass.

---

## Deferred work

Tracked in `task_plan/Backlog/CORE-006b-runtime-deferred.md`. Sub-step
status:

1. ~~Penetration test suite covering the 5 escape vectors (DOM access,
   `localStorage` reach, cookie exfiltration, main-thread eval,
   `connect-src` exfiltration).~~ — ✅ Done 2026-04-24 as
   **CORE-006b-step1** (extended to 8 vectors, surface-contract
   reframing; see above).
2. Production CSP rollout (`worker-src 'self' blob:`, `script-src 'self'
   'wasm-unsafe-eval'`, etc.) in `frontend/index.html`. → step 2
3. **BENCH-AVR-04 with N=3 plugins** — hard regression gate (< 1 % vs
   no-plugin baseline). → step 3
4. *Installed Plugins* UI surface for `PluginHostStats` (queue depth,
   drops, missed pings) — feeds CORE-008. → step 4
5. DOM-bound API design (`render.kind: 'svg'` declarative schema; opt-in
   Web Component registration for panels and overlays). → step 5
6. ~~Per-plugin egress accounting and rate-limit policy for `fetch`.~~ —
   ✅ Done 2026-04-24 as **CORE-006b-step6** (see "Fetch egress +
   rate-limit" section above).
