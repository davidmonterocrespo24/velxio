#!/usr/bin/env node
/**
 * Promote bench/results/last-run.json to bench/baseline.json.
 *
 * Re-run this only with intent: it freezes a new performance contract.
 * Commit the diff so reviewers can see what moved.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'bench/results/last-run.json');
const DEST = resolve(ROOT, 'bench/baseline.json');

if (!existsSync(SRC)) {
  console.error(`No last-run.json at ${SRC}.\nRun \`npm run bench\` first.`);
  process.exit(2);
}

mkdirSync(dirname(DEST), { recursive: true });
copyFileSync(SRC, DEST);
console.log(`Baseline updated → ${DEST}`);
console.log('Commit the change to lock the new performance contract.');
