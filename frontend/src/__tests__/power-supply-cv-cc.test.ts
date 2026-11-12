/**
 * The lab supply holds its voltage until its current limit, then holds the
 * current (velxio/velxio-prod#96).
 *
 * It was an ideal source behind V / (1.5 · limit): a battery whose internal
 * resistance grew with the setpoint and shrank with the limit. 9 V read
 * 8.946 V on 1 kΩ with a 1 A limit and 8.491 V with 0.1 A, 5 V read
 * 4.983 V, and a 9 Ω load on 9 V / 1 A silently read 5.4 V at 0.6 A: the
 * circuit check only fired below V / (3 · limit). A bench supply holds its
 * setpoint within millivolts up to the limit (Rigol DP800: load regulation
 * < 0.01 % + 2 mV) and then regulates the current (B&K: CV / CC).
 */
import { describe, it, expect } from 'vitest';
import { solveInput } from './helpers/solveInput';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { readVoltmeter, readAmmeter } from '../simulation/spice/probes';
import { verifyCircuit, findSourceConflicts } from '../simulation/verify/circuitVerifier';
import type { BuildNetlistInput } from '../simulation/spice/types';
import type { Wire } from '../types/wire';

const wire = (id: string, a: [string, string], b: [string, string]) =>
  ({ id, start: { componentId: a[0], pinName: a[1] }, end: { componentId: b[0], pinName: b[1] } }) as Wire;

/** Supply -> load resistor -> back, solved as an operating point. */
function supplyOnLoad(supply: Record<string, unknown>, load: string): BuildNetlistInput {
  return {
    components: [
      { id: 'ps', metadataId: 'power-supply', properties: { mode: 'dc', ...supply } },
      { id: 'rl', metadataId: 'resistor', properties: { value: load } },
    ],
    wires: [wire('w1', ['ps', 'SIG'], ['rl', '1']), wire('w2', ['rl', '2'], ['ps', 'GND'])],
    boards: [],
    analysis: { kind: 'op' },
  };
}

async function onLoad(voltage: number, currentLimit: number, load: string) {
  const solve = await solveInput(supplyOnLoad({ voltage, currentLimit }, load));
  const v = solve.nodeVoltages[solve.pinNetMap.get('rl:1')!]!;
  return { v, i: Math.abs(solve.branchCurrents.v_ps ?? NaN) };
}

describe('constant voltage below the limit', () => {
  for (const [volts, limit, before] of [
    [9, 1, 8.94631],
    [9, 0.1, 8.49055],
    [5, 1, 4.98338],
  ] as const) {
    it(`${volts} V / ${limit} A on 1 kΩ reads ${volts}.000 V (it read ${before} V)`, async () => {
      const { v, i } = await onLoad(volts, limit, '1000');
      expect(Math.abs(v - volts)).toBeLessThan(1e-3);
      expect(Math.abs(i - volts / 1000)).toBeLessThan(1e-6);
    });
  }

  it('a 10 Ω load on 9 V / 1 A, just under the limit, still reads 9 V', async () => {
    const { v, i } = await onLoad(9, 1, '10');
    expect(Math.abs(v - 9)).toBeLessThan(0.01);
    expect(i).toBeLessThan(0.91);
  });
});

describe('constant current at the limit', () => {
  it('9 V / 1 A into 5 Ω holds 1 A and drops to 5 V (it read 4.09 V at 0.82 A)', async () => {
    const { v, i } = await onLoad(9, 1, '5');
    expect(Math.abs(i - 1)).toBeLessThan(2e-3);
    expect(Math.abs(v - 5)).toBeLessThan(0.01);
  });

  it('9 V / 0.1 A into 50 Ω holds 100 mA', async () => {
    const { v, i } = await onLoad(9, 0.1, '50');
    expect(Math.abs(i - 0.1)).toBeLessThan(2e-3);
    expect(Math.abs(v - 5)).toBeLessThan(0.1);
  });

  it('a dead short draws the limit, not 1.5 times it', async () => {
    const { i } = await onLoad(9, 0.1, '0.001');
    expect(i).toBeGreaterThan(0.1);
    expect(i).toBeLessThan(0.102);
  });
});

describe('the circuit check', () => {
  it('reports a load at the limit, where the supply has gone constant-current', async () => {
    const result = await verifyCircuit(supplyOnLoad({ voltage: 9, currentLimit: 1 }, '8'));
    const overload = result.errors.find((e) => e.code === 'source-overload');
    expect(overload?.componentId).toBe('ps');
    expect(overload?.message).toMatch(/current limit/);
  });

  it('says nothing about a load under the limit', async () => {
    const result = await verifyCircuit(supplyOnLoad({ voltage: 9, currentLimit: 1 }, '10'));
    expect(result.errors.filter((e) => e.code === 'source-overload')).toEqual([]);
  });

  it('a supply wired onto a board 5V pin or in parallel with another is no source conflict', () => {
    const parallel: BuildNetlistInput = {
      components: [
        { id: 'p1', metadataId: 'power-supply', properties: { mode: 'dc', voltage: 5, currentLimit: 1 } },
        { id: 'p2', metadataId: 'power-supply', properties: { mode: 'dc', voltage: 5, currentLimit: 1 } },
        { id: 'rl', metadataId: 'resistor', properties: { value: '100' } },
      ],
      wires: [
        wire('w1', ['p1', 'SIG'], ['rl', '1']),
        wire('w2', ['p2', 'SIG'], ['rl', '1']),
        wire('w3', ['rl', '2'], ['p1', 'GND']),
        wire('w4', ['p2', 'GND'], ['p1', 'GND']),
      ],
      boards: [],
      analysis: { kind: 'op' },
    };
    expect(findSourceConflicts(buildNetlist(parallel).netlist, parallel)).toEqual([]);
    const onRail: BuildNetlistInput = {
      components: [
        { id: 'ps', metadataId: 'power-supply', properties: { mode: 'dc', voltage: 5, currentLimit: 1 } },
        { id: 'rl', metadataId: 'resistor', properties: { value: '100' } },
      ],
      wires: [
        wire('w1', ['ps', 'SIG'], ['uno', '5V']),
        wire('w2', ['uno', '5V'], ['rl', '1']),
        wire('w3', ['rl', '2'], ['uno', 'GND']),
        wire('w4', ['ps', 'GND'], ['uno', 'GND']),
      ],
      boards: [{ id: 'uno', boardKind: 'arduino-uno', vcc: 5, pins: {}, groundPinNames: ['GND'], vccPinNames: ['5V'] }],
      analysis: { kind: 'op' },
    };
    expect(findSourceConflicts(buildNetlist(onRail).netlist, onRail)).toEqual([]);
  });
});

describe('in AC mode', () => {
  it('a 3 V, 60 Hz supply on 100 Ω reads RMS 2.121 V (it read 2.080 V behind 2 Ω)', async () => {
    const components = [
      { id: 'ps', metadataId: 'power-supply', properties: { mode: 'ac', voltage: 3, frequency: 60, currentLimit: 1 } },
      { id: 'rl', metadataId: 'resistor', properties: { value: '100' } },
      { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
    ];
    const wires = [
      wire('w1', ['ps', 'SIG'], ['rl', '1']),
      wire('w2', ['rl', '2'], ['ps', 'GND']),
      wire('w3', ['vm', 'V+'], ['rl', '1']),
      wire('w4', ['vm', 'V-'], ['rl', '2']),
    ];
    const solve = await solveInput(buildInputFromStore({ components, wires, boards: [] }));
    const r = readVoltmeter(components[2]!, (c, p) => solve.pinNetMap.get(`${c}:${p}`) ?? null, solve, solve.timeWaveforms);
    expect(Math.abs(r.ac!.rms - 3 * Math.SQRT1_2)).toBeLessThan(3 * Math.SQRT1_2 * 0.005);
    expect(Math.abs(r.ac!.dc)).toBeLessThan(0.01);
  });

  it('limits the charging current of a rectifier reservoir, with no current ringing once charged', async () => {
    // 12 V peak, 50 Hz, 1 A limit -> diode -> 1000 µF || 100 Ω, through an
    // ammeter. Before the capacitor charges, the supply sits at its limit;
    // afterwards it tops the capacitor up in short pulses. The diode never
    // conducts backwards, so the supply current must never go negative
    // beyond the diode's leakage: a negative swing is the trapezoidal
    // integration ringing after a constant-current to constant-voltage
    // crossover.
    const components = [
      { id: 'ps', metadataId: 'power-supply', properties: { mode: 'ac', voltage: 12, frequency: 50, currentLimit: 1 } },
      { id: 'am', metadataId: 'instr-ammeter', properties: {} },
      { id: 'd1', metadataId: 'diode-1n4007', properties: {} },
      { id: 'c1', metadataId: 'capacitor-electrolytic', properties: { value: '1000u' } },
      { id: 'rl', metadataId: 'resistor', properties: { value: '100' } },
    ];
    const wires = [
      wire('w1', ['ps', 'SIG'], ['am', 'A+']),
      wire('w2', ['am', 'A-'], ['d1', 'A']),
      wire('w3', ['d1', 'C'], ['c1', '+']),
      wire('w4', ['c1', '+'], ['rl', '1']),
      wire('w5', ['rl', '2'], ['c1', '−']),
      wire('w6', ['c1', '−'], ['ps', 'GND']),
    ];
    const solve = await solveInput(buildInputFromStore({ components, wires, boards: [] }));
    const i = solve.timeWaveforms!.branches.get('v_am_sense')!;
    expect(Math.max(...i)).toBeLessThan(1.01);
    expect(Math.min(...i)).toBeGreaterThan(-1e-3);
    const a = readAmmeter(components[1]!, solve, solve.timeWaveforms);
    expect(a.ac).toBeDefined();
  });
});
