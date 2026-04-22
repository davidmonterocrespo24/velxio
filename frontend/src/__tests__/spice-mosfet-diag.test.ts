/**
 * Diagnostic: mimic the exact CircuitScheduler.drain() pipeline to confirm
 * that the key `BasicParts.ts` reads for the LED brightness
 * (`branchCurrents['v_<id>_sense']`) is actually present after a real solve
 * of the mosfet-pwm-led topology with the gate driven by a PWM-equivalent
 * DC voltage.
 */
import { describe, it, expect } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { runNetlist } from '../simulation/spice/SpiceEngine';
import type { BuildNetlistInput } from '../simulation/spice/types';

function buildInput(gateDuty: number): BuildNetlistInput {
  return {
    components: [
      { id: 'rl', metadataId: 'resistor', properties: { value: '220' } },
      { id: 'led1', metadataId: 'led', properties: { color: 'white' } },
      { id: 'q1', metadataId: 'mosfet-2n7000', properties: {} },
      { id: 'rg', metadataId: 'resistor', properties: { value: '100000' } },
    ],
    wires: [
      {
        id: 'w1',
        start: { componentId: 'arduino-uno', pinName: '5V' },
        end: { componentId: 'rl', pinName: '1' },
      },
      {
        id: 'w2',
        start: { componentId: 'rl', pinName: '2' },
        end: { componentId: 'led1', pinName: 'A' },
      },
      {
        id: 'w3',
        start: { componentId: 'led1', pinName: 'C' },
        end: { componentId: 'q1', pinName: 'D' },
      },
      {
        id: 'w4',
        start: { componentId: 'q1', pinName: 'S' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
      },
      {
        id: 'w5',
        start: { componentId: 'arduino-uno', pinName: '9' },
        end: { componentId: 'q1', pinName: 'G' },
      },
      {
        id: 'w6',
        start: { componentId: 'q1', pinName: 'G' },
        end: { componentId: 'rg', pinName: '1' },
      },
      {
        id: 'w7',
        start: { componentId: 'rg', pinName: '2' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
      },
    ],
    boards: [
      {
        id: 'arduino-uno',
        vcc: 5,
        pins: {
          '5V': { type: 'digital', v: 5 },
          GND: { type: 'digital', v: 0 },
          '9': { type: 'pwm', duty: gateDuty },
        },
        groundPinNames: ['GND'],
        vccPinNames: ['5V'],
      },
    ],
    analysis: { kind: 'op' },
  };
}

describe('MOSFET PWM LED — scheduler key diagnostic', () => {
  it(
    'prints the full variableNames list and shows which keys land in branchCurrents',
    { timeout: 30_000 },
    async () => {
      const { netlist } = buildNetlist(buildInput(1.0)); // 100% duty = full on

      console.log('\n=== NETLIST ===\n' + netlist + '\n==============');

      const cooked = await runNetlist(netlist);

      console.log('RAW variableNames:', cooked.variableNames);

      // Mirror CircuitScheduler.drain() exactly
      const branchCurrents: Record<string, number> = {};
      for (const name of cooked.variableNames) {
        if (name.startsWith('i(')) {
          const src = name.slice(2, -1);
          const i = cooked.dcValue(name);
          if (Number.isFinite(i)) branchCurrents[src] = i;
        }
      }

      console.log('branchCurrents keys (scheduler-filtered):', Object.keys(branchCurrents));

      console.log('v_led1_sense:', branchCurrents['v_led1_sense']);

      expect(Object.keys(branchCurrents)).toContain('v_led1_sense');
      expect(Math.abs(branchCurrents['v_led1_sense'])).toBeGreaterThan(1e-6);
    },
  );
});
