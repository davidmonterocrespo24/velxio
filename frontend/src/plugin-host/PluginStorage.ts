/**
 * In-memory `PluginStorage` with quota enforcement.
 *
 * Two design decisions:
 *
 *   1. **Quota check happens on `set()`, not on read.** Reading a 1 MB blob
 *      is fine; growing past the cap is what we block. The check measures
 *      the JSON-serialized size of the proposed value plus the key length
 *      (UTF-8 bytes) and sums it with the existing entries to decide.
 *
 *   2. **Backed by a Map by default; a `StorageBackend` interface exists so
 *      a future IndexedDB implementation can plug in without changing the
 *      `PluginStorage` shape.** The in-memory backend is enough for tests
 *      and for unsigned plugins that don't need cross-session persistence.
 *
 * The bucket label ('user' vs 'workspace') is carried only for error
 * messages — there's no behavioral difference.
 */

import {
  StorageQuotaError,
  PLUGIN_STORAGE_QUOTA_BYTES,
  type PluginStorage,
} from '@velxio/sdk';

export type StorageBucket = 'user' | 'workspace';

/**
 * Pluggable backend so we can swap the in-memory map for IndexedDB later
 * without changing `InMemoryPluginStorage`. Sync API on purpose — async
 * backends still satisfy this by maintaining their own write-through cache.
 */
export interface StorageBackend {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  keys(): string[];
}

export class MapStorageBackend implements StorageBackend {
  private readonly data = new Map<string, unknown>();

  get(key: string): unknown | undefined {
    return this.data.get(key);
  }
  set(key: string, value: unknown): void {
    this.data.set(key, value);
  }
  delete(key: string): void {
    this.data.delete(key);
  }
  keys(): string[] {
    return [...this.data.keys()];
  }
}

/** Approximate byte size of a value once JSON-serialized + the key. */
function sizeOf(key: string, value: unknown): number {
  const keyBytes = new TextEncoder().encode(key).length;
  const valueBytes = new TextEncoder().encode(JSON.stringify(value)).length;
  return keyBytes + valueBytes;
}

export class InMemoryPluginStorage implements PluginStorage {
  constructor(
    private readonly bucket: StorageBucket,
    private readonly backend: StorageBackend = new MapStorageBackend(),
    private readonly quotaBytes: number = PLUGIN_STORAGE_QUOTA_BYTES,
  ) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.backend.get(key) as T | undefined;
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    // Sum of every other entry + the proposed write — replacing an existing
    // key reuses its slot, so we subtract the old size before adding the new.
    let total = 0;
    for (const k of this.backend.keys()) {
      if (k === key) continue;
      total += sizeOf(k, this.backend.get(k));
    }
    const proposed = sizeOf(key, value);
    if (total + proposed > this.quotaBytes) {
      throw new StorageQuotaError(this.bucket, total + proposed, this.quotaBytes);
    }
    this.backend.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.backend.delete(key);
  }

  async keys(): Promise<ReadonlyArray<string>> {
    return this.backend.keys();
  }

  /** Test/diagnostic helper — current bucket usage in bytes. */
  usedBytes(): number {
    let total = 0;
    for (const k of this.backend.keys()) {
      total += sizeOf(k, this.backend.get(k));
    }
    return total;
  }
}
