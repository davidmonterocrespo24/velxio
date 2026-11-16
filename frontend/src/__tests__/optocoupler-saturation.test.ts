/**
 * The optocoupler's output is a phototransistor: it saturates
 * (velxio/velxio-prod#131).
 *
 * The 4N25 and PC817 were an LED, a 0 V sense source and an F source
 * (CTR x I_LED) straight from collector to emitter: an ideal current source
 * with no V_CE(sat). Behind the usual 10 k pull-up it pulled the collector to
 * whatever voltage that current needed: -59.67 V in the gallery's
 * optocoupler-signal (270 ohm LED resistor, 10 k to 5 V), -124 V with a
 * PC817, where a real part sits at 0.1-0.5 V. analogRead clamped it to 0, so
 * the sketch looked right while every meter, scope and downstream part saw
 * an impossible voltage. The LED also dropped 1.48 V at 10 mA and 1.76 V at
 * 50 mA, over the 4N25's 1.5 V and the PC817's 1.4 V maxima.
 *
 * Datasheets:
 *   - Vishay 4N25: VF 1.3 V typ / 1.5 V max at 50 mA; CTR 20 % min, 50 % typ
 *     at IF 10 mA, VCE 10 V; VCE(sat) <= 0.5 V at IC 2 mA, IF 50 mA.
 *   - Sharp PC817X: VF 1.2 V typ / 1.4 V max at 20 mA; CTR 50-600 % at IF
 *     5 mA, VCE 5 V; VCE(sat) 0.1 V typ / 0.2 V max at IF 20 mA, IC 1 mA.
 */
import { describe, it, expect } from 'vitest';
import { componentToSpice } from '../simulation/spice/componentToSpice';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { exampleToBuildNetlistInput } from '../utils/exampleToBuildNetlistInput';
import { circuitExamples } from '../data/examples-circuits';
import { runNetlist } from './helpers/testSolver';

/** The part with IF forced into its LED and its collector held at `vce`
 *  (or fed from `pullup` volts through `rl` ohms when given). */
async function opto(
  metadataId: string,
  ifA: number,
  out: { vce: number } | { pullup: number; rl: number },
): Promise<{ vf: number; ic: number; vce: number }> {
  const em = componentToSpice(
    { id: 'u1', metadataId, properties: {} },
    (pin) => ({ AN: 'an', CAT: '0', COL: 'col', EMIT: '0' })[pin] ?? null,
    { vcc: 5 },
  );
  if (!em) throw new Error(`no emission for ${metadataId}`);
  const outCards =
    'vce' in out
      ? [`V_c col 0 DC ${out.vce}`]
      : [`V_c vp 0 DC ${out.pullup}`, `R_l vp col ${out.rl}`];
  const r = await runNetlist(
    [`* ${metadataId}`, ...em.cards, ...em.modelsUsed, `I_f 0 an DC ${ifA}`, ...outCards, '.op', '.end'].join('\n'),
  );
  return { vf: r.dcValue('v(an)'), ic: -r.dcValue('i(v_c)'), vce: r.dcValue('v(col)') };
}

describe('optocoupler output saturates like a phototransistor (velxio/velxio-prod#131)', () => {
  it('the gallery optocoupler-signal: the collector sits near 0 V, never below ground', {
    timeout: 60_000,
  }, async () => {
    const example = circuitExamples.find((e) => e.id === 'optocoupler-signal');
    expect(example).toBeDefined();
    const input = exampleToBuildNetlistInput(example!, {
      boards: [
        {
          id: 'arduino-uno',
          boardKind: 'arduino-uno',
          pinStates: { '9': { type: 'digital', v: 5 } } as never,
        },
      ],
      analysis: { kind: 'op' },
    });
    const { netlist, pinNetMap } = buildNetlist(input);
    const r = await runNetlist(netlist);
    const col = r.dcValue(`v(${pinNetMap.get('u1:COL')})`);
    const an = r.dcValue(`v(${pinNetMap.get('u1:AN')})`);
    expect(col).toBeGreaterThanOrEqual(0);
    expect(col).toBeLessThan(0.4);
    // LED: (5 V - VF) / 270 ohm, about 14 mA, at the datasheet's ~1.2 V.
    expect(an).toBeGreaterThan(1.1);
    expect(an).toBeLessThan(1.3);
  });

  it('4N25: VCE(sat) under 0.5 V at IC 2 mA, IF 50 mA', { timeout: 60_000 }, async () => {
    // 2 mA from 5 V through 2.5 k when saturated.
    const p = await opto('opto-4n25', 50e-3, { pullup: 5, rl: 2400 });
    expect(p.vce).toBeGreaterThanOrEqual(0);
    expect(p.vce).toBeLessThan(0.5);
  });

  it('PC817: VCE(sat) about 0.1 V (0.2 max) at IC 1 mA, IF 20 mA', { timeout: 60_000 }, async () => {
    const p = await opto('opto-pc817', 20e-3, { pullup: 5, rl: 4900 });
    expect(p.vce).toBeGreaterThanOrEqual(0);
    expect(p.vce).toBeLessThan(0.2);
  });

  it('keeps its CTR in the linear region: 4N25 about 50 % at IF 10 mA, VCE 10 V', {
    timeout: 60_000,
  }, async () => {
    const p = await opto('opto-4n25', 10e-3, { vce: 10 });
    expect(p.ic / 10e-3).toBeGreaterThan(0.4);
    expect(p.ic / 10e-3).toBeLessThan(0.6);
  });

  it('PC817 CTR about 100 % at IF 5 mA, VCE 5 V (inside 50-600 %)', { timeout: 60_000 }, async () => {
    const p = await opto('opto-pc817', 5e-3, { vce: 5 });
    expect(p.ic / 5e-3).toBeGreaterThan(0.8);
    expect(p.ic / 5e-3).toBeLessThan(1.3);
  });

  it('the LED drops about 1.2 V: 4N25 <= 1.5 V at 50 mA, PC817 <= 1.4 V at 20 mA', {
    timeout: 60_000,
  }, async () => {
    const a = await opto('opto-4n25', 50e-3, { vce: 5 });
    expect(a.vf).toBeGreaterThan(1.2);
    expect(a.vf).toBeLessThan(1.5);
    const b = await opto('opto-pc817', 20e-3, { vce: 5 });
    expect(b.vf).toBeGreaterThan(1.1);
    expect(b.vf).toBeLessThan(1.4);
    const c = await opto('opto-4n25', 10e-3, { vce: 5 });
    expect(c.vf).toBeGreaterThan(1.1);
    expect(c.vf).toBeLessThan(1.25);
  });

  it('dark, the output is off', { timeout: 60_000 }, async () => {
    const p = await opto('opto-4n25', 0, { vce: 10 });
    expect(Math.abs(p.ic)).toBeLessThan(1e-6);
  });
});
