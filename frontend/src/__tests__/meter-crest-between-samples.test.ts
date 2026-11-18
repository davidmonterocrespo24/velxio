/**
 * A meter's peak and swing take a smooth crest between the samples, and leave
 * corners where the samples put them (velxio/velxio-prod#120, #125).
 *
 * ngspice stores a sine at about a twentieth of its period, and a crest falls
 * anywhere between two samples: the largest sample is up to 1 - cos(π/20) =
 * 1.2 % under it. The meters took the largest sample, so the book's
 * 1 kΩ / 160 nF high-pass at 5 kHz read 975.15 mV for 980.78 mV, and a swing
 * peak to peak (#125) came out short by as much. The vertex of the parabola
 * through the crest's three samples is within 0.03 % of a sine's crest at
 * that step. A corner is not a crest a parabola describes, so a clipped top,
 * a square wave, a triangle, a capacitor's charge-then-discharge peak and a
 * spike keep their largest sample: none may read above its true maximum.
 */
import { describe, it, expect } from 'vitest';
import { spanStats } from '../simulation/spice/waveformStats';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { readVoltmeter } from '../simulation/spice/probes';
import { solveInput } from './helpers/solveInput';
import type { Wire } from '../types/wire';

const T = 1e-3;

/** `f` sampled over five periods at the times `grid` returns for each period. */
function sampled(f: (t: number) => number, grid: (k: number) => number[]) {
  const time: number[] = [];
  for (let k = 0; k < 5; k++) time.push(...grid(k));
  time.push(5 * T);
  return { time, x: time.map(f) };
}

/** Twenty even samples a period, shifted by `phase` (0..1) of a step. */
const even = (phase: number) => (k: number) =>
  Array.from({ length: 20 }, (_, j) => k * T + ((j + phase) * T) / 20).filter((t) => t >= 0);

/** Uneven steps between T/30 and T/14, the way ngspice's step wanders. */
const uneven = (k: number) => {
  const out: number[] = [];
  const steps = [1 / 30, 1 / 14, 1 / 22, 1 / 17, 1 / 25, 1 / 19, 1 / 15, 1 / 28];
  let t = k * T;
  for (let j = 0; t < (k + 1) * T - 1e-12; j++) {
    out.push(t);
    t += steps[(j + k) % steps.length]! * T;
  }
  return out;
};

const span = { from: 2 * T, to: 5 * T };
const sine = (t: number) => Math.sin((2 * Math.PI * t) / T);

describe('a smooth crest between two samples', () => {
  it('a sine sampled at T/20 reads its crest and its trough within 0.05 %, at any phase (it read up to 1.2 % short)', () => {
    let worst = 0;
    for (let p = 0; p < 1; p += 0.1) {
      const { time, x } = sampled(sine, even(p));
      const st = spanStats(time, x, span)!;
      worst = Math.max(worst, Math.abs(st.max - 1), Math.abs(st.min + 1));
    }
    expect(worst).toBeLessThan(5e-4);
  });

  it('on uneven steps too, within 0.1 %', () => {
    for (const shift of [0, 0.13e-3, 0.37e-3]) {
      const { time, x } = sampled((t) => 2 + 0.6 * sine(t + shift), uneven);
      const st = spanStats(time, x, span)!;
      expect(Math.abs(st.max - 2.6), `max, shift ${shift}`).toBeLessThan(2.6e-3 * 0.6);
      expect(Math.abs(st.min - 1.4), `min, shift ${shift}`).toBeLessThan(1e-3 * 0.6);
    }
  });
});

describe('a corner keeps its largest sample', () => {
  const shapes: Array<[string, (t: number) => number, number, number]> = [
    // [name, waveform, its true maximum, its true minimum]
    ['a sine clipped at ±0.8', (t) => Math.max(-0.8, Math.min(0.8, sine(t))), 0.8, -0.8],
    ['a triangle', (t) => 1 - 4 * Math.abs(((t / T + 0.25) % 1) - 0.5), 1, -1],
    [
      'a capacitor charged and discharged by a square wave (τ = T/10)',
      (t) => {
        const u = (t / T) % 1;
        const top = 1 - Math.exp(-5);
        return u < 0.5 ? 1 - Math.exp(-u * 10) : top * Math.exp(-(u - 0.5) * 10);
      },
      1 - Math.exp(-5),
      0,
    ],
    ['a square wave', (t) => (((t / T) % 1) < 0.5 ? 5 : 0), 5, 0],
    ['a spike decaying after each edge', (t) => Math.exp(-((t / T) % 1) * 40), 1, Math.exp(-40)],
  ];
  for (const [name, f, top, bottom] of shapes) {
    it(`${name} reads no more than its true maximum, and no less than its true minimum`, () => {
      for (const grid of [even(0), even(0.3), even(0.5), even(0.77), uneven]) {
        const { time, x } = sampled(f, grid);
        const st = spanStats(time, x, span)!;
        expect(st.max).toBeLessThanOrEqual(top + 1e-12);
        expect(st.min).toBeGreaterThanOrEqual(bottom - 1e-12);
      }
    });
  }
});

describe("the book's high-pass, through ngspice", () => {
  it('1 kΩ / 160 nF at 5 kHz swings twice 980.8 mV within 0.2 % (its largest samples are 0.6 % short)', { timeout: 60_000 }, async () => {
    const wire = (id: string, a: [string, string], b: [string, string]) =>
      ({ id, start: { componentId: a[0], pinName: a[1] }, end: { componentId: b[0], pinName: b[1] } }) as Wire;
    const components = [
      { id: 'sg', metadataId: 'signal-generator', properties: { waveform: 'sine', frequency: 5000, amplitude: 1, offset: 0 } },
      { id: 'c1', metadataId: 'capacitor', properties: { value: '160n' } },
      { id: 'r1', metadataId: 'resistor', properties: { value: '1k' } },
      { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
    ];
    const wires = [
      wire('w1', ['sg', 'SIG'], ['c1', '1']),
      wire('w2', ['c1', '2'], ['r1', '1']),
      wire('w3', ['r1', '2'], ['sg', 'GND']),
      wire('w4', ['vm', 'V+'], ['r1', '1']),
      wire('w5', ['vm', 'V-'], ['sg', 'GND']),
    ];
    const solve = await solveInput(buildInputFromStore({ components, wires, boards: [] }));
    const v = readVoltmeter(components[3]!, (c, p) => solve.pinNetMap.get(`${c}:${p}`) ?? null, solve, solve.timeWaveforms);
    const x = 2 * Math.PI * 5000 * 1e3 * 160e-9;
    const amplitude = x / Math.hypot(1, x); // 980.78 mV
    expect(Math.abs(v.ac!.peakToPeak / 2 - amplitude) / amplitude).toBeLessThan(0.002);
    expect(Math.abs(v.ac!.peak - amplitude) / amplitude).toBeLessThan(0.002);
  });
});
