/**
 * The 1N4007, 1N4733 and 1N5817 against their datasheets
 * (velxio/velxio-prod#132).
 *
 * - 1N4007: the card dropped 0.44 V at 10 mA and 0.67 V at 1 A, 0.18-0.23 V
 *   under Vishay's typical curve (1N4001-1N4007 datasheet, Fig. 4: about
 *   0.62 V at 10 mA, 0.75 V at 0.1 A, 0.9 V at 1 A; 1.1 V max at 1 A). A
 *   silicon rectifier dropping 0.44 V misleads every rectifier lab that
 *   teaches 0.6-0.7 V per diode. Vishay's own model (1n4007.txt) fits it.
 * - 1N4733A: 5.1 V nominal at IZT = 49 mA (Vishay 1N4728A series); the card
 *   put Bv at 5.1 V and then added 5 ohm * 49 mA on top, 5.34 V at IZT. Its
 *   forward drop, 0.47 V at 10 mA, was no silicon junction's either.
 * - 1N5817: the model is right (onsemi: 0.32 V max at 0.1 A, 0.45 V max at
 *   1 A); the catalog said "0.32 V at 1 A".
 *
 * Each figure is read off the part's own cards (componentToSpice) driven by a
 * current source, so the test follows the model the canvas uses.
 */
import { describe, it, expect } from 'vitest';
import { componentToSpice } from '../simulation/spice/componentToSpice';
import { runNetlist } from './helpers/testSolver';
import metadataJson from '../../public/components-metadata.json' with { type: 'json' };

/** Volts across the part's A-C with `amps` forced from A to C (forward), or
 *  from C to A (reverse; returned as a positive V(C) - V(A)). */
async function dropAt(metadataId: string, amps: number, reverse = false): Promise<number> {
  const em = componentToSpice(
    { id: 'd1', metadataId, properties: {} },
    (pin) => (pin === 'A' ? (reverse ? '0' : 'n1') : reverse ? 'n1' : '0'),
    { vcc: 5 },
  );
  if (!em) throw new Error(`no emission for ${metadataId}`);
  const netlist = [
    `* ${metadataId} at ${amps} A ${reverse ? 'reverse' : 'forward'}`,
    ...em.cards,
    ...em.modelsUsed,
    // A current source pushes `amps` into n1 (out of ground).
    `I_test 0 n1 DC ${amps}`,
    '.op',
    '.end',
  ].join('\n');
  const r = await runNetlist(netlist);
  return r.dcValue('v(n1)');
}

describe('1N4007 forward drop follows Vishay Fig. 4 (velxio/velxio-prod#132)', () => {
  it('about 0.62 V at 10 mA', { timeout: 60_000 }, async () => {
    const v = await dropAt('diode-1n4007', 10e-3);
    expect(v).toBeGreaterThan(0.58);
    expect(v).toBeLessThan(0.68);
  });

  it('about 0.75 V at 0.1 A', { timeout: 60_000 }, async () => {
    const v = await dropAt('diode-1n4007', 0.1);
    expect(v).toBeGreaterThan(0.7);
    expect(v).toBeLessThan(0.8);
  });

  it('about 0.9 V at 1 A, under the 1.1 V maximum', { timeout: 60_000 }, async () => {
    const v = await dropAt('diode-1n4007', 1);
    expect(v).toBeGreaterThan(0.84);
    expect(v).toBeLessThan(1.1);
  });
});

describe('1N4733A zener is 5.1 V at its test current (velxio/velxio-prod#132)', () => {
  it('5.1 V +-1 % at IZT = 49 mA', { timeout: 60_000 }, async () => {
    const v = await dropAt('zener-1n4733', 49e-3, true);
    expect(v).toBeGreaterThan(5.05);
    expect(v).toBeLessThan(5.15);
  });

  it('a silicon forward drop: 0.6-0.8 V at 10 mA and at most 1.2 V at 200 mA', { timeout: 60_000 }, async () => {
    const v10 = await dropAt('zener-1n4733', 10e-3);
    expect(v10).toBeGreaterThan(0.6);
    expect(v10).toBeLessThan(0.8);
    const v200 = await dropAt('zener-1n4733', 0.2);
    expect(v200).toBeLessThanOrEqual(1.2);
  });
});

describe('1N5817 Schottky: the model and the catalog agree with onsemi (velxio/velxio-prod#132)', () => {
  it('the model stays under the 0.32 V (0.1 A) and 0.45 V (1 A) maxima', { timeout: 60_000 }, async () => {
    expect(await dropAt('diode-1n5817', 0.1)).toBeLessThan(0.32);
    expect(await dropAt('diode-1n5817', 1)).toBeLessThan(0.45);
  });

  it('the catalog does not quote the 0.1 A figure as the 1 A one', () => {
    const entry = (metadataJson as { components: Array<{ id: string; description: string }> }).components.find(
      (c) => c.id === 'diode-1n5817',
    );
    expect(entry).toBeDefined();
    expect(entry!.description).not.toMatch(/0\.32\s*V\s*at\s*1\s*A/);
    expect(entry!.description).toMatch(/0\.45\s*V\s*at\s*1\s*A/);
  });
});
