#!/usr/bin/env node
/**
 * SDK smoke test.
 *
 * Packs `@velxio/sdk` into a tarball, installs it into a throwaway tmp
 * project, and exercises the public surface from both ESM and CJS.
 *
 * If this script fails, do NOT publish — the package is broken in a
 * way that the in-repo tests didn't catch (typically: missing dist
 * file, broken `exports` map, or a runtime import that requires a
 * dev-only file).
 *
 * Run from the repo root:
 *   node packages/sdk/scripts/smoke-test.mjs
 */

import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sdkDir = resolve(__dirname, '..');
const repoRoot = resolve(sdkDir, '..', '..');

function step(name, fn) {
  process.stdout.write(`▶ ${name} ... `);
  try {
    const result = fn();
    process.stdout.write('ok\n');
    return result;
  } catch (err) {
    process.stdout.write('FAILED\n');
    console.error(err);
    process.exit(1);
  }
}

function sh(cmd, opts = {}) {
  const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
  // execSync returns null when stdio is 'inherit' — callers that pipe
  // stdio for the side effect (build logs) don't need the captured output.
  return typeof out === 'string' ? out.trim() : '';
}

const tmp = mkdtempSync(join(tmpdir(), 'velxio-sdk-smoke-'));
try {
  step('build the SDK', () => {
    sh('npm run build', { cwd: sdkDir, stdio: 'inherit' });
  });

  const tarball = step('pack into tarball', () => {
    const out = sh('npm pack --silent --pack-destination ' + JSON.stringify(tmp), { cwd: sdkDir });
    // npm pack prints the filename on stdout; resolve into tmp.
    return join(tmp, out.split('\n').pop().trim());
  });

  step('create empty consumer project', () => {
    const consumer = join(tmp, 'consumer');
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify(
        {
          name: 'velxio-sdk-smoke-consumer',
          version: '0.0.0',
          private: true,
          type: 'module',
          dependencies: { '@velxio/sdk': `file:${tarball.replace(/\\/g, '/')}` },
        },
        null,
        2,
      ),
    );
    sh('npm install --no-audit --no-fund --silent', { cwd: consumer });
  });

  step('import via ESM', () => {
    const consumer = join(tmp, 'consumer');
    writeFileSync(
      join(consumer, 'esm-import.mjs'),
      `import { SDK_VERSION, MANIFEST_SCHEMA_VERSION, PLUGIN_PERMISSIONS, validateManifest } from '@velxio/sdk';
if (typeof SDK_VERSION !== 'string') { throw new Error('SDK_VERSION missing'); }
if (typeof MANIFEST_SCHEMA_VERSION !== 'number') { throw new Error('MANIFEST_SCHEMA_VERSION missing'); }
if (!Array.isArray(PLUGIN_PERMISSIONS) || PLUGIN_PERMISSIONS.length === 0) {
  throw new Error('PLUGIN_PERMISSIONS missing or empty');
}
if (typeof validateManifest !== 'function') { throw new Error('validateManifest missing'); }
console.log(JSON.stringify({ sdk: SDK_VERSION, schema: MANIFEST_SCHEMA_VERSION, perms: PLUGIN_PERMISSIONS.length }));
`,
    );
    const out = sh('node esm-import.mjs', { cwd: consumer });
    JSON.parse(out);
  });

  step('import via CJS', () => {
    const consumer = join(tmp, 'consumer');
    writeFileSync(
      join(consumer, 'cjs-import.cjs'),
      `const sdk = require('@velxio/sdk');
if (typeof sdk.SDK_VERSION !== 'string') { throw new Error('CJS SDK_VERSION missing'); }
if (typeof sdk.validateManifest !== 'function') { throw new Error('CJS validateManifest missing'); }
console.log(sdk.SDK_VERSION);
`,
    );
    sh('node cjs-import.cjs', { cwd: consumer });
  });

  step('subpath import @velxio/sdk/manifest', () => {
    const consumer = join(tmp, 'consumer');
    writeFileSync(
      join(consumer, 'subpath-import.mjs'),
      `import { PluginManifestSchema } from '@velxio/sdk/manifest';
if (PluginManifestSchema === undefined) { throw new Error('PluginManifestSchema missing'); }
console.log('ok');
`,
    );
    sh('node subpath-import.mjs', { cwd: consumer });
  });

  step('subpath import @velxio/sdk/events', () => {
    const consumer = join(tmp, 'consumer');
    writeFileSync(
      join(consumer, 'events-import.mjs'),
      `import * as events from '@velxio/sdk/events';
if (events === undefined) { throw new Error('events module missing'); }
console.log('ok');
`,
    );
    sh('node events-import.mjs', { cwd: consumer });
  });

  step('types resolve', () => {
    const consumer = join(tmp, 'consumer');
    writeFileSync(
      join(consumer, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            skipLibCheck: true,
          },
          include: ['types-check.ts'],
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(consumer, 'types-check.ts'),
      `import { validateManifest, type PluginManifest, type PluginPermission } from '@velxio/sdk';
const x: PluginPermission = 'ui.command.register';
const result = validateManifest({});
const m: PluginManifest | null = result.ok ? result.manifest : null;
void x; void m;
`,
    );
    // Use the SDK's own typescript dev dep — install nothing extra.
    const tscBin = resolve(sdkDir, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
    sh(`"${tscBin}" -p tsconfig.json`, { cwd: consumer, shell: true });
  });

  console.log('\n✅ smoke test passed');
} finally {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // tmp will be cleaned up by the OS eventually; not worth failing on.
  }
}

void repoRoot; void readFileSync;
