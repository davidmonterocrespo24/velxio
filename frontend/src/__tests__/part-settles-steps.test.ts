/**
 * A part that stores energy in its own cards steps from where it was
 * (velxio/velxio-prod#164).
 *
 * The circuit service carries every capacitor's voltage and every inductor's
 * current from one pad state to the next, and runs the step the circuit takes
 * when the pads change (velxio/velxio-prod#153). It only did so for a deck
 * the canvas's capacitors and inductors made a step response: a part whose
 * own cards hold a C or an L (a DC motor's winding and shaft) was solved as
 * an operating point at each pad state, so a motor switched on drew its
 * running current at once, and one switched off sent nothing through its
 * flyback diode. A part now says how long it settles
 * (registerPartSettleTime), and the deck it is on steps.
 *
 * Its C and L must not make a PWM pad that drives it reactive either: held at
 * its mean, an IRF540's gate at 2.5 V passes nothing where the real gate is
 * fully on for half of each period (velxio/velxio-prod#152). A part whose
 * state the PWM's two levels describe says so (SpiceEmission.pwmStatic). And
 * when the pads stop being chopped, the step starts from where the circuit
 * was on average over the PWM period, not from the operating point of the
 * mean, which the circuit is never in.
 *
 * The test part is a 5 V load of 50 ohm into a node that 2 mF and 50 ohm hold
 * to its other lead, with a 0 V sense source at its + lead: switched on from
 * rest it draws 100 mA, falling to 50 mA as the 2 mF charges to 2.5 V
 * (tau = 50 ms).
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
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import {
  registerPartSettleTime,
  registerSpiceMapper,
  type Mapper,
} from '../simulation/spice/componentToSpice';
import { interpolateAt } from '../simulation/spice/waveformStats';
import type { PinSourceState } from '../simulation/spice/types';

/** The test part, with or without the PWM flag. */
const settlingLoad =
  (pwmStatic: boolean): Mapper =>
  (comp, netLookup) => {
    const plus = netLookup('+');
    const minus = netLookup('-');
    if (!plus || !minus) return null;
    const m = `${comp.id}_m`;
    return {
      cards: [
        `V_${comp.id}_sense ${plus} ${comp.id}_a DC 0`,
        `R_${comp.id}_a ${comp.id}_a ${m} 50`,
        `R_${comp.id}_b ${m} ${minus} 50`,
        `C_${comp.id}_c ${m} ${minus} 2m`,
      ],
      modelsUsed: new Set<string>(),
      ...(pwmStatic ? { pwmStatic: true } : {}),
    };
  };
registerSpiceMapper('test-settling-load', settlingLoad(true));
registerPartSettleTime('test-settling-load', () => 0.5);
registerSpiceMapper('test-settling-load-reactive', settlingLoad(false));
registerPartSettleTime('test-settling-load-reactive', () => 0.5);

type Wire = { id: string; start: { componentId: string; pinName: string }; end: { componentId: string; pinName: string } };
const w = (id: string, a: [string, string], b: [string, string]): Wire => ({
  id,
  start: { componentId: a[0], pinName: a[1] },
  end: { componentId: b[0], pinName: b[1] },
});
const UNO = 'arduino-uno';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 5V -> the part -> an IRF540's drain, its source on GND, its gate on pin 9. */
function rig(part = 'test-settling-load') {
  return {
    components: [
      { id: 'q1', metadataId: 'mosfet-irf540', properties: {} },
      { id: 'ld', metadataId: part, properties: {} },
    ],
    wires: [
      w('w1', [UNO, '5V'], ['ld', '+']),
      w('w2', ['ld', '-'], ['q1', 'D']),
      w('w3', ['q1', 'S'], [UNO, 'GND']),
      w('w4', ['q1', 'G'], [UNO, '9']),
    ],
  };
}

const services: CircuitSimulationService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  __resetMixedModeScheduler();
});

function service(canvas: ReturnType<typeof rig>, initial: Record<string, PinSourceState>) {
  __setSchedulerSolverFactoryForTests(() => new NgSpiceNodeAdapter());
  let pins = initial;
  const published: ElectricalSnapshot[] = [];
  const simStore: SimulatorStorePort = {
    getState: () => ({ ...canvas, boards: [{ id: UNO, boardKind: UNO, running: true }] }),
    subscribe: () => () => {},
  };
  const svc = new CircuitSimulationService(
    simStore,
    { publish: (s) => published.push(s) },
    getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
    { collectBoardPinStates: () => pins },
  );
  services.push(svc);
  return {
    svc,
    published,
    setPins: (next: Record<string, PinSourceState>) => {
      pins = next;
    },
  };
}

/** The part's current on a snapshot's step at `t` seconds after its edge. */
const stepAmps = (s: ElectricalSnapshot, t: number): number =>
  interpolateAt(s.stepWaveforms!.time, s.stepWaveforms!.branches.get('v_ld_sense')!, t);

function deck(part: string, pin9: PinSourceState) {
  const { components, wires } = rig(part);
  return buildInputFromStore({
    components,
    wires: wires as never,
    boards: [{ id: UNO, boardKind: UNO, pinStates: { '9': pin9 } }],
  });
}

describe('a part that stores energy in its own cards (velxio/velxio-prod#164)', () => {
  it('makes the deck with a driven pin a step response that lasts as long as it settles', () => {
    const analysis = deck('test-settling-load', { type: 'digital', v: 5 }).analysis;
    expect(analysis.kind).toBe('tran');
    expect(analysis.kind === 'tran' && analysis.settleS).toBe(0.5);
    // The deck's own window stays the short one: nothing on the canvas
    // charges, and a rebuild would otherwise run a long flat capture.
    expect(analysis.kind === 'tran' && Number(analysis.stop)).toBeLessThanOrEqual(5e-3);
  });

  it('leaves a PWM pad that drives it static when its state is the PWM states\' (pwmStatic), reactive otherwise', () => {
    const pwm: PinSourceState = { type: 'pwm', duty: 0.5 };
    expect(buildNetlist(deck('test-settling-load', pwm)).staticPads.has('v_arduino_uno_9')).toBe(true);
    expect(buildNetlist(deck('test-settling-load-reactive', pwm)).staticPads.has('v_arduino_uno_9')).toBe(false);
  });

  it('switched on from rest it steps: the full current first, then what it settles to', { timeout: 60_000 }, async () => {
    const { svc, published, setPins } = service(rig(), { '9': { type: 'digital', v: 0 } });
    await svc.tick();
    expect(published.at(-1)!.stepWaveforms).toBeUndefined();
    setPins({ '9': { type: 'digital', v: 5 } });
    await svc.handleMcuEdge(UNO, '9', true, 5, null);
    await sleep(150);
    const on = published.at(-1)!;
    expect(on.stepWaveforms?.oneShot).toBeDefined();
    // 5 V into 50 ohm with the 2 mF empty, then 50 mA as it charges (the
    // IRF540's channel takes a few millivolts).
    expect(stepAmps(on, 0)).toBeCloseTo(0.1, 2);
    expect(stepAmps(on, 0.05)).toBeCloseTo(0.05 + 0.05 * Math.exp(-1), 2);
    expect(on.branchCurrents['v_ld_sense']).toBeCloseTo(0.05, 2);
  });

  it('chopped by a PWM and then held HIGH, it steps from where the PWM held it on average', { timeout: 60_000 }, async () => {
    const { svc, published, setPins } = service(rig(), { '9': { type: 'pwm', duty: 0.5 } });
    await svc.tick();
    // The PWM is its HIGH and LOW states, weighted by the duty: 50 mA half
    // the time (the 2 mF at 2.5 V), and nothing the other half.
    const pwm = published.at(-1)!;
    expect(pwm.window?.states.filter((s) => s.weight > 0).map((s) => Math.round(s.weight * 100))).toEqual([50, 50]);
    setPins({ '9': { type: 'digital', v: 5 } });
    await svc.tick();
    const high = published.at(-1)!;
    expect(high.stepWaveforms?.oneShot).toBeDefined();
    // From the 2 mF at 1.25 V, its mean over the PWM: (5 - 1.25) / 50, not
    // the 100 mA of an empty 2 mF, which is where the PWM's mean, an IRF540
    // gate at 2.5 V that passes nothing, would have left it.
    expect(stepAmps(high, 0)).toBeCloseTo(0.075, 2);
    expect(svc.stepSolveCount).toBe(1);
  });
});
