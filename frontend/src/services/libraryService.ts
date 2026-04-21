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

export async function installLibrary(name: string): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(`${API_BASE}/install`, {
    method: 'POST',
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
