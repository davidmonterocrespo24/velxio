/**
 * A coil switched off kicks, and a step resolves the kick (velxio/velxio-prod
 * #164).
 *
 * When a pad edge leaves a capacitor or an inductor away from where the new
 * state settles it, the circuit service runs the step the circuit takes from
 * there, a transient sized to the deck's slowest time constant (velxio/
 * velxio-prod#153). ngspice's first step is a hundredth of the run's TSTEP, a
 * 2000th of the run: in a deck that also holds something slow (here an RC of
 * a second on another pin, a run of 10 s), the first step was 50 us. A coil
 * cut off by a MOSFET kicks for about a microsecond, into its own losses or
 * the MOSFET's avalanche, and the step stepped over it: no spike on the
 * drain, and the coil's energy gone. A deck with an inductor now runs its
 * steps with a fine TSTEP and the coarse one as TMAX (ngspice's
 * `tran tstep tstop tstart tmax`), which keeps the run's length and samples
 * the kick.
 *
 * The coil is 1 mH with 1 kOhm across it (its losses), behind 56 ohm on 5 V,
 * switched by an IRF540 (BV 100 V) with its gate on pin 9: 89 mA through it
 * when on, about 60 V on the drain at the kick.
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
import { tranCommand } from '../simulation/spice/ports/SolverPort';
import type { PinSourceState } from '../simulation/spice/types';

type Wire = { id: string; start: { componentId: string; pinName: string }; end: { componentId: string; pinName: string } };
const w = (id: string, a: [string, string], b: [string, string]): Wire => ({
  id,
  start: { componentId: a[0], pinName: a[1] },
  end: { componentId: b[0], pinName: b[1] },
});
const UNO = 'arduino-uno';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 5V -> 56 ohm -> 1 mH || 1 kOhm -> drain; and an RC of 1 s on pin 10. */
function rig(diode: boolean) {
  return {
    components: [
      { id: 'rl', metadataId: 'resistor', properties: { value: '56' } },
      { id: 'l1', metadataId: 'inductor', properties: { value: '1m' } },
      { id: 'rp', metadataId: 'resistor', properties: { value: '1k' } },
      { id: 'q1', metadataId: 'mosfet-irf540', properties: {} },
      { id: 'rc', metadataId: 'resistor', properties: { value: '10k' } },
      { id: 'cc', metadataId: 'capacitor', properties: { value: '100u' } },
      ...(diode ? [{ id: 'd1', metadataId: 'diode-1n4007', properties: {} }] : []),
    ],
    wires: [
      w('w1', [UNO, '5V'], ['rl', '1']),
      w('w2', ['rl', '2'], ['l1', '1']),
      w('w3', ['l1', '2'], ['q1', 'D']),
      w('w4', ['rp', '1'], ['l1', '1']),
      w('w5', ['rp', '2'], ['l1', '2']),
      w('w6', ['q1', 'S'], [UNO, 'GND']),
      w('w7', ['q1', 'G'], [UNO, '9']),
      w('w8', [UNO, '10'], ['rc', '1']),
      w('w9', ['rc', '2'], ['cc', '1']),
      w('w10', ['cc', '2'], [UNO, 'GND.2']),
      ...(diode ? [w('w11', ['d1', 'A'], ['q1', 'D']), w('w12', ['d1', 'C'], [UNO, '5V'])] : []),
    ],
  };
}

const services: CircuitSimulationService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  __resetMixedModeScheduler();
});

/** The coil on (pin 9 HIGH, pin 10 HIGH and settled), then pin 9 LOW: the
 *  step published at the edge. */
async function turnOff(diode: boolean): Promise<{ off: ElectricalSnapshot; drain: string }> {
  __setSchedulerSolverFactoryForTests(() => new NgSpiceNodeAdapter());
  const canvas = rig(diode);
  let pins: Record<string, PinSourceState> = { '9': { type: 'digital', v: 5 }, '10': { type: 'digital', v: 5 } };
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
  await svc.tick();
  pins = { ...pins, '9': { type: 'digital', v: 0 } };
  await svc.handleMcuEdge(UNO, '9', false, 5, null);
  await sleep(150);
  const off = published.at(-1)!;
  return { off, drain: off.pinNetMap.get('q1:D')! };
}

/** The highest drain voltage within `untilS` of the edge, and when. */
function peak(s: ElectricalSnapshot, net: string, untilS: number): { v: number; t: number } {
  const t = s.stepWaveforms!.time;
  const v = s.stepWaveforms!.nodes.get(net)!;
  let best = { v: -Infinity, t: 0 };
  for (let k = 0; k < t.length && t[k]! <= untilS; k++) if (v[k]! > best.v) best = { v: v[k]!, t: t[k]! };
  return best;
}

describe('a coil switched off in a step (velxio/velxio-prod#164)', () => {
  it('the step command keeps its length and takes a fine first step', () => {
    expect(tranCommand({ kind: 'tran', step: '1e-6', stop: '10', maxStep: '5e-3', uic: true })).toBe('tran 1e-6 10 0 5e-3 uic');
    expect(tranCommand({ kind: 'tran', step: '1e-4', stop: '0.4' })).toBe('tran 1e-4 0.4');
    expect(tranCommand({ kind: 'tran', step: '1e-5', stop: '0.2', start: '0.1' })).toBe('tran 1e-5 0.2 0.1');
  });

  it('kicks the drain to tens of volts within microseconds of the edge, in a deck that settles over seconds', { timeout: 60_000 }, async () => {
    const { off, drain } = await turnOff(false);
    expect(off.stepWaveforms?.oneShot).toBeDefined();
    // The run still covers the RC's second.
    expect(off.stepWaveforms!.time.at(-1)!).toBeGreaterThan(5);
    const kick = peak(off, drain, 1e-4);
    expect(kick.v).toBeGreaterThan(40);
    expect(kick.v).toBeLessThan(101);
    expect(kick.t).toBeLessThan(5e-6);
    // Gone a millisecond later: the drain back at the supply.
    expect(interpolate(off, drain, 1e-3)).toBeCloseTo(5, 1);
  });

  it('a 1N4007 across the load clamps the kick at about 0.7 V over the supply', { timeout: 60_000 }, async () => {
    const { off, drain } = await turnOff(true);
    const kick = peak(off, drain, 1e-4);
    expect(kick.v).toBeGreaterThan(5.3);
    expect(kick.v).toBeLessThan(6.2);
  });
});

function interpolate(s: ElectricalSnapshot, net: string, t: number): number {
  const ts = s.stepWaveforms!.time;
  const vs = s.stepWaveforms!.nodes.get(net)!;
  let k = 0;
  while (k < ts.length - 1 && ts[k + 1]! <= t) k++;
  return vs[k]!;
}
