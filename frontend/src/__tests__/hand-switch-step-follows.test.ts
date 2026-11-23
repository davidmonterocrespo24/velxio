// @vitest-environment jsdom
/**
 * A press or a flip on a circuit that stores energy is followed in time
 * (velxio/velxio-prod#107).
 *
 * Release 9 made an RC charged from a board pin take its step (#153): the
 * service runs the transient from the state the capacitor is in, and
 * analogRead and the oscilloscope follow it. Two cases were left. A circuit
 * with no driven pin (no board, or a board that drives nothing) was solved at
 * its operating point on every press: an RC charged through a pushbutton
 * showed its final voltage at once. And with a board the step was run, but
 * the meters, the LEDs and the parts read the operating point it settles to,
 * so an RC timer that lights an LED through a transistor seconds after the
 * press lit it at once.
 *
 * Now a rebuild that changes only where pushbuttons and slide switches stand
 * runs the step from the state the circuit is in, with no board as with one,
 * and the service publishes the scalar fields along the curve at the time
 * since the press until it ends. A step that starts while such a step is
 * under way (a pad edge, another press) carries it on. Anything else is
 * solved as before.
 *
 * Runs the app's simulator store, the real service subscribed to it, the
 * electrical store the parts read, and ngspice (the Node adapter), in real
 * time: every publish is checked against the curve at the moment it went
 * out.
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
import { readVoltmeter } from '../simulation/spice/probes';
import { createSpiceResolvedPinResolver } from '../simulation/PinResolver';
import { solvedLedBranch } from '../simulation/parts/ledBranch';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useElectricalStore } from '../store/useElectricalStore';

type LoadPayload = Parameters<ReturnType<typeof useSimulatorStore.getState>['loadProjectState']>[0];
type Published = { at: number; s: ElectricalSnapshot };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const running: Array<() => void> = [];
afterEach(() => {
  for (const stop of running.splice(0)) stop();
  __resetMixedModeScheduler();
  useElectricalStore.getState().reset();
  // reset() keeps the toolbar's Stop, as the app does.
  useElectricalStore.getState().setPaused(false);
  // A part a case burnt stays burnt in the store until a Reset.
  useSimulatorStore.getState().clearBurntComponents();
});

/** The service on the app's simulator store, as the editor mounts it,
 *  publishing into the electrical store and a list stamped with the time
 *  each publish went out. `pins` stands in for the board's pin states. */
function serviceOnStore(pins: () => Record<string, unknown> = () => ({})) {
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
    {
      collectBoardPinStates: () => pins() as never,
      // As start.ts wires it: the toolbar's Stop of a board-less circuit.
      paused: () => useElectricalStore.getState().paused,
    },
  );
  const unsubscribe = service.start();
  running.push(() => {
    unsubscribe();
    service.stop();
  });
  /** Wait until every rebuild the store asked for has been solved. */
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
  boards: Array<{ id: string; boardKind: string; x: number; y: number }> = [],
): LoadPayload =>
  ({
    boards,
    fileGroups: {},
    folderGroups: {},
    activeBoardId: boards[0]?.id ?? null,
    components,
    wires,
  }) as unknown as LoadPayload;

/**
 * An Uno drives pin 13 into an LED (so the deck steps on pad edges, as in
 * release 9); its 5V pin charges 100 uF through the button and 10 kOhm, bled
 * by 100 kOhm and the voltmeter.
 */
const boardRc = (): LoadPayload =>
  project(
    [
      part('btn', 'pushbutton', { pressed: false }),
      part('r1', 'resistor', { value: '10k' }),
      part('r2', 'resistor', { value: '100k' }),
      part('c1', 'capacitor', { value: '100u' }),
      part('vm', 'instr-voltmeter'),
      part('r13', 'resistor', { value: '220' }),
      part('led13', 'led', { color: 'red' }),
    ],
    [
      wire('w1', ['uno', '5V'], ['btn', '1.l']),
      wire('w2', ['btn', '2.l'], ['r1', '1']),
      wire('w3', ['r1', '2'], ['c1', '1']),
      wire('w4', ['c1', '2'], ['uno', 'GND.1']),
      wire('w5', ['r2', '1'], ['c1', '1']),
      wire('w6', ['r2', '2'], ['uno', 'GND.1']),
      wire('w7', ['vm', 'V+'], ['c1', '1']),
      wire('w8', ['vm', 'V-'], ['uno', 'GND.2']),
      wire('w9', ['uno', '13'], ['r13', '1']),
      wire('w10', ['r13', '2'], ['led13', 'A']),
      wire('w11', ['led13', 'C'], ['uno', 'GND.2']),
    ],
    [{ id: 'uno', boardKind: 'arduino-uno', x: 0, y: 0 }],
  );

/** Write a part's properties the way a button press does. */
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
/** Seconds between a publish and the start of the step it carries. */
const sinceStep = (p: Published): number => (p.at - p.s.stepWaveforms!.oneShot!.wallMs) / 1000;

/**
 * The moment of the step a followed publish shows (its stepAtS), checked to
 * be when it went out: read on the curve just before the publish, so no
 * later than it, and earlier only by what a loaded box takes between two
 * statements (a test runner at nice 19 on a busy box was seen at 107 ms).
 */
function momentOf(p: Published): number {
  const t = p.s.stepAtS;
  expect(t, 'a followed publish says its moment').toBeDefined();
  const lag = sinceStep(p) - t!;
  expect(lag).toBeGreaterThanOrEqual(0);
  expect(lag).toBeLessThan(0.5);
  return t!;
}

/** `series` on `time`, linearly interpolated at `t` seconds. */
function curveAt(time: readonly number[], series: readonly number[], t: number): number {
  if (t <= time[0]!) return series[0]!;
  let k = 1;
  while (k < time.length - 1 && time[k]! < t) k++;
  const f = Math.min(1, (t - time[k - 1]!) / (time[k]! - time[k - 1]!));
  return series[k - 1]! + f * (series[k]! - series[k - 1]!);
}

const par = (...rs: number[]) => 1 / rs.reduce((acc, r) => acc + 1 / r, 0);
/** The voltmeter's input resistance (componentToSpice 'instr-voltmeter'). */
const METER_OHMS = 10e6;

describe('a press on a circuit that stores energy is followed in time (velxio/velxio-prod#107)', () => {
  it(
    'no board: a voltmeter across an RC follows the charge through a pushbutton, then the discharge',
    { timeout: 120_000 },
    async () => {
      const t = serviceOnStore();
      // 5 V through the button and 10 kOhm into 100 uF, bled by 100 kOhm and
      // the voltmeter's 10 MOhm.
      useSimulatorStore
        .getState()
        .loadProjectState(
          project(
            [
              part('ps', 'power-supply', { voltage: 5, currentLimit: 1 }),
              part('btn', 'pushbutton', { pressed: false }),
              part('r1', 'resistor', { value: '10k' }),
              part('r2', 'resistor', { value: '100k' }),
              part('c1', 'capacitor', { value: '100u' }),
              part('vm', 'instr-voltmeter'),
            ],
            [
              wire('w1', ['ps', 'SIG'], ['btn', '1.l']),
              wire('w2', ['btn', '2.l'], ['r1', '1']),
              wire('w3', ['r1', '2'], ['c1', '1']),
              wire('w4', ['c1', '2'], ['ps', 'GND']),
              wire('w5', ['r2', '1'], ['c1', '1']),
              wire('w6', ['r2', '2'], ['ps', 'GND']),
              wire('w7', ['vm', 'V+'], ['c1', '1']),
              wire('w8', ['vm', 'V-'], ['ps', 'GND']),
            ],
          ),
        );
      await t.settle();
      await sleep(100);
      expect(volts(t.log.at(-1)!.s, 'c1:1'), 'the capacitor starts empty').toBeLessThan(0.01);

      const bleed = par(100e3, METER_OHMS);
      const vEnd = (5 * bleed) / (10e3 + bleed);
      const tauCharge = par(10e3, bleed) * 100e-6;
      const tauDischarge = bleed * 100e-6;
      const charge = (s: number) => vEnd * (1 - Math.exp(-s / tauCharge));

      const pressedAt = performance.now();
      const n0 = t.log.length;
      setProps('btn', { pressed: true });
      await sleep(1200);
      const pressed = t.log.slice(n0);
      // The first publish after the press is early on the curve, not at its end.
      expect(volts(pressed[0]!.s, 'c1:1')).toBeLessThan(2);
      expect(pressed.length, 'publishes over the 1.2 s after the press').toBeGreaterThan(10);
      // The step began at the press.
      const onset = pressed[0]!.s.stepWaveforms?.oneShot?.wallMs;
      expect(onset, 'the press published a step').toBeDefined();
      expect(Math.abs(onset! - pressedAt)).toBeLessThan(50);
      for (const p of pressed) {
        expect(
          Math.abs(volts(p.s, 'c1:1') - charge(momentOf(p))),
          `at ${sinceStep(p).toFixed(3)} s`,
        ).toBeLessThan(0.01 * vEnd);
      }
      // The meter reads it the way the Voltmeter component reads the store.
      const mid = pressed[Math.floor(pressed.length / 2)]!.s;
      const reading = readVoltmeter(
        { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
        (c, p) => mid.pinNetMap.get(`${c}:${p}`) ?? null,
        {
          nodeVoltages: mid.nodeVoltages,
          branchCurrents: {},
          converged: true,
          error: null,
          solveMs: 0,
          submittedNetlist: '',
          pinNetMap: mid.pinNetMap,
          analysisMode: 'op',
        },
        undefined,
      );
      expect(reading.value).toBeCloseTo(volts(mid, 'c1:1'), 6);
      expect(reading.ac, 'a DC reading').toBeUndefined();

      // Released, it drains through the bleed from where the charge got to.
      const n1 = t.log.length;
      setProps('btn', { pressed: false });
      await sleep(800);
      const released = t.log.slice(n1);
      // A publish about every 0.1 s: the discharge moves 1 % of its range in
      // that time (FOLLOW_STEP).
      expect(released.length).toBeGreaterThan(3);
      const releaseOnset = released[0]!.s.stepWaveforms!.oneShot!.wallMs;
      const v0 = charge((releaseOnset - onset!) / 1000);
      for (const p of released) {
        const expected = v0 * Math.exp(-momentOf(p) / tauDischarge);
        expect(
          Math.abs(volts(p.s, 'c1:1') - expected),
          `at ${sinceStep(p).toFixed(3)} s`,
        ).toBeLessThan(0.01 * vEnd);
      }
    },
  );

  it(
    'no board: a delay-on timer lights its LED through a Darlington seconds after the press',
    { timeout: 120_000 },
    async () => {
      const t = serviceOnStore();
      // The button charges 47 uF through 100 kOhm (1 MOhm bleeds it); the
      // capacitor drives a Darlington's base through 1 MOhm, and the pair
      // sinks the LED's 330 Ohm from 5 V once its base nears 1.3 V.
      useSimulatorStore
        .getState()
        .loadProjectState(
          project(
            [
              part('ps', 'power-supply', { voltage: 5, currentLimit: 1 }),
              part('btn', 'pushbutton', { pressed: false }),
              part('r1', 'resistor', { value: '100k' }),
              part('c1', 'capacitor', { value: '47u' }),
              part('rd', 'resistor', { value: '1M' }),
              part('rb', 'resistor', { value: '1M' }),
              part('q1', 'bjt-2n2222'),
              part('q2', 'bjt-2n2222'),
              part('rl', 'resistor', { value: '330' }),
              part('led1', 'led', { color: 'red' }),
            ],
            [
              wire('w1', ['ps', 'SIG'], ['btn', '1.l']),
              wire('w2', ['btn', '2.l'], ['r1', '1']),
              wire('w3', ['r1', '2'], ['c1', '1']),
              wire('w4', ['c1', '2'], ['ps', 'GND']),
              wire('w5', ['rd', '1'], ['c1', '1']),
              wire('w6', ['rd', '2'], ['ps', 'GND']),
              wire('w7', ['c1', '1'], ['rb', '1']),
              wire('w8', ['rb', '2'], ['q1', 'B']),
              wire('w9', ['q1', 'E'], ['q2', 'B']),
              wire('w10', ['q2', 'E'], ['ps', 'GND']),
              wire('w11', ['q1', 'C'], ['q2', 'C']),
              wire('w12', ['ps', 'SIG'], ['rl', '1']),
              wire('w13', ['rl', '2'], ['led1', 'A']),
              wire('w14', ['led1', 'C'], ['q2', 'C']),
            ],
          ),
        );
      await t.settle();
      await sleep(100);
      const lit = () => {
        const r = solvedLedBranch('v_led1_sense');
        return r.kind === 'lit' ? r.brightness : NaN;
      };
      expect(lit(), 'dark before the press').toBeLessThan(1e-3);

      const n0 = t.log.length;
      setProps('btn', { pressed: true });
      // The LED part reads the electrical store: dark for most of a second.
      await sleep(600);
      expect(lit(), 'still dark 0.6 s after the press').toBeLessThan(0.01);
      expect(t.log.length - n0, 'publishes while the capacitor charges').toBeGreaterThan(5);
      await sleep(2400);
      expect(lit(), 'lit 3 s after the press').toBeGreaterThan(0.3);
      // When it came on: the first publish whose LED current passed half of
      // what it settles to, which the step's operating point holds.
      const pressed = t.log.slice(n0);
      const settled = Math.abs(pressed.at(-1)!.s.branchCurrents['v_led1_sense']!);
      expect(settled).toBeGreaterThan(5e-3);
      const on = pressed.find((p) => Math.abs(p.s.branchCurrents['v_led1_sense']!) > settled / 2);
      expect(on, 'the LED came on').toBeDefined();
      expect(momentOf(on!), 'seconds from the press to the LED').toBeGreaterThan(1);
      expect(momentOf(on!)).toBeLessThan(2.5);
      // And every publish on the way is the step's curve at its moment.
      const step = pressed[0]!.s.stepWaveforms!;
      const ledCurve = step.branches.get('v_led1_sense')!;
      for (const p of pressed) {
        if (p.s.stepAtS === undefined) continue; // the step's end: where it settles
        const expected = curveAt(step.time, ledCurve, momentOf(p));
        const i = p.s.branchCurrents['v_led1_sense']!;
        expect(Math.abs(i - expected), `${i} A at ${p.s.stepAtS.toFixed(3)} s`).toBeLessThan(
          1e-9 + 1e-9 * Math.abs(expected),
        );
      }
    },
  );

  it(
    'no board: a relay delay-off timer keeps its lamp lit after the release until the coil drops out',
    { timeout: 120_000 },
    async () => {
      const t = serviceOnStore();
      // The button charges 470 uF through 100 Ohm; the capacitor holds an NPN
      // on through 2.2 kOhm, and the NPN holds the relay's coil from 5 V; the
      // relay's NO contact lights an LED. Released, the capacitor drains into
      // the base until the coil falls under its drop-out (45 % of 5 V).
      useSimulatorStore
        .getState()
        .loadProjectState(
          project(
            [
              part('ps', 'power-supply', { voltage: 5, currentLimit: 1 }),
              part('btn', 'pushbutton', { pressed: false }),
              part('r1', 'resistor', { value: '100' }),
              part('c1', 'capacitor', { value: '470u' }),
              part('rb', 'resistor', { value: '2.2k' }),
              part('q1', 'bjt-2n2222'),
              part('k1', 'relay', { coil_voltage: 5 }),
              part('rl', 'resistor', { value: '330' }),
              part('led1', 'led', { color: 'red' }),
            ],
            [
              wire('w1', ['ps', 'SIG'], ['btn', '1.l']),
              wire('w2', ['btn', '2.l'], ['r1', '1']),
              wire('w3', ['r1', '2'], ['c1', '1']),
              wire('w4', ['c1', '2'], ['ps', 'GND']),
              wire('w5', ['c1', '1'], ['rb', '1']),
              wire('w6', ['rb', '2'], ['q1', 'B']),
              wire('w7', ['q1', 'E'], ['ps', 'GND']),
              wire('w8', ['ps', 'SIG'], ['k1', 'COIL+']),
              wire('w9', ['k1', 'COIL-'], ['q1', 'C']),
              wire('w10', ['ps', 'SIG'], ['k1', 'COM']),
              wire('w11', ['k1', 'NO'], ['rl', '1']),
              wire('w12', ['rl', '2'], ['led1', 'A']),
              wire('w13', ['led1', 'C'], ['ps', 'GND']),
            ],
          ),
        );
      await t.settle();
      const lamp = () =>
        Math.abs(useElectricalStore.getState().branchCurrents['v_led1_sense'] ?? 0);
      const coil = (s: ElectricalSnapshot) => volts(s, 'k1:COIL+') - volts(s, 'k1:COIL-');
      expect(lamp(), 'the lamp starts dark').toBeLessThan(1e-6);
      setProps('btn', { pressed: true });
      await sleep(800);
      expect(lamp(), 'the press pulls the relay in').toBeGreaterThan(5e-3);
      const n1 = t.log.length;
      setProps('btn', { pressed: false });
      await sleep(1000);
      expect(lamp(), 'still lit a second after the release').toBeGreaterThan(5e-3);
      await sleep(3000);
      expect(lamp(), 'dark four seconds after the release').toBeLessThan(1e-6);
      const released = t.log.slice(n1);
      const off = released.find((p) => Math.abs(p.s.branchCurrents['v_led1_sense'] ?? 0) < 1e-6);
      expect(off, 'the lamp went out').toBeDefined();
      // It went out as the coil fell through the drop-out, 2.25 V.
      const before = released[released.indexOf(off!) - 1]!;
      expect(coil(before.s)).toBeGreaterThan(2.2);
      expect(coil(off!.s)).toBeLessThan(2.3);
      expect(sinceStep(off!), 'seconds from the release to the lamp going out').toBeGreaterThan(
        1.5,
      );
    },
  );

  it(
    'with a board: the meter follows the press, and a pad edge on the way carries the step on',
    { timeout: 120_000 },
    async () => {
      let pin13 = 5;
      const t = serviceOnStore(() => ({ '13': { type: 'digital', v: pin13 } }));
      useSimulatorStore.getState().loadProjectState(boardRc());
      await t.settle();
      await sleep(100);
      expect(t.log.at(-1)!.s.analysisMode, 'a step-response deck').toBe('tran');
      const bleed = par(100e3, METER_OHMS);
      const vEnd = (5 * bleed) / (10e3 + bleed);
      const tau = par(10e3, bleed) * 100e-6;

      const n0 = t.log.length;
      setProps('btn', { pressed: true });
      await sleep(500);
      const pressed = t.log.slice(n0);
      expect(volts(pressed[0]!.s, 'c1:1'), 'early on the curve, not at its end').toBeLessThan(2);
      expect(pressed.length).toBeGreaterThan(5);
      const onset = pressed[0]!.s.stepWaveforms!.oneShot!.wallMs;
      // The charge since the press, at the moment a publish shows: on a step
      // that began at the press or at a later edge that carried it on.
      const curve = (p: Published) =>
        vEnd *
        (1 - Math.exp(-((p.s.stepWaveforms!.oneShot!.wallMs - onset) / 1000 + momentOf(p)) / tau));
      for (const p of pressed) {
        expect(Math.abs(volts(p.s, 'c1:1') - curve(p))).toBeLessThan(0.01 * vEnd);
      }

      // digitalWrite(13, LOW) half a second in: its LED goes dark at once, and
      // the capacitor carries on charging on the same curve.
      pin13 = 0;
      const n1 = t.log.length;
      await t.service.handleMcuEdge('uno', '13', false, 5, null);
      await sleep(600);
      const after = t.log.slice(n1);
      expect(after.length).toBeGreaterThan(5);
      expect(Math.abs(after.at(-1)!.s.branchCurrents['v_led13_sense']!)).toBeLessThan(1e-6);
      for (const p of after) {
        expect(Math.abs(volts(p.s, 'c1:1') - curve(p))).toBeLessThan(0.01 * vEnd);
      }
    },
  );
});

describe('Stop holds a board-less circuit where it is', () => {
  it(
    'a step being followed stops with it, and Run carries it on from there',
    { timeout: 120_000 },
    async () => {
      // The toolbar's Stop pauses a board-less circuit (useElectricalStore
      // .paused): every LED and meter holds what it shows so the user can
      // look at it. A step being followed holds too, and so does its clock.
      const t = serviceOnStore();
      useSimulatorStore
        .getState()
        .loadProjectState(
          project(
            [
              part('ps', 'power-supply', { voltage: 5, currentLimit: 1 }),
              part('btn', 'pushbutton', { pressed: false }),
              part('r1', 'resistor', { value: '10k' }),
              part('r2', 'resistor', { value: '100k' }),
              part('c1', 'capacitor', { value: '100u' }),
            ],
            [
              wire('w1', ['ps', 'SIG'], ['btn', '1.l']),
              wire('w2', ['btn', '2.l'], ['r1', '1']),
              wire('w3', ['r1', '2'], ['c1', '1']),
              wire('w4', ['c1', '2'], ['ps', 'GND']),
              wire('w5', ['r2', '1'], ['c1', '1']),
              wire('w6', ['r2', '2'], ['ps', 'GND']),
            ],
          ),
        );
      await t.settle();
      setProps('btn', { pressed: true });
      await sleep(400);
      useElectricalStore.getState().setPaused(true);
      const heldAt = t.log.length;
      const held = volts(t.log.at(-1)!.s, 'c1:1');
      const heldMoment = t.log.at(-1)!.s.stepAtS!;
      expect(held, 'charging when stopped').toBeLessThan(3);
      await sleep(800);
      expect(t.log.length - heldAt, 'nothing published while stopped').toBeLessThanOrEqual(1);
      // What the meters and the LEDs read: still the moment it stopped at.
      const store = useElectricalStore.getState();
      expect(store.nodeVoltages[store.pinNetMap.get('c1:1')!]).toBeCloseTo(held, 2);
      useElectricalStore.getState().setPaused(false);
      await sleep(300);
      const resumed = t.log.slice(heldAt).filter((p) => p.s.stepAtS !== undefined);
      expect(resumed.length).toBeGreaterThan(2);
      // Carried on from where it stopped: not 0.8 s further down the curve.
      expect(resumed.at(-1)!.s.stepAtS! - heldMoment).toBeLessThan(0.6);
      expect(resumed.at(-1)!.s.stepAtS! - heldMoment).toBeGreaterThan(0.1);
    },
  );

  it(
    'with a board on the canvas, a Stop a board-less canvas left behind holds nothing: the press is followed and the pad edges publish',
    { timeout: 120_000 },
    async () => {
      // The board-less Stop sets the flag, and only a board-less Run, a
      // chips-only Run or a gallery example clears it: opening a saved
      // project, importing one, restoring a draft or adding a board leave it
      // set. A running board's canvas takes presses all the same, and the
      // board's own Run and Stop are what start and stop it.
      let pin13 = 5;
      const t = serviceOnStore(() => ({ '13': { type: 'digital', v: pin13 } }));
      useSimulatorStore.getState().loadProjectState(boardRc());
      await t.settle();
      await sleep(100);
      useElectricalStore.getState().setPaused(true);
      const n0 = t.log.length;
      setProps('btn', { pressed: true });
      await sleep(800);
      const pressed = t.log.slice(n0);
      expect(pressed.length, 'publishes over the 0.8 s after the press').toBeGreaterThan(5);
      expect(volts(pressed.at(-1)!.s, 'c1:1'), 'the capacitor charging').toBeGreaterThan(1);
      // digitalWrite(13, LOW): its LED goes dark, and the charge carries on.
      pin13 = 0;
      const n1 = t.log.length;
      await t.service.handleMcuEdge('uno', '13', false, 5, null);
      await sleep(400);
      const after = t.log.slice(n1);
      expect(after.length, 'publishes over the 0.4 s after the pad edge').toBeGreaterThan(0);
      expect(Math.abs(after.at(-1)!.s.branchCurrents['v_led13_sense']!)).toBeLessThan(1e-6);
      expect(volts(after.at(-1)!.s, 'c1:1')).toBeGreaterThan(volts(pressed.at(-1)!.s, 'c1:1'));
    },
  );
});

describe('a followed step goes out as often as it moves', () => {
  it(
    'a slow RC is published less and less often as its curve flattens, and every publish is on the curve',
    { timeout: 120_000 },
    async () => {
      // 5 V through the button and 100 kOhm into 100 uF, bled by 1 MOhm: a
      // 9.1 s charge, and a release that drains through the bleed for
      // 100 s, which the step runs out to its 600 s limit. Every publish
      // re-renders the meters, the overlay and the LEDs.
      const t = serviceOnStore();
      useSimulatorStore
        .getState()
        .loadProjectState(
          project(
            [
              part('ps', 'power-supply', { voltage: 5, currentLimit: 1 }),
              part('btn', 'pushbutton', { pressed: false }),
              part('r1', 'resistor', { value: '100k' }),
              part('r2', 'resistor', { value: '1M' }),
              part('c1', 'capacitor', { value: '100u' }),
            ],
            [
              wire('w1', ['ps', 'SIG'], ['btn', '1.l']),
              wire('w2', ['btn', '2.l'], ['r1', '1']),
              wire('w3', ['r1', '2'], ['c1', '1']),
              wire('w4', ['c1', '2'], ['ps', 'GND']),
              wire('w5', ['r2', '1'], ['c1', '1']),
              wire('w6', ['r2', '2'], ['ps', 'GND']),
            ],
          ),
        );
      await t.settle();
      await sleep(100);
      const vEnd = (5 * 1e6) / (100e3 + 1e6);
      const tauCharge = par(100e3, 1e6) * 100e-6;
      const charge = (s: number) => vEnd * (1 - Math.exp(-s / tauCharge));

      const n0 = t.log.length;
      setProps('btn', { pressed: true });
      await sleep(4000);
      const pressed = t.log.slice(n0);
      const onset = pressed[0]!.s.stepWaveforms!.oneShot!.wallMs;
      const n1 = t.log.length;
      setProps('btn', { pressed: false });
      await sleep(3000);
      const released = t.log.slice(n1);

      // At 33 ms a publish, as fast as the curve moves or not, this was 115
      // publishes pressed and 86 released.
      expect(pressed.length, 'publishes over the 4 s pressed').toBeLessThan(70);
      expect(released.length, 'publishes over the 3 s after the release').toBeLessThan(25);
      // Still followed: a moving curve goes out at least every 0.25 s.
      expect(pressed.length).toBeGreaterThan(12);
      expect(released.length).toBeGreaterThan(6);
      for (const p of pressed) {
        expect(
          Math.abs(volts(p.s, 'c1:1') - charge(momentOf(p))),
          `at ${sinceStep(p).toFixed(3)} s`,
        ).toBeLessThan(0.01 * vEnd);
      }
      const releaseOnset = released[0]!.s.stepWaveforms!.oneShot!.wallMs;
      const v0 = charge((releaseOnset - onset) / 1000);
      for (const p of released) {
        const expected = v0 * Math.exp(-momentOf(p) / (1e6 * 100e-6));
        expect(
          Math.abs(volts(p.s, 'c1:1') - expected),
          `at ${sinceStep(p).toFixed(3)} s`,
        ).toBeLessThan(0.01 * vEnd);
      }
      const gaps = released.slice(1).map((p, i) => p.at - released[i]!.at);
      expect(Math.max(...gaps), 'ms between two publishes of the release').toBeLessThan(600);
    },
  );
});

describe('what no hand starts is solved as before', () => {
  it(
    'an edit that is not a press is solved at its operating point at once',
    { timeout: 120_000 },
    async () => {
      const t = serviceOnStore();
      // A divider with a capacitor across its foot, and a pushbutton elsewhere
      // on the canvas: the canvas has both, but the edit is a resistor's.
      useSimulatorStore
        .getState()
        .loadProjectState(
          project(
            [
              part('ps', 'power-supply', { voltage: 5, currentLimit: 1 }),
              part('r1', 'resistor', { value: '10k' }),
              part('r2', 'resistor', { value: '100k' }),
              part('c1', 'capacitor', { value: '100u' }),
              part('btn', 'pushbutton', { pressed: false }),
              part('rl', 'resistor', { value: '330' }),
              part('led1', 'led', { color: 'red' }),
            ],
            [
              wire('w1', ['ps', 'SIG'], ['r1', '1']),
              wire('w2', ['r1', '2'], ['c1', '1']),
              wire('w3', ['c1', '2'], ['ps', 'GND']),
              wire('w4', ['r2', '1'], ['c1', '1']),
              wire('w5', ['r2', '2'], ['ps', 'GND']),
              wire('w6', ['ps', 'SIG'], ['btn', '1.l']),
              wire('w7', ['btn', '2.l'], ['rl', '1']),
              wire('w8', ['rl', '2'], ['led1', 'A']),
              wire('w9', ['led1', 'C'], ['ps', 'GND']),
            ],
          ),
        );
      await t.settle();
      await sleep(100);
      expect(volts(t.log.at(-1)!.s, 'c1:1')).toBeCloseTo((5 * 100) / 110, 3);
      const n0 = t.log.length;
      setProps('r2', { value: '10k' });
      await t.settle();
      await sleep(300);
      const after = t.log.slice(n0);
      // One publish, at the new operating point, with no step: as before.
      expect(after.length).toBe(1);
      expect(after[0]!.s.analysisMode).toBe('op');
      expect(after[0]!.s.stepWaveforms).toBeUndefined();
      expect(volts(after[0]!.s, 'c1:1')).toBeCloseTo(2.5, 3);
    },
  );

  it(
    'another circuit loaded while a step is followed: nothing of the old one is published after it',
    { timeout: 120_000 },
    async () => {
      const t = serviceOnStore();
      const rc = (c: string) =>
        project(
          [
            part('ps', 'power-supply', { voltage: 5, currentLimit: 1 }),
            part('btn', 'pushbutton', { pressed: false }),
            part('r1', 'resistor', { value: '10k' }),
            part(c, 'capacitor', { value: '100u' }),
          ],
          [
            wire('w1', ['ps', 'SIG'], ['btn', '1.l']),
            wire('w2', ['btn', '2.l'], ['r1', '1']),
            wire('w3', ['r1', '2'], [c, '1']),
            wire('w4', [c, '2'], ['ps', 'GND']),
          ],
        );
      useSimulatorStore.getState().loadProjectState(rc('c1'));
      await t.settle();
      setProps('btn', { pressed: true });
      await sleep(300);
      expect(t.service.debugState().following, 'the press is being followed').toBe(true);
      const n = t.log.length;
      useSimulatorStore.getState().loadProjectState(rc('c2'));
      await t.settle();
      await sleep(300);
      // The new circuit powers up as a circuit does: settled, nothing followed,
      // and nothing of the old one goes out after it.
      expect(t.service.debugState().following).toBe(false);
      const after = t.log.slice(n);
      const firstNew = after.findIndex((p) => p.s.pinNetMap.has('c2:1'));
      expect(firstNew).toBeGreaterThanOrEqual(0);
      for (const p of after.slice(firstNew)) {
        expect(p.s.pinNetMap.has('c1:1'), 'the old circuit published after the new one').toBe(
          false,
        );
        expect(p.s.stepWaveforms).toBeUndefined();
      }
      // At its operating point from its first publish on: the 1 GOhm of the
      // open contact against the pull-downs of the nets behind it.
      const pulled = (5 * 50e6) / (1e9 + 50e6);
      for (const p of after.slice(firstNew)) expect(volts(p.s, 'c2:1')).toBeCloseTo(pulled, 3);
    },
  );
});

describe('the parts that read their pins follow the step from where the circuit is', () => {
  /**
   * What a part on a path through an active device reads of a pin (a logic
   * input after a transistor, a relay's driver): the scheduler's voltage
   * events, each stamped with the time since `from` was last set, and the
   * logic edges a resolver with its threshold at 2.5 V makes of them.
   */
  function watchPin(componentId: string, pinName: string) {
    const sched = getMixedModeScheduler();
    let t0 = performance.now();
    const seen: Array<{ s: number; v: number }> = [];
    sched.subscribe(componentId, pinName, (_state, v) =>
      seen.push({ s: (performance.now() - t0) / 1000, v }),
    );
    const resolver = createSpiceResolvedPinResolver(componentId, pinName, sched, {
      thresholdHigh: 2.5,
      thresholdLow: 2.5,
      vcc: 5,
    });
    const edges: Array<{ s: number; state: string }> = [];
    resolver.onChange((state) => edges.push({ s: (performance.now() - t0) / 1000, state }));
    return {
      seen,
      edges,
      state: () => resolver.getCurrentState(),
      from: (at: number) => {
        t0 = at;
      },
    };
  }

  it(
    'no board: an input on the capacitor of an RC sees the charge from its start, never its end first',
    { timeout: 120_000 },
    async () => {
      // 5 V through the button and 10 kOhm into 100 uF, bled by 100 kOhm.
      const t = serviceOnStore();
      useSimulatorStore
        .getState()
        .loadProjectState(
          project(
            [
              part('ps', 'power-supply', { voltage: 5, currentLimit: 1 }),
              part('btn', 'pushbutton', { pressed: false }),
              part('r1', 'resistor', { value: '10k' }),
              part('r2', 'resistor', { value: '100k' }),
              part('c1', 'capacitor', { value: '100u' }),
            ],
            [
              wire('w1', ['ps', 'SIG'], ['btn', '1.l']),
              wire('w2', ['btn', '2.l'], ['r1', '1']),
              wire('w3', ['r1', '2'], ['c1', '1']),
              wire('w4', ['c1', '2'], ['ps', 'GND']),
              wire('w5', ['r2', '1'], ['c1', '1']),
              wire('w6', ['r2', '2'], ['ps', 'GND']),
            ],
          ),
        );
      await t.settle();
      await sleep(100);
      const pin = watchPin('c1', '1');
      expect(pin.state(), 'the capacitor starts empty').toBe('LOW');
      const vEnd = (5 * 100e3) / (10e3 + 100e3);
      const tau = par(10e3, 100e3) * 100e-6;
      const charge = (s: number) => vEnd * (1 - Math.exp(-s / tau));
      const crossS = -tau * Math.log(1 - 2.5 / vEnd);

      pin.from(performance.now());
      setProps('btn', { pressed: true });
      await sleep(2500);
      expect(pin.seen.length, 'voltage events while it charges').toBeGreaterThan(10);
      // Never ahead of the charge: each value is the curve at a moment no
      // later than when it arrived. The operating point the press settles to
      // (4.55 V) arriving first, then the curve, was a pulse.
      for (const e of pin.seen) {
        expect(e.v, `${e.v.toFixed(4)} V at ${e.s.toFixed(3)} s`).toBeLessThan(
          charge(e.s) + 0.01 * vEnd,
        );
      }
      // One logic edge, as the charge passes 2.5 V, not three.
      expect(pin.edges.map((e) => e.state)).toEqual(['HIGH']);
      expect(pin.edges[0]!.s).toBeGreaterThan(crossS);
      expect(pin.edges[0]!.s).toBeLessThan(crossS + 0.5);
    },
  );

  it(
    'with a board: an input on the capacitor sees the charge, and a pad edge on the way does not show it its end',
    { timeout: 120_000 },
    async () => {
      let pin13 = 5;
      const t = serviceOnStore(() => ({ '13': { type: 'digital', v: pin13 } }));
      useSimulatorStore.getState().loadProjectState(boardRc());
      await t.settle();
      await sleep(100);
      const pin = watchPin('c1', '1');
      expect(pin.state(), 'the capacitor starts empty').toBe('LOW');
      const bleed = par(100e3, METER_OHMS);
      const vEnd = (5 * bleed) / (10e3 + bleed);
      const tau = par(10e3, bleed) * 100e-6;
      const charge = (s: number) => vEnd * (1 - Math.exp(-s / tau));

      const pressedAt = performance.now();
      pin.from(pressedAt);
      setProps('btn', { pressed: true });
      await sleep(400);
      // digitalWrite(13, LOW) on the way: a new pad state, solved at its
      // operating point before its step carries the charge on.
      pin13 = 0;
      const edgeS = (performance.now() - pressedAt) / 1000;
      await t.service.handleMcuEdge('uno', '13', false, 5, null);
      await sleep(400);
      expect(
        pin.seen.filter((e) => e.s > edgeS).length,
        'voltage events after the pad edge',
      ).toBeGreaterThan(3);
      for (const e of pin.seen) {
        expect(e.v, `${e.v.toFixed(4)} V at ${e.s.toFixed(3)} s`).toBeLessThan(
          charge(e.s) + 0.01 * vEnd,
        );
      }
      // At most the one edge of the charge passing 2.5 V (0.73 s in).
      expect(pin.edges.filter((e) => e.state !== 'HIGH')).toEqual([]);
      expect(pin.edges.length).toBeLessThanOrEqual(1);
    },
  );
});
