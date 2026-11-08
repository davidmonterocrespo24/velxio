/**
 * A transient capture the circuit service publishes belongs to the state it
 * publishes (velxio/velxio-prod#153).
 *
 * A circuit with a capacitor or an inductor and a driven board pin is solved
 * as a transient when its deck is built, and every later pin edge as an
 * operating point. The service used to republish the deck's capture after
 * each of those operating points, so the readers that prefer a capture over
 * the scalar values (the LED part, the AVR and RP2040 ADC hooks, the ESP32
 * waveform push, the meters) kept reading the circuit as it was when the deck
 * was built: a Blink with a 100 nF across 5V/GND kept its LED lit after the
 * LOW edge, at the 14 mA of the HIGH state.
 *
 * Runs the real service, scheduler and ngspice (the Node adapter).
 */
import { describe, it, expect, afterEach } from 'vitest';
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
import type { PinSourceState } from '../simulation/spice/types';

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

/** A service on the real engine over a fixed canvas whose pin 13 the test drives. */
function setup(components: Array<{ id: string; metadataId: string; properties: Record<string, unknown> }>, wires: Wire[]) {
  __setSchedulerSolverFactoryForTests(() => new NgSpiceNodeAdapter());
  let pins: Record<string, PinSourceState> = { '13': { type: 'digital', v: 5 } };
  const published: ElectricalSnapshot[] = [];
  const simStore: SimulatorStorePort = {
    getState: () => ({ components, wires, boards: [{ id: 'arduino-uno', boardKind: 'arduino-uno', running: true }] }),
    subscribe: () => () => {},
  };
  const service = new CircuitSimulationService(
    simStore,
    { publish: (s) => published.push(s) },
    getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
    { collectBoardPinStates: () => pins },
  );
  services.push(service);
  const drive13 = async (high: boolean) => {
    pins = { '13': { type: 'digital', v: high ? 5 : 0 } };
    await service.handleMcuEdge('arduino-uno', '13', high, 5, null);
    await sleep(150); // the window after the edge closes and publishes
  };
  return { service, published, drive13 };
}

/** The current an LED part derives from a snapshot: the capture's mean |I| when
 *  one is published (BasicParts.ts), else the scalar branch current. */
function ledCurrent(s: ElectricalSnapshot, key: string): number {
  const samples = s.timeWaveforms?.branches.get(key);
  if (samples && samples.length > 0) return samples.reduce((a, x) => a + Math.abs(x), 0) / samples.length;
  return Math.abs(s.branchCurrents[key] ?? 0);
}

/** A capture describes the published state when it ends where the state is. */
function captureMatchesState(s: ElectricalSnapshot): boolean {
  if (!s.timeWaveforms) return true;
  for (const [net, v] of Object.entries(s.nodeVoltages)) {
    const samples = s.timeWaveforms.nodes.get(net);
    if (!samples || samples.length === 0) continue;
    if (Math.abs(samples[samples.length - 1]! - v) > 1e-6) return false;
  }
  return true;
}

describe('a published capture belongs to the published state (velxio/velxio-prod#153)', () => {
  it('a Blink with an unrelated capacitor: the LED follows the pin, not the deck', { timeout: 60_000 }, async () => {
    const { service, published, drive13 } = setup(
      [
        { id: 'r1', metadataId: 'resistor', properties: { value: '220' } },
        { id: 'led1', metadataId: 'led', properties: { color: 'red' } },
        { id: 'c1', metadataId: 'capacitor', properties: { value: '100n' } },
      ],
      [
        w('w1', ['arduino-uno', '13'], ['r1', '1']),
        w('w2', ['r1', '2'], ['led1', 'A']),
        w('w3', ['led1', 'C'], ['arduino-uno', 'GND.1']),
        w('w4', ['c1', '1'], ['arduino-uno', '5V']),
        w('w5', ['c1', '2'], ['arduino-uno', 'GND.2']),
      ],
    );
    await service.tick(); // the deck: pin 13 HIGH, solved as a transient
    const built = published.at(-1)!;
    expect(built.analysisMode).toBe('tran');
    expect(ledCurrent(built, 'v_led1_sense')).toBeGreaterThan(0.01);

    await drive13(false);
    const low = published.at(-1)!;
    expect(ledCurrent(low, 'v_led1_sense')).toBeLessThan(1e-6);
    expect(published.every(captureMatchesState)).toBe(true);
    // The oscilloscope still has a trace to draw between its own recaptures.
    expect(low.scopeWaveforms?.time.length ?? 0).toBeGreaterThan(1);

    await drive13(true);
    expect(ledCurrent(published.at(-1)!, 'v_led1_sense')).toBeGreaterThan(0.01);
    expect(published.every(captureMatchesState)).toBe(true);
  });

  it('the oscilloscope draws the deck capture the readers no longer get', async () => {
    const { useElectricalStore } = await import('../store/useElectricalStore');
    const { useOscilloscopeStore } = await import('../store/useOscilloscopeStore');
    const { startAnalogScopeFeed, stopAnalogScopeFeed } = await import('../simulation/spice/analogScopeFeed');
    useOscilloscopeStore.setState({ open: true, running: true });
    const id = useOscilloscopeStore.getState().addNetChannel('n1', 'n1');
    startAnalogScopeFeed();
    try {
      const capture = { time: [0, 1e-3, 2e-3], nodes: new Map([['n1', [0, 2.5, 5]]]), branches: new Map() };
      useElectricalStore.getState().setSolveResult({
        nodeVoltages: { n1: 0 },
        branchCurrents: {},
        pinNetMap: new Map(),
        analysisMode: 'tran',
        timeWaveforms: undefined, // a pad edge, solved as an operating point
        scopeWaveforms: capture,
        converged: true,
        error: null,
        lastSolveMs: 0,
        submittedNetlist: '',
        sourcedNets: new Set(),
      });
      expect(useOscilloscopeStore.getState().samples[id]?.map((s) => s.volts)).toEqual([0, 2.5, 5]);
    } finally {
      stopAnalogScopeFeed();
      useElectricalStore.getState().reset();
    }
  });

  it('a circuit with a signal generator keeps its waveform after a pin edge, for the new state', { timeout: 60_000 }, async () => {
    const { service, published, drive13 } = setup(
      [
        // 1 kHz sine, 1 V peak on 2.5 V, into A0 through a 1k/1k divider.
        { id: 'sg1', metadataId: 'signal-generator', properties: { waveform: 'sine', frequency: 1000, amplitude: 1, offset: 2.5 } },
        { id: 'ra', metadataId: 'resistor', properties: { value: '1000' } },
        { id: 'rb', metadataId: 'resistor', properties: { value: '1000' } },
        // An LED on pin 13 that the sketch blinks.
        { id: 'r1', metadataId: 'resistor', properties: { value: '220' } },
        { id: 'led1', metadataId: 'led', properties: { color: 'red' } },
      ],
      [
        w('w1', ['sg1', 'SIG'], ['ra', '1']),
        w('w2', ['ra', '2'], ['rb', '1']),
        w('w3', ['rb', '2'], ['arduino-uno', 'GND.1']),
        w('w4', ['sg1', 'GND'], ['arduino-uno', 'GND.2']),
        w('w5', ['ra', '2'], ['arduino-uno', 'A0']),
        w('w6', ['arduino-uno', '13'], ['r1', '1']),
        w('w7', ['r1', '2'], ['led1', 'A']),
        w('w8', ['led1', 'C'], ['arduino-uno', 'GND.3']),
      ],
    );
    await service.tick();
    expect(published.at(-1)!.analysisMode).toBe('tran');

    await drive13(false);
    const low = published.at(-1)!;
    // The LED is off in the state published ...
    expect(ledCurrent(low, 'v_led1_sense')).toBeLessThan(1e-6);
    // ... and A0 still swings: 0.5 V peak around 1.25 V, from a capture of this state.
    const a0 = low.timeWaveforms?.nodes.get(low.pinNetMap.get('arduino-uno:A0')!) ?? [];
    expect(a0.length).toBeGreaterThan(10);
    expect(Math.max(...a0) - Math.min(...a0)).toBeGreaterThan(0.9);
    expect(published.every(captureMatchesState)).toBe(true);
  });
});
