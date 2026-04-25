/**
 * EventBus micro-benchmarks.
 *
 * Budget (from task CORE-003 and principle #0):
 *   BENCH-EVENT-01 (emit 0 listeners)      ≤ 10 ns/op  → ≥ 100 000 000 hz
 *   BENCH-EVENT-02 (emit 100 no-op)        ≤ 1 µs/op   → ≥ 1 000 000 hz
 *   BENCH-PIN-01   (emit with guard, 0 li) ≤ 10 ns/op  → ≥ 100 000 000 hz
 *
 * The guard pattern (BENCH-PIN-01) is what hot callers like AVRSimulator's
 * firePinChangeWithTime use: `if (bus.hasListeners(event)) bus.emit(...)`.
 * It has to be as cheap as the cold emit path itself — otherwise the guard
 * is a tax, not a shortcut.
 */

import type { Bench } from 'tinybench';
import { HostEventBus } from '../src/simulation/EventBus';

export const EVENT_BENCH_METADATA = {
  'BENCH-EVENT-01 — emit with 0 listeners': {
    description: 'Cold-path emit. Fast-path branch, no allocation, no dispatch.',
    budget: { min_hz: 100_000_000 },
  },
  'BENCH-EVENT-02 — emit with 100 listeners (noop)': {
    description: 'Hot dispatch. Iterates snapshot of 100 listeners and calls each.',
    budget: { min_hz: 1_000_000 },
  },
  'BENCH-PIN-01 — guarded emit with 0 listeners': {
    description:
      'hasListeners-guarded emit, as used in AVRSimulator hot path. Must be ' +
      'indistinguishable from the unguarded cold path.',
    budget: { min_hz: 100_000_000 },
  },
} as const;

export function registerEventBusBenches(bench: Bench): void {
  // ── BENCH-EVENT-01 ────────────────────────────────────────────────────
  // Zero listeners: the bus should short-circuit before touching the payload.
  {
    const bus = new HostEventBus();
    const payload = { componentId: 'x', pinName: 'D13', state: 1 as const };
    bench.add('BENCH-EVENT-01 — emit with 0 listeners', () => {
      bus.emit('pin:change', payload);
    });
  }

  // ── BENCH-EVENT-02 ────────────────────────────────────────────────────
  // Full dispatch to 100 no-op listeners. Exercises the Set → Array
  // snapshot + for-loop call cost.
  // Silence the leak-warn — 100 listeners is the workload, not a leak.
  {
    const bus = new HostEventBus({ leakWarningThreshold: Infinity });
    for (let i = 0; i < 100; i++) {
      bus.on('pin:change', () => {
        /* noop */
      });
    }
    const payload = { componentId: 'x', pinName: 'D13', state: 1 as const };
    bench.add('BENCH-EVENT-02 — emit with 100 listeners (noop)', () => {
      bus.emit('pin:change', payload);
    });
  }

  // ── BENCH-PIN-01 ──────────────────────────────────────────────────────
  // Hot-path guard pattern. Builds the payload only when there's a listener.
  // With zero listeners, this must be as cheap as BENCH-EVENT-01.
  {
    const bus = new HostEventBus();
    bench.add('BENCH-PIN-01 — guarded emit with 0 listeners', () => {
      if (bus.hasListeners('pin:change')) {
        bus.emit('pin:change', { componentId: 'x', pinName: 'D13', state: 1 });
      }
    });
  }
}
