/**
 * The circuit check warns about a relay coil fed below the voltage the
 * contacts actually close at (velxio/velxio-prod#108).
 *
 * The relay model pulls in at 75 % of coil_voltage and drops out at 45 %
 * (ngspice SW closes at Vt + Vh and opens at Vt - Vh): the Songle
 * SRD-05VDC-SL-C's must-operate maximum, the level at which every relay is
 * guaranteed to close (Omron FAQ: apply that percentage or more to make sure
 * it operates). Rule C of the check still warned only below 60 % and called
 * it "the ~60% pull-in threshold", so a 5 V coil on a 3.3 V rail or a GPIO,
 * the common beginner case, passed the check and never closed in the
 * simulation. Rule C also ignored the KS2E-M-DC5, a 5 V relay too.
 */
import { describe, it, expect } from 'vitest';
import { verifyCircuit } from '../simulation/verify/circuitVerifier';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { runNetlist } from './helpers/testSolver';
import type { BuildNetlistInput } from '../simulation/spice/types';

type Comp = BuildNetlistInput['components'][number];
type Wire = BuildNetlistInput['wires'][number];

const psu = (volts: number): Comp => ({
  id: 'psu1',
  metadataId: 'power-supply',
  properties: { voltage: volts, currentLimit: 1 },
});
const w = (id: string, a: [string, string], b: [string, string]): Wire => ({
  id,
  start: { componentId: a[0], pinName: a[1] },
  end: { componentId: b[0], pinName: b[1] },
});

/** A relay of `coilVolts` with its coil on a `supply` volt bench supply, and
 *  COM on the same supply through NO to a 1 k load. */
function relayOn(supply: number, coilVolts = 5): BuildNetlistInput {
  return {
    components: [
      psu(supply),
      { id: 'k1', metadataId: 'relay', properties: { coil_voltage: coilVolts } },
      { id: 'rl', metadataId: 'resistor', properties: { value: '1000' } },
    ],
    wires: [
      w('w1', ['psu1', '+'], ['k1', 'COIL+']),
      w('w2', ['k1', 'COIL-'], ['psu1', '-']),
      w('w3', ['psu1', '+'], ['k1', 'COM']),
      w('w4', ['k1', 'NO'], ['rl', '1']),
      w('w5', ['rl', '2'], ['psu1', '-']),
    ],
    boards: [],
    analysis: { kind: 'op' },
  };
}

const mismatch = (r: { warnings: Array<{ code: string; componentId?: string; message: string }> }) =>
  r.warnings.find((x) => x.code === 'voltage-mismatch' && x.componentId === 'k1');

/** Current through the NO contact's 1 k load in the solved circuit (the
 *  bench supply floats: read the load's own two ends). */
async function noCurrent(input: BuildNetlistInput): Promise<number> {
  const { netlist, pinNetMap } = buildNetlist(input);
  const r = await runNetlist(netlist);
  const v = (pin: string) => r.dcValue(`v(${pinNetMap.get(pin)})`);
  return (v('rl:1') - v('rl:2')) / 1000;
}

describe('rule C uses the relay\'s real pull-in (velxio/velxio-prod#108)', () => {
  it('warns about a 5 V coil on a 3.3 V supply, which never closes', { timeout: 60_000 }, async () => {
    const input = relayOn(3.3);
    const finding = mismatch(await verifyCircuit(input));
    expect(finding, 'no warning for a 5 V coil on 3.3 V').toBeDefined();
    expect(finding!.message).toContain('75%');
    expect(finding!.message).toContain('3.75 V');
    // ...and the simulation agrees: the contact stays open.
    expect(await noCurrent(input)).toBeLessThan(1e-6);
  });

  it('warns at 3.7 V, still under 3.75 V', { timeout: 60_000 }, async () => {
    expect(mismatch(await verifyCircuit(relayOn(3.7)))).toBeDefined();
  });

  it('quotes the 75% figure when it already warned (2.9 V)', { timeout: 60_000 }, async () => {
    const finding = mismatch(await verifyCircuit(relayOn(2.9)));
    expect(finding).toBeDefined();
    expect(finding!.message).not.toContain('60%');
    expect(finding!.message).toContain('75%');
  });

  it('is silent at 3.8 V, where the simulated contact does close', { timeout: 60_000 }, async () => {
    const input = relayOn(3.8);
    expect(mismatch(await verifyCircuit(input))).toBeUndefined();
    expect(await noCurrent(input)).toBeGreaterThan(3e-3);
  });

  it('is silent for a 5 V coil on 5 V and a 12 V coil on 12 V', { timeout: 60_000 }, async () => {
    expect(mismatch(await verifyCircuit(relayOn(5)))).toBeUndefined();
    expect(mismatch(await verifyCircuit(relayOn(12, 12)))).toBeUndefined();
  });

  it('warns about a 5 V coil on an ESP32\'s 3V3 pin', { timeout: 60_000 }, async () => {
    const input: BuildNetlistInput = {
      components: [{ id: 'k1', metadataId: 'relay', properties: { coil_voltage: 5 } }],
      wires: [w('w1', ['esp', '3V3'], ['k1', 'COIL+']), w('w2', ['k1', 'COIL-'], ['esp', 'GND'])],
      boards: [{ id: 'esp', vcc: 3.3, pins: {}, groundPinNames: ['GND'], vccPinNames: ['3V3'] }],
      analysis: { kind: 'op' },
    };
    expect(mismatch(await verifyCircuit(input))).toBeDefined();
  });

  it('checks the KS2E-M-DC5 (a 5 V coil) too', { timeout: 60_000 }, async () => {
    const input: BuildNetlistInput = {
      components: [psu(3.3), { id: 'k1', metadataId: 'ks2e-m-dc5', properties: {} }],
      wires: [w('w1', ['psu1', '+'], ['k1', 'COIL1']), w('w2', ['k1', 'COIL2'], ['psu1', '-'])],
      boards: [],
      analysis: { kind: 'op' },
    };
    const finding = mismatch(await verifyCircuit(input));
    expect(finding, 'no warning for the KS2E on 3.3 V').toBeDefined();
    expect(finding!.message).toContain('3.75 V');
  });
});
