/**
 * Time-domain statistics for SPICE `.tran` waveforms.
 *
 * Used by instruments (voltmeter, ammeter, overlay) to display physically
 * meaningful AC values — RMS for "steady-state AC reading", peak for
 * "scope cursor", and DC component for the underlying bias.
 *
 * Also houses the linear interpolator used by the per-read ADC hook.
 */

/** Root-mean-square: sqrt(mean(x²)). For a pure sine, Vpk/√2. */
export function rms(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (const s of samples) sumSq += s * s;
  return Math.sqrt(sumSq / samples.length);
}

/** Arithmetic mean (DC component). */
export function mean(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s;
  return sum / samples.length;
}

/** Maximum absolute value. */
export function peak(samples: readonly number[]): number {
  let p = 0;
  for (const s of samples) {
    const a = Math.abs(s);
    if (a > p) p = a;
  }
  return p;
}

/** Max − min. */
export function peakToPeak(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  let min = samples[0];
  let max = samples[0];
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    if (s < min) min = s;
    if (s > max) max = s;
  }
  return max - min;
}

/** True if the signal has any AC content above `epsilon` peak-to-peak. */
export function isAC(samples: readonly number[], epsilon = 1e-4): boolean {
  return peakToPeak(samples) > epsilon;
}

/**
 * Element-wise difference of two waveforms sampled on the same time base.
 * If lengths differ, the shorter wins. Used by voltmeter (probe+ − probe−).
 */
export function subtract(a: readonly number[], b: readonly number[]): number[] {
  const n = Math.min(a.length, b.length);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = a[i] - b[i];
  return out;
}

/**
 * Linear interpolation across a (time, value) table. `ts` must be
 * monotonically increasing. Clamps to the endpoints if `t` is outside range.
 * O(log n) via binary search — safe to call at >1 kHz rates.
 */
export function interpolateAt(ts: readonly number[], vs: readonly number[], t: number): number {
  if (ts.length === 0) return 0;
  if (t <= ts[0]) return vs[0];
  const lastIdx = ts.length - 1;
  if (t >= ts[lastIdx]) return vs[lastIdx];
  let lo = 0;
  let hi = lastIdx;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid;
  }
  const t0 = ts[lo];
  const t1 = ts[hi];
  if (t1 === t0) return vs[lo];
  const a = (t - t0) / (t1 - t0);
  return vs[lo] * (1 - a) + vs[hi] * a;
}
