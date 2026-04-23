# Event Bus

The Velxio simulator exposes a **typed event bus** that plugins and built-in
UI both subscribe to. It is the single source of truth for "something
happened inside the simulator" — no component should poll state when it
could react to an event.

This doc is for contributors to the Core. Plugin authors should read the
SDK API docs in `@velxio/sdk/events` instead — they only see the read-only
`EventBusReader` surface.

---

## Design invariants

1. **Strictly typed.** Every event name maps to one payload shape, declared
   in `packages/sdk/src/events.ts`. Adding an event means editing that file
   first — the compiler then surfaces every call site that needs to emit.
2. **Read-only for plugins.** The SDK exports `EventBusReader` which only
   has `on()` / `hasListeners()` / `listenerCount()`. The full bus with
   `emit()` lives in the Core (`frontend/src/simulation/EventBus.ts`) and
   is never handed to plugin code.
3. **Zero-listener fast path.** The first line of `emit()` is a
   `this.listeners[event] === undefined` check. With no listeners, emit is
   a single property lookup and a return — no allocation, no iteration.
4. **Error isolation.** A throwing listener is caught, logged, and does
   not block subsequent listeners in the same dispatch. One buggy plugin
   cannot freeze the simulator.
5. **Snapshot on dispatch.** Listeners registering or unregistering during
   a dispatch do not affect the in-flight dispatch. This prevents subtle
   skip-one-listener bugs.
6. **Synchronous dispatch.** Listeners are invoked inline. Plugins that
   need async work do it inside their listener (`fn = (p) => { void doAsync(p); }`).

## Event catalogue

See `packages/sdk/src/events.ts` for authoritative types. High-level map:

| Event | Emitted by | Cadence | Notes |
|---|---|---|---|
| `simulator:start` | `AVRSimulator.start` | once per run | Includes `board` + `mode` |
| `simulator:stop` | `AVRSimulator.stop` | once per run | `reason: 'user' \| 'crash' \| 'completed' \| 'reset'` |
| `simulator:reset` | `AVRSimulator.reset` | once per reset | Empty payload |
| `simulator:tick` | `AVRSimulator.start` loop | **throttled 10 Hz** | Carries `cycle` + `ts` |
| `pin:change` | Port listeners in `AVRSimulator.firePinChangeWithTime` | per-transition | Guarded with `hasListeners` |
| `serial:tx` | `AVRUSART.onByteTransmit` | per-byte | Guarded |
| `serial:rx` | Reserved for future inbound Serial | — | Not yet emitted |
| `spice:step` | `CircuitScheduler` post-solve | **throttled 5 Hz** | Guarded; includes `nodes` snapshot |
| `board:change` | Reserved | — | Planned for MCU selector |
| `compile:start` | `compileCode()` entry | per-request | — |
| `compile:done` | `compileCode()` exit (both paths) | per-request | Carries `ok`, `durationMs`, `bytes?`, `message?` |

## Performance contract

Measured by PERF-001 benches (`frontend/bench/eventbus.bench.ts`).
Numbers are **best-of-N** on Node 22, Windows x64, under tinybench
harness — real host emit is faster than the bench reports, because
tinybench adds per-iteration overhead.

| Bench | Budget | Actual (2026-04-22) |
|---|---|---|
| `BENCH-EVENT-01` (emit, 0 listeners) | ≥ 10M hz | 12.78M hz |
| `BENCH-EVENT-02` (emit, 100 listeners) | ≥ 1M hz | 3.25M hz |
| `BENCH-PIN-01` (guarded emit, 0 listeners) | ≥ 10M hz | 13.17M hz |

The guarded-emit pattern used in hot paths (`AVRSimulator.firePinChangeWithTime`)
must be at least as fast as the cold `emit()`, otherwise the guard is a tax
instead of a shortcut. The benches above verify that invariant.

## Hot-path guard pattern

When emitting from inside a tight loop (port listener, serial byte, 1 MHz
sim tick), build the payload lazily:

```ts
if (this.bus.hasListeners('pin:change')) {
  this.bus.emit('pin:change', {
    componentId: 'board:mcu',
    pinName: `D${pin}`,
    state: state ? 1 : 0,
  });
}
```

If nobody is listening, the payload object is never allocated. This is
critical for `pin:change` emissions that fire at the MCU's full speed —
a 16 MHz blink that toggles PORTB every cycle would produce 16M emits/s
without the guard.

## Throttling

Continuous signals (`simulator:tick`, `spice:step`) are throttled by the
emitter, not the subscriber. Each emitter owns a `ThrottleState` object
and wraps emits with `shouldEmitThrottled()`:

```ts
private readonly tickThrottle: ThrottleState = { lastEmitMs: 0 };
// in the frame loop:
if (this.bus.hasListeners('simulator:tick')) {
  if (shouldEmitThrottled(this.tickThrottle, timestamp, TICK_INTERVAL_MS)) {
    this.bus.emit('simulator:tick', { cycle, ts: timestamp });
  }
}
```

The throttle fires on the first call (primed = false) then at most once per
interval. Dropped emits are **dropped** — they do not queue.

## Testing

Unit tests live at `frontend/src/__tests__/EventBus.test.ts`. They cover
registration, unregistration, double-unsubscribe idempotence, error
isolation, iteration safety under concurrent on/off, leak warning, clear(),
throttling semantics, singleton lifecycle, and a perf smoke test.

When writing integration tests that involve the bus, call
`__resetEventBusForTests()` in a `beforeEach` to avoid stale listeners
from prior tests affecting the emit count.

## Adding a new event

1. Add the name + payload shape to `SimulatorEvents` in `packages/sdk/src/events.ts`.
2. Bump `@velxio/sdk` version (minor if this is additive).
3. Emit from the Core. For cold-path events, just `bus.emit(...)`.
   For hot-path events, add the `hasListeners` guard.
4. Add a test that registers a listener and verifies it fires.
5. If the event is continuous (>1 Hz natural cadence), pick a throttle
   interval and wire through `shouldEmitThrottled()`.
6. Update this table.
