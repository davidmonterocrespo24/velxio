/**
 * Every field the simulator reads as a number goes through the shared value
 * parser (velxio/velxio-prod#118, with #105 and #101).
 *
 * The supply and generator fields went through Number(): "1k", "9V" or
 * "500m" became NaN, ngspice rejected the whole deck and the canvas showed
 * nothing, with no word about which field. Now they read like a resistor's
 * value, and a text that is not a value is reported by the circuit check
 * (and at the field, see value-field-readout-dialog.test.ts), while the
 * netlist gets the field's default, never NaN.
 */
import { describe, it, expect } from 'vitest';
import { componentToSpice } from '../simulation/spice/componentToSpice';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { verifyCircuit } from '../simulation/verify/circuitVerifier';
import { solveInput } from './helpers/solveInput';
import type { BuildNetlistInput } from '../simulation/spice/types';

const close = (got: number, want: number) => {
  expect(Number.isFinite(got)).toBe(true);
  expect(Math.abs(got - want)).toBeLessThanOrEqual(Math.abs(want) * 1e-12);
};

function cards(metadataId: string, properties: Record<string, unknown>, pins: Record<string, string>) {
  const out = componentToSpice(
    { id: 'x', metadataId, properties },
    (p) => pins[p] ?? null,
    { vcc: 5 },
  );
  if (!out) throw new Error(`${metadataId} emitted nothing`);
  return out.cards;
}

/** The value field of a two-terminal card: `R_x a b <value>`. */
const cardValue = (card: string) => Number(card.trim().split(/\s+/)[3]);

describe('every field reads through it (#118)', () => {
  it('a resistor "1M" is a megaohm, a capacitor "100nF" 100 nF, an RKM "4k7" 4.7 kΩ', () => {
    const pins = { '1': 'a', '2': 'b' };
    close(cardValue(cards('resistor', { value: '1M' }, pins)[0]), 1e6);
    close(cardValue(cards('resistor-1k', { value: '4k7' }, pins)[0]), 4700);
    close(cardValue(cards('capacitor', { value: '100nF' }, pins)[0]), 100e-9);
    close(cardValue(cards('capacitor-electrolytic', { value: '1000uF' }, { '+': 'a', '−': 'b' })[0]), 1e-3);
    close(cardValue(cards('inductor', { value: '10mH' }, pins)[0]), 10e-3);
  });

  it('the signal generator reads "1k", "3V" and "0.5V" (it emitted SIN(0 3 NaN))', () => {
    const out = cards(
      'signal-generator',
      { waveform: 'sine', frequency: '1k', amplitude: '3V', offset: '0.5V' },
      { SIG: 's', GND: '0' },
    );
    expect(out.join('\n')).not.toMatch(/NaN/);
    expect(out[0]).toBe('V_x s 0 SIN(0.5 3 1000)');
    const square = cards('signal-generator', { waveform: 'square', frequency: '2kHz', amplitude: 1 }, { SIG: 's', GND: '0' });
    expect(square[0]).toContain('PULSE(-1 1 0 1n 1n 0.00025 0.0005)');
  });

  it('a field that is not a value never reaches the netlist as NaN', () => {
    const gen = cards('signal-generator', { frequency: '1,5k', amplitude: 'x', offset: '' }, { SIG: 's', GND: '0' });
    expect(gen.join('\n')).not.toMatch(/NaN/);
    const ps = cards('power-supply', { voltage: 'nine', currentLimit: '1 A max' }, { SIG: 'p', GND: '0' });
    expect(ps.join('\n')).not.toMatch(/NaN/);
    const relay = cards(
      'relay',
      { coil_resistance: '70Ω', coil_voltage: '5V' },
      { 'COIL+': 'c', 'COIL-': '0', COM: 'm', NO: 'o' },
    );
    expect(relay.join('\n')).not.toMatch(/NaN/);
  });

  it('a supply set to "9V" with a "500m" limit drives its load (the deck was rejected)', async () => {
    const input: BuildNetlistInput = {
      components: [
        { id: 'ps1', metadataId: 'power-supply', properties: { mode: 'dc', voltage: '9V', currentLimit: '500m' } },
        { id: 'rl', metadataId: 'resistor', properties: { value: '1k' } },
      ],
      wires: [
        { id: 'w1', start: { componentId: 'ps1', pinName: 'SIG' }, end: { componentId: 'rl', pinName: '1' } },
        { id: 'w2', start: { componentId: 'rl', pinName: '2' }, end: { componentId: 'ps1', pinName: 'GND' } },
      ],
      boards: [],
      analysis: { kind: 'op' },
    };
    const solve = await solveInput(input);
    const net = solve.pinNetMap.get('rl:1')!;
    expect(net).toBeDefined();
    const v = solve.nodeVoltages[net];
    expect(v).toBeGreaterThan(8.8);
    expect(v).toBeLessThan(9.01);
  });

  it('the transient window reads the generator frequency "2k" (the circuit was solved as .op)', () => {
    const input = buildInputFromStore({
      components: [
        { id: 'g', metadataId: 'signal-generator', properties: { waveform: 'sine', frequency: '2k', amplitude: 1 } },
        { id: 'r', metadataId: 'resistor', properties: { value: '1k' } },
      ],
      wires: [],
      boards: [],
    });
    expect(input.analysis).toMatchObject({
      kind: 'tran',
      step: (1 / (2000 * 20)).toExponential(3),
      stop: (5e-3).toExponential(3),
    });
  });

  it('the circuit check names a field that is not a value, and the number used instead', async () => {
    const input: BuildNetlistInput = {
      components: [
        { id: 'bat', metadataId: 'battery-9v', properties: {} },
        { id: 'r1', metadataId: 'resistor', properties: { value: '4,7k' } },
        { id: 'g1', metadataId: 'signal-generator', properties: { waveform: 'dc', offset: 'five' } },
      ],
      wires: [
        { id: 'w1', start: { componentId: 'bat', pinName: '+' }, end: { componentId: 'r1', pinName: '1' } },
        { id: 'w2', start: { componentId: 'r1', pinName: '2' }, end: { componentId: 'bat', pinName: '−' } },
      ],
      boards: [],
      analysis: { kind: 'op' },
    };
    const result = await verifyCircuit(input);
    const bad = result.errors.filter((e) => (e.code as string) === 'invalid-value');
    expect(bad.map((e) => e.componentId).sort()).toEqual(['g1', 'r1']);
    const r1 = bad.find((e) => e.componentId === 'r1')!;
    expect(r1.message).toContain('"4,7k"');
    expect(r1.message).toContain('1 kΩ');
    const g1 = bad.find((e) => e.componentId === 'g1')!;
    expect(g1.message).toContain('offset');
    expect(g1.message).toContain('0 V');
  });

  it('a value that reads fine raises nothing', async () => {
    const input: BuildNetlistInput = {
      components: [
        { id: 'bat', metadataId: 'battery-9v', properties: {} },
        { id: 'r1', metadataId: 'resistor', properties: { value: '4k7' } },
      ],
      wires: [
        { id: 'w1', start: { componentId: 'bat', pinName: '+' }, end: { componentId: 'r1', pinName: '1' } },
        { id: 'w2', start: { componentId: 'r1', pinName: '2' }, end: { componentId: 'bat', pinName: '−' } },
      ],
      boards: [],
      analysis: { kind: 'op' },
    };
    const result = await verifyCircuit(input);
    expect(result.errors.filter((e) => (e.code as string) === 'invalid-value')).toEqual([]);
  });
});
