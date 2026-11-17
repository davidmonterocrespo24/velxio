/**
 * A deck that settles before its window and holds a diode reads what the
 * circuit does, not what the time step does (velxio/velxio-prod#143).
 *
 * A diode conducts in short pulses around the source's peaks: the smoothed
 * rectifier's reservoir recharges for about 2 ms of each 20 ms period. At the
 * window's step, a twentieth of a period, ngspice did not shorten its step
 * through those pulses (801 time points for a 0.78 s run, one per window
 * step), so each pulse was two or three points. Every cycle left the
 * capacitor a little off, and the start-up's tens of cycles settled it there:
 *  - an-smoothed-rectifier read DC 9.146 V for a reservoir that sits at
 *    8.766 V (+4.3 %; its 4-period window from t = 0 read 8.948 V, +2.1 %);
 *  - an-diode-clamper read 4.540 V for 4.430 V (+2.5 %).
 * At half the window's step the gallery's three settled diode decks read
 * within 0.5 % of a run at a fiftieth of it, and so do twelve variants with
 * other loads, capacitors, diodes, frequencies and a square wave.
 *
 * Each deck is solved as the app solves it (the card its netlist carries, as
 * the service runs it) and compared with the same deck, same start-up, at a
 * twentieth of the window's step. Real ngspice (the Node adapter).
 */
import { describe, it, expect } from 'vitest';
import { exampleProjects } from '../data/examples';
import { exampleToBuildNetlistInput } from '../utils/exampleToBuildNetlistInput';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { NgSpiceNodeAdapter } from '../simulation/spice/adapters/NgSpiceNodeAdapter';
import { readVoltmeter } from '../simulation/spice/probes';
import { parseValueWithUnits } from '../simulation/spice/valueParser';
import type { BuildNetlistInput, ElectricalSolveResult, TimeWaveforms } from '../simulation/spice/types';
import { solveInput } from './helpers/solveInput';

type Meter = { dc: number; rms: number };

function galleryInput(id: string): BuildNetlistInput {
  const ex = exampleProjects.find((e) => e.id === id);
  expect(ex, id).toBeDefined();
  return exampleToBuildNetlistInput(ex!);
}

/** The deck's .tran card, as numbers. */
function card(input: BuildNetlistInput): { step: number; stop: number; start: number } {
  const line = buildNetlist(input).netlist.split('\n').find((l) => l.startsWith('.tran '));
  expect(line, '.tran card').toBeDefined();
  const [, step, stop, start] = line!.split(/\s+/);
  return { step: Number(step), stop: Number(stop), start: start === undefined ? 0 : Number(start) };
}

/** The voltmeter's DC and RMS, as the app reads them off a solve. */
function meter(input: BuildNetlistInput, pinNetMap: Map<string, string>, solve: ElectricalSolveResult, tw: TimeWaveforms): Meter {
  const vm = input.components.find((c) => c.metadataId === 'instr-voltmeter')!;
  const r = readVoltmeter(vm, (c, p) => pinNetMap.get(`${c}:${p}`) ?? null, solve, tw);
  expect(r.ac, 'a reading over the window').toBeDefined();
  return { dc: r.ac!.dc, rms: r.ac!.rms };
}

/** The deck as the app runs it: the analysis its card carries. */
async function asTheAppReads(input: BuildNetlistInput): Promise<Meter> {
  const solve = await solveInput(input);
  return meter(input, solve.pinNetMap!, solve, solve.timeWaveforms!);
}

/** The same deck and start-up at a twentieth of the window's step. */
async function fineStep(input: BuildNetlistInput): Promise<Meter> {
  if (input.analysis.kind !== 'tran') throw new Error('not a transient');
  const built = buildNetlist(input);
  if (built.analysis.kind !== 'tran') throw new Error('not a transient');
  const adapter = new NgSpiceNodeAdapter();
  await adapter.init();
  await adapter.loadCircuit(built.netlist);
  const step = parseValueWithUnits(input.analysis.step) / 20;
  const start = built.analysis.start ? parseValueWithUnits(built.analysis.start) : 0;
  await adapter.solve(
    built.analysis.start
      ? { kind: 'tran', step: step.toExponential(4), stop: built.analysis.stop, start: built.analysis.start }
      : { kind: 'tran', step: step.toExponential(4), stop: built.analysis.stop },
    { vectorsOfInterest: [] },
  );
  const { vectors } = adapter.readAllCurrentVectors();
  const nodes = new Map<string, number[]>();
  const nodeVoltages: Record<string, number> = {};
  for (const [name, vec] of vectors) {
    if (name === 'time' || name.endsWith('#branch') || vec.real.length === 0) continue;
    nodes.set(name, Array.from(vec.real));
    nodeVoltages[name] = vec.real[vec.real.length - 1]!;
  }
  const tw: TimeWaveforms = {
    time: Array.from(vectors.get('time')!.real, (t) => Math.max(0, t - start)),
    nodes,
    branches: new Map(),
    period: input.analysis.period,
  };
  const solve = { nodeVoltages, branchCurrents: {}, converged: true, error: null, analysisMode: 'tran' } as unknown as ElectricalSolveResult;
  return meter(input, built.pinNetMap, solve, tw);
}

describe('a settled deck that holds a diode reads within 1 % of a fine-step run', () => {
  for (const id of ['an-smoothed-rectifier', 'an-diode-clamper', 'an-voltage-doubler']) {
    it(id, { timeout: 120_000 }, async () => {
      const input = galleryInput(id);
      expect(card(input).start, 'it settles before its window').toBeGreaterThan(0);
      const app = await asTheAppReads(input);
      const ref = await fineStep(input);
      expect(Math.abs(app.dc - ref.dc) / Math.abs(ref.dc)).toBeLessThan(0.01);
      expect(Math.abs(app.rms - ref.rms) / Math.abs(ref.rms)).toBeLessThan(0.01);
    });
  }
});

describe('which decks step finer, and what it costs', () => {
  it("a settled diode deck steps at half the window's step, after the same start-up", () => {
    // 50 Hz, a twentieth of a period is 1 ms; 0.7 s of start-up and 80 ms of
    // window, as before.
    const rect = card(galleryInput('an-smoothed-rectifier'));
    expect(rect.step).toBeCloseTo(0.5e-3, 9);
    expect(rect.start).toBeCloseTo(0.7, 6);
    expect(rect.stop - rect.start).toBeCloseTo(0.08, 6);
    // 1 kHz: 50 µs halved; 70 ms of start-up.
    const clamp = card(galleryInput('an-diode-clamper'));
    expect(clamp.step).toBeCloseTo(25e-6, 12);
    expect(clamp.start).toBeCloseTo(0.07, 6);
  });

  it('the start-up stays bounded: at most twice the 10 000 window steps', () => {
    // The doubler's 7 s start-up, the longest in the gallery, is 14 000 of
    // its half steps.
    const doubler = card(galleryInput('an-voltage-doubler'));
    expect(doubler.start).toBeCloseTo(7, 6);
    expect(doubler.start / doubler.step).toBeLessThanOrEqual(2 * 10_000 + 1e-6);
  });

  it('a deck with nothing to settle, or no diode, keeps the window step', () => {
    // A diode with no capacitor: no start-up, the window from t = 0.
    const halfWave = card(galleryInput('an-half-wave-rectifier'));
    expect(halfWave).toEqual({ step: 1e-3, stop: 0.08, start: 0 });
    // 490 Hz into 10 kΩ / 10 µF: a start-up, no diode.
    const filter = card(
      buildInputFromStore({
        components: [
          { id: 'sg1', metadataId: 'signal-generator', properties: { waveform: 'square', frequency: 490, amplitude: 2.5, offset: 2.5 } },
          { id: 'r1', metadataId: 'resistor', properties: { value: '10k' } },
          { id: 'c1', metadataId: 'capacitor', properties: { value: '10u' } },
        ],
        wires: [
          { id: 'w1', start: { componentId: 'sg1', pinName: 'SIG' }, end: { componentId: 'r1', pinName: '1' } },
          { id: 'w2', start: { componentId: 'r1', pinName: '2' }, end: { componentId: 'c1', pinName: '1' } },
          { id: 'w3', start: { componentId: 'c1', pinName: '2' }, end: { componentId: 'sg1', pinName: 'GND' } },
        ] as never,
        boards: [],
      }),
    );
    expect(filter.start).toBeGreaterThan(0);
    expect(filter.step).toBeCloseTo(1 / (490 * 20), 7);
  });
});
