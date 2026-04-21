/**
 * Diagnostic: NPN Transistor LED Switch example
 * Verifies SPICE behavior in both pin-9-HIGH and pin-9-LOW states.
 * Reproduces the user-reported "LED stays on always" symptom.
 */
import { describe, it, expect } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { runNetlist } from '../simulation/spice/SpiceEngine';
import type { BuildNetlistInput, PinSourceState } from '../simulation/spice/types';

function buildInput(pin9State: 'HIGH' | 'LOW'): BuildNetlistInput {
  const pins: Record<string, PinSourceState> = {
    '5V': { type: 'digital', v: 5 },
    GND: { type: 'digital', v: 0 },
  };
  if (pin9State === 'HIGH') {
    pins['9'] = { type: 'digital', v: 5 };
  }
  // LOW: mirror production collectPinStates behavior — pin 9 is omitted.

  return {
    components: [
      { id: 'rb', metadataId: 'resistor', properties: { value: '1000' } },
      { id: 'rc', metadataId: 'resistor', properties: { value: '220' } },
      { id: 'led1', metadataId: 'led', properties: { color: 'green' } },
      { id: 'q1', metadataId: 'bjt-2n2222', properties: {} },
    ],
    wires: [
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
    ],
    boards: [
      {
        id: 'arduino-uno',
        vcc: 5,
        pins,
        groundPinNames: ['GND'],
        vccPinNames: ['5V'],
      },
    ],
    analysis: { kind: 'op' },
  };
}

async function solveAndGetLedCurrent(
  pin9: 'HIGH' | 'LOW',
): Promise<{ current: number; netlist: string }> {
  const { netlist } = buildNetlist(buildInput(pin9));
  const cooked = await runNetlist(netlist);
  const branchCurrents: Record<string, number> = {};
  for (const name of cooked.variableNames) {
    if (name.startsWith('i(')) {
      const src = name.slice(2, -1);
      const i = cooked.dcValue(name);
      if (Number.isFinite(i)) branchCurrents[src] = i;
    }
  }
  return { current: Math.abs(branchCurrents['v_led1_sense'] ?? 0), netlist };
}

describe('NPN Transistor Switch — diagnostic', () => {
  it('pin 9 HIGH: LED conducts ~20 mA', { timeout: 30_000 }, async () => {
    const { current, netlist } = await solveAndGetLedCurrent('HIGH');

    console.log('\n=== NETLIST (pin9=HIGH) ===\n' + netlist);

    console.log('LED current (HIGH):', current);
    expect(current).toBeGreaterThan(5e-3);
  });

  it(
    'pin 9 LOW: LED current should be ~0 (user reports it stays lit)',
    { timeout: 30_000 },
    async () => {
      const { current, netlist } = await solveAndGetLedCurrent('LOW');

      console.log('\n=== NETLIST (pin9=LOW) ===\n' + netlist);

      console.log('LED current (LOW):', current);
      // If this fails with >1µA, we have reproduced the bug.
      expect(current).toBeLessThan(1e-6);
    },
  );
});
