/**
 * ChipParts.ts — Simulation logic for complex IC chips
 *
 * Implements:
 *  - 74HC595 8-bit Serial-to-Parallel Shift Register
 *  - wokwi-7segment display (driven by 74HC595 outputs)
 */

import { PartSimulationRegistry } from './PartSimulationRegistry';
import { useSimulatorStore } from '../../store/useSimulatorStore';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Given a 74HC595 component ID and a pin name (e.g. 'Q0'), find the DOM element
 * of whatever component is connected on the other side of that wire, plus the
 * pin name on that component.
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
    A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, DP: 7,
  };
  const idx = segmentIndex[pinName.toUpperCase()];
  if (idx === undefined) return;

  const el = element as any;
  const current: number[] = Array.isArray(el.values) ? [...el.values] : [0, 0, 0, 0, 0, 0, 0, 0];
  current[idx] = state ? 1 : 0;
  el.values = current;
}

// ─── 74HC595 simulation ───────────────────────────────────────────────────────

PartSimulationRegistry.register('74hc595', {
  attachEvents: (element, simulator, getArduinoPinHelper) => {
    const pinManager = (simulator as any).pinManager;
    if (!pinManager) return () => {};

    // Internal state
    let shiftReg = 0;    // 8-bit shift register
    let storageReg = 0;  // 8-bit storage register (output)
    let oeActive = false; // output enable (active low)
    let mrActive = true;  // master reset (active low — HIGH = not reset)

    let prevShcp = false;
    let prevStcp = false;

    // Resolve connected Arduino pins
    const pinDS   = getArduinoPinHelper('DS');
    const pinSHCP = getArduinoPinHelper('SHCP');
    const pinSTCP = getArduinoPinHelper('STCP');
    const pinMR   = getArduinoPinHelper('MR');
    const pinOE   = getArduinoPinHelper('OE');

    const unsubscribers: (() => void)[] = [];

    // Helper: propagate current storage reg outputs to connected components
    const propagateOutputs = () => {
      if (!oeActive) return; // outputs disabled (OE high = disabled)
      const compId = element.id;

      // Q0-Q7 maps to bits 0-7 of storageReg
      const outputPins = ['Q0', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'];
      for (let i = 0; i < 8; i++) {
        const state = ((storageReg >> i) & 1) === 1;
        const connected = getConnectedToPin(compId, outputPins[i]);
        if (connected) {
          // Update 7-segment or LED or any other component
          const tagName = connected.element.tagName.toLowerCase();
          if (tagName === 'wokwi-7segment') {
            set7SegPin(connected.element, connected.pinName, state);
          } else if (tagName === 'wokwi-led') {
            (connected.element as any).value = state ? 1 : 0;
          }
          // Update 74HC595 chained via Q7S
          if (tagName === 'wokwi-74hc595' && outputPins[i] === 'Q7S') {
            // Q7S is serial out — drives DS of next chip (handled via wire logic)
          }
        }
      }

      // Update this element's visual (Q0-Q7 output dots)
      const el = element as any;
      el.values = outputPins.map((_, i) => ((storageReg >> i) & 1));

      // Also propagate Q7S (serial output = bit 7 of shift register, not storage)
      const q7sConn = getConnectedToPin(element.id, 'Q7S');
      if (q7sConn) {
        // Q7S is used to chain to the DS pin of next 74HC595 — this is handled
        // by the DS monitoring of the downstream chip
      }
    };

    // OE (active low — LOW enables outputs)
    if (pinOE !== null) {
      pinManager.triggerPinChange(pinOE, true); // default HIGH = disabled
      unsubscribers.push(pinManager.onPinChange(pinOE, (_: number, state: boolean) => {
        oeActive = !state; // OE low = active
        propagateOutputs();
      }));
    } else {
      oeActive = true; // assume OE tied to GND (always enabled)
    }

    // MR (active low — LOW resets shift register)
    if (pinMR !== null) {
      unsubscribers.push(pinManager.onPinChange(pinMR, (_: number, state: boolean) => {
        mrActive = state; // MR high = no reset, low = reset
        if (!mrActive) {
          shiftReg = 0;
        }
      }));
    } else {
      mrActive = true; // assume MR tied high
    }

    // DS — latched on SHCP rising edge; just track current value
    let dsState = false;
    if (pinDS !== null) {
      unsubscribers.push(pinManager.onPinChange(pinDS, (_: number, state: boolean) => {
        dsState = state;
      }));
    }

    // SHCP — rising edge shifts DS into shift register
    if (pinSHCP !== null) {
      unsubscribers.push(pinManager.onPinChange(pinSHCP, (_: number, state: boolean) => {
        if (state && !prevShcp) {
          // Rising edge
          if (mrActive) {
            // Shift: MSB shifts out via Q7S, DS enters at LSB
            shiftReg = ((shiftReg << 1) | (dsState ? 1 : 0)) & 0xFF;
          }
        }
        prevShcp = state;
      }));
    }

    // STCP — rising edge latches shift register to storage register
    if (pinSTCP !== null) {
      unsubscribers.push(pinManager.onPinChange(pinSTCP, (_: number, state: boolean) => {
        if (state && !prevStcp) {
          // Rising edge — latch
          storageReg = shiftReg;
          propagateOutputs();
        }
        prevStcp = state;
      }));
    }

    // Initial state propagation
    propagateOutputs();

    return () => unsubscribers.forEach(u => u());
  },
});

// ─── 7-segment display (direct-drive, when connected directly to Arduino) ────

PartSimulationRegistry.register('7segment', {
  attachEvents: (element, simulator, getArduinoPinHelper) => {
    const pinManager = (simulator as any).pinManager;
    if (!pinManager) return () => {};

    const unsubscribers: (() => void)[] = [];

    const segments = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP'];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const arduinoPin = getArduinoPinHelper(seg);
      if (arduinoPin !== null) {
        unsubscribers.push(pinManager.onPinChange(arduinoPin, (_: number, state: boolean) => {
          set7SegPin(element, seg, state);
        }));
      }
    }

    return () => unsubscribers.forEach(u => u());
  },
  // Called by SimulatorCanvas for boards without a local simulator (e.g. ESP32 via QEMU backend).
  // pinName is the segment identifier (A, B, C, D, E, F, G, DP).
  onPinStateChange: (pinName: string, state: boolean, element: HTMLElement) => {
    set7SegPin(element, pinName, state);
  },
});
