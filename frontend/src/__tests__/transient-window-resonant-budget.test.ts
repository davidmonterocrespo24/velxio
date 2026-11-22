/**
 * A deck that can resonate integrates at a finer step, and its window and its
 * start-up last as long as any other deck's (velxio/velxio-prod#121, #107,
 * #143).
 *
 * The stored window is bounded at 8000 steps (#107) and the start-up at
 * 10 000 (#143). #121 runs a deck with an inductor and a capacitor at a fifth
 * of the plain step (a hundredth of the fastest period instead of a
 * twentieth), and both bounds were counted in that finer step, so they shrank
 * fivefold in time:
 *  - a 5 kHz generator into an RLC next to a 50 Hz one on a 1 kΩ load: the
 *    window went from four 50 Hz periods (80 ms) to 16 ms, less than one, and
 *    a voltmeter on the 1 V sine read RMS 681.08 mV and DC -444.85 mV for
 *    707.11 mV and 0;
 *  - a 1 kHz, 0-5 V square wave into 100 Ω, 10 mH and 470 µF: the start-up
 *    went from 0.329 s (seven time constants) to 0.1 s, and the capacitor
 *    read DC 2.229 V for 2.5 V (1.619 V with 1000 µF);
 *  - a sine-driven LC low-pass whose seven time constants fit 10 000 plain
 *    steps but not 10 000 of its finer ones ran no start-up at all: the rule
 *    for sine-driven decks (#120) called it too slow.
 * Both budgets now count the plain step, and only the integration runs at the
 * finer one. A diode's finer step (DIODE_STEP_DIVISOR) counts from the plain
 * step too: a resonant deck is already finer than that.
 * Runs the app's analysis choice (storeAdapter), netlist builder, ngspice (the
 * Node adapter) and voltmeter.
 */
import { describe, it, expect } from 'vitest';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { readVoltmeter } from '../simulation/spice/probes';
import { solveInput } from './helpers/solveInput';

type Comp = { id: string; metadataId: string; properties: Record<string, unknown> };
type Wire = { id: string; start: { componentId: string; pinName: string }; end: { componentId: string; pinName: string } };
const w = (id: string, a: [string, string], b: [string, string]): Wire => ({
  id,
  start: { componentId: a[0], pinName: a[1] },
  end: { componentId: b[0], pinName: b[1] },
});

/**
 * A `fast` Hz, 1 V sine into 10 Ω, 1 mH and 1 µF in series, and a `slow` Hz,
 * 1 V sine on a 1 kΩ load with a voltmeter across it. With
 * `inductor: false` the coil is left out (an RC).
 */
function twoGenerators(fast: number, slow: number, { inductor = true } = {}) {
  const components: Comp[] = [
    { id: 'g1', metadataId: 'signal-generator', properties: { waveform: 'sine', frequency: fast, amplitude: 1, offset: 0 } },
    { id: 'r1', metadataId: 'resistor', properties: { value: '10' } },
    ...(inductor ? [{ id: 'l1', metadataId: 'inductor', properties: { value: '1m' } }] : []),
    { id: 'c1', metadataId: 'capacitor', properties: { value: '1u' } },
    { id: 'g2', metadataId: 'signal-generator', properties: { waveform: 'sine', frequency: slow, amplitude: 1, offset: 0 } },
    { id: 'r2', metadataId: 'resistor', properties: { value: '1k' } },
    { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
  ];
  const wires: Wire[] = [
    w('w1', ['g1', 'SIG'], ['r1', '1']),
    ...(inductor
      ? [w('w2', ['r1', '2'], ['l1', '1']), w('w3', ['l1', '2'], ['c1', '1'])]
      : [w('w2', ['r1', '2'], ['c1', '1'])]),
    w('w4', ['c1', '2'], ['g1', 'GND']),
    w('w5', ['g2', 'SIG'], ['r2', '1']),
    w('w6', ['r2', '2'], ['g2', 'GND']),
    w('w7', ['g1', 'GND'], ['g2', 'GND']),
    w('w8', ['vm', 'V+'], ['r2', '1']),
    w('w9', ['vm', 'V-'], ['g2', 'GND']),
  ];
  return { components, wires };
}

/**
 * A 1 kHz, 0-5 V square wave into 100 Ω, 10 mH and `cap` in series (with
 * `inductor: false`, the same RC), a voltmeter across the capacitor. With
 * `diode: true` a 1N4007 leads the chain.
 */
function squareRlc(cap: string, { inductor = true, diode = false } = {}) {
  const components: Comp[] = [
    { id: 'g', metadataId: 'signal-generator', properties: { waveform: 'square', frequency: 1000, amplitude: 2.5, offset: 2.5 } },
    ...(diode ? [{ id: 'd', metadataId: 'diode-1n4007', properties: {} }] : []),
    { id: 'r', metadataId: 'resistor', properties: { value: '100' } },
    ...(inductor ? [{ id: 'l', metadataId: 'inductor', properties: { value: '10m' } }] : []),
    { id: 'c', metadataId: 'capacitor', properties: { value: cap } },
    { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
  ];
  const wires: Wire[] = [
    ...(diode ? [w('w0', ['g', 'SIG'], ['d', 'A']), w('w1', ['d', 'C'], ['r', '1'])] : [w('w1', ['g', 'SIG'], ['r', '1'])]),
    ...(inductor
      ? [w('w2', ['r', '2'], ['l', '1']), w('w3', ['l', '2'], ['c', '1'])]
      : [w('w2', ['r', '2'], ['c', '1'])]),
    w('w4', ['c', '2'], ['g', 'GND']),
    w('w5', ['vm', 'V+'], ['c', '1']),
    w('w6', ['vm', 'V-'], ['g', 'GND']),
  ];
  return { components, wires };
}

/**
 * A 1 kHz, 1 V sine into 10 kΩ, 1 mH and 4.7 µF in series (with
 * `inductor: false`, the same RC), a voltmeter across the capacitor: a
 * low-pass whose time constant (47 ms) outlasts its 5 ms window.
 */
function sineLowPass({ inductor = true } = {}) {
  const components: Comp[] = [
    { id: 'g', metadataId: 'signal-generator', properties: { waveform: 'sine', frequency: 1000, amplitude: 1, offset: 0 } },
    { id: 'r', metadataId: 'resistor', properties: { value: '10k' } },
    ...(inductor ? [{ id: 'l', metadataId: 'inductor', properties: { value: '1m' } }] : []),
    { id: 'c', metadataId: 'capacitor', properties: { value: '4.7u' } },
    { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
  ];
  const wires: Wire[] = [
    w('w1', ['g', 'SIG'], ['r', '1']),
    ...(inductor
      ? [w('w2', ['r', '2'], ['l', '1']), w('w3', ['l', '2'], ['c', '1'])]
      : [w('w2', ['r', '2'], ['c', '1'])]),
    w('w4', ['c', '2'], ['g', 'GND']),
    w('w5', ['vm', 'V+'], ['c', '1']),
    w('w6', ['vm', 'V-'], ['g', 'GND']),
  ];
  return { components, wires };
}

/** The deck's .tran card, as numbers (start 0 when it runs no start-up). */
function tranCard(components: Comp[], wires: Wire[]): { step: number; stop: number; start: number } {
  const { netlist } = buildNetlist(buildInputFromStore({ components, wires: wires as never, boards: [] }));
  const line = netlist.split('\n').find((l) => l.startsWith('.tran '));
  expect(line, '.tran card').toBeDefined();
  const [, step, stop, start] = line!.split(/\s+/);
  return { step: Number(step), stop: Number(stop), start: start === undefined ? 0 : Number(start) };
}

async function meterReading(components: Comp[], wires: Wire[]) {
  const input = buildInputFromStore({ components, wires: wires as never, boards: [] });
  const solve = await solveInput(input);
  const v = readVoltmeter(
    components.find((c) => c.id === 'vm')!,
    (c, p) => solve.pinNetMap.get(`${c}:${p}`) ?? null,
    solve,
    solve.timeWaveforms,
  );
  expect(v.ac).toBeDefined();
  return v.ac!;
}

describe('a resonant deck keeps the window a plain deck gets', () => {
  it.each([
    // [fast, slow, what the voltmeter read]
    [5000, 50, 'RMS 681.08 mV, DC -444.85 mV'],
    [2000, 20, 'RMS 681.08 mV, DC -444.85 mV'],
  ] as const)(
    'a %d Hz RLC next to a %d Hz generator: four slow periods at the resonant step (it read %s)',
    { timeout: 120_000 },
    async (fast, slow, _was) => {
      const rlc = twoGenerators(fast, slow);
      const ac = await meterReading(rlc.components, rlc.wires);
      expect(Math.abs(ac.rms - Math.SQRT1_2), `RMS ${ac.rms}`).toBeLessThan(1e-3);
      expect(Math.abs(ac.dc), `DC ${ac.dc}`).toBeLessThan(1e-3);

      const card = tranCard(rlc.components, rlc.wires);
      // The integration keeps #121's step, a hundredth of the fast period...
      expect(card.step).toBeCloseTo(1 / (fast * 100), 12);
      // ...and the window is the RC's: four periods of the slow source.
      const rc = twoGenerators(fast, slow, { inductor: false });
      const rcCard = tranCard(rc.components, rc.wires);
      expect(rcCard.stop - rcCard.start).toBeCloseTo(4 / slow, 9);
      expect(card.stop - card.start).toBeCloseTo(4 / slow, 9);
    },
  );
});

describe('a resonant deck keeps the start-up a plain deck gets', () => {
  it.each([
    // [C, what the capacitor read]
    ['470u', 'DC 2.229 V'],
    ['1000u', 'DC 1.619 V'],
  ] as const)(
    'a 1 kHz square into 100 Ω, 10 mH and %s settles as long as the same RC (it read %s)',
    { timeout: 120_000 },
    async (cap, _was) => {
      const rlc = squareRlc(cap);
      // The square wave's mean, 2.5 V, less what a start-up cut at its budget
      // leaves (2.484 V for 1000 µF, as the RC reads).
      const ac = await meterReading(rlc.components, rlc.wires);
      expect(Math.abs(ac.dc - 2.5), `DC ${ac.dc}`).toBeLessThan(0.02);

      const rc = squareRlc(cap, { inductor: false });
      const card = tranCard(rlc.components, rlc.wires);
      const rcCard = tranCard(rc.components, rc.wires);
      expect(card.step).toBeCloseTo(1 / (1000 * 100), 12);
      expect(rcCard.step).toBeCloseTo(1 / (1000 * 20), 12);
      // Seven time constants of 100 Ω × C (0.329 s for 470 µF), or the
      // budget of 10 000 plain steps (0.5 s) for 1000 µF.
      expect(rcCard.start).toBeGreaterThanOrEqual(0.329 - 1e-9);
      expect(card.start).toBeCloseTo(rcCard.start, 9);
    },
  );

  it('a sine-driven LC filter settles as long as the same RC (10 kΩ, 1 mH, 4.7 µF at 1 kHz)', { timeout: 120_000 }, async () => {
    // Seven time constants are 0.329 s: within 10 000 plain steps (0.5 s),
    // not within 10 000 of the deck's finer ones (0.1 s), which the rule for
    // sine-driven decks (velxio/velxio-prod#120) would call too slow to run.
    const lc = sineLowPass();
    const ac = await meterReading(lc.components, lc.wires);
    // |H| = 1 / |1 - ω²LC + jωRC| at 1 kHz: 3.386 mV peak.
    const omega = 2 * Math.PI * 1000;
    const A = 1 / Math.hypot(1 - omega * omega * 1e-3 * 4.7e-6, omega * 10e3 * 4.7e-6);
    expect(Math.abs(ac.dc), `DC ${ac.dc}`).toBeLessThan(A * 0.01);
    expect(Math.abs(ac.rms - A * Math.SQRT1_2) / (A * Math.SQRT1_2), `RMS ${ac.rms}`).toBeLessThan(0.015);

    const card = tranCard(lc.components, lc.wires);
    const rc = sineLowPass({ inductor: false });
    const rcCard = tranCard(rc.components, rc.wires);
    expect(card.step).toBeCloseTo(1 / (1000 * 100), 12);
    expect(rcCard.start).toBeGreaterThanOrEqual(0.329 - 1e-9);
    expect(card.start).toBeCloseTo(rcCard.start, 9);
  });

  it('a resonant deck that holds a diode runs at the resonant step, not half of it', () => {
    // A diode's conduction pulses want half the plain step (T/40); a resonant
    // deck already runs at T/100.
    const rlc = squareRlc('100u', { diode: true });
    const card = tranCard(rlc.components, rlc.wires);
    expect(card.start).toBeGreaterThan(0);
    expect(card.step).toBeCloseTo(1 / (1000 * 100), 12);
    // Without the coil the diode deck keeps its half step.
    const rc = squareRlc('100u', { diode: true, inductor: false });
    expect(tranCard(rc.components, rc.wires).step).toBeCloseTo(1 / (1000 * 40), 12);
  });
});
