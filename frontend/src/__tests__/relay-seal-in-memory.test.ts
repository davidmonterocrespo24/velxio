/**
 * A relay fed through its own contact stays in (velxio/velxio-prod#109).
 *
 * A seal-in (a motor starter's hold contact): START energises the coil, the
 * relay's NO contact closes in parallel with START, and the coil keeps itself
 * powered after START is released, until STOP breaks the circuit. The circuit
 * has two consistent operating points, coil on with the contact closed and
 * coil off with it open, and a real one stays in whichever it is in.
 *
 * Velxio rebuilt the deck on every button change and every S card started
 * released (ngspice's OFF by default inside the hysteresis band), so the
 * operating point after the release was always the open one: the relay
 * dropped out the moment START was let go. The circuit service now carries
 * each armature's state from the solve it published into the next deck
 * (ON/OFF on the S cards), and a pin edge that pulls a relay in on a board
 * circuit rebuilds the deck with it in.
 *
 * Runs the real service, scheduler and ngspice (the Node adapter).
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
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import type { BuildNetlistInput, PinSourceState } from '../simulation/spice/types';

type Comp = { id: string; metadataId: string; properties: Record<string, unknown> };
type Wire = BuildNetlistInput['wires'][number];
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

/** The real service over a canvas the test edits, and the coil voltage of the
 *  last snapshot it published. */
function serviceOver(
  initial: { components: Comp[]; wires: Wire[]; boards: Array<{ id: string; boardKind: string; running?: boolean }> },
  pins: () => Record<string, PinSourceState> = () => ({}),
) {
  __setSchedulerSolverFactoryForTests(() => new NgSpiceNodeAdapter());
  let state = initial;
  const published: ElectricalSnapshot[] = [];
  const simStore: SimulatorStorePort = { getState: () => state, subscribe: () => () => {} };
  const service = new CircuitSimulationService(
    simStore,
    { publish: (s) => published.push(s) },
    getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
    { collectBoardPinStates: () => pins() },
  );
  services.push(service);
  const coil = (): number => {
    const s = published[published.length - 1];
    if (!s) return NaN;
    const net = s.pinNetMap.get('k1:COIL+');
    return net ? (s.nodeVoltages[net] ?? NaN) - (s.nodeVoltages[s.pinNetMap.get('k1:COIL-') ?? '0'] ?? 0) : NaN;
  };
  /** Change one part's properties, as the inspector or a button press does,
   *  and let the service rebuild. */
  const setProps = async (id: string, props: Record<string, unknown>) => {
    state = {
      ...state,
      components: state.components.map((c) => (c.id === id ? { ...c, properties: { ...c.properties, ...props } } : c)),
    };
    await service.tick();
  };
  return { service, published, coil, setProps };
}

/**
 * Board-less seal-in: a 5 V bench supply through STOP (a slide switch, common
 * on pin 2, run on pin 1, stop on pin 3) to a bus; START (a pushbutton) from
 * the bus to COIL+; COM on the bus and NO on COIL+, in parallel with START.
 */
function sealIn(): { components: Comp[]; wires: Wire[]; boards: [] } {
  return {
    components: [
      { id: 'ps', metadataId: 'power-supply', properties: { voltage: 5, currentLimit: 1 } },
      { id: 'stop', metadataId: 'slide-switch', properties: { value: 0 } },
      { id: 'start', metadataId: 'pushbutton', properties: { pressed: false } },
      { id: 'k1', metadataId: 'relay', properties: { coil_voltage: 5 } },
    ],
    wires: [
      w('w1', ['ps', 'SIG'], ['stop', '2']),
      w('w2', ['stop', '1'], ['start', '1.l']),
      w('w3', ['start', '2.l'], ['k1', 'COIL+']),
      w('w4', ['k1', 'COIL-'], ['ps', 'GND']),
      w('w5', ['stop', '1'], ['k1', 'COM']),
      w('w6', ['k1', 'NO'], ['k1', 'COIL+']),
    ],
    boards: [],
  };
}

describe('a sealed-in relay holds after START is released (velxio/velxio-prod#109)', () => {
  it('START pulls it in, it holds on its own contact, STOP drops it for good', { timeout: 60_000 }, async () => {
    const t = serviceOver(sealIn());
    await t.service.tick();
    expect(t.coil()).toBeLessThan(0.1);

    await t.setProps('start', { pressed: true });
    expect(t.coil()).toBeGreaterThan(4.9);

    await t.setProps('start', { pressed: false });
    expect(t.coil(), 'dropped out when START was released').toBeGreaterThan(4.9);

    await t.setProps('stop', { value: 1 });
    expect(t.coil()).toBeLessThan(0.1);

    await t.setProps('stop', { value: 0 });
    expect(t.coil(), 'a released seal-in must not come back on its own').toBeLessThan(0.1);
  });

  it('without the hold contact the relay drops out when START is released', { timeout: 60_000 }, async () => {
    const c = sealIn();
    c.wires = c.wires.filter((x) => x.id !== 'w6');
    const t = serviceOver(c);
    await t.service.tick();
    await t.setProps('start', { pressed: true });
    expect(t.coil()).toBeGreaterThan(4.9);
    await t.setProps('start', { pressed: false });
    expect(t.coil()).toBeLessThan(0.1);
  });
});

describe('a pin that pulls a sealed relay in leaves it in (velxio/velxio-prod#109)', () => {
  it('pin 9 HIGH through a diode pulls it in; pin 9 LOW and it holds', { timeout: 60_000 }, async () => {
    let level = 0;
    const t = serviceOver(
      {
        components: [
          { id: 'd1', metadataId: 'diode-1n4148', properties: {} },
          // A sensitive 5 V coil (1 kΩ, 5 mA): since #140 an ATmega pin drives
          // the circuit through its output impedance, and the default 70 Ω coil
          // would ask it for about 60 mA, past its 40 mA absolute maximum, and
          // never reach the pull-in voltage, as with a real pin.
          { id: 'k1', metadataId: 'relay', properties: { coil_voltage: 5, coil_resistance: 1000 } },
        ],
        wires: [
          w('w1', ['arduino-uno', '9'], ['d1', 'A']),
          w('w2', ['d1', 'C'], ['k1', 'COIL+']),
          w('w3', ['k1', 'COIL-'], ['arduino-uno', 'GND']),
          w('w4', ['arduino-uno', '5V'], ['k1', 'COM']),
          w('w5', ['k1', 'NO'], ['k1', 'COIL+']),
        ],
        boards: [{ id: 'arduino-uno', boardKind: 'arduino-uno', running: true }],
      },
      () => ({ '9': { type: 'digital', v: level } }),
    );
    await t.service.tick();
    expect(t.coil()).toBeLessThan(0.1);

    level = 5;
    await t.service.handleMcuEdge('arduino-uno', '9', true, 5, null);
    await vi.waitFor(() => expect(t.coil()).toBeGreaterThan(4.9), { timeout: 5000, interval: 20 });

    level = 0;
    await t.service.handleMcuEdge('arduino-uno', '9', false, 5, null);
    // Let the window close and anything it asked for run.
    await new Promise((r) => setTimeout(r, 600));
    expect(t.coil(), 'dropped out when the pin went LOW').toBeGreaterThan(4.9);
  });
});

describe('the deck carries the state (velxio/velxio-prod#109)', () => {
  const input = (operated?: boolean): BuildNetlistInput => ({
    ...sealIn(),
    analysis: { kind: 'op' },
    ...(operated === undefined ? {} : { memory: { switches: new Map([['k1', operated]]) } }),
  });

  it('starts the contacts released, and operated when the memory says so', () => {
    const fresh = buildNetlist(input());
    expect(fresh.netlist).toMatch(/^S_k1_no .* RELAY_NO_5$/m);
    expect(fresh.memoryCells).toEqual([{ id: 'k1', control: 'k1_coilv', on: 3.75, off: 2.25, seed: false }]);
    const held = buildNetlist(input(true));
    expect(held.netlist).toMatch(/^S_k1_no .* RELAY_NO_5 ON$/m);
    expect(held.memoryCells[0]!.seed).toBe(true);
    expect(buildNetlist(input(false)).netlist).toMatch(/^S_k1_no .* RELAY_NO_5$/m);
  });
});
