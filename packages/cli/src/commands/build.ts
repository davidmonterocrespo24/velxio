/**
 * `velxio-plugin build` — esbuild bundle + manifest rewrite + integrity emit.
 *
 * Steps:
 *   1. `runValidate` against the source manifest (fail fast).
 *   2. esbuild bundle to `<outdir>/bundle.mjs` with `@velxio/sdk` external —
 *      the host injects the SDK in the worker scope, so bundling it would
 *      duplicate the runtime + break instanceof checks across the boundary.
 *   3. Copy `manifest.json` verbatim into `<outdir>/manifest.json` so
 *      consumers fetch one tarball-shaped artefact (bundle + manifest +
 *      integrity sidecar all rooted at `dist/`).
 *   4. Emit `<outdir>/integrity.json` `{ id, version, sha256, sizeBytes,
 *      builtAt }`. The registry reads THIS file to populate the
 *      `InstalledPlugin.bundleHash` field that the CORE-007 BundleVerifier
 *      checks at load time — the manifest schema itself does not carry
 *      `bundleHash`, so the integrity sidecar is the source of truth.
 *
 * The function returns the byte size + hash so tests can pin them.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { build as esbuild } from 'esbuild';
import { runValidate } from './validate';

export interface BuildOptions {
  /** Working directory (project root). Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Entry source file relative to cwd. Defaults to `src/index.ts`. */
  readonly entry?: string;
  /** Output directory relative to cwd. Defaults to `dist`. */
  readonly outdir?: string;
  /** Manifest path relative to cwd. Defaults to `manifest.json`. */
  readonly manifestPath?: string;
  /** Skip minification — useful for dev / debugging. Defaults to false. */
  readonly minify?: boolean;
}

export interface BuildResult {
  readonly ok: boolean;
  readonly bundlePath: string;
  readonly manifestPath: string;
  readonly integrityPath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly lines: ReadonlyArray<string>;
}

const DEFAULT_ENTRY = 'src/index.ts';
const DEFAULT_OUTDIR = 'dist';
const DEFAULT_MANIFEST = 'manifest.json';

export async function runBuild(opts: BuildOptions = {}): Promise<BuildResult> {
  const cwd = opts.cwd ?? process.cwd();
  const entryAbs = path.resolve(cwd, opts.entry ?? DEFAULT_ENTRY);
  const outdirAbs = path.resolve(cwd, opts.outdir ?? DEFAULT_OUTDIR);
  const srcManifestAbs = path.resolve(cwd, opts.manifestPath ?? DEFAULT_MANIFEST);
  const outBundleAbs = path.join(outdirAbs, 'bundle.mjs');
  const outManifestAbs = path.join(outdirAbs, 'manifest.json');
  const outIntegrityAbs = path.join(outdirAbs, 'integrity.json');

  const lines: string[] = [];

  // Step 1 — validate manifest before doing any work.
  const validation = await runValidate({ cwd, manifestPath: srcManifestAbs });
  if (!validation.ok) {
    return {
      ok: false,
      bundlePath: outBundleAbs,
      manifestPath: outManifestAbs,
      integrityPath: outIntegrityAbs,
      sha256: '',
      sizeBytes: 0,
      lines: validation.lines,
    };
  }
  lines.push(...validation.lines);

  // Read manifest as JSON for the dist copy + integrity sidecar.
  // Trust the bytes — `validate` already round-tripped them through Zod.
  const manifestJson = JSON.parse(await fs.readFile(srcManifestAbs, 'utf8')) as Record<string, unknown>;

  // Step 2 — esbuild bundle. We DO NOT use --outfile because esbuild's
  // metafile is more useful when we manage the output ourselves.
  await fs.mkdir(outdirAbs, { recursive: true });

  try {
    await esbuild({
      entryPoints: [entryAbs],
      outfile: outBundleAbs,
      bundle: true,
      format: 'esm',
      target: 'es2022',
      platform: 'browser',
      minify: opts.minify ?? true,
      sourcemap: true,
      external: ['@velxio/sdk'],
      logLevel: 'silent',
    });
  } catch (err) {
    return {
      ok: false,
      bundlePath: outBundleAbs,
      manifestPath: outManifestAbs,
      integrityPath: outIntegrityAbs,
      sha256: '',
      sizeBytes: 0,
      lines: [...lines, `✗ esbuild failed: ${(err as Error).message}`],
    };
  }

  // Step 3 — hash bundle bytes & rewrite manifest in-place at outdir.
  const bundleBytes = await fs.readFile(outBundleAbs);
  const sha256 = createHash('sha256').update(bundleBytes).digest('hex');
  const sizeBytes = bundleBytes.byteLength;

  await fs.writeFile(outManifestAbs, JSON.stringify(manifestJson, null, 2) + '\n', 'utf8');

  // Step 4 — integrity sidecar. Schema is independent of the manifest so
  // CI tooling can consume it without depending on @velxio/sdk.
  const integrity = {
    id: manifestJson.id,
    version: manifestJson.version,
    sha256,
    sizeBytes,
    builtAt: new Date().toISOString(),
  };
  await fs.writeFile(outIntegrityAbs, JSON.stringify(integrity, null, 2) + '\n', 'utf8');

  lines.push(
    `✓ bundle: ${path.relative(cwd, outBundleAbs)} (${sizeBytes} bytes)`,
    `✓ sha256: ${sha256}`,
  );

  return {
    ok: true,
    bundlePath: outBundleAbs,
    manifestPath: outManifestAbs,
    integrityPath: outIntegrityAbs,
    sha256,
    sizeBytes,
    lines,
  };
}
