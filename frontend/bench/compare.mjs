#!/usr/bin/env node
/**
 * Compare the last bench run against the committed baseline.
 *
 * Reads:
 *   bench/results/last-run.json  (produced by `npm run bench`)
 *   bench/baseline.json          (committed, generated once via `npm run bench:save`)
 *
 * For each named benchmark present in both files, computes the percent change
 * in hz (operations per second) of the latest run vs the baseline, and prints
 * a table. Exits with code 1 if ANY benchmark regresses beyond its tolerance,
 * 0 otherwise.
 *
 * Tolerances live in TOLERANCES below. Defaults to 1% for AVR-* and 2% for
 * SPICE-*, matching the budgets in docs/PERFORMANCE.md (principle #0 of
 * the Velxio Pro plan).
 *
 * Run this with: node bench/compare.mjs
 * Or via npm script: npm run bench:check
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const LAST_RUN = resolve(ROOT, 'bench/results/last-run.json');
const BASELINE = resolve(ROOT, 'bench/baseline.json');

/**
 * Tolerance (as a decimal, e.g. 0.03 = 3%) is the maximum allowed REGRESSION
 * vs baseline before the gate fails. A bench is allowed to get faster
 * (positive delta) without limit.
 *
 * These are CI-noise budgets, NOT the SDK overhead budgets. Velxio's
 * principle #0 says AVR8 <1% and SPICE <2% degradation from any one
 * SDK/plugin change, but a single bench run on a shared CI host varies
 * 2–4% just from scheduler jitter. Setting the gate at 1% here would
 * fire on noise, not regressions — see docs/PERFORMANCE.md.
 *
 * Match by prefix on the bench name (case-insensitive). First match wins,
 * fallback is DEFAULT_TOLERANCE.
 */
const TOLERANCES = [
  { prefix: 'BENCH-AVR', tolerance: 0.02 },
  { prefix: 'BENCH-RP2', tolerance: 0.02 },
  { prefix: 'BENCH-SPICE', tolerance: 0.05 },
  { prefix: 'BENCH-EVENT', tolerance: 0.02 },
  { prefix: 'BENCH-PIN', tolerance: 0.02 },
  // BENCH-PART measures the SDK adapter closure overhead on top of the
  // PinManager dispatch. Host-side PinManager lives in the same jitter
  // band as the EventBus micro-benches — 2% matches the existing AVR
  // gate and, more importantly, is tight enough to catch a regression
  // that would invalidate CORE-002c-step4's "adapter overhead is noise"
  // claim.
  { prefix: 'BENCH-PART', tolerance: 0.02 },
];
const DEFAULT_TOLERANCE = 0.05;

function toleranceFor(name) {
  const upper = name.toUpperCase();
  for (const { prefix, tolerance } of TOLERANCES) {
    if (upper.includes(prefix)) return tolerance;
  }
  return DEFAULT_TOLERANCE;
}

/**
 * Walk vitest's bench output and yield { name, hz } per measured benchmark.
 * Vitest 4 emits one of two shapes; we tolerate both.
 */
function* extractBenches(json) {
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    // Vitest bench result entries have `name` plus `result.hz` or `mean`/`hz`.
    if (typeof node.name === 'string') {
      const hz = node.result?.hz ?? node.hz;
      if (typeof hz === 'number' && Number.isFinite(hz) && hz > 0) {
        return out.push({ name: node.name, hz });
      }
    }
    for (const value of Object.values(node)) visit(value);
  };
  const out = [];
  visit(json);
  yield* out;
}

function loadJson(path) {
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function indexBenches(json) {
  const map = new Map();
  if (!json) return map;
  for (const { name, hz } of extractBenches(json)) {
    // If a name appears twice (shouldn't), keep the slowest — conservative.
    const prev = map.get(name);
    if (prev === undefined || hz < prev) map.set(name, hz);
  }
  return map;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function formatHz(hz) {
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(2)} M ops/s`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(2)} k ops/s`;
  return `${hz.toFixed(2)} ops/s`;
}

function main() {
  const lastJson = loadJson(LAST_RUN);
  if (!lastJson) {
    console.error(`Missing ${LAST_RUN}. Run \`npm run bench\` first.`);
    process.exit(2);
  }
  const baselineJson = loadJson(BASELINE);
  if (!baselineJson) {
    console.error(
      `Missing ${BASELINE}.\n` +
        `Capture a baseline once with \`npm run bench:save\`, commit it, ` +
        `and try again.`,
    );
    process.exit(2);
  }

  const last = indexBenches(lastJson);
  const baseline = indexBenches(baselineJson);

  if (last.size === 0) {
    console.error('No benchmark results found in last-run.json.');
    process.exit(2);
  }

  let regressed = 0;
  let unchanged = 0;
  let improved = 0;
  const onlyInLast = [];
  const missingFromLast = [];
  const rows = [];

  for (const [name, hz] of last) {
    const baseHz = baseline.get(name);
    if (baseHz === undefined) {
      onlyInLast.push(name);
      continue;
    }
    const delta = (hz - baseHz) / baseHz; // positive = faster, negative = slower
    const tolerance = toleranceFor(name);
    const regressed_ = delta < -tolerance;
    const status = regressed_
      ? 'REGRESS'
      : delta > 0.01
        ? 'faster'
        : 'ok';
    rows.push({ name, hz, baseHz, delta, tolerance, status });
    if (regressed_) regressed++;
    else if (delta > 0.01) improved++;
    else unchanged++;
  }
  for (const name of baseline.keys()) {
    if (!last.has(name)) missingFromLast.push(name);
  }

  // Print the table.
  console.log('');
  console.log('Benchmark vs baseline');
  console.log('─'.repeat(110));
  console.log(
    pad('name', 60) +
      pad('latest', 16) +
      pad('baseline', 16) +
      pad('Δ%', 9) +
      pad('tol', 7) +
      'status',
  );
  console.log('─'.repeat(110));
  for (const row of rows) {
    const sign = row.delta >= 0 ? '+' : '';
    console.log(
      pad(row.name.slice(0, 58), 60) +
        pad(formatHz(row.hz), 16) +
        pad(formatHz(row.baseHz), 16) +
        pad(`${sign}${(row.delta * 100).toFixed(2)}%`, 9) +
        pad(`${(row.tolerance * 100).toFixed(1)}%`, 7) +
        row.status,
    );
  }
  console.log('─'.repeat(110));
  console.log(
    `Summary: ${regressed} regressed, ${improved} improved, ${unchanged} unchanged.`,
  );
  if (onlyInLast.length > 0) {
    console.log(`New benches not in baseline: ${onlyInLast.join(', ')}`);
    console.log('  → If intentional, run `npm run bench:save` to update baseline.');
  }
  if (missingFromLast.length > 0) {
    console.log(`Baseline benches missing from this run: ${missingFromLast.join(', ')}`);
  }
  console.log('');
  process.exit(regressed > 0 ? 1 : 0);
}

main();
