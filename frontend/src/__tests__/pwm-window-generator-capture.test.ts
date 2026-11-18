/**
 * A signal generator keeps its waveform while a PWM pad drives a static load
 * elsewhere on the canvas (velxio/velxio-prod#232).
 *
 * Since #152 a static PWM pad is published as its HIGH and LOW states weighted
 * by the duty. The state the deck holds the pad in, its mean, is never the
 * circuit's, so its transient capture was not published, and nothing was in
 * its place: with fade-led's LED on pin 9 at 50 %, a 1 kHz sine on A0 reached
 * the ADC replay, the meters and the oscilloscope as its DC level, 1.25 V.
 *
 * The capture published now is that of the state the pads hold: each split
 * state's own transient, weighted by its share of the PWM period. The
 * generator's net is the same sine in every split state; a net the PWM pad
 * moves reads its average over the period, as the window gives it. Each
 * window state carries its own capture too, and an LED reads its current in
 * every state from it: a PWM LED keeps the brightness and the burnout check
 * of #152 beside a generator (the mix's mean current would brighten an LED
 * driven past its rating, and hide the peak that burns it).
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
import { readSpan, spanStats, mixCaptures } from '../simulation/spice/waveformStats';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/BasicParts';
import type { PinSourceState, TimeWaveforms } from '../simulation/spice/types';

type Comp = { id: string; metadataId: string; properties: Record<string, unknown> };
type Wire = { id: string; start: { componentId: string; pinName: string }; end: { componentId: string; pinName: string } };
const w = (id: string, a: [string, string], b: [string, string]): Wire => ({
  id,
  start: { componentId: a[0], pinName: a[1] },
  end: { componentId: b[0], pinName: b[1] },
});

/** The issue's probe: a 1 kHz sine (1 V amplitude, 1.25 V offset) on A0, and
 *  fade-led's LED on pin 9 (220 ohm, blue). */
const GENERATOR_AND_PWM_LED: { components: Comp[]; wires: Wire[] } = {
  components: [
    { id: 'gen', metadataId: 'signal-generator', properties: { waveform: 'sine', frequency: '1000', amplitude: '1', offset: '1.25' } },
    { id: 'r1', metadataId: 'resistor', properties: { value: '220' } },
    { id: 'led1', metadataId: 'led', properties: { color: 'blue' } },
  ],
  wires: [
    w('g1', ['gen', 'SIG'], ['arduino-uno', 'A0']),
    w('g2', ['gen', 'GND'], ['arduino-uno', 'GND.2']),
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
  useSimulatorStore.getState().clearBurntComponents();
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

/** Min, max and mean of a net over the capture's whole periods. */
function netStats(tw: TimeWaveforms, net: string) {
  const samples = tw.nodes.get(net);
  if (!samples) throw new Error(`no samples for ${net}`);
  const span = readSpan(tw.time, tw.period);
  const s = spanStats(tw.time, samples, span!)!;
  return { min: s.min, max: s.max, mean: s.mean };
}

describe('a generator keeps its capture beside a PWM pad on a static load (#232)', () => {
  it('pin 9 at 50 %: the sine on A0 is published, to the store the ADC replay and the meters read', { timeout: 60_000 }, async () => {
    const { svc, published } = service(GENERATOR_AND_PWM_LED, () => ({ '9': { type: 'pwm', duty: 0.5 } }));
    await svc.tick();
    const snap = published.at(-1)!;
    expect(snap.analysisMode).toBe('tran');
    const a0 = snap.pinNetMap.get('arduino-uno:A0')!;
    expect(snap.timeWaveforms, 'a capture is published').toBeDefined();
    const s = netStats(snap.timeWaveforms!, a0);
    // 1 V amplitude about 1.25 V: 0.25 V to 2.25 V.
    expect(s.max - s.min).toBeGreaterThan(1.95);
    expect(s.max).toBeCloseTo(2.25, 1);
    expect(s.min).toBeCloseTo(0.25, 1);
    expect(s.mean).toBeCloseTo(1.25, 2);
    // What the ADC replay reads (connectAnalogInputsToMcu reads the store).
    const stored = useElectricalStore.getState().timeWaveforms;
    expect(stored?.nodes.get(a0)).toEqual(snap.timeWaveforms!.nodes.get(a0));
    // The oscilloscope's capture shows the sine too.
    const scope = useElectricalStore.getState().scopeWaveforms!;
    expect(netStats(scope, a0).max - netStats(scope, a0).min).toBeGreaterThan(1.95);
  });

  it('the PWM LED still glows at its duty times its on-current (#152 holds)', { timeout: 60_000 }, async () => {
    const { svc, published } = service(GENERATOR_AND_PWM_LED, () => ({ '9': { type: 'pwm', duty: 0.5 } }));
    const el = attachLed('led1', 9);
    await svc.tick();
    const snap = published.at(-1)!;
    const states = snap.window?.states ?? [];
    expect(states.filter((st) => st.weight > 0).length).toBe(2);
    const onA = Math.max(...states.map((st) => Math.abs(st.branchCurrents['v_led1_sense'] ?? 0)));
    expect(onA).toBeGreaterThan(0.008);
    // The capture's LED current is the duty-weighted average over the period ...
    const led = snap.timeWaveforms!.branches.get('v_led1_sense')!;
    const span = readSpan(snap.timeWaveforms!.time, snap.timeWaveforms!.period)!;
    expect(spanStats(snap.timeWaveforms!.time, led, span)!.meanAbs).toBeCloseTo(0.5 * onA, 5);
    // ... and the LED part shows the same brightness the window gives.
    expect(el.brightness).toBeCloseTo((0.5 * onA) / 0.02, 3);
  });

  it('a new duty publishes the sine again, from the cached HIGH and LOW transients', { timeout: 60_000 }, async () => {
    let duty = 0.25;
    const { svc, published } = service(GENERATOR_AND_PWM_LED, () => ({ '9': { type: 'pwm', duty } }));
    await svc.tick();
    const solved = svc.stateSolveCount;
    duty = 0.75;
    await svc.tick();
    expect(svc.stateSolveCount).toBe(solved);
    const snap = published.at(-1)!;
    const a0 = snap.pinNetMap.get('arduino-uno:A0')!;
    const s = netStats(snap.timeWaveforms!, a0);
    expect(s.max - s.min).toBeGreaterThan(1.95);
  });

  it('pin 9 a plain digital LOW: the capture is the state\'s own, as before', { timeout: 60_000 }, async () => {
    const { svc, published } = service(GENERATOR_AND_PWM_LED, () => ({ '9': { type: 'digital', v: 0 } }));
    await svc.tick();
    const snap = published.at(-1)!;
    expect(snap.window).toBeUndefined();
    const s = netStats(snap.timeWaveforms!, snap.pinNetMap.get('arduino-uno:A0')!);
    expect(s.max - s.min).toBeGreaterThan(1.95);
  });

  it('an LED the generator drives keeps its own brightness beside the PWM LED', { timeout: 60_000 }, async () => {
    // The sine drives a second LED through 100 ohm: it conducts on the upper
    // half-wave only. Its brightness is the mean of its current over whole
    // periods, with or without the PWM pad.
    const canvas = {
      components: [
        ...GENERATOR_AND_PWM_LED.components,
        { id: 'r2', metadataId: 'resistor', properties: { value: '100' } },
        { id: 'led2', metadataId: 'led', properties: { color: 'red' } },
      ],
      wires: [
        ...GENERATOR_AND_PWM_LED.wires,
        w('w4', ['gen', 'SIG'], ['r2', '1']),
        w('w5', ['r2', '2'], ['led2', 'A']),
        w('w6', ['led2', 'C'], ['arduino-uno', 'GND.3']),
      ],
    };
    const brightness = async (pin9: PinSourceState) => {
      const { svc } = service(canvas, () => ({ '9': pin9 }));
      const el = attachLed('led2', 99);
      await svc.tick();
      const b = el.brightness;
      svc.stop();
      __resetMixedModeScheduler();
      useElectricalStore.getState().reset();
      return b;
    };
    const alone = await brightness({ type: 'digital', v: 0 });
    const besidePwm = await brightness({ type: 'pwm', duty: 0.5 });
    expect(alone).toBeGreaterThan(0.01);
    expect(besidePwm).toBeCloseTo(alone, 3);
  });
});

/** An LED on pin 9 through `ohms`, beside the issue's generator on A0 or alone. */
function pwmLed(ohms: string, withGenerator: boolean): { components: Comp[]; wires: Wire[] } {
  const keep = (id: string) => withGenerator || !id.startsWith('g');
  return {
    components: GENERATOR_AND_PWM_LED.components
      .filter((c) => keep(c.id))
      .map((c) => (c.id === 'r1' ? { ...c, properties: { value: ohms } } : c)),
    wires: GENERATOR_AND_PWM_LED.wires.filter((x) => keep(x.id)),
  };
}

describe('a PWM LED reads the same beside a generator as without one (#232, #152)', () => {
  /** The LED on pin 9 at `duty`: its brightness, its current while HIGH, and
   *  whether it burnt out. */
  async function ledAt(ohms: string, duty: number, withGenerator: boolean) {
    const { svc, published } = service(pwmLed(ohms, withGenerator), () => ({ '9': { type: 'pwm', duty } }));
    const el = attachLed('led1', 9);
    await svc.tick();
    const snap = published.at(-1)!;
    const onA = Math.max(...(snap.window?.states ?? []).map((st) => Math.abs(st.branchCurrents['v_led1_sense'] ?? 0)));
    const out = {
      brightness: el.brightness,
      onA,
      burnt: useSimulatorStore.getState().burntComponents.has('led1'),
      analysis: snap.analysisMode,
      captured: !!snap.timeWaveforms,
    };
    svc.stop();
    __resetMixedModeScheduler();
    useElectricalStore.getState().reset();
    useSimulatorStore.getState().clearBurntComponents();
    return out;
  }

  it('an LED driven past its 20 mA rating glows at its duty, not at the mean current of the mix', { timeout: 60_000 }, async () => {
    const alone = await ledAt('47', 0.5, false);
    const beside = await ledAt('47', 0.5, true);
    expect(beside.analysis).toBe('tran');
    expect(beside.captured).toBe(true);
    // About 39 mA while HIGH (the blue LED through 47 ohm): past the rating,
    // so the HIGH state is at full brightness, for half the period.
    expect(alone.onA).toBeGreaterThan(0.03);
    expect(alone.brightness).toBeCloseTo(0.5, 3);
    // The mix's mean, 0.5 x 39 mA, would read as 0.97 of full brightness.
    expect(beside.brightness).toBeCloseTo(alone.brightness, 3);
  });

  it('an LED that burns while HIGH burns beside a generator too, whatever its mean current', { timeout: 60_000 }, async () => {
    const duty = 0.3;
    const alone = await ledAt('15', duty, false);
    // The case tells the two apart: over 100 mA while HIGH, under it on average.
    expect(alone.onA).toBeGreaterThan(0.1);
    expect(alone.onA * duty).toBeLessThan(0.1);
    expect(alone.burnt).toBe(true);
    const beside = await ledAt('15', duty, true);
    expect(beside.burnt).toBe(true);
    expect(beside.brightness).toBe(0);
  });
});

describe('an LED over a window whose states carry their own captures (#232)', () => {
  /** A capture of `n` points over 4 ms whose LED current is `amps` throughout. */
  const flat = (amps: number) => {
    const time = Array.from({ length: 41 }, (_, i) => i * 1e-4);
    return { time, nodes: new Map<string, number[]>(), branches: new Map([['v_led1_sense', time.map(() => amps)]]), period: 1e-3 };
  };

  it('glows at the time-weighted brightness of the states, not at the latest state alone', () => {
    const el = attachLed('led1', 13);
    const on = flat(0.01);
    const off = flat(0);
    const state = (weight: number, tw: ReturnType<typeof flat>) => ({
      weight, ms: weight * 33, levels: {}, nodeVoltages: {}, branchCurrents: { v_led1_sense: tw.branches.get('v_led1_sense')!.at(-1)! }, timeWaveforms: tw,
    });
    useElectricalStore.getState().setSolveResult({
      ...useElectricalStore.getState(),
      branchCurrents: { v_led1_sense: 0 },
      // The pin was HIGH for a quarter of the window and is LOW now.
      window: { ms: 33, states: [state(0.25, on), state(0.75, off)] },
      analysisMode: 'tran',
      timeWaveforms: off,
    });
    // 10 mA is half the rating: a quarter of the window at half brightness.
    expect(el.brightness).toBeCloseTo(0.125, 6);
  });
});

describe('mixCaptures', () => {
  it('mixes captures on one time axis sample by sample, by weight', () => {
    const time = [0, 1, 2];
    const a = { time, nodes: new Map([['n1', [1, 1, 1]], ['n2', [0, 2, 4]]]), branches: new Map([['v1', [0.1, 0.1, 0.1]]]), period: 2 };
    const b = { time: time.slice(), nodes: new Map([['n1', [0, 0, 0]], ['n2', [0, 2, 4]]]), branches: new Map([['v1', [0, 0, 0]]]), period: 2 };
    const m = mixCaptures([{ capture: a, weight: 0.25 }, { capture: b, weight: 0.75 }])!;
    expect(m.time).toEqual([0, 1, 2]);
    expect(m.nodes.get('n1')).toEqual([0.25, 0.25, 0.25]);
    expect(m.nodes.get('n2')).toEqual([0, 2, 4]);
    expect(m.branches.get('v1')![0]).toBeCloseTo(0.025, 12);
    expect(m.period).toBe(2);
  });

  it('puts captures with different time points on the union of them, each read between its samples', () => {
    const a = { time: [0, 2, 4], nodes: new Map([['n', [0, 2, 4]]]), branches: new Map<string, number[]>() };
    const b = { time: [0, 1, 4], nodes: new Map([['n', [0, 1, 4]]]), branches: new Map<string, number[]>() };
    const m = mixCaptures([{ capture: a, weight: 1 }, { capture: b, weight: 1 }])!;
    expect(m.time).toEqual([0, 1, 2, 4]);
    // Both are the line v = t, so their mix is too, wherever it is read.
    expect(m.nodes.get('n')).toEqual([0, 1, 2, 4]);
  });

  it('keeps only the vectors every capture holds, and passes a lone capture through', () => {
    const a = { time: [0, 1], nodes: new Map([['n', [1, 1]], ['only-a', [5, 5]]]), branches: new Map<string, number[]>() };
    const b = { time: [0, 1], nodes: new Map([['n', [3, 3]]]), branches: new Map<string, number[]>() };
    const m = mixCaptures([{ capture: a, weight: 0.5 }, { capture: b, weight: 0.5 }])!;
    expect([...m.nodes.keys()]).toEqual(['n']);
    expect(m.nodes.get('n')).toEqual([2, 2]);
    expect(mixCaptures([{ capture: a, weight: 1 }, { capture: b, weight: 0 }])).toBe(a);
    expect(mixCaptures([])).toBeUndefined();
  });
});
