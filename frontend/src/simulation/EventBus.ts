/**
 * Host-side EventBus — typed, error-isolated, allocation-aware.
 *
 * Plugins consume this through the read-only `EventBusReader` interface
 * from `@velxio/sdk/events`. The Core holds the full `HostEventBus` with
 * `emit()` (never handed to plugins).
 *
 * Performance contract (principle #0, validated by PERF-001 benches):
 *   - emit() with 0 listeners must be ≤ 10 ns. Implementation: the first
 *     line of emit() checks `this.listeners[event] === undefined` and returns.
 *   - Hot-path callers (port listeners, spice step, serial tx) should guard
 *     with `hasListeners(event)` before constructing payloads.
 *   - Listener storage is `Set<Function>` for O(1) add/remove.
 *   - Listeners are called synchronously and in insertion order. A throwing
 *     listener is caught, logged, and does not block others.
 *
 * Throttling for `simulator:tick` (10 Hz) and `spice:step` (5 Hz) is the
 * caller's responsibility — wrap emits in `shouldEmit*()` helpers exported
 * from this module. Throttle state is per-emitter, not global, so multiple
 * simulator instances do not interfere.
 */

import type {
  SimulatorEventListener,
  SimulatorEventName,
  SimulatorEvents,
  EventBusReader,
  Unsubscribe,
} from '@velxio/sdk/events';

const LEAK_WARNING_THRESHOLD = 50;

export interface HostEventBusOptions {
  /**
   * Threshold above which `on()` logs a one-time leak warning per event
   * channel. Defaults to 50. Set to `Infinity` to silence the warning —
   * intended for benchmarks that intentionally install many listeners
   * to measure dispatch cost (BENCH-EVENT-02), NOT for production code.
   */
  leakWarningThreshold?: number;
}

/**
 * Full host-side bus. Owns `emit()` and listener storage.
 *
 * The `reader()` getter returns a narrowed interface that only exposes
 * `on()` / `hasListeners()` / `listenerCount()`. Hand the reader to
 * plugins — never the bus itself.
 */
export class HostEventBus implements EventBusReader {
  // Indexed object keyed by event name. `undefined` = no listeners ever
  // registered for this event (fast-path check).
  private listeners: Partial<
    Record<SimulatorEventName, Set<(payload: unknown) => void>>
  > = {};

  // Track events that have already warned about leaks so we don't spam.
  private warnedEvents = new Set<SimulatorEventName>();

  private readonly leakThreshold: number;

  constructor(options: HostEventBusOptions = {}) {
    this.leakThreshold = options.leakWarningThreshold ?? LEAK_WARNING_THRESHOLD;
  }

  on<K extends SimulatorEventName>(
    event: K,
    listener: SimulatorEventListener<K>,
  ): Unsubscribe {
    let set = this.listeners[event];
    if (set === undefined) {
      set = new Set();
      this.listeners[event] = set;
    }
    set.add(listener as (payload: unknown) => void);

    if (set.size > this.leakThreshold && !this.warnedEvents.has(event)) {
      this.warnedEvents.add(event);
      console.warn(
        `[EventBus] ${event} has ${set.size} listeners — possible leak. ` +
          'Ensure plugins call their unsubscribe handles in deactivate().',
      );
    }

    return () => {
      const s = this.listeners[event];
      if (s === undefined) return;
      s.delete(listener as (payload: unknown) => void);
      if (s.size === 0) {
        delete this.listeners[event];
        this.warnedEvents.delete(event);
      }
    };
  }

  hasListeners<K extends SimulatorEventName>(event: K): boolean {
    const set = this.listeners[event];
    return set !== undefined && set.size > 0;
  }

  listenerCount<K extends SimulatorEventName>(event: K): number {
    return this.listeners[event]?.size ?? 0;
  }

  /**
   * Emit an event. Synchronous — listeners run in insertion order.
   * Throwing listeners are isolated (logged, not rethrown).
   *
   * Hot-path callers SHOULD guard with `hasListeners()` before building
   * the payload object. When there are no listeners, this function returns
   * on the very first line without touching the payload.
   */
  emit<K extends SimulatorEventName>(
    event: K,
    payload: SimulatorEvents[K],
  ): void {
    const set = this.listeners[event];
    if (set === undefined) return;
    // Snapshot before iterating: a listener that calls `off()` during
    // dispatch must not affect the current pass.
    const snapshot = Array.from(set);
    for (let i = 0; i < snapshot.length; i++) {
      try {
        snapshot[i](payload);
      } catch (err) {
        console.error(`[EventBus] listener for "${event}" threw:`, err);
      }
    }
  }

  /**
   * Remove every listener. Intended for test teardown and full simulator
   * restarts. Plugin code must not call this.
   */
  clear(): void {
    this.listeners = {};
    this.warnedEvents.clear();
  }

  /**
   * Narrowed view for plugin consumption.
   */
  reader(): EventBusReader {
    return this;
  }
}

// ── Throttling helpers ──────────────────────────────────────────────────
//
// Throttling is intentionally per-event-per-emitter, not a property of
// the bus itself. Putting it on the bus would force every call site to
// share one clock; keeping it out means AVRSimulator and SpiceEngine can
// each own their own throttle state without coordinating.

export interface ThrottleState {
  /**
   * Timestamp of the last fired emit, in the same clock domain as the
   * `nowMs` you pass. Start at `0` — the helper treats `0` as the
   * "never fired" sentinel and fires on the first call, regardless of
   * whether the first `nowMs` is also 0.
   */
  lastEmitMs: number;
  /** Set internally once the first emit fires. Do not touch. */
  primed?: boolean;
}

export const TICK_INTERVAL_MS = 100; // 10 Hz
export const SPICE_STEP_INTERVAL_MS = 200; // 5 Hz

/**
 * Returns true at most once per `intervalMs`. Caller owns the state object
 * — typically one per simulator instance per event.
 *
 * Semantics: fires immediately on the first call (when `lastEmitMs === 0`),
 * then at most once per `intervalMs` thereafter. The first-call behavior
 * means callers don't have to seed the state — just `{ lastEmitMs: 0 }`.
 *
 * Example:
 * ```ts
 * const tickThrottle: ThrottleState = { lastEmitMs: 0 };
 * if (shouldEmitThrottled(tickThrottle, performance.now(), TICK_INTERVAL_MS)) {
 *   bus.emit('simulator:tick', { cycle, ts: performance.now() });
 * }
 * ```
 */
export function shouldEmitThrottled(
  state: ThrottleState,
  nowMs: number,
  intervalMs: number,
): boolean {
  if (!state.primed) {
    state.primed = true;
    state.lastEmitMs = nowMs;
    return true;
  }
  if (nowMs - state.lastEmitMs >= intervalMs) {
    state.lastEmitMs = nowMs;
    return true;
  }
  return false;
}

// ── Singleton ──────────────────────────────────────────────────────────
//
// One bus per browser tab. If we ever need multi-tenancy (iframe-embedded
// simulators) we'll introduce a factory — for now the global is fine and
// matches how stores, registries, and the SPICE engine are accessed.

let globalBus: HostEventBus | null = null;

export function getEventBus(): HostEventBus {
  if (globalBus === null) globalBus = new HostEventBus();
  return globalBus;
}

/** Test-only: reset the global bus between tests. */
export function __resetEventBusForTests(): void {
  globalBus = null;
}
