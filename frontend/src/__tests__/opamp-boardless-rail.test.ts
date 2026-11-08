/**
 * An LM358 with its V+ pin unwired runs from the logic rail, `vcc_rail`. On a
 * canvas with no board nothing else names that rail, so NetlistBuilder emitted
 * no source for it and the op-amp's supply floated: the seven op-amp examples
 * of the analog gallery, all board-less, solved to nonsense. The follower put
 * out 0.106 V for 1.5-3.5 V in, while the floating rail wandered up to 26 V
 * (velxio/velxio-prod#126).
 *
 * It is a regression of 54936ef6 (2026-05-15), which replaced the behavioural
 * clamp, whose top was the number `vcc - 1.5`, with the real LM358 macro-model
 * on the `vcc_rail` node. Without a board the rail is 5 V, the supply the
 * behavioural op-amps already assume.
 *
 * Wired supply pins (0b88c1c0) keep their own supply, see
 * spice-opamp-supply-pins.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { analogExamples } from '../data/examples-analog';
import { exampleToBuildNetlistInput } from '../utils/exampleToBuildNetlistInput';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { runNetlist } from './helpers/testSolver';
import type { BuildNetlistInput } from '../simulation/spice/types';

const OPAMP_EXAMPLES = [
  'an-opamp-inverting',
  'an-opamp-non-inverting',
  'an-opamp-follower',
  'an-opamp-summing',
  'an-opamp-integrator',
  'an-opamp-comparator',
  'an-schmitt-trigger',
];

function example(id: string) {
  const ex = analogExamples.find((e) => e.id === id);
  if (!ex) throw new Error(`${id} is not in the analog gallery`);
  return ex;
}

/** Samples of a transient vector after the first 20 % (start-up). */
function settled(v: number[]): number[] {
  return v.slice(Math.floor(v.length * 0.2));
}

function follower(vplus: boolean): BuildNetlistInput {
  const w = (id: string, a: [string, string], b: [string, string]) => ({
    id,
    start: { componentId: a[0], pinName: a[1] },
    end: { componentId: b[0], pinName: b[1] },
  });
  const wires = [
    w('w1', ['src', 'SIG'], ['u1', 'IN+']),
    w('w2', ['u1', 'OUT'], ['u1', 'IN-']),
    w('w3', ['u1', 'OUT'], ['rl', '1']),
    w('w4', ['rl', '2'], ['src', 'GND']),
  ];
  const components: BuildNetlistInput['components'] = [
    {
      id: 'src',
      metadataId: 'signal-generator',
      properties: { waveform: 'dc', offset: 2, amplitude: 0, frequency: 1 },
    },
    { id: 'u1', metadataId: 'opamp-lm358', properties: {} },
    { id: 'rl', metadataId: 'resistor', properties: { value: '10000' } },
  ];
  if (vplus) {
    components.push({
      id: 'ps',
      metadataId: 'power-supply',
      properties: { mode: 'dc', voltage: 12, currentLimit: 1 },
    });
    wires.push(w('w5', ['ps', 'SIG'], ['u1', 'V+']));
    wires.push(w('w6', ['ps', 'GND'], ['src', 'GND']));
    wires.push(w('w7', ['u1', 'V-'], ['src', 'GND']));
  }
  return { components, wires, boards: [], analysis: { kind: 'op' } };
}

describe('LM358 without a board (#126)', () => {
  it('gets a 5 V rail source when its V+ pin is unwired', () => {
    const { netlist } = buildNetlist(follower(false));
    expect(netlist).toMatch(/^X_u1 \S+ \S+ vcc_rail 0 \S+ LM358$/m);
    expect(netlist).toMatch(/^V_VCC_RAIL vcc_rail 0 DC 5$/m);
  });

  it('adds no rail source when its supply pins are wired', async () => {
    const { netlist, pinNetMap } = buildNetlist(follower(true));
    expect(netlist).not.toMatch(/vcc_rail/);
    const r = await runNetlist(netlist);
    expect(r.dcValue(`v(${pinNetMap.get('u1:OUT')})`)).toBeCloseTo(2, 2);
  });

  it(
    'an-opamp-follower tracks its 1.5-3.5 V input',
    { timeout: 60_000 },
    async () => {
      const input = exampleToBuildNetlistInput(example('an-opamp-follower'));
      const { netlist, pinNetMap } = buildNetlist(input);
      const r = await runNetlist(netlist);
      const vin = settled(r.vec(`v(${pinNetMap.get('u1:IN+')})`) as number[]);
      const vout = settled(r.vec(`v(${pinNetMap.get('u1:OUT')})`) as number[]);
      expect(Math.min(...vin)).toBeLessThan(1.6);
      expect(Math.max(...vin)).toBeGreaterThan(3.4);
      const worst = Math.max(...vout.map((v, i) => Math.abs(v - vin[i]!)));
      expect(worst).toBeLessThan(0.02);
    },
  );

  it(
    'an-opamp-comparator swings from near 0 V to the LM358 high level',
    { timeout: 60_000 },
    async () => {
      const input = exampleToBuildNetlistInput(example('an-opamp-comparator'));
      const { netlist, pinNetMap } = buildNetlist(input);
      const r = await runNetlist(netlist);
      const vout = settled(r.vec(`v(${pinNetMap.get('u1:OUT')})`) as number[]);
      expect(Math.min(...vout)).toBeLessThan(0.1);
      // An LM358 on 5 V tops out about 1.5 V under V+ (TI SLOS068, VOH).
      expect(Math.max(...vout)).toBeGreaterThan(3.2);
      expect(Math.max(...vout)).toBeLessThan(4.2);
    },
  );

  it.each(OPAMP_EXAMPLES)('%s runs its LM358 from a steady 5 V rail', { timeout: 60_000 }, async (id) => {
    const input = exampleToBuildNetlistInput(example(id));
    const { netlist } = buildNetlist(input);
    const r = await runNetlist(netlist);
    const rail = r.vec('v(vcc_rail)') as number[];
    expect(Math.min(...rail)).toBeCloseTo(5, 6);
    expect(Math.max(...rail)).toBeCloseTo(5, 6);
  });
});
