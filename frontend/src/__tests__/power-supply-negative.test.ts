/**
 * A power supply set to a negative voltage behaves as the mirror image of
 * the positive one (velxio/velxio-prod#133).
 *
 * Its series resistance was max(0.01, V / (1.5 · Ilim)): negative for a
 * negative V, so the clamp left 0.01 Ω. The same supply was almost ideal at
 * -12 V (-11.99988 V on 1 kΩ) and had 8 Ω at +12 V (11.90476 V). A bench
 * channel set to -12 V (the Rigol DP831 has a 0 to -30 V one) regulates and
 * limits exactly like one set to +12 V, so: same load, same limit, the
 * readings change sign and nothing else.
 */
import { describe, it, expect } from 'vitest';
import { solveInput } from './helpers/solveInput';
import type { BuildNetlistInput } from '../simulation/spice/types';

async function loadVolts(voltage: number, currentLimit: number, load: string): Promise<{ v: number; i: number }> {
  const input: BuildNetlistInput = {
    components: [
      { id: 'ps', metadataId: 'power-supply', properties: { mode: 'dc', voltage, currentLimit } },
      { id: 'rl', metadataId: 'resistor', properties: { value: load } },
    ],
    wires: [
      { id: 'w1', start: { componentId: 'ps', pinName: 'SIG' }, end: { componentId: 'rl', pinName: '1' } },
      { id: 'w2', start: { componentId: 'rl', pinName: '2' }, end: { componentId: 'ps', pinName: 'GND' } },
    ],
    boards: [],
    analysis: { kind: 'op' },
  };
  const solve = await solveInput(input);
  const v = solve.nodeVoltages[solve.pinNetMap.get('rl:1')!]!;
  return { v, i: v / Number(load) };
}

describe('a negative setpoint mirrors the positive one', () => {
  for (const [limit, load] of [
    [1, '1000'],
    [0.1, '1000'],
    [0.1, '50'],
  ] as const) {
    it(`±12 V, ${limit} A limit, ${load} Ω load`, async () => {
      const plus = await loadVolts(12, limit, load);
      const minus = await loadVolts(-12, limit, load);
      expect(plus.v).toBeGreaterThan(0);
      expect(Math.abs(minus.v + plus.v)).toBeLessThan(Math.abs(plus.v) * 1e-6);
    });
  }
});
