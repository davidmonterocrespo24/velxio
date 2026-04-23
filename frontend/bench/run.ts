/**
 * Bench runner — registers every suite against tinybench, runs the whole
 * matrix N times, then keeps the BEST hz per task across all rounds.
 *
 * Why best-of-N:
 *   Single-run benchmark variance on a real dev/CI host is 3–5% from OS
 *   scheduling jitter alone. The "max throughput" sample is the round
 *   least disturbed by the scheduler — closest to what the code can
 *   actually do — and the noise floor between two best-of-N runs is
 *   typically <1.5%, which is what makes a CI gate meaningful.
 *
 * Invocation (via npm script):
 *   npm run bench
 *
 * Direct:
 *   npx vite-node bench/run.ts
 *   npx vite-node bench/run.ts --rounds 5
 *
 * Output:
 *   bench/results/last-run.json   — machine-readable, kept under git ignore
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bench } from 'tinybench';
import { registerAvrBenches, AVR_BENCH_METADATA } from './avr.bench';
import { registerSpiceBenches } from './spice.bench';
import { registerEventBusBenches } from './eventbus.bench';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const RESULTS_PATH = resolve(ROOT, 'bench/results/last-run.json');

const DEFAULT_ROUNDS = 3;

interface BenchResult {
  name: string;
  hz: number;          // operations per second (best across rounds)
  meanMs: number;      // average iteration duration of the best round
  rmeStddevPct: number; // relative margin of error of the best round
  samples: number;
  rounds: number;      // how many rounds contributed
  derived?: Record<string, number>;
}

interface RunReport {
  schema: 1;
  startedAt: string;
  durationMs: number;
  node: string;
  platform: string;
  arch: string;
  cpus: number;
  rounds: number;
  results: BenchResult[];
}

function parseRounds(): number {
  const i = process.argv.indexOf('--rounds');
  if (i >= 0 && process.argv[i + 1]) {
    const n = Number(process.argv[i + 1]);
    if (Number.isFinite(n) && n >= 1 && n <= 20) return Math.floor(n);
  }
  const env = process.env.BENCH_ROUNDS;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n >= 1 && n <= 20) return Math.floor(n);
  }
  return DEFAULT_ROUNDS;
}

function makeBench(): Bench {
  const b = new Bench({
    time: 2000,
    warmupTime: 400,
    iterations: 10,
  });
  registerAvrBenches(b);
  registerSpiceBenches(b);
  registerEventBusBenches(b);
  return b;
}

interface RoundSample {
  hz: number;
  meanMs: number;
  rme: number;
  samples: number;
}

async function runOnce(): Promise<Map<string, RoundSample>> {
  const bench = makeBench();
  await bench.run();
  const out = new Map<string, RoundSample>();
  for (const task of bench.tasks) {
    const r = task.result;
    if (
      !r ||
      r.state === 'errored' ||
      r.state === 'not-started' ||
      r.state === 'started' ||
      r.state === 'aborted'
    ) {
      console.error(`Bench ${task.name} produced no usable result (state=${r?.state ?? 'missing'}).`);
      if (r && 'error' in r && r.error) console.error(r.error);
      process.exit(1);
    }
    out.set(task.name, {
      hz: r.throughput.mean,
      meanMs: r.latency.mean,
      rme: r.latency.rme,
      samples: r.latency.samplesCount,
    });
  }
  return out;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const rounds = parseRounds();

  // best[name] = round-sample with the highest hz seen so far
  const best = new Map<string, RoundSample>();
  for (let round = 1; round <= rounds; round++) {
    console.log(`── round ${round}/${rounds} ──`);
    const round_ = await runOnce();
    for (const [name, sample] of round_) {
      const prev = best.get(name);
      if (!prev || sample.hz > prev.hz) best.set(name, sample);
    }
  }

  const results: BenchResult[] = [];
  for (const [name, s] of best) {
    const derived: Record<string, number> = {};
    if (name.startsWith('BENCH-AVR')) {
      derived.equivalentMhz = AVR_BENCH_METADATA.hzToMhz(s.hz);
    }
    results.push({
      name,
      hz: s.hz,
      meanMs: s.meanMs,
      rmeStddevPct: s.rme,
      samples: s.samples,
      rounds,
      derived: Object.keys(derived).length ? derived : undefined,
    });
  }

  const report: RunReport = {
    schema: 1,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: (await import('node:os')).cpus().length,
    rounds,
    results,
  };

  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(RESULTS_PATH, JSON.stringify(report, null, 2));

  // Pretty-print to stdout (the JSON is for compare.mjs).
  console.log('');
  console.log(`Bench run finished in ${report.durationMs} ms (${rounds} rounds, best-of)`);
  console.log(`Node ${report.node} on ${report.platform}/${report.arch}, ${report.cpus} CPUs`);
  console.log('─'.repeat(96));
  console.log(
    pad('name', 56) + pad('hz (best)', 16) + pad('±%', 9) + 'extras',
  );
  console.log('─'.repeat(96));
  for (const r of results) {
    const extras = r.derived
      ? Object.entries(r.derived)
          .map(([k, v]) => `${k}=${v.toFixed(3)}`)
          .join(' ')
      : '';
    console.log(
      pad(r.name.slice(0, 55), 56) +
        pad(formatHz(r.hz), 16) +
        pad(`±${r.rmeStddevPct.toFixed(2)}%`, 9) +
        extras,
    );
  }
  console.log('─'.repeat(96));
  console.log(`Wrote ${RESULTS_PATH}`);
  console.log('Compare against committed baseline with: node bench/compare.mjs');
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function formatHz(hz: number): string {
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(2)} M ops/s`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(2)} k ops/s`;
  return `${hz.toFixed(2)} ops/s`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
