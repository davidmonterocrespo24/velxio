// @vitest-environment jsdom
/**
 * SDK-007 contract tests — `DisposableStore` semantics + `ctx.subscriptions`.
 *
 * Covers:
 *   - LIFO unwind order on `dispose()`.
 *   - Idempotency: `dispose()` twice is a no-op.
 *   - Fault isolation: a throwing dispose does not block the others.
 *   - Late-arrival `add()` after dispose disposes immediately + warns.
 *   - `ctx.subscriptions` and `ctx.addDisposable()` share the same backing store.
 *   - 100-disposable smoke test: registry returns to baseline after teardown.
 *   - `subscriptions.size` and `isDisposed` flags reflect state correctly.
 *   - The host's own adapter-tracked handles are torn down on the same dispose.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  defineComponent,
  type Disposable,
  type EventBusReader,
  type PluginManifest,
  type PluginPermission,
} from '@velxio/sdk';

import { createPluginContext } from '../plugin-host/createPluginContext';
import { HostDisposableStore } from '../plugin-host/DisposableStore';
import { createPluginLogger } from '../plugin-host/PluginLogger';
import componentRegistry from '../services/ComponentRegistry';

const fakeEvents: EventBusReader = {
  on: () => () => {},
  hasListeners: () => false,
  listenerCount: () => 0,
};

function manifest(
  perms: PluginPermission[] = [],
  extras: Partial<PluginManifest> = {},
): PluginManifest {
  return {
    schemaVersion: 1,
    id: 'sdk007.test',
    name: 'SDK-007 Test',
    version: '1.0.0',
    publisher: { name: 'Tester' },
    description: 'plugin used by SDK-007 contract tests',
    icon: 'https://example.com/icon.svg',
    license: 'MIT',
    category: 'utility',
    tags: [],
    type: ['ui-extension'],
    entry: { module: 'index.js' },
    permissions: perms,
    pricing: { model: 'free' },
    refundPolicy: 'none',
    ...extras,
  } as PluginManifest;
}

// ── HostDisposableStore — direct unit tests ─────────────────────────────────

describe('HostDisposableStore', () => {
  function freshStore(): {
    store: HostDisposableStore;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  } {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createPluginLogger(manifest());
    const store = new HostDisposableStore(logger, 'unit-test');
    return { store, warn, error };
  }

  it('dispose unwinds in LIFO order', () => {
    const { store, warn, error } = freshStore();
    const order: number[] = [];
    store.add({ dispose: () => order.push(1) });
    store.add({ dispose: () => order.push(2) });
    store.add({ dispose: () => order.push(3) });
    store.dispose();
    expect(order).toEqual([3, 2, 1]);
    warn.mockRestore();
    error.mockRestore();
  });

  it('dispose() is idempotent — second call is a no-op', () => {
    const { store, warn, error } = freshStore();
    const fn = vi.fn();
    store.add({ dispose: fn });
    store.dispose();
    store.dispose();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(store.isDisposed).toBe(true);
    warn.mockRestore();
    error.mockRestore();
  });

  it('a throwing dispose is logged and the rest still run', () => {
    const { store, warn, error } = freshStore();
    const survivor = vi.fn();
    store.add({ dispose: survivor });
    store.add({
      dispose: () => {
        throw new Error('boom');
      },
    });
    store.add(survivor as unknown as Disposable extends never ? never : Disposable);
    // The middle one throws — the wrappers around it must still run.
    expect(() => store.dispose()).not.toThrow();
    expect(survivor).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it('add() after dispose disposes the late-arrival immediately and warns', () => {
    const { store, warn, error } = freshStore();
    store.dispose();
    const late = vi.fn();
    store.add({ dispose: late });
    expect(late).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it('size reflects current count and resets after dispose', () => {
    const { store, warn, error } = freshStore();
    expect(store.size).toBe(0);
    store.add({ dispose: () => {} });
    store.add({ dispose: () => {} });
    expect(store.size).toBe(2);
    store.dispose();
    expect(store.size).toBe(0);
    warn.mockRestore();
    error.mockRestore();
  });
});

// ── ctx.subscriptions — same backing store as host adapters ─────────────────

describe('ctx.subscriptions', () => {
  it('is exposed on the context and is a DisposableStore', () => {
    const { context } = createPluginContext(manifest([]), { events: fakeEvents });
    expect(context.subscriptions).toBeDefined();
    expect(typeof context.subscriptions.add).toBe('function');
    expect(typeof context.subscriptions.dispose).toBe('function');
    expect(context.subscriptions.isDisposed).toBe(false);
  });

  it('addDisposable() and subscriptions.add() share the same store', () => {
    const { context, dispose } = createPluginContext(manifest([]), {
      events: fakeEvents,
    });
    const a = vi.fn();
    const b = vi.fn();
    context.addDisposable({ dispose: a });
    context.subscriptions.add({ dispose: b });
    expect(context.subscriptions.size).toBe(2);
    dispose();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('host-tracked registry handles tear down on the same dispose() as plugin-tracked subscriptions', () => {
    const { context, ui, dispose } = createPluginContext(
      manifest(['ui.command.register']),
      { events: fakeEvents },
    );
    // Plugin-managed: passed via subscriptions.add directly.
    const pluginOwned = vi.fn();
    context.subscriptions.add({ dispose: pluginOwned });
    // Host-managed: returned by a registry call. The adapter pushes the
    // handle into the same store so we don't end up with two parallel lists.
    context.commands.register({ id: 'a', title: 'A', run: () => {} });
    expect(ui.commands.has('a')).toBe(true);
    expect(context.subscriptions.size).toBe(2);
    dispose();
    expect(pluginOwned).toHaveBeenCalledTimes(1);
    expect(ui.commands.has('a')).toBe(false);
    expect(context.subscriptions.isDisposed).toBe(true);
  });

  it('100 registrations + dispose returns the host registries to baseline', () => {
    const { context, ui, dispose } = createPluginContext(
      manifest([
        'ui.command.register',
        'ui.toolbar.register',
        'components.register',
      ]),
      { events: fakeEvents, fetchImpl: undefined },
    );
    const baselineComponents = componentRegistry.list().length;
    const componentIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = `sdk007.test.cmp.${i}`;
      componentIds.push(id);
      if (i % 3 === 0) {
        context.commands.register({
          id: `sdk007.test.cmd.${i}`,
          title: `cmd ${i}`,
          run: () => {},
        });
      } else if (i % 3 === 1) {
        context.toolbar.register({
          id: `sdk007.test.tb.${i}`,
          commandId: `sdk007.test.cmd.${i - 1}`,
          label: `tb ${i}`,
          position: 'left',
        });
      } else {
        context.components.register(
          defineComponent({
            id,
            name: `Bulk ${i}`,
            category: 'basic',
            element: 'wokwi-led',
            description: '',
            pins: [{ name: 'A', x: 0, y: 0 }],
          }),
        );
      }
    }
    expect(context.subscriptions.size).toBe(100);
    expect(componentRegistry.list().length).toBeGreaterThan(baselineComponents);

    dispose();

    expect(context.subscriptions.isDisposed).toBe(true);
    expect(context.subscriptions.size).toBe(0);
    expect(ui.commands.size()).toBe(0);
    expect(ui.toolbar.size()).toBe(0);
    // Every plugin-registered component is gone from the global registry.
    for (const id of componentIds) {
      expect(componentRegistry.get(id)).toBeUndefined();
    }
    expect(componentRegistry.list().length).toBe(baselineComponents);
  });

  it('returning a Disposable from activate() is equivalent to subscriptions.add — both fire on dispose', () => {
    // We don't have a loader yet, but the contract works the same: the
    // plugin can either push to subscriptions.add or return a disposable
    // that the host (future loader) hands back through addDisposable.
    const { context, dispose } = createPluginContext(manifest([]), {
      events: fakeEvents,
    });
    const fn = vi.fn();
    const handFromActivate: Disposable = { dispose: fn };
    // Simulate the loader doing `ctx.addDisposable(returnValue)`.
    context.addDisposable(handFromActivate);
    dispose();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('plugin-side subscriptions.dispose() (manual partial teardown) does NOT prevent later host dispose', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { context, dispose } = createPluginContext(
        manifest(['ui.command.register']),
        { events: fakeEvents },
      );
      context.commands.register({ id: 'a', title: 'A', run: () => {} });
      // Plugin manually disposes the store mid-activation. From here on,
      // every new add() is disposed immediately + warns.
      context.subscriptions.dispose();
      const late = vi.fn();
      context.subscriptions.add({ dispose: late });
      expect(late).toHaveBeenCalledTimes(1);
      // Host's outer dispose() is then idempotent — no double-fire.
      const second = vi.fn();
      context.addDisposable({ dispose: second });
      expect(second).toHaveBeenCalledTimes(1);
      dispose();
      // Confirm second never fires twice.
      expect(second).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
