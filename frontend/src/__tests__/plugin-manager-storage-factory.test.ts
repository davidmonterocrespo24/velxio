// @vitest-environment jsdom
/**
 * `PluginManager.load()` storage backend factory wiring.
 *
 * Verifies:
 *   - When `configure()` is called WITHOUT a `storageBackendFactory`,
 *     loaded plugins fall back to in-memory storage (no IDB hit).
 *   - When the factory IS configured, the manager awaits it for both
 *     buckets BEFORE constructing the worker, and forwards the resolved
 *     backends to `createPluginContext` via the per-plugin services overlay.
 *   - The factory is called once per plugin per bucket — the manager
 *     does not share backend instances between plugins (cross-plugin
 *     isolation depends on each backend carrying its own pluginId prefix).
 *   - When the factory throws, the entry is marked `failed` and the
 *     worker is never constructed (the user sees the failure in the
 *     Installed Plugins panel, the bundle never executes).
 */

import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EventBusReader,
  PluginManifest,
  SimulatorEventListener,
  SimulatorEventName,
} from '@velxio/sdk';

import {
  getPluginManager,
  resetPluginManagerForTests,
  type WorkerFactory,
  type PluginStorageBackendFactory,
} from '../plugins/runtime/PluginManager';
import type { WorkerLike } from '../plugins/runtime/PluginHost';
import type { StorageBackend } from '../plugin-host/PluginStorage';

// ── fakes ────────────────────────────────────────────────────────────────

function fakeEventBus(): EventBusReader {
  return {
    on: () => () => {},
    hasListeners: () => false,
    listenerCount: () => 0,
  } as unknown as EventBusReader & {
    emit<K extends SimulatorEventName>(event: K, payload: unknown): void;
  };
}

/**
 * Worker that resolves the init handshake by replying `ready` to the
 * first `init` message it sees. We only need the manager's load path to
 * succeed — actual RPC dispatch is exercised in plugin-runtime-host.
 */
function makeReadyWorker(): WorkerLike {
  let listener: ((ev: MessageEvent) => void) | null = null;
  const worker: WorkerLike = {
    postMessage(msg: unknown) {
      const data = msg as { kind?: string };
      if (data?.kind === 'init') {
        // Reply on a microtask so the listener is already attached.
        queueMicrotask(() => {
          listener?.({ data: { kind: 'ready' } } as MessageEvent);
        });
      }
    },
    addEventListener(_type: string, fn: EventListenerOrEventListenerObject) {
      listener = fn as (ev: MessageEvent) => void;
    },
    removeEventListener() {
      listener = null;
    },
    terminate() {
      listener = null;
    },
  } as unknown as WorkerLike;
  return worker;
}

const workerFactory: WorkerFactory = { create: () => makeReadyWorker() };

function manifest(id = 'sb.test'): PluginManifest {
  return {
    schemaVersion: 1,
    id,
    name: 'Storage Backend Test',
    version: '1.0.0',
    publisher: { name: 'Tester' },
    description: 'manager storage factory test',
    icon: 'https://example.com/icon.svg',
    license: 'MIT',
    category: 'utility',
    tags: [],
    type: ['ui-extension'],
    entry: { module: 'index.js' },
    permissions: ['storage.user.read', 'storage.user.write'],
    pricing: { model: 'free' },
    refundPolicy: 'none',
  } as PluginManifest;
}

function recordingBackend(): StorageBackend & { writes: Array<[string, unknown]> } {
  const data = new Map<string, unknown>();
  const writes: Array<[string, unknown]> = [];
  return {
    get: (k: string) => data.get(k),
    set: (k: string, v: unknown) => {
      data.set(k, v);
      writes.push([k, v]);
    },
    delete: (k: string) => { data.delete(k); },
    keys: () => [...data.keys()],
    writes,
  };
}

// ── lifecycle ────────────────────────────────────────────────────────────

beforeEach(() => {
  resetPluginManagerForTests();
});

afterEach(() => {
  resetPluginManagerForTests();
});

// ── tests ────────────────────────────────────────────────────────────────

describe('PluginManager · storage backend factory', () => {
  it('loads a plugin without calling the factory when none is configured', async () => {
    const mgr = getPluginManager();
    mgr.configure({
      factory: workerFactory,
      services: { events: fakeEventBus() },
    });
    const entry = await mgr.load(manifest('a'), { bundleUrl: 'blob:test' });
    expect(entry.status).toBe('active');
  });

  it('awaits the factory for BOTH buckets before constructing the worker', async () => {
    const mgr = getPluginManager();
    const calls: Array<{ id: string; bucket: string }> = [];
    let workerCreated = false;
    const factory: PluginStorageBackendFactory = async (id, bucket) => {
      calls.push({ id, bucket });
      // Simulate an async pre-load — IDB scan would take a tick or two.
      await Promise.resolve();
      return recordingBackend();
    };
    const wf: WorkerFactory = {
      create: () => {
        workerCreated = true;
        return makeReadyWorker();
      },
    };
    mgr.configure({
      factory: wf,
      services: { events: fakeEventBus() },
      storageBackendFactory: factory,
    });

    const entry = await mgr.load(manifest('b'), { bundleUrl: 'blob:test' });
    expect(entry.status).toBe('active');
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.bucket).sort()).toEqual(['user', 'workspace']);
    expect(calls.every((c) => c.id === 'b')).toBe(true);
    expect(workerCreated).toBe(true);
  });

  it('calls the factory once per plugin, not shared across plugins', async () => {
    const mgr = getPluginManager();
    const factorySpy = vi.fn<PluginStorageBackendFactory>(async () => recordingBackend());
    mgr.configure({
      factory: workerFactory,
      services: { events: fakeEventBus() },
      storageBackendFactory: factorySpy,
    });
    await mgr.load(manifest('p1'), { bundleUrl: 'blob:test' });
    await mgr.load(manifest('p2'), { bundleUrl: 'blob:test' });
    // 2 plugins × 2 buckets = 4 calls
    expect(factorySpy).toHaveBeenCalledTimes(4);
    const ids = factorySpy.mock.calls.map((c) => c[0]).sort();
    expect(ids).toEqual(['p1', 'p1', 'p2', 'p2']);
  });

  it('marks the entry failed and never constructs the worker when the factory throws', async () => {
    const mgr = getPluginManager();
    let workerCreated = false;
    const wf: WorkerFactory = {
      create: () => {
        workerCreated = true;
        return makeReadyWorker();
      },
    };
    mgr.configure({
      factory: wf,
      services: { events: fakeEventBus() },
      storageBackendFactory: async () => {
        throw new Error('IDB open failed');
      },
    });
    await expect(mgr.load(manifest('bad'), { bundleUrl: 'blob:test' })).rejects.toThrow(/IDB open failed/);
    expect(workerCreated).toBe(false);
    const entry = mgr.get('bad');
    expect(entry?.status).toBe('failed');
    expect(entry?.error?.message).toMatch(/IDB open failed/);
  });

  it('respects per-load services override and skips the factory when backends are pre-supplied', async () => {
    const mgr = getPluginManager();
    const factorySpy = vi.fn<PluginStorageBackendFactory>(async () => recordingBackend());
    mgr.configure({
      factory: workerFactory,
      services: { events: fakeEventBus() },
      storageBackendFactory: factorySpy,
    });

    const userBackend = recordingBackend();
    const workspaceBackend = recordingBackend();
    await mgr.load(manifest('c'), {
      bundleUrl: 'blob:test',
      services: {
        events: fakeEventBus(),
        userStorageBackend: userBackend,
        workspaceStorageBackend: workspaceBackend,
      },
    });
    // Caller pre-supplied both buckets → factory must NOT be invoked.
    expect(factorySpy).not.toHaveBeenCalled();
  });
});
