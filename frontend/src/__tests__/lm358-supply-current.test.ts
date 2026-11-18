/**
 * The LM358 draws its quiescent current FROM its supply (velxio/velxio-prod#190).
 *
 * National's macro-model (vendored in models/lm358Subckt.ts) carried
 * `F6 50 99 POLY(1) V6 300U 1`: a constant 300 uA pulled out of V- and pushed
 * INTO V+. Against the model's 75 uA bias source that made the net supply
 * current negative below about 10 V (-46 uA out of V+ at 5 V, -61 uA at 3.3 V),
 * so the part fed its own supply and a power budget or a supply ammeter read
 * the op-amp as a source.
 *
 * What the datasheets give, per amplifier with no load:
 *   - TI LM358 (2024): 350 uA typ / 600 uA max at 5 V, 500 / 1000 uA at 30 V;
 *   - National LM358-N, the model's origin: 0.5 mA typ per package of two at
 *     5 V and 1 mA at 30 V, i.e. 250 / 500 uA per amplifier. The model's own
 *     NOTE ("simulated supply current is 1/2 of total device current") targets
 *     this per-amplifier figure.
 *
 * The I(V6) term of the same line is right (it moves the output's sinking
 * current from V+ to V-), so the fix drops only the constant.
 *
 * Circuit: one LM358 as a voltage follower, V+ and V- on their own sources so
 * each pin's current reads off its source.
 */
import { describe, it, expect } from 'vitest';
import { LM358_SUBCKT } from '../simulation/spice/models/lm358Subckt';
import { runNetlist } from './helpers/testSolver';

/** Current out of the V+ pin's source into the part, and out of the part's
 *  V- pin into ground, in amperes. */
async function supplyCurrents(
  vs: number,
  vin: number,
  load: 'none' | 'to-ground' | 'to-supply',
): Promise<{ vplus: number; vminus: number; vout: number }> {
  // The pull-up has its own source so I(VCC) is the V+ pin's current alone.
  const loadCard =
    load === 'to-ground' ? 'RL out 0 1k' : load === 'to-supply' ? `VPU pu 0 DC ${vs}\nRL out pu 1k` : '';
  const netlist = [
    '* LM358 follower supply current',
    `VCC vp 0 DC ${vs}`,
    'VEE vm 0 DC 0',
    `VIN in 0 DC ${vin}`,
    'X1 in out vp vm out LM358',
    loadCard,
    LM358_SUBCKT,
    '.op',
    '.end',
  ].join('\n');
  const r = await runNetlist(netlist);
  // ngspice's branch current runs from the source's + node through it to its
  // - node: I(VCC) < 0 when VCC feeds the circuit, I(VEE) > 0 when current
  // leaves the part's V- pin for ground.
  return {
    vplus: -r.dcValue('i(vcc)'),
    vminus: r.dcValue('i(vee)'),
    vout: r.dcValue('v(out)'),
  };
}

describe('LM358 supply current (velxio/velxio-prod#190)', () => {
  it('draws about 0.25 mA from a 5 V supply with no load', { timeout: 60_000 }, async () => {
    const c = await supplyCurrents(5, 2.5, 'none');
    expect(c.vout).toBeCloseTo(2.5, 2);
    // National 250 uA typ per amplifier; TI's current die 350 uA typ, 600 uA max.
    expect(c.vplus).toBeGreaterThan(200e-6);
    expect(c.vplus).toBeLessThan(600e-6);
    // With no load every microamp that enters V+ leaves through V-.
    expect(c.vminus).toBeCloseTo(c.vplus, 6);
  });

  it('draws a positive current at 3.3 V and at most 1 mA at 30 V', { timeout: 60_000 }, async () => {
    const low = await supplyCurrents(3.3, 1.2, 'none');
    expect(low.vplus).toBeGreaterThan(150e-6);
    const high = await supplyCurrents(30, 10, 'none');
    expect(high.vplus).toBeGreaterThan(low.vplus);
    expect(high.vplus).toBeLessThan(1e-3);
  });

  it('sourcing 2.5 mA into 1 k, V+ carries the load and V- still returns the quiescent current', {
    timeout: 60_000,
  }, async () => {
    const c = await supplyCurrents(5, 2.5, 'to-ground');
    expect(c.vout).toBeCloseTo(2.5, 2);
    expect(c.vplus).toBeGreaterThan(2.5e-3);
    expect(c.vplus).toBeLessThan(2.5e-3 + 600e-6);
    expect(c.vminus).toBeGreaterThan(0);
  });

  it('sinking 2.5 mA from a 1 k pull-up, the current leaves through V-', { timeout: 60_000 }, async () => {
    const c = await supplyCurrents(5, 2.5, 'to-supply');
    expect(c.vout).toBeCloseTo(2.5, 2);
    expect(c.vminus).toBeGreaterThan(2.5e-3);
    expect(c.vminus).toBeLessThan(2.5e-3 + 600e-6);
    expect(c.vplus).toBeGreaterThan(0);
  });
});
