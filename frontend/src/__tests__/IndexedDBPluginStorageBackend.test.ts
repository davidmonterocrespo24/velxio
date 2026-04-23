/**
 * IndexedDB-backed plugin storage backend.
 *
 * `fake-indexeddb/auto` patches `globalThis.indexedDB` with a real-IDB
 * implementation that runs in node — no jsdom environment needed. Each
 * test creates its own `createStore(dbName, storeName)` so suites stay
 * isolated even though the Promise-resolving order of `idb-keyval` would
 * otherwise let a previous test's pending writes leak into the next.
 */

import 'fake-indexeddb/auto';

import { describe, expect, it, beforeEach } from 'vitest';
import { createStore, type UseStore } from 'idb-keyval';

import {
  IndexedDBPluginStorageBackend,
  createPluginStorageBackends,
} from '../plugin-host/IndexedDBPluginStorageBackend';
import { InMemoryPluginStorage, type StorageBackend } from '../plugin-host/PluginStorage';

let dbCounter = 0;

function freshStore(): UseStore {
  dbCounter += 1;
  return createStore(`velxio.test-storage-${dbCounter}`, 'entries');
}

describe('IndexedDBPluginStorageBackend', () => {
  beforeEach(() => {
    // Each test mints its own DB name, so no cleanup is required.
  });

  it('returns undefined for keys that have never been set', async () => {
    const backend = await IndexedDBPluginStorageBackend.create('test.plugin', 'user', {
      store: freshStore(),
    });
    expect(backend.get('missing')).toBeUndefined();
    expect(backend.keys()).toEqual([]);
  });

  it('round-trips values via the in-memory mirror without persistence', async () => {
    const backend = await IndexedDBPluginStorageBackend.create('test.plugin', 'user', {
      store: freshStore(),
    });
    backend.set('foo', { count: 7 });
    backend.set('bar', 'hello');
    expect(backend.get('foo')).toEqual({ count: 7 });
    expect(backend.get('bar')).toBe('hello');
    expect(backend.keys().sort()).toEqual(['bar', 'foo']);
  });

  it('persists writes across backend instances backed by the same store', async () => {
    const store = freshStore();
    const writer = await IndexedDBPluginStorageBackend.create('test.plugin', 'user', { store });
    writer.set('alpha', 1);
    writer.set('beta', { nested: true });
    await writer.flushed();

    const reader = await IndexedDBPluginStorageBackend.create('test.plugin', 'user', { store });
    expect(reader.get('alpha')).toBe(1);
    expect(reader.get('beta')).toEqual({ nested: true });
    expect(reader.keys().sort()).toEqual(['alpha', 'beta']);
  });

  it('isolates buckets — `user` and `workspace` of the same plugin do not see each other', async () => {
    const store = freshStore();
    const userBackend = await IndexedDBPluginStorageBackend.create('test.plugin', 'user', { store });
    const workspaceBackend = await IndexedDBPluginStorageBackend.create('test.plugin', 'workspace', { store });

    userBackend.set('shared', 'user-side');
    workspaceBackend.set('shared', 'workspace-side');
    await Promise.all([userBackend.flushed(), workspaceBackend.flushed()]);

    expect(userBackend.get('shared')).toBe('user-side');
    expect(workspaceBackend.get('shared')).toBe('workspace-side');
    expect(userBackend.keys()).toEqual(['shared']);
    expect(workspaceBackend.keys()).toEqual(['shared']);

    // Reload both — the persisted values should still be isolated.
    const userReloaded = await IndexedDBPluginStorageBackend.create('test.plugin', 'user', { store });
    const workspaceReloaded = await IndexedDBPluginStorageBackend.create('test.plugin', 'workspace', { store });
    expect(userReloaded.get('shared')).toBe('user-side');
    expect(workspaceReloaded.get('shared')).toBe('workspace-side');
  });

  it('isolates plugins — two plugin ids with the same key do not see each other', async () => {
    const store = freshStore();
    const a = await IndexedDBPluginStorageBackend.create('plugin.a', 'user', { store });
    const b = await IndexedDBPluginStorageBackend.create('plugin.b', 'user', { store });

    a.set('token', 'a-secret');
    b.set('token', 'b-secret');
    await Promise.all([a.flushed(), b.flushed()]);

    expect(a.get('token')).toBe('a-secret');
    expect(b.get('token')).toBe('b-secret');

    // Cross-instance isolation must hold after reload too.
    const aReloaded = await IndexedDBPluginStorageBackend.create('plugin.a', 'user', { store });
    expect(aReloaded.get('token')).toBe('a-secret');
    expect(aReloaded.keys()).toEqual(['token']);
  });

  it('removes keys from both the mirror and the persisted store', async () => {
    const store = freshStore();
    const writer = await IndexedDBPluginStorageBackend.create('test.plugin', 'user', { store });
    writer.set('keep', 1);
    writer.set('drop', 2);
    await writer.flushed();

    writer.delete('drop');
    expect(writer.get('drop')).toBeUndefined();
    expect(writer.keys()).toEqual(['keep']);
    await writer.flushed();

    const reader = await IndexedDBPluginStorageBackend.create('test.plugin', 'user', { store });
    expect(reader.get('drop')).toBeUndefined();
    expect(reader.keys()).toEqual(['keep']);
  });

  it('preserves write order through the queue (last write wins)', async () => {
    const store = freshStore();
    const writer = await IndexedDBPluginStorageBackend.create('test.plugin', 'user', { store });
    writer.set('counter', 1);
    writer.set('counter', 2);
    writer.set('counter', 3);
    await writer.flushed();

    const reader = await IndexedDBPluginStorageBackend.create('test.plugin', 'user', { store });
    expect(reader.get('counter')).toBe(3);
  });

  it('reports persistence failures via onError without dropping the mirror value', async () => {
    const store = freshStore();
    const errors: unknown[] = [];
    const backend = await IndexedDBPluginStorageBackend.create('test.plugin', 'user', {
      store,
      onError: (err) => errors.push(err),
    });
    backend.set('good', 1);
    // Force the next IDB write to fail by putting a value the IDB encoder
    // can't structured-clone (functions).
    backend.set('bad', () => 42);
    await backend.flushed();

    expect(backend.get('good')).toBe(1);
    expect(backend.get('bad')).toBeInstanceOf(Function);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('createPluginStorageBackends returns both buckets primed in parallel', async () => {
    const store = freshStore();
    const { user, workspace } = await createPluginStorageBackends('test.plugin', { store });

    user.set('u', 1);
    workspace.set('w', 2);
    await Promise.all([user.flushed(), workspace.flushed()]);

    const reload = await createPluginStorageBackends('test.plugin', { store });
    expect(reload.user.get('u')).toBe(1);
    expect(reload.workspace.get('w')).toBe(2);
    expect(reload.user.get('w')).toBeUndefined();
    expect(reload.workspace.get('u')).toBeUndefined();
  });
});

describe('InMemoryPluginStorage backed by IndexedDB', () => {
  it('quota check uses the pre-loaded mirror, not the IDB store', async () => {
    const store = freshStore();
    const backend = await IndexedDBPluginStorageBackend.create('quota.plugin', 'user', { store });
    const cap = 256;
    const persisted: StorageBackend = backend;
    const storage = new InMemoryPluginStorage('user', persisted, cap);

    await storage.set('a', 'x'.repeat(100));
    await expect(storage.set('b', 'y'.repeat(200))).rejects.toThrow(/quota/i);
    expect(await storage.get<string>('a')).toBe('x'.repeat(100));
  });

  it('writes survive restart via the wrapper await flushed contract', async () => {
    const store = freshStore();
    const session1Backend = await IndexedDBPluginStorageBackend.create(
      'restart.plugin',
      'user',
      { store },
    );
    const session1 = new InMemoryPluginStorage('user', session1Backend);
    await session1.set('config', { theme: 'dark' });
    await session1.delete('config');
    await session1.set('config', { theme: 'light' });

    const session2Backend = await IndexedDBPluginStorageBackend.create(
      'restart.plugin',
      'user',
      { store },
    );
    const session2 = new InMemoryPluginStorage('user', session2Backend);
    expect(await session2.get('config')).toEqual({ theme: 'light' });
  });
});
