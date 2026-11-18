/**
 * A reactive circuit carries its state across pad edges (velxio/velxio-prod#153).
 *
 * The circuit service runs a step only when the circuit is not where the new
 * pad state's operating point has it: from the capacitor voltages and
 * inductor currents it holds at the edge, read on the curve published last at
 * the time since it began, as a one-shot capture whose t = 0 is the edge
 * (ElectricalSnapshot.stepWaveforms, beside the operating point it settles
 * to). A circuit already there (a Blink with a decoupling capacitor) runs
 * none. And a board whose ADC the bridge does not hook (the ESP32 family) is
 * fed the curve as a scalar over time and then the operating point: pushed as
 * a waveform, the engine would loop it.
 *
 * The first two run the real service, scheduler and ngspice (the Node adapter).
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
import { interpolateAt } from '../simulation/spice/waveformStats';
import type { PinSourceState, TimeWaveforms } from '../simulation/spice/types';

type Wire = { id: string; start: { componentId: string; pinName: string }; end: { componentId: string; pinName: string } };
const w = (id: string, a: [string, string], b: [string, string]): Wire => ({
  id,
  start: { componentId: a[0], pinName: a[1] },
  end: { componentId: b[0], pinName: b[1] },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const services: CircuitSimulationService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  __resetMixedModeScheduler();
});

function setup(
  components: Array<{ id: string; metadataId: string; properties: Record<string, unknown> }>,
  wires: Wire[],
  initial: Record<string, PinSourceState>,
) {
  __setSchedulerSolverFactoryForTests(() => new NgSpiceNodeAdapter());
  let pins = initial;
  const published: ElectricalSnapshot[] = [];
  const simStore: SimulatorStorePort = {
    getState: () => ({ components, wires, boards: [{ id: 'uno', boardKind: 'arduino-uno', running: true }] }),
    subscribe: () => () => {},
  };
  const service = new CircuitSimulationService(
    simStore,
    { publish: (s) => published.push(s) },
    getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
    { collectBoardPinStates: () => pins },
  );
  services.push(service);
  const drive = async (pin: string, high: boolean, guestMs: number) => {
    pins = { ...pins, [pin]: { type: 'digital', v: high ? 5 : 0 } };
    await service.handleMcuEdge('uno', pin, high, 5, guestMs);
    await sleep(150);
  };
  return { service, published, drive };
}

/** The A0 curve of a snapshot's step at `t` seconds after it began. */
const a0At = (s: ElectricalSnapshot, t: number): number => {
  const net = s.pinNetMap.get('uno:A0')!;
  return interpolateAt(s.stepWaveforms!.time, s.stepWaveforms!.nodes.get(net)!, t);
};

const RC = {
  components: [
    { id: 'r1', metadataId: 'resistor', properties: { value: '10000' } },
    { id: 'c1', metadataId: 'capacitor', properties: { value: '100u' } },
  ],
  wires: [
    w('w1', ['uno', '8'], ['r1', '1']),
    w('w2', ['r1', '2'], ['c1', '1']),
    w('w3', ['r1', '2'], ['uno', 'A0']),
    w('w4', ['c1', '2'], ['uno', 'GND.1']),
  ],
};

describe('a reactive circuit steps from the state it is in', () => {
  it('charges from 0 V at the edge that drives it, then discharges from where it got to', { timeout: 60_000 }, async () => {
    const { service, published, drive } = setup(RC.components, RC.wires, {});
    await service.tick(); // pin 8 not driven: the capacitor at 0 V
    expect(published.at(-1)!.timeWaveforms).toBeUndefined();
    expect(published.at(-1)!.stepWaveforms).toBeUndefined();

    await drive('8', true, 100); // digitalWrite(8, HIGH) at 100 ms of guest time
    const charge = published.at(-1)!;
    expect(charge.stepWaveforms?.oneShot?.guestMs).toEqual({ uno: 100 });
    // The state's own capture is not the step: the meters read the DC it
    // settles to, which is what the scalar fields hold.
    expect(charge.timeWaveforms).toBeUndefined();
    expect(charge.nodeVoltages[charge.pinNetMap.get('uno:A0')!]).toBeCloseTo(5, 3);
    // 5 (1 - e^-t) with RC = 1 s, and a capture long enough to see it settle.
    expect(a0At(charge, 0)).toBeCloseTo(0, 2);
    expect(a0At(charge, 0.1)).toBeCloseTo(5 * (1 - Math.exp(-0.1)), 2);
    expect(a0At(charge, 1)).toBeCloseTo(5 * (1 - Math.exp(-1)), 2);
    expect(charge.stepWaveforms!.time.at(-1)!).toBeGreaterThanOrEqual(4.9);

    await drive('8', false, 600); // digitalWrite(8, LOW) 0.5 s later
    const discharge = published.at(-1)!;
    expect(discharge.stepWaveforms?.oneShot?.guestMs).toEqual({ uno: 600 });
    const v0 = 5 * (1 - Math.exp(-0.5));
    expect(a0At(discharge, 0)).toBeCloseTo(v0, 2);
    expect(a0At(discharge, 1)).toBeCloseTo(v0 * Math.exp(-1), 2);
    expect(service.stepSolveCount).toBe(2);
  });

  it('a Blink with a decoupling capacitor runs no step: the capacitor is where it settles', { timeout: 60_000 }, async () => {
    const { service, published, drive } = setup(
      [
        { id: 'r1', metadataId: 'resistor', properties: { value: '220' } },
        { id: 'led1', metadataId: 'led', properties: { color: 'red' } },
        { id: 'c1', metadataId: 'capacitor', properties: { value: '100n' } },
      ],
      [
        w('w1', ['uno', '13'], ['r1', '1']),
        w('w2', ['r1', '2'], ['led1', 'A']),
        w('w3', ['led1', 'C'], ['uno', 'GND.1']),
        w('w4', ['c1', '1'], ['uno', '5V']),
        w('w5', ['c1', '2'], ['uno', 'GND.2']),
      ],
      { '13': { type: 'digital', v: 5 } },
    );
    await service.tick();
    await drive('13', false, 1000);
    await drive('13', true, 2000);
    expect(service.stepSolveCount).toBe(0);
    expect(published.at(-1)!.stepWaveforms).toBeUndefined();
  });
});

describe('an ADC the bridge does not hook follows a step as a scalar', () => {
  it('ESP32: the curve at the guest time since the edge, then the operating point, never a looping waveform push', async () => {
    vi.useFakeTimers();
    const { useSimulatorStore, getBoardSimulator } = await import('../store/useSimulatorStore');
    const { useElectricalStore } = await import('../store/useElectricalStore');
    const { connectAnalogInputsToMcu } = await import('../simulation/spice/connectAnalogInputsToMcu');
    const id = useSimulatorStore.getState().addBoard('esp32' as never, 0, 0);
    let unsub: (() => void) | null = null;
    try {
      const sim = getBoardSimulator(id) as unknown as Record<string, unknown>;
      const fed: Array<[number, number]> = [];
      const pushed: number[] = [];
      let guestUs = 1_000_000;
      sim.setAdcVoltage = (pin: number, v: number) => {
        fed.push([pin, v]);
        return true;
      };
      sim.setAdcWaveform = (_pin: number, samples: Uint16Array) => {
        pushed.push(samples.length);
        return true;
      };
      sim.getGuestMicros = () => guestUs;
      unsub = connectAnalogInputsToMcu();
      const capture: TimeWaveforms = {
        time: [0, 0.5, 1, 2],
        nodes: new Map([['n0', [0, 1, 2, 3]]]),
        branches: new Map(),
        oneShot: { wallMs: 0, guestMs: { [id]: 1000 } },
      };
      guestUs = 1_500_000; // 0.5 s after the edge
      useElectricalStore.setState({
        pinNetMap: new Map([[`${id}:34`, 'n0']]),
        // The operating point the step settles to: past the capture's end,
        // which here stops short of it, this is what the pad reads.
        nodeVoltages: { n0: 3.2 },
        sourcedNets: new Set(['n0']),
        stepWaveforms: capture,
      } as never);
      expect(fed.at(-1)).toEqual([34, 1]);
      guestUs = 2_000_000; // 1 s
      vi.advanceTimersByTime(20);
      expect(fed.at(-1)).toEqual([34, 2]);
      guestUs = 3_500_000; // past the end: the operating point, then the feed stops
      vi.advanceTimersByTime(20);
      expect(fed.at(-1)).toEqual([34, 3.2]);
      const n = fed.length;
      vi.advanceTimersByTime(100);
      expect(fed.length).toBe(n);
      expect(pushed.filter((len) => len > 0)).toEqual([]);
    } finally {
      unsub?.();
      useSimulatorStore.getState().removeBoard?.(id);
      useElectricalStore.getState().reset();
      vi.useRealTimers();
    }
  });
});
