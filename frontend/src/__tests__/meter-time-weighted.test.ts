/**
 * Meters and LEDs average a transient over TIME, on whole periods
 * (velxio/velxio-prod#100, #106).
 *
 * ngspice keeps the points of its own variable time step, crowded wherever
 * the signal moves fast. The voltmeter and ammeter averaged those points
 * with equal weight over the second half of the window counted in POINTS,
 * which for a sine is not a whole number of periods:
 *   - the default 1 kHz, 1 V generator on 1 kΩ read RMS 692.6 mV and
 *     DC -91 mV for 707.1 mV and 0 V;
 *   - an RC driven by a 0-5 V square wave (the book's practice 7.1) read
 *     393 µA RMS for a true 157 µA, because most of a period's points sit
 *     right after the edges, where the current peaks.
 * The LED's transient brightness had the same flaw over the whole capture:
 * an RC-coupled LED glowed at about 20 % for a mean current of about 1 %.
 * Now the statistics are the trapezoid on x and x² (|x| for the LED) over
 * the last whole periods of the slowest source, after settling.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { buildPinNetLookup, readVoltmeter, readAmmeter } from '../simulation/spice/probes';
import { solveInput } from './helpers/solveInput';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import { useElectricalStore } from '../store/useElectricalStore';
import '../simulation/parts/BasicParts';
import type { ElectricalSolveResult, TimeWaveforms } from '../simulation/spice/types';
import type { Wire } from '../types/wire';

const wire = (id: string, a: [string, string], b: [string, string]) =>
  ({ id, start: { componentId: a[0], pinName: a[1] }, end: { componentId: b[0], pinName: b[1] } }) as Wire;

type Comp = { id: string; metadataId: string; properties: Record<string, unknown> };

async function solveCircuit(components: Comp[], wires: Wire[]) {
  const input = buildInputFromStore({ components, wires, boards: [] });
  expect(input.analysis.kind).toBe('tran');
  return solveInput(input);
}

describe('a synthetic waveform with crowded points', () => {
  it('reads a sine sampled unevenly by its time, over whole periods', () => {
    // 1 V, 1 kHz, five periods: T/20 points, plus ten more crowded into the
    // first tenth of every period, the way ngspice crowds them after an edge.
    const T = 1e-3;
    const time: number[] = [];
    for (let k = 0; k < 5; k++) {
      for (let j = 0; j < 20; j++) {
        time.push(k * T + (j * T) / 20);
        if (j < 2) for (let m = 1; m < 6; m++) time.push(k * T + (j * T) / 20 + (m * T) / 120);
      }
    }
    time.push(5 * T);
    const v = time.map((t) => Math.sin((2 * Math.PI * t) / T));
    const tw: TimeWaveforms = { time, nodes: new Map([['n1', v]]), branches: new Map(), period: T };
    const solve = {
      nodeVoltages: { n1: v[v.length - 1] },
      branchCurrents: {},
      converged: true,
      error: null,
      analysisMode: 'tran',
    } as unknown as ElectricalSolveResult;
    const reading = readVoltmeter(
      { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
      (_c, pin) => (pin === 'V+' ? 'n1' : '0'),
      solve,
      tw,
    );
    expect(reading.ac).toBeDefined();
    // The trapezoid on uneven T/20 points is good to about 0.1 %.
    expect(Math.abs(reading.ac!.rms - Math.SQRT1_2)).toBeLessThan(Math.SQRT1_2 * 0.003);
    expect(Math.abs(reading.ac!.dc)).toBeLessThan(2e-3);
  });
});

describe('the meters on real transients', () => {
  it('the default generator (1 kHz, 1 V) on 1 kΩ reads RMS 707 mV and DC 0 (it read 692.6 mV, -91 mV)', async () => {
    const components: Comp[] = [
      { id: 'g', metadataId: 'signal-generator', properties: { waveform: 'sine', frequency: 1000, amplitude: 1, offset: 0 } },
      { id: 'r', metadataId: 'resistor', properties: { value: '1k' } },
      { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
    ];
    const wires = [
      wire('w1', ['g', 'SIG'], ['r', '1']),
      wire('w2', ['r', '2'], ['g', 'GND']),
      wire('w3', ['vm', 'V+'], ['r', '1']),
      wire('w4', ['vm', 'V-'], ['g', 'GND']),
    ];
    const solve = await solveCircuit(components, wires);
    const lookup = buildPinNetLookup(wires, [{ componentId: 'g', pinName: 'GND' }], []);
    const reading = readVoltmeter(components[2]!, lookup, solve, solve.timeWaveforms);
    expect(reading.ac).toBeDefined();
    expect(Math.abs(reading.ac!.rms - Math.SQRT1_2)).toBeLessThan(Math.SQRT1_2 * 0.005);
    expect(Math.abs(reading.ac!.dc)).toBeLessThan(0.005);
    expect(reading.ac!.peak).toBeGreaterThan(0.98);
  });

  it('a 50 Hz sine reads its RMS too (window of four periods, read over two)', async () => {
    const components: Comp[] = [
      { id: 'g', metadataId: 'signal-generator', properties: { waveform: 'sine', frequency: 50, amplitude: 5, offset: 0 } },
      { id: 'r', metadataId: 'resistor', properties: { value: '1k' } },
      { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
    ];
    const wires = [
      wire('w1', ['g', 'SIG'], ['r', '1']),
      wire('w2', ['r', '2'], ['g', 'GND']),
      wire('w3', ['vm', 'V+'], ['r', '1']),
      wire('w4', ['vm', 'V-'], ['g', 'GND']),
    ];
    const solve = await solveCircuit(components, wires);
    const lookup = buildPinNetLookup(wires, [{ componentId: 'g', pinName: 'GND' }], []);
    const reading = readVoltmeter(components[2]!, lookup, solve, solve.timeWaveforms);
    expect(Math.abs(reading.ac!.rms - 5 * Math.SQRT1_2)).toBeLessThan(5 * Math.SQRT1_2 * 0.005);
    expect(Math.abs(reading.ac!.dc)).toBeLessThan(0.025);
  });

  it('a 0-5 V, 100 Hz square into 10 kΩ + 100 nF reads 157 µA RMS (it read 393 µA)', async () => {
    // Steady state: the capacitor swings 0.034 V <-> 4.966 V, and each edge
    // starts a 4.966 V / 10 kΩ = 0.497 mA spike decaying with τ = 1 ms, so
    // I_rms = 0.497 mA · sqrt(τ / T) = 157.05 µA (T = 10 ms).
    const components: Comp[] = [
      { id: 'g', metadataId: 'signal-generator', properties: { waveform: 'square', frequency: 100, amplitude: 2.5, offset: 2.5 } },
      { id: 'am', metadataId: 'instr-ammeter', properties: {} },
      { id: 'r', metadataId: 'resistor', properties: { value: '10k' } },
      { id: 'c', metadataId: 'capacitor', properties: { value: '100n' } },
    ];
    const wires = [
      wire('w1', ['g', 'SIG'], ['am', 'A+']),
      wire('w2', ['am', 'A-'], ['r', '1']),
      wire('w3', ['r', '2'], ['c', '1']),
      wire('w4', ['c', '2'], ['g', 'GND']),
    ];
    const solve = await solveCircuit(components, wires);
    const reading = readAmmeter(components[1]!, solve, solve.timeWaveforms);
    expect(reading.ac).toBeDefined();
    expect(reading.ac!.rms).toBeGreaterThan(157.05e-6 * 0.97);
    expect(reading.ac!.rms).toBeLessThan(157.05e-6 * 1.03);
    // A capacitor passes no DC.
    expect(Math.abs(reading.ac!.dc)).toBeLessThan(5e-6);
  });
});

describe('an LED driven through a capacitor (#106)', () => {
  afterEach(() => {
    useElectricalStore.setState({ branchCurrents: {}, timeWaveforms: undefined });
  });

  it('glows at its time-averaged current, about 1 %, not 20 %', async () => {
    // 0-5 V, 100 Hz square -> 1 µF -> 220 Ω -> LED; 1 kΩ from the capacitor
    // to ground lets it discharge. The LED only conducts a short spike after
    // each rising edge: its mean current is about 0.2 mA, 1 % of 20 mA.
    const components: Comp[] = [
      { id: 'g', metadataId: 'signal-generator', properties: { waveform: 'square', frequency: 100, amplitude: 2.5, offset: 2.5 } },
      { id: 'c', metadataId: 'capacitor', properties: { value: '1u' } },
      { id: 'rd', metadataId: 'resistor', properties: { value: '1k' } },
      { id: 'rs', metadataId: 'resistor', properties: { value: '220' } },
      { id: 'led1', metadataId: 'led', properties: { color: 'red' } },
    ];
    const wires = [
      wire('w1', ['g', 'SIG'], ['c', '1']),
      wire('w2', ['c', '2'], ['rd', '1']),
      wire('w3', ['rd', '2'], ['g', 'GND']),
      wire('w4', ['c', '2'], ['rs', '1']),
      wire('w5', ['rs', '2'], ['led1', 'A']),
      wire('w6', ['led1', 'C'], ['g', 'GND']),
    ];
    const solve = await solveCircuit(components, wires);
    expect(solve.timeWaveforms?.branches.get('v_led1_sense')).toBeDefined();

    const el = { value: false, brightness: 0, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const sim = { pinManager: { onPinChange: vi.fn().mockReturnValue(() => {}), onPwmChange: vi.fn().mockReturnValue(() => {}) } };
    const detach = PartSimulationRegistry.get('led')!.attachEvents!(
      el as unknown as HTMLElement,
      sim as never,
      () => null,
      'led1',
    );
    useElectricalStore.setState({ branchCurrents: solve.branchCurrents, timeWaveforms: solve.timeWaveforms });
    expect(el.brightness).toBeGreaterThan(0.004);
    expect(el.brightness).toBeLessThan(0.02);
    detach?.();
  });
});
