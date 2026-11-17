/**
 * A circuit driven by a sine is read in its steady state too, when its own
 * time constant outlasts the first half of the window (velxio/velxio-prod#120).
 *
 * A sine starts at its offset, so the operating point at t = 0 holds the
 * circuit's DC steady state, and the start-up the deck skips (settleTime.ts)
 * was run only for square waves and diodes. But each capacitor also starts
 * without its share of the AC, and that difference decays with the circuit's
 * time constant. The window is four periods (at least 5 ms) and the meters
 * read its second half, so a slow filter was read in its start-up: a 1 kHz,
 * 1 V sine into 10 kΩ / 1 µF (τ = 10 ms) read pk 26.88 mV, DC 10.59 mV and
 * RMS 15.40 mV across the capacitor, for a steady state of 15.91 mV peak,
 * no DC and 11.25 mV RMS. Now such a deck runs seven time constants first
 * when that fits the start-up's budget of steps.
 * Runs the app's analysis, netlist builder and ngspice (the Node adapter).
 */
import { describe, it, expect } from 'vitest';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { readVoltmeter } from '../simulation/spice/probes';
import { solveInput } from './helpers/solveInput';
import { exampleProjects } from '../data/examples';
import { exampleToBuildNetlistInput } from '../utils/exampleToBuildNetlistInput';

type Comp = { id: string; metadataId: string; properties: Record<string, unknown> };
type Wire = { id: string; start: { componentId: string; pinName: string }; end: { componentId: string; pinName: string } };
const w = (id: string, a: [string, string], b: [string, string]): Wire => ({
  id,
  start: { componentId: a[0], pinName: a[1] },
  end: { componentId: b[0], pinName: b[1] },
});

/** A 1 V sine into R then C, with a voltmeter across C (a low-pass). */
function lowPass(r: string, c: string, frequency: number): { components: Comp[]; wires: Wire[] } {
  return {
    components: [
      { id: 'sg', metadataId: 'signal-generator', properties: { waveform: 'sine', frequency, amplitude: 1, offset: 0 } },
      { id: 'r1', metadataId: 'resistor', properties: { value: r } },
      { id: 'c1', metadataId: 'capacitor', properties: { value: c } },
      { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
    ],
    wires: [
      w('w1', ['sg', 'SIG'], ['r1', '1']),
      w('w2', ['r1', '2'], ['c1', '1']),
      w('w3', ['c1', '2'], ['sg', 'GND']),
      w('w4', ['vm', 'V+'], ['c1', '1']),
      w('w5', ['vm', 'V-'], ['sg', 'GND']),
    ],
  };
}

/** The steady-state amplitude across C: 1 / sqrt(1 + (ωRC)²). */
const amplitude = (R: number, C: number, f: number) => 1 / Math.hypot(1, 2 * Math.PI * f * R * C);

async function reading(r: string, c: string, f: number) {
  const { components, wires } = lowPass(r, c, f);
  const input = buildInputFromStore({ components, wires: wires as never, boards: [] });
  const solve = await solveInput(input);
  const v = readVoltmeter(
    components[3]!,
    (cc, p) => solve.pinNetMap.get(`${cc}:${p}`) ?? null,
    solve,
    solve.timeWaveforms,
  );
  expect(v.ac).toBeDefined();
  return { ac: v.ac!, tw: solve.timeWaveforms! };
}

/** The deck's .tran card, as numbers. */
function tranCard(components: Comp[], wires: Wire[]): { step: number; stop: number; start: number } {
  const { netlist } = buildNetlist(buildInputFromStore({ components, wires: wires as never, boards: [] }));
  const line = netlist.split('\n').find((l) => l.startsWith('.tran '));
  expect(line, '.tran card').toBeDefined();
  const [, step, stop, start] = line!.split(/\s+/);
  return { step: Number(step), stop: Number(stop), start: start === undefined ? 0 : Number(start) };
}

describe('a sine-driven filter slower than its window is read settled', () => {
  it.each([
    // [R, C, f, what it read: pk / DC / RMS]
    ['10k', '1u', 1000, 'pk 26.88 mV, DC 10.59 mV, RMS 15.40 mV'],
    ['10k', '10u', 50, 'pk 50.39 mV, DC 17.42 mV, RMS 28.38 mV'],
    ['10k', '100n', 1000, 'pk 160.20 mV, DC 3.28 mV, RMS 110.34 mV'],
  ] as const)('%s / %s at %d Hz reads its steady state (it read %s)', { timeout: 60_000 }, async (r, c, f) => {
    const R = Number(r.replace('k', 'e3'));
    const C = Number(c.replace('u', 'e-6').replace('n', 'e-9'));
    const A = amplitude(R, C, f);
    const { ac } = await reading(r, c, f);
    // The meter's own 10 MΩ and the step's frequency shift (ωh up to π/10:
    // up to 0.8 % at f well above the corner) keep it within 1.5 %.
    expect(Math.abs(ac.rms - A * Math.SQRT1_2) / (A * Math.SQRT1_2)).toBeLessThan(0.015);
    expect(Math.abs(ac.peak - A) / A).toBeLessThan(0.025);
    expect(Math.abs(ac.dc)).toBeLessThan(A * 0.01);
  });

  it('the deck runs seven time constants first, in whole periods, and stores the same four-period window from t = 0', async () => {
    const { components, wires } = lowPass('10k', '1u', 1000);
    const card = tranCard(components, wires);
    expect(card.step).toBeCloseTo(1 / (1000 * 20), 12);
    expect(card.start).toBeGreaterThanOrEqual(0.07); // 7 × 10 ms
    expect(card.start).toBeLessThan(0.07 + 1e-3 + 1e-9);
    expect(Math.abs(card.start * 1000 - Math.round(card.start * 1000))).toBeLessThan(1e-6);
    expect(card.stop - card.start).toBeCloseTo(5e-3, 9);
    const { tw } = await reading('10k', '1u', 1000);
    expect(tw.time[0]!).toBeGreaterThanOrEqual(0);
    expect(tw.time[0]!).toBeLessThan(1e-4);
    expect(tw.time.at(-1)!).toBeCloseTo(5e-3, 6);
  });

  it('a filter that settles within the first half of its window runs no start-up (the book\'s 1 kΩ / 160 nF)', () => {
    // τ = 0.16 ms: seven of them are over 1.12 ms into the 5 ms window, long
    // before the 2.5 ms the meters start reading at.
    const { components, wires } = lowPass('1k', '160n', 1000);
    expect(tranCard(components, wires).start).toBe(0);
  });

  it('a time constant too long for the start-up budget runs none: the amplifiers keep their window', () => {
    // 10 µF through a 1 MΩ / 470 kΩ gate divider is 3.2 s, and the BJT's input
    // coupling 82 ms: seven of either is more than 10 000 steps of T/20 at
    // 1 kHz. A coupling capacitor's share of the AC is a ripple-sized part of
    // the signal it passes, so the reading does not need it.
    for (const id of ['an-mosfet-common-source', 'an-bjt-common-emitter']) {
      const ex = exampleProjects.find((e) => e.id === id)!;
      const { netlist } = buildNetlist(exampleToBuildNetlistInput(ex));
      const line = netlist.split('\n').find((l) => l.startsWith('.tran '))!;
      expect(line.split(/\s+/), id).toHaveLength(3);
    }
    // 10 kΩ / 100 µF at 1 kHz: τ = 1 s, seven of them are 140 000 steps.
    const { components, wires } = lowPass('10k', '100u', 1000);
    expect(tranCard(components, wires).start).toBe(0);
  });
});
