/**
 * IndexedDB-backed `SettingsBackend` for plugin settings.
 *
 * The default `InMemorySettingsBackend` (in `SettingsRegistry.ts`) loses
 * everything on refresh. Production wires this backend at App startup so
 * the user's plugin settings survive across sessions.
 *
 * Storage layout:
 *   - DB: `velxio.plugin-settings`
 *   - Object store: `settings`
 *   - Key: `pluginId` (a single string per plugin — values namespace
 *     inside the JSON blob, not in IDB keys)
 *   - Value: `{ values, updatedAt }` — the `updatedAt` lets future
 *     conflict resolution (Pro multi-device sync) pick a winner without
 *     a separate index.
 *
 * Why separate from the in-memory backend:
 *   - Tests stay in-process; vitest's jsdom polyfill for IDB doesn't
 *     fully implement transactions, so production tests would flake.
 *   - The wiring point at `App.tsx` only flips the backend once at boot.
 *   - The backend is a thin adapter — no caching, no batching. The
 *     `HostSettingsRegistry` already keeps a per-plugin in-memory cache
 *     that absorbs hot reads.
 */

import {
  get as idbGet,
  set as idbSet,
  del as idbDel,
  keys as idbKeys,
  createStore,
  type UseStore,
} from 'idb-keyval';

import type { SettingsValues } from '@velxio/sdk';

import type { SettingsBackend } from './SettingsRegistry';

const DB_NAME = 'velxio.plugin-settings';
const STORE_NAME = 'settings';

interface PersistedRecord {
  readonly values: SettingsValues;
  readonly updatedAt: number;
}

export class IndexedDBSettingsBackend implements SettingsBackend {
  private readonly store: UseStore;

  constructor(store?: UseStore) {
    this.store = store ?? createStore(DB_NAME, STORE_NAME);
  }

  async read(pluginId: string): Promise<SettingsValues | undefined> {
    const record = await idbGet<PersistedRecord>(pluginId, this.store);
    return record?.values;
  }

  async write(pluginId: string, values: SettingsValues): Promise<void> {
    const record: PersistedRecord = { values, updatedAt: Date.now() };
    await idbSet(pluginId, record, this.store);
  }

  async clear(pluginId: string): Promise<void> {
    await idbDel(pluginId, this.store);
  }

  /**
   * Enumerate every persisted plugin id. Used by the "Export all
   * settings" button so the panel can dump every namespace into a
   * single JSON without needing the registry to know about plugins
   * that aren't currently loaded.
   */
  async listPluginIds(): Promise<string[]> {
    const all = await idbKeys(this.store);
    return all.filter((k): k is string => typeof k === 'string');
  }
}
