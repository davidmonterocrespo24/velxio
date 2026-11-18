// @vitest-environment jsdom
/**
 * Another circuit powers up anew (velxio/velxio-prod#109, #147).
 *
 * The circuit service carries a relay's armature and an SR latch's state from
 * one solve to the next, by component id, so a sealed-in relay holds and a
 * latch keeps what SET or RESET left. The service lives as long as the
 * editor, and nothing cleared that memory when another circuit was loaded:
 * gallery examples have fixed ids, so reopening nand-sr-latch after SET
 * showed Q high (4.721 V) instead of its power-up Q = 0, and reloading a
 * project whose relay had sealed in brought it back pulled in (4.995 V on the
 * coil) with nobody pressing START.
 *
 * Every bulk replacement of the canvas (a project, an example, an import, the
 * starter picker emptying it) bumps the store's hydrationSeq; the service now
 * starts the memory from scratch at the first rebuild that sees a new value.
 * An ordinary edit keeps it. Runs the real stores, the real service on them
 * and ngspice (the Node adapter).
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
import { useSimulatorStore } from '../store/useSimulatorStore';
import { loadExample } from '../utils/loadExample';
import { clearWorkspaceForStarter } from '../components/editor/NewProjectDialog';
import { exampleProjects } from '../data/examples';

type LoadPayload = Parameters<ReturnType<typeof useSimulatorStore.getState>['loadProjectState']>[0];

const running: Array<{ service: CircuitSimulationService; unsubscribe: () => void }> = [];
afterEach(() => {
  for (const r of running.splice(0)) {
    r.unsubscribe();
    r.service.stop();
  }
  __resetMixedModeScheduler();
});

/** The service on the app's own simulator store, subscribed to it as the
 *  editor mounts it, publishing into a list. `whileLoading`, when set, runs
 *  once while the solver loads the next deck: something the user does while
 *  a solve is under way. */
function serviceOnStore() {
  __setSchedulerSolverFactoryForTests(() => new NgSpiceNodeAdapter());
  const published: ElectricalSnapshot[] = [];
  const scheduler = getMixedModeScheduler() as unknown as MixedModeSchedulerPort;
  const hooks: { whileLoading: (() => void) | null } = { whileLoading: null };
  const port = new Proxy(scheduler, {
    get(target, prop) {
      if (prop === 'loadCircuit') {
        return async (netlist: string, pinNetMap: Map<string, string>) => {
          const during = hooks.whileLoading;
          hooks.whileLoading = null;
          await target.loadCircuit(netlist, pinNetMap);
          during?.();
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  const service = new CircuitSimulationService(
    useSimulatorStore as unknown as SimulatorStorePort,
    { publish: (s) => published.push(s) },
    port,
    { collectBoardPinStates: () => ({}) },
  );
  const unsubscribe = service.start();
  running.push({ service, unsubscribe });
  /** Wait until every rebuild the store asked for has been solved and
   *  published. */
  const settle = async (): Promise<void> => {
    const before = published.length;
    await vi.waitFor(
      () => {
        const d = service.debugState();
        expect(d.tickQueued || d.busy, 'the service is still solving').toBe(false);
        expect(published.length, 'nothing was published').toBeGreaterThan(before);
      },
      { timeout: 20_000, interval: 10 },
    );
  };
  const volts = (pin: string): number => {
    const s = published[published.length - 1];
    const net = s?.pinNetMap.get(pin);
    if (!s || !net) return NaN;
    return net === '0' ? 0 : (s.nodeVoltages[net] ?? NaN);
  };
  return { service, published, settle, volts, hooks };
}

/** Write a part's properties the way a button press or the inspector does. */
function setProps(id: string, props: Record<string, unknown>): void {
  const sim = useSimulatorStore.getState();
  const comp = sim.components.find((c) => c.id === id);
  if (!comp) throw new Error(`no part ${id} on the canvas`);
  sim.updateComponent(id, { properties: { ...comp.properties, ...props } } as never);
}

/**
 * A seal-in, board-less: a 5 V bench supply through STOP (a slide switch) to
 * a bus; START (a pushbutton) from the bus to COIL+; COM on the bus and NO on
 * COIL+, in parallel with START. Ids as a saved project keeps them.
 */
function sealInProject(): LoadPayload {
  const part = (id: string, metadataId: string, properties: Record<string, unknown>) => ({
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
  return {
    boards: [],
    fileGroups: {},
    folderGroups: {},
    activeBoardId: null,
    components: [
      part('ps', 'power-supply', { voltage: 5, currentLimit: 1 }),
      part('stop', 'slide-switch', { value: 0 }),
      part('start', 'pushbutton', { pressed: false }),
      part('k1', 'relay', { coil_voltage: 5 }),
    ],
    wires: [
      wire('w1', ['ps', 'SIG'], ['stop', '2']),
      wire('w2', ['stop', '1'], ['start', '1.l']),
      wire('w3', ['start', '2.l'], ['k1', 'COIL+']),
      wire('w4', ['k1', 'COIL-'], ['ps', 'GND']),
      wire('w5', ['stop', '1'], ['k1', 'COM']),
      wire('w6', ['k1', 'NO'], ['k1', 'COIL+']),
    ],
  } as unknown as LoadPayload;
}

/** Load the seal-in, press and release START: the relay holds itself in. */
async function sealedIn(t: ReturnType<typeof serviceOnStore>): Promise<() => number> {
  const coil = () => t.volts('k1:COIL+') - t.volts('k1:COIL-');
  useSimulatorStore.getState().loadProjectState(sealInProject());
  await t.settle();
  expect(coil(), 'the relay powers up released').toBeLessThan(0.1);
  setProps('start', { pressed: true });
  await t.settle();
  expect(coil()).toBeGreaterThan(4.9);
  setProps('start', { pressed: false });
  await t.settle();
  expect(coil(), 'the seal-in holds once START is released').toBeGreaterThan(4.9);
  return coil;
}

describe('a reloaded circuit starts from its power-up state (velxio/velxio-prod#109, #147)', () => {
  it('reopening the gallery SR latch after SET shows Q low again', { timeout: 120_000 }, async () => {
    const t = serviceOnStore();
    const example = exampleProjects.find((e) => e.id === 'nand-sr-latch');
    if (!example) throw new Error('nand-sr-latch is gone from the gallery');
    const q = () => t.volts('g1:Y');

    await loadExample(example);
    await t.settle();
    expect(q(), 'the latch powers up with Q low').toBeLessThan(0.1);
    setProps('setBtn', { pressed: true });
    await t.settle();
    setProps('setBtn', { pressed: false });
    await t.settle();
    expect(q(), 'the latch keeps SET').toBeGreaterThan(4.5);

    await loadExample(example);
    await t.settle();
    expect(q(), 'reopening the example brought its SET state back').toBeLessThan(0.1);
  });

  it('reloading a project (loadProjectState) drops a sealed-in relay', { timeout: 120_000 }, async () => {
    const t = serviceOnStore();
    const coil = await sealedIn(t);

    useSimulatorStore.getState().loadProjectState(sealInProject());
    await t.settle();
    expect(coil(), 'the reloaded relay came back pulled in').toBeLessThan(0.1);
  });

  it('a reload that lands while the old circuit is being solved still powers up', { timeout: 120_000 }, async () => {
    // The solve under way finishes after the load, with the relay in: what it
    // leaves must not seed the reloaded circuit.
    const t = serviceOnStore();
    const coil = await sealedIn(t);

    t.hooks.whileLoading = () => useSimulatorStore.getState().loadProjectState(sealInProject());
    setProps('ps', { currentLimit: 2 });
    await t.settle();
    expect(t.hooks.whileLoading, 'the reload did not run during a solve').toBeNull();
    expect(coil(), 'the solve that ended after the reload brought the relay back in').toBeLessThan(0.1);
  });

  it('a new project from the starter picker forgets it too, whatever goes on the canvas next', { timeout: 120_000 }, async () => {
    // The starter picker empties the canvas. The same parts put back at once
    // by the raw mutators (no load of their own) power up released, whether
    // or not the empty canvas got a solve of its own in between.
    const t = serviceOnStore();
    const coil = await sealedIn(t);

    const { components, wires } = useSimulatorStore.getState();
    clearWorkspaceForStarter();
    const sim = useSimulatorStore.getState();
    for (const c of components) sim.addComponent(c);
    for (const w of wires) sim.addWire(w);
    await t.settle();
    expect(coil(), 'the relay came back pulled in after the starter change').toBeLessThan(0.1);
  });

  it('an ordinary edit keeps the memory', { timeout: 120_000 }, async () => {
    const t = serviceOnStore();
    const coil = await sealedIn(t);

    setProps('ps', { currentLimit: 2 });
    await t.settle();
    expect(coil(), 'editing the supply dropped the seal-in').toBeGreaterThan(4.9);
  });
});
