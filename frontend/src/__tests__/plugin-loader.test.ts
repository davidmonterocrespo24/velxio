// @vitest-environment jsdom
/**
 * End-to-end PluginLoader tests with a stubbed PluginManager.
 *
 * The loader goes:
 *   cache → fetch → verify → manager.load
 *
 * We stub the manager to a deterministic "always succeed unless told
 * otherwise" so we can assert: (1) cache hits skip the fetch, (2) cache
 * misses populate the cache after verify, (3) integrity mismatch ends
 * with `failed`, (4) network exhaustion with no cache ends with
 * `offline`, (5) the manager error is preserved on failed activate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginManifest } from '@velxio/sdk';

import {
  computeBundleHash,
  MemoryCacheBackend,
  PluginCache,
  PluginLoader,
  type InstalledPlugin,
} from '../plugins/loader';
import type {
  LoadOptions,
  PluginEntry,
  PluginManager,
} from '../plugins/runtime/PluginManager';

// ── stubs ────────────────────────────────────────────────────────────────

interface StubManagerCall {
  manifest: PluginManifest;
  opts: LoadOptions;
}

class StubManager {
  readonly calls: StubManagerCall[] = [];
  fail: { name: string; message: string } | null = null;
  async load(manifest: PluginManifest, opts: LoadOptions): Promise<PluginEntry> {
    this.calls.push({ manifest, opts });
    if (this.fail !== null) {
      const e = new Error(this.fail.message);
      e.name = this.fail.name;
      throw e;
    }
    return { id: manifest.id, manifest, status: 'active' };
  }
  unload(_id: string): void { /* not used here */ }
  list(): readonly PluginEntry[] { return []; }
  get(): PluginEntry | undefined { return undefined; }
  subscribe(): () => void { return () => {}; }
  resetForTests(): void { this.calls.length = 0; this.fail = null; }
}

function manifest(id: string, version = '1.0.0'): PluginManifest {
  return {
    schemaVersion: 1,
    id,
    name: id,
    version,
    publisher: { name: 'Tester' },
    description: 'loader test',
    icon: 'https://example.com/icon.svg',
    license: 'MIT',
    category: 'utility',
    tags: [],
    type: ['ui-extension'],
    entry: { module: 'index.js' },
    permissions: [],
    pricing: { model: 'free' },
    refundPolicy: 'none',
  } as PluginManifest;
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function ok(b: Uint8Array): Response { return new Response(b, { status: 200, statusText: 'OK' }); }

let backend: MemoryCacheBackend;
let cache: PluginCache;
let mgr: StubManager;

beforeEach(() => {
  backend = new MemoryCacheBackend();
  cache = new PluginCache({ backend });
  mgr = new StubManager();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── tests ────────────────────────────────────────────────────────────────

describe('PluginLoader · cache miss → fetch → verify → load', () => {
  it('happy path populates the cache and reports source=cdn', async () => {
    const body = bytes('plugin source');
    const hash = await computeBundleHash(body);
    const fetchImpl = vi.fn().mockResolvedValue(ok(body));
    const loader = new PluginLoader({
      cache,
      fetchOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, preferDevServer: false, baseDelayMs: 1 },
      manager: mgr as unknown as PluginManager,
    });
    const installed: InstalledPlugin[] = [
      { manifest: manifest('a'), bundleHash: hash },
    ];
    const [outcome] = await loader.loadInstalled(installed);
    expect(outcome?.status).toBe('active');
    expect(outcome?.source).toBe('cdn');
    expect(outcome?.cacheHit).toBe(false);
    expect(outcome?.fetchAttempts).toBe(1);
    expect(mgr.calls.length).toBe(1);
    expect(mgr.calls[0]?.opts.integrity).toBe(hash);
    // Cache populated.
    const cached = await cache.get('a', '1.0.0');
    expect(cached?.hash).toBe(hash);
  });
});

describe('PluginLoader · cache hit', () => {
  it('skips the fetch when bytes are cached and hash matches', async () => {
    const body = bytes('cached plugin');
    const hash = await computeBundleHash(body);
    await cache.put('a', '1.0.0', { bundle: body.buffer.slice(0), hash, manifest: manifest('a') });
    const fetchImpl = vi.fn().mockRejectedValue(new Error('should not be called'));
    const loader = new PluginLoader({
      cache,
      fetchOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, preferDevServer: false },
      manager: mgr as unknown as PluginManager,
    });
    const [outcome] = await loader.loadInstalled([{ manifest: manifest('a'), bundleHash: hash }]);
    expect(outcome?.status).toBe('active');
    expect(outcome?.source).toBe('cache');
    expect(outcome?.cacheHit).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats a cache hit with hash drift as a miss and refetches', async () => {
    const body = bytes('new bytes');
    const newHash = await computeBundleHash(body);
    await cache.put('a', '1.0.0', { bundle: bytes('old bytes').buffer.slice(0), hash: 'oldhash', manifest: manifest('a') });
    const fetchImpl = vi.fn().mockResolvedValue(ok(body));
    const loader = new PluginLoader({
      cache,
      fetchOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, preferDevServer: false, baseDelayMs: 1 },
      manager: mgr as unknown as PluginManager,
    });
    const [outcome] = await loader.loadInstalled([{ manifest: manifest('a'), bundleHash: newHash }]);
    expect(outcome?.status).toBe('active');
    expect(outcome?.source).toBe('cdn');
    expect(outcome?.cacheHit).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('PluginLoader · failures', () => {
  it('integrity mismatch ends with failed and does not poison the cache', async () => {
    const body = bytes('mitm');
    const fetchImpl = vi.fn().mockResolvedValue(ok(body));
    const loader = new PluginLoader({
      cache,
      fetchOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, preferDevServer: false, baseDelayMs: 1 },
      manager: mgr as unknown as PluginManager,
    });
    const [outcome] = await loader.loadInstalled([{ manifest: manifest('a'), bundleHash: 'deadbeef' }]);
    expect(outcome?.status).toBe('failed');
    expect(outcome?.error?.name).toBe('BundleIntegrityError');
    expect(await cache.get('a', '1.0.0')).toBeUndefined();
    expect(mgr.calls.length).toBe(0);
  });

  it('exhausted CDN with no cache ends with offline', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const loader = new PluginLoader({
      cache,
      fetchOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, preferDevServer: false, attempts: 2, baseDelayMs: 1 },
      manager: mgr as unknown as PluginManager,
    });
    const [outcome] = await loader.loadInstalled([{ manifest: manifest('a'), bundleHash: 'aa' }]);
    expect(outcome?.status).toBe('offline');
    expect(mgr.calls.length).toBe(0);
  });

  it('manager.load throw is captured as failed outcome', async () => {
    const body = bytes('plugin');
    const hash = await computeBundleHash(body);
    const fetchImpl = vi.fn().mockResolvedValue(ok(body));
    mgr.fail = { name: 'ActivateError', message: 'plugin activate threw' };
    const loader = new PluginLoader({
      cache,
      fetchOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, preferDevServer: false, baseDelayMs: 1 },
      manager: mgr as unknown as PluginManager,
    });
    const [outcome] = await loader.loadInstalled([{ manifest: manifest('a'), bundleHash: hash }]);
    expect(outcome?.status).toBe('failed');
    expect(outcome?.error?.name).toBe('ActivateError');
    expect(outcome?.error?.message).toContain('plugin activate threw');
  });
});

describe('PluginLoader · enabled flag', () => {
  it('enabled:false skips the fetch and reports disabled', async () => {
    const fetchImpl = vi.fn();
    const loader = new PluginLoader({
      cache,
      fetchOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, preferDevServer: false },
      manager: mgr as unknown as PluginManager,
    });
    const [outcome] = await loader.loadInstalled([
      { manifest: manifest('a'), bundleHash: 'x', enabled: false },
    ]);
    expect(outcome?.status).toBe('disabled');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mgr.calls.length).toBe(0);
  });
});

describe('PluginLoader · concurrency + GC', () => {
  it('failures of one plugin do not block others', async () => {
    const okBody = bytes('good');
    const okHash = await computeBundleHash(okBody);
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/bad/')) return new Response('boom', { status: 500 });
      return ok(okBody);
    });
    const loader = new PluginLoader({
      cache,
      fetchOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, preferDevServer: false, attempts: 1, baseDelayMs: 1 },
      manager: mgr as unknown as PluginManager,
    });
    const installed: InstalledPlugin[] = [
      { manifest: manifest('good'), bundleHash: okHash },
      { manifest: manifest('bad'), bundleHash: 'aa' },
    ];
    const outcomes = await loader.loadInstalled(installed);
    const byId = Object.fromEntries(outcomes.map((o) => [o.id, o]));
    expect(byId['good']?.status).toBe('active');
    expect(byId['bad']?.status).toBe('offline');
  });

  it('runs GC after the batch, preserving currently-active versions', async () => {
    const tinyCache = new PluginCache({ backend, maxBytes: 50 });
    // Pre-fill with a stale 100-byte entry that should be evicted.
    await tinyCache.put('stale', '0.0.1', {
      bundle: new Uint8Array(100).buffer,
      hash: 'h',
      manifest: manifest('stale', '0.0.1'),
      cachedAt: 1,
    });
    const body = bytes('x'.repeat(20));
    const hash = await computeBundleHash(body);
    const fetchImpl = vi.fn().mockResolvedValue(ok(body));
    const loader = new PluginLoader({
      cache: tinyCache,
      fetchOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, preferDevServer: false, baseDelayMs: 1 },
      manager: mgr as unknown as PluginManager,
    });
    await loader.loadInstalled([{ manifest: manifest('current'), bundleHash: hash }]);
    expect(await tinyCache.get('stale', '0.0.1')).toBeUndefined();
    expect(await tinyCache.get('current', '1.0.0')).toBeDefined();
  });
});
