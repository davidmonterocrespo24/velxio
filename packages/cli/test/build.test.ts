/**
 * `runBuild` tests — focus on the contract the CORE-007 BundleVerifier
 * relies on: the emitted manifest's `bundleHash` MUST equal SHA-256 of
 * the emitted bundle, and the bundle MUST tree-shake @velxio/sdk out so
 * the host can inject its own copy.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runBuild } from '../src/commands/build';
import { makeTmpDir, rmDir, VALID_MANIFEST } from './helpers';

const tmpdirs: string[] = [];

afterEach(async () => {
  while (tmpdirs.length) await rmDir(tmpdirs.pop()!);
});

async function newProject(opts?: {
  manifest?: unknown;
  source?: string;
}): Promise<string> {
  const dir = await makeTmpDir();
  tmpdirs.push(dir);
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify(opts?.manifest ?? VALID_MANIFEST, null, 2),
    'utf8',
  );
  await fs.writeFile(
    path.join(dir, 'src', 'index.ts'),
    opts?.source ??
      `export default { activate(_ctx: unknown) { /* sample */ } };\n`,
    'utf8',
  );
  return dir;
}

describe('runBuild', () => {
  it('emits bundle.mjs + manifest.json + integrity.json with matching SHA-256', async () => {
    const dir = await newProject();
    const result = await runBuild({ cwd: dir });
    expect(result.ok).toBe(true);

    const bundleBytes = await fs.readFile(result.bundlePath);
    const manifestJson = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
    const integrityJson = JSON.parse(await fs.readFile(result.integrityPath, 'utf8'));

    const expected = createHash('sha256').update(bundleBytes).digest('hex');
    expect(result.sha256).toBe(expected);
    // bundleHash is NOT a manifest field — it lives in integrity.json
    // and the registry stitches it onto InstalledPlugin records.
    expect(manifestJson.bundleHash).toBeUndefined();
    expect(integrityJson.sha256).toBe(expected);
    expect(integrityJson.sizeBytes).toBe(bundleBytes.byteLength);
    expect(integrityJson.id).toBe('sample-plugin');
    expect(integrityJson.version).toBe('0.1.0');
  });

  it('marks @velxio/sdk as external (does not inline it in the bundle)', async () => {
    const dir = await newProject({
      // Use an inline `import` against @velxio/sdk to force resolution attempt.
      // We fake the module via a node_modules stub so esbuild has something
      // to externalize. Our build config marks it external regardless, so
      // the bundle should reference it by name.
      source: `import { definePlugin } from '@velxio/sdk';\nexport default definePlugin({ async activate(_ctx: unknown) {} });\n`,
    });
    // Stub out the SDK module so esbuild can resolve the import for the
    // dependency graph walk (it still won't bundle since we mark external).
    await fs.mkdir(path.join(dir, 'node_modules', '@velxio', 'sdk'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'node_modules', '@velxio', 'sdk', 'package.json'),
      JSON.stringify({ name: '@velxio/sdk', version: '0.1.0', main: 'index.js' }),
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, 'node_modules', '@velxio', 'sdk', 'index.js'),
      'export function definePlugin(p) { return p; }\n',
      'utf8',
    );

    const result = await runBuild({ cwd: dir, minify: false });
    expect(result.ok).toBe(true);

    const bundle = await fs.readFile(result.bundlePath, 'utf8');
    // External imports stay as bare module specifiers in ESM output.
    expect(bundle).toMatch(/@velxio\/sdk/);
    // The host-side function body must NOT be inlined.
    expect(bundle).not.toMatch(/return p;/);
  });

  it('refuses to build when the source manifest is invalid', async () => {
    const dir = await newProject({ manifest: { ...VALID_MANIFEST, version: 'oops' } });
    const result = await runBuild({ cwd: dir });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toMatch(/version/);

    // No artefacts on the floor.
    await expect(fs.access(path.join(dir, 'dist', 'bundle.mjs'))).rejects.toThrow();
  });

  it('produces a deterministic hash across rebuilds', async () => {
    const dir = await newProject();
    const a = await runBuild({ cwd: dir });
    // Force a fresh wall-clock for `builtAt` but bundle bytes should be stable.
    await new Promise((r) => setTimeout(r, 10));
    const b = await runBuild({ cwd: dir });
    expect(a.ok && b.ok).toBe(true);
    expect(a.sha256).toBe(b.sha256);
    expect(a.sizeBytes).toBe(b.sizeBytes);
  });

  it('reports esbuild failures cleanly when entry has a syntax error', async () => {
    const dir = await newProject({ source: 'export default {{{ bad syntax;\n' });
    const result = await runBuild({ cwd: dir });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toMatch(/esbuild failed/);
  });
});
