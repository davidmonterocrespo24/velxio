/**
 * CircuitSimulationService tests.
 *
 * Fully isolated from useSimulatorStore + useElectricalStore + the
 * WASM scheduler.  Uses fakes for every port so the service's
 * orchestration logic is exercised standalone.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CircuitSimulationService,
  type SimulatorStorePort,
  type ElectricalStorePort,
  type MixedModeSchedulerPort,
  type ElectricalSnapshot,
} from '../simulation/spice/CircuitSimulationService';
import {
  getMixedModeScheduler,
  __resetMixedModeScheduler,
  __setSchedulerSolverFactoryForTests,
} from '../simulation/spice/MixedModeScheduler';
import { FakeSolverAdapter } from '../simulation/spice/adapters/FakeSolverAdapter';

// Tracks unsubscribe handles + services so afterEach can fully shut
// the orchestrator down. Two leaks fixed together:
//
//   1. service.start() returns an unsubscribe handle for the store
//      subscription. If the test never called it, the listener pinned
//      the simStore (+ service + scheduler via closure) and vitest's
//      forks pool stopped exiting cleanly.
//   2. Even with the subscription released, service.tick() is async
//      and its finally-block recursively re-schedules itself when
//      `pendingMcuEdges` is non-empty. After afterEach disposes the
//      scheduler, those re-scheduled ticks throw "call loadCircuit
//      first", get caught, and schedule ANOTHER tick — infinite
//      Promise loop in the event queue that survives until the worker
//      OOMs (the manifest of the original "circuit-sim solve failed"
//      console.warn that kept appearing across files). Fix: call
//      `service.stop()` which flips an internal `stopped` flag that
//      short-circuits tick() + handleMcuEdge().
const _activeUnsubs: Array<() => void> = [];
const _activeServices: Array<{ stop: () => void }> = [];

function startTracked(service: {
  start: () => () => void;
  stop: () => void;
}): () => void {
  const unsub = service.start();
  _activeUnsubs.push(unsub);
  _activeServices.push(service);
  return unsub;
}

afterEach(() => {
  for (const unsub of _activeUnsubs.splice(0)) {
    try { unsub(); } catch { /* ignore */ }
  }
  for (const service of _activeServices.splice(0)) {
    try { service.stop(); } catch { /* ignore */ }
  }
  __resetMixedModeScheduler();
});

function makeSimStore(initial: {
  components: Array<{ id: string; metadataId: string; properties: Record<string, unknown> }>;
  wires: Array<{
    id: string;
    start: { componentId: string; pinName: string };
    end: { componentId: string; pinName: string };
  }>;
  boards: Array<{ id: string; boardKind: string }>;
}): { port: SimulatorStorePort; set(next: Partial<typeof initial>): void } {
  let state: typeof initial = initial;
  const listeners: Array<(s: unknown, p: unknown) => void> = [];
  return {
    port: {
      getState: () => state,
      subscribe(l) {
        listeners.push(l);
        return () => {
          const i = listeners.indexOf(l);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
    },
    set(next) {
      const prev = state;
      state = { ...state, ...next };
      for (const l of listeners) l(state, prev);
    },
  };
}

function makeElectricalStore(): {
  port: ElectricalStorePort;
  snapshots: ElectricalSnapshot[];
} {
  const snapshots: ElectricalSnapshot[] = [];
  return {
    snapshots,
    port: {
      publish(s) {
        snapshots.push(s);
      },
    },
  };
}

const simpleBoardWithBoard = {
  components: [{ id: 'r1', metadataId: 'resistor', properties: { value: '1k' } }],
  wires: [
    {
      id: 'w1',
      start: { componentId: 'uno', pinName: '5V' },
      end: { componentId: 'r1', pinName: '1' },
    },
    {
      id: 'w2',
      start: { componentId: 'r1', pinName: '2' },
      end: { componentId: 'uno', pinName: 'GND' },
    },
  ],
  boards: [{ id: 'uno', boardKind: 'arduino-uno' }],
};

describe('CircuitSimulationService — orchestration', () => {
  it('runs an initial solve when started', async () => {
    const fake = new FakeSolverAdapter({ vectors: { 'v(vcc_rail)': 5 } });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({ '5V': { type: 'digital', v: 5 } }) },
    );
    startTracked(service);
    await new Promise((r) => setTimeout(r, 20));

    expect(fake.calls.loadCircuit.length).toBe(1);
    expect(fake.calls.solve.length).toBe(1);
    expect(elec.snapshots.length).toBe(1);
    expect(elec.snapshots[0]?.analysisMode).toBe('op');
    expect(elec.snapshots[0]?.nodeVoltages.vcc_rail).toBeCloseTo(5);
  });

  it('extracts branch currents from i(v_*) vectors', async () => {
    const fake = new FakeSolverAdapter({
      vectors: { 'v(vcc_rail)': 5, 'i(v_vcc_rail)': -0.005 },
    });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({ '5V': { type: 'digital', v: 5 } }) },
    );
    startTracked(service);
    await new Promise((r) => setTimeout(r, 20));

    const snap = elec.snapshots[0];
    expect(snap?.branchCurrents.v_vcc_rail).toBeCloseTo(-0.005);
  });

  it('re-solves on components / wires / boards changes', async () => {
    const fake = new FakeSolverAdapter({ vectors: { 'v(vcc_rail)': 5 } });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({ '5V': { type: 'digital', v: 5 } }) },
    );
    startTracked(service);
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.calls.solve.length).toBe(1);

    sim.set({ components: [...simpleBoardWithBoard.components, { id: 'r2', metadataId: 'resistor', properties: {} }] });
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.calls.solve.length).toBe(2);
  });

  it('does NOT re-solve when an unrelated field changes', async () => {
    const fake = new FakeSolverAdapter({ vectors: { 'v(vcc_rail)': 5 } });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({}) },
    );
    startTracked(service);
    await new Promise((r) => setTimeout(r, 10));
    sim.set({}); // same arrays — should NOT trigger a re-solve
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.calls.solve.length).toBe(1);
  });

  it('does NOT re-solve when a board only appended serial output', async () => {
    // The serial batcher rewrites `boards` once per frame with a longer
    // serialOutput. An ESP32 printing a line per GPIO write used to pay one
    // full rebuild+solve per edge for that (rebuildCount climbing in step with
    // edgeCount on velxio.dev, 2026-09-05).
    const fake = new FakeSolverAdapter({ vectors: { 'v(vcc_rail)': 5 } });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({}) },
    );
    startTracked(service);
    await new Promise((r) => setTimeout(r, 10));
    expect(service.rebuildCount).toBe(1);

    sim.set({ boards: [{ id: 'uno', boardKind: 'arduino-uno', serialOutput: 'H\n' } as never] });
    sim.set({ boards: [{ id: 'uno', boardKind: 'arduino-uno', serialOutput: 'H\nL\n' } as never] });
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.calls.solve.length).toBe(1);
    expect(service.rebuildCount).toBe(1);

    // Stop resets every pin, so a running flip must still rebuild.
    sim.set({ boards: [{ id: 'uno', boardKind: 'arduino-uno', running: true } as never] });
    await new Promise((r) => setTimeout(r, 10));
    expect(service.rebuildCount).toBe(2);
    // A kind change rebuilds too.
    sim.set({ boards: [{ id: 'uno', boardKind: 'arduino-nano', running: true } as never] });
    await new Promise((r) => setTimeout(r, 10));
    expect(service.rebuildCount).toBe(3);
  });

  it('coalesces solves when one is in flight', async () => {
    const fake = new FakeSolverAdapter({
      vectors: { 'v(vcc_rail)': 5 },
      solveDelayMs: 30,
    });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({}) },
    );
    startTracked(service);
    await new Promise((r) => setTimeout(r, 5)); // the initial solve is in flight
    sim.set({ components: [{ id: 'a', metadataId: 'resistor', properties: {} }] });
    sim.set({ components: [{ id: 'b', metadataId: 'resistor', properties: {} }] });
    sim.set({ components: [{ id: 'c', metadataId: 'resistor', properties: {} }] });
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.calls.solve.length).toBe(2); // initial + 1 trailing
  });

  it('publishes .tran waveforms when analysis is transient', async () => {
    const fake = new FakeSolverAdapter({
      vectors: {
        'v(n_out)': new Float64Array([0, 1, 2, 3, 4]),
        'i(v_src)': new Float64Array([0.01, 0.02, 0.03, 0.04, 0.05]),
      },
      timeAxis: new Float64Array([0, 1e-4, 2e-4, 3e-4, 4e-4]),
    });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore({
      components: [
        // A signal-generator forces .tran in buildInputFromStore.
        {
          id: 'sg1',
          metadataId: 'signal-generator',
          properties: { waveform: 'sine', frequency: 100 },
        },
      ],
      wires: [],
      boards: [{ id: 'uno', boardKind: 'arduino-uno' }],
    });
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({}) },
    );
    startTracked(service);
    await new Promise((r) => setTimeout(r, 20));

    const snap = elec.snapshots[0];
    expect(snap?.analysisMode).toBe('tran');
    expect(snap?.timeWaveforms).toBeDefined();
    expect(snap?.timeWaveforms?.time.length).toBe(5);
  });

  it('publishes warnings from the solver', async () => {
    const fake = new FakeSolverAdapter({ vectors: { 'v(vcc_rail)': 5 } });
    // FakeSolverAdapter does not currently emit warnings; vetting that the
    // service forwards them is sufficient — see solver-port-contract for
    // the warnings-field contract.
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({}) },
    );
    startTracked(service);
    await new Promise((r) => setTimeout(r, 10));
    // The FakeSolverAdapter returns empty warnings, so the snapshot
    // also has empty warnings — but the field exists.
    expect(elec.snapshots[0]?.warnings).toEqual([]);
  });
});

describe('handleMcuEdge (Phase 1c D1)', () => {
  it('runs an initial full solve, then alter + republish on edge', async () => {
    let gateV = 0;
    let drainV = 4.9;
    const fake = new FakeSolverAdapter({
      vectors: () => ({
        'v(net_gate)': gateV,
        'v(net_drain)': drainV,
        'v(vcc_rail)': 5,
        'i(v_vcc_rail)': -0.005,
      }),
    });
    fake.onAlter = (name, value) => {
      if (name === 'V_uno_9') {
        gateV = value;
        drainV = value >= 1.6 ? 0.05 : 4.9;
      }
    };
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore({
      components: [
        { id: 'q1', metadataId: 'bjt-2n2222', properties: {} },
        { id: 'rb', metadataId: 'resistor', properties: { value: '1k' } },
      ],
      wires: [
        {
          id: 'w1',
          start: { componentId: 'uno', pinName: '9' },
          end: { componentId: 'rb', pinName: '1' },
        },
        {
          id: 'w2',
          start: { componentId: 'rb', pinName: '2' },
          end: { componentId: 'q1', pinName: 'B' },
        },
      ],
      boards: [{ id: 'uno', boardKind: 'arduino-uno' }],
    });
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      // Mark pin 9 as a digital MCU output so the netlist emits
      // V_uno_9 from the very first solve. Without this the
      // self-heal path in handleMcuEdge triggers a rebuild (full
      // tick) instead of the alter + resolveDc fast path the test
      // is verifying, and the assertion below races the rebuild's
      // own solve completing.
      { collectBoardPinStates: () => ({ '9': { type: 'digital', v: 0 } }) },
    );
    startTracked(service);
    await new Promise((r) => setTimeout(r, 20));
    const initialSolves = fake.calls.solve.length;
    const initialSnapshots = elec.snapshots.length;
    expect(initialSolves).toBe(1); // initial full solve
    expect(initialSnapshots).toBe(1);

    await service.handleMcuEdge('uno', '9', true, 5);
    // Solve count went up by exactly 1 (alter + .op), no new loadCircuit.
    expect(fake.calls.solve.length).toBe(initialSolves + 1);
    expect(fake.calls.loadCircuit.length).toBe(1); // still 1
    expect(fake.calls.alterSource).toEqual([['V_uno_9', 5]]);
    expect(elec.snapshots.length).toBe(initialSnapshots + 1);
  });

  it('an edge that lands while the deck is being solved is not lost', async () => {
    // The deck collects its pin levels before it solves. A level reported
    // during the solve is in neither the deck nor the timeline that comes
    // with it; the service keeps the last level of every pad with its time
    // and puts the ones newer than the collection back on the new
    // timeline, so the first window publishes them.
    const fake = new FakeSolverAdapter({
      vectors: { 'v(vcc_rail)': 5 },
      solveDelayMs: 30,
    });
    __setSchedulerSolverFactoryForTests(() => fake);
    // Pin 9 must be wired into the netlist so buildNetlist emits V_uno_9
    // (NetlistBuilder skips board pins whose net lookup returns null).
    const sim = makeSimStore({
      components: [
        { id: 'rb', metadataId: 'resistor', properties: { value: '1k' } },
      ],
      wires: [
        {
          id: 'w1',
          start: { componentId: 'uno', pinName: '9' },
          end: { componentId: 'rb', pinName: '1' },
        },
        {
          id: 'w2',
          start: { componentId: 'rb', pinName: '2' },
          end: { componentId: 'uno', pinName: 'GND' },
        },
      ],
      boards: [{ id: 'uno', boardKind: 'arduino-uno' }],
    });
    const elec = makeElectricalStore();
    let pin9 = 0;
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({ '9': { type: 'digital', v: pin9 } }) },
    );
    startTracked(service);
    await new Promise((r) => setTimeout(r, 60)); // first deck loaded, pin 9 is a known pad
    sim.set({ components: [{ id: 'rb', metadataId: 'resistor', properties: { value: '2k' } }] });
    await new Promise((r) => setTimeout(r, 5)); // rebuild collected 0 V, solve in flight
    pin9 = 5;
    void service.handleMcuEdge('uno', '9', true, 5);
    await new Promise((r) => setTimeout(r, 150));
    expect(fake.calls.alterSource).toEqual([['V_uno_9', 5]]);
    const last = elec.snapshots.at(-1)!;
    expect(last.window?.states.at(-1)?.levels['v_uno_9']).toBe(5);
  });

  it('bounds solve rate under a sustained edge storm (multiplexed display)', async () => {
    // Regression: a 4-digit 7-segment clock over QEMU keeps ~13 pins hot
    // (thousands of GPIO edges/second). Replaying queued edges IMMEDIATELY
    // after each solve ran the solver at 100% duty with no idle gap — the
    // main thread starved for minutes until the sim WebSocket dropped.
    // The drain timer must space solves out: over a ~200 ms storm window
    // the solve count stays bounded (~1 per 33 ms gap), nowhere near the
    // one-solve-per-edge fire hose.
    const fake = new FakeSolverAdapter({
      vectors: { 'v(vcc_rail)': 5 },
      solveDelayMs: 2,
    });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore({
      components: [
        { id: 'rb', metadataId: 'resistor', properties: { value: '1k' } },
      ],
      wires: [
        {
          id: 'w1',
          start: { componentId: 'uno', pinName: '9' },
          end: { componentId: 'rb', pinName: '1' },
        },
        {
          id: 'w2',
          start: { componentId: 'rb', pinName: '2' },
          end: { componentId: 'uno', pinName: 'GND' },
        },
      ],
      boards: [{ id: 'uno', boardKind: 'arduino-uno' }],
    });
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({ '9': { type: 'digital', v: 0 } }) },
    );
    startTracked(service);
    await new Promise((r) => setTimeout(r, 30)); // let the initial solve land

    // Storm: toggle the pin every 2 ms for 200 ms (~100 edges).
    let state = false;
    for (let i = 0; i < 100; i++) {
      state = !state;
      void service.handleMcuEdge('uno', '9', state, 5);
      await new Promise((r) => setTimeout(r, 2));
    }
    await new Promise((r) => setTimeout(r, 80)); // trailing drain

    // 100 edges in ~200 ms with a 33 ms drain gap → ~7 solves + initial.
    // Generous ceiling; the pre-fix behaviour was 1 solve per edge (100+).
    const total = fake.calls.solve.length;
    expect(total).toBeGreaterThanOrEqual(2); // it DID keep solving
    expect(total).toBeLessThanOrEqual(30);
  });

  it('kicks a full tick when no circuit has been loaded yet', async () => {
    const fake = new FakeSolverAdapter({ vectors: { 'v(vcc_rail)': 5 } });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({}) },
    );
    // No service.start() — first call is handleMcuEdge.
    await service.handleMcuEdge('uno', '9', true, 5);
    await new Promise((r) => setTimeout(r, 10));
    // Should have done a FULL tick (loadCircuit + solve), not just alter.
    expect(fake.calls.loadCircuit.length).toBe(1);
    expect(fake.calls.alterSource).toEqual([]);
  });

  it('heals a sibling pin that was classified as an output mid-solve', async () => {
    // Regression (binary-counter-leds, the most-viewed gallery example):
    // a sketch writing several pins between yields lost every pin but the
    // first. Sequence: pin 2's edge lands first, self-heals, and rebuilds
    // the netlist; pins 3-5 arrive while that solve is in flight and used
    // to be queued and then dropped for having no source in the loaded
    // context, so they stayed at their build-time voltage forever. Bit 0
    // blinked, bits 1-3 stayed dark while the firmware counted correctly
    // on serial.
    //
    // A pad without a source costs one rebuild per deck, and the rebuild
    // reads the live pin levels, so the next deck carries every sibling
    // at the level it holds.
    const fake = new FakeSolverAdapter({
      vectors: { 'v(vcc_rail)': 5 },
      solveDelayMs: 30,
    });
    __setSchedulerSolverFactoryForTests(() => fake);
    // Pin 3 is NOT an MCU output at build time — it becomes one only once
    // the firmware first drives it, exactly like PinManager.outputPins.
    // `levels` is the PinManager's view: the level the pad holds.
    let pin3IsOutput = false;
    const levels: Record<string, number> = { '2': 0, '3': 0 };
    const sim = makeSimStore({
      components: [
        { id: 'r2', metadataId: 'resistor', properties: { value: '220' } },
        { id: 'r3', metadataId: 'resistor', properties: { value: '220' } },
      ],
      wires: [
        { id: 'w2a', start: { componentId: 'uno', pinName: '2' }, end: { componentId: 'r2', pinName: '1' } },
        { id: 'w2b', start: { componentId: 'r2', pinName: '2' }, end: { componentId: 'uno', pinName: 'GND' } },
        { id: 'w3a', start: { componentId: 'uno', pinName: '3' }, end: { componentId: 'r3', pinName: '1' } },
        { id: 'w3b', start: { componentId: 'r3', pinName: '2' }, end: { componentId: 'uno', pinName: 'GND' } },
      ],
      boards: [{ id: 'uno', boardKind: 'arduino-uno' }],
    });
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      {
        collectBoardPinStates: () =>
          pin3IsOutput
            ? { '2': { type: 'digital', v: levels['2'] }, '3': { type: 'digital', v: levels['3'] } }
            : { '2': { type: 'digital', v: levels['2'] } },
      },
    );
    startTracked(service);
    // Let the initial netlist get built (without pin 3) while its solve
    // is still in flight.
    await new Promise((r) => setTimeout(r, 5));
    pin3IsOutput = true;
    levels['2'] = 5;
    void service.handleMcuEdge('uno', '2', true, 5);
    levels['3'] = 5;
    void service.handleMcuEdge('uno', '3', true, 5);
    await new Promise((r) => setTimeout(r, 300));
    const deck = fake.calls.loadCircuit.at(-1) ?? '';
    expect(deck).toMatch(/V_uno_3 \S+ 0 DC 5/);
    expect(deck).toMatch(/V_uno_2 \S+ 0 DC 5/);
    // The healed pins never cost more than the one rebuild each deck allows.
    expect(fake.calls.solve.length).toBeLessThanOrEqual(3);
  });

  it('does not loop forever healing a pin that can never be sourced', async () => {
    // The flip side of the heal above: an unwired GPIO never gets a
    // V-source no matter how many rebuilds run. The per-pin guard must
    // let it through at most once, then go back to dropping — otherwise
    // heal -> tick -> heal spins the solver at 100% duty.
    const fake = new FakeSolverAdapter({
      vectors: { 'v(vcc_rail)': 5 },
      solveDelayMs: 5,
    });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      // Pin 7 is claimed as an output but is wired to nothing, so
      // buildNetlist never emits V_uno_7.
      { collectBoardPinStates: () => ({ '7': { type: 'digital', v: 0 } }) },
    );
    startTracked(service);
    await new Promise((r) => setTimeout(r, 20));
    const before = fake.calls.solve.length;
    void service.handleMcuEdge('uno', '7', true, 5);
    await new Promise((r) => setTimeout(r, 400));
    // A bounded number of extra solves — not one per 33 ms drain gap
    // (~12 over this window) and nowhere near a runaway.
    expect(fake.calls.solve.length - before).toBeLessThanOrEqual(4);
  });
});

describe('the publish window keeps every state the pads went through', () => {
  // Two wired output pins, like two LEDs of a chase: each step lowers one
  // pin and raises the next within microseconds of each other.
  const twoPins = {
    components: [
      { id: 'ra', metadataId: 'resistor', properties: { value: '1k' } },
      { id: 'rb', metadataId: 'resistor', properties: { value: '1k' } },
    ],
    wires: [
      { id: 'w1', start: { componentId: 'uno', pinName: '9' }, end: { componentId: 'ra', pinName: '1' } },
      { id: 'w2', start: { componentId: 'ra', pinName: '2' }, end: { componentId: 'uno', pinName: 'GND' } },
      { id: 'w3', start: { componentId: 'uno', pinName: '10' }, end: { componentId: 'rb', pinName: '1' } },
      { id: 'w4', start: { componentId: 'rb', pinName: '2' }, end: { componentId: 'uno', pinName: 'GND' } },
    ],
    boards: [{ id: 'uno', boardKind: 'arduino-uno' }],
  };

  /** A service over twoPins whose collector mirrors the levels the test drives. */
  function setup(solveDelayMs: number) {
    const fake = new FakeSolverAdapter({ vectors: { 'v(vcc_rail)': 5 }, solveDelayMs });
    __setSchedulerSolverFactoryForTests(() => fake);
    const levels: Record<string, number> = { '9': 0, '10': 0 };
    const sim = makeSimStore(twoPins);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port, elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({
        '9': { type: 'digital', v: levels['9'] },
        '10': { type: 'digital', v: levels['10'] },
      }) },
    );
    startTracked(service);
    const drive = (pin: '9' | '10', high: boolean) => {
      levels[pin] = high ? 5 : 0;
      void service.handleMcuEdge('uno', pin, high, 5);
    };
    /** Milliseconds the published windows gave to states where `pin` was high. */
    const highMs = (pin: string) => elec.snapshots.reduce((acc, snap) => {
      for (const st of snap.window?.states ?? []) if (st.levels[`v_uno_${pin}`] === 5) acc += st.ms;
      return acc;
    }, 0);
    return { fake, sim, elec, service, drive, highMs };
  }

  it('a 50 ms step of a chase is a state worth 50 ms, whatever the solver was doing', async () => {
    // Regression: the Mega 16-LED bar (50 ms per step) lit only the LEDs at
    // the turnarounds. A step's HIGH landed while the previous step's LOW
    // was still solving, was queued last-state-wins, and 50 ms later its
    // own LOW overwrote it: the solver never saw the HIGH and that LED
    // never lit. Now the HIGH is 48 ms of the windows it spans.
    const { elec, drive, highMs } = setup(30);
    await new Promise((r) => setTimeout(r, 60)); // initial solve lands

    drive('9', true);                              // solves now, 30 ms in flight
    await new Promise((r) => setTimeout(r, 2));
    drive('10', true);                             // lands while it solves
    await new Promise((r) => setTimeout(r, 48));
    drive('10', false);
    await new Promise((r) => setTimeout(r, 200));  // windows settle

    expect(highMs('10')).toBeGreaterThanOrEqual(40);
    expect(highMs('10')).toBeLessThanOrEqual(60);
    // And the last word is the level the pad holds.
    const last = elec.snapshots.at(-1)!;
    const latest = last.window ? last.window.states.at(-1)! : undefined;
    expect(latest?.levels['v_uno_10'] ?? 0).toBe(0);
  });

  it('a glitch of a few milliseconds weighs a few milliseconds, not a frame and not nothing', async () => {
    const { drive, highMs } = setup(30);
    await new Promise((r) => setTimeout(r, 60));

    drive('9', true);
    await new Promise((r) => setTimeout(r, 2));
    drive('10', true);
    await new Promise((r) => setTimeout(r, 3));
    drive('10', false);
    await new Promise((r) => setTimeout(r, 200));

    expect(highMs('10')).toBeGreaterThan(0);
    expect(highMs('10')).toBeLessThanOrEqual(12);
  });

  it('the latest state of a window is the level the pads hold, even after toggling back', async () => {
    const { elec, drive } = setup(30);
    await new Promise((r) => setTimeout(r, 60));

    drive('9', true);
    await new Promise((r) => setTimeout(r, 2));
    drive('10', true);
    await new Promise((r) => setTimeout(r, 20));
    drive('10', false);
    await new Promise((r) => setTimeout(r, 2));
    drive('10', true);
    await new Promise((r) => setTimeout(r, 200));

    const windows = elec.snapshots.filter((snap) => snap.window);
    expect(windows.length).toBeGreaterThan(0);
    const last = windows.at(-1)!.window!;
    expect(last.states.at(-1)!.levels['v_uno_10']).toBe(5);
    const weights = last.states.reduce((a, st) => a + st.weight, 0);
    expect(weights).toBeCloseTo(1, 6);
  });

  it('a periodic pattern is solved once per state and then only looked up', async () => {
    // A scan, a software PWM, a multiplexed display: the same few states
    // again and again. Each costs the solver once per deck.
    const { fake, drive } = setup(2);
    await new Promise((r) => setTimeout(r, 30));
    const before = fake.calls.solve.length;
    let high = false;
    for (let i = 0; i < 20; i++) {
      high = !high;
      drive('9', high);
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 100));
    // Two states (pin 9 high, pin 9 low), the low one is the deck's own.
    expect(fake.calls.solve.length - before).toBeLessThanOrEqual(2);
  });

  it('an unwired output pin scanned every step rebuilds the deck a few times a second, not per edge', async () => {
    // The Mega bar scans pins 22-37 with LEDs on 22-29 only: every edge on
    // an unwired pin took the self-heal and rebuilt the whole netlist,
    // sixteen rebuilds per sweep, which is where the solve time that lost
    // the pulses above came from. A pad asks again only after HEAL_RETRY_MS.
    const fake = new FakeSolverAdapter({ vectors: { 'v(vcc_rail)': 5 }, solveDelayMs: 2 });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port, elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({ '7': { type: 'digital', v: 0 } }) },
    );
    startTracked(service);
    await new Promise((r) => setTimeout(r, 30));
    const before = fake.calls.solve.length;
    let level = false;
    for (let i = 0; i < 10; i++) {
      level = !level;
      void service.handleMcuEdge('uno', '7', level, 5);
      await new Promise((r) => setTimeout(r, 40));
    }
    await new Promise((r) => setTimeout(r, 100));
    // 400 ms of edges at one heal per 250 ms: two, three with the trailing one.
    expect(fake.calls.solve.length - before).toBeLessThanOrEqual(3);
  });

  it('a pad whose first rebuild ran during a reset is healed by the next edge', async () => {
    // The Mega bar on velxio.dev: the firmware's first burst of edges
    // landed while Run was resetting the board, the rebuild they asked
    // for collected no outputs, and with "once per deck" no later edge
    // could ask again. Here the collector reports the pin as an output
    // only from the second rebuild on, like a reset would.
    const fake = new FakeSolverAdapter({ vectors: { 'v(vcc_rail)': 5 }, solveDelayMs: 5 });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore({
      components: [{ id: 'rb', metadataId: 'resistor', properties: { value: '1k' } }],
      wires: [
        { id: 'w1', start: { componentId: 'uno', pinName: '9' }, end: { componentId: 'rb', pinName: '1' } },
        { id: 'w2', start: { componentId: 'rb', pinName: '2' }, end: { componentId: 'uno', pinName: 'GND' } },
      ],
      boards: [{ id: 'uno', boardKind: 'arduino-uno' }],
    });
    const elec = makeElectricalStore();
    let rebuilds = 0;
    const service = new CircuitSimulationService(
      sim.port, elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => (++rebuilds >= 3 ? { '9': { type: 'digital', v: 5 } } : {}) },
    );
    startTracked(service);
    await new Promise((r) => setTimeout(r, 30));           // rebuild 1: no outputs
    void service.handleMcuEdge('uno', '9', true, 5);       // heal -> rebuild 2: still none (reset)
    await new Promise((r) => setTimeout(r, 300));          // past HEAL_RETRY_MS
    void service.handleMcuEdge('uno', '9', true, 5);       // asks again -> rebuild 3 carries the pad
    await new Promise((r) => setTimeout(r, 100));
    const deck = fake.calls.loadCircuit.at(-1) ?? '';
    expect(deck).toMatch(/V_uno_9 \S+ 0 DC 5/);
  });
});

describe('CircuitSimulationService — error handling', () => {
  it('logs but does not throw when solver fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = new FakeSolverAdapter();
    // Override solve to reject on first call.
    let calls = 0;
    fake.solve = async () => {
      calls++;
      throw new Error('boom');
    };
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({}) },
    );
    startTracked(service);
    await new Promise((r) => setTimeout(r, 10));
    expect(warn).toHaveBeenCalled();
    expect(elec.snapshots.length).toBe(0); // no publish on failure
    expect(calls).toBeGreaterThan(0);
    warn.mockRestore();
  });
});
