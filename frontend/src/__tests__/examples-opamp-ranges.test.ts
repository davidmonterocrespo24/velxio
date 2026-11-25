/**
 * The gallery's op-amp examples work on the 5 V their LM358 runs from
 * (velxio/velxio-prod#127).
 *
 * Without a board the LM358 runs from the 5 V rail (#126). On 5 V a real one
 * is guaranteed to swing from about 0 V to 3.5 V (TI SLOS068: VOH no lower
 * than V+ - 1.5 V into 2 kOhm) and to take inputs up to V+ - 1.5 V. The
 * simulator's model does a little more: its output reaches about 4 V at
 * light load and its inputs work up to V+ (#128, lm358Subckt.ts). The
 * examples are designed for the real part's guarantee, which they did not
 * fit:
 *   - the non-inverting amplifier multiplied its input's 2.5 V DC by 11 too,
 *     27.5 V asked for: 3.96 V flat;
 *   - the inverting one needed 2.5 +- 2 V: clipped at 3.97 V;
 *   - the summing one summed around a 2.5 V reference (4.5 V asked for, 3.98 V
 *     out) while its text gave the ground-referenced formula (-3 V);
 *   - the integrator had no DC path: it started saturated and stayed clipped
 *     near 4.06 V for the whole window.
 * Each is now designed to stay inside about 1-3.3 V, and the integrator has a
 * resistor across its capacitor.
 */
import { describe, it, expect } from 'vitest';
import { analogExamples } from '../data/examples-analog';
import { exampleToBuildNetlistInput } from '../utils/exampleToBuildNetlistInput';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { runNetlist } from './helpers/testSolver';

function example(id: string) {
  const ex = analogExamples.find((e) => e.id === id);
  if (!ex) throw new Error(`${id} is not in the analog gallery`);
  return ex;
}

/** Every sample of OUT (and IN+ / IN-) of the example's own deck, after the
 *  first `skip` share of the window (start-up). */
async function solve(id: string, skip = 0.2) {
  const { netlist, pinNetMap } = buildNetlist(exampleToBuildNetlistInput(example(id)));
  const r = await runNetlist(netlist);
  const vec = (pin: string) => {
    const v = r.vec(`v(${pinNetMap.get(pin)})`) as number[];
    return v.slice(Math.floor(v.length * skip));
  };
  return { out: vec('u1:OUT'), inp: vec('u1:IN+'), inn: vec('u1:IN-'), netlist };
}

/** A DC source's offset in the example (signal-generator `offset`). */
function dc(id: string, part: string): number {
  const c = example(id).components.find((x) => x.id === part);
  return Number(c?.properties?.offset);
}
function ohms(id: string, part: string): number {
  const c = example(id).components.find((x) => x.id === part);
  return Number(c?.properties?.value);
}

/** The LM358's linear output range on 5 V, with a margin. */
const LO = 0.8;
const HI = 3.4;

describe('op-amp gallery examples stay inside an LM358 on 5 V (velxio/velxio-prod#127)', () => {
  it('an-opamp-inverting: -10 x a 0.1 V sine, 2 V p-p around its reference, unclipped', { timeout: 60_000 }, async () => {
    const { out } = await solve('an-opamp-inverting');
    const lo = Math.min(...out);
    const hi = Math.max(...out);
    expect(lo).toBeGreaterThan(LO);
    expect(hi).toBeLessThan(HI);
    expect(hi - lo).toBeGreaterThan(1.8);
    expect(hi - lo).toBeLessThan(2.2);
    expect((hi + lo) / 2).toBeCloseTo(dc('an-opamp-inverting', 'vref'), 1);
  });

  it('an-opamp-non-inverting: 11 x its whole input, DC included, unclipped', { timeout: 60_000 }, async () => {
    const { out, inp } = await solve('an-opamp-non-inverting');
    const worst = Math.max(...out.map((v, i) => Math.abs(v - 11 * inp[i]!)));
    expect(worst).toBeLessThan(0.05);
    expect(Math.min(...out)).toBeGreaterThan(LO);
    expect(Math.max(...out)).toBeLessThan(HI);
  });

  it('an-opamp-summing: Vref - Rf((V1 - Vref)/R1 + (V2 - Vref)/R2), as its text says', { timeout: 60_000 }, async () => {
    const id = 'an-opamp-summing';
    const { out } = await solve(id, 0);
    const vref = dc(id, 'vref');
    const want =
      vref - ohms(id, 'rf') * ((dc(id, 'v1') - vref) / ohms(id, 'r1') + (dc(id, 'v2') - vref) / ohms(id, 'r2'));
    expect(want).toBeGreaterThan(LO);
    expect(want).toBeLessThan(HI);
    // Within the model's input offset (2 mV) times the noise gain of 3.
    expect(Math.abs(out[out.length - 1]! - want)).toBeLessThan(0.01);
    expect(example(id).description).toContain('V_out = Vref − Rf · ((V1 − Vref)/R1 + (V2 − Vref)/R2)');
  });

  it('an-opamp-integrator: a triangle around its reference once it has settled, never clipped', { timeout: 60_000 }, async () => {
    const id = 'an-opamp-integrator';
    const all = await solve(id, 0);
    expect(Math.max(...all.out)).toBeLessThan(HI);
    expect(Math.min(...all.out)).toBeGreaterThan(LO);
    // The second half of the window: the start-up offset has decayed.
    const { out } = await solve(id, 0.5);
    const lo = Math.min(...out);
    const hi = Math.max(...out);
    expect(hi - lo).toBeGreaterThan(0.6);
    expect(hi - lo).toBeLessThan(1.4);
    expect((hi + lo) / 2).toBeCloseTo(dc(id, 'vref'), 0);
  });
});
