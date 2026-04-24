/**
 * ChipParts.ts — Simulation logic for complex IC chips.
 *
 * Implements:
 *  - 74HC595 8-bit Serial-to-Parallel Shift Register
 *  - wokwi-7segment display (direct-drive or 74HC595-driven)
 *
 * Migrated in CORE-002c-step4 from the legacy host shape to the SDK
 * `PartSimulation` contract. `pinManager.triggerPinChange(pin, true)`
 * (used to default OE HIGH) is now `handle.setPinState(pin, true)` —
 * the SDK handle's direct pin drive is semantically equivalent from
 * the component side.
 */

import type { PartSimulation, PinState } from '@velxio/sdk';
import { definePartSimulation } from '@velxio/sdk';
import type { PartRegistry } from './PartSimulationRegistry';
import { useSimulatorStore } from '../../store/useSimulatorStore';

const isHigh = (state: PinState): boolean => state === 1;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Given a 74HC595 component ID and a pin name (e.g. 'Q0'), find the DOM
 * element of whatever component is connected on the other side of that
 * wire, plus the pin name on that component.
 */
function getConnectedToPin(
  componentId: string,
  pinName: string,
): { element: HTMLElement; pinName: string } | null {
  const { wires } = useSimulatorStore.getState();
  for (const wire of wires) {
    let otherCompId: string | null = null;
    let otherPin: string | null = null;

    if (wire.start.componentId === componentId && wire.start.pinName === pinName) {
      otherCompId = wire.end.componentId;
      otherPin = wire.end.pinName;
    } else if (wire.end.componentId === componentId && wire.end.pinName === pinName) {
      otherCompId = wire.start.componentId;
      otherPin = wire.start.pinName;
    }

    if (otherCompId && otherPin) {
      const el = document.getElementById(otherCompId);
      if (el) return { element: el as HTMLElement, pinName: otherPin };
    }
  }
  return null;
}

/**
 * Update a 7-segment display element when pin states change.
 * pinName is the segment identifier (A, B, C, D, E, F, G, DP).
 * state is whether the segment is lit (HIGH = lit for common-cathode).
 */
function set7SegPin(element: HTMLElement, pinName: string, state: boolean) {
  const segmentIndex: Record<string, number> = {
    A: 0,
    B: 1,
    C: 2,
    D: 3,
    E: 4,
    F: 5,
    G: 6,
    DP: 7,
  };
  const idx = segmentIndex[pinName.toUpperCase()];
  if (idx === undefined) return;

  const el = element as HTMLElement & { values?: number[] };
  const current: number[] = Array.isArray(el.values) ? [...el.values] : [0, 0, 0, 0, 0, 0, 0, 0];
  current[idx] = state ? 1 : 0;
  el.values = current;
}

// ─── 74HC595 8-bit Serial-to-Parallel Shift Register ─────────────────────────

export const hc595Part: PartSimulation = definePartSimulation({
  attachEvents: (element, handle) => {
    let shiftReg = 0;
    let storageReg = 0;
    let oeActive = false;
    let mrActive = true;

    let prevShcp = false;
    let prevStcp = false;
    let dsState = false;

    const pinOE = handle.getArduinoPin('OE');
    const pinMR = handle.getArduinoPin('MR');

    const disposables: Array<{ dispose(): void }> = [];

    const propagateOutputs = () => {
      if (!oeActive) return; // outputs disabled (OE high = disabled)

      const outputPins = ['Q0', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'];
      for (let i = 0; i < 8; i++) {
        const state = ((storageReg >> i) & 1) === 1;
        const connected = getConnectedToPin(handle.componentId, outputPins[i]);
        if (connected) {
          const tagName = connected.element.tagName.toLowerCase();
          if (tagName === 'wokwi-7segment') {
            set7SegPin(connected.element, connected.pinName, state);
          } else if (tagName === 'wokwi-led') {
            (connected.element as HTMLElement & { value: number }).value = state ? 1 : 0;
          }
        }
      }

      const el = element as HTMLElement & { values: number[] };
      el.values = outputPins.map((_, i) => (storageReg >> i) & 1);
    };

    // OE (active low — LOW enables outputs). Default the pin HIGH from the
    // component side so downstream logic sees a stable "disabled" state
    // until the user drives OE.
    if (pinOE !== null) {
      handle.setPinState(pinOE, true);
      disposables.push(
        handle.onPinChange('OE', (s) => {
          oeActive = !isHigh(s);
          propagateOutputs();
        }),
      );
    } else {
      oeActive = true; // assume OE tied to GND (always enabled)
    }

    // MR (active low — LOW resets shift register)
    if (pinMR !== null) {
      disposables.push(
        handle.onPinChange('MR', (s) => {
          mrActive = isHigh(s);
          if (!mrActive) shiftReg = 0;
        }),
      );
    } else {
      mrActive = true; // assume MR tied high
    }

    // DS — latched on SHCP rising edge; just track current value
    if (handle.getArduinoPin('DS') !== null) {
      disposables.push(
        handle.onPinChange('DS', (s) => {
          dsState = isHigh(s);
        }),
      );
    }

    // SHCP — rising edge shifts DS into shift register
    if (handle.getArduinoPin('SHCP') !== null) {
      disposables.push(
        handle.onPinChange('SHCP', (s) => {
          const state = isHigh(s);
          if (state && !prevShcp && mrActive) {
            shiftReg = ((shiftReg << 1) | (dsState ? 1 : 0)) & 0xff;
          }
          prevShcp = state;
        }),
      );
    }

    // STCP — rising edge latches shift register to storage register
    if (handle.getArduinoPin('STCP') !== null) {
      disposables.push(
        handle.onPinChange('STCP', (s) => {
          const state = isHigh(s);
          if (state && !prevStcp) {
            storageReg = shiftReg;
            propagateOutputs();
          }
          prevStcp = state;
        }),
      );
    }

    propagateOutputs();

    return () => disposables.forEach((d) => d.dispose());
  },
});

// ─── 7-segment display (direct-drive) ────────────────────────────────────────

export const sevenSegmentPart: PartSimulation = definePartSimulation({
  attachEvents: (element, handle) => {
    const segments = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP'];
    const disposables: Array<{ dispose(): void }> = [];

    for (const seg of segments) {
      if (handle.getArduinoPin(seg) === null) continue;
      disposables.push(
        handle.onPinChange(seg, (s) => {
          set7SegPin(element, seg, isHigh(s));
        }),
      );
    }

    return () => disposables.forEach((d) => d.dispose());
  },
  // Called by SimulatorCanvas for boards without a local simulator (e.g. ESP32
  // via QEMU backend). pinName is the segment identifier (A, B, C, D, E, F,
  // G, DP).
  onPinStateChange: (pinName, state, element) => {
    set7SegPin(element, pinName, state);
  },
});

// ─── Seeding ──────────────────────────────────────────────────────────────────

/**
 * Register every ChipParts entry on the given registry. Called once at
 * boot by `src/builtin/registerCoreParts.ts`.
 */
export function registerChipParts(registry: PartRegistry): void {
  registry.registerSdkPart('74hc595', hc595Part);
  registry.registerSdkPart('7segment', sevenSegmentPart);
}
