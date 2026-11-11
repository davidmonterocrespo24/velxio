/**
 * A voltmeter with its V+ lead on ground reads the AC on its V- lead
 * (velxio/velxio-prod#116).
 *
 * The check meant for the minus lead looked at the plus net
 * (`plusNet === '0' ? undefined : nodes.get(minusNet)`), so with V+ on
 * ground the meter lost its waveform and printed the last transient sample
 * under "DC V": 0.00 µV when the window ended on a zero crossing, the crest
 * otherwise. A real meter with swapped leads reads the same RMS and peak,
 * with the sign of the DC flipped.
 */
import { describe, it, expect } from 'vitest';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { readVoltmeter } from '../simulation/spice/probes';
import { solveInput } from './helpers/solveInput';
import type { ElectricalSolveResult, TimeWaveforms } from '../simulation/spice/types';
import type { Wire } from '../types/wire';

const VM = { id: 'vm', metadataId: 'instr-voltmeter', properties: {} };

describe('a voltmeter with V+ on ground', () => {
  it('reads the waveform on its V- lead: same RMS and peak, DC with the sign flipped', () => {
    const T = 1e-3;
    const time = Array.from({ length: 101 }, (_, k) => (k * 5 * T) / 100);
    const v = time.map((t) => 0.5 + Math.sin((2 * Math.PI * t) / T));
    const tw: TimeWaveforms = { time, nodes: new Map([['n1', v]]), branches: new Map(), period: T };
    const solve = {
      nodeVoltages: { n1: v[v.length - 1] },
      branchCurrents: {},
      converged: true,
      error: null,
      analysisMode: 'tran',
    } as unknown as ElectricalSolveResult;
    const forward = readVoltmeter(VM, (_c, pin) => (pin === 'V+' ? 'n1' : '0'), solve, tw);
    const reversed = readVoltmeter(VM, (_c, pin) => (pin === 'V+' ? '0' : 'n1'), solve, tw);
    expect(forward.ac).toBeDefined();
    expect(reversed.ac).toBeDefined();
    expect(reversed.ac!.rms).toBeCloseTo(forward.ac!.rms, 12);
    expect(reversed.ac!.peak).toBeCloseTo(forward.ac!.peak, 12);
    expect(reversed.ac!.dc).toBeCloseTo(-forward.ac!.dc, 12);
    expect(reversed.display).toBe(reversed.ac!.rmsDisplay);
  });

  it('on a 3 V, 1 kHz generator reads RMS 2.121 V (it read 0.00 µV under DC V)', async () => {
    const wires = [
      { id: 'w1', start: { componentId: 'g', pinName: 'SIG' }, end: { componentId: 'r', pinName: '1' } },
      { id: 'w2', start: { componentId: 'r', pinName: '2' }, end: { componentId: 'g', pinName: 'GND' } },
      { id: 'w3', start: { componentId: 'vm', pinName: 'V-' }, end: { componentId: 'r', pinName: '1' } },
      { id: 'w4', start: { componentId: 'vm', pinName: 'V+' }, end: { componentId: 'g', pinName: 'GND' } },
    ] as Wire[];
    const input = buildInputFromStore({
      components: [
        { id: 'g', metadataId: 'signal-generator', properties: { waveform: 'sine', frequency: 1000, amplitude: 3, offset: 0 } },
        { id: 'r', metadataId: 'resistor', properties: { value: '1k' } },
        VM,
      ],
      wires,
      boards: [],
    });
    const solve = await solveInput(input);
    const reading = readVoltmeter(VM, (c, p) => solve.pinNetMap.get(`${c}:${p}`) ?? null, solve, solve.timeWaveforms);
    expect(reading.ac).toBeDefined();
    expect(Math.abs(reading.ac!.rms - 3 * Math.SQRT1_2)).toBeLessThan(3 * Math.SQRT1_2 * 0.005);
    expect(reading.display).toMatch(/^RMS 2\.12\d V$/);
  });
});
