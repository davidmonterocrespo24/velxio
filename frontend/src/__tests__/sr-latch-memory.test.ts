/**
 * An SR latch remembers (velxio/velxio-prod#147).
 *
 * Analog engine. A NAND latch (each gate's output on the other's input) has
 * two stable states and keeps the one it is in when both inputs return high;
 * it powers up in one of them. The symmetric point with both outputs at
 * mid-rail is an unstable equilibrium a real latch leaves in nanoseconds, but
 * an operating point with no history lands on it, and Velxio re-solved from
 * scratch after every button change: the gallery's nand-sr-latch ("Memory
 * without a clock!") read 2.500 V / 2.500 V after SET or RESET was released,
 * with its LED half lit. Gates on a feedback loop now drive their pins
 * through 25 ohm and the deck seeds the loop with .nodeset: with where it was
 * at the last solve, or a definite power-up state (the first gate low).
 *
 * Digital engine. The slide switch only drove its common with the selected
 * throw's level, so the textbook debouncer (common to GND, throws on the
 * pulled-up S-bar and R-bar) put two strong drivers against each other on
 * the ground net and the latch never set. The switch is now a two-way
 * connection.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { exampleToBuildNetlistInput } from '../utils/exampleToBuildNetlistInput';
import { circuitExamples } from '../data/examples-circuits';
import { runNetlist } from './helpers/testSolver';
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
import { buildDigitalNetwork } from '../simulation/digital/digitalGateEngine';
import { resetBusNets } from '../simulation/customChips/busNets';
import { PinManager } from '../simulation/PinManager';
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

const latchExample = () => {
  const ex = circuitExamples.find((e) => e.id === 'nand-sr-latch');
  if (!ex) throw new Error('nand-sr-latch is gone from the gallery');
  return exampleToBuildNetlistInput(ex, {
    boards: [{ id: 'arduino-uno', boardKind: 'arduino-uno', pinStates: {} }],
    analysis: { kind: 'op' },
  });
};

describe('the analog NAND latch powers up in a state (velxio/velxio-prod#147)', () => {
  it('the gallery latch solves to Q = 0, Q-bar = 5 V, not 2.5 V / 2.5 V', { timeout: 60_000 }, async () => {
    const input = latchExample();
    const { netlist, pinNetMap, nodeMemoryCells } = buildNetlist(input);
    expect(netlist).toMatch(/^\.nodeset V\(\S+\)=0 V\(\S+\)=5$/m);
    expect(nodeMemoryCells.map((c) => c.key)).toEqual(['g1:Y', 'g2:Y']);
    const r = await runNetlist(netlist);
    expect(r.dcValue(`v(${pinNetMap.get('g1:Y')})`)).toBeLessThan(0.1);
    expect(r.dcValue(`v(${pinNetMap.get('g2:Y')})`)).toBeGreaterThan(4.9);
  });

  it('a gate on no loop is emitted exactly as before', () => {
    const { netlist } = buildNetlist({
      components: [{ id: 'g', metadataId: 'logic-gate-and', properties: {} }],
      wires: [
        w('w1', ['uno', '5V'], ['g', 'A']),
        w('w2', ['uno', '5V'], ['g', 'B']),
        w('w3', ['g', 'Y'], ['uno', 'D4']),
      ],
      boards: [{ id: 'uno', vcc: 5, pins: {}, groundPinNames: ['GND'], vccPinNames: ['5V'] }],
      analysis: { kind: 'op' },
    });
    expect(netlist).not.toMatch(/\.nodeset/);
    expect(netlist).not.toMatch(/R_g_ro\b/);
    expect(netlist).toMatch(/^B_g \S+ 0 V = /m);
    expect(netlist).not.toMatch(/g_yi/);
  });
});

/** The real service over the gallery latch, with its buttons. */
function latchService(pins: () => Record<string, PinSourceState> = () => ({})) {
  __setSchedulerSolverFactoryForTests(() => new NgSpiceNodeAdapter());
  const ex = circuitExamples.find((e) => e.id === 'nand-sr-latch')!;
  const input = latchExample();
  let state = {
    components: input.components as Comp[],
    wires: input.wires,
    boards: [{ id: 'arduino-uno', boardKind: 'arduino-uno', running: true }],
  };
  expect(ex.components.length).toBeGreaterThan(0);
  const published: ElectricalSnapshot[] = [];
  const simStore: SimulatorStorePort = { getState: () => state, subscribe: () => () => {} };
  const service = new CircuitSimulationService(
    simStore,
    { publish: (s) => published.push(s) },
    getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
    { collectBoardPinStates: () => pins() },
  );
  services.push(service);
  const q = (): number => {
    const s = published[published.length - 1];
    const net = s?.pinNetMap.get('g1:Y');
    return s && net ? (s.nodeVoltages[net] ?? NaN) : NaN;
  };
  const press = async (id: string, pressed: boolean) => {
    state = {
      ...state,
      components: state.components.map((c) => (c.id === id ? { ...c, properties: { ...c.properties, pressed } } : c)),
    };
    await service.tick();
  };
  return { service, q, press };
}

describe('the analog NAND latch keeps its state (velxio/velxio-prod#147)', () => {
  it('SET then release holds Q high; RESET then release holds it low', { timeout: 60_000 }, async () => {
    const t = latchService();
    await t.service.tick();
    expect(t.q()).toBeLessThan(0.1);

    await t.press('setBtn', true);
    expect(t.q()).toBeGreaterThan(4.5);
    await t.press('setBtn', false);
    expect(t.q(), 'forgot SET when the button was released').toBeGreaterThan(4.5);

    await t.press('rstBtn', true);
    expect(t.q()).toBeLessThan(0.5);
    await t.press('rstBtn', false);
    expect(t.q(), 'forgot RESET when the button was released').toBeLessThan(0.5);
  });

  it('a latch driven from board pins keeps the state a pin pulse left', { timeout: 60_000 }, async () => {
    __setSchedulerSolverFactoryForTests(() => new NgSpiceNodeAdapter());
    let sBar = 5;
    const pins = (): Record<string, PinSourceState> => ({
      '2': { type: 'digital', v: sBar },
      '3': { type: 'digital', v: 5 },
    });
    // A diode and a resistor on Q make it a circuit for ngspice (gates and
    // board pins alone go to the digital engine).
    const components: Comp[] = [
      { id: 'g1', metadataId: 'logic-gate-nand', properties: {} },
      { id: 'g2', metadataId: 'logic-gate-nand', properties: {} },
      { id: 'd1', metadataId: 'diode-1n4148', properties: {} },
      { id: 'rq', metadataId: 'resistor', properties: { value: '10000' } },
    ];
    const wires = [
      w('w1', ['arduino-uno', '2'], ['g1', 'A']),
      w('w2', ['arduino-uno', '3'], ['g2', 'A']),
      w('w3', ['g1', 'Y'], ['g2', 'B']),
      w('w4', ['g2', 'Y'], ['g1', 'B']),
      w('w5', ['g1', 'Y'], ['d1', 'A']),
      w('w6', ['d1', 'C'], ['rq', '1']),
      w('w7', ['rq', '2'], ['arduino-uno', 'GND']),
    ];
    const published: ElectricalSnapshot[] = [];
    const service = new CircuitSimulationService(
      {
        getState: () => ({ components, wires, boards: [{ id: 'arduino-uno', boardKind: 'arduino-uno', running: true }] }),
        subscribe: () => () => {},
      },
      { publish: (s) => published.push(s) },
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => pins() },
    );
    services.push(service);
    const q = () => {
      const s = published[published.length - 1]!;
      return s.nodeVoltages[s.pinNetMap.get('g1:Y')!] ?? NaN;
    };
    await service.tick();
    expect(q()).toBeLessThan(0.1);

    sBar = 0;
    await service.handleMcuEdge('arduino-uno', '2', false, 5, null);
    await vi.waitFor(() => expect(q()).toBeGreaterThan(4.5), { timeout: 5000, interval: 20 });
    sBar = 5;
    await service.handleMcuEdge('arduino-uno', '2', true, 5, null);
    await new Promise((r) => setTimeout(r, 600));
    expect(q(), 'forgot SET when the pin went back HIGH').toBeGreaterThan(4.5);
  });

  it('pin pulses SET and then RESET in quick succession: the RESET shows at once', { timeout: 60_000 }, async () => {
    // Each flip rebuilds the deck with the latch where the flip left it. The
    // rebuild for RESET used to wait until 250 ms after the one for SET, and
    // the solves in between came from the deck seeded with SET: once RESET was
    // released Q read high again until that rebuild ran.
    __setSchedulerSolverFactoryForTests(() => new NgSpiceNodeAdapter());
    let sBar = 5;
    let rBar = 5;
    const pins = (): Record<string, PinSourceState> => ({
      '2': { type: 'digital', v: sBar },
      '3': { type: 'digital', v: rBar },
    });
    const components: Comp[] = [
      { id: 'g1', metadataId: 'logic-gate-nand', properties: {} },
      { id: 'g2', metadataId: 'logic-gate-nand', properties: {} },
      { id: 'd1', metadataId: 'diode-1n4148', properties: {} },
      { id: 'rq', metadataId: 'resistor', properties: { value: '10000' } },
    ];
    const wires = [
      w('w1', ['arduino-uno', '2'], ['g1', 'A']),
      w('w2', ['arduino-uno', '3'], ['g2', 'A']),
      w('w3', ['g1', 'Y'], ['g2', 'B']),
      w('w4', ['g2', 'Y'], ['g1', 'B']),
      w('w5', ['g1', 'Y'], ['d1', 'A']),
      w('w6', ['d1', 'C'], ['rq', '1']),
      w('w7', ['rq', '2'], ['arduino-uno', 'GND']),
    ];
    const published: ElectricalSnapshot[] = [];
    const service = new CircuitSimulationService(
      {
        getState: () => ({ components, wires, boards: [{ id: 'arduino-uno', boardKind: 'arduino-uno', running: true }] }),
        subscribe: () => () => {},
      },
      { publish: (s) => published.push(s) },
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => pins() },
    );
    services.push(service);
    const qOf = (s: ElectricalSnapshot) => s.nodeVoltages[s.pinNetMap.get('g1:Y')!] ?? NaN;
    const q = () => qOf(published[published.length - 1]!);
    await service.tick();
    expect(q()).toBeLessThan(0.1);

    sBar = 0;
    await service.handleMcuEdge('arduino-uno', '2', false, 5, null);
    await vi.waitFor(() => expect(q()).toBeGreaterThan(4.5), { timeout: 5000, interval: 2 });
    sBar = 5;
    await service.handleMcuEdge('arduino-uno', '2', true, 5, null);
    rBar = 0;
    await service.handleMcuEdge('arduino-uno', '3', false, 5, null);
    await vi.waitFor(() => expect(q()).toBeLessThan(0.5), { timeout: 5000, interval: 2 });
    const from = published.length;
    rBar = 5;
    await service.handleMcuEdge('arduino-uno', '3', true, 5, null);
    await new Promise((r) => setTimeout(r, 100));
    const after = published.slice(from).map(qOf);
    expect(after.length, 'nothing was published after RESET was released').toBeGreaterThan(0);
    expect(after.filter((v) => v > 2.5), 'published the SET state again after RESET was released').toEqual([]);
    await new Promise((r) => setTimeout(r, 400));
    expect(q(), 'the latch ended in the SET state').toBeLessThan(0.5);
  });
});

describe('the digital engine\'s slide switch is a two-way contact (velxio/velxio-prod#147)', () => {
  it('the debouncer (common to GND, throws on pulled-up S-bar / R-bar) sets and resets the latch', () => {
    resetBusNets();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const comps = [
      { id: 'src', metadataId: 'signal-generator', properties: { waveform: 'dc', offset: 5 } },
      { id: 'rS', metadataId: 'resistor', properties: { value: '10000' } },
      { id: 'rR', metadataId: 'resistor', properties: { value: '10000' } },
      { id: 'sw', metadataId: 'slide-switch', properties: { value: 0 } },
      { id: 'g1', metadataId: 'logic-gate-nand', properties: {} },
      { id: 'g2', metadataId: 'logic-gate-nand', properties: {} },
    ];
    const W = (a: [string, string], b: [string, string]) => ({
      start: { componentId: a[0], pinName: a[1] },
      end: { componentId: b[0], pinName: b[1] },
    });
    const wires = [
      W(['src', 'SIG'], ['rS', '1']),
      W(['rS', '2'], ['g1', 'A']),
      W(['src', 'SIG'], ['rR', '1']),
      W(['rR', '2'], ['g2', 'A']),
      W(['g1', 'Y'], ['g2', 'B']),
      W(['g2', 'Y'], ['g1', 'B']),
      W(['sw', '2'], ['src', 'GND']),
      W(['sw', '1'], ['g1', 'A']),
      W(['sw', '3'], ['g2', 'A']),
    ];
    try {
      const net = buildDigitalNetwork(comps, wires, new PinManager());
      expect(net.ok).toBe(true);
      const rd = (c: string, p: string) => net.readNet(net.netOf(c, p)!);
      // value 0: the common pulls S-bar low -> Q = 1.
      expect([rd('g1', 'A'), rd('g2', 'A'), rd('g1', 'Y'), rd('g2', 'Y')]).toEqual([0, 1, 1, 0]);
      net.setSwitch('sw', 1);
      expect([rd('g1', 'A'), rd('g2', 'A'), rd('g1', 'Y'), rd('g2', 'Y')]).toEqual([1, 0, 0, 1]);
      net.setSwitch('sw', 0);
      expect([rd('g1', 'A'), rd('g2', 'A'), rd('g1', 'Y'), rd('g2', 'Y')]).toEqual([0, 1, 1, 0]);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('contention'))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
