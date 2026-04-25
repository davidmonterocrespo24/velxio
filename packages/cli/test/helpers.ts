import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Create an isolated tmpdir for a single test. The directory is registered
 * for cleanup against the calling test via `onCleanup` (vitest-style).
 */
export async function makeTmpDir(prefix = 'velxio-cli-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix + randomBytes(4).toString('hex') + '-'));
  return dir;
}

export async function rmDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** A known-good manifest used as the baseline for validate/build tests. */
export const VALID_MANIFEST = {
  schemaVersion: 1,
  id: 'sample-plugin',
  name: 'Sample Plugin',
  version: '0.1.0',
  sdkVersion: '^0.1.0',
  minVelxioVersion: '^0.1.0',
  author: { name: 'Test' },
  description:
    'A sample plugin used by the CLI test suite to exercise validate and build paths.',
  // 1x1 transparent PNG — short, schema-valid.
  icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  license: 'MIT',
  category: 'components',
  tags: [],
  type: ['component'],
  entry: './dist/bundle.mjs',
  permissions: ['components.register'],
  pricing: { model: 'free' },
  refundPolicy: 'none',
} as const;
