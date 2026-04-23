/**
 * SHA-256 verification of plugin bundle bytes.
 *
 * The same logic lives once in `pluginWorker.ts` (worker-side defense
 * in depth — re-verify before `import()` even if the host already
 * verified) and once here (loader-side — verify on download so a
 * tampered bundle never enters the cache, and so the host UI can
 * surface a clear "integrity mismatch" before spinning up a Worker).
 *
 * Two functions, one for each direction:
 *   - `computeBundleHash(bytes)` → hex SHA-256
 *   - `verifyBundleHash(bytes, expectedHex)` → throws `BundleIntegrityError`
 */

export class BundleIntegrityError extends Error {
  override readonly name = 'BundleIntegrityError';
  constructor(
    readonly expectedHex: string,
    readonly actualHex: string,
    readonly pluginId?: string,
  ) {
    super(
      pluginId !== undefined
        ? `Bundle integrity mismatch for plugin "${pluginId}": expected ${expectedHex}, got ${actualHex}`
        : `Bundle integrity mismatch: expected ${expectedHex}, got ${actualHex}`,
    );
  }
}

export async function computeBundleHash(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', view);
  return bufToHex(digest);
}

export async function verifyBundleHash(
  bytes: Uint8Array | ArrayBuffer,
  expectedHex: string,
  pluginId?: string,
): Promise<string> {
  const actual = await computeBundleHash(bytes);
  const expected = expectedHex.toLowerCase();
  if (actual !== expected) {
    throw new BundleIntegrityError(expected, actual, pluginId);
  }
  return actual;
}

function bufToHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    out += view[i]!.toString(16).padStart(2, '0');
  }
  return out;
}
