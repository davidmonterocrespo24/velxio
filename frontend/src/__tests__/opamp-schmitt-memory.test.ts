/**
 * A Schmitt trigger settles in one of its two states (velxio/velxio-prod#134).
 *
 * An op-amp whose resistors feed its output back to IN+ (a Schmitt trigger)
 * has two stable states inside its band, one at each rail, and an unstable
 * one between them where IN+ meets IN-. A real trigger sits in one of the
 * two and keeps it until its input leaves the band. An operating point has
 * no history and landed on the middle one: the book's trigger (R2/R1 = 10,
 * 2.5 V on IN-) read OUT = 27.5 - 10 * Vin, 3.47 / 2.47 / 1.47 V for 2.4 /
 * 2.5 / 2.6 V in, and the gallery's trigger did the same with its pot inside
 * the band. The deck now seeds such an op-amp with .nodeset: OUT and IN+
 * with where OUT was at the last solve, or OUT alone with its low rail at
 * power-up. The circuit service carries that state from one solve to the
 * next, as it does a relay's armature (#109) and an SR latch (#147).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { exampleToBuildNetlistInput } from '../utils/exampleToBuildNetlistInput';
import { circuitExamples } from '../data/examples-circuits';
import { analogExamples } from '../data/examples-analog';
import { runNetlist } from './helpers/testSolver';
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
import type { BuildNetlistInput, CircuitMemory, PinSourceState } from '../simulation/spice/types';

type Comp = BuildNetlistInput['components'][number];
type Wire = BuildNetlistInput['wires'][number];
const w = (id: string, a: [string, string], b: [string, string]): Wire => ({
  id,
  start: { componentId: a[0], pinName: a[1] },
  end: { componentId: b[0], pinName: b[1] },
});
const dc = (id: string, volts: number): Comp => ({
  id,
  metadataId: 'signal-generator',
  properties: { waveform: 'dc', offset: volts, amplitude: 0, frequency: 1 },
});
const res = (id: string, ohms: number): Comp => ({
  id,
  metadataId: 'resistor',
  properties: { value: String(ohms) },
});

/**
 * The book's trigger: Vin through R1 = 10k to IN+, R2 = 100k from OUT to
 * IN+, 2.5 V on IN-, a 10k load, the op-amp on the 5 V logic rail. Its band
 * is Vin from 2.35 to 2.75 V on an LM358 (OUT 3.96 V high, 13 mV low).
 */
function bookTrigger(
  vin: number,
  opamp = 'opamp-lm358',
  memory?: CircuitMemory,
): BuildNetlistInput {
  return {
    components: [
      dc('vin', vin),
      dc('vref', 2.5),
      res('r1', 10_000),
      res('r2', 100_000),
      res('rl', 10_000),
      { id: 'u1', metadataId: opamp, properties: {} },
    ],
    wires: [
      w('w1', ['vin', 'SIG'], ['r1', '1']),
      w('w2', ['r1', '2'], ['u1', 'IN+']),
      w('w3', ['u1', 'OUT'], ['r2', '1']),
      w('w4', ['r2', '2'], ['u1', 'IN+']),
      w('w5', ['vref', 'SIG'], ['u1', 'IN-']),
      w('w6', ['u1', 'OUT'], ['rl', '1']),
      w('w7', ['rl', '2'], ['vin', 'GND']),
      w('w8', ['vref', 'GND'], ['vin', 'GND']),
    ],
    boards: [],
    analysis: { kind: 'op' },
    ...(memory ? { memory } : {}),
  };
}

async function solveOut(input: BuildNetlistInput): Promise<number> {
  const { netlist, pinNetMap } = buildNetlist(input);
  const r = await runNetlist(netlist);
  return r.dcValue(`v(${pinNetMap.get('u1:OUT')})`);
}

const remembered = (volts: number): CircuitMemory => ({ nodes: new Map([['u1:OUT', volts]]) });

describe('the book trigger solved in DC inside its band (velxio/velxio-prod#134)', () => {
  it.each([2.4, 2.5, 2.6])(
    'Vin = %s V powers up with OUT low, not on the middle point 27.5 - 10 * Vin',
    { timeout: 60_000 },
    async (vin) => {
      const out = await solveOut(bookTrigger(vin));
      expect(out, `OUT sits ${out.toFixed(3)} V, the unstable middle point`).toBeLessThan(0.05);
    },
  );

  it.each([2.4, 2.5, 2.6])(
    'Vin = %s V with OUT high at the last solve stays high',
    { timeout: 60_000 },
    async (vin) => {
      const out = await solveOut(bookTrigger(vin, 'opamp-lm358', remembered(3.956)));
      expect(out).toBeGreaterThan(3.9);
    },
  );

  it(
    'outside the band there is one state, whatever the last solve left',
    { timeout: 60_000 },
    async () => {
      expect(await solveOut(bookTrigger(2.0, 'opamp-lm358', remembered(3.956)))).toBeLessThan(0.05);
      expect(await solveOut(bookTrigger(3.0))).toBeGreaterThan(3.9);
      expect(await solveOut(bookTrigger(3.0, 'opamp-lm358', remembered(0.013)))).toBeGreaterThan(
        3.9,
      );
    },
  );

  it('the deck seeds OUT alone from the low rail at power-up, and OUT and IN+ with the same volts from memory', () => {
    const { netlist, pinNetMap, nodeMemoryCells } = buildNetlist(bookTrigger(2.5));
    const out = pinNetMap.get('u1:OUT');
    const inp = pinNetMap.get('u1:IN+');
    expect(netlist).toMatch(new RegExp(`^\\.nodeset V\\(${out}\\)=0$`, 'm'));
    expect(nodeMemoryCells).toEqual([{ key: 'u1:OUT', net: out, threshold: 2.5, seed: 0 }]);
    const high = buildNetlist(bookTrigger(2.5, 'opamp-lm358', remembered(3.9561234)));
    expect(high.netlist).toMatch(
      new RegExp(`^\\.nodeset V\\(${out}\\)=3.956 V\\(${inp}\\)=3.956$`, 'm'),
    );
    expect(high.nodeMemoryCells).toEqual([
      { key: 'u1:OUT', net: out, threshold: 2.5, seed: 3.956, alsoSeeded: [inp] },
    ]);
  });

  it.each(['opamp-lm741', 'opamp-tl072', 'opamp-lm324'])(
    'a trigger on an %s keeps its state too',
    { timeout: 60_000 },
    async (opamp) => {
      // The behavioural parts hold OUT with an ideal source, which .nodeset
      // cannot move: the seed on IN+ is what places them.
      const low = await solveOut(bookTrigger(2.5, opamp));
      const high = await solveOut(bookTrigger(2.5, opamp, remembered(4)));
      expect(
        high - low,
        `${opamp}: low ${low.toFixed(3)} V, high ${high.toFixed(3)} V`,
      ).toBeGreaterThan(0.9);
    },
  );
});

/**
 * A trigger on +-12 V from two generators, its reference on ground.
 * Non-inverting: Vin through R1 = 10k to IN+, R2 = 100k from OUT, IN- on
 * ground; the band is Vin within about +-1 V and the middle point
 * OUT = -10 * Vin. Inverting: Vin on IN-, IN+ = OUT * 10k / 110k; at Vin = 0
 * the middle point is OUT = 0. The deck names no rail for V- here (a
 * generator's net, as a battery's or a bench supply's would be) and takes
 * 0 V for its low rail: a power-up seed that put IN+ there as well sat the
 * LM741 and the TL072 on their middle point, where unseeded they start on a
 * rail.
 */
function dualTrigger(topo: 'inv' | 'noninv', opamp: string, vin: number): BuildNetlistInput {
  const wires: Wire[] = [
    w('ws1', ['vpos', 'GND'], ['vneg', 'GND']),
    w('wp', ['u1', 'V+'], ['vpos', 'SIG']),
    w('wm', ['u1', 'V-'], ['vneg', 'SIG']),
    w('wg', ['vin', 'GND'], ['vpos', 'GND']),
    w('wl1', ['u1', 'OUT'], ['rl', '1']),
    w('wl2', ['rl', '2'], ['vpos', 'GND']),
  ];
  if (topo === 'inv') {
    wires.push(
      w('a1', ['vin', 'SIG'], ['u1', 'IN-']),
      w('a2', ['u1', 'OUT'], ['r2', '1']),
      w('a3', ['r2', '2'], ['u1', 'IN+']),
      w('a4', ['u1', 'IN+'], ['r1', '1']),
      w('a5', ['r1', '2'], ['vpos', 'GND']),
    );
  } else {
    wires.push(
      w('a1', ['vin', 'SIG'], ['r1', '1']),
      w('a2', ['r1', '2'], ['u1', 'IN+']),
      w('a3', ['u1', 'OUT'], ['r2', '1']),
      w('a4', ['r2', '2'], ['u1', 'IN+']),
      w('a5', ['u1', 'IN-'], ['vpos', 'GND']),
    );
  }
  return {
    components: [
      dc('vpos', 12),
      dc('vneg', -12),
      dc('vin', vin),
      res('r1', 10_000),
      res('r2', 100_000),
      res('rl', 10_000),
      { id: 'u1', metadataId: opamp, properties: {} },
    ],
    wires,
    boards: [],
    analysis: { kind: 'op' },
  };
}

describe('a dual-supply trigger with a ground reference powers up on a rail (velxio/velxio-prod#134)', () => {
  const cases: Array<[string, 'inv' | 'noninv', number]> = [];
  for (const opamp of ['opamp-lm741', 'opamp-tl072', 'opamp-lm358']) {
    for (const vin of [-0.5, -0.1, 0.1, 0.5]) cases.push([opamp, 'noninv', vin]);
    cases.push([opamp, 'inv', 0]);
  }
  it.each(cases)('%s %s, Vin = %s V', { timeout: 60_000 }, async (opamp, topo, vin) => {
    const out = await solveOut(dualTrigger(topo, opamp, vin));
    expect(Math.abs(out), `OUT sits ${out.toFixed(3)} V, not on a rail`).toBeGreaterThan(9);
  });
});

describe('only an op-amp on positive feedback is seeded (velxio/velxio-prod#134)', () => {
  const lm358 = (id = 'u1'): Comp => ({ id, metadataId: 'opamp-lm358', properties: {} });
  const cases: Array<[string, BuildNetlistInput]> = [
    [
      'a comparator (no feedback)',
      {
        components: [dc('vin', 2.4), dc('vref', 2.5), lm358(), res('rl', 10_000)],
        wires: [
          w('w1', ['vin', 'SIG'], ['u1', 'IN+']),
          w('w2', ['vref', 'SIG'], ['u1', 'IN-']),
          w('w3', ['u1', 'OUT'], ['rl', '1']),
          w('w4', ['rl', '2'], ['vin', 'GND']),
          w('w5', ['vref', 'GND'], ['vin', 'GND']),
        ],
        boards: [],
        analysis: { kind: 'op' },
      },
    ],
    [
      'a non-inverting amplifier (feedback to IN-)',
      {
        components: [dc('vin', 1), lm358(), res('rf', 10_000), res('rg', 10_000)],
        wires: [
          w('w1', ['vin', 'SIG'], ['u1', 'IN+']),
          w('w2', ['u1', 'OUT'], ['rf', '1']),
          w('w3', ['rf', '2'], ['u1', 'IN-']),
          w('w4', ['u1', 'IN-'], ['rg', '1']),
          w('w5', ['rg', '2'], ['vin', 'GND']),
        ],
        boards: [],
        analysis: { kind: 'op' },
      },
    ],
    [
      'a relaxation oscillator (more feedback to IN- than to IN+)',
      {
        // OUT reaches IN- through Rt (the capacitor is open in DC) and IN+
        // through the Ra / Rb divider: beta- = 1 against beta+ = 0.5.
        components: [
          lm358(),
          res('rt', 10_000),
          { id: 'ct', metadataId: 'capacitor', properties: { value: '100n' } },
          res('ra', 10_000),
          res('rb', 10_000),
          dc('gnd', 0),
        ],
        wires: [
          w('w1', ['u1', 'OUT'], ['rt', '1']),
          w('w2', ['rt', '2'], ['u1', 'IN-']),
          w('w3', ['u1', 'IN-'], ['ct', '1']),
          w('w4', ['ct', '2'], ['gnd', 'GND']),
          w('w5', ['u1', 'OUT'], ['ra', '1']),
          w('w6', ['ra', '2'], ['u1', 'IN+']),
          w('w7', ['u1', 'IN+'], ['rb', '1']),
          w('w8', ['rb', '2'], ['gnd', 'GND']),
        ],
        boards: [],
        analysis: { kind: 'op' },
      },
    ],
    [
      'an ideal op-amp, which has no rails to settle on',
      {
        ...bookTrigger(2.5, 'opamp-ideal'),
      },
    ],
  ];
  it.each(cases)('%s gets no seed', (_name, input) => {
    const { netlist, nodeMemoryCells } = buildNetlist(input);
    expect(netlist).not.toMatch(/^\.nodeset/m);
    expect(nodeMemoryCells).toEqual([]);
  });
});

/** The gallery's opamp-schmitt-trigger (an inverting trigger on the Uno) with
 *  its pot at `pot` (0..1023). IN- follows the pot; the band is about 2.17 to
 *  2.70 V on it, the pot from about 445 to 552. */
function galleryTrigger(pot: number): BuildNetlistInput {
  const ex = circuitExamples.find((e) => e.id === 'opamp-schmitt-trigger');
  if (!ex) throw new Error('opamp-schmitt-trigger is gone from the gallery');
  const input = exampleToBuildNetlistInput(ex, {
    boards: [{ id: 'arduino-uno', boardKind: 'arduino-uno', pinStates: {} }],
    analysis: { kind: 'op' },
  });
  return {
    ...input,
    components: input.components.map((c) =>
      c.id === 'pot' ? { ...c, properties: { ...c.properties, value: pot } } : c,
    ),
  };
}

describe('the gallery triggers (velxio/velxio-prod#134)', () => {
  it(
    'opamp-schmitt-trigger opened with its pot inside the band powers up low',
    { timeout: 60_000 },
    async () => {
      const out = await solveOut(galleryTrigger(500));
      expect(out, `OUT sits ${out.toFixed(3)} V`).toBeLessThan(0.05);
    },
  );

  it(
    'an-schmitt-trigger starts its transient from a state, not from the middle point',
    { timeout: 60_000 },
    async () => {
      const ex = analogExamples.find((e) => e.id === 'an-schmitt-trigger');
      if (!ex) throw new Error('an-schmitt-trigger is gone from the gallery');
      const { netlist, pinNetMap, analysis } = buildNetlist(exampleToBuildNetlistInput(ex));
      expect(analysis.kind).toBe('tran');
      const r = await runNetlist(netlist);
      const out = r.vec(`v(${pinNetMap.get('u1:OUT')})`) as number[];
      // At t = 0 the sine is at 2.5 V, inside the band (1 to 5 V on this
      // trigger): OUT was 2.4955 V there, the middle point.
      expect(out[0], `OUT starts at ${out[0]!.toFixed(3)} V`).toBeLessThan(0.05);
    },
  );
});

const services: CircuitSimulationService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  __resetMixedModeScheduler();
});

/** The real service on ngspice, over a store port the test drives. */
function serviceOver(
  initial: { components: Comp[]; wires: Wire[] },
  pins: () => Record<string, PinSourceState> = () => ({}),
) {
  __setSchedulerSolverFactoryForTests(() => new NgSpiceNodeAdapter());
  let state = {
    components: initial.components,
    wires: initial.wires,
    boards: [{ id: 'arduino-uno', boardKind: 'arduino-uno', running: true }],
    hydrationSeq: 1,
  };
  const published: ElectricalSnapshot[] = [];
  const service = new CircuitSimulationService(
    { getState: () => state, subscribe: () => () => {} } as SimulatorStorePort,
    { publish: (s) => published.push(s) },
    getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
    { collectBoardPinStates: () => pins() },
  );
  services.push(service);
  const out = (): number => {
    const s = published[published.length - 1];
    const net = s?.pinNetMap.get('u1:OUT');
    return s && net ? (s.nodeVoltages[net] ?? NaN) : NaN;
  };
  const setPot = async (value: number) => {
    state = {
      ...state,
      components: state.components.map((c) =>
        c.id === 'pot' ? { ...c, properties: { ...c.properties, value } } : c,
      ),
    };
    await service.tick();
  };
  const reload = async (components: Comp[]) => {
    state = { ...state, components, hydrationSeq: state.hydrationSeq + 1 };
    await service.tick();
  };
  return { service, out, setPot, reload };
}

describe('the circuit service carries the trigger state (velxio/velxio-prod#134)', () => {
  it(
    'turning the pot of opamp-schmitt-trigger shows its hysteresis',
    { timeout: 120_000 },
    async () => {
      const start = galleryTrigger(0);
      const t = serviceOver({ components: start.components as Comp[], wires: start.wires });
      await t.service.tick();
      expect(t.out(), 'pot at 0: IN- under the band, OUT high').toBeGreaterThan(3.9);
      await t.setPot(500);
      expect(t.out(), 'pot back inside the band: OUT forgot it was high').toBeGreaterThan(3.9);
      await t.setPot(1023);
      expect(t.out(), 'pot at 1023: IN- over the band, OUT low').toBeLessThan(0.05);
      await t.setPot(500);
      expect(t.out(), 'pot back inside the band: OUT forgot it was low').toBeLessThan(0.05);
      await t.setPot(0);
      expect(t.out()).toBeGreaterThan(3.9);
    },
  );

  it('a reloaded circuit powers up anew', { timeout: 120_000 }, async () => {
    const start = galleryTrigger(500);
    const t = serviceOver({ components: start.components as Comp[], wires: start.wires });
    await t.service.tick();
    expect(t.out(), 'opened inside the band: OUT powers up low').toBeLessThan(0.05);
    await t.setPot(0);
    await t.setPot(500);
    expect(t.out(), 'OUT keeps high inside the band').toBeGreaterThan(3.9);
    await t.reload(start.components as Comp[]);
    expect(t.out(), 'the reloaded trigger came back high').toBeLessThan(0.05);
  });

  it(
    'a trigger driven from board pins keeps the state a pin left',
    { timeout: 120_000 },
    async () => {
      // D9 through 10k and D10 through 20k into a node held by 20k to GND: the
      // trigger sees 2.5 V (inside its band) with only D9 high, 3.75 V with both
      // and 1.25 V with only D10, behind a 5k source and R1 = 10k.
      let d9 = 5;
      let d10 = 0;
      const pins = (): Record<string, PinSourceState> => ({
        '9': { type: 'digital', v: d9 },
        '10': { type: 'digital', v: d10 },
      });
      const components: Comp[] = [
        res('ra', 10_000),
        res('rb', 20_000),
        res('rg', 20_000),
        res('r1', 10_000),
        res('r2', 100_000),
        res('rref1', 10_000),
        res('rref2', 10_000),
        { id: 'u1', metadataId: 'opamp-lm358', properties: {} },
      ];
      const wires: Wire[] = [
        w('w1', ['arduino-uno', '9'], ['ra', '1']),
        w('w2', ['arduino-uno', '10'], ['rb', '1']),
        w('w3', ['ra', '2'], ['rg', '1']),
        w('w4', ['rb', '2'], ['rg', '1']),
        w('w5', ['rg', '2'], ['arduino-uno', 'GND']),
        w('w6', ['rg', '1'], ['r1', '1']),
        w('w7', ['r1', '2'], ['u1', 'IN+']),
        w('w8', ['u1', 'OUT'], ['r2', '1']),
        w('w9', ['r2', '2'], ['u1', 'IN+']),
        w('w10', ['arduino-uno', '5V'], ['rref1', '1']),
        w('w11', ['rref1', '2'], ['u1', 'IN-']),
        w('w12', ['u1', 'IN-'], ['rref2', '1']),
        w('w13', ['rref2', '2'], ['arduino-uno', 'GND']),
      ];
      const t = serviceOver({ components, wires }, pins);
      await t.service.tick();
      expect(t.out(), 'powered up inside the band: OUT low').toBeLessThan(0.05);

      d10 = 5;
      await t.service.handleMcuEdge('arduino-uno', '10', true, 5, null);
      await vi.waitFor(() => expect(t.out()).toBeGreaterThan(3.9), { timeout: 5000, interval: 20 });
      d10 = 0;
      await t.service.handleMcuEdge('arduino-uno', '10', false, 5, null);
      await new Promise((r) => setTimeout(r, 600));
      expect(t.out(), 'forgot it was high when D10 went back LOW').toBeGreaterThan(3.9);

      d9 = 0;
      await t.service.handleMcuEdge('arduino-uno', '9', false, 5, null);
      await vi.waitFor(() => expect(t.out()).toBeLessThan(0.05), { timeout: 5000, interval: 20 });
      d9 = 5;
      await t.service.handleMcuEdge('arduino-uno', '9', true, 5, null);
      await new Promise((r) => setTimeout(r, 600));
      expect(t.out(), 'forgot it was low when D9 went back HIGH').toBeLessThan(0.05);
    },
  );
});
