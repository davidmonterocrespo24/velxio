/**
 * Several PWM LEDs at different duties each glow at their own duty
 * (velxio/velxio-prod#233).
 *
 * A static PWM pad is published as the HIGH and LOW states it alternates
 * between, weighted by its duty (#152). With k such pads at distinct duties
 * the state the pads hold splits into k + 1 states (phase-aligned channels:
 * every pad HIGH from the start of the period until its duty). The window
 * solved at most four states it had not cached, so with four or more pads the
 * last split state was left out and the weights renormalised over the rest:
 * four LEDs at 20/40/60/80 % glowed at 25/50/75/100 % of their on-level, and
 * stayed so while nothing else published.
 *
 * The real service on ngspice, the real store port and the real LED part.
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

/** One LED per pin: pin -> 220 ohm -> red LED -> GND, as the fade examples wire it. */
function ledsOn(pins: string[]): { components: Comp[]; wires: Wire[] } {
  const components: Comp[] = [];
  const wires: Wire[] = [];
  for (const pin of pins) {
    components.push({ id: `r${pin}`, metadataId: 'resistor', properties: { value: '220' } });
    components.push({ id: `led${pin}`, metadataId: 'led', properties: { color: 'red' } });
    wires.push(w(`wa${pin}`, ['arduino-uno', pin], [`r${pin}`, '1']));
    wires.push(w(`wb${pin}`, [`r${pin}`, '2'], [`led${pin}`, 'A']));
    wires.push(w(`wc${pin}`, [`led${pin}`, 'C'], ['arduino-uno', 'GND.1']));
  }
  return { components, wires };
}

const services: CircuitSimulationService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  __resetMixedModeScheduler();
  useElectricalStore.getState().reset();
  vi.unstubAllGlobals();
});

function service(canvas: { components: Comp[]; wires: Wire[] }, pins: () => Record<string, PinSourceState>) {
  __setSchedulerSolverFactoryForTests(() => new NgSpiceNodeAdapter());
  const published: ElectricalSnapshot[] = [];
  const storePort = createElectricalStorePort();
  const simStore: SimulatorStorePort = {
    getState: () => ({ ...canvas, boards: [{ id: 'arduino-uno', boardKind: 'arduino-uno', running: true }] }),
    subscribe: () => () => {},
  };
  const svc = new CircuitSimulationService(
    simStore,
    { publish: (s) => { published.push(s); storePort.publish(s); } },
    getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
    { collectBoardPinStates: pins },
  );
  services.push(svc);
  return { svc, published };
}

/** The LED part as the canvas attaches it, reading the electrical store. */
function attachLed(componentId: string, pin: number) {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const el = { addEventListener: () => {}, removeEventListener: () => {}, value: false, brightness: 0 } as unknown as HTMLElement & { value: boolean; brightness: number };
  const pinManager = { onPinChange: () => () => {}, onPwmChange: () => () => {}, getPwmValue: () => 0 };
  const pins: Record<string, number> = { A: pin, C: -1 };
  PartSimulationRegistry.get('led')!.attachEvents!(el, { pinManager } as never, (n: string) => pins[n] ?? null, componentId);
  return el;
}

/** Each LED's on-current (the most it carries in any state) and its window mean. */
function perLed(snap: ElectricalSnapshot, pins: string[]) {
  const states = snap.window?.states ?? [];
  return pins.map((pin) => {
    const key = `v_led${pin}_sense`;
    const onA = Math.max(...states.map((s) => Math.abs(s.branchCurrents[key] ?? 0)));
    const meanA = states.reduce((a, s) => a + s.weight * Math.abs(s.branchCurrents[key] ?? 0), 0);
    return { pin, onA, meanA };
  });
}

describe('every PWM LED glows at its own duty, however many there are (#233)', () => {
  const cases: Array<{ name: string; duties: Record<string, number> }> = [
    { name: 'four LEDs at 20 / 40 / 60 / 80 %', duties: { '3': 0.2, '5': 0.4, '6': 0.6, '9': 0.8 } },
    { name: 'five LEDs at 10 / 30 / 50 / 70 / 90 %', duties: { '3': 0.1, '5': 0.3, '6': 0.5, '9': 0.7, '10': 0.9 } },
    { name: 'six LEDs, two at the same duty', duties: { '3': 0.15, '5': 0.35, '6': 0.35, '9': 0.55, '10': 0.75, '11': 0.95 } },
  ];

  for (const { name, duties } of cases) {
    it(`${name}: each mean current is its duty times its on-current, and so is each brightness`, { timeout: 60_000 }, async () => {
      const pins = Object.keys(duties);
      const { svc, published } = service(ledsOn(pins), () =>
        Object.fromEntries(pins.map((p) => [p, { type: 'pwm', duty: duties[p]! } as PinSourceState])),
      );
      const els = Object.fromEntries(pins.map((p) => [p, attachLed(`led${p}`, Number(p))]));
      await svc.tick();
      const snap = published.at(-1)!;
      for (const { pin, onA, meanA } of perLed(snap, pins)) {
        // Red LED + 220 ohm from 5 V: about 14 mA while its pin is HIGH.
        expect(onA, `pin ${pin}`).toBeGreaterThan(0.012);
        expect(els[pin]!.brightness, `pin ${pin}: brightness`).toBeCloseTo((duties[pin]! * onA) / 0.02, 4);
        expect(meanA / onA, `pin ${pin}: share of the period lit`).toBeCloseTo(duties[pin]!, 4);
      }
      // Every share of the period the pads go through is in the window.
      const distinct = new Set(Object.values(duties)).size;
      expect(snap.window?.states.filter((s) => s.weight > 0).length).toBe(distinct + 1);
      const total = snap.window!.states.reduce((a, s) => a + s.weight, 0);
      expect(total).toBeCloseTo(1, 9);
    });
  }

  it('a pin edge beside four PWM LEDs: every publish that follows keeps their exact duties', { timeout: 60_000 }, async () => {
    const duties: Record<string, number> = { '3': 0.2, '5': 0.4, '6': 0.6, '9': 0.8 };
    const pwmPins = Object.keys(duties);
    const canvas = ledsOn([...pwmPins, '13']);
    const { svc, published } = service(canvas, () => ({
      ...Object.fromEntries(pwmPins.map((p) => [p, { type: 'pwm', duty: duties[p]! } as PinSourceState])),
      '13': { type: 'digital', v: 0 },
    }));
    await svc.tick();
    // Pin 13 goes HIGH: a state none of whose PWM splits is cached yet. The
    // answer to the edge and the windows after it each hold the split of the
    // state the pads are in; the PWM LEDs keep their duties throughout.
    const from = published.length;
    await svc.handleMcuEdge('arduino-uno', '13', true, 5);
    await new Promise((r) => setTimeout(r, 120));
    await (svc as unknown as { chain: Promise<void> }).chain;
    const after = published.slice(from);
    expect(after.length).toBeGreaterThan(0);
    for (const [n, snap] of after.entries()) {
      for (const { pin, onA, meanA } of perLed(snap, pwmPins)) {
        expect(meanA / onA, `publish ${n}, pin ${pin}`).toBeCloseTo(duties[pin]!, 4);
      }
    }
  });
});
