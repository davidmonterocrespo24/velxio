/**
 * Transistors are held to their datasheet ratings (velxio/velxio-prod#138).
 *
 * The circuit check had rules for sources, LEDs, resistors, rated supply
 * pins and electrolytics, and none for transistors: a 2N2222 (40 V) whose
 * coil was switched off with no flyback diode reached 1141 V, and nothing
 * said so. Each transistor now has V_CEO / V_DSS, I_C / I_D and P_D in its
 * metadata, and its collector (drain) and base carry 0 V sense sources, so
 * the solve gives what it carries too.
 *
 *   - Before Run (circuitVerifier, Rule 7): the operating point, and the
 *     window of a source that moves by itself (a generator into the coil).
 *   - While it runs (runtimeBurnout): what the live solve publishes, the step
 *     after a pin's edge included, which is where a board's coil kicks.
 *
 * Real ngspice (Node adapter) throughout; the runtime cases run the real
 * circuit service and scheduler into the real stores and monitor.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import metadataJson from '../../public/components-metadata.json' with { type: 'json' };
import { verifyCircuit, type CircuitWarning } from '../simulation/verify/circuitVerifier';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { buildPreflightSnapshot } from '../simulation/verify/verifyFromStore';
import {
  CircuitSimulationService,
  type MixedModeSchedulerPort,
  type SimulatorStorePort,
} from '../simulation/spice/CircuitSimulationService';
import {
  getMixedModeScheduler,
  __resetMixedModeScheduler,
  __setSchedulerSolverFactoryForTests,
} from '../simulation/spice/MixedModeScheduler';
import { NgSpiceNodeAdapter } from '../simulation/spice/adapters/NgSpiceNodeAdapter';
import { useElectricalStore } from '../store/useElectricalStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { ComponentRegistry } from '../services/ComponentRegistry';
import '../simulation/parts/runtimeBurnout';
import type { PinSourceState } from '../simulation/spice/types';
import type { ComponentMetadata } from '../types/component-metadata';

type Part = { id: string; metadataId: string; properties: Record<string, unknown> };
type Wire = { id: string; start: { componentId: string; pinName: string }; end: { componentId: string; pinName: string } };
const w = (id: string, a: [string, string], b: [string, string]): Wire => ({
  id,
  start: { componentId: a[0], pinName: a[1] },
  end: { componentId: b[0], pinName: b[1] },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const catalogue = (metadataJson as unknown as { components: ComponentMetadata[] }).components;
const byId = new Map(catalogue.map((c) => [c.id, c] as const));
const ratingsOf = (metadataId: string) => {
  const m = byId.get(metadataId);
  return m?.ratings ? { ratings: m.ratings, name: m.name } : undefined;
};

const transistorWarnings = (ws: CircuitWarning[]) => ws.filter((x) => x.code.startsWith('transistor-'));

async function preflight(components: Part[], wires: Wire[], boards: Array<{ id: string; boardKind: string }> = []) {
  const { snap, synthesizedPins } = buildPreflightSnapshot({ components, wires, boards });
  const result = await verifyCircuit(buildInputFromStore(snap as never), { synthesizedPins, ratingsOf } as never);
  return { all: [...result.errors, ...result.warnings], transistor: transistorWarnings([...result.errors, ...result.warnings]) };
}

/** A 5 V square wave into a 2N2222's base through 1 kOhm; the relay's coil
 *  (70 ohm / 20 mH) from a 5 V supply to its collector, its contact lighting a
 *  1 kOhm load: chapter 13's circuit, with or without the relay's diode. */
function relayDriver(flyback: boolean): { components: Part[]; wires: Wire[] } {
  return {
    components: [
      { id: 'gen', metadataId: 'signal-generator', properties: { waveform: 'square', frequency: '10', amplitude: '2.5', offset: '2.5' } },
      { id: 'ps', metadataId: 'power-supply', properties: { voltage: '5' } },
      { id: 'rb', metadataId: 'resistor', properties: { value: '1000' } },
      { id: 'q1', metadataId: 'bjt-2n2222', properties: {} },
      { id: 'k1', metadataId: 'relay', properties: { include_flyback: flyback } },
      { id: 'rl', metadataId: 'resistor', properties: { value: '1000' } },
    ],
    wires: [
      w('w1', ['gen', 'SIG'], ['rb', '1']),
      w('w2', ['rb', '2'], ['q1', 'B']),
      w('w3', ['q1', 'E'], ['gen', 'GND']),
      w('w4', ['ps', '+'], ['k1', 'COIL+']),
      w('w5', ['k1', 'COIL-'], ['q1', 'C']),
      w('w6', ['ps', '-'], ['gen', 'GND']),
      w('w7', ['ps', '+'], ['k1', 'COM']),
      w('w8', ['k1', 'NO'], ['rl', '1']),
      w('w9', ['rl', '2'], ['gen', 'GND']),
    ],
  };
}

describe('the circuit check holds transistors to their ratings (velxio/velxio-prod#138)', () => {
  it('a generator switching a coil with no diode: the collector breaks down past 40 V', { timeout: 120_000 }, async () => {
    const { components, wires } = relayDriver(false);
    const { transistor } = await preflight(components, wires);
    expect(transistor.map((x) => x.code)).toEqual(['transistor-overvoltage']);
    const v = transistor[0]!;
    expect(v.componentId).toBe('q1');
    expect(v.severity).toBe('warning');
    expect(v.metric!).toBeGreaterThan(40);
    expect(v.metric!).toBeLessThan(42);
    expect(v.message).toMatch(/q1 \(2N2222\) reaches 40\.\d+ V between its collector and emitter, above its 40 V rating \(V_CEO\)/);
    expect(v.message).toMatch(/flyback diode/);
  });

  it('the same coil with its diode: nothing to say', { timeout: 120_000 }, async () => {
    const { components, wires } = relayDriver(true);
    expect((await preflight(components, wires)).transistor).toEqual([]);
  });

  it('a 2N2222 asked for 2 A: over its 600 mA, and over its 625 mW', { timeout: 120_000 }, async () => {
    // Base from 5 V through 100 ohm (43 mA), a 2 ohm load from 5 V.
    const { transistor } = await preflight(
      [
        { id: 'ps', metadataId: 'power-supply', properties: { voltage: '5', currentLimit: '5' } },
        { id: 'rb', metadataId: 'resistor', properties: { value: '100' } },
        { id: 'rl', metadataId: 'resistor', properties: { value: '2', power: '50' } },
        { id: 'q1', metadataId: 'bjt-2n2222', properties: {} },
      ],
      [
        w('w1', ['ps', '+'], ['rb', '1']),
        w('w2', ['rb', '2'], ['q1', 'B']),
        w('w3', ['ps', '+'], ['rl', '1']),
        w('w4', ['rl', '2'], ['q1', 'C']),
        w('w5', ['q1', 'E'], ['ps', '-']),
      ],
    );
    expect(transistor.map((x) => x.code).sort()).toEqual(['transistor-overcurrent', 'transistor-overpower']);
    const i = transistor.find((x) => x.code === 'transistor-overcurrent')!;
    expect(i.message).toMatch(/q1 \(2N2222\) carries [\d.]+ A, above its 600 mA rating \(I_C\)/);
  });

  it('an IRF540 half on dissipates past what it sheds in free air', { timeout: 120_000 }, async () => {
    // Gate at 4.6 V: about 0.9 A through 4 ohm from 12 V, 8 V across the channel.
    const { transistor } = await preflight(
      [
        { id: 'ps', metadataId: 'power-supply', properties: { voltage: '12', currentLimit: '5' } },
        { id: 'pg', metadataId: 'power-supply', properties: { voltage: '4.6' } },
        { id: 'rl', metadataId: 'resistor', properties: { value: '4', power: '50' } },
        { id: 'q1', metadataId: 'mosfet-irf540', properties: {} },
      ],
      [
        w('w1', ['ps', '+'], ['rl', '1']),
        w('w2', ['rl', '2'], ['q1', 'D']),
        w('w3', ['q1', 'S'], ['ps', '-']),
        w('w4', ['pg', '+'], ['q1', 'G']),
        w('w5', ['pg', '-'], ['ps', '-']),
      ],
    );
    expect(transistor.map((x) => x.code)).toEqual(['transistor-overpower']);
    expect(transistor[0]!.message).toMatch(/q1 \(IRF540\) dissipates [\d.]+ W, above the 2\.4 W it can shed in free air \(P_D at 25 °C\)/);
  });

  it('the same IRF540 on a heatsink: held to its 150 W, nothing to say', { timeout: 120_000 }, async () => {
    const { transistor } = await preflight(
      [
        { id: 'ps', metadataId: 'power-supply', properties: { voltage: '12', currentLimit: '5' } },
        { id: 'pg', metadataId: 'power-supply', properties: { voltage: '4.6' } },
        { id: 'rl', metadataId: 'resistor', properties: { value: '4', power: '50' } },
        { id: 'q1', metadataId: 'mosfet-irf540', properties: { heatsink: true } },
      ],
      [
        w('w1', ['ps', '+'], ['rl', '1']),
        w('w2', ['rl', '2'], ['q1', 'D']),
        w('w3', ['q1', 'S'], ['ps', '-']),
        w('w4', ['pg', '+'], ['q1', 'G']),
        w('w5', ['pg', '-'], ['ps', '-']),
      ],
    );
    expect(transistor).toEqual([]);
  });

  it('a P-channel high-side switch cutting a coil: its drain falls past -100 V', { timeout: 120_000 }, async () => {
    // A 12 V square on the gate of an IRF9540 whose source is on 12 V: on at
    // 0 V, off at 12 V. The coil hangs from the drain to ground.
    const { transistor } = await preflight(
      [
        { id: 'ps', metadataId: 'power-supply', properties: { voltage: '12' } },
        { id: 'gen', metadataId: 'signal-generator', properties: { waveform: 'square', frequency: '10', amplitude: '6', offset: '6' } },
        { id: 'q1', metadataId: 'mosfet-irf9540', properties: {} },
        { id: 'rc', metadataId: 'resistor', properties: { value: '70' } },
        { id: 'l1', metadataId: 'analog-inductor', properties: { value: '20m' } },
      ],
      [
        w('w1', ['ps', '+'], ['q1', 'S']),
        w('w2', ['gen', 'SIG'], ['q1', 'G']),
        w('w3', ['gen', 'GND'], ['ps', '-']),
        w('w4', ['q1', 'D'], ['rc', '1']),
        w('w5', ['rc', '2'], ['l1', 'A']),
        w('w6', ['l1', 'B'], ['ps', '-']),
      ],
    );
    expect(transistor.map((x) => x.code)).toEqual(['transistor-overvoltage']);
    expect(transistor[0]!.metric!).toBeGreaterThan(100);
    expect(transistor[0]!.metric!).toBeLessThan(102);
    expect(transistor[0]!.message).toMatch(/q1 \(IRF9540\) reaches 10\d\.\d+ V between its drain and source, above its 100 V rating \(V_DSS\)\. A real one avalanches/);
  });

  it('a transistor switching an LED within its ratings: nothing to say', { timeout: 120_000 }, async () => {
    const { all, transistor } = await preflight(
      [
        { id: 'rb', metadataId: 'resistor', properties: { value: '1000' } },
        { id: 'q1', metadataId: 'bjt-2n2222', properties: {} },
        { id: 'rl', metadataId: 'resistor', properties: { value: '220' } },
        { id: 'led1', metadataId: 'led', properties: { color: 'red' } },
      ],
      [
        w('w1', ['uno', '9'], ['rb', '1']),
        w('w2', ['rb', '2'], ['q1', 'B']),
        w('w3', ['q1', 'E'], ['uno', 'GND.1']),
        w('w4', ['uno', '5V'], ['rl', '1']),
        w('w5', ['rl', '2'], ['led1', 'A']),
        w('w6', ['led1', 'C'], ['q1', 'C']),
      ],
      [{ id: 'uno', boardKind: 'arduino-uno' }],
    );
    expect(transistor).toEqual([]);
    expect(all.filter((x) => x.severity === 'error')).toEqual([]);
  });
});

// ── While it runs ──────────────────────────────────────────────────────────

const services: CircuitSimulationService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  __resetMixedModeScheduler();
  vi.restoreAllMocks();
});

/** An Uno pin switching a 70 ohm / 20 mH coil through a 2N2222, the live
 *  solve published into the electrical store the runtime monitor watches. */
async function runCoil(diode: boolean) {
  ComponentRegistry.getInstance().mergeComponents(catalogue);
  const components: Part[] = [
    { id: 'rb', metadataId: 'resistor', properties: { value: '1000' } },
    { id: 'q1', metadataId: 'bjt-2n2222', properties: {} },
    { id: 'rc', metadataId: 'resistor', properties: { value: '70' } },
    { id: 'l1', metadataId: 'analog-inductor', properties: { value: '20m' } },
    ...(diode ? [{ id: 'd1', metadataId: 'diode-1n4007', properties: {} }] : []),
  ];
  const wires: Wire[] = [
    w('w1', ['uno', '9'], ['rb', '1']),
    w('w2', ['rb', '2'], ['q1', 'B']),
    w('w3', ['q1', 'E'], ['uno', 'GND.1']),
    w('w4', ['uno', '5V'], ['rc', '1']),
    w('w5', ['rc', '2'], ['l1', 'A']),
    w('w6', ['l1', 'B'], ['q1', 'C']),
    ...(diode ? [w('w7', ['d1', 'A'], ['q1', 'C']), w('w8', ['d1', 'C'], ['uno', '5V'])] : []),
  ];
  const boards = [{ id: 'uno', boardKind: 'arduino-uno', running: true }];
  useSimulatorStore.setState({
    components: components.map((c) => ({ ...c, x: 0, y: 0 })),
    wires,
    boards,
  } as never);
  useSimulatorStore.setState({ hexEpoch: (useSimulatorStore.getState().hexEpoch ?? 0) + 1 } as never);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  __setSchedulerSolverFactoryForTests(() => new NgSpiceNodeAdapter());
  let pins: Record<string, PinSourceState> = {};
  const simStore: SimulatorStorePort = {
    getState: () => ({ components, wires, boards }),
    subscribe: () => () => {},
  };
  const service = new CircuitSimulationService(
    simStore,
    { publish: (snapshot) => useElectricalStore.getState().setSolveResult(snapshot as never) },
    getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
    { collectBoardPinStates: () => pins },
  );
  services.push(service);
  await service.tick();
  let guest = 100;
  for (const high of [true, false, true, false]) {
    pins = { ...pins, '9': { type: 'digital', v: high ? 5 : 0 } };
    await service.handleMcuEdge('uno', '9', high, 5, guest);
    guest += 500;
    await sleep(300);
  }
  return warn.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('[transistor]'));
}

/** A boardless 2N2222 asked for 1.3 A (base from 5 V through 100 ohm, a 2
 *  ohm load), solved by the real service into the store the monitor watches. */
async function runOverload() {
  ComponentRegistry.getInstance().mergeComponents(catalogue);
  const components: Part[] = [
    { id: 'ps', metadataId: 'power-supply', properties: { voltage: '5', currentLimit: '5' } },
    { id: 'rb', metadataId: 'resistor', properties: { value: '100' } },
    { id: 'rl', metadataId: 'resistor', properties: { value: '2', power: '50' } },
    { id: 'q1', metadataId: 'bjt-2n2222', properties: {} },
  ];
  const wires: Wire[] = [
    w('w1', ['ps', '+'], ['rb', '1']),
    w('w2', ['rb', '2'], ['q1', 'B']),
    w('w3', ['ps', '+'], ['rl', '1']),
    w('w4', ['rl', '2'], ['q1', 'C']),
    w('w5', ['q1', 'E'], ['ps', '-']),
  ];
  useSimulatorStore.setState({ components: components.map((c) => ({ ...c, x: 0, y: 0 })), wires, boards: [] } as never);
  useSimulatorStore.setState({ hexEpoch: (useSimulatorStore.getState().hexEpoch ?? 0) + 1 } as never);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  __setSchedulerSolverFactoryForTests(() => new NgSpiceNodeAdapter());
  const service = new CircuitSimulationService(
    { getState: () => ({ components, wires, boards: [] }), subscribe: () => () => {} },
    { publish: (snapshot) => useElectricalStore.getState().setSolveResult(snapshot as never) },
    getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
    { collectBoardPinStates: () => ({}) },
  );
  services.push(service);
  await service.tick();
  await sleep(50);
  const said = () => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('[transistor]'));
  return { said };
}

describe('the runtime monitor holds transistors to their ratings (velxio/velxio-prod#138)', () => {
  it('a thermal rating is said once the circuit has stayed past it, not at the first solve', { timeout: 120_000 }, async () => {
    const { said } = await runOverload();
    // The current and the power are thermal: nothing yet...
    expect(said()).toEqual([]);
    // ...and both once the circuit has sat there for the burn delay.
    await sleep(1000);
    expect(said()).toHaveLength(2);
    expect(said().join('\n')).toMatch(/q1 \(2N2222\) carries [\d.]+ A, above its 600 mA rating \(I_C\)/);
    expect(said().join('\n')).toMatch(/q1 \(2N2222\) dissipates [\d.]+ W, above the 625 mW it can shed in free air/);
  });

  it('a pin switching a coil off with no diode: the kick past 40 V, said once', { timeout: 120_000 }, async () => {
    const said = await runCoil(false);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^\[transistor\] Transistor q1 \(2N2222\) reaches 40\.\d+ V between its collector and emitter, above its 40 V rating \(V_CEO\)/);
    expect(said[0]).toMatch(/flyback diode across the coil/);
  });

  it('the same coil with a flyback diode: nothing to say', { timeout: 120_000 }, async () => {
    expect(await runCoil(true)).toEqual([]);
  });
});
