/**
 * MOSFETs break down at their rated drain-source voltage
 * (velxio/velxio-prod#110).
 *
 * The VDMOS cards came from LTspice's library, where `Vds=60` is a label
 * ngspice ignores, and none carried `BV`. Switching off a coil with no flyback
 * diode then put its whole stored energy into a few tens of pF: a 2N7000's
 * drain rose to about 2.6 kV in the simulation (4.1 kV in the issue), where a
 * real part avalanches just above its V(BR)DSS and dissipates the energy, or
 * fails. ngspice's VDMOS takes the breakdown on its body diode (BV, IBV;
 * README.vdmos), so the clamp is a model parameter:
 *   - 2N7000   BVDSS 60 V  (onsemi 2N7000/2N7002 datasheet)
 *   - IRF540   VDS 100 V   (Vishay IRF540)
 *   - IRF9540  VDS -100 V  (Vishay IRF9540, P-channel)
 * (The FQP27P06 was a Level-1 card with no breakdown at all; its VDMOS card,
 * #136, carries its -60 V and is checked in transistor-models-datasheet.)
 *
 * Circuit: a 70 ohm / 20 mH coil (the relay's) from the supply to the drain
 * (N-channel, low side) or from the drain to ground (P-channel, high side),
 * no diode across it; the gate turns the switch off at 1 ms.
 */
import { describe, it, expect } from 'vitest';
import { componentToSpice } from '../simulation/spice/componentToSpice';
import { runNetlist } from './helpers/testSolver';

async function drainExcursion(metadataId: string, pchan: boolean, supply: number): Promise<number> {
  const em = componentToSpice(
    { id: 'm1', metadataId, properties: {} },
    (pin) => (pin === 'D' ? 'd' : pin === 'G' ? 'g' : pchan ? 'vs' : '0'),
    { vcc: 5 },
  );
  if (!em) throw new Error(`no emission for ${metadataId}`);
  // N-channel: gate 10 V -> 0 V at 1 ms. P-channel: gate at 0 V (VGS = -supply)
  // -> supply at 1 ms.
  const gate = pchan
    ? `V_g g 0 PWL(0 0 1m 0 1.0001m ${supply})`
    : 'V_g g 0 PWL(0 10 1m 10 1.0001m 0)';
  const coil = pchan
    ? ['R_coil d mid 70', 'L_coil mid 0 20m']
    : ['R_coil vs mid 70', 'L_coil mid d 20m'];
  const netlist = [
    `* ${metadataId}: inductive turn-off without a flyback diode`,
    `V_s vs 0 DC ${supply}`,
    gate,
    ...coil,
    ...em.cards,
    ...em.modelsUsed,
    '.tran 1u 3m',
    '.end',
  ].join('\n');
  const r = await runNetlist(netlist);
  const d = r.vec('v(d)') as number[];
  const vs = pchan ? supply : 0;
  // V_DS excursion after the turn-off, signed as the part sees it.
  let worst = 0;
  for (const v of d) {
    const vds = (v as number) - vs;
    if (pchan ? vds < worst : vds > worst) worst = vds;
  }
  return worst;
}

describe('MOSFET drain-source breakdown (velxio/velxio-prod#110)', () => {
  it('2N7000 on 5 V clamps near its 60 V rating', { timeout: 60_000 }, async () => {
    const vds = await drainExcursion('mosfet-2n7000', false, 5);
    expect(vds).toBeGreaterThan(55);
    expect(vds).toBeLessThan(70);
  });

  it('IRF540 on 12 V clamps near its 100 V rating', { timeout: 60_000 }, async () => {
    const vds = await drainExcursion('mosfet-irf540', false, 12);
    expect(vds).toBeGreaterThan(95);
    expect(vds).toBeLessThan(115);
  });

  it('IRF9540 high side on 12 V clamps near -100 V', { timeout: 60_000 }, async () => {
    const vds = await drainExcursion('mosfet-irf9540', true, 12);
    expect(vds).toBeLessThan(-95);
    expect(vds).toBeGreaterThan(-115);
  });
});
