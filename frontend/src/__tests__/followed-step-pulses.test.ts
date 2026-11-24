// @vitest-environment jsdom
/**
 * A moment of a step being followed is a pulse, not a load the circuit holds
 * (velxio/velxio-prod#107).
 *
 * A press or a flip on a circuit that stores energy now publishes the scalar
 * fields along the step it starts (hand-switch-step-follows.test.ts), so the
 * readers that judge a part by the state it holds saw an inrush as if the
 * circuit stayed there: the burnout monitor burns a part at once at 3x its
 * limit, and an LED burns at once past 100 mA. A 1/4 W resistor charging a
 * capacitor through 10 Ohm from 5 V takes 2.5 W for a moment, and a
 * capacitor dumped into an LED through 10 Ohm passes about 160 mA for a
 * moment; neither is the bench's burnout. Now such a moment (the snapshot's
 * stepAtS) burns a part only once it has lasted the burnout monitor's thermal
 * delay, 0.7 s, and the operating point the step settles to is judged as any
 * is.
 *
 * Runs the app's simulator store, the real service subscribed to it, the
 * electrical store the parts read, the burnout monitor and ngspice (the Node
 * adapter), in real time.
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
import { createElectricalStorePort } from '../simulation/spice/start';
import { solvedLedBranch } from '../simulation/parts/ledBranch';
import { decideBurn } from '../simulation/parts/runtimeBurnout';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useElectricalStore } from '../store/useElectricalStore';
import type { TimeWaveforms } from '../simulation/spice/types';

type LoadPayload = Parameters<ReturnType<typeof useSimulatorStore.getState>['loadProjectState']>[0];
type Published = { at: number; s: ElectricalSnapshot };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const running: Array<() => void> = [];
afterEach(() => {
  for (const stop of running.splice(0)) stop();
  __resetMixedModeScheduler();
  useElectricalStore.getState().reset();
  // A part a case burnt stays burnt in the store until a Reset.
  useSimulatorStore.getState().clearBurntComponents();
});

/** The service on the app's simulator store, as the editor mounts it,
 *  publishing into the electrical store and a list. */
function serviceOnStore() {
  __setSchedulerSolverFactoryForTests(() => new NgSpiceNodeAdapter());
  const log: Published[] = [];
  const store = createElectricalStorePort();
  const service = new CircuitSimulationService(
    useSimulatorStore as unknown as SimulatorStorePort,
    {
      publish: (s) => {
        log.push({ at: performance.now(), s });
        store.publish(s);
      },
    },
    getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
    { collectBoardPinStates: () => ({}) },
  );
  const unsubscribe = service.start();
  running.push(() => {
    unsubscribe();
    service.stop();
  });
  const settle = async (): Promise<void> => {
    const before = log.length;
    await vi.waitFor(
      () => {
        const d = service.debugState() as { tickQueued: boolean; busy: boolean };
        expect(d.tickQueued || d.busy, 'the service is still solving').toBe(false);
        expect(log.length, 'nothing was published').toBeGreaterThan(before);
      },
      { timeout: 30_000, interval: 10 },
    );
  };
  return { service, log, settle };
}

const part = (id: string, metadataId: string, properties: Record<string, unknown> = {}) => ({
  id,
  metadataId,
  x: 0,
  y: 0,
  properties,
});
const wire = (id: string, a: [string, string], b: [string, string]) => ({
  id,
  start: { componentId: a[0], pinName: a[1], x: 0, y: 0 },
  end: { componentId: b[0], pinName: b[1], x: 0, y: 0 },
  waypoints: [],
  color: '#00ff00',
});
const project = (
  components: ReturnType<typeof part>[],
  wires: ReturnType<typeof wire>[],
): LoadPayload =>
  ({
    boards: [],
    fileGroups: {},
    folderGroups: {},
    activeBoardId: null,
    components,
    wires,
  }) as unknown as LoadPayload;

/** Write a part's properties the way a button press or a flip does. */
function setProps(id: string, props: Record<string, unknown>): void {
  const sim = useSimulatorStore.getState();
  const comp = sim.components.find((c) => c.id === id);
  if (!comp) throw new Error(`no part ${id} on the canvas`);
  sim.updateComponent(id, { properties: { ...comp.properties, ...props } } as never);
}

const volts = (s: ElectricalSnapshot, pin: string): number => {
  const net = s.pinNetMap.get(pin);
  return net === undefined ? NaN : net === '0' ? 0 : (s.nodeVoltages[net] ?? NaN);
};

/** A one-shot capture of one branch current, the way a step publishes it. */
function stepOf(key: string, time: number[], amps: number[]): TimeWaveforms {
  return {
    time,
    nodes: new Map(),
    branches: new Map([[key, amps]]),
    oneShot: { wallMs: 0 },
  };
}

/** Publish a snapshot straight into the electrical store, as the port does. */
function publishToStore(
  fields: Partial<Parameters<ReturnType<typeof useElectricalStore.getState>['setSolveResult']>[0]>,
) {
  useElectricalStore.getState().setSolveResult({
    nodeVoltages: {},
    branchCurrents: {},
    window: undefined,
    pinNetMap: new Map(),
    analysisMode: 'op',
    timeWaveforms: undefined,
    stepWaveforms: undefined,
    stepAtS: undefined,
    scopeWaveforms: undefined,
    converged: true,
    error: null,
    lastSolveMs: 0,
    submittedNetlist: '',
    sourcedNets: new Set(),
    voltageSources: [],
    ...fields,
  });
}

describe('a moment of a followed step is a pulse, not a load the circuit holds', () => {
  it('the burnout delay holds for a moment however high it is', () => {
    // At once for a load the circuit holds at 3x its burn limit, as before.
    expect(decideBurn(5, 0, 1000).burn).toBe(true);
    // A moment of a step: only once it has lasted the thermal delay.
    expect(decideBurn(5, 0, 1000, true)).toEqual({ burn: false, overSince: 1000 });
    expect(decideBurn(5, 1000, 1500, true).burn).toBe(false);
    expect(decideBurn(5, 1000, 1800, true).burn).toBe(true);
  });

  it('the burnout monitor burns a resistor at 5x its limit at once, but not on a moment of a step', () => {
    // 5 V across 10 Ohm: 2.5 W in a 1/4 W resistor, five times its burn limit.
    useSimulatorStore
      .getState()
      .loadProjectState(project([part('rx', 'resistor', { value: '10' })], []));
    const pinNetMap = new Map([
      ['rx:1', 'n1'],
      ['rx:2', '0'],
    ]);
    publishToStore({ nodeVoltages: { n1: 5 }, pinNetMap, stepAtS: 0.05 });
    expect(useSimulatorStore.getState().burntComponents.has('rx'), 'a moment of a step').toBe(
      false,
    );
    publishToStore({ nodeVoltages: { n1: 5 }, pinNetMap });
    expect(useSimulatorStore.getState().burntComponents.has('rx'), 'a load the circuit holds').toBe(
      true,
    );
  });

  it('an LED reads a pulse over 100 mA as full glow until it has lasted 0.7 s', () => {
    const key = 'v_led1_sense';
    // 300 mA falling to 50 mA over a second.
    const time = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
    const short = stepOf(key, time, [0.3, 0.25, 0.2, 0.12, 0.08, 0.05]);
    publishToStore({ branchCurrents: { [key]: 0.25 }, stepWaveforms: short, stepAtS: 0.2 });
    expect(solvedLedBranch(key)).toEqual({ kind: 'lit', brightness: 1, on: true });
    // Over 100 mA from 0 to 0.9 s: burnt once it has lasted 0.7 s.
    const long = stepOf(key, time, [0.3, 0.28, 0.25, 0.2, 0.15, 0.05]);
    publishToStore({ branchCurrents: { [key]: 0.2 }, stepWaveforms: long, stepAtS: 0.6 });
    expect(solvedLedBranch(key).kind).toBe('lit');
    publishToStore({ branchCurrents: { [key]: 0.15 }, stepWaveforms: long, stepAtS: 0.8 });
    expect(solvedLedBranch(key)).toEqual({ kind: 'over', current: 0.15 });
    // A current the circuit holds burns at once, as before.
    publishToStore({ branchCurrents: { [key]: 0.25 } });
    expect(solvedLedBranch(key)).toEqual({ kind: 'over', current: 0.25 });
  });

  it(
    'a press charging 40 mF through 10 Ohm from 9 V: the inrush is followed, and the resistor survives it',
    { timeout: 120_000 },
    async () => {
      // 8.1 W into a 1/4 W resistor at the press, falling with tau = 0.4 s:
      // past 3x its burn limit (twice the rating) for the first 0.34 s, past
      // the limit for 0.56 s. The 1.6 J it takes is within what a 1/4 W
      // resistor's short-time overload rating allows (6.25 times its power
      // for 5 s).
      const t = serviceOnStore();
      useSimulatorStore
        .getState()
        .loadProjectState(
          project(
            [
              part('ps', 'power-supply', { voltage: 9, currentLimit: 1 }),
              part('btn', 'pushbutton', { pressed: false }),
              part('r1', 'resistor', { value: '10' }),
              part('c1', 'capacitor', { value: '40m' }),
            ],
            [
              wire('w1', ['ps', 'SIG'], ['btn', '1.l']),
              wire('w2', ['btn', '2.l'], ['r1', '1']),
              wire('w3', ['r1', '2'], ['c1', '1']),
              wire('w4', ['c1', '2'], ['ps', 'GND']),
            ],
          ),
        );
      await t.settle();
      const n0 = t.log.length;
      setProps('btn', { pressed: true });
      await sleep(1500);
      expect(
        t.log.slice(n0).some((p) => p.s.stepAtS !== undefined),
        'the press is followed',
      ).toBe(true);
      expect(useSimulatorStore.getState().burntComponents.has('r1')).toBe(false);
      // Charged: no current through the resistor.
      expect(volts(t.log.at(-1)!.s, 'c1:1')).toBeGreaterThan(8.5);
    },
  );

  it(
    'a slide switch dumping 56 mF into an LED through 10 Ohm: full glow while it lasts, fading, never burnt',
    { timeout: 120_000 },
    async () => {
      // Flipped, the switch takes the charged capacitor off the supply and
      // puts it across 10 Ohm and a red LED: well over the 100 mA burnout
      // current for the first half second, under 20 mA within two seconds.
      const t = serviceOnStore();
      useSimulatorStore
        .getState()
        .loadProjectState(
          project(
            [
              part('ps', 'power-supply', { voltage: 5, currentLimit: 1 }),
              part('sw', 'slide-switch', { value: 0 }),
              part('c1', 'capacitor', { value: '56m' }),
              part('r1', 'resistor', { value: '10' }),
              part('led1', 'led', { color: 'red' }),
            ],
            [
              wire('w1', ['ps', 'SIG'], ['sw', '1']),
              wire('w2', ['sw', '2'], ['c1', '1']),
              wire('w3', ['c1', '2'], ['ps', 'GND']),
              wire('w4', ['sw', '3'], ['r1', '1']),
              wire('w5', ['r1', '2'], ['led1', 'A']),
              wire('w6', ['led1', 'C'], ['ps', 'GND']),
            ],
          ),
        );
      await t.settle();
      await sleep(100);
      expect(volts(t.log.at(-1)!.s, 'c1:1'), 'charged from the supply').toBeGreaterThan(4.9);
      const readings: Array<{ amps: number; kind: string; brightness: number; moment: boolean }> =
        [];
      const unsubscribe = useElectricalStore.subscribe((st) => {
        const r = solvedLedBranch('v_led1_sense');
        readings.push({
          amps: Math.abs(st.branchCurrents['v_led1_sense'] ?? 0),
          kind: r.kind,
          brightness: r.kind === 'lit' ? r.brightness : NaN,
          moment: st.stepAtS !== undefined,
        });
      });
      running.push(unsubscribe);
      setProps('sw', { value: 1 });
      await sleep(2500);
      expect(
        readings.some((r) => r.moment),
        'the flip is followed',
      ).toBe(true);
      expect(readings.filter((r) => r.kind !== 'lit')).toEqual([]);
      for (const r of readings) if (r.amps > 0.1) expect(r.brightness).toBe(1);
      // It fades as the capacitor drains.
      expect(readings.at(-1)!.brightness).toBeLessThan(0.5);
    },
  );
});
