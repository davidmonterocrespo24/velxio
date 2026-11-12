/**
 * A linear regulator cannot drive its output past ground (velxio/velxio-prod#130).
 *
 * The behavioural regulators were V = min(VIN - 2, 5) and the like, with no
 * floor: with 0 V in a 7805 put out -2 V (-20 mA into 100 Ohm), a 7905 +2 V
 * and an LM317 -2 V. A 78xx's pass transistor only sources from VIN, and "the
 * output of the device does not sink current" (TI LM340 / LM7805, 8.1.2). The
 * current mirror that draws the output current out of VIN then pushed that
 * negative current back into VIN, so the gallery's 5 V supply started its
 * transient with the reservoir capacitor already at 2 V.
 */
import { describe, it, expect } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { exampleProjects } from '../data/examples';
import { exampleToBuildNetlistInput } from '../utils/exampleToBuildNetlistInput';
import { runNetlist } from './helpers/testSolver';
import type { BuildNetlistInput } from '../simulation/spice/types';

type Wire = BuildNetlistInput['wires'][number];
const w = (id: string, a: [string, string], b: [string, string]): Wire => ({
  id,
  start: { componentId: a[0], pinName: a[1] },
  end: { componentId: b[0], pinName: b[1] },
});

/**
 * `vin` volts on the regulator's input (minus for the 7905), a 100 Ohm load.
 * The LM317 sets 5 V with 240 Ohm from VOUT to ADJ and 720 Ohm to ground.
 */
async function regulate(part: string, vin: number) {
  const ref = part === 'reg-lm317' ? 'ADJ' : 'GND';
  const components: BuildNetlistInput['components'] = [
    {
      id: 'src',
      metadataId: 'signal-generator',
      properties: { waveform: 'dc', offset: vin, amplitude: 0, frequency: 1 },
    },
    { id: 'u1', metadataId: part, properties: {} },
    { id: 'rl', metadataId: 'resistor', properties: { value: '100' } },
  ];
  const wires = [
    w('w1', ['src', 'SIG'], ['u1', 'VIN']),
    w('w2', ['u1', 'VOUT'], ['rl', '1']),
    w('w3', ['rl', '2'], ['src', 'GND']),
  ];
  if (part === 'reg-lm317') {
    components.push(
      { id: 'r1', metadataId: 'resistor', properties: { value: '240' } },
      { id: 'r2', metadataId: 'resistor', properties: { value: '720' } },
    );
    wires.push(
      w('w4', ['u1', 'VOUT'], ['r1', '1']),
      w('w5', ['r1', '2'], ['u1', ref]),
      w('w6', ['u1', ref], ['r2', '1']),
      w('w7', ['r2', '2'], ['src', 'GND']),
    );
  } else {
    wires.push(w('w4', ['u1', ref], ['src', 'GND']));
  }
  const { netlist, pinNetMap } = buildNetlist({ components, wires, boards: [], analysis: { kind: 'op' } });
  const r = await runNetlist(netlist);
  return {
    vout: r.dcValue(`v(${pinNetMap.get('u1:VOUT')})`),
    // The source's own branch: what the regulator takes from (or pushes into) it.
    sourceAmps: r.dcValue('i(v_src)'),
  };
}

describe('regulators have a floor (#130)', () => {
  it.each([
    ['reg-7805', 0],
    ['reg-7812', 0],
    ['reg-7905', 0],
    ['reg-lm317', 0],
    ['reg-7805', 1.5],
    ['reg-7905', -1.5],
  ])('%s with %s V in puts out 0 V and pushes nothing into its input', async (part, vin) => {
    const s = await regulate(part, vin);
    expect(s.vout).toBeCloseTo(0, 6);
    expect(s.sourceAmps).toBeCloseTo(0, 6);
  });

  it.each([
    ['reg-7805', 4, 2],
    ['reg-7805', 9, 5],
    ['reg-7812', 15, 12],
    ['reg-7905', -9, -5],
    ['reg-lm317', 9, 5],
  ])('%s with %s V in still puts out %s V', async (part, vin, vout) => {
    const s = await regulate(part, vin);
    expect(s.vout).toBeCloseTo(vout, 2);
  });

  it(
    'analog-5v-power-supply starts with its reservoir capacitor empty and still regulates 5 V',
    { timeout: 60_000 },
    async () => {
      const ex = exampleProjects.find((e) => e.id === 'analog-5v-power-supply')!;
      const { netlist, pinNetMap } = buildNetlist(exampleToBuildNetlistInput(ex));
      const r = await runNetlist(netlist);
      const cap = r.vec(`v(${pinNetMap.get('c1:+')})`) as number[];
      const out = r.vec(`v(${pinNetMap.get('u1:VOUT')})`) as number[];
      expect(Math.abs(cap[0]!)).toBeLessThan(0.01);
      expect(Math.min(...out)).toBeGreaterThan(-0.01);
      expect(out[out.length - 1]!).toBeCloseTo(5, 2);
    },
  );
});
