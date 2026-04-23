// @vitest-environment jsdom
/**
 * PluginCache tests — backed by the in-memory `MemoryCacheBackend` so
 * we don't depend on the jsdom IndexedDB polyfill (which `idb-keyval`
 * sometimes refuses to use).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { PluginManifest } from '@velxio/sdk';

import {
  MemoryCacheBackend,
  PluginCache,
} from '../plugins/loader/PluginCache';

function manifest(id: string, version = '1.0.0'): PluginManifest {
  return {
    schemaVersion: 1,
    id,
    name: id,
    version,
    publisher: { name: 'Tester' },
    description: 'cache test',
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

function bytesOf(n: number): ArrayBuffer {
  return new Uint8Array(n).fill(1).buffer;
}

let backend: MemoryCacheBackend;
let cache: PluginCache;

beforeEach(() => {
  backend = new MemoryCacheBackend();
  cache = new PluginCache({ backend, maxBytes: 10_000 });
});

describe('PluginCache · roundtrip', () => {
  it('put + get returns the same entry', async () => {
    await cache.put('a', '1.0.0', { bundle: bytesOf(100), hash: 'h1', manifest: manifest('a') });
    const e = await cache.get('a', '1.0.0');
    expect(e?.hash).toBe('h1');
    expect(e?.size).toBe(100);
    expect(e?.bundle.byteLength).toBe(100);
  });

  it('miss returns undefined', async () => {
    expect(await cache.get('nope', '1.0.0')).toBeUndefined();
  });

  it('list enumerates all (id, version) tuples', async () => {
    await cache.put('a', '1.0.0', { bundle: bytesOf(10), hash: 'h', manifest: manifest('a') });
    await cache.put('a', '1.1.0', { bundle: bytesOf(10), hash: 'h', manifest: manifest('a', '1.1.0') });
    await cache.put('b', '0.0.1', { bundle: bytesOf(10), hash: 'h', manifest: manifest('b', '0.0.1') });
    const items = await cache.list();
    expect(items.map((x) => `${x.id}:${x.version}`).sort()).toEqual([
      'a:1.0.0', 'a:1.1.0', 'b:0.0.1',
    ]);
  });

  it('totalBytes sums size across all entries', async () => {
    await cache.put('a', '1.0.0', { bundle: bytesOf(100), hash: 'h', manifest: manifest('a') });
    await cache.put('b', '1.0.0', { bundle: bytesOf(250), hash: 'h', manifest: manifest('b') });
    expect(await cache.totalBytes()).toBe(350);
  });

  it('delete removes an entry', async () => {
    await cache.put('a', '1.0.0', { bundle: bytesOf(10), hash: 'h', manifest: manifest('a') });
    await cache.delete('a', '1.0.0');
    expect(await cache.get('a', '1.0.0')).toBeUndefined();
  });
});

describe('PluginCache · gc', () => {
  it('does nothing under the byte ceiling', async () => {
    await cache.put('a', '1.0.0', { bundle: bytesOf(100), hash: 'h', manifest: manifest('a') });
    const evicted = await cache.gc();
    expect(evicted).toEqual([]);
    expect(await cache.get('a', '1.0.0')).toBeDefined();
  });

  it('evicts oldest first to fit', async () => {
    const c = new PluginCache({ backend, maxBytes: 200 });
    await c.put('a', '1', { bundle: bytesOf(100), hash: 'h', manifest: manifest('a'), cachedAt: 1 });
    await c.put('b', '1', { bundle: bytesOf(100), hash: 'h', manifest: manifest('b'), cachedAt: 2 });
    await c.put('c', '1', { bundle: bytesOf(100), hash: 'h', manifest: manifest('c'), cachedAt: 3 });
    // Total = 300, ceiling = 200 → evict oldest (a).
    const evicted = await c.gc();
    expect(evicted.map((e) => e.id)).toEqual(['a']);
    expect(await c.get('a', '1')).toBeUndefined();
    expect(await c.get('b', '1')).toBeDefined();
    expect(await c.get('c', '1')).toBeDefined();
  });

  it('never evicts a key in `keep`, even if it is the oldest', async () => {
    const c = new PluginCache({ backend, maxBytes: 200 });
    await c.put('a', '1', { bundle: bytesOf(100), hash: 'h', manifest: manifest('a'), cachedAt: 1 });
    await c.put('b', '1', { bundle: bytesOf(100), hash: 'h', manifest: manifest('b'), cachedAt: 2 });
    await c.put('c', '1', { bundle: bytesOf(100), hash: 'h', manifest: manifest('c'), cachedAt: 3 });
    const evicted = await c.gc({ keep: new Set(['a:1']) });
    expect(evicted.map((e) => e.id)).toEqual(['b']);
    expect(await c.get('a', '1')).toBeDefined();
  });
});

describe('PluginCache · pruneVersions', () => {
  it('drops every version of an id except the keepers', async () => {
    await cache.put('a', '1.0.0', { bundle: bytesOf(10), hash: 'h', manifest: manifest('a') });
    await cache.put('a', '1.1.0', { bundle: bytesOf(10), hash: 'h', manifest: manifest('a', '1.1.0') });
    await cache.put('a', '2.0.0', { bundle: bytesOf(10), hash: 'h', manifest: manifest('a', '2.0.0') });
    await cache.put('b', '1.0.0', { bundle: bytesOf(10), hash: 'h', manifest: manifest('b') });
    const removed = await cache.pruneVersions('a', new Set(['2.0.0']));
    expect(removed).toBe(2);
    expect(await cache.get('a', '1.0.0')).toBeUndefined();
    expect(await cache.get('a', '1.1.0')).toBeUndefined();
    expect(await cache.get('a', '2.0.0')).toBeDefined();
    expect(await cache.get('b', '1.0.0')).toBeDefined();
  });
});
