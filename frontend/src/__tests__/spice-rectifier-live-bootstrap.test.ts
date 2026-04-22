/**
 * Half-Wave Rectifier — wireElectricalSolver live bootstrap.
 *
 * Extracted from `spice-rectifier-live-repro.test.ts` so this describe runs
 * in its own Vitest worker. The ngspice-WASM engine is a singleton that
 * holds global heap state; when L1/L3 solves run before this test in the
 * same process, realloc explodes with "Not enough memory or heap corruption"
 * and the electrical store falls back to `op` analysis. Isolating the live
 * bootstrap into its own file gives it a pristine WASM instance.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function rectifierSnapshot() {
  return {
    components: [
      {
        id: 'sg1',
        metadataId: 'signal-generator',
        properties: { waveform: 'sine', frequency: 50, amplitude: 5, offset: 0 },
      },
      { id: 'd1', metadataId: 'diode-1n4007', properties: {} },
      { id: 'rl', metadataId: 'resistor', properties: { value: '1000' } },
    ],
    wires: [
      {
        id: 'w1',
        start: { componentId: 'sg1', pinName: 'SIG' },
        end: { componentId: 'd1', pinName: 'A' },
      },
      {
        id: 'w2',
        start: { componentId: 'd1', pinName: 'C' },
        end: { componentId: 'rl', pinName: '1' },
      },
      {
        id: 'w3',
        start: { componentId: 'rl', pinName: '2' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
      },
      {
        id: 'w4',
        start: { componentId: 'sg1', pinName: 'GND' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
      },
      {
        id: 'w5',
        start: { componentId: 'd1', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'A0' },
      },
    ],
    boards: [
      {
        id: 'arduino-uno',
        boardKind: 'arduino-uno' as const,
        pinStates: {},
      },
    ],
  };
}

describe('Half-Wave Rectifier — wireElectricalSolver live bootstrap', () => {
  let rafCallbacks: Array<() => void>;

  beforeEach(() => {
    rafCallbacks = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('window', globalThis);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function flushRaf() {
    while (rafCallbacks.length > 0) {
      const cbs = rafCallbacks.splice(0, rafCallbacks.length);
      for (const cb of cbs) {
        try {
          cb();
        } catch (e) {
          console.warn('RAF cb threw', e);
        }
      }
      break;
    }
  }

  it('invokes wireElectricalSolver against live stores populated by loadExample', async () => {
    const { useSimulatorStore } = await import('../store/useSimulatorStore');
    const { useElectricalStore } = await import('../store/useElectricalStore');
    const { wireElectricalSolver } = await import('../simulation/spice/subscribeToStore');

    const snap = rectifierSnapshot();
    const store = useSimulatorStore.getState();

    store.setComponents(
      snap.components.map((c) => ({
        id: c.id,
        metadataId: c.metadataId,
        x: 0,
        y: 0,
        properties: c.properties,
      })),
    );
    store.setWires(
      snap.wires.map((w) => ({
        id: w.id,
        start: { componentId: w.start.componentId, pinName: w.start.pinName, x: 0, y: 0 },
        end: { componentId: w.end.componentId, pinName: w.end.pinName, x: 0, y: 0 },
        color: '#ffaa00',
        waypoints: [],
      })),
    );

    const unsub = wireElectricalSolver();

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const es = useElectricalStore.getState();
      if (es.timeWaveforms) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const finalES = useElectricalStore.getState();

    const sim = (await import('../store/useSimulatorStore')).getBoardSimulator('arduino-uno');
    if (sim) {
      for (let i = 0; i < 10; i++) await flushRaf();
    }

    unsub();

    expect(finalES.converged).toBe(true);
    expect(finalES.analysisMode).toBe('tran');
    expect(finalES.timeWaveforms).toBeDefined();
    expect(finalES.pinNetMap.size).toBeGreaterThan(0);
    expect(finalES.pinNetMap.has('arduino-uno:A0')).toBe(true);
  }, 45_000);
});
