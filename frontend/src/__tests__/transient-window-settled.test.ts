/**
 * A circuit driven by a periodic source is read in its steady state, not in
 * the first periods after power-on (velxio/velxio-prod#143).
 *
 * With a signal generator the transient ran four periods of the slowest
 * source from t = 0 and published that, whatever the circuit's own time
 * constant: a 490 Hz square wave (the Uno's PWM rate) into 10 kΩ / 10 µF
 * (τ = 100 ms) ran 8.16 ms, 0.08 τ, so the capacitor read 0.195 V and the
 * voltmeter DC 0.151 V where the real filter sits at 2.5 V with about 25 mV
 * of ripple. Every recapture started again from 0 V.
 *
 * Now the deck runs the circuit for about seven of its largest time
 * constants first (ngspice's TSTART: computed, not stored) and stores only
 * the four periods after that; the time axis the readers get starts at 0.
 * Runs the real circuit service, scheduler and ngspice (the Node adapter).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
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
import type { ElectricalSolveResult, TimeWaveforms } from '../simulation/spice/types';
import { transientShortfall, TRANSIENT_SHORTFALL_PREFIX } from '../simulation/spice/transientShortfall';
import { setElectricalResolveHook } from '../simulation/spice/electricalResolveHook';
import { startAnalogScopeFeed, stopAnalogScopeFeed } from '../simulation/spice/analogScopeFeed';
import { useOscilloscopeStore } from '../store/useOscilloscopeStore';
import { useElectricalStore } from '../store/useElectricalStore';
import { largestTimeConstant } from '../simulation/spice/settleTime';
import { exampleProjects } from '../data/examples';
import { exampleToBuildNetlistInput } from '../utils/exampleToBuildNetlistInput';
import type { SolveAnalysis, SolveResult } from '../simulation/spice/ports/SolverPort';

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

/** The book's chapter 21 filter: the Uno's 490 Hz PWM, 0-5 V, into R and C,
 *  with a voltmeter across C. */
function pwmFilter(r: string, c: string): { components: Comp[]; wires: Wire[] } {
  return {
    components: [
      { id: 'sg1', metadataId: 'signal-generator', properties: { waveform: 'square', frequency: 490, amplitude: 2.5, offset: 2.5 } },
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

/** What the app publishes for a canvas, through the real service. */
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
  const s = published.at(-1);
  expect(s, 'a publish').toBeDefined();
  return s!;
}

/** The deck's .tran card, as numbers. */
function tranCard(components: Comp[], wires: Wire[]): { step: number; stop: number; start: number } {
  const { netlist } = buildNetlist(buildInputFromStore({ components, wires: wires as never, boards: [] }));
  const line = netlist.split('\n').find((l) => l.startsWith('.tran '));
  expect(line, '.tran card').toBeDefined();
  const [, step, stop, start] = line!.split(/\s+/);
  return { step: Number(step), stop: Number(stop), start: start === undefined ? 0 : Number(start) };
}

describe('a periodic source is read in its steady state', () => {
  it('490 Hz into 10 kΩ / 10 µF: the capacitor and the voltmeter read 2.5 V, not the first 8 ms of the charge', { timeout: 60_000 }, async () => {
    const { components, wires } = pwmFilter('10k', '10u');
    const s = await publishedFor(components, wires);
    const cap = s.pinNetMap.get('c1:1')!;
    // The published value is the last sample: on the ripple around 2.5 V
    // (it read 0.195 V).
    expect(Math.abs(s.nodeVoltages[cap]! - 2.5)).toBeLessThan(0.03);

    const tw = s.timeWaveforms!;
    expect(tw).toBeDefined();
    const solve = {
      nodeVoltages: s.nodeVoltages,
      branchCurrents: s.branchCurrents,
      converged: true,
      error: null,
      analysisMode: s.analysisMode,
    } as unknown as ElectricalSolveResult;
    const reading = readVoltmeter(
      components.find((c) => c.id === 'vm1')!,
      (c, p) => s.pinNetMap.get(`${c}:${p}`) ?? null,
      solve,
      tw,
    );
    // Steady state: a mean of 2.5 V, an RMS of sqrt(2.5² + ripple²/12).
    // It read DC 0.151 V, RMS 0.155 V.
    expect(reading.ac).toBeDefined();
    expect(Math.abs(reading.ac!.dc - 2.5)).toBeLessThan(0.0125);
    expect(Math.abs(reading.ac!.rms - 2.5)).toBeLessThan(0.0125);
    // The ripple of a settled RC: about V/(4 f R C) = 25.5 mV peak to peak.
    const v = tw.nodes.get(cap)!;
    const ripple = Math.max(...v) - Math.min(...v);
    expect(ripple).toBeGreaterThan(0.02);
    expect(ripple).toBeLessThan(0.035);

    // The readers get a window that starts at 0 and holds four whole periods
    // (the ADC replays it in a loop, the scope draws it from its left edge).
    expect(tw.time[0]!).toBeGreaterThanOrEqual(0);
    expect(tw.time[0]!).toBeLessThan(1e-4);
    expect(tw.time.at(-1)!).toBeCloseTo(4 / 490, 5);
  });

  it('the deck settles for seven time constants, in whole periods, before the window it stores', () => {
    const { components, wires } = pwmFilter('10k', '10u');
    const { step, stop, start } = tranCard(components, wires);
    expect(step).toBeCloseTo(1 / (490 * 20), 7);
    const periods = start * 490;
    expect(Math.abs(periods - Math.round(periods))).toBeLessThan(1e-3);
    expect(start).toBeGreaterThanOrEqual(0.7); // 7 × 100 ms
    expect(start).toBeLessThan(0.7 + 1 / 490 + 1e-9);
    expect(stop - start).toBeCloseTo(4 / 490, 6);
  });

  it('a capacitor across the generator itself does not lengthen the run', () => {
    // Held by an ideal source at both ends, it adds nothing to wait for.
    const { components } = pwmFilter('10k', '10u');
    const extra: Comp = { id: 'c2', metadataId: 'capacitor', properties: { value: '1000u' } };
    const card = tranCard(
      [...components.filter((c) => c.id !== 'c1' && c.id !== 'vm1'), extra],
      [
        w('w1', ['sg1', 'SIG'], ['r1', '1']),
        w('w2', ['r1', '2'], ['sg1', 'GND']),
        w('w6', ['c2', '1'], ['sg1', 'SIG']),
        w('w7', ['c2', '2'], ['sg1', 'GND']),
      ],
    );
    expect(card.start).toBe(0);
  });

  it('the settling is bounded: τ = 1 s at 490 Hz runs at most 10 000 steps before the window', () => {
    const { components, wires } = pwmFilter('10k', '100u');
    const { step, start } = tranCard(components, wires);
    expect(start).toBeGreaterThan(0.5);
    expect(start / step).toBeLessThanOrEqual(10_000 + 1 / (490 * step));
  });
});

describe('what a settled run costs and says', () => {
  it('the scope does not re-run a deck whose latest publish carries its own capture', () => {
    vi.useFakeTimers();
    const resolves = vi.fn();
    setElectricalResolveHook(resolves);
    try {
      useOscilloscopeStore.setState({ open: true, running: true, channels: [], samples: {} });
      useOscilloscopeStore.getState().addNetChannel('n1', 'n1');
      startAnalogScopeFeed();
      const asked = resolves.mock.calls.length; // the first sweep, asked at once
      const capture: TimeWaveforms = { time: [0, 1e-3], nodes: new Map([['n1', [2.5, 2.5]]]), branches: new Map() };
      useElectricalStore.setState({ timeWaveforms: capture, scopeWaveforms: capture });
      // The same deck would give the same sweep: no re-run (it was one every
      // 250 ms, each a whole settled transient).
      vi.advanceTimersByTime(1000);
      expect(resolves.mock.calls.length).toBe(asked);
      // A pin edge solved as an operating point publishes no capture: a new
      // sweep is due.
      useElectricalStore.setState({ timeWaveforms: undefined });
      vi.advanceTimersByTime(250);
      expect(resolves.mock.calls.length).toBe(asked + 1);
    } finally {
      stopAnalogScopeFeed();
      setElectricalResolveHook(null);
      useElectricalStore.getState().reset();
      useOscilloscopeStore.setState({ channels: [], samples: {} });
      vi.useRealTimers();
    }
  });

  it('a run that fails while it settles says so, rather than "stopped at 0 ns"', () => {
    const message = transientShortfall(
      { kind: 'tran', step: '1.020e-4', stop: '7.081633e-1', start: '7.000000e-1' },
      new Float64Array(0),
    );
    expect(message).toMatch(new RegExp(`^${TRANSIENT_SHORTFALL_PREFIX} an instant before 700.0 ms`));
  });
});

describe('which decks settle, and for how long', () => {
  const galleryCard = (id: string) => {
    const ex = exampleProjects.find((e) => e.id === id)!;
    const { netlist } = buildNetlist(exampleToBuildNetlistInput(ex));
    return netlist.split('\n').find((l) => l.startsWith('.tran '))!;
  };

  it('a sine-driven amplifier starts at its steady-state DC: no start-up is run for its coupling capacitors', () => {
    // 10 µF through a 1 MΩ / 470 kΩ gate divider is 3.2 s, but a sine starts
    // at its offset, so the operating point at t = 0 is the circuit's DC, and
    // what is left is a ripple-sized part of the signal that seven of those
    // time constants would take far more than the start-up's budget to run
    // off (transient-window-sine-settled.test.ts, velxio/velxio-prod#120).
    expect(galleryCard('an-mosfet-common-source').split(/\s+/)).toHaveLength(3);
    expect(galleryCard('an-bjt-common-emitter').split(/\s+/)).toHaveLength(3);
  });

  it("a rectifier runs seven of its reservoir's discharge time constants first, more than it needs", () => {
    // The estimate takes the 100 µF reservoir's discharge through its 1 kΩ
    // load, τ = 100 ms: seven of them in whole 20 ms periods. The reservoir
    // tops up through the diode every cycle, so the circuit is settled within
    // its first cycles: at a fine step it reads 8.766 V from t = 0 and after
    // 1.4 s alike, and the start-up only costs time. The 9.146 V this deck
    // read at first was the step's error, not an unsettled start
    // (transient-window-diode-step.test.ts).
    const [, , stop, start] = galleryCard('an-smoothed-rectifier').split(/\s+/);
    expect(Number(start)).toBeCloseTo(0.7, 6);
    expect(Number(stop) - Number(start)).toBeCloseTo(0.08, 6);
  });

  it('a voltmeter on an op-amp output does not make the feedback capacitor a 1 s time constant', () => {
    // The integrator's square wave starts away from its mean. Since #127 its
    // 100 nF has a 22 k Rf across it (Rf * Cf = 2.2 ms), so it settles through
    // a start-up of a few Rf * Cf; the meter's 10 MΩ on the op-amp output
    // would have made it a 1 s time constant and a 7 s start-up.
    const [, , stop, start] = galleryCard('an-opamp-integrator').split(/\s+/);
    expect(Number(start)).toBeGreaterThan(0);
    expect(Number(start)).toBeLessThan(0.05);
    expect(Number(stop) - Number(start)).toBeCloseTo(0.02, 6);
  });

  it('a series RLC decays with L/R through its resistor, not through the meter across its capacitor', () => {
    const tau = largestTimeConstant([
      'V_src n2 0 PULSE(0 1 0 1n 1n 1e-4 2e-4)',
      'R_r1 n2 n1 10',
      'L_l1 n1 n0 0.001',
      'C_c1 n0 0 0.000001 IC=0',
      'R_vm_vmR n0 0 10Meg',
    ]);
    expect(tau).toBeCloseTo(1e-4, 9); // L/R; the true envelope is 2L/R
  });

  it('when the solver gives up during the start-up, the service shows the window from t = 0 instead of nothing', async () => {
    const runs: SolveAnalysis[] = [];
    let last: SolveResult | null = null;
    const scheduler: MixedModeSchedulerPort = {
      loadCircuit: async () => {},
      resolveDc: async () => {},
      resolveTran: async (step, stop, start) => {
        runs.push(start ? { kind: 'tran', step, stop, start } : { kind: 'tran', step, stop });
        // A settled run that died before its window stores no sample.
        const time = start ? new Float64Array(0) : Float64Array.from([0, 4e-3, 8e-3]);
        last = {
          analysis: runs.at(-1)!,
          vectors: new Map(),
          timeAxis: time,
          solveMs: 0,
          warnings: [],
        };
      },
      getLastResult: () => last,
      onMcuPinChange: async () => {},
      alterSources: async () => {},
    };
    const { components, wires } = pwmFilter('10k', '10u');
    const published: ElectricalSnapshot[] = [];
    const service = new CircuitSimulationService(
      { getState: () => ({ components, wires, boards: [] }), subscribe: () => () => {} },
      { publish: (snap) => published.push(snap) },
      scheduler,
      { collectBoardPinStates: () => ({}) },
    );
    services.push(service);
    await service.tick();
    expect(runs).toHaveLength(2);
    expect(runs[0]!).toMatchObject({ kind: 'tran', start: expect.any(String) });
    expect(runs[1]!).toEqual({ kind: 'tran', step: runs[0]!.kind === 'tran' ? runs[0]!.step : '', stop: expect.any(String) });
    expect(Number((runs[1] as { stop: string }).stop)).toBeCloseTo(4 / 490, 6);
    expect(published.at(-1)!.timeWaveforms?.time).toEqual([0, 4e-3, 8e-3]);
  });
});
