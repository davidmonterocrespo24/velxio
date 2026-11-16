/**
 * The FQP27P06, 2N3055 and 2N2222 cards against their datasheets, and the
 * catalog texts of the MOSFETs (velxio/velxio-prod#136).
 *
 * - FQP27P06 (Fairchild, Rev. A2): RDS(on) 0.055 ohm typ / 0.07 max at
 *   VGS -10 V, ID -13.5 A; VGS(th) -2 to -4 V at 250 uA; gFS 12.4 S at
 *   -13.5 A; Fig. 2 about 15 A at VGS -5 V (VDS -30 V); BVDSS -60 V. The
 *   card was a Level-1 placeholder: 32.6 ohm and 41 mA at VGS -5 V, 10.7 ohm
 *   at -10 V, and no breakdown.
 * - 2N3055 (onsemi, VCE 4 V): VBE about 0.62 V at 0.1 A and 0.72 V at 1 A
 *   (Fig. 7), hFE about 110 at 0.1 A and 95 at 1 A (Fig. 3), 20-70 at 4 A.
 *   The card read 0.40 V / 0.50 V and hFE 66 / 36 / 15.
 * - 2N2222 (onsemi P2N2222A, VCE 10 V): typical hFE about 105 at 0.1 mA and
 *   150 at 1 mA (Fig. 3); minimums 35 / 50 / 75 / 100 at 0.1 / 1 / 10 /
 *   150 mA. The card had no low-current roll-off: 218 at 0.1 mA. (The
 *   issue's 35-50 are the minimums, not the typical gain.)
 *
 * Every figure is read off the part's own cards (componentToSpice).
 */
import { describe, it, expect } from 'vitest';
import { componentToSpice } from '../simulation/spice/componentToSpice';
import { runNetlist } from './helpers/testSolver';
import metadataJson from '../../public/components-metadata.json' with { type: 'json' };

function cardsOf(metadataId: string, pins: Record<string, string>): string[] {
  const em = componentToSpice({ id: 'q1', metadataId, properties: {} }, (pin) => pins[pin] ?? null, {
    vcc: 5,
  });
  if (!em) throw new Error(`no emission for ${metadataId}`);
  return [...em.cards, ...em.modelsUsed];
}

async function op(lines: string[]) {
  return runNetlist(['* transistor datasheet point', ...lines, '.op', '.end'].join('\n'));
}

/** The BJT at collector current `ic` with VCE fixed: its hFE and VBE. The base
 *  current is found by iterating on the gain the solve reports. */
async function bjtAt(metadataId: string, vce: number, ic: number): Promise<{ hfe: number; vbe: number }> {
  const cards = cardsOf(metadataId, { C: 'c', B: 'b', E: '0' });
  let ib = ic / 100;
  let hfe = 0;
  let vbe = 0;
  for (let k = 0; k < 12; k++) {
    const r = await op([...cards, `V_c c 0 DC ${vce}`, `I_b 0 b DC ${ib}`]);
    const icNow = -r.dcValue('i(v_c)');
    hfe = icNow / ib;
    vbe = r.dcValue('v(b)');
    if (Math.abs(icNow / ic - 1) < 1e-4) break;
    ib *= ic / icNow;
  }
  return { hfe, vbe };
}

describe('FQP27P06 is a 60 V / 27 A power P-MOSFET (velxio/velxio-prod#136)', () => {
  const fqp = (pins: Record<string, string>) => cardsOf('mosfet-fqp27p06', pins);

  it('RDS(on) at VGS -10 V, ID -13.5 A is about 55 mohm (70 max)', { timeout: 60_000 }, async () => {
    // A 13.5 A sink pulls the drain below the grounded source.
    const r = await op([
      ...fqp({ D: 'd', G: 'g', S: '0' }),
      'V_g g 0 DC -10',
      'V_n n 0 DC -40',
      'I_t d n DC 13.5',
    ]);
    const rds = -r.dcValue('v(d)') / 13.5;
    expect(rds).toBeGreaterThan(0.04);
    expect(rds).toBeLessThan(0.07);
  });

  it('VGS(th) at -250 uA (drain on gate) lies in -2 .. -4 V', { timeout: 60_000 }, async () => {
    const r = await op([...fqp({ D: 'd', G: 'd', S: '0' }), 'V_n n 0 DC -10', 'I_t d n DC 250u']);
    const vth = r.dcValue('v(d)');
    expect(vth).toBeLessThan(-2);
    expect(vth).toBeGreaterThan(-4);
  });

  it('passes amps at VGS -5 V (Fig. 2: about 15 A at VDS -30 V)', { timeout: 60_000 }, async () => {
    const r = await op([...fqp({ D: 'd', G: 'g', S: '0' }), 'V_g g 0 DC -5', 'V_d d 0 DC -30']);
    const id = Math.abs(r.dcValue('i(v_d)'));
    expect(id).toBeGreaterThan(8);
    expect(id).toBeLessThan(25);
  });

  it('clamps a coil switched off without a diode near its -60 V rating', { timeout: 60_000 }, async () => {
    const netlist = [
      '* FQP27P06 high side, inductive turn-off',
      'V_s vs 0 DC 12',
      'V_g g 0 PWL(0 0 1m 0 1.0001m 12)',
      'R_coil d mid 70',
      'L_coil mid 0 20m',
      ...fqp({ D: 'd', G: 'g', S: 'vs' }),
      '.tran 1u 3m',
      '.end',
    ].join('\n');
    const r = await runNetlist(netlist);
    const vds = Math.min(...(r.vec('v(d)') as number[])) - 12;
    expect(vds).toBeLessThan(-55);
    expect(vds).toBeGreaterThan(-70);
  });
});

describe('2N3055 follows onsemi Fig. 3 and Fig. 7 (velxio/velxio-prod#136)', () => {
  it('VBE about 0.62 V and hFE about 110 at 0.1 A', { timeout: 60_000 }, async () => {
    const p = await bjtAt('bjt-2n3055', 4, 0.1);
    expect(p.vbe).toBeGreaterThan(0.58);
    expect(p.vbe).toBeLessThan(0.67);
    expect(p.hfe).toBeGreaterThan(85);
    expect(p.hfe).toBeLessThan(135);
  });

  it('VBE about 0.72 V and hFE about 95 at 1 A', { timeout: 60_000 }, async () => {
    const p = await bjtAt('bjt-2n3055', 4, 1);
    expect(p.vbe).toBeGreaterThan(0.67);
    expect(p.vbe).toBeLessThan(0.78);
    expect(p.hfe).toBeGreaterThan(75);
    expect(p.hfe).toBeLessThan(120);
  });

  it('hFE inside the 20-70 the datasheet guarantees at 4 A, VBE under 1.5 V', { timeout: 60_000 }, async () => {
    const p = await bjtAt('bjt-2n3055', 4, 4);
    expect(p.hfe).toBeGreaterThanOrEqual(20);
    expect(p.hfe).toBeLessThanOrEqual(70);
    expect(p.vbe).toBeLessThan(1.5);
  });
});

describe('2N2222 gain rolls off at low current (velxio/velxio-prod#136)', () => {
  it('hFE about 105 at 0.1 mA and 150 at 1 mA (onsemi Fig. 3, VCE 10 V)', { timeout: 60_000 }, async () => {
    const low = await bjtAt('bjt-2n2222', 10, 1e-4);
    expect(low.hfe).toBeGreaterThan(80);
    expect(low.hfe).toBeLessThan(140);
    const mid = await bjtAt('bjt-2n2222', 10, 1e-3);
    expect(mid.hfe).toBeGreaterThan(120);
    expect(mid.hfe).toBeLessThan(190);
    expect(mid.hfe).toBeGreaterThan(low.hfe);
  });

  it('stays inside the datasheet minimums up to 150 mA', { timeout: 60_000 }, async () => {
    expect((await bjtAt('bjt-2n2222', 10, 1e-2)).hfe).toBeGreaterThan(75);
    const hi = (await bjtAt('bjt-2n2222', 10, 0.15)).hfe;
    expect(hi).toBeGreaterThan(100);
    expect(hi).toBeLessThan(300);
  });
});

describe('MOSFET catalog texts say what the parts do (velxio/velxio-prod#136)', () => {
  const entries = (metadataJson as { components: Array<{ id: string; description: string }> }).components;
  const text = (id: string) => entries.find((c) => c.id === id)?.description ?? '';

  it('the 2N7000 is not "fully enhanced at 3.3 V"', () => {
    expect(text('mosfet-2n7000')).not.toMatch(/fully enhanced at 3\.3/i);
  });

  it('the IRF540 quotes its own 28 A and 77 mohm, not the IRF540N 33 A', () => {
    expect(text('mosfet-irf540')).toMatch(/28 A/);
    expect(text('mosfet-irf540')).not.toMatch(/33 A/);
  });

  it('the FQP27P06 is not sold as a 3.3 V logic-level part', () => {
    expect(text('mosfet-fqp27p06')).not.toMatch(/suitable for 3\.3/i);
    expect(text('mosfet-fqp27p06')).not.toMatch(/^Logic-level/i);
  });
});
