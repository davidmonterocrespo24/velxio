/**
 * Time-domain statistics for SPICE `.tran` waveforms.
 *
 * Used by instruments (voltmeter, ammeter, overlay) to display physically
 * meaningful AC values — RMS for "steady-state AC reading", peak for
 * "scope cursor", and DC component for the underlying bias.
 *
 * Also houses the linear interpolator used by the per-read ADC hook.
 */
import type { TimeWaveforms } from './types';

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
 * The stretch of a transient a meter reads, in seconds of simulated time.
 *
 * Every transient starts at t = 0 from the operating point of that instant
 * (a sine at 0 V, a reservoir capacitor empty) and its window is sized to let
 * the circuit settle first (four periods of the slowest source), so a meter
 * reads the second half of it (395514db: a rectifier's reservoir capacitor
 * charging from 0 V pulled a 5 V regulator output down to "DC 3.47 V").
 *
 * When the period of the slowest source is known, the span is a whole
 * number of periods ending at the end of the window: a mean or an RMS over
 * 2.64 periods of a sine is not the sine's mean or RMS, and the default
 * 1 kHz generator read "DC -91 mV, RMS 692.6 mV" for a 1 V sine
 * (velxio/velxio-prod#100). If the second half holds no whole period, the
 * last period of the window; if the window holds none either, the second
 * half as it is.
 */
export function readSpan(time: readonly number[], period?: number): { from: number; to: number } | null {
  const n = time.length;
  if (n < 2) return null;
  const start = time[0]!;
  const end = time[n - 1]!;
  const length = end - start;
  if (!(length > 0)) return null;
  if (period !== undefined && period > 0) {
    // Whole periods in a stretch, forgiving the rounding of the window's end.
    const whole = (span: number) => Math.floor(span / period + 1e-6);
    const inHalf = whole(length / 2);
    if (inHalf >= 1) return { from: end - inHalf * period, to: end };
    if (whole(length) >= 1) return { from: end - period, to: end };
  }
  return { from: end - length / 2, to: end };
}

/** Time-weighted statistics of a waveform over a span. */
export interface SpanStats {
  /** Mean (the DC a meter reads). */
  mean: number;
  /** Root mean square. */
  rms: number;
  /** Mean of the magnitude (what an LED's light follows). */
  meanAbs: number;
  /** Largest magnitude. */
  peak: number;
  min: number;
  max: number;
}

/**
 * Time-weighted statistics of a sampled waveform over `span`.
 *
 * ngspice keeps the points of its own variable time step, crowded wherever
 * the signal moves fast: after a PULSE edge most of a period's points sit in
 * the first fraction of a millisecond. A plain average of the points counts
 * those moments many times over, so the ammeter of an RC driven by a square
 * wave read 393 µA for a true 157 µA (#100) and an RC-coupled LED glowed at
 * 20 % for a 1 % mean current (#106). Each point is weighted by the time it
 * stands for instead: the trapezoid rule on x and on x² (which is exact for
 * a sine sampled at T/20 over whole periods), and |x| integrated exactly
 * along the straight line between two samples, zero crossing included. The
 * span's ends are interpolated between the samples around them.
 */
export function spanStats(
  time: readonly number[],
  x: readonly number[],
  span: { from: number; to: number },
): SpanStats | null {
  const n = Math.min(time.length, x.length);
  if (n < 2 || !(span.to > span.from)) return null;
  const at = (i: number, t: number): number => {
    const t0 = time[i]!;
    const t1 = time[i + 1]!;
    if (t1 === t0) return x[i]!;
    return x[i]! + ((x[i + 1]! - x[i]!) * (t - t0)) / (t1 - t0);
  };
  let sum = 0;
  let sumSq = 0;
  let sumAbs = 0;
  let total = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n - 1; i++) {
    const t0 = time[i]!;
    const t1 = time[i + 1]!;
    if (t1 <= span.from || t0 >= span.to) continue;
    const a = Math.max(t0, span.from);
    const b = Math.min(t1, span.to);
    const xa = a === t0 ? x[i]! : at(i, a);
    const xb = b === t1 ? x[i + 1]! : at(i, b);
    if (!Number.isFinite(xa) || !Number.isFinite(xb)) return null;
    if (xa < min) min = xa;
    if (xb < min) min = xb;
    if (xa > max) max = xa;
    if (xb > max) max = xb;
    const dt = b - a;
    if (!(dt > 0)) continue;
    total += dt;
    sum += ((xa + xb) / 2) * dt;
    sumSq += ((xa * xa + xb * xb) / 2) * dt;
    const ma = Math.abs(xa);
    const mb = Math.abs(xb);
    sumAbs += xa * xb >= 0 ? ((ma + mb) / 2) * dt : ((xa * xa + xb * xb) / (2 * (ma + mb))) * dt;
  }
  if (!(total > 0)) return null;
  return {
    mean: sum / total,
    rms: Math.sqrt(Math.max(0, sumSq / total)),
    meanAbs: sumAbs / total,
    peak: Math.max(Math.abs(min), Math.abs(max)),
    min,
    max,
  };
}

/**
 * The weighted mean, sample by sample, of several captures of one deck: what
 * a reader that integrates over time sees of a circuit that alternates
 * between those states faster than it reads them. A PWM pad on a static load
 * is its HIGH and LOW states weighted by the duty (CircuitSimulationService),
 * and with a generator on the canvas each of them is a transient of its own:
 * the generator's net is the same wave in every one, so it comes out as
 * itself, and a net the pad moves comes out at its mean over the period
 * (velxio/velxio-prod#232).
 *
 * ngspice picks its own time points, so two captures need not share them:
 * then the mix is on the union of their points, each capture read between its
 * own samples by linear interpolation. Only the vectors every capture holds
 * are mixed; the period is the first capture's (one deck, one period). A
 * single capture, or a single one with weight, is returned as it is.
 */
export function mixCaptures(
  parts: ReadonlyArray<{ capture: TimeWaveforms; weight: number }>,
): TimeWaveforms | undefined {
  const used = parts.filter((p) => p.weight > 0 && p.capture.time.length > 0);
  if (used.length === 0) return undefined;
  if (used.length === 1) return used[0]!.capture;
  const total = used.reduce((acc, p) => acc + p.weight, 0);
  const first = used[0]!.capture;
  const shared = used.every(
    (p) => p.capture.time.length === first.time.length && p.capture.time.every((t, i) => t === first.time[i]),
  );
  const time = shared ? first.time.slice() : unionOfTimes(used.map((p) => p.capture.time));
  const mix = (pick: (tw: TimeWaveforms) => Map<string, number[]>): Map<string, number[]> => {
    const out = new Map<string, number[]>();
    for (const key of pick(first).keys()) {
      if (!used.every((p) => pick(p.capture).has(key))) continue;
      const acc = new Array<number>(time.length).fill(0);
      for (const p of used) {
        const samples = pick(p.capture).get(key)!;
        const at = shared ? samples : resampleOnto(p.capture.time, samples, time);
        const w = p.weight / total;
        for (let i = 0; i < time.length; i++) acc[i] += w * at[i]!;
      }
      out.set(key, acc);
    }
    return out;
  };
  return {
    time,
    nodes: mix((tw) => tw.nodes),
    branches: mix((tw) => tw.branches),
    period: first.period,
  };
}

/** Every time point of several monotonic axes, once each, in order. */
function unionOfTimes(axes: ReadonlyArray<readonly number[]>): number[] {
  const all: number[] = [];
  for (const axis of axes) for (const t of axis) all.push(t);
  all.sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of all) if (out.length === 0 || t !== out[out.length - 1]) out.push(t);
  return out;
}

/** A waveform read at other time points, linearly between its own samples
 *  and held at its ends (interpolateAt, walked once for a sorted axis). */
function resampleOnto(time: readonly number[], x: readonly number[], onto: readonly number[]): number[] {
  const n = Math.min(time.length, x.length);
  const out = new Array<number>(onto.length);
  let j = 0;
  for (let i = 0; i < onto.length; i++) {
    const t = onto[i]!;
    while (j + 1 < n && time[j + 1]! <= t) j++;
    if (n === 0) out[i] = NaN;
    else if (t <= time[0]!) out[i] = x[0]!;
    else if (j + 1 >= n) out[i] = x[n - 1]!;
    else {
      const t0 = time[j]!;
      const t1 = time[j + 1]!;
      out[i] = t1 === t0 ? x[j]! : x[j]! + ((x[j + 1]! - x[j]!) * (t - t0)) / (t1 - t0);
    }
  }
  return out;
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
