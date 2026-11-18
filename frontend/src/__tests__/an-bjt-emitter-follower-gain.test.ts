/**
 * The gallery's emitter follower has the gain its description gives
 * (velxio/velxio-prod#123).
 *
 * an-bjt-emitter-follower promised "unity voltage gain" and gave 0.668: the
 * emitter swung 2.95-4.29 V for the 5-7 V input. The engine was right. The
 * 100 kohm in series with the base and the stage's own input resistance,
 * about (beta + 1)(re + RE) = 200 kohm, form a 1:3 divider; seen from the
 * emitter, R = (RS + r_pi) / (beta + 1) = 505 ohm against RE = 1 kohm gives
 * Av = 1 / (1 + R / RE) = 0.66 (en.wikipedia.org/wiki/Common_collector).
 * With 1 kohm in series the follower is what a follower is: Av = 0.99, the
 * emitter one diode drop under the base.
 */
import { describe, it, expect } from 'vitest';
import { analogExamples } from '../data/examples-analog';
import { exampleToBuildNetlistInput } from '../utils/exampleToBuildNetlistInput';
import { readSpan, spanStats } from '../simulation/spice/waveformStats';
import { solveInput } from './helpers/solveInput';

const EXAMPLE = analogExamples.find((e) => e.id === 'an-bjt-emitter-follower')!;

async function peakToPeak(pins: Array<[string, string]>) {
  const input = exampleToBuildNetlistInput(EXAMPLE);
  const s = await solveInput(input);
  const tw = s.timeWaveforms!;
  const span = readSpan(tw.time, input.analysis.kind === 'tran' ? input.analysis.period : undefined)!;
  const out: Record<string, { pp: number; mean: number }> = {};
  for (const [cid, pin] of pins) {
    const st = spanStats(tw.time, tw.nodes.get(s.pinNetMap.get(`${cid}:${pin}`)!)!, span)!;
    out[`${cid}:${pin}`] = { pp: st.max - st.min, mean: st.mean };
  }
  return out;
}

describe('an-bjt-emitter-follower (velxio/velxio-prod#123)', () => {
  it('follows the input with a gain of 0.99, the emitter a diode drop under the base', { timeout: 60_000 }, async () => {
    const w = await peakToPeak([
      ['src', 'SIG'],
      ['q1', 'B'],
      ['q1', 'E'],
    ]);
    const gain = w['q1:E']!.pp / w['src:SIG']!.pp;
    expect(gain).toBeGreaterThan(0.98);
    expect(gain).toBeLessThan(1);
    const vbe = w['q1:B']!.mean - w['q1:E']!.mean;
    expect(vbe).toBeGreaterThan(0.6);
    expect(vbe).toBeLessThan(0.75);
  });

  it('gives the gain the circuit has, not "unity"', () => {
    expect(EXAMPLE.description).not.toMatch(/unity/i);
    expect(EXAMPLE.description).toMatch(/0\.99/);
  });
});
