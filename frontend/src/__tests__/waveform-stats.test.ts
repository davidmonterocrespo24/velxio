/**
 * Unit tests for `waveformStats.ts` — the time-domain helpers that instrument
 * components (Voltmeter, Ammeter, Overlay) use to display AC values.
 */
import { describe, it, expect } from 'vitest';
import {
  rms,
  mean,
  peak,
  peakToPeak,
  isAC,
  subtract,
  interpolateAt,
} from '../simulation/spice/waveformStats';

/** Generate `n` samples of a sine wave with amplitude `amp` and DC offset `dc`. */
function sine(n: number, amp: number, dc = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(dc + amp * Math.sin((2 * Math.PI * i) / n));
  }
  return out;
}

describe('rms', () => {
  it('returns 0 for an empty array', () => {
    expect(rms([])).toBe(0);
  });

  it('returns |x| for a single DC sample', () => {
    expect(rms([5])).toBe(5);
    expect(rms([-3])).toBe(3);
  });

  it('returns |x| for a constant waveform', () => {
    expect(rms([2, 2, 2, 2])).toBe(2);
  });

  it('returns amp/√2 for a pure sine (classic AC RMS)', () => {
    const samples = sine(1024, 5);
    expect(rms(samples)).toBeCloseTo(5 / Math.sqrt(2), 2);
  });

  it('returns sqrt(amp²/2 + dc²) for sine + DC offset', () => {
    const samples = sine(1024, 5, 3);
    const expected = Math.sqrt(25 / 2 + 9);
    expect(rms(samples)).toBeCloseTo(expected, 2);
  });
});

describe('mean', () => {
  it('returns 0 for an empty array', () => {
    expect(mean([])).toBe(0);
  });

  it('returns the arithmetic mean', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });

  it('returns ≈ 0 for a pure centered sine', () => {
    expect(mean(sine(1024, 5))).toBeCloseTo(0, 2);
  });

  it('recovers the DC offset of a biased sine', () => {
    expect(mean(sine(1024, 5, 3))).toBeCloseTo(3, 2);
  });
});

describe('peak', () => {
  it('returns max absolute value', () => {
    expect(peak([1, -3, 2, -0.5])).toBe(3);
  });

  it('returns 0 for an empty array', () => {
    expect(peak([])).toBe(0);
  });

  it('returns amplitude for a pure sine', () => {
    expect(peak(sine(1024, 4.2))).toBeCloseTo(4.2, 2);
  });
});

describe('peakToPeak', () => {
  it('returns max − min', () => {
    expect(peakToPeak([1, -3, 2, -0.5])).toBe(5);
  });

  it('returns 0 for constant waveform', () => {
    expect(peakToPeak([7, 7, 7])).toBe(0);
  });
});

describe('isAC', () => {
  it('is false for constant DC', () => {
    expect(isAC([3.3, 3.3, 3.3])).toBe(false);
  });

  it('is false for very small ripple below epsilon', () => {
    expect(isAC([3.3, 3.30001, 3.3], 1e-4)).toBe(false);
  });

  it('is true for audible AC', () => {
    expect(isAC(sine(256, 1))).toBe(true);
  });
});

describe('subtract', () => {
  it('element-wise subtracts same-length arrays', () => {
    expect(subtract([5, 6, 7], [1, 2, 3])).toEqual([4, 4, 4]);
  });

  it('clips to the shorter length', () => {
    expect(subtract([5, 6, 7, 8], [1, 2])).toEqual([4, 4]);
  });
});

describe('interpolateAt', () => {
  const ts = [0, 1, 2, 3, 4];
  const vs = [0, 2, 4, 6, 8]; // linear y=2t

  it('returns exact value at a knot', () => {
    expect(interpolateAt(ts, vs, 2)).toBe(4);
  });

  it('linearly interpolates between knots', () => {
    expect(interpolateAt(ts, vs, 1.5)).toBe(3);
  });

  it('clamps below the first knot', () => {
    expect(interpolateAt(ts, vs, -99)).toBe(0);
  });

  it('clamps above the last knot', () => {
    expect(interpolateAt(ts, vs, 999)).toBe(8);
  });

  it('handles empty arrays', () => {
    expect(interpolateAt([], [], 5)).toBe(0);
  });
});
