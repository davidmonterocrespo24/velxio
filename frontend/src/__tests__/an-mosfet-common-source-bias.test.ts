/**
 * The gallery's MOSFET amplifier is biased in saturation (velxio/velxio-prod#124).
 *
 * an-mosfet-common-source had Rd = 4.7 kohm. With Velxio's 2N7000 (Vto 1.6 V)
 * the stage sat in the triode region: VG 3.84 V, VS 2.09 V, VD 2.18 V, so
 * VDS = 0.09 V under VGS - Vth = 0.15 V, and a +-0.1 V input came out as
 * +0.39 / -0.035 V: crushed on one side, not amplified. A MOSFET amplifies in
 * saturation, VDS >= VGS - Vth (en.wikipedia.org/wiki/MOSFET, modes of
 * operation), and a design that only gets there for Vth above 1.8 V is
 * fragile: the 2N7000's VGS(th) is 0.8-3 V (onsemi 2N7000 datasheet).
 *
 * With Rd = 2.2 kohm the drain sits near the middle of what it can swing
 * (about 7.4 V between VS = 2.1 V and 12 V), the swing is symmetric, and the
 * gain is Rd / (Rs + 1/gm), about 2.1 with the source resistor unbypassed.
 */
import { describe, it, expect } from 'vitest';
import { analogExamples } from '../data/examples-analog';
import { exampleToBuildNetlistInput } from '../utils/exampleToBuildNetlistInput';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { readSpan, spanStats } from '../simulation/spice/waveformStats';
import { solveInput } from './helpers/solveInput';

const EXAMPLE = analogExamples.find((e) => e.id === 'an-mosfet-common-source')!;

/**
 * A pin's voltage over whole periods of the settled capture, as the meters
 * read it (readSpan): its mean (the resting point of a linear stage), its
 * extremes and its peak-to-peak.
 */
async function swing(pins: Array<[string, string]>) {
  const input = exampleToBuildNetlistInput(EXAMPLE);
  const s = await solveInput(input);
  const tw = s.timeWaveforms!;
  const span = readSpan(tw.time, input.analysis.kind === 'tran' ? input.analysis.period : undefined)!;
  const out: Record<string, { min: number; max: number; mean: number; pp: number }> = {};
  for (const [cid, pin] of pins) {
    const net = s.pinNetMap.get(`${cid}:${pin}`)!;
    const st = spanStats(tw.time, tw.nodes.get(net)!, span)!;
    out[`${cid}:${pin}`] = { min: st.min, max: st.max, mean: st.mean, pp: st.max - st.min };
  }
  return out;
}

/** The 2N7000's threshold, read from the card the netlist carries. */
function vto(): number {
  const { netlist } = buildNetlist(exampleToBuildNetlistInput(EXAMPLE));
  const m = /\.model M2N7000 VDMOS\([^)]*\bVto=([\d.]+)/i.exec(netlist);
  return Number(m?.[1]);
}

describe('an-mosfet-common-source (velxio/velxio-prod#124)', () => {
  it('stays in saturation over the whole swing, with the drain near the middle of its range', { timeout: 60_000 }, async () => {
    const w = await swing([
      ['m1', 'G'],
      ['m1', 'S'],
      ['m1', 'D'],
    ]);
    const g = w['m1:G']!;
    const s = w['m1:S']!;
    const d = w['m1:D']!;
    const vth = vto();
    expect(vth).toBeGreaterThan(0);
    // VDS >= VGS - Vth at every point of the swing, with a volt to spare.
    expect(d.min - s.max).toBeGreaterThan(g.max - s.min - vth + 1);
    // The drain's resting point in the middle third of VS..12 V.
    const span = 12 - s.mean;
    expect(d.mean).toBeGreaterThan(s.mean + span / 3);
    expect(d.mean).toBeLessThan(12 - span / 3);
  });

  it('amplifies the 0.2 Vpp input about 2x, the same both ways', { timeout: 60_000 }, async () => {
    const w = await swing([
      ['src', 'SIG'],
      ['m1', 'D'],
    ]);
    const vin = w['src:SIG']!;
    const d = w['m1:D']!;
    const gain = d.pp / vin.pp;
    expect(gain).toBeGreaterThan(1.8);
    expect(gain).toBeLessThan(2.5);
    // A linear stage: the two half-swings about its resting point agree
    // within 10 %.
    const up = d.max - d.mean;
    const down = d.mean - d.min;
    expect(Math.abs(up - down) / ((up + down) / 2)).toBeLessThan(0.1);
  });

  it('says what it is: the bias, and a gain of about 2', () => {
    expect(EXAMPLE.description).toMatch(/gain/i);
    expect(EXAMPLE.description).toMatch(/≈ 2|about 2/);
  });
});
