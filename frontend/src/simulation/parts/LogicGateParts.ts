/**
 * LogicGateParts.ts — Simulation logic for logic gate components.
 *
 * All gates listen to their input pins via pinManager.onPinChange,
 * compute the boolean output, and drive the Y pin accordingly.
 *
 * 2-input gates: A, B → Y
 * NOT gate:      A    → Y
 */

import { PartSimulationRegistry } from './PartSimulationRegistry';
import type { PartSimulationLogic } from './PartSimulationRegistry';

// ─── Helper ───────────────────────────────────────────────────────────────────

function twoInputGate(compute: (a: boolean, b: boolean) => boolean): PartSimulationLogic {
  return {
    attachEvents: (element, simulator, getPin) => {
      const pinA = getPin('A');
      const pinB = getPin('B');
      const pinY = getPin('Y');

      if (pinA === null || pinB === null || pinY === null) return () => {};

      let stateA = false;
      let stateB = false;

      const update = () => simulator.setPinState(pinY, compute(stateA, stateB));

      const unsubA = simulator.pinManager.onPinChange(pinA, (_: number, s: boolean) => {
        stateA = s;
        update();
      });
      const unsubB = simulator.pinManager.onPinChange(pinB, (_: number, s: boolean) => {
        stateB = s;
        update();
      });

      update(); // Drive Y immediately with initial LOW state

      return () => {
        unsubA();
        unsubB();
      };
    },
  };
}

// ─── AND ──────────────────────────────────────────────────────────────────────
PartSimulationRegistry.register(
  'logic-gate-and',
  twoInputGate((a, b) => a && b),
);

// ─── NAND ─────────────────────────────────────────────────────────────────────
PartSimulationRegistry.register(
  'logic-gate-nand',
  twoInputGate((a, b) => !(a && b)),
);

// ─── OR ───────────────────────────────────────────────────────────────────────
PartSimulationRegistry.register(
  'logic-gate-or',
  twoInputGate((a, b) => a || b),
);

// ─── NOR ──────────────────────────────────────────────────────────────────────
PartSimulationRegistry.register(
  'logic-gate-nor',
  twoInputGate((a, b) => !(a || b)),
);

// ─── XOR ──────────────────────────────────────────────────────────────────────
PartSimulationRegistry.register(
  'logic-gate-xor',
  twoInputGate((a, b) => a !== b),
);

// ─── XNOR ─────────────────────────────────────────────────────────────────────
PartSimulationRegistry.register(
  'logic-gate-xnor',
  twoInputGate((a, b) => a === b),
);

// ─── Multi-input gates (3 / 4 inputs) ─────────────────────────────────────────

function nInputGate(
  inputNames: string[],
  compute: (inputs: boolean[]) => boolean,
): PartSimulationLogic {
  return {
    attachEvents: (element, simulator, getPin) => {
      const inputPins = inputNames.map((n) => getPin(n));
      const pinY = getPin('Y');

      if (inputPins.some((p) => p === null) || pinY === null) return () => {};

      const states = inputNames.map(() => false);
      const update = () => simulator.setPinState(pinY, compute(states));

      const unsubs = inputPins.map((p, i) =>
        simulator.pinManager.onPinChange(p!, (_: number, s: boolean) => {
          states[i] = s;
          update();
        }),
      );

      update();

      return () => {
        unsubs.forEach((u) => u());
      };
    },
  };
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
  dataPins: string[],
  initial: boolean,
  sample: (state: boolean, inputs: boolean[]) => boolean,
): PartSimulationLogic {
  return {
    attachEvents: (element, simulator, getPin) => {
      const clkPin = getPin('CLK');
      const qPin = getPin('Q');
      const qbarPin = getPin('Qbar');
      const dataPinIds = dataPins.map((n) => getPin(n));

      if (clkPin === null || qPin === null || qbarPin === null) return () => {};
      if (dataPinIds.some((p) => p === null)) return () => {};

      let prevClk = false;
      let q = initial;
      const dataStates = dataPins.map(() => false);

      const emit = () => {
        simulator.setPinState(qPin, q);
        simulator.setPinState(qbarPin, !q);
      };

      const unsubClk = simulator.pinManager.onPinChange(clkPin, (_: number, s: boolean) => {
        if (!prevClk && s) {
          // Rising edge
          q = sample(q, dataStates);
          emit();
        }
        prevClk = s;
      });

      const unsubData = dataPinIds.map((p, i) =>
        simulator.pinManager.onPinChange(p!, (_: number, s: boolean) => {
          dataStates[i] = s;
        }),
      );

      emit(); // Drive initial Q / Qbar

      return () => {
        unsubClk();
        unsubData.forEach((u) => u());
      };
    },
  };
}

// D flip-flop: Q ← D on rising CLK
PartSimulationRegistry.register(
  'flip-flop-d',
  edgeTriggeredFF(['D'], false, (_q, [d]) => d),
);

// T flip-flop: Q ← Q ⊕ T on rising CLK (toggle when T=1)
PartSimulationRegistry.register(
  'flip-flop-t',
  edgeTriggeredFF(['T'], false, (q, [t]) => (t ? !q : q)),
);

// JK flip-flop:
//   J=0, K=0 → hold
//   J=1, K=0 → set (Q=1)
//   J=0, K=1 → reset (Q=0)
//   J=1, K=1 → toggle
PartSimulationRegistry.register(
  'flip-flop-jk',
  edgeTriggeredFF(['J', 'K'], false, (q, [j, k]) => {
    if (j && k) return !q;
    if (j) return true;
    if (k) return false;
    return q;
  }),
);

PartSimulationRegistry.register('logic-gate-and-3', nInputGate(['A', 'B', 'C'], allTrue));
PartSimulationRegistry.register('logic-gate-or-3', nInputGate(['A', 'B', 'C'], anyTrue));
PartSimulationRegistry.register('logic-gate-nand-3', nInputGate(['A', 'B', 'C'], notAll));
PartSimulationRegistry.register('logic-gate-nor-3', nInputGate(['A', 'B', 'C'], notAny));
PartSimulationRegistry.register('logic-gate-and-4', nInputGate(['A', 'B', 'C', 'D'], allTrue));
PartSimulationRegistry.register('logic-gate-or-4', nInputGate(['A', 'B', 'C', 'D'], anyTrue));
PartSimulationRegistry.register('logic-gate-nand-4', nInputGate(['A', 'B', 'C', 'D'], notAll));
PartSimulationRegistry.register('logic-gate-nor-4', nInputGate(['A', 'B', 'C', 'D'], notAny));

// ─── NOT (inverter) ───────────────────────────────────────────────────────────
PartSimulationRegistry.register('logic-gate-not', {
  attachEvents: (element, simulator, getPin) => {
    const pinA = getPin('A');
    const pinY = getPin('Y');

    if (pinA === null || pinY === null) return () => {};

    const unsub = simulator.pinManager.onPinChange(pinA, (_: number, s: boolean) => {
      simulator.setPinState(pinY, !s);
    });

    simulator.setPinState(pinY, true); // NOT LOW = HIGH (initial LOW input → HIGH output)

    return unsub;
  },
});
