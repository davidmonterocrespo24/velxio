/**
 * The series RLC example says where its peaks are (velxio/velxio-prod#122).
 *
 * an-rlc-series-resonance said "Vc peaks at resonance". In a series RLC the
 * CURRENT peaks at f0 = 1 / (2 pi sqrt(LC)); the capacitor's voltage peaks
 * below it, at f0 sqrt(1 - 1 / (2 Q^2)), and only meets it in the high-Q
 * limit (Fiore, AC Electrical Circuit Analysis 8.2: "at lower Q values the
 * peaks tend to spread apart, with the capacitor's peak below f0"). Here
 * R = 10 ohm, L = 1 mH, C = 1 uF: f0 = 5.03 kHz, Q = sqrt(L/C)/R = 3.16, and
 * Vc peaks at 4.91 kHz, 3.20 x the input against 3.16 x at f0. The engine
 * shows exactly that; the text was the high-Q approximation.
 *
 * The sweep below is the one the description asks the reader to make, on the
 * shipped solver, read as the voltmeter reads it (RMS over whole periods).
 */
import { describe, it, expect } from 'vitest';
import { analogExamples } from '../data/examples-analog';
import { exampleToBuildNetlistInput } from '../utils/exampleToBuildNetlistInput';
import { readSpan, spanStats } from '../simulation/spice/waveformStats';
import { solveInput } from './helpers/solveInput';
import type { ExampleProject } from '../data/examples';

const EXAMPLE = analogExamples.find((e) => e.id === 'an-rlc-series-resonance')!;

function atFrequency(hz: number): ExampleProject {
  return {
    ...EXAMPLE,
    components: EXAMPLE.components.map((c) =>
      c.id === 'src' ? { ...c, properties: { ...c.properties, frequency: hz } } : c,
    ),
  };
}

/** RMS of the capacitor's voltage and of the loop current at `hz`. */
async function measure(hz: number): Promise<{ vc: number; i: number; vin: number }> {
  const input = exampleToBuildNetlistInput(atFrequency(hz));
  const s = await solveInput(input);
  const tw = s.timeWaveforms!;
  const span = readSpan(tw.time, input.analysis.kind === 'tran' ? input.analysis.period : undefined)!;
  const node = (cid: string, pin: string) => {
    const net = s.pinNetMap.get(`${cid}:${pin}`)!;
    return net === '0' ? tw.time.map(() => 0) : tw.nodes.get(net)!;
  };
  const sig = node('src', 'SIG');
  const mid = node('r1', '2');
  const vc = node('c1', '1');
  const iR = sig.map((v, k) => (v - mid[k]!) / 10);
  return {
    vc: spanStats(tw.time, vc, span)!.rms,
    i: spanStats(tw.time, iR, span)!.rms,
    vin: spanStats(tw.time, sig, span)!.rms,
  };
}

describe('an-rlc-series-resonance (velxio/velxio-prod#122)', () => {
  it('the current peaks at f0 = 5.03 kHz, the capacitor voltage just below it', { timeout: 120_000 }, async () => {
    const at = async (hz: number) => ({ hz, ...(await measure(hz)) });
    const below = await at(4850);
    const near = await at(4900);
    const f0 = await at(5033);
    const above = await at(5150);
    // The current is highest at f0, against 3 % either side of it.
    expect(f0.i).toBeGreaterThan(below.i);
    expect(f0.i).toBeGreaterThan(above.i);
    // The capacitor's voltage is higher 2.6 % below f0 than at f0 (theory:
    // 3.20 x against 3.16 x the input), and about 3.2 x the input there.
    expect(near.vc).toBeGreaterThan(f0.vc * 1.01);
    expect(near.vc / near.vin).toBeGreaterThan(3.1);
    expect(near.vc / near.vin).toBeLessThan(3.3);
  });

  it('says so instead of "Vc peaks at resonance"', () => {
    expect(EXAMPLE.description).not.toMatch(/Vc peaks at resonance/i);
    expect(EXAMPLE.description).toMatch(/current peaks at/i);
    expect(EXAMPLE.description).toMatch(/below/i);
  });
});
