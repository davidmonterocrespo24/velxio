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
| `i2c:transfer` | `I2CBusManager.flushTransfer` (AVR) + `RP2040Simulator.flushI2cTransfer` | per sub-transaction (between START and STOP/repeated-START) | Guarded; includes `addr`, `direction`, `data: Uint8Array`, `stop` |
| `spi:transfer` | `installSpiTransferObserver` wrap on `AVRSPI.completeTransfer` + `wireSpiObserver` on `RPSPI.completeTransmit` | per byte | Guarded; `cs: 'default' \| 'spi0' \| 'spi1'`, `mosi`/`miso: Uint8Array(1)` |
| `spice:step` | `CircuitScheduler` post-solve | **throttled 5 Hz** | Guarded; includes `nodes` snapshot |
| `board:change` | Reserved | — | Planned for MCU selector |
| `compile:start` | `compileCode()` entry | per-request | — |
| `compile:done` | `compileCode()` exit (both paths) | per-request | Carries `ok`, `durationMs`, `bytes?`, `message?` |
| `plugin:update:applied` | `PluginLoader.checkForUpdates()` after a successful auto-reload | once per applied auto-update | Guarded; emitted only on `auto-approve` / `auto-approve-with-toast` paths and only when `reload.status === 'active'`. NOT emitted on `requires-consent`. Carries `pluginId`, `fromVersion`, `toVersion`, `decision`, `addedPermissions: readonly string[]`. |

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

## I2C/SPI transfer observation (CORE-003b)

`i2c:transfer` and `spi:transfer` are **bus observation** events — every
sub-transaction the master drives is reported, regardless of whether a
slave was actually present or whether it ACKed. A NACK'd I2C connect
followed by STOP still emits a transfer with `data.length === 0` so a
plugin protocol-decoder can render the failed connect on its bus trace.

### I2C — sub-transaction boundaries

A sub-transaction lives between `connectToSlave()` and the next `stop()`
**or** the next `connectToSlave()` (which is a *repeated START*). The
emitter flushes with:

- `stop: true`  on a real STOP — the bus is released.
- `stop: false` on a repeated START — the master is keeping ownership of
  the bus and re-addressing.

Direction (`'read'` vs `'write'`) is inferred from whether
`writeByte`/`readByte` arrives first inside the sub-transaction. A
sub-transaction with no byte transfers (NACK'd connect → STOP) defaults
to `'write'` since the address byte's R/W bit was zero.

### SPI — per-byte observation

`AVRSPI` and `RPSPI` are byte-oriented peripherals: every SPDR write
(AVR) / `onTransmit` (RP2040) generates one MOSI byte; the slave (or
loopback) responds with one MISO byte via `completeTransfer` /
`completeTransmit`. The observer wraps the **completion** hook so the
event fires exactly once per byte pair, after both MOSI and MISO are known.

#### MOSI capture survives plugin slave installation

On AVR, `registerSpiSlave` (the plugin-facing API) replaces
`spi.onByte` with the slave's handler. To survive that, the observer
wraps `cpu.writeHooks[SPDR]` instead — a separate slot the slave
installation does not touch. Every SPDR write goes through this hook
before `spi.onByte()` fires, so MOSI is captured even when a plugin
slave returns the MISO byte.

On RP2040, `setSPIHandler` replaces `spi.onTransmit` directly — so the
implementation re-snapshots MOSI inline inside the user-handler wrapper.
The completion-side observer (set by `wireSpiObserver` at init) survives
unchanged because nobody re-assigns `completeTransmit`.

#### Channel id

- AVR: always `'default'` (single SPI bus).
- RP2040: `'spi0'` or `'spi1'` (two hardware SPI blocks).
- Plugin SPI buses (future) should pick a stable identifier; plugin
  decoders that observe via `events.on('spi:transfer', ...)` use the
  `cs` field to filter.

## Plugin update telemetry — `plugin:update:applied` (SDK-008f)

Telemetry plugins observe sibling auto-updates by subscribing to
`'plugin:update:applied'`. Emitted by `PluginLoader.checkForUpdates()`
in `frontend/src/plugins/loader/PluginLoader.ts` immediately after
`manager.unload(id)` + `manager.load(latestManifest, ...)` resolves
with `status: 'active'`. The emit is hot-path-guarded by
`bus.hasListeners('plugin:update:applied')` even though the loader's
24h tick is cold — the guard is the canonical idiom.

**When the event fires:**

| Loader decision | `reload.status` | Emit? |
|---|---|---|
| `auto-approve` | `'active'` | ✅ |
| `auto-approve-with-toast` | `'active'` | ✅ |
| `auto-approve` | `'failed'` / `'offline'` / `'license-failed'` | ❌ |
| `requires-consent` | (no reload yet) | ❌ |
| `no-drift` / `no-manifest` / `skipped` / `busy` / `error` | (no reload) | ❌ |

`requires-consent` deliberately does **not** emit: those updates are
still pending a user click via the badge UI in the Installed Plugins
modal. A separate `'plugin:update:available'` event for that path was
explicitly out of scope for SDK-008f — it would expose pending
permission asks cross-plugin (privacy-questionable).

**Payload:**

```ts
{
  pluginId: string;
  fromVersion: string;
  toVersion: string;
  decision: 'auto-approve' | 'auto-approve-with-toast';
  addedPermissions: readonly string[];  // delta vs. prior manifest
}
```

`addedPermissions` is the post-hoc delta computed from the prior
manifest (the user implicitly accepted via `auto-approve-with-toast`),
so this is not a new privacy surface beyond what the user already
saw in the toast.

**Permission gate:** subscribing requires `simulator.events.read`
(Low-risk, existing) — same gate as the rest of the EventBus.

## Adding a new event

1. Add the name + payload shape to `SimulatorEvents` in `packages/sdk/src/events.ts`.
2. Bump `@velxio/sdk` version (minor if this is additive).
3. Emit from the Core. For cold-path events, just `bus.emit(...)`.
   For hot-path events, add the `hasListeners` guard.
4. Add a test that registers a listener and verifies it fires.
5. If the event is continuous (>1 Hz natural cadence), pick a throttle
   interval and wire through `shouldEmitThrottled()`.
6. Update this table.
