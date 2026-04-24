/**
 * PartSimulationRegistry adapter-overhead benchmarks.
 *
 * Measures the cost difference between the two parts-authoring shapes the
 * host now supports:
 *
 *   BENCH-PART-01 — legacy `registry.register(id, logic)` with
 *                   `attachEvents(element, simulator, getPin, id)` directly
 *                   calling `simulator.pinManager.onPinChange(arduinoPin, cb)`.
 *                   This is the path built-in parts used before CORE-002c.
 *
 *   BENCH-PART-02 — SDK `registry.registerSdkPart(id, part)` with
 *                   `attachEvents(element, handle)` subscribing via
 *                   `handle.onPinChange(pinName, cb)`. The host adapter
 *                   resolves `getArduinoPin(pinName)` once at subscribe time
 *                   then wraps the user callback with a
 *                   `(_pin, boolean) => cb(state ? 1 : 0)` coercion closure
 *                   before installing it in `pinManager.onPinChange`.
 *
 * The delta between the two is the pure adapter overhead introduced by
 * CORE-002c-step4's mass migration of 30 built-in parts to the SDK shape.
 *
 * Principle #0 budget (from docs/PERFORMANCE.md): the SDK adapter must cost
 * less than AVR8 <1% and SPICE <2% vs a legacy path. Practically, on this
 * bench the two numbers should be within the CI noise floor (~2%), because
 * the adapter adds at most one closure layer + one boolean→number coercion
 * per pin-change dispatch — each a couple of nanoseconds on a modern JIT.
 *
 * The bench drives `PinManager.triggerPinChange` directly rather than going
 * through the full AVR CPU loop. Reason: we want to isolate the adapter
 * cost, not measure `avrInstruction()` dispatch on top. `BENCH-AVR-04` /
 * `BENCH-AVR-05` already measure the combined cost through a real CPU.
 */

import type { Bench } from 'tinybench';
import type { PartSimulation } from '@velxio/sdk';
import { PartRegistry } from '../src/simulation/parts/PartSimulationRegistry';
import { PinManager } from '../src/simulation/PinManager';

const DISPATCHES_PER_ITERATION = 1000;

/**
 * Minimal `AnySimulator`-shaped stub suitable for `registerSdkPart()` +
 * `attachEvents()`. Only `isRunning`, `setPinState`, and `pinManager` are
 * actually consulted by the adapter for the `onPinChange` path — the rest
 * are kept `undefined` so typechecking stays honest.
 */
function makeFakeSimulator(pinManager: PinManager) {
  return {
    isRunning: () => true,
    setPinState: (_pin: number, _state: boolean) => {
      /* noop */
    },
    pinManager,
    // Intentionally absent: spi, i2cBus, setAdcVoltage, etc. The adapter
    // no-ops gracefully when these are missing (see defensive tweak in
    // PartSimulationRegistry.ts), so an `onPinChange`-only part works.
  } as unknown as Parameters<
    NonNullable<
      import('../src/simulation/parts/PartSimulationRegistry').PartSimulationLogic['attachEvents']
    >
  >[1];
}

function makeGetPin(): (name: string) => number | null {
  return (name) => (name === 'LED' ? 13 : null);
}

function makeElement(): HTMLElement {
  // The adapter doesn't touch the element for `onPinChange`, so a bare
  // object that matches the HTMLElement shape for TypeScript is fine.
  return {} as HTMLElement;
}

export function registerPartsBenches(bench: Bench): void {
  // ── BENCH-PART-01 ────────────────────────────────────────────────────
  // Legacy direct-subscribe path. Represents every built-in part from
  // before CORE-002c-step4.
  {
    const pinManager = new PinManager();
    const simulator = makeFakeSimulator(pinManager);
    const registry = new PartRegistry();
    let observed = 0;
    registry.register('bench-legacy-part', {
      attachEvents: (_element, sim, getPin) => {
        const arduinoPin = getPin('LED');
        if (arduinoPin === null) return () => {};
        return sim.pinManager.onPinChange(arduinoPin, (_pin, _state) => {
          observed++;
        });
      },
    });
    const logic = registry.get('bench-legacy-part')!;
    const cleanup = logic.attachEvents!(makeElement(), simulator, makeGetPin(), 'cmp-1');

    bench.add('BENCH-PART-01 legacy pinManager.onPinChange dispatch', () => {
      for (let i = 0; i < DISPATCHES_PER_ITERATION; i++) {
        // Toggle the pin so the PinManager actually fires each iteration
        // — `triggerPinChange` short-circuits when the state is unchanged.
        pinManager.triggerPinChange(13, (i & 1) === 0);
      }
      if (observed < 0) throw new Error('unreachable');
    });

    // Register the teardown callback so tinybench's afterAll sees the
    // subscription go away. We don't call it here — the bench holds the
    // reference for the lifetime of the process.
    void cleanup;
  }

  // ── BENCH-PART-02 ────────────────────────────────────────────────────
  // SDK adapter path. Represents every part migrated in step4.
  {
    const pinManager = new PinManager();
    const simulator = makeFakeSimulator(pinManager);
    const registry = new PartRegistry();
    let observed = 0;
    const sdkPart: PartSimulation = {
      metadataId: 'bench-sdk-part',
      attachEvents: (_element, handle) => {
        const sub = handle.onPinChange('LED', (_state) => {
          observed++;
        });
        return () => sub.dispose();
      },
    };
    registry.registerSdkPart('bench-sdk-part', sdkPart);
    const logic = registry.get('bench-sdk-part')!;
    const cleanup = logic.attachEvents!(makeElement(), simulator, makeGetPin(), 'cmp-2');

    bench.add('BENCH-PART-02 SDK adapter handle.onPinChange dispatch', () => {
      for (let i = 0; i < DISPATCHES_PER_ITERATION; i++) {
        pinManager.triggerPinChange(13, (i & 1) === 0);
      }
      if (observed < 0) throw new Error('unreachable');
    });

    void cleanup;
  }
}

export const PART_BENCH_METADATA = {
  dispatchesPerIteration: DISPATCHES_PER_ITERATION,
  /** Convert ops/s → millions of pin-change dispatches per second. */
  hzToDispatchesMhz(hz: number): number {
    return (hz * DISPATCHES_PER_ITERATION) / 1e6;
  },
};
