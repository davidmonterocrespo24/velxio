/**
 * The power supply in AC mode runs a transient (velxio/velxio-prod#113).
 *
 * Its mapper emits SIN(0 V f), but pickDynamicAnalysis only looked for
 * signal generators, so the circuit was solved as .op: at t = 0, where the
 * sine is 0 V, and every meter on it read 0.00 µV. With an oscilloscope
 * open, the scope's 20 ms window cut 60 Hz at 1.2 periods. The supply now
 * sizes the window like a generator does: four periods, twenty points each.
 */
import { describe, it, expect } from 'vitest';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { buildPinNetLookup, readVoltmeter } from '../simulation/spice/probes';
import { solveInput } from './helpers/solveInput';
import type { Wire } from '../types/wire';

const wire = (id: string, a: [string, string], b: [string, string]) =>
  ({ id, start: { componentId: a[0], pinName: a[1] }, end: { componentId: b[0], pinName: b[1] } }) as Wire;

/** An AC supply across a 100 Ω load, with a voltmeter across the load. */
function acCircuit(supply: Record<string, unknown>) {
  return {
    components: [
      { id: 'ps', metadataId: 'power-supply', properties: supply },
      { id: 'rl', metadataId: 'resistor', properties: { value: '100' } },
      { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
    ],
    wires: [
      wire('w1', ['ps', 'SIG'], ['rl', '1']),
      wire('w2', ['rl', '2'], ['ps', 'GND']),
      wire('w3', ['vm', 'V+'], ['rl', '1']),
      wire('w4', ['vm', 'V-'], ['rl', '2']),
    ],
    boards: [],
  };
}

describe('a power supply in AC mode', () => {
  it('is solved as a transient of four periods at twenty points per period', () => {
    const input = buildInputFromStore(acCircuit({ mode: 'ac', voltage: 3, frequency: 60, currentLimit: 1 }));
    expect(input.analysis).toMatchObject({
      kind: 'tran',
      step: (1 / (60 * 20)).toExponential(3),
      stop: (4 / 60).toExponential(3),
    });
  });

  it('reads its frequency like any other field ("50Hz")', () => {
    const input = buildInputFromStore(acCircuit({ mode: 'ac', voltage: 3, frequency: '50Hz' }));
    expect(input.analysis).toMatchObject({ kind: 'tran', stop: (4 / 50).toExponential(3) });
  });

  it('in DC mode stays an operating point', () => {
    const input = buildInputFromStore(acCircuit({ mode: 'dc', voltage: 3, frequency: 60 }));
    expect(input.analysis).toEqual({ kind: 'op' });
  });

  it('puts an AC reading on the meter across its load (it read 0.00 µV)', async () => {
    const circuit = acCircuit({ mode: 'ac', voltage: 3, frequency: 60, currentLimit: 1 });
    const input = buildInputFromStore(circuit);
    const solve = await solveInput(input);
    const lookup = buildPinNetLookup(circuit.wires, [{ componentId: 'ps', pinName: 'GND' }], []);
    const reading = readVoltmeter(circuit.components[2]!, lookup, solve, solve.timeWaveforms);
    expect(reading.ac).toBeDefined();
    // 3 V peak: 2.121 V RMS. The supply's own resistance and the meter's
    // statistics (#96, #100) keep the reading within a few percent here.
    expect(reading.ac!.rms).toBeGreaterThan(1.95);
    expect(reading.ac!.rms).toBeLessThan(2.2);
    expect(reading.ac!.peak).toBeGreaterThan(2.8);
  });
});
