// @vitest-environment jsdom
/**
 * Plugin host contract tests — exercises every permission gate, the
 * storage quota, the scoped fetch allowlist, and an end-to-end activation
 * that registers commands, panels, components, and uses storage + fetch.
 *
 * The test plugin's manifest declares the minimum permissions for whatever
 * we exercise; deny tests construct manifests with permissions OMITTED to
 * verify the gate fires synchronously.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PermissionDeniedError,
  StorageQuotaError,
  HttpAllowlistDeniedError,
  HttpResponseTooLargeError,
  type EventBusReader,
  type PluginManifest,
  type PluginPermission,
} from '@velxio/sdk';

import { createPluginContext } from '../plugin-host/createPluginContext';
import {
  InMemoryPluginStorage,
  MapStorageBackend,
} from '../plugin-host/PluginStorage';
import { createScopedFetch } from '../plugin-host/ScopedFetch';
import { hasPermission, requirePermission } from '../plugin-host/PermissionGate';

// ── Test helpers ────────────────────────────────────────────────────────────

const fakeEvents: EventBusReader = {
  on: () => () => {},
  hasListeners: () => false,
  listenerCount: () => 0,
};

function manifest(perms: PluginPermission[] = [], extras: Partial<PluginManifest> = {}): PluginManifest {
  return {
    schemaVersion: 1,
    id: 'test.plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    publisher: { name: 'Tester' },
    description: 'a plugin used by host tests',
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

// ── Permission gate ─────────────────────────────────────────────────────────

describe('PermissionGate', () => {
  it('hasPermission reflects the manifest', () => {
    const m = manifest(['ui.command.register']);
    expect(hasPermission(m, 'ui.command.register')).toBe(true);
    expect(hasPermission(m, 'http.fetch')).toBe(false);
  });

  it('requirePermission throws PermissionDeniedError when missing', () => {
    const m = manifest([]);
    expect(() => requirePermission(m, 'ui.command.register')).toThrow(
      PermissionDeniedError,
    );
  });

  it('PermissionDeniedError carries plugin id and missing permission', () => {
    const m = manifest([], { id: 'foo.bar' });
    try {
      requirePermission(m, 'http.fetch');
    } catch (err) {
      expect(err).toBeInstanceOf(PermissionDeniedError);
      const e = err as PermissionDeniedError;
      expect(e.pluginId).toBe('foo.bar');
      expect(e.permission).toBe('http.fetch');
      return;
    }
    throw new Error('expected throw');
  });

  it('requirePermission is a no-op when the permission is declared', () => {
    const m = manifest(['ui.toolbar.register']);
    expect(() => requirePermission(m, 'ui.toolbar.register')).not.toThrow();
  });
});

// ── Storage + quota ─────────────────────────────────────────────────────────

describe('InMemoryPluginStorage', () => {
  it('round-trips values', async () => {
    const s = new InMemoryPluginStorage('user');
    await s.set('a', { n: 1 });
    expect(await s.get('a')).toEqual({ n: 1 });
    expect(await s.keys()).toEqual(['a']);
  });

  it('delete removes a key', async () => {
    const s = new InMemoryPluginStorage('user');
    await s.set('a', 1);
    await s.delete('a');
    expect(await s.get('a')).toBeUndefined();
  });

  it('throws StorageQuotaError when exceeding quota', async () => {
    const s = new InMemoryPluginStorage('user', new MapStorageBackend(), 100);
    // Two big values that together exceed the cap. The first set succeeds,
    // the second triggers the quota.
    await s.set('a', 'x'.repeat(60));
    await expect(s.set('b', 'y'.repeat(60))).rejects.toBeInstanceOf(
      StorageQuotaError,
    );
  });

  it('replacing an existing key reuses its slot (no false quota trip)', async () => {
    const s = new InMemoryPluginStorage('user', new MapStorageBackend(), 200);
    // a + b together fit. Replacing a with the same-size value must still fit.
    await s.set('a', 'x'.repeat(60));
    await s.set('b', 'y'.repeat(60));
    await expect(s.set('a', 'z'.repeat(60))).resolves.toBeUndefined();
  });

  it('usedBytes reports current footprint', async () => {
    const s = new InMemoryPluginStorage('user');
    expect(s.usedBytes()).toBe(0);
    await s.set('k', 'v');
    expect(s.usedBytes()).toBeGreaterThan(0);
  });
});

// ── Scoped fetch ────────────────────────────────────────────────────────────

describe('createScopedFetch', () => {
  it('rejects URLs not in the allowlist', async () => {
    const m = manifest(['http.fetch'], {
      http: { allowlist: ['https://api.example.com/'] },
    });
    const fetchSpy = vi.fn();
    const f = createScopedFetch(m, { fetchImpl: fetchSpy as never });
    await expect(f('https://evil.com/data')).rejects.toBeInstanceOf(
      HttpAllowlistDeniedError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects http:// even when the allowlist has https:// for the same host', async () => {
    const m = manifest(['http.fetch'], {
      http: { allowlist: ['https://api.example.com/'] },
    });
    const f = createScopedFetch(m, { fetchImpl: vi.fn() as never });
    await expect(f('http://api.example.com/x')).rejects.toBeInstanceOf(
      HttpAllowlistDeniedError,
    );
  });

  it('passes through allowed URLs and tags the request', async () => {
    const m = manifest(['http.fetch'], {
      http: { allowlist: ['https://api.example.com/'] },
      id: 'demo.plugin',
      version: '2.3.4',
    });
    const fakeResponse = new Response('ok', { status: 200 });
    const fetchSpy = vi.fn(async () => fakeResponse);
    const f = createScopedFetch(m, { fetchImpl: fetchSpy as never });
    const res = await f('https://api.example.com/things');
    // The cap wraps the body in a counting ReadableStream, so identity is
    // not preserved — but status, text, and bytes round-trip exactly.
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({
      'X-Velxio-Plugin': 'demo.plugin@2.3.4',
    });
    expect((init as RequestInit).credentials).toBe('omit');
  });

  it('refuses oversize responses early via Content-Length', async () => {
    const m = manifest(['http.fetch'], {
      http: { allowlist: ['https://big.example.com/'] },
    });
    const huge = new Response('', {
      headers: { 'content-length': String(10 * 1024 * 1024) },
    });
    const f = createScopedFetch(m, {
      fetchImpl: (async () => huge) as never,
      maxBytes: 1024,
    });
    await expect(f('https://big.example.com/x')).rejects.toBeInstanceOf(
      HttpResponseTooLargeError,
    );
  });

  it('passes through chunked responses under the cap', async () => {
    const m = manifest(['http.fetch'], {
      http: { allowlist: ['https://big.example.com/'] },
    });
    // Stream three 1-byte chunks; total 3 bytes, well under cap.
    const chunked = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.enqueue(new Uint8Array([2]));
          controller.enqueue(new Uint8Array([3]));
          controller.close();
        },
      }),
    );
    const f = createScopedFetch(m, {
      fetchImpl: (async () => chunked) as never,
      maxBytes: 1024,
    });
    const res = await f('https://big.example.com/x');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual([1, 2, 3]);
  });

  it('aborts mid-stream when a no-Content-Length response exceeds the cap', async () => {
    const m = manifest(['http.fetch'], {
      http: { allowlist: ['https://big.example.com/'] },
    });
    // Server omits Content-Length and streams more than the cap. Each chunk
    // is 100 bytes; the cap is 250 bytes. The third chunk pushes the total
    // to 300, triggering mid-stream abort.
    const chunk = new Uint8Array(100);
    const oversized = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      }),
    );
    const f = createScopedFetch(m, {
      fetchImpl: (async () => oversized) as never,
      maxBytes: 250,
    });
    const res = await f('https://big.example.com/x');
    await expect(res.arrayBuffer()).rejects.toBeInstanceOf(
      HttpResponseTooLargeError,
    );
  });

  it('passes through bodyless responses (e.g. 204) without wrapping', async () => {
    const m = manifest(['http.fetch'], {
      http: { allowlist: ['https://api.example.com/'] },
    });
    const noContent = new Response(null, { status: 204 });
    const f = createScopedFetch(m, {
      fetchImpl: (async () => noContent) as never,
      maxBytes: 100,
    });
    const res = await f('https://api.example.com/x');
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });
});

// ── createPluginContext (gates wired up) ────────────────────────────────────

describe('createPluginContext — gates', () => {
  it('command.register throws without ui.command.register permission', () => {
    const { context } = createPluginContext(manifest([]), { events: fakeEvents });
    expect(() =>
      context.commands.register({
        id: 'p.cmd',
        title: 'Do thing',
        run: () => {},
      }),
    ).toThrow(PermissionDeniedError);
  });

  it('command.register succeeds with permission', () => {
    const { context, ui } = createPluginContext(
      manifest(['ui.command.register']),
      { events: fakeEvents },
    );
    const handle = context.commands.register({
      id: 'p.cmd',
      title: 'Do thing',
      run: () => {},
    });
    expect(ui.commands.has('p.cmd')).toBe(true);
    handle.dispose();
    expect(ui.commands.has('p.cmd')).toBe(false);
  });

  it('storage read requires storage.user.read', async () => {
    const { context } = createPluginContext(
      manifest(['storage.user.write']), // write only, no read
      { events: fakeEvents },
    );
    // write is allowed
    await context.userStorage.set('k', 1);
    // read throws
    await expect(context.userStorage.get('k')).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it('storage write requires storage.user.write', async () => {
    const { context } = createPluginContext(
      manifest(['storage.user.read']),
      { events: fakeEvents },
    );
    await expect(context.userStorage.set('k', 1)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it('http.fetch requires the permission AND a non-empty allowlist for that URL', async () => {
    const m = manifest(['http.fetch'], {
      http: { allowlist: ['https://api.example.com/'] },
    });
    const fetchSpy = vi.fn(async () => new Response('ok'));
    const { context } = createPluginContext(m, {
      events: fakeEvents,
      fetchImpl: fetchSpy as never,
    });
    const res = await context.fetch('https://api.example.com/');
    expect(res.status).toBe(200);
    // Without the permission, even a whitelisted URL rejects.
    const { context: ctx2 } = createPluginContext(
      manifest([], { http: { allowlist: ['https://api.example.com/'] } }),
      { events: fakeEvents, fetchImpl: fetchSpy as never },
    );
    await expect(ctx2.fetch('https://api.example.com/')).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it('dispose() tears down every disposable acquired through ctx (LIFO)', () => {
    const { context, ui, dispose } = createPluginContext(
      manifest([
        'ui.command.register',
        'ui.toolbar.register',
        'ui.statusbar.register',
      ]),
      { events: fakeEvents },
    );
    context.commands.register({ id: 'a', title: 'A', run: () => {} });
    context.toolbar.register({
      id: 'b',
      commandId: 'a',
      label: 'B',
      position: 'left',
    });
    context.statusBar.register({
      id: 'c',
      text: 'C',
      alignment: 'right',
    });
    expect(ui.commands.size()).toBe(1);
    expect(ui.toolbar.size()).toBe(1);
    expect(ui.statusBar.size()).toBe(1);
    dispose();
    expect(ui.commands.size()).toBe(0);
    expect(ui.toolbar.size()).toBe(0);
    expect(ui.statusBar.size()).toBe(0);
  });

  it('addDisposable hooks plugin-managed resources into the same teardown path', () => {
    const fn = vi.fn();
    const { context, dispose } = createPluginContext(manifest([]), {
      events: fakeEvents,
    });
    context.addDisposable({ dispose: fn });
    dispose();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('dispose is idempotent', () => {
    const fn = vi.fn();
    const { context, dispose } = createPluginContext(manifest([]), {
      events: fakeEvents,
    });
    context.addDisposable({ dispose: fn });
    dispose();
    dispose();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a throwing disposable does not block subsequent disposals', () => {
    const survivor = vi.fn();
    const { context, dispose } = createPluginContext(manifest([]), {
      events: fakeEvents,
    });
    context.addDisposable({ dispose: survivor });
    context.addDisposable({
      dispose: () => {
        throw new Error('boom');
      },
    });
    expect(() => dispose()).not.toThrow();
    expect(survivor).toHaveBeenCalledTimes(1);
  });

  it('exposes manifest, logger, and events on the context', () => {
    const { context } = createPluginContext(manifest([]), { events: fakeEvents });
    expect(context.manifest.id).toBe('test.plugin');
    expect(typeof context.logger.info).toBe('function');
    expect(context.events).toBe(fakeEvents);
  });

  it('SpiceRegistry.registerModel is gated and the model is retrievable through ui.spiceModels', () => {
    const { context, ui } = createPluginContext(
      manifest(['simulator.spice.read']),
      { events: fakeEvents },
    );
    const handle = context.spice.registerModel(
      'DPLUGIN',
      '.model DPLUGIN D(Is=1e-15 N=1)',
    );
    expect(ui.spiceModels.has('DPLUGIN')).toBe(true);
    handle.dispose();
    expect(ui.spiceModels.has('DPLUGIN')).toBe(false);
  });

  it('SpiceRegistry.registerModel throws without simulator.spice.read', () => {
    const { context } = createPluginContext(manifest([]), { events: fakeEvents });
    expect(() => context.spice.registerModel('X', '.model X D')).toThrow(
      PermissionDeniedError,
    );
  });
});

// ── End-to-end activation ──────────────────────────────────────────────────

describe('end-to-end plugin activation', () => {
  it('a fake plugin can register a command, save preferences, and call fetch', async () => {
    const m = manifest(
      [
        'ui.command.register',
        'storage.user.read',
        'storage.user.write',
        'http.fetch',
      ],
      {
        id: 'demo.weather',
        http: { allowlist: ['https://api.weather.test/'] },
      },
    );
    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify({ tempC: 21 }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { context, ui, dispose } = createPluginContext(m, {
      events: fakeEvents,
      fetchImpl: fakeFetch as never,
    });

    // simulate what a plugin's `activate(ctx)` would do
    context.commands.register({
      id: 'demo.weather.refresh',
      title: 'Weather: Refresh',
      run: async () => {
        const res = await context.fetch('https://api.weather.test/now');
        const json = (await res.json()) as { tempC: number };
        await context.userStorage.set('lastTempC', json.tempC);
      },
    });

    expect(ui.commands.has('demo.weather.refresh')).toBe(true);
    await ui.commands.execute('demo.weather.refresh');
    expect(fakeFetch).toHaveBeenCalledOnce();
    expect(await context.userStorage.get('lastTempC')).toBe(21);

    dispose();
    expect(ui.commands.size()).toBe(0);
  });
});
