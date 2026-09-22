/**
 * Board buses perf baseline: the frame clock and the result record the bench
 * suites share (project/board-buses-2026-09, DESIGN section 11, D-007).
 *
 * Not a *.test.ts: vitest only collects `*.test.ts`, so this is a helper and
 * not an empty suite. The pro overlay's ESP32 benches keep their own copy of
 * the same record (pro/frontend/src/pro/esp32sim/__tests__/perf/perfKit.ts):
 * importing across the submodule would break the pro suite on any velxio
 * pointer that predates this file. harness/bus-perf.mjs reads both and checks
 * the schema tag, so the two copies cannot drift silently.
 *
 * Opt-in: nothing here runs unless BUS_PERF=1 (see `perfEnabled`). With
 * BUS_PERF_OUT set, the suite writes its results there as JSON; without it,
 * it prints one line per bench.
 */
import { loadavg } from 'node:os';
import { writeFileSync } from 'node:fs';

export const PERF_SCHEMA = 'bus-perf/1';

export const perfEnabled = process.env.BUS_PERF === '1';

/** Process CPU time (user + system) in ms. Load on a shared machine inflates
 *  wall time far more than it inflates CPU time, so both are recorded. */
const cpuMs = (): number => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

export interface FrameSample {
  wallMs: number;
  cpuMs: number;
  /** Guest time the frame took, when the firmware reports it. */
  guestUs?: number;
  /** Bus bytes the frame clocked, when the bench counts them. */
  bytes?: number;
}

/** Laps one sample per frame boundary. `start()` opens the first frame. */
export class FrameClock {
  readonly samples: FrameSample[] = [];
  private wall = 0;
  private cpu = 0;

  start(): void {
    this.wall = performance.now();
    this.cpu = cpuMs();
  }

  lap(extra: { guestUs?: number; bytes?: number } = {}): void {
    const wall = performance.now();
    const cpu = cpuMs();
    this.samples.push({ wallMs: wall - this.wall, cpuMs: cpu - this.cpu, ...extra });
    this.wall = wall;
    this.cpu = cpu;
  }
}

export interface Stats {
  median: number;
  min: number;
  max: number;
  mean: number;
  all: number[];
}

export function stats(values: number[]): Stats {
  const all = values.map((v) => Math.round(v * 1000) / 1000);
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return { median: r(median), min: r(sorted[0]), max: r(sorted[sorted.length - 1]), mean: r(mean), all };
}

export interface BenchSpec {
  /** Stable id, the same across phases: `<board>.<part>.<workload>`. */
  bench: string;
  /**
   * `full`: engine + today's bus path + the real part decoder.
   * `bare`: the same engine and workload with nothing on the bus but a byte
   * counter, so `full - bare` is what the bus path and the decoder cost.
   */
  config: 'full' | 'bare';
  engine: string;
  part: string;
  /** How the bytes are produced: real firmware, or the SoC's SPI registers. */
  drive: 'firmware' | 'registers';
  /** The code path a byte takes in this configuration, engine outward. */
  path: string;
  pixelBytesPerFrame: number;
  warmupFrames: number;
}

export interface BenchResult extends BenchSpec {
  name: string;
  bytesPerFrame: number;
  frames: number;
  wallMsPerFrame: Stats;
  cpuMsPerFrame: Stats;
  /** bytesPerFrame over the median frame time. */
  bytesPerSecWall: number;
  bytesPerSecCpu: number;
  guestUsPerFrame?: number;
  /** What the bench checked before it trusted its numbers. */
  verified: string;
  loadavg: { start: number[]; end: number[] };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Build a result from the samples after the warm-up frames. */
export function result(
  spec: BenchSpec,
  samples: FrameSample[],
  bytesPerFrame: number,
  verified: string,
  load: { start: number[]; end: number[] },
): BenchResult {
  const measured = samples.slice(spec.warmupFrames);
  if (!measured.length) throw new Error(`${spec.bench}: no measured frames`);
  const wall = stats(measured.map((s) => s.wallMs));
  const cpu = stats(measured.map((s) => s.cpuMs));
  const guest = measured.map((s) => s.guestUs).filter((v): v is number => typeof v === 'number');
  return {
    ...spec,
    name: `${spec.bench}.${spec.config}`,
    bytesPerFrame,
    frames: measured.length,
    wallMsPerFrame: wall,
    cpuMsPerFrame: cpu,
    bytesPerSecWall: Math.round(bytesPerFrame / (wall.median / 1000)),
    bytesPerSecCpu: Math.round(bytesPerFrame / (cpu.median / 1000)),
    guestUsPerFrame: guest.length ? stats(guest).median : undefined,
    verified,
    loadavg: { start: load.start.map(round2), end: load.end.map(round2) },
  };
}

export const loadNow = (): number[] => loadavg();

/** Collects a suite's results and writes them where the runner asked. */
export class PerfReport {
  readonly results: BenchResult[] = [];
  private readonly startedAt = new Date().toISOString();
  private readonly loadStart = loadNow();
  private readonly suite: string;

  constructor(suite: string) {
    this.suite = suite;
  }

  add(r: BenchResult): void {
    this.results.push(r);
    // One line per bench, for a run without the harness.
    console.info(
      `[bus-perf] ${r.name}: ${r.wallMsPerFrame.median} ms/frame wall, ` +
        `${r.cpuMsPerFrame.median} ms/frame cpu, ${(r.bytesPerSecWall / 1e6).toFixed(3)} MB/s, ` +
        `${r.bytesPerFrame} B/frame, load ${r.loadavg.start[0]}`,
    );
  }

  write(): void {
    const out = process.env.BUS_PERF_OUT;
    if (!out) return;
    const doc = {
      schema: PERF_SCHEMA,
      suite: this.suite,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      node: process.version,
      loadavg: { start: this.loadStart.map(round2), end: loadNow().map(round2) },
      results: this.results,
    };
    writeFileSync(out, JSON.stringify(doc, null, 2));
  }
}
