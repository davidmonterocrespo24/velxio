/**
 * IndexedDB-backed `StorageBackend` for plugin storage.
 *
 * The default `MapStorageBackend` is in-memory only — every refresh wipes
 * `ctx.userStorage` / `ctx.workspaceStorage`. This backend gives plugins
 * cross-session persistence without forcing the SDK contract async.
 *
 * Storage layout:
 *
 *   - DB:  `velxio.plugin-storage`
 *   - One object store: `entries`
 *   - Keys: `${pluginId}:${bucket}:${key}` (string)
 *   - Values: the raw object the plugin handed to `set()` (structured-cloned).
 *
 * Why one shared store with prefixed keys instead of one store per plugin?
 * IDB requires every object store to be declared in `onupgradeneeded`. We
 * cannot dynamically `db.createObjectStore('plugin:foo')` when plugin "foo"
 * loads — it would force a version bump on every install. A single store
 * with prefixed keys lets us pre-load just one plugin's bucket via a
 * key-range cursor, which is what `loadPrefix()` does.
 *
 * Async construction, sync reads:
 *   `create(pluginId, bucket)` does an async pre-load of every key under
 *   the prefix into an in-memory `Map`. After construction, `get`/`keys`
 *   are O(1) Map lookups so the sync `StorageBackend` interface holds.
 *   Memory cost ≤ the bucket quota (1 MB).
 *
 * Write-through, ordered queue:
 *   `set`/`delete` mutate the mirror synchronously (so the next read sees
 *   the new value) and enqueue the IDB write on a single-track promise
 *   chain. The chain's `flushed()` Promise lets `InMemoryPluginStorage.set`
 *   await persistence — without it, the caller's `await store.set(k, v)`
 *   would resolve before the bytes hit disk and a tab close mid-flight
 *   could lose the value silently.
 *
 * Errors during persistence are logged via the injected `onError` and the
 * mirror keeps the new value (the next write retries). The lost-write
 * window is bounded to "the most recent op before a tab crash."
 */

import { createStore, type UseStore } from 'idb-keyval';

import type { StorageBackend, StorageBucket } from './PluginStorage';

const DB_NAME = 'velxio.plugin-storage';
const STORE_NAME = 'entries';

export interface IndexedDBPluginStorageBackendOptions {
  /**
   * Override the IDB store. Production wiring uses the default
   * `velxio.plugin-storage / entries`. Tests inject a fresh `createStore()`
   * call to isolate from other suites.
   */
  readonly store?: UseStore;
  /**
   * Called when an IDB write fails. Defaults to `console.error`. The host
   * wires this to `PluginLogger.error` so failures show up tagged with the
   * plugin id.
   */
  readonly onError?: (err: unknown) => void;
}

export class IndexedDBPluginStorageBackend implements StorageBackend {
  private readonly mirror: Map<string, unknown>;
  private readonly store: UseStore;
  private readonly prefix: string;
  private readonly onError: (err: unknown) => void;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    mirror: Map<string, unknown>,
    store: UseStore,
    prefix: string,
    onError: (err: unknown) => void,
  ) {
    this.mirror = mirror;
    this.store = store;
    this.prefix = prefix;
    this.onError = onError;
  }

  /**
   * Open the store, scan every key under `${pluginId}:${bucket}:`, and
   * return a backend ready for sync reads. The plugin loader awaits this
   * before constructing the worker so the plugin's `activate(ctx)` sees a
   * populated `userStorage`/`workspaceStorage` from the first read.
   */
  static async create(
    pluginId: string,
    bucket: StorageBucket,
    options: IndexedDBPluginStorageBackendOptions = {},
  ): Promise<IndexedDBPluginStorageBackend> {
    const store = options.store ?? createStore(DB_NAME, STORE_NAME);
    const onError = options.onError ?? defaultOnError;
    const prefix = `${pluginId}:${bucket}:`;
    const mirror = await loadPrefix(store, prefix);
    return new IndexedDBPluginStorageBackend(mirror, store, prefix, onError);
  }

  get(key: string): unknown | undefined {
    return this.mirror.get(key);
  }

  set(key: string, value: unknown): void {
    this.mirror.set(key, value);
    const fullKey = this.prefix + key;
    this.enqueueWrite((s) => promisifyRequest(s.put(value, fullKey)));
  }

  delete(key: string): void {
    this.mirror.delete(key);
    const fullKey = this.prefix + key;
    this.enqueueWrite((s) => promisifyRequest(s.delete(fullKey)));
  }

  keys(): string[] {
    return [...this.mirror.keys()];
  }

  /**
   * Resolve once every queued IDB write has completed (or failed —
   * failures are reported via `onError` and the queue continues).
   * `InMemoryPluginStorage.set/delete` awaits this so the caller's
   * `await ctx.userStorage.set(k, v)` doesn't return until the bytes
   * are durable.
   */
  async flushed(): Promise<void> {
    await this.writeQueue;
  }

  private enqueueWrite(fn: (s: IDBObjectStore) => Promise<unknown>): void {
    this.writeQueue = this.writeQueue
      .then(() => this.store('readwrite', fn))
      .then(() => undefined)
      .catch((err) => this.onError(err));
  }
}

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error);
  });
}

/**
 * Cursor scan for one plugin's bucket. Uses a key range so we don't
 * deserialize values from other plugins — important when the database
 * has dozens of plugins worth of state.
 */
async function loadPrefix(store: UseStore, prefix: string): Promise<Map<string, unknown>> {
  return store('readonly', (objectStore) => {
    return new Promise<Map<string, unknown>>((resolve, reject) => {
      const result = new Map<string, unknown>();
      // `￿` is the highest BMP code point — used here as the upper
      // bound for any string starting with `prefix`. IDB sorts keys
      // lexicographically, so this catches every key in the namespace.
      const range = IDBKeyRange.bound(prefix, prefix + '￿', false, false);
      const req = objectStore.openCursor(range);
      req.onsuccess = (): void => {
        const cursor = req.result;
        if (cursor !== null) {
          const fullKey = cursor.key as string;
          result.set(fullKey.substring(prefix.length), cursor.value);
          cursor.continue();
        } else {
          resolve(result);
        }
      };
      req.onerror = (): void => reject(req.error);
    });
  });
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.error('[plugin storage]', err);
}

/**
 * Convenience pair factory for the common case where the loader needs
 * both buckets. Awaits both in parallel.
 */
export async function createPluginStorageBackends(
  pluginId: string,
  options: IndexedDBPluginStorageBackendOptions = {},
): Promise<{ user: IndexedDBPluginStorageBackend; workspace: IndexedDBPluginStorageBackend }> {
  const [user, workspace] = await Promise.all([
    IndexedDBPluginStorageBackend.create(pluginId, 'user', options),
    IndexedDBPluginStorageBackend.create(pluginId, 'workspace', options),
  ]);
  return { user, workspace };
}
