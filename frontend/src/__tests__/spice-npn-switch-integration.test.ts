/**
 * End-to-end integration test for the npn-led-switch example.
 *
 * Runs a real AVR sketch that toggles pin 9 HIGH/LOW in a loop and exercises
 * the complete solve pipeline:
 *   AVR port listener → PinManager → collectPinStates → NetlistBuilder →
 *   ngspice → branchCurrents
 *
 * This is the first test that can detect bugs *between* the PinManager and
 * the SPICE netlist (the layer the `spice-npn-switch-diag.test.ts` skipped).
 */
import { describe, it, expect } from 'vitest';
import { AVRTestHarness, assemble, LDI, OUT, RJMP } from './helpers/avrTestHarness';
import { PinManager } from '../simulation/PinManager';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { runNetlist } from '../simulation/spice/SpiceEngine';
import type { BuildNetlistInput, PinSourceState } from '../simulation/spice/types';
import { BOARD_PIN_GROUPS } from '../simulation/spice/boardPinGroups';

// ── Production collectPinStates, copied verbatim for test ─────────────────
// If this test ever diverges from subscribeToStore.ts, update both.
function collectPinStates(
  pm: PinManager,
  wires: Array<{
    start: { componentId: string; pinName: string };
    end: { componentId: string; pinName: string };
  }>,
  boardId = 'arduino-uno',
): Record<string, PinSourceState> {
  const group = BOARD_PIN_GROUPS['arduino-uno'] ?? BOARD_PIN_GROUPS.default;
  const vcc = group.vcc;
  const result: Record<string, PinSourceState> = {};
  const pinNames = new Set<string>();
  for (const w of wires) {
    if (w.start.componentId === boardId) pinNames.add(w.start.pinName);
    if (w.end.componentId === boardId) pinNames.add(w.end.pinName);
  }
  for (const pinName of pinNames) {
    if (group.gnd.includes(pinName) || group.vcc_pins.includes(pinName)) continue;
    const arduinoPin = /^\d+$/.test(pinName) ? parseInt(pinName, 10) : -1;
    if (arduinoPin < 0) continue;
    const pwmDuty = pm.getPwmValue(arduinoPin);
    if (pwmDuty > 0) {
      result[pinName] = { type: 'pwm', duty: pwmDuty };
    } else if (pm.getPinState(arduinoPin)) {
      result[pinName] = { type: 'digital', v: vcc };
    }
  }
  return result;
}

function npnSwitchWires() {
  return [
    {
      id: 'w1',
      start: { componentId: 'arduino-uno', pinName: '9' },
      end: { componentId: 'rb', pinName: '1' },
    },
    {
      id: 'w2',
      start: { componentId: 'rb', pinName: '2' },
      end: { componentId: 'q1', pinName: 'B' },
    },
    {
      id: 'w3',
      start: { componentId: 'arduino-uno', pinName: '5V' },
      end: { componentId: 'rc', pinName: '1' },
    },
    {
      id: 'w4',
      start: { componentId: 'rc', pinName: '2' },
      end: { componentId: 'led1', pinName: 'A' },
    },
    {
      id: 'w5',
      start: { componentId: 'led1', pinName: 'C' },
      end: { componentId: 'q1', pinName: 'C' },
    },
    {
      id: 'w6',
      start: { componentId: 'q1', pinName: 'E' },
      end: { componentId: 'arduino-uno', pinName: 'GND' },
    },
  ];
}

function npnSwitchInput(pinStates: Record<string, PinSourceState>): BuildNetlistInput {
  return {
    components: [
      { id: 'rb', metadataId: 'resistor', properties: { value: '1000' } },
      { id: 'rc', metadataId: 'resistor', properties: { value: '220' } },
      { id: 'led1', metadataId: 'led', properties: { color: 'green' } },
      { id: 'q1', metadataId: 'bjt-2n2222', properties: {} },
    ],
    wires: npnSwitchWires(),
    boards: [
      {
        id: 'arduino-uno',
        vcc: 5,
        pins: pinStates,
        groundPinNames: ['GND'],
        vccPinNames: ['5V'],
      },
    ],
    analysis: { kind: 'op' },
  };
}

/**
 * AVR program: toggle PORTB bit 1 (pin 9) on/off in a tight loop.
 *   DDRB  = 0x02  (pin 9 output)
 *   PORTB = 0x02, RJMP back; PORTB = 0x00, RJMP back
 * Host calls runCycles(N) then reads PORTB to check pin 9 state.
 */
function pin9ToggleProgram(): Uint16Array {
  return assemble([
    LDI(16, 0x02),
    OUT(0x04, 16), // DDRB = 0x02 (bit 1 = pin 9 output)
    LDI(16, 0x02),
    OUT(0x05, 16), // PORTB = 0x02 (pin 9 HIGH)
    LDI(16, 0x00),
    OUT(0x05, 16), // PORTB = 0x00 (pin 9 LOW)
    RJMP(-5), // loop back — will toggle HIGH again
  ]);
}

describe('NPN LED switch — integration pipeline', () => {
  it(
    'pin 9 toggled by AVR → PinManager → SPICE produces correct LED currents',
    { timeout: 60_000 },
    async () => {
      const avr = new AVRTestHarness();
      avr.loadProgram(pin9ToggleProgram());
      const pm = new PinManager();

      // Mirror AVRSimulator wiring: PORTB listener → PinManager.updatePort.
      let lastPortB = 0;
      avr.ports.B.addListener((value: number) => {
        if (value !== lastPortB) {
          pm.updatePort('PORTB', value, lastPortB);
          lastPortB = value;
        }
      });

      // Step cycle by cycle until pin 9 goes HIGH after the second OUT instruction.
      let highCycle = -1;
      for (let i = 0; i < 2000 && highCycle < 0; i++) {
        avr.runCycles(1);
        if (pm.getPinState(9)) highCycle = i;
      }

      console.log('pin 9 went HIGH after', highCycle, 'cycles');
      expect(highCycle).toBeGreaterThanOrEqual(0);

      // Solve with pin 9 HIGH and assert LED conducts.
      const highPins = collectPinStates(pm, npnSwitchWires());

      console.log('pinStates after HIGH write:', highPins);
      expect(highPins['9']).toEqual({ type: 'digital', v: 5 });

      const { netlist: nlHigh } = buildNetlist(npnSwitchInput(highPins));
      const cookedHigh = await runNetlist(nlHigh);
      const iHigh = Math.abs(cookedHigh.dcValue('i(v_led1_sense)'));

      console.log('HIGH: LED current =', iHigh, 'A');
      expect(iHigh).toBeGreaterThan(5e-3);

      // Advance AVR by enough cycles for the OUT(PORTB, 0x00) to fire.
      let lowCycle = -1;
      for (let i = 0; i < 2000 && lowCycle < 0; i++) {
        avr.runCycles(1);
        if (!pm.getPinState(9)) lowCycle = i;
      }

      console.log('pin 9 went LOW after', lowCycle, 'additional cycles');
      expect(lowCycle).toBeGreaterThanOrEqual(0);

      const lowPins = collectPinStates(pm, npnSwitchWires());

      console.log('pinStates after LOW write:', lowPins);
      expect(lowPins['9']).toBeUndefined();

      const { netlist: nlLow } = buildNetlist(npnSwitchInput(lowPins));

      console.log('\n=== NETLIST (after AVR LOW) ===\n' + nlLow);
      const cookedLow = await runNetlist(nlLow);
      const iLow = Math.abs(cookedLow.dcValue('i(v_led1_sense)'));

      console.log('LOW: LED current =', iLow, 'A');
      expect(iLow).toBeLessThan(1e-6);
    },
  );
});
