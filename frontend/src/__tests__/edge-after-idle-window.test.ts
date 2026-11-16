/**
 * The first pin edge after an idle period opens a window that starts at the
 * edge (velxio/velxio-prod#152, the regression of its first fix).
 *
 * The service publishes a pad edge twice: at once, as the state the pads now
 * hold, and 33 ms later as the window of states the pads went through, which
 * the LED part and the meters average. Since the store port forwards that
 * window (d9db29a0), the window of the first edge after idle ran from the
 * last close, often a second earlier, so it was almost all the state before
 * the edge: on every Blink toggle the LED showed the new level, fell back to
 * nearly the old one for a window, then took the new level again (0.719 ->
 * 0.067 -> 0.719 at the HIGH edge). The canvas had already shown that old
 * state for the whole idle period; it belongs to no window.
 *
 * Checked end to end: real ngspice, the real store port, the real LED part.
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
import { useElectricalStore } from '../store/useElectricalStore';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/BasicParts';
import type { PinSourceState } from '../simulation/spice/types';

type Comp = { id: string; metadataId: string; properties: Record<string, unknown> };
type Wire = { id: string; start: { componentId: string; pinName: string }; end: { componentId: string; pinName: string } };
const w = (id: string, a: [string, string], b: [string, string]): Wire => ({
  id,
  start: { componentId: a[0], pinName: a[1] },
  end: { componentId: b[0], pinName: b[1] },
});

/** Blink: pin 13 -> 220 ohm -> red LED -> GND. */
const BLINK: { components: Comp[]; wires: Wire[] } = {
  components: [
    { id: 'r1', metadataId: 'resistor', properties: { value: '220' } },
    { id: 'led1', metadataId: 'led', properties: { color: 'red' } },
  ],
  wires: [
    w('w1', ['arduino-uno', '13'], ['r1', '1']),
    w('w2', ['r1', '2'], ['led1', 'A']),
    w('w3', ['led1', 'C'], ['arduino-uno', 'GND.1']),
  ],
};

const services: CircuitSimulationService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  __resetMixedModeScheduler();
  useElectricalStore.getState().reset();
  vi.unstubAllGlobals();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The LED part as the canvas attaches it, reading the electrical store. */
function attachLed(componentId: string) {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const el = { addEventListener: () => {}, removeEventListener: () => {}, value: false, brightness: 0 } as unknown as HTMLElement & {
    value: boolean;
    brightness: number;
  };
  const pinManager = { onPinChange: () => () => {}, onPwmChange: () => () => {}, getPwmValue: () => 0 };
  const pins: Record<string, number> = { A: 13, C: -1 };
  PartSimulationRegistry.get('led')!.attachEvents!(el, { pinManager } as never, (n: string) => pins[n] ?? null, componentId);
  return el;
}

/** Blink on the real solver: every publish, with the LED's brightness right after it. */
function blink() {
  __setSchedulerSolverFactoryForTests(() => new NgSpiceNodeAdapter());
  const level = { v: 5 };
  const storePort = createElectricalStorePort();
  const el = attachLed('led1');
  const published: Array<{ snap: ElectricalSnapshot; brightness: number }> = [];
  const simStore: SimulatorStorePort = {
    getState: () => ({ ...BLINK, boards: [{ id: 'arduino-uno', boardKind: 'arduino-uno', running: true }] }),
    subscribe: () => () => {},
  };
  const svc = new CircuitSimulationService(
    simStore,
    {
      publish: (snap) => {
        storePort.publish(snap);
        // The LED part updates synchronously from its store subscription.
        published.push({ snap, brightness: el.brightness });
      },
    },
    getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
    { collectBoardPinStates: (): Record<string, PinSourceState> => ({ '13': { type: 'digital', v: level.v } }) },
  );
  services.push(svc);
  /** Wait until no window is open and no solver work is queued. */
  const settle = async () => {
    for (let i = 0; i < 300; i++) {
      const d = svc.debugState();
      if (!d.windowOpen && !d.busy && !d.streaming) return;
      await sleep(10);
    }
    throw new Error('the service never went idle');
  };
  /** Pin 13 to `high`, as connectMcuEdgesToService reports it. */
  const edge = async (high: boolean) => {
    level.v = high ? 5 : 0;
    await svc.handleMcuEdge('arduino-uno', '13', high, 5, null);
  };
  return { svc, el, published, settle, edge };
}

describe('the first edge after idle opens its window at the edge (velxio/velxio-prod#152)', () => {
  it('Blink: the LED goes straight from its old level to the new one, with no fall back', { timeout: 60_000 }, async () => {
    const { svc, el, published, settle, edge } = blink();
    await svc.tick();
    await settle();
    const on = el.brightness;
    // Red LED, 220 ohm from 5 V: about 14 mA, 0.72 of the LED's 20 mA.
    expect(on).toBeGreaterThan(0.6);
    expect(on).toBeLessThan(0.8);

    for (const [high, from, to] of [
      [false, on, 0],
      [true, 0, on],
    ] as const) {
      // Idle: the board holds the pin, as Blink does inside delay(1000).
      await sleep(400);
      const mark = published.length;
      await edge(high);
      await settle();
      const levels = published.slice(mark).map((p) => p.brightness);
      expect(levels.length, 'the edge was published').toBeGreaterThan(0);
      // Each publish moves toward the new level and never back toward the old.
      let last = from;
      for (const b of levels) {
        expect(Math.abs(b - to), `brightness ${levels.map((x) => x.toFixed(3)).join(' -> ')} after the ${high ? 'HIGH' : 'LOW'} edge`).toBeLessThanOrEqual(
          Math.abs(last - to) + 1e-9,
        );
        last = b;
      }
      expect(levels.at(-1)!).toBeCloseTo(to, 3);
    }
  });

  it('a window published after an idle edge holds no time of the state before the edge', { timeout: 60_000 }, async () => {
    const { svc, published, settle, edge } = blink();
    await svc.tick();
    await settle();
    await sleep(400);
    const mark = published.length;
    await edge(false);
    await settle();
    for (const { snap } of published.slice(mark)) {
      for (const st of snap.window?.states ?? []) {
        if (st.ms > 0) expect(st.levels['v_arduino_uno_13'], `a window state of ${st.ms.toFixed(1)} ms`).toBe(0);
      }
      // The window is the time since the edge, not since the last publish.
      if (snap.window) expect(snap.window.ms).toBeLessThan(200);
    }
  });
});
