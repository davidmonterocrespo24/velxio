/**
 * Does this server provide every gallery library itself?
 *
 * A deployment with a library lock seeds the whole gallery set at boot and
 * reports it on `/health` as `libraries: { ok: true }`. Then the on-load
 * install (`ensureLibraries`) is redundant: nothing is missing, and the
 * install endpoint refuses anonymous visitors anyway. Without that field
 * (an OSS self-host, or a deployment whose seed is incomplete) the answer is
 * false and the loader keeps installing on load, which is the only path
 * that puts an example's libraries on such a server.
 *
 * One request per session, cached; any failure reads as "no".
 */
import { getApiBase } from '../lib/apiBase';

let cached: Promise<boolean> | null = null;

export function serverProvidesGalleryLibraries(): Promise<boolean> {
  if (cached === null) {
    cached = (async () => {
      try {
        const res = await fetch(`${getApiBase().replace(/\/api$/, '')}/health`, { credentials: 'same-origin' });
        if (!res.ok) return false;
        const body = (await res.json()) as { libraries?: { ok?: unknown } };
        return body?.libraries?.ok === true;
      } catch {
        return false;
      }
    })();
  }
  return cached;
}

/** Test seam: forget the cached answer. */
export function resetGalleryLibrariesGateForTest(): void {
  cached = null;
}
