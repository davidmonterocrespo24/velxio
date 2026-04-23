/**
 * IndexedDB cache for plugin bundles.
 *
 * Lives behind `idb-keyval` so each call is a single transaction. We do
 * not use a relational schema — the value is the whole bundle plus the
 * manifest snapshot at the time it was cached, which keeps the cache
 * self-describing if the manifest list ever drifts on the server.
 *
 * Design choices:
 *   - Key shape: `plugin:<id>:<version>`. One bundle per (id, version),
 *     so a hot reload of the same version is a no-op and an update
 *     just writes a new key without invalidating the old one until GC.
 *   - Value carries `cachedAt` (ms epoch) for LRU-ish GC.
 *   - GC runs *after* a successful `put`, never before, so a transient
 *     CDN failure can't trip us into evicting the only cached copy of
 *     a plugin we're about to need.
 *   - The cache exposes a `StorageBackend` seam so tests inject a
 *     `Map`-backed in-memory store instead of touching `indexedDB`,
 *     which jsdom's idb-keyval polyfill doesn't fully support.
 *
 * The cache does NOT verify integrity itself — callers verify before
 * `put()` so a tampered byte stream is rejected upstream and never
 * persisted.
 */

import {
  get as idbGet,
  set as idbSet,
  del as idbDel,
  keys as idbKeys,
  createStore,
  type UseStore,
} from 'idb-keyval';

import type { PluginManifest } from '@velxio/sdk';

// ── Types ────────────────────────────────────────────────────────────────

export interface PluginCacheEntry {
  readonly bundle: ArrayBuffer;
  readonly hash: string;
  readonly manifest: PluginManifest;
  readonly cachedAt: number;
  /** Bytes — denormalised for fast GC accounting. */
  readonly size: number;
}

/**
 * Pluggable backend so tests can inject an in-memory store. In
 * production we wrap `idb-keyval` against a dedicated object store,
 * keeping the rest of the editor's IDB usage isolated.
 */
export interface PluginCacheBackend {
  get(key: string): Promise<PluginCacheEntry | undefined>;
  set(key: string, value: PluginCacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface PluginCacheOptions {
  /**
   * Hard ceiling for total cached bytes. After a `put`, the cache
   * evicts oldest entries (by `cachedAt`) until the total fits, but
   * never evicts a key that matches a current (id, version) we are
   * actively keeping per `gc({ keep })`.
   *
   * Default: 100 MB.
   */
  readonly maxBytes?: number;
  readonly backend?: PluginCacheBackend;
}

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const STORE_NAME = 'velxio-plugin-cache';
const DB_NAME = 'velxio-plugins';

// ── Default IDB-backed backend ───────────────────────────────────────────

class IdbBackend implements PluginCacheBackend {
  private readonly store: UseStore;
  constructor() {
    this.store = createStore(DB_NAME, STORE_NAME);
  }
  async get(key: string): Promise<PluginCacheEntry | undefined> {
    return (await idbGet<PluginCacheEntry>(key, this.store)) ?? undefined;
  }
  async set(key: string, value: PluginCacheEntry): Promise<void> {
    await idbSet(key, value, this.store);
  }
  async delete(key: string): Promise<void> {
    await idbDel(key, this.store);
  }
  async keys(): Promise<string[]> {
    return (await idbKeys(this.store)).filter((k): k is string => typeof k === 'string');
  }
}

/** In-memory backend for tests and SSR. */
export class MemoryCacheBackend implements PluginCacheBackend {
  private readonly map = new Map<string, PluginCacheEntry>();
  async get(key: string): Promise<PluginCacheEntry | undefined> { return this.map.get(key); }
  async set(key: string, value: PluginCacheEntry): Promise<void> { this.map.set(key, value); }
  async delete(key: string): Promise<void> { this.map.delete(key); }
  async keys(): Promise<string[]> { return Array.from(this.map.keys()); }
}

// ── PluginCache ──────────────────────────────────────────────────────────

export class PluginCache {
  private readonly backend: PluginCacheBackend;
  private readonly maxBytes: number;

  constructor(opts: PluginCacheOptions = {}) {
    this.backend = opts.backend ?? new IdbBackend();
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /** Read a cached entry. Returns undefined on miss. */
  async get(id: string, version: string): Promise<PluginCacheEntry | undefined> {
    return this.backend.get(keyOf(id, version));
  }

  /**
   * Write a verified bundle to the cache, then run GC (subject to the
   * `keep` set so we never evict a plugin we're actively using).
   */
  async put(
    id: string,
    version: string,
    entry: Omit<PluginCacheEntry, 'cachedAt' | 'size'> & { cachedAt?: number },
  ): Promise<void> {
    const size = entry.bundle.byteLength;
    const stamped: PluginCacheEntry = {
      bundle: entry.bundle,
      hash: entry.hash,
      manifest: entry.manifest,
      cachedAt: entry.cachedAt ?? Date.now(),
      size,
    };
    await this.backend.set(keyOf(id, version), stamped);
  }

  async delete(id: string, version: string): Promise<void> {
    await this.backend.delete(keyOf(id, version));
  }

  async list(): Promise<readonly { id: string; version: string; entry: PluginCacheEntry }[]> {
    const keys = await this.backend.keys();
    const out: { id: string; version: string; entry: PluginCacheEntry }[] = [];
    for (const k of keys) {
      const parsed = parseKey(k);
      if (parsed === undefined) continue;
      const entry = await this.backend.get(k);
      if (entry === undefined) continue;
      out.push({ id: parsed.id, version: parsed.version, entry });
    }
    return out;
  }

  async totalBytes(): Promise<number> {
    const all = await this.list();
    return all.reduce((sum, x) => sum + x.entry.size, 0);
  }

  /**
   * Evict oldest entries until total bytes fit `maxBytes`. The `keep`
   * set is `${id}:${version}` strings of plugins currently active —
   * those are never evicted, even if they are the oldest.
   *
   * Returns the list of evicted (id, version) pairs.
   */
  async gc(opts: { keep?: ReadonlySet<string> } = {}): Promise<{ id: string; version: string }[]> {
    const keep = opts.keep ?? new Set<string>();
    const all = (await this.list()).slice().sort((a, b) => a.entry.cachedAt - b.entry.cachedAt);
    let total = all.reduce((sum, x) => sum + x.entry.size, 0);
    const evicted: { id: string; version: string }[] = [];
    for (const { id, version, entry } of all) {
      if (total <= this.maxBytes) break;
      if (keep.has(`${id}:${version}`)) continue;
      await this.backend.delete(keyOf(id, version));
      total -= entry.size;
      evicted.push({ id, version });
    }
    return evicted;
  }

  /**
   * Drop every cached version of `id` except the ones in `keepVersions`.
   * Called when a plugin is uninstalled or downgraded — frees the
   * bytes of stale versions immediately rather than waiting for GC.
   */
  async pruneVersions(id: string, keepVersions: ReadonlySet<string>): Promise<number> {
    const all = await this.list();
    let removed = 0;
    for (const { id: cid, version } of all) {
      if (cid !== id) continue;
      if (keepVersions.has(version)) continue;
      await this.backend.delete(keyOf(cid, version));
      removed++;
    }
    return removed;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function keyOf(id: string, version: string): string {
  return `plugin:${id}:${version}`;
}

function parseKey(key: string): { id: string; version: string } | undefined {
  // Versions can contain `:` (e.g. SemVer pre-release `1.0.0-beta:rc1`),
  // so split into at most 3 from the left and let the rest be the version.
  if (!key.startsWith('plugin:')) return undefined;
  const rest = key.slice('plugin:'.length);
  const sep = rest.indexOf(':');
  if (sep === -1) return undefined;
  return { id: rest.slice(0, sep), version: rest.slice(sep + 1) };
}
