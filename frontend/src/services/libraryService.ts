const API_BASE = `${import.meta.env.VITE_API_BASE || '/api'}/libraries`;

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
}

export async function searchLibraries(query: string): Promise<ArduinoLibrary[]> {
  const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
    throw new Error(err.detail || 'Failed to search libraries');
  }
  const data = await res.json();
  return data.libraries || [];
}

export async function installLibrary(name: string, version?: string): Promise<{ success: boolean; error?: string; fallback?: boolean; requested_version?: string }> {
  const res = await fetch(`${API_BASE}/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, version: version ?? null }),
  });
  const data = await res.json();
  return data;
}

export async function uninstallLibrary(name: string): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(`${API_BASE}/uninstall`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  return data;
}

export async function getInstalledLibraries(): Promise<InstalledLibrary[]> {
  const res = await fetch(`${API_BASE}/list`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
    throw new Error(err.detail || 'Failed to fetch installed libraries');
  }
  const data = await res.json();
  return data.libraries || [];
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
