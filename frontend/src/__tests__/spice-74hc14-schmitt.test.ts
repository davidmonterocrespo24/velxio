/**
 * The 74HC14's hysteresis (velxio/velxio-prod#144).
 *
 * An inverting Schmitt trigger switches its output low when the input rises
 * past VT+ and back high when it falls below VT-: while the output is high
 * the upper threshold applies. The model had the two swapped (2.0 V while the
 * output was high, 3.0 V while it was low), so an input inside the band had
 * no solution. An RC on 1A stopped the transient at 5.108 ms of 40 ms and
 * nothing said so; a sine starting inside the band produced no samples at all.
 *
 * Thresholds: TI SN74HC14 (SCLS085L) typical VT+ / VT- are 2.5 / 1.6 V at
 * 4.5 V and 3.3 / 2.0 V at 6 V, about 55 % and 35 % of VCC: 2.75 / 1.75 V on
 * the 5 V rail used here.
 *
 * And a transient that does stop early is now reported instead of shown
 * frozen (transientShortfall).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { componentToSpice } from '../simulation/spice/componentToSpice';
import { runNetlist } from './helpers/testSolver';
import {
  transientShortfall,
  TRANSIENT_SHORTFALL_PREFIX,
} from '../simulation/spice/transientShortfall';
import {
  CircuitSimulationService,
  type ElectricalSnapshot,
  type MixedModeSchedulerPort,
} from '../simulation/spice/CircuitSimulationService';
import {
  getMixedModeScheduler,
  __resetMixedModeScheduler,
  __setSchedulerSolverFactoryForTests,
} from '../simulation/spice/MixedModeScheduler';
import { FakeSolverAdapter } from '../simulation/spice/adapters/FakeSolverAdapter';
import { useElectricalStore } from '../store/useElectricalStore';
import { pickSolverError, startSolverFaultReporter } from '../simulation/spice/solverFaultReporter';
import type { BuildNetlistInput } from '../simulation/spice/types';

type Wire = BuildNetlistInput['wires'][number];
const w = (id: string, a: [string, string], b: [string, string]): Wire => ({
  id,
  start: { componentId: a[0], pinName: a[1] },
  end: { componentId: b[0], pinName: b[1] },
});

/** A generator through 10 kOhm into 1A, with 1 uF from 1A to ground. */
function rcIntoSchmitt(src: Record<string, unknown>, step: string, stop: string): BuildNetlistInput {
  return {
    components: [
      { id: 'src', metadataId: 'signal-generator', properties: src },
      { id: 'r1', metadataId: 'resistor', properties: { value: '10000' } },
      { id: 'c1', metadataId: 'capacitor', properties: { value: '1u' } },
      { id: 'u1', metadataId: 'ic-74hc14', properties: {} },
      { id: 'rl', metadataId: 'resistor', properties: { value: '10000' } },
    ],
    wires: [
      w('w1', ['src', 'SIG'], ['r1', '1']),
      w('w2', ['r1', '2'], ['u1', '1A']),
      w('w3', ['u1', '1A'], ['c1', '1']),
      w('w4', ['c1', '2'], ['src', 'GND']),
      w('w5', ['u1', '1Y'], ['rl', '1']),
      w('w6', ['rl', '2'], ['src', 'GND']),
      w('w7', ['u1', 'GND'], ['src', 'GND']),
    ],
    boards: [],
    analysis: { kind: 'tran', step, stop },
  };
}

/** V(1A) at every sample where 1Y crosses mid-rail, with the new level of 1Y. */
async function switchPoints(input: BuildNetlistInput) {
  const { netlist, pinNetMap } = buildNetlist(input);
  const r = await runNetlist(netlist);
  const time = r.vec('time') as number[];
  const a = r.vec(`v(${pinNetMap.get('u1:1A')})`) as number[];
  const y = r.vec(`v(${pinNetMap.get('u1:1Y')})`) as number[];
  const flips: Array<{ to: 'high' | 'low'; vin: number }> = [];
  for (let i = 1; i < y.length; i++) {
    if (y[i - 1]! > 2.5 !== y[i]! > 2.5) flips.push({ to: y[i]! > 2.5 ? 'high' : 'low', vin: a[i]! });
  }
  return { end: time[time.length - 1] ?? 0, samples: time.length, flips };
}

describe('74HC14 Schmitt trigger (#144)', () => {
  it('uses VT+ while its output is high and VT- while it is low', () => {
    const lookup = (pin: string) => ({ '1A': 'a', '1Y': 'y' })[pin] ?? null;
    const card = componentToSpice(
      { id: 'u1', metadataId: 'ic-74hc14', properties: {} },
      lookup,
      { vcc: 5 },
    )!.cards[0];
    expect(card).toBe('B_u1_1 y 0 V = 5 * (1 - u(V(a) - (1.75 + u(V(y)-2.5) * 1)))');
  });

  it(
    'an RC on 1A runs the whole 40 ms and switches at 2.75 V rising and 1.75 V falling',
    { timeout: 60_000 },
    async () => {
      const s = await switchPoints(
        rcIntoSchmitt({ waveform: 'square', frequency: 50, amplitude: 2.5, offset: 2.5 }, '20u', '40m'),
      );
      expect(s.end).toBeCloseTo(0.04, 9);
      const lows = s.flips.filter((f) => f.to === 'low');
      const highs = s.flips.filter((f) => f.to === 'high');
      expect(lows.length).toBeGreaterThanOrEqual(2);
      expect(highs.length).toBeGreaterThanOrEqual(2);
      for (const f of lows) expect(f.vin).toBeCloseTo(2.75, 1);
      for (const f of highs) expect(f.vin).toBeCloseTo(1.75, 1);
    },
  );

  it('a sine that starts inside the band solves from t = 0', { timeout: 60_000 }, async () => {
    const s = await switchPoints(
      rcIntoSchmitt({ waveform: 'sine', frequency: 10, amplitude: 2.5, offset: 2.5 }, '1m', '400m'),
    );
    expect(s.samples).toBeGreaterThan(0);
    expect(s.end).toBeCloseTo(0.4, 9);
    expect(s.flips.length).toBeGreaterThanOrEqual(6);
  });
});

describe('a transient that stops early is reported (#144)', () => {
  afterEach(() => {
    __resetMixedModeScheduler();
    useElectricalStore.getState().reset();
  });

  it('transientShortfall names the instant the run stopped', () => {
    const tran = { kind: 'tran' as const, step: '20u', stop: '40m' };
    const msg = transientShortfall(tran, new Float64Array([0, 0.002, 0.005108]));
    expect(msg).toContain(`${TRANSIENT_SHORTFALL_PREFIX} 5.108 ms of 40.00 ms`);
    expect(transientShortfall(tran, new Float64Array([0, 0.02, 0.04]))).toBeNull();
    expect(transientShortfall({ kind: 'op' }, new Float64Array(0))).toBeNull();
    // It outranks ngspice's own chatter as the error the store keeps.
    expect(pickSolverError(['doAnalyses: TRAN:  Timestep too small', msg!])).toBe(msg);
  });

  it('the solve loop publishes it and the console reports it', async () => {
    // A 100 Hz generator asks for 40 ms; the solver hands back 0.4 ms.
    const fake = new FakeSolverAdapter({
      vectors: { 'v(n0)': new Float64Array([0, 1, 2, 3, 4]) },
      timeAxis: new Float64Array([0, 1e-4, 2e-4, 3e-4, 4e-4]),
    });
    __setSchedulerSolverFactoryForTests(() => fake);
    const snapshots: ElectricalSnapshot[] = [];
    const state = {
      components: [
        {
          id: 'sg1',
          metadataId: 'signal-generator',
          properties: { waveform: 'sine', frequency: 100 },
        },
      ],
      wires: [],
      boards: [],
    };
    const service = new CircuitSimulationService(
      { getState: () => state, subscribe: () => () => {} },
      { publish: (s) => snapshots.push(s) },
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({}) },
    );
    const reported: string[] = [];
    const stopReporter = startSolverFaultReporter((m) => reported.push(m));
    const stop = service.start();
    try {
      await new Promise((r) => setTimeout(r, 20));
      const warning = snapshots[0]?.warnings.find((m) => m.startsWith(TRANSIENT_SHORTFALL_PREFIX));
      expect(warning).toContain('400.0 µs of 40.00 ms');

      useElectricalStore.getState().setSolveResult({
        nodeVoltages: { n0: 4 },
        branchCurrents: {},
        pinNetMap: new Map([['sg1:SIG', 'n0']]),
        analysisMode: 'tran',
        timeWaveforms: undefined,
        converged: false,
        error: pickSolverError(snapshots[0]!.warnings),
        lastSolveMs: 0,
        submittedNetlist: '',
        sourcedNets: new Set(),
      });
      expect(reported).toEqual([warning]);
    } finally {
      stop();
      service.stop();
      stopReporter();
    }
  });
});
