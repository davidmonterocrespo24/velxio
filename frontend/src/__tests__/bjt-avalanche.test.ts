/**
 * Bipolar transistors break down at their rated V(BR)CEO
 * (velxio/velxio-prod#138, the bipolar half of #110).
 *
 * The Gummel-Poon cards have no breakdown, so a coil switched off with no
 * flyback diode drove the collector to kilovolts: 1141 V on a 2N2222 from
 * 5 V (40 V part), 1863 V on a BC547, -2060 V on a 2N3906. A real part
 * avalanches just past its rating and dissipates the coil's energy there, or
 * fails. Each card now carries a C-E breakdown at its rated V(BR)CEO
 * (bjtBreakdownSubckt):
 *   - 2N2222  40 V  (onsemi P2N2222A, Rev. 7)
 *   - BC547   45 V  (onsemi BC546/D, Rev. 8)
 *   - 2N3055  60 V  (onsemi 2N3055/D, Rev. 7: VCEO(sus))
 *   - 2N3906 -40 V  (onsemi 2N3906/D, Rev. 4)
 *   - BC557  -45 V  (onsemi BC556B/D, Rev. 3)
 *
 * Circuit: a 70 ohm / 20 mH coil (the relay's) from the supply to the
 * collector (NPN, low side) or from the collector to ground (PNP, high side),
 * no diode across it; the base, driven through 1 kOhm, turns the switch off
 * at 1 ms. The switch itself must be the card's as before: saturated while
 * on, at the supply while off, and no leakage below the rating.
 */
import { describe, it, expect } from 'vitest';
import { componentToSpice } from '../simulation/spice/componentToSpice';
import { runNetlist } from './helpers/testSolver';

const PARTS: Array<{ id: string; vceo: number; pnp: boolean }> = [
  { id: 'bjt-2n2222', vceo: 40, pnp: false },
  { id: 'bjt-bc547', vceo: 45, pnp: false },
  { id: 'bjt-2n3055', vceo: 60, pnp: false },
  { id: 'bjt-2n3906', vceo: 40, pnp: true },
  { id: 'bjt-bc557', vceo: 45, pnp: true },
];

function emission(metadataId: string, emitter: string) {
  const em = componentToSpice(
    { id: 'q1', metadataId, properties: {} },
    (pin) => (pin === 'C' ? 'c' : pin === 'B' ? 'b' : emitter),
    { vcc: 5 },
  );
  if (!em) throw new Error(`no emission for ${metadataId}`);
  return em;
}

/** V_CE as the part blocks it (V_EC on a PNP) over a turn-off at 1 ms. */
async function turnOff(metadataId: string, pnp: boolean, supply: number) {
  const em = emission(metadataId, pnp ? 'vs' : '0');
  const drive = pnp
    ? [`V_g g 0 PWL(0 0 1m 0 1.0001m ${supply})`, 'R_b g b 1k']
    : ['V_g g 0 PWL(0 5 1m 5 1.0001m 0)', 'R_b g b 1k'];
  const coil = pnp ? ['R_coil c mid 70', 'L_coil mid 0 20m'] : ['R_coil vs mid 70', 'L_coil mid c 20m'];
  const netlist = [
    `* ${metadataId}: inductive turn-off without a flyback diode`,
    `V_s vs 0 DC ${supply}`,
    ...drive,
    ...coil,
    ...em.cards,
    ...em.modelsUsed,
    '.tran 1u 3m',
    '.end',
  ].join('\n');
  const r = await runNetlist(netlist);
  const t = r.vec('time') as number[];
  const c = r.vec('v(c)') as number[];
  const vce = c.map((v) => (pnp ? supply - (v as number) : (v as number)));
  const at = (time: number) => vce[t.findIndex((x) => (x as number) >= time)]!;
  return { peak: Math.max(...vce), on: at(0.9e-3), off: at(2.9e-3) };
}

describe('bipolar collector-emitter breakdown (velxio/velxio-prod#138)', () => {
  for (const part of PARTS) {
    for (const supply of [5, 12]) {
      it(`${part.id} on ${supply} V clamps just past its ${part.vceo} V rating`, { timeout: 60_000 }, async () => {
        const { peak, on, off } = await turnOff(part.id, part.pnp, supply);
        // Past the rating, by the blocking diode's drop at most.
        expect(peak).toBeGreaterThan(part.vceo);
        expect(peak).toBeLessThan(part.vceo + 1.5);
        // The switch is the card's: saturated while on, at the supply while off.
        expect(on).toBeLessThan(0.4);
        expect(off).toBeCloseTo(supply, 2);
      });
    }

    it(`${part.id} leaks nothing below its rating`, { timeout: 60_000 }, async () => {
      // Off (base tied to the emitter through 1 kOhm) at 90 % of the rating.
      const v = 0.9 * part.vceo;
      const em = emission(part.id, '0');
      const netlist = [
        `* ${part.id}: off at ${v} V`,
        `V_s vs 0 DC ${part.pnp ? -v : v}`,
        'V_sense vs c DC 0',
        'R_b b 0 1k',
        ...em.cards,
        ...em.modelsUsed,
        '.op',
        '.end',
      ].join('\n');
      const r = await runNetlist(netlist);
      expect(Math.abs(r.dcValue('i(v_sense)'))).toBeLessThan(1e-6);
    });
  }
});
