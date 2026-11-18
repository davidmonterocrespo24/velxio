// @vitest-environment jsdom
/**
 * A meter on a node with a DC level shows the swing of the signal, and says
 * that its RMS includes the DC (velxio/velxio-prod#125).
 *
 * On an amplifier's collector (4.83 V of bias under a 0.615 V sine) the
 * voltmeter showed "AC V | RMS 4.850 V | pk 5.443 V | DC 4.830 V":
 *  - "pk" was the largest |v|, measured from 0 V, so the screen held no
 *    figure for the AC part alone and no gain could be worked out from it;
 *  - the legend said "AC V", the AC-voltage mode of a bench meter, which
 *    blocks the DC and reads 0.435 V there, while the RMS shown was that of
 *    the whole signal, DC included.
 * Now the sub-line shows the peak-to-peak swing ("pp"), which no DC offset
 * changes, and the legend says "AC+DC" over the RMS of the whole signal.
 * Runs the app's netlist builder and ngspice (the Node adapter), and renders
 * the meters the canvas draws.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createElement, act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { readVoltmeter, readAmmeter } from '../simulation/spice/probes';
import { solveInput } from './helpers/solveInput';
import { Voltmeter } from '../components/components-instruments/Voltmeter';
import { Ammeter } from '../components/components-instruments/Ammeter';
import { useElectricalStore } from '../store/useElectricalStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import type { ElectricalSolveResult } from '../simulation/spice/types';
import type { Wire } from '../types/wire';

const wire = (id: string, a: [string, string], b: [string, string]) =>
  ({ id, start: { componentId: a[0], pinName: a[1] }, end: { componentId: b[0], pinName: b[1] } }) as Wire;

type Comp = { id: string; metadataId: string; properties: Record<string, unknown> };

/** The collector of the book's chapter 14 amplifier: 4.83 V DC + 0.615 V, 1 kHz,
 *  across 1 kΩ, with a voltmeter across it and an ammeter in series. */
function biasedSine(): { components: Comp[]; wires: Wire[] } {
  return {
    components: [
      { id: 'g', metadataId: 'signal-generator', properties: { waveform: 'sine', frequency: 1000, amplitude: 0.615, offset: 4.83 } },
      { id: 'am', metadataId: 'instr-ammeter', properties: {} },
      { id: 'r', metadataId: 'resistor', properties: { value: '1k' } },
      { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
    ],
    wires: [
      wire('w1', ['g', 'SIG'], ['am', 'A+']),
      wire('w2', ['am', 'A-'], ['r', '1']),
      wire('w3', ['r', '2'], ['g', 'GND']),
      wire('w4', ['vm', 'V+'], ['r', '1']),
      wire('w5', ['vm', 'V-'], ['g', 'GND']),
    ],
  };
}

async function solved(components: Comp[], wires: Wire[]): Promise<ElectricalSolveResult> {
  const input = buildInputFromStore({ components, wires, boards: [] });
  expect(input.analysis.kind).toBe('tran');
  return solveInput(input);
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The text elements of a meter as the canvas renders it, in document order. */
function texts(element: ReactElement): string[] {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  const out = [...host.querySelectorAll('text')].map((t) => t.textContent ?? '');
  act(() => root.unmount());
  host.remove();
  return out;
}

afterEach(() => {
  useElectricalStore.getState().reset();
  useSimulatorStore.setState({ wires: [] });
});

describe('a meter on a node with a DC level', () => {
  it('shows the swing of the collector, 1.23 V peak to peak, under a legend that says the RMS includes the DC', async () => {
    const { components, wires } = biasedSine();
    const solve = await solved(components, wires);
    const lookup = (c: string, p: string) => solve.pinNetMap.get(`${c}:${p}`) ?? null;
    const v = readVoltmeter(components[3]!, lookup, solve, solve.timeWaveforms);
    expect(v.ac).toBeDefined();

    // The meter the canvas draws, from the published solve. It read
    // "AC V", "RMS 4.850 V", "pk 5.443 V" and "DC 4.830 V".
    useSimulatorStore.setState({ wires, boards: [] } as never);
    useElectricalStore.setState({
      nodeVoltages: solve.nodeVoltages,
      branchCurrents: solve.branchCurrents,
      timeWaveforms: solve.timeWaveforms,
      pinNetMap: solve.pinNetMap,
      converged: true,
      error: null,
    } as never);
    const shown = texts(createElement(Voltmeter, { id: 'vm' }));
    expect(shown).toContain('AC+DC V');
    expect(shown.filter((t) => /^pk /.test(t))).toEqual([]);
    expect(shown.filter((t) => /^pp /.test(t))).toEqual([v.ac!.peakToPeakDisplay]);
    expect(shown).toContain(v.ac!.rmsDisplay);
    expect(shown).toContain(v.ac!.dcDisplay);

    // 2 x 0.615 V, less up to 1.2 % for a crest that falls between two
    // samples of a twentieth of a period.
    expect(v.ac!.peakToPeak).toBeGreaterThan(1.23 * 0.985);
    expect(v.ac!.peakToPeak).toBeLessThanOrEqual(1.23 * 1.0001);
    expect(v.ac!.peakToPeakDisplay).toMatch(/^pp 1\.2[1-3]\d V$/);
    // The DC and the RMS of the whole signal: sqrt(4.83² + 0.615²/2).
    expect(v.ac!.dc).toBeCloseTo(4.83, 2);
    expect(v.ac!.rms).toBeCloseTo(Math.sqrt(4.83 ** 2 + 0.615 ** 2 / 2), 2);
  });

  it('the ammeter in series shows the current swing the same way, 1.23 mA peak to peak', async () => {
    const { components, wires } = biasedSine();
    const solve = await solved(components, wires);
    const a = readAmmeter(components[1]!, solve, solve.timeWaveforms);
    expect(a.ac).toBeDefined();

    useElectricalStore.setState({
      branchCurrents: solve.branchCurrents,
      timeWaveforms: solve.timeWaveforms,
      converged: true,
      error: null,
    } as never);
    const shown = texts(createElement(Ammeter, { id: 'am' }));
    // It read "AC A" and "pk 5.44 mA".
    expect(shown).toContain('AC+DC A');
    expect(shown.filter((t) => /^pk /.test(t))).toEqual([]);
    expect(shown.filter((t) => /^pp /.test(t))).toEqual([a.ac!.peakToPeakDisplay]);

    expect(a.ac!.peakToPeak).toBeGreaterThan(1.23e-3 * 0.985);
    expect(a.ac!.peakToPeak).toBeLessThanOrEqual(1.23e-3 * 1.0001);
    expect(a.ac!.peakToPeakDisplay).toMatch(/^pp 1\.2[1-3] mA$/);
  });

  it('a sine with no DC reads its RMS, twice its amplitude peak to peak, and DC 0', async () => {
    const { components, wires } = biasedSine();
    components[0]!.properties = { waveform: 'sine', frequency: 1000, amplitude: 1, offset: 0 };
    const solve = await solved(components, wires);
    const lookup = (c: string, p: string) => solve.pinNetMap.get(`${c}:${p}`) ?? null;
    const v = readVoltmeter(components[3]!, lookup, solve, solve.timeWaveforms);
    expect(v.ac!.rms).toBeCloseTo(Math.SQRT1_2, 2);
    expect(v.ac!.peakToPeak).toBeGreaterThan(2 * 0.985);
    expect(v.ac!.peakToPeak).toBeLessThanOrEqual(2 * 1.0001);
    expect(Math.abs(v.ac!.dc)).toBeLessThan(5e-3);
  });

  it('a DC reading keeps its single line and its "DC V" legend', () => {
    useSimulatorStore.setState({ wires: [wire('w1', ['vm', 'V+'], ['r', '1'])], boards: [] } as never);
    useElectricalStore.setState({
      nodeVoltages: { n0: 3.3 },
      pinNetMap: new Map([
        ['vm:V+', 'n0'],
        ['vm:V-', '0'],
      ]),
      timeWaveforms: undefined,
      converged: true,
      error: null,
    } as never);
    const shown = texts(createElement(Voltmeter, { id: 'vm' }));
    expect(shown, JSON.stringify(shown)).toContain('DC V');
    expect(shown, JSON.stringify(shown)).toContain('3.300 V');
  });
});
