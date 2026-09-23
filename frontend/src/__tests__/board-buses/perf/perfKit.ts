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

export const PERF_SCHEMA = 'bus-perf/2';

export const perfEnabled = process.env.BUS_PERF === '1';

/** Process CPU time (user + system) in ms. Load on a shared machine inflates
 *  wall time far more than it inflates CPU time, so both are recorded. */
const cpuMs = (): number => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

// ── Machine-speed probe ──────────────────────────────────────────────────────

/*
 * A fixed piece of JS timed next to every frame, so a frame can also be read
 * in units of it. The server these benches run on is production and shared:
 * its load swings 2x within minutes and CPU time moves with it (hyperthread
 * siblings, caches, clock). Two runs of identical code measured one bench 9 %
 * apart, outside the spread of either set of three repetitions, which is a
 * phase blocked by noise. The probe is slowed by the same things at the same
 * moment, so frame / probe is steadier than either alone.
 *
 * The probe lives here, not in velxio code: a phase that changes the bus must
 * not change the ruler. It is shaped like the hot path it rules (calls through
 * a small table of closures, stores into a typed array, an object now and
 * then) and takes about 4 ms on an idle core of the baseline machine.
 */
const PROBE_ITERATIONS = 200_000;
const probeBuf = new Uint8ClampedArray(64 * 1024);
const probeSinks = [
  (v: number, i: number) => {
    probeBuf[i] = v;
    return v;
  },
  (v: number, i: number) => {
    probeBuf[i + 1] = v ^ 0x5a;
    return v + 1;
  },
  (v: number, i: number) => {
    probeBuf[i + 2] = v >> 1;
    return v - 1;
  },
];
let probeKeep = 0;
let probeWarm = false;

function probeOnce(): void {
  let acc = 0;
  const queue: Array<{ k: number; acc: number }> = [];
  for (let k = 0; k < PROBE_ITERATIONS; k++) {
    acc = (acc + probeSinks[k % 3](k & 0xff, ((k * 97) & 0x3fff) * 4)) | 0;
    if ((k & 63) === 0) {
      queue.push({ k, acc });
      if (queue.length > 32) queue.shift();
    }
  }
  probeKeep = (probeKeep + (acc ^ queue.length)) | 0;
}

/** CPU ms the probe takes right now. The first call warms it up (JIT tiers). */
export function probeCpuMs(): number {
  if (!probeWarm) {
    for (let i = 0; i < 30; i++) probeOnce();
    probeWarm = true;
  }
  const t0 = cpuMs();
  probeOnce();
  return cpuMs() - t0;
}

/** Keeps the probe's result observable, so no compiler can drop the loop. */
export const probeChecksum = (): number => probeKeep;

/**
 * Negative control for the phase gate: BUS_PERF_INJECT=<n> makes the `full`
 * benches run n rounds of xorshift on every bus byte, on top of the real path,
 * so a run can prove that harness/bus-perf.mjs --compare catches a slowdown of
 * that size. Zero (the default) in every real measurement; the runner refuses
 * to write the baseline with it set.
 */
export const injectedWorkPerByte = Number(process.env.BUS_PERF_INJECT ?? 0);

let burnKeep = 1;

/**
 * One byte's worth of injected work. Call it once per bus byte, inside the
 * path under test; it does nothing when the control is off. The benches wrap
 * BOTH entry points a byte can take (a frame and a block), because an engine
 * that hands whole W-buffer transactions over calls the frame path for none of
 * them, and wrapping frames alone left the control dead.
 */
export function burnInjectedWork(): void {
  const n = injectedWorkPerByte;
  if (!n) return;
  let x = burnKeep;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
  }
  burnKeep = x | 1;
}

export interface FrameSample {
  wallMs: number;
  cpuMs: number;
  /** The probe's CPU ms: right before the frame, inside it, right after it. */
  probeMs: number[];
  /** Guest time the frame took, when the firmware reports it. */
  guestUs?: number;
  /** Bus bytes the frame clocked, when the bench counts them. */
  bytes?: number;
}

/** Frame CPU ms between two probes inside one frame, so a 500 ms frame is
 *  read against the machine of its whole span, not of its two ends. */
const PROBE_EVERY_MS = 25;

/**
 * Laps one sample per frame boundary; `start()` opens the first frame. The
 * probe runs at every boundary and, through `tick()`, every PROBE_EVERY_MS of
 * frame CPU inside a frame, always outside both clocks.
 */
export class FrameClock {
  readonly samples: FrameSample[] = [];
  private wall = 0;
  private cpu = 0;
  private running = false;
  private lastProbe = 0;
  private probes: number[] = [];

  start(): void {
    this.probes = [probeCpuMs()];
    this.running = true;
    this.wall = performance.now();
    this.cpu = cpuMs();
    this.lastProbe = this.cpu;
  }

  /** Call often from inside a frame (every tick, every row). Cheap unless it is
   *  time to probe; the probe's time is taken off the frame. */
  tick(): void {
    if (!this.running) return;
    const c0 = cpuMs();
    if (c0 - this.lastProbe < PROBE_EVERY_MS) return;
    const w0 = performance.now();
    this.probes.push(probeCpuMs());
    const c1 = cpuMs();
    this.cpu += c1 - c0;
    this.wall += performance.now() - w0;
    this.lastProbe = c1;
  }

  lap(extra: { guestUs?: number; bytes?: number } = {}): void {
    const wall = performance.now();
    const cpu = cpuMs();
    const after = probeCpuMs();
    this.probes.push(after);
    this.samples.push({ wallMs: wall - this.wall, cpuMs: cpu - this.cpu, probeMs: this.probes, ...extra });
    this.probes = [after];
    this.wall = performance.now();
    this.cpu = cpuMs();
    this.lastProbe = this.cpu;
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
  /** Per frame, the mean of the probes around and inside it (CPU ms). */
  probeCpuMs: Stats;
  /**
   * Per frame, its CPU time over the probes around and inside it: the frame
   * in probe units (pu). What harness/bus-perf.mjs compares phases on.
   */
  puPerFrame: Stats;
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
  const probe = measured.map((s) => s.probeMs.reduce((a, v) => a + v, 0) / s.probeMs.length);
  const guest = measured.map((s) => s.guestUs).filter((v): v is number => typeof v === 'number');
  return {
    ...spec,
    name: `${spec.bench}.${spec.config}`,
    bytesPerFrame,
    frames: measured.length,
    wallMsPerFrame: wall,
    cpuMsPerFrame: cpu,
    probeCpuMs: stats(probe),
    puPerFrame: stats(measured.map((s, i) => s.cpuMs / probe[i])),
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
    // One line per bench, for a run without the harness. Straight to stdout:
    // the suites silence console.log (the frame loops log every guest second).
    process.stdout.write(
      `[bus-perf] ${r.name}: ${r.wallMsPerFrame.median} ms/frame wall, ` +
        `${r.cpuMsPerFrame.median} ms/frame cpu, ${r.puPerFrame.median} pu/frame, ` +
        `${(r.bytesPerSecWall / 1e6).toFixed(3)} MB/s, ` +
        `${r.bytesPerFrame} B/frame, load ${r.loadavg.start[0]}\n`,
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
      probeChecksum: probeChecksum(),
      injectedWorkPerByte,
      loadavg: { start: this.loadStart.map(round2), end: loadNow().map(round2) },
      results: this.results,
    };
    writeFileSync(out, JSON.stringify(doc, null, 2));
  }
}
