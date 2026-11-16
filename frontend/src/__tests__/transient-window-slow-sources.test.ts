/**
 * A slow signal generator gets whole periods, however long they are
 * (velxio/velxio-prod#107).
 *
 * A transient was capped at 0.4 s, so a generator under 10 Hz never had its
 * four periods, and one under 2.5 Hz not even one: the meters averaged a
 * fraction of a wave and called it the steady state.
 *  - 0.5 Hz, 0-5 V, into 100 kΩ / 10 µF (τ = 1 s): `.tran 0.1 0.4`, the
 *    capacitor at 1.65 V and the voltmeter DC 1.02 V for a 2.5 V mean;
 *  - 1 Hz into 10 kΩ / 10 µF: the window held only the HIGH half, DC 4.23 V.
 * The cap was about cost, but a single source's four periods are 80 steps
 * whatever its frequency (the step is a twentieth of a period). What costs is
 * a window that also holds a much faster source; that one is bounded in
 * steps instead of seconds. The start-up runs first (#143), so the RC timers
 * of seconds the book wants to teach read their steady state.
 * Runs the real circuit service, scheduler and ngspice (the Node adapter).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  CircuitSimulationService,
  type ElectricalSnapshot,
  type MixedModeSchedulerPort,
  type SimulatorStorePort,
} from '../simulation/spice/CircuitSimulationService';
import {
  getMixedModeScheduler,
  __resetMixedModeScheduler,
  __setSchedulerSolverFactoryForTests,
} from '../simulation/spice/MixedModeScheduler';
import { NgSpiceNodeAdapter } from '../simulation/spice/adapters/NgSpiceNodeAdapter';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { readVoltmeter } from '../simulation/spice/probes';
import type { ElectricalSolveResult } from '../simulation/spice/types';

type Comp = { id: string; metadataId: string; properties: Record<string, unknown> };
type Wire = { id: string; start: { componentId: string; pinName: string }; end: { componentId: string; pinName: string } };
const w = (id: string, a: [string, string], b: [string, string]): Wire => ({
  id,
  start: { componentId: a[0], pinName: a[1] },
  end: { componentId: b[0], pinName: b[1] },
});

const services: CircuitSimulationService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  __resetMixedModeScheduler();
});

/** A 0-5 V square wave into R and C, a voltmeter across C. */
function squareRc(hz: number, r: string, c: string): { components: Comp[]; wires: Wire[] } {
  return {
    components: [
      { id: 'sg1', metadataId: 'signal-generator', properties: { waveform: 'square', frequency: hz, amplitude: 2.5, offset: 2.5 } },
      { id: 'r1', metadataId: 'resistor', properties: { value: r } },
      { id: 'c1', metadataId: 'capacitor', properties: { value: c } },
      { id: 'vm1', metadataId: 'instr-voltmeter', properties: {} },
    ],
    wires: [
      w('w1', ['sg1', 'SIG'], ['r1', '1']),
      w('w2', ['r1', '2'], ['c1', '1']),
      w('w3', ['c1', '2'], ['sg1', 'GND']),
      w('w4', ['vm1', 'V+'], ['c1', '1']),
      w('w5', ['vm1', 'V-'], ['c1', '2']),
    ],
  };
}

async function publishedFor(components: Comp[], wires: Wire[]): Promise<ElectricalSnapshot> {
  __setSchedulerSolverFactoryForTests(() => new NgSpiceNodeAdapter());
  const published: ElectricalSnapshot[] = [];
  const simStore: SimulatorStorePort = {
    getState: () => ({ components, wires, boards: [] }),
    subscribe: () => () => {},
  };
  const service = new CircuitSimulationService(
    simStore,
    { publish: (s) => published.push(s) },
    getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
    { collectBoardPinStates: () => ({}) },
  );
  services.push(service);
  await service.tick();
  return published.at(-1)!;
}

function meterOn(s: ElectricalSnapshot, components: Comp[]) {
  const solve = {
    nodeVoltages: s.nodeVoltages,
    branchCurrents: s.branchCurrents,
    converged: true,
    error: null,
    analysisMode: s.analysisMode,
  } as unknown as ElectricalSolveResult;
  return readVoltmeter(
    components.find((c) => c.id === 'vm1')!,
    (c, p) => s.pinNetMap.get(`${c}:${p}`) ?? null,
    solve,
    s.timeWaveforms,
  );
}

function tranCard(components: Comp[], wires: Wire[]) {
  const { netlist } = buildNetlist(buildInputFromStore({ components, wires: wires as never, boards: [] }));
  const line = netlist.split('\n').find((l) => l.startsWith('.tran '))!;
  const [, step, stop, start] = line.split(/\s+/);
  return { step: Number(step), stop: Number(stop), start: start === undefined ? 0 : Number(start) };
}

describe('a slow generator gets whole periods', () => {
  it('0.5 Hz into 100 kΩ / 10 µF (τ = 1 s): four 2 s periods, settled, a 2.5 V mean', { timeout: 60_000 }, async () => {
    const { components, wires } = squareRc(0.5, '100k', '10u');
    const card = tranCard(components, wires);
    expect(card.stop - card.start).toBeCloseTo(8, 6); // was 0.4 s in all

    const s = await publishedFor(components, wires);
    const reading = meterOn(s, components);
    // It read DC 1.02 V, RMS 1.09 V.
    expect(reading.ac).toBeDefined();
    expect(Math.abs(reading.ac!.dc - 2.5)).toBeLessThan(0.025);
    // Each half period is one τ: the capacitor swings between
    // 5/(1+e) = 1.345 V and 5e/(1+e) = 3.655 V.
    const v = s.timeWaveforms!.nodes.get(s.pinNetMap.get('c1:1')!)!;
    expect(Math.min(...v)).toBeCloseTo(5 / (1 + Math.E), 1);
    expect(Math.max(...v)).toBeCloseTo((5 * Math.E) / (1 + Math.E), 1);
    expect(s.timeWaveforms!.time.at(-1)!).toBeCloseTo(8, 3);
  });

  it('1 Hz into 10 kΩ / 10 µF: the window holds both halves of the wave (it read DC 4.23 V)', { timeout: 60_000 }, async () => {
    const { components, wires } = squareRc(1, '10k', '10u');
    const s = await publishedFor(components, wires);
    const reading = meterOn(s, components);
    expect(reading.ac).toBeDefined();
    expect(Math.abs(reading.ac!.dc - 2.5)).toBeLessThan(0.025);
  });

  it('a window that also holds a much faster source stays within 8000 steps', () => {
    // 1 kHz and 1 Hz: four periods of 1 Hz at a twentieth of 1 kHz's period
    // would be 80 000 steps; whole 1 Hz periods do not fit, so the window
    // stays what the step budget holds.
    const { components, wires } = squareRc(1, '10k', '10u');
    components.push({ id: 'sg2', metadataId: 'signal-generator', properties: { waveform: 'sine', frequency: 1000, amplitude: 1, offset: 0 } });
    components.push({ id: 'r2', metadataId: 'resistor', properties: { value: '1k' } });
    wires.push(w('w6', ['sg2', 'SIG'], ['r2', '1']), w('w7', ['r2', '2'], ['sg2', 'GND']));
    const { step, stop, start } = tranCard(components, wires);
    expect(step).toBeCloseTo(5e-5, 9);
    expect((stop - start) / step).toBeLessThanOrEqual(8000 + 1e-6);
    expect(stop - start).toBeGreaterThanOrEqual(0.4 - 1e-9); // no shorter than the old cap
    // The start-up keeps to its own budget too: rounded to whole 1 s periods
    // it would be 20 000 steps.
    expect(start / step).toBeLessThanOrEqual(10_000 + 1e-6);
  });
});
