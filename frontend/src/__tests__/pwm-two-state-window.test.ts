/**
 * A PWM pad driving a static load is the two states it alternates between,
 * weighted by its duty, not one source at its mean voltage
 * (velxio/velxio-prod#152).
 *
 * The netlist stamps a hardware-PWM pin as `V_<board>_<pin> net 0 DC duty*vcc`.
 * For a resistor that is the right average; for an LED it is not: the diode's
 * current is exponential in its voltage, so the current at the mean voltage
 * collapses (the Shockley equation), while a real LED under PWM carries its
 * full on-current for the duty and nothing for the rest, and its average
 * current is the duty times that (TI SLVAFQ9, section 2.2, PWM dimming). On
 * the gallery's fade-led (blue LED, 220 ohm, pin 9) analogWrite(100) gave
 * 4.9 pA instead of 3.4 mA and the LED stayed dark for 60 % of the ramp.
 *
 * The service already publishes a time-weighted window of pad states for
 * software PWM and scans, and the LED part and the meters already integrate
 * it, but the store port in start.ts never forwarded it. Both halves are
 * checked here, end to end: the real service on ngspice, the real store port,
 * the real LED part.
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
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
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

/** The gallery's fade-led: pin 9 -> 220 ohm -> blue LED -> GND. */
const FADE_LED: { components: Comp[]; wires: Wire[] } = {
  components: [
    { id: 'r1', metadataId: 'resistor', properties: { value: '220' } },
    { id: 'led1', metadataId: 'led', properties: { color: 'blue' } },
  ],
  wires: [
    w('w1', ['arduino-uno', '9'], ['r1', '1']),
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
function attachLed(componentId: string) {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const el = { addEventListener: () => {}, removeEventListener: () => {}, value: false, brightness: 0 } as unknown as HTMLElement & { value: boolean; brightness: number };
  const pinManager = { onPinChange: () => () => {}, onPwmChange: () => () => {}, getPwmValue: () => 0 };
  const pins: Record<string, number> = { A: 9, C: -1 };
  PartSimulationRegistry.get('led')!.attachEvents!(el, { pinManager } as never, (n: string) => pins[n] ?? null, componentId);
  return el;
}

describe('a PWM pad on a static load is its two states (velxio/velxio-prod#152)', () => {
  it('the store keeps the window and the deck sources the service publishes', () => {
    const port = createElectricalStorePort();
    port.publish({
      nodeVoltages: { n1: 1 },
      branchCurrents: {},
      window: { ms: 33, states: [] },
      pinNetMap: new Map(),
      analysisMode: 'op',
      warnings: [],
      sourcedNets: new Set(),
      voltageSources: ['v_uno_9'],
    });
    expect(useElectricalStore.getState().window).toEqual({ ms: 33, states: [] });
    expect(useElectricalStore.getState().voltageSources).toEqual(['v_uno_9']);
  });

  it('fade-led: the LED glows at the duty times its on-current, from the lowest duties up', { timeout: 60_000 }, async () => {
    let duty = 100 / 255;
    const { svc, published } = service(FADE_LED, () => ({ '9': { type: 'pwm', duty } }));
    const el = attachLed('led1');
    const rows: Array<{ duty: number; meanA: number; brightness: number; onA: number }> = [];
    for (const ocr of [100, 150, 200]) {
      duty = ocr / 255;
      await svc.tick();
      const snap = published.at(-1)!;
      const states = snap.window?.states ?? [];
      const onA = Math.max(...states.map((s) => Math.abs(s.branchCurrents['v_led1_sense'] ?? 0)));
      const meanA = states.reduce((a, s) => a + s.weight * Math.abs(s.branchCurrents['v_led1_sense'] ?? 0), 0);
      rows.push({ duty, meanA, brightness: el.brightness, onA });
    }
    for (const r of rows) {
      // Blue LED + 220 ohm from 5 V: about 8.7 mA while the pin is HIGH.
      expect(r.onA).toBeGreaterThan(0.008);
      expect(r.onA).toBeLessThan(0.0095);
      // The average current is the duty times the on-current (3.4 / 5.1 / 6.8 mA) ...
      expect(r.meanA).toBeCloseTo(r.duty * r.onA, 6);
      // ... and the LED part shows what its window says: duty x I_on / 20 mA.
      expect(r.brightness).toBeCloseTo((r.duty * r.onA) / 0.02, 3);
    }
    expect(rows[0]!.meanA).toBeGreaterThan(0.003); // analogWrite(100): 3.4 mA, not picoamps
  });

  it('a new duty reuses the HIGH and LOW solves it already has', { timeout: 60_000 }, async () => {
    let duty = 0.25;
    const { svc } = service(FADE_LED, () => ({ '9': { type: 'pwm', duty } }));
    await svc.tick();
    const solvedOnce = svc.stateSolveCount;
    duty = 0.5;
    await svc.tick();
    duty = 0.75;
    await svc.tick();
    expect(svc.stateSolveCount).toBe(solvedOnce);
  });

  it('a PWM pad behind an RC filter stays at its mean: the capacitor sees the average', { timeout: 60_000 }, async () => {
    const { svc, published } = service(
      {
        components: [
          { id: 'r1', metadataId: 'resistor', properties: { value: '10000' } },
          { id: 'c1', metadataId: 'capacitor', properties: { value: '10u' } },
        ],
        wires: [
          w('w1', ['arduino-uno', '9'], ['r1', '1']),
          w('w2', ['r1', '2'], ['c1', '1']),
          w('w3', ['c1', '2'], ['arduino-uno', 'GND.1']),
          w('w4', ['r1', '2'], ['arduino-uno', 'A0']),
        ],
      },
      () => ({ '9': { type: 'pwm', duty: 0.5 } }),
    );
    await svc.tick();
    const snap = published.at(-1)!;
    expect(snap.window).toBeUndefined();
    expect(snap.nodeVoltages[snap.pinNetMap.get('arduino-uno:A0')!]).toBeCloseTo(2.5, 2);
  });
});

describe('which board pads drive a static load (NetlistBuilder.staticPads)', () => {
  const padsOf = (components: Comp[], wires: Wire[]) =>
    buildNetlist(
      buildInputFromStore({
        components,
        // The netlist reads a wire's id and ends only (see verifyFromStore).
        wires: wires as unknown as Parameters<typeof buildInputFromStore>[0]['wires'],
        boards: [{ id: 'arduino-uno', boardKind: 'arduino-uno', pinStates: { '9': { type: 'pwm', duty: 0.5 } } }],
      }),
    ).staticPads;

  it('an LED and its resistor are static', () => {
    expect(padsOf(FADE_LED.components, FADE_LED.wires).has('v_arduino_uno_9')).toBe(true);
  });

  it('a capacitor on the pad network is not', () => {
    const pads = padsOf(
      [
        { id: 'r1', metadataId: 'resistor', properties: { value: '10000' } },
        { id: 'c1', metadataId: 'capacitor', properties: { value: '10u' } },
      ],
      [w('w1', ['arduino-uno', '9'], ['r1', '1']), w('w2', ['r1', '2'], ['c1', '1']), w('w3', ['c1', '2'], ['arduino-uno', 'GND.1'])],
    );
    expect(pads.has('v_arduino_uno_9')).toBe(false);
  });

  it('a decoupling capacitor across the supply does not make the LED pad reactive', () => {
    const pads = padsOf(
      [...FADE_LED.components, { id: 'c1', metadataId: 'capacitor', properties: { value: '100n' } }],
      [...FADE_LED.wires, w('w4', ['c1', '1'], ['arduino-uno', '5V']), w('w5', ['c1', '2'], ['arduino-uno', 'GND.2'])],
    );
    expect(pads.has('v_arduino_uno_9')).toBe(true);
  });

  it('a transistor switching an LED is static through the transistor', () => {
    const pads = padsOf(
      [
        { id: 'rb', metadataId: 'resistor', properties: { value: '1000' } },
        { id: 'rc', metadataId: 'resistor', properties: { value: '220' } },
        { id: 'led1', metadataId: 'led', properties: { color: 'green' } },
        { id: 'q1', metadataId: 'bjt-2n2222', properties: {} },
      ],
      [
        w('w1', ['arduino-uno', '9'], ['rb', '1']),
        w('w2', ['rb', '2'], ['q1', 'B']),
        w('w3', ['arduino-uno', '5V'], ['rc', '1']),
        w('w4', ['rc', '2'], ['led1', 'A']),
        w('w5', ['led1', 'C'], ['q1', 'C']),
        w('w6', ['q1', 'E'], ['arduino-uno', 'GND.1']),
      ],
    );
    expect(pads.has('v_arduino_uno_9')).toBe(true);
  });
});
