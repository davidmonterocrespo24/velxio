/**
 * LogicGateParts.ts — Simulation logic for logic gate components.
 *
 * All gates listen to their input pins via `handle.onPinChange`, compute the
 * boolean output, and drive the Y pin accordingly.
 *
 * 2-input gates: A, B → Y
 * NOT gate:      A    → Y
 *
 * This file is the **SDK-eligible reference migration** for CORE-002c — every
 * gate is authored against the narrow `@velxio/sdk` `SimulatorHandle` via
 * `definePartSimulation` and registered through `PartRegistry.registerSdkPart`.
 * It proves the SDK surface covers a non-trivial, fan-out-heavy part catalog.
 */

import type { PartSimulation, PinState } from '@velxio/sdk';
import { definePartSimulation } from '@velxio/sdk';
import type { PartRegistry } from './PartSimulationRegistry';

// PinState is `0 | 1 | 'z' | 'x'`. The host wraps PinManager's boolean into
// `0 | 1` for SDK subscribers, so only `1` signals HIGH at runtime; `'z'` and
// `'x'` are treated as LOW (same behaviour as the pre-migration direct
// boolean subscription).
const isHigh = (state: PinState): boolean => state === 1;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function twoInputGate(compute: (a: boolean, b: boolean) => boolean): PartSimulation {
  return definePartSimulation({
    attachEvents: (_element, handle) => {
      const pinY = handle.getArduinoPin('Y');
      if (pinY === null) return () => {};

      let stateA = false;
      let stateB = false;

      const update = () => handle.setPinState(pinY, compute(stateA, stateB));

      const subA = handle.onPinChange('A', (s) => {
        stateA = isHigh(s);
        update();
      });
      const subB = handle.onPinChange('B', (s) => {
        stateB = isHigh(s);
        update();
      });

      update(); // Drive Y immediately with initial LOW state

      return () => {
        subA.dispose();
        subB.dispose();
      };
    },
  });
}

function nInputGate(
  inputNames: ReadonlyArray<string>,
  compute: (inputs: boolean[]) => boolean,
): PartSimulation {
  return definePartSimulation({
    attachEvents: (_element, handle) => {
      const pinY = handle.getArduinoPin('Y');
      if (pinY === null) return () => {};

      const states = inputNames.map(() => false);
      const update = () => handle.setPinState(pinY, compute(states));

      const subs = inputNames.map((name, i) =>
        handle.onPinChange(name, (s) => {
          states[i] = isHigh(s);
          update();
        }),
      );

      update();

      return () => {
        subs.forEach((sub) => sub.dispose());
      };
    },
  });
}

const allTrue = (xs: boolean[]) => xs.every(Boolean);
const anyTrue = (xs: boolean[]) => xs.some(Boolean);
const notAll = (xs: boolean[]) => !allTrue(xs);
const notAny = (xs: boolean[]) => !anyTrue(xs);

// ─── Flip-flops (edge-triggered, digital-sim only) ────────────────────────────
// SPICE mode cannot simulate real edge detection at DC; these components are
// therefore digital-only and do not emit a SPICE mapper.
//
// Each FF samples its data inputs on the rising edge of CLK. Q and Qbar are
// driven synchronously.

function edgeTriggeredFF(
  dataPins: ReadonlyArray<string>,
  initial: boolean,
  sample: (state: boolean, inputs: boolean[]) => boolean,
): PartSimulation {
  return definePartSimulation({
    attachEvents: (_element, handle) => {
      const qPin = handle.getArduinoPin('Q');
      const qbarPin = handle.getArduinoPin('Qbar');
      if (qPin === null || qbarPin === null) return () => {};

      let prevClk = false;
      let q = initial;
      const dataStates = dataPins.map(() => false);

      const emit = () => {
        handle.setPinState(qPin, q);
        handle.setPinState(qbarPin, !q);
      };

      const subClk = handle.onPinChange('CLK', (s) => {
        const high = isHigh(s);
        if (!prevClk && high) {
          // Rising edge — latch
          q = sample(q, dataStates);
          emit();
        }
        prevClk = high;
      });

      const subsData = dataPins.map((name, i) =>
        handle.onPinChange(name, (s) => {
          dataStates[i] = isHigh(s);
        }),
      );

      emit(); // Drive initial Q / Qbar

      return () => {
        subClk.dispose();
        subsData.forEach((sub) => sub.dispose());
      };
    },
  });
}

// ─── Exported part records (reused by tests + plugin-style registration) ─────

export const logicGateAnd = twoInputGate((a, b) => a && b);
export const logicGateNand = twoInputGate((a, b) => !(a && b));
export const logicGateOr = twoInputGate((a, b) => a || b);
export const logicGateNor = twoInputGate((a, b) => !(a || b));
export const logicGateXor = twoInputGate((a, b) => a !== b);
export const logicGateXnor = twoInputGate((a, b) => a === b);

export const logicGateAnd3 = nInputGate(['A', 'B', 'C'], allTrue);
export const logicGateOr3 = nInputGate(['A', 'B', 'C'], anyTrue);
export const logicGateNand3 = nInputGate(['A', 'B', 'C'], notAll);
export const logicGateNor3 = nInputGate(['A', 'B', 'C'], notAny);
export const logicGateAnd4 = nInputGate(['A', 'B', 'C', 'D'], allTrue);
export const logicGateOr4 = nInputGate(['A', 'B', 'C', 'D'], anyTrue);
export const logicGateNand4 = nInputGate(['A', 'B', 'C', 'D'], notAll);
export const logicGateNor4 = nInputGate(['A', 'B', 'C', 'D'], notAny);

// D flip-flop: Q ← D on rising CLK
export const flipFlopD = edgeTriggeredFF(['D'], false, (_q, [d]) => d);
// T flip-flop: Q ← Q ⊕ T on rising CLK (toggle when T=1)
export const flipFlopT = edgeTriggeredFF(['T'], false, (q, [t]) => (t ? !q : q));
// JK flip-flop: 00=hold, 10=set, 01=reset, 11=toggle
export const flipFlopJk = edgeTriggeredFF(['J', 'K'], false, (q, [j, k]) => {
  if (j && k) return !q;
  if (j) return true;
  if (k) return false;
  return q;
});

export const logicGateNot: PartSimulation = definePartSimulation({
  attachEvents: (_element, handle) => {
    const pinY = handle.getArduinoPin('Y');
    if (pinY === null) return () => {};

    const sub = handle.onPinChange('A', (s) => {
      handle.setPinState(pinY, !isHigh(s));
    });

    handle.setPinState(pinY, true); // NOT LOW = HIGH (initial LOW input → HIGH output)

    return () => sub.dispose();
  },
});

/**
 * Register every LogicGateParts entry on the given registry via the SDK
 * `registerSdkPart` path — this file is the reference migration for
 * CORE-002c. Called once at boot by `src/builtin/registerCoreParts.ts`.
 */
export function registerLogicGateParts(registry: PartRegistry): void {
  registry.registerSdkPart('logic-gate-and', logicGateAnd);
  registry.registerSdkPart('logic-gate-nand', logicGateNand);
  registry.registerSdkPart('logic-gate-or', logicGateOr);
  registry.registerSdkPart('logic-gate-nor', logicGateNor);
  registry.registerSdkPart('logic-gate-xor', logicGateXor);
  registry.registerSdkPart('logic-gate-xnor', logicGateXnor);

  registry.registerSdkPart('logic-gate-and-3', logicGateAnd3);
  registry.registerSdkPart('logic-gate-or-3', logicGateOr3);
  registry.registerSdkPart('logic-gate-nand-3', logicGateNand3);
  registry.registerSdkPart('logic-gate-nor-3', logicGateNor3);
  registry.registerSdkPart('logic-gate-and-4', logicGateAnd4);
  registry.registerSdkPart('logic-gate-or-4', logicGateOr4);
  registry.registerSdkPart('logic-gate-nand-4', logicGateNand4);
  registry.registerSdkPart('logic-gate-nor-4', logicGateNor4);

  registry.registerSdkPart('flip-flop-d', flipFlopD);
  registry.registerSdkPart('flip-flop-t', flipFlopT);
  registry.registerSdkPart('flip-flop-jk', flipFlopJk);

  registry.registerSdkPart('logic-gate-not', logicGateNot);
}
