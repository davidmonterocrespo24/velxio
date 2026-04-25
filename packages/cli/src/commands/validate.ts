/**
 * `velxio-plugin validate` — runs `validateManifest` from the SDK against
 * the plugin's `manifest.json` and emits one issue per line on failure.
 *
 * The SDK already does both Zod-structural validation AND the cross-field
 * semantic checks (`http.fetch` ⇒ allowlist, `pricing.free` ⇒
 * `refundPolicy: 'none'`). We only render its result.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validateManifest } from '@velxio/sdk/manifest';

export interface ValidateOptions {
  /** Path to the manifest file. Defaults to `<cwd>/manifest.json`. */
  readonly manifestPath?: string;
  /** Working directory used when `manifestPath` is not absolute. */
  readonly cwd?: string;
}

export interface ValidateResult {
  readonly ok: boolean;
  readonly resolvedPath: string;
  /** Lines suitable for direct `console.log` output (one per issue or one summary). */
  readonly lines: ReadonlyArray<string>;
}

const DEFAULT_FILENAME = 'manifest.json';

export async function runValidate(opts: ValidateOptions = {}): Promise<ValidateResult> {
  const cwd = opts.cwd ?? process.cwd();
  const resolvedPath = path.isAbsolute(opts.manifestPath ?? DEFAULT_FILENAME)
    ? (opts.manifestPath as string)
    : path.resolve(cwd, opts.manifestPath ?? DEFAULT_FILENAME);

  let raw: string;
  try {
    raw = await fs.readFile(resolvedPath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      resolvedPath,
      lines: [`✗ cannot read manifest at ${resolvedPath}: ${(err as Error).message}`],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      resolvedPath,
      lines: [`✗ ${path.basename(resolvedPath)} is not valid JSON: ${(err as Error).message}`],
    };
  }

  const result = validateManifest(parsed);
  if (!result.ok) {
    return {
      ok: false,
      resolvedPath,
      lines: [
        `✗ ${path.basename(resolvedPath)} failed manifest validation:`,
        ...result.errors.map((e) => `  ${e.path}: ${e.message}`),
      ],
    };
  }

  return {
    ok: true,
    resolvedPath,
    lines: [`✓ ${result.manifest.id}@${result.manifest.version} manifest válido`],
  };
}
