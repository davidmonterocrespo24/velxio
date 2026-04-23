// @vitest-environment jsdom
/**
 * End-to-end tests for PluginHost + ContextStub talking over a
 * `MessageChannel` (the same code path as a real Worker, minus the
 * worker bootstrap). Verifies:
 *   - Plugin-side `ctx.commands.register({ handler })` reaches the
 *     in-process command registry; calling the host-side handler
 *     bounces back into the worker callback.
 *   - Permission denials raised by the in-process gate surface as
 *     rejected promises in the worker.
 *   - Storage round-trips a value.
 *   - Settings declare/get/set/onChange round-trips.
 *   - Event subscription pushes simulator events into the worker.
 *   - Disposal from the worker side actually disposes the host-side
 *     handle (command disappears).
 *   - terminate() clears every host registration.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  EventBusReader,
  PluginContext,
  PluginManifest,
  PluginPermission,
  SimulatorEventListener,
  SimulatorEventName,
  SimulatorEvents,
} from '@velxio/sdk';
import { defineSettingsSchema } from '@velxio/sdk';

import { PluginHost, type WorkerLike } from '../plugins/runtime/PluginHost';
import { buildContextStub } from '../plugins/runtime/ContextStub';
import { RpcChannel, type RpcEndpoint } from '../plugins/runtime/rpc';

import { resetSettingsRegistryForTests } from '../plugin-host/SettingsRegistry';
import { resetLocaleStoreForTests } from '../plugin-host/I18nRegistry';
import { resetTemplateRegistryForTests } from '../plugin-host/TemplateRegistry';
import { resetLibraryRegistryForTests } from '../plugin-host/LibraryRegistry';

// ── fakes ────────────────────────────────────────────────────────────────

interface FakeBus extends EventBusReader {
  emit<K extends SimulatorEventName>(event: K, payload: SimulatorEvents[K]): void;
}

function fakeEventBus(): FakeBus {
  const listeners = new Map<SimulatorEventName, Set<SimulatorEventListener<SimulatorEventName>>>();
  return {
    on(event, fn) {
      let s = listeners.get(event);
      if (s === undefined) {
        s = new Set();
        listeners.set(event, s);
      }
      s.add(fn as SimulatorEventListener<SimulatorEventName>);
      return () => { s!.delete(fn as SimulatorEventListener<SimulatorEventName>); };
    },
    hasListeners: (event) => (listeners.get(event)?.size ?? 0) > 0,
    listenerCount: (event) => listeners.get(event)?.size ?? 0,
    emit(event, payload) {
      const s = listeners.get(event);
      if (s === undefined) return;
      for (const fn of Array.from(s)) {
        try {
          (fn as SimulatorEventListener<typeof event>)(payload);
        } catch { /* ignore */ }
      }
    },
  };
}

function manifest(
  id = 'runtime.test',
  perms: PluginPermission[] = ['ui.command.register', 'storage.user.read', 'storage.user.write', 'simulator.events.read', 'settings.declare'],
): PluginManifest {
  return {
    schemaVersion: 1,
    id,
    name: 'Runtime Test',
    version: '1.0.0',
    publisher: { name: 'Tester' },
    description: 'plugin used by runtime tests',
    icon: 'https://example.com/icon.svg',
    license: 'MIT',
    category: 'utility',
    tags: [],
    type: ['ui-extension'],
    entry: { module: 'index.js' },
    permissions: perms,
    pricing: { model: 'free' },
    refundPolicy: 'none',
  } as PluginManifest;
}

function endpointFor(port: MessagePort): RpcEndpoint & { close(): void } {
  port.start();
  return {
    postMessage: (msg, transfer) => port.postMessage(msg, (transfer ?? []) as Transferable[]),
    addEventListener: (type, listener) => port.addEventListener(type, listener as EventListener),
    removeEventListener: (type, listener) => port.removeEventListener(type, listener as EventListener),
    close: () => port.close(),
  };
}

/**
 * Fake "worker": a MessagePort masquerading as a WorkerLike. Pair this
 * with a ContextStub on the other end of the MessageChannel and you
 * have the full runtime in one process.
 */
function makeFakeWorker(port: MessagePort): WorkerLike {
  const ep = endpointFor(port);
  return {
    postMessage: ep.postMessage,
    addEventListener: ep.addEventListener,
    removeEventListener: ep.removeEventListener,
    terminate: () => ep.close(),
  };
}

// ── per-test setup: spawn paired host + stub ─────────────────────────────

interface Fixture {
  readonly bus: FakeBus;
  readonly host: PluginHost;
  readonly ctx: PluginContext;
  readonly workerRpc: RpcChannel;
  readonly cleanup: () => void;
}

function spawn(perms?: PluginPermission[]): Fixture {
  const channel = new MessageChannel();
  const bus = fakeEventBus();
  const m = manifest('runtime.test', perms);
  const host = new PluginHost({
    manifest: m,
    worker: makeFakeWorker(channel.port1),
    services: { events: bus },
    pingIntervalMs: 0, // disable for tests
  });
  const workerRpc = new RpcChannel(endpointFor(channel.port2));
  const stub = buildContextStub({ manifest: m, rpc: workerRpc });
  return {
    bus,
    host,
    ctx: stub.context,
    workerRpc,
    cleanup: () => {
      try { stub.dispose(); } catch { /* ignore */ }
      try { workerRpc.dispose(); } catch { /* ignore */ }
      try { host.terminate(); } catch { /* ignore */ }
      channel.port1.close();
      channel.port2.close();
    },
  };
}

beforeEach(() => {
  resetSettingsRegistryForTests();
  resetLocaleStoreForTests();
  resetTemplateRegistryForTests();
  resetLibraryRegistryForTests();
});

let fixture: Fixture | null = null;
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

// ── tests ────────────────────────────────────────────────────────────────

describe('runtime · commands', () => {
  it('register + execute round-trips through the worker boundary', async () => {
    fixture = spawn();
    let invoked = 0;
    fixture.ctx.commands.register({
      id: 'test.cmd',
      title: 'Test Command',
      run: () => { invoked++; },
    });
    await flushMicrotasks();
    // Now invoke from the HOST side (simulating user click in command palette).
    await fixture.host.ui.commands.execute('test.cmd');
    await flushMicrotasks();
    expect(invoked).toBe(1);
  });

  it('disposing the handle removes the command from the host registry', async () => {
    fixture = spawn();
    const handle = fixture.ctx.commands.register({
      id: 'temp.cmd',
      title: 'Temp',
      run: () => {},
    });
    await flushMicrotasks();
    expect(fixture.host.ui.commands.get('temp.cmd')).toBeDefined();
    handle.dispose();
    await flushMicrotasks();
    expect(fixture.host.ui.commands.get('temp.cmd')).toBeUndefined();
  });
});

describe('runtime · permissions', () => {
  it('rejects when the in-process gate denies the call', async () => {
    fixture = spawn([]); // no permissions
    // Identity check by name — instanceof is unreliable across the SDK
    // module boundary (the host and the test may import via different
    // resolved paths, producing two distinct classes). Behaviour is what
    // matters: a PermissionDeniedError surfaces in the worker.
    await expect(
      Promise.resolve(fixture.ctx.userStorage.get('any')),
    ).rejects.toMatchObject({ name: 'PermissionDeniedError' });
  });
});

describe('runtime · storage', () => {
  it('round-trips a value through the host', async () => {
    fixture = spawn();
    await fixture.ctx.userStorage.set('k', { hello: 'world' });
    const v = await fixture.ctx.userStorage.get('k');
    expect(v).toEqual({ hello: 'world' });
  });
});

describe('runtime · events', () => {
  it('fan-outs simulator events to worker subscribers', async () => {
    fixture = spawn();
    const seen: unknown[] = [];
    fixture.ctx.events.on('pin:change', (p) => seen.push(p));
    await flushMicrotasks();
    fixture.bus.emit('pin:change', { componentId: 'led1', pinName: 'A', state: 1 });
    fixture.bus.emit('pin:change', { componentId: 'led1', pinName: 'A', state: 0 });
    await flushMicrotasks();
    // Coalescing on (componentId, pinName) means we get the LATEST state only
    // when a burst happens within one microtask. Two manual emit() calls
    // each schedule their own flush, so both arrive — verify last one wins
    // OR both arrive (depending on timing).
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[seen.length - 1]).toMatchObject({ state: 0 });
  });

  it('unsubscribe stops further deliveries', async () => {
    fixture = spawn();
    const seen: unknown[] = [];
    const off = fixture.ctx.events.on('serial:tx', (p) => seen.push(p));
    await flushMicrotasks();
    fixture.bus.emit('serial:tx', { port: 0, data: new Uint8Array([1]) });
    await flushMicrotasks();
    off();
    await flushMicrotasks();
    fixture.bus.emit('serial:tx', { port: 0, data: new Uint8Array([2]) });
    await flushMicrotasks();
    expect(seen.length).toBe(1);
  });
});

describe('runtime · settings', () => {
  it('declare + get returns defaults', async () => {
    fixture = spawn();
    fixture.ctx.settings.declare({
      schema: defineSettingsSchema({
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['fast', 'slow'], default: 'fast' },
          retries: { type: 'integer', minimum: 0, default: 3 },
        },
      }),
    });
    await flushMicrotasks();
    const values = await fixture.ctx.settings.get();
    expect(values).toEqual({ mode: 'fast', retries: 3 });
  });

  it('set + onChange notifies via callback proxy', async () => {
    fixture = spawn();
    fixture.ctx.settings.declare({
      schema: defineSettingsSchema({
        type: 'object',
        properties: {
          enabled: { type: 'boolean', default: false },
        },
      }),
    });
    await flushMicrotasks();
    const seen: unknown[] = [];
    fixture.ctx.settings.onChange((v) => seen.push(v));
    await flushMicrotasks();
    await fixture.ctx.settings.set({ enabled: true });
    await flushMicrotasks();
    expect(seen.length).toBe(1);
    expect(seen[0]).toEqual({ enabled: true });
  });
});

describe('runtime · terminate', () => {
  it('disposes every host-side registration', async () => {
    fixture = spawn();
    fixture.ctx.commands.register({ id: 'a', title: 'A', handler: () => {} });
    fixture.ctx.commands.register({ id: 'b', title: 'B', handler: () => {} });
    await flushMicrotasks();
    expect(fixture.host.ui.commands.get('a')).toBeDefined();
    expect(fixture.host.ui.commands.get('b')).toBeDefined();
    fixture.host.terminate();
    expect(fixture.host.ui.commands.get('a')).toBeUndefined();
    expect(fixture.host.ui.commands.get('b')).toBeUndefined();
  });

  it('terminating twice is a noop', () => {
    fixture = spawn();
    fixture.host.terminate();
    expect(() => fixture!.host.terminate()).not.toThrow();
  });
});

// ── helpers ──────────────────────────────────────────────────────────────

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}
