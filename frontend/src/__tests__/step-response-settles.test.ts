/**
 * A step ends where the circuit settles, and only analogRead follows it
 * (velxio/velxio-prod#153, after the review of 3befa6ab).
 *
 * After a pad edge the circuit service runs the step a capacitor or an
 * inductor takes from the state it was in. It sized that run from the deck's
 * time constant, its largest R times its largest C (or an L over its largest
 * R), and the ADC held the capture's last sample from its end on, with no
 * time limit. Three 10 kOhm in series into 100 uF (tau 3 s, estimated 1 s)
 * stayed at 4.822 V for good, and a 1 H coil behind its own 10 Ohm, with
 * 10 kOhm elsewhere (tau 0.1 s, estimated 0.1 ms), at 4.520 V, where the
 * bench and release 7 give 5 V and 0 V. The step was also published as the
 * state's own capture, so a voltmeter on a plain RC read its tail as AC
 * ("RMS 4.988 V" for a DC 4.995 V) and the next edge started from the held
 * sample.
 *
 * Now a step runs until the circuit has settled, every ADC reads the
 * operating point the scalar fields hold once the step is over, and the step
 * is published apart from the state's own capture, so the meters read DC.
 *
 * Runs the real service, scheduler, ADC bridge and ngspice (the Node
 * adapter). The board's ADC is a stand-in with the AVR ADC's shape, read on a
 * guest clock the spec sets.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  CircuitSimulationService,
  type ElectricalSnapshot,
  type MixedModeSchedulerPort,
  type SimulatorStorePort,
  type SolveWindowState,
} from '../simulation/spice/CircuitSimulationService';
import {
  getMixedModeScheduler,
  __resetMixedModeScheduler,
  __setSchedulerSolverFactoryForTests,
} from '../simulation/spice/MixedModeScheduler';
import { NgSpiceNodeAdapter } from '../simulation/spice/adapters/NgSpiceNodeAdapter';
import { createElectricalStorePort } from '../simulation/spice/start';
import { connectAnalogInputsToMcu } from '../simulation/spice/connectAnalogInputsToMcu';
import { averageOverWindow, readAmmeter, readVoltmeter } from '../simulation/spice/probes';
import { readSpan, spanStats } from '../simulation/spice/waveformStats';
import { useSimulatorStore, getBoardSimulator } from '../store/useSimulatorStore';
import { useElectricalStore } from '../store/useElectricalStore';
import type { PinSourceState } from '../simulation/spice/types';

type Part = { id: string; metadataId: string; properties: Record<string, unknown> };
type Wire = { id: string; start: { componentId: string; pinName: string }; end: { componentId: string; pinName: string } };
const w = (id: string, a: [string, string], b: [string, string]): Wire => ({
  id,
  start: { componentId: a[0], pinName: a[1] },
  end: { componentId: b[0], pinName: b[1] },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the service has nothing under way: no solve running or asked
 *  for, no window open (a pad that heals runs its rebuild unawaited). */
async function idle(service: CircuitSimulationService): Promise<void> {
  for (let quiet = 0, i = 0; quiet < 3 && i < 1500; i++) {
    await sleep(20);
    const d = service.debugState() as { busy: boolean; tickQueued: boolean; windowOpen: boolean };
    quiet = d.busy || d.tickQueued || d.windowOpen ? 0 : quiet + 1;
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0).reverse()) f();
  __resetMixedModeScheduler();
});

/**
 * An Uno whose pin 8 the spec drives, on the real service publishing into
 * the electrical store, with the ADC bridge hooked into a stand-in AVR ADC.
 * `analogRead(at)` converts A0 at `at` seconds of the board's own clock.
 */
function bench(id: string, parts: Part[], wires: Wire[]) {
  __setSchedulerSolverFactoryForTests(() => new NgSpiceNodeAdapter());
  useSimulatorStore.getState().addBoard('arduino-uno', 0, 0, id);
  const sim = getBoardSimulator(id) as unknown as Record<string, unknown>;
  let guestUs = 0;
  const conversions: number[] = [];
  const adc = {
    channelValues: [] as number[],
    referenceVoltage: 5,
    sampleCycles: 0,
    cpu: { addClockEvent: (fn: () => void) => fn() },
    completeADCRead: (value: number) => conversions.push(value),
    onADCRead: (_input: unknown) => {},
  };
  sim.getADC = () => adc;
  sim.getGuestMicros = () => guestUs;
  const unhook = connectAnalogInputsToMcu();

  let pins: Record<string, PinSourceState> = {};
  const published: ElectricalSnapshot[] = [];
  const port = createElectricalStorePort();
  const simStore: SimulatorStorePort = {
    getState: () => ({ components: parts, wires, boards: [{ id, boardKind: 'arduino-uno', running: true }] }),
    subscribe: () => () => {},
  };
  const service = new CircuitSimulationService(
    simStore,
    {
      publish: (s) => {
        published.push(s);
        port.publish(s);
      },
    },
    getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
    { collectBoardPinStates: () => pins },
  );
  cleanups.push(() => {
    service.stop();
    unhook();
    useSimulatorStore.getState().removeBoard(id);
    useElectricalStore.getState().reset();
  });

  /** digitalWrite(8, high) at `atS` seconds of the board's clock. */
  const drive = async (high: boolean, atS: number) => {
    pins = { '8': { type: 'digital', v: high ? 5 : 0 } };
    guestUs = atS * 1e6;
    await service.handleMcuEdge(id, '8', high, 5, atS * 1000);
    await idle(service);
  };
  /** analogRead(A0) at `atS` seconds, in volts (10-bit, 5 V reference). */
  const analogRead = (atS: number): number => {
    guestUs = atS * 1e6;
    adc.onADCRead({ type: 0, channel: 0 });
    return (conversions.at(-1)! * 5) / 1024;
  };
  return { service, published, drive, analogRead };
}

/** The voltage the scalar fields of the latest publish give A0. */
const scalarA0 = (s: ElectricalSnapshot, id: string): number => s.nodeVoltages[s.pinNetMap.get(`${id}:A0`)!]!;

describe('a step runs until the circuit settles, then the ADC reads the operating point', () => {
  it('three 10 kOhm in series into 100 uF: tau 3 s, not the 1 s the largest R times C gives', { timeout: 120_000 }, async () => {
    const id = 'uno-rrrc';
    const { service, published, drive, analogRead } = bench(
      id,
      [
        { id: 'r1', metadataId: 'resistor', properties: { value: '10k' } },
        { id: 'r2', metadataId: 'resistor', properties: { value: '10k' } },
        { id: 'r3', metadataId: 'resistor', properties: { value: '10k' } },
        { id: 'c1', metadataId: 'capacitor', properties: { value: '100u' } },
      ],
      [
        w('w1', [id, '8'], ['r1', '1']),
        w('w2', ['r1', '2'], ['r2', '1']),
        w('w3', ['r2', '2'], ['r3', '1']),
        w('w4', ['r3', '2'], ['c1', '1']),
        w('w5', ['c1', '2'], [id, 'GND.1']),
        w('w6', ['c1', '1'], [id, 'A0']),
      ],
    );
    await service.tick(); // pin 8 not driven yet: the capacitor at 0 V
    await drive(true, 0.1);
    const tau = 3;
    // The curve, on the board's clock since the edge (10-bit: 4.9 mV a step).
    expect(analogRead(0.1 + 1)).toBeCloseTo(5 * (1 - Math.exp(-1 / tau)), 1);
    expect(Math.abs(analogRead(0.1 + 6) - 5 * (1 - Math.exp(-6 / tau)))).toBeLessThan(0.02);
    // Where it ends: the operating point, an hour later as at once.
    expect(scalarA0(published.at(-1)!, id)).toBeCloseTo(5, 2);
    expect(analogRead(0.1 + 3600)).toBeGreaterThan(4.99);
    // The next edge starts from there, not from wherever the run stopped.
    await drive(false, 0.1 + 3600);
    expect(Math.abs(analogRead(0.1 + 3600 + 1) - 5 * Math.exp(-1 / tau))).toBeLessThan(0.02);
    expect(analogRead(0.1 + 7200)).toBeLessThan(0.01);
  });

  it('a 1 H coil behind its own 10 Ohm, 10 kOhm elsewhere: tau 0.1 s, not 0.1 ms', { timeout: 120_000 }, async () => {
    const id = 'uno-rl';
    const { service, published, drive, analogRead } = bench(
      id,
      [
        { id: 'r1', metadataId: 'resistor', properties: { value: '10' } },
        { id: 'l1', metadataId: 'inductor', properties: { value: '1' } },
        { id: 'r2', metadataId: 'resistor', properties: { value: '10k' } },
      ],
      [
        w('w1', [id, '8'], ['r1', '1']),
        w('w2', ['r1', '2'], ['l1', '1']),
        w('w3', ['l1', '2'], [id, 'GND.1']),
        w('w4', ['r1', '2'], [id, 'A0']),
        w('w5', ['r1', '2'], ['r2', '1']),
        w('w6', ['r2', '2'], [id, 'GND.2']),
      ],
    );
    await service.tick();
    await drive(true, 0.1);
    // The coil's node falls as its current builds: 5 V * 10k / 10.01k * e^(-t / tau),
    // tau = 1 H / (10 Ohm || 10 kOhm).
    const tau = 1 / ((10 * 10e3) / (10 + 10e3));
    const v = (t: number) => ((5 * 10e3) / (10e3 + 10)) * Math.exp(-t / tau);
    expect(Math.abs(analogRead(0.1 + 0.01) - v(0.01))).toBeLessThan(0.02);
    expect(Math.abs(analogRead(0.1 + 0.1) - v(0.1))).toBeLessThan(0.02);
    // At DC the coil shorts the node: 0 V, as release 7 and the bench show.
    expect(scalarA0(published.at(-1)!, id)).toBeCloseTo(0, 2);
    expect(analogRead(0.1 + 1)).toBeLessThan(0.01);
    expect(analogRead(0.1 + 3600)).toBeLessThan(0.01);
  });
});

describe('the meters read a step as the DC it settles to, not its tail as AC', () => {
  it('a voltmeter across an RC and an ammeter in series after the pin goes HIGH', { timeout: 120_000 }, async () => {
    const id = 'uno-vm';
    const { service, published, drive } = bench(
      id,
      [
        { id: 'r1', metadataId: 'resistor', properties: { value: '10000' } },
        { id: 'c1', metadataId: 'capacitor', properties: { value: '100u' } },
        { id: 'vm1', metadataId: 'instr-voltmeter', properties: {} },
        { id: 'am1', metadataId: 'instr-ammeter', properties: {} },
      ],
      [
        w('w1', [id, '8'], ['am1', 'A+']),
        w('w1b', ['am1', 'A-'], ['r1', '1']),
        w('w2', ['r1', '2'], ['c1', '1']),
        w('w3', ['r1', '2'], [id, 'A0']),
        w('w4', ['c1', '2'], [id, 'GND.1']),
        w('w5', ['vm1', 'V+'], ['r1', '2']),
        w('w6', ['vm1', 'V-'], [id, 'GND.2']),
      ],
    );
    await service.tick();
    await drive(true, 0.1);
    expect(service.stepSolveCount).toBeGreaterThan(0);
    const s = published.at(-1)!;
    const look = (c: string, p: string) => s.pinNetMap.get(`${c}:${p}`) ?? null;
    // Read the way the Voltmeter and Ammeter components read the store.
    const solve = {
      nodeVoltages: averageOverWindow(s.window, (st) => (st as SolveWindowState).nodeVoltages, s.nodeVoltages),
      branchCurrents: averageOverWindow(s.window, (st) => (st as SolveWindowState).branchCurrents, s.branchCurrents),
      converged: true,
      error: null,
      solveMs: 0,
      submittedNetlist: '',
      pinNetMap: s.pinNetMap,
      analysisMode: s.timeWaveforms ? ('tran' as const) : ('op' as const),
      timeWaveforms: s.timeWaveforms,
    };
    const vm = readVoltmeter({ id: 'vm1', metadataId: 'instr-voltmeter', properties: {} }, look, solve, s.timeWaveforms);
    const am = readAmmeter({ id: 'am1', metadataId: 'instr-ammeter', properties: {} }, solve, s.timeWaveforms);
    // 5 V across the 10 MOhm voltmeter behind 10 kOhm: 4.995 V and 499.5 nA, DC.
    expect(vm.display).toBe('4.995 V');
    expect(vm.ac).toBeUndefined();
    expect(am.display).toBe('499.5 nA');
    expect(am.ac).toBeUndefined();
    // A wire label on the capacitor's net is DC too (ElectricalOverlay's rule).
    const net = look('c1', '1')!;
    const tw = s.timeWaveforms;
    const span = tw ? readSpan(tw.time, tw.period) : null;
    const samples = tw?.nodes.get(net);
    const stats = tw && span && samples ? spanStats(tw.time, samples, span) : null;
    expect(stats === null || stats.max - stats.min <= 1e-4).toBe(true);
  });
});

describe('a rebuild that changes nothing leaves a step under way where it is', () => {
  it('the same deck rebuilt without a pad edge keeps the curve on the board clock', { timeout: 120_000 }, async () => {
    const id = 'uno-keep';
    const { service, published, drive, analogRead } = bench(
      id,
      [
        { id: 'r1', metadataId: 'resistor', properties: { value: '10000' } },
        { id: 'c1', metadataId: 'capacitor', properties: { value: '100u' } },
      ],
      [
        w('w1', [id, '8'], ['r1', '1']),
        w('w2', ['r1', '2'], ['c1', '1']),
        w('w3', ['r1', '2'], [id, 'A0']),
        w('w4', ['c1', '2'], [id, 'GND.1']),
      ],
    );
    await service.tick();
    await drive(true, 0.1);
    const steps = service.stepSolveCount;
    // The step, in its own field (in the state's capture before it had one).
    const stepOf = (s: ElectricalSnapshot) => s.stepWaveforms ?? (s.timeWaveforms?.oneShot ? s.timeWaveforms : undefined);
    const curve = stepOf(published.at(-1)!);
    expect(curve?.oneShot?.guestMs).toEqual({ [id]: 100 });
    // A part moved on the canvas, or the scope asking for a fresh sweep: the
    // same deck again, with the pads where they were. Run again from the
    // state read on the wall clock, the curve would restart off the board's.
    await service.tick();
    await idle(service);
    expect(service.stepSolveCount).toBe(steps);
    expect(stepOf(published.at(-1)!)).toBe(curve);
    expect(analogRead(0.1 + 1)).toBeCloseTo(5 * (1 - Math.exp(-1)), 1);
  });
});

