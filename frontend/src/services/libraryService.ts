import { getApiBase } from '../lib/apiBase';
const apiBase = () => `${getApiBase()}/libraries`;
export const ARDUINO_LIBRARIES_CHANGED = 'velxio-arduino-libraries-changed';

function librariesChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(ARDUINO_LIBRARIES_CHANGED));
}

export interface ArduinoLibrary {
  name: string;
  author?: string;
  version?: string;
  sentence?: string;
  paragraph?: string;
  website?: string;
  category?: string;
  types?: string[];
  releases?: Record<string, { version: string }>;
  latest?: {
    version: string;
    sentence?: string;
    paragraph?: string;
    author?: string;
    website?: string;
  };
}

export interface InstalledLibrary {
  library?: {
    name: string;
    version: string;
    author?: string;
    sentence?: string;
    location?: string;
  };
  name?: string;
  version?: string;
  author?: string;
  sentence?: string;
  /** P2.2c — true for the user's own per-user custom uploads (vs shared index libs). */
  custom?: boolean;
}

export async function searchLibraries(query: string): Promise<ArduinoLibrary[]> {
  const res = await fetch(`${apiBase()}/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
    throw new Error(err.detail || 'Failed to search libraries');
  }
  const data = await res.json();
  return data.libraries || [];
}

export async function installLibrary(name: string, version?: string): Promise<{ success: boolean; error?: string; fallback?: boolean; requested_version?: string }> {
  const res = await fetch(`${apiBase()}/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, version: version ?? null }),
  });
  const data = await res.json();
  if (res.ok && data.success) librariesChanged();
  return data;
}

export async function uninstallLibrary(name: string): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(`${apiBase()}/uninstall`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (res.ok && data.success) librariesChanged();
  return data;
}

export async function getInstalledLibraries(): Promise<InstalledLibrary[]> {
  const res = await fetch(`${apiBase()}/list`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
    throw new Error(err.detail || 'Failed to fetch installed libraries');
  }
  const data = await res.json();
  return data.libraries || [];
}

/**
 * P2.2c — the signed-in user's per-user CUSTOM libraries (uploaded .zip),
 * which live in their per-user store, not the shared global list. Merged into
 * the Installed view + velxio.json autocomplete so they can see and reuse their
 * uploads. Returns [] when unauthenticated or no pro overlay (401/404).
 */
export async function getCustomLibraries(): Promise<InstalledLibrary[]> {
  try {
    const res = await fetch('/api/pro/libraries/custom', { credentials: 'include' });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** P2.2c — remove one of the user's own custom uploads (per-user store). */
export async function deleteCustomLibrary(
  name: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/pro/libraries/custom/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Failed to remove' }));
      return { success: false, error: err.detail || 'Failed to remove' };
    }
    librariesChanged();
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'network error' };
  }
}

/**
 * Resolve a library name to "Name@X.Y.Z" using arduino-cli lib search.
 * Returns null if the library is not found in the index.
 * Used during export to resolve versions for libraries that are not locally installed.
 */
export async function resolveLibraryVersion(libName: string): Promise<string | null> {
  try {
    const results = await searchLibraries(libName);
    // Find best match: exact name or name without underscores/spaces
    const normalised = libName.replace(/[\s_]+/g, '').toLowerCase();
    const match = results.find(
      (r) =>
        r.name.replace(/[\s_]+/g, '').toLowerCase() === normalised ||
        normalised.includes(r.name.replace(/[\s_]+/g, '').toLowerCase()) ||
        r.name.replace(/[\s_]+/g, '').toLowerCase().includes(normalised),
    );
    if (!match) return null;
    const latest = match.latest?.version;
    if (latest && /^\d+\.\d+\.\d+$/.test(latest)) {
      return `${match.name}@${latest}`;
    }
    return null;
  } catch {
    return null;
  }
}
