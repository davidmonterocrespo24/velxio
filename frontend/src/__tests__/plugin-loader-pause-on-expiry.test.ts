// @vitest-environment jsdom
/**
 * Pause-on-expiry timer + PluginManager.pause/resume primitives (CORE-008c).
 *
 * The loader arms a `setTimeout` for any plugin whose license carries a
 * future `expiresAt`. When the timer fires, the loader calls
 * `manager.pause(id, 'license-expired')` so the worker is left running
 * (renew + resume is O(1)) but the UI surfaces the expired state.
 *
 * Coverage:
 *   - PluginManager.pause(id, reason) flips status, preserves the worker
 *     handle, and is idempotent on already-paused / non-existent ids.
 *   - PluginManager.resume(id) restores 'active' iff the host is alive.
 *   - PluginLoader arms a timer per paid plugin with `expiresAt`.
 *   - Timer fires → manager.pause runs with reason 'license-expired'.
 *   - Timer is cancelled on `manager.unload(id)` (no late pause after teardown).
 *   - Already-expired licenses (clock skew) pause synchronously after load.
 *   - Long expiry > 24 h re-arms in chunks.
 *   - Free plugins / perpetual paid licenses do NOT arm a timer.
 *   - `loader.dispose()` clears every pending timer.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginManifest } from '@velxio/sdk';

import {
  computeBundleHash,
  inMemoryLicenseResolver,
  MemoryCacheBackend,
  PluginCache,
  PluginLoader,
  type InstalledPlugin,
} from '../plugins/loader';
import { base64UrlEncode } from '../plugins/license/base64url';
import { canonicalJsonStringify, utf8Encode } from '../plugins/license/canonicalize';
import {
  type ActivePublicKey,
  type LicenseToken,
  type SignedLicense,
} from '../plugins/license/types';
import {
  getPluginManager,
  resetPluginManagerForTests,
  type PluginEntry,
  type PluginPauseReason,
  type PluginManager,
  type WorkerFactory,
} from '../plugins/runtime/PluginManager';

// ── crypto helpers (mirrors plugin-loader-license-gate.test.ts) ─────────

interface TestKey {
  readonly active: ActivePublicKey;
  readonly privateKey: CryptoKey;
}

async function makeTestKey(kid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return {
    privateKey: pair.privateKey,
    active: { kid, key: pair.publicKey },
  };
}

async function sign(
  payload: LicenseToken,
  privateKey: CryptoKey,
  kid?: string,
): Promise<SignedLicense> {
  const bytes = utf8Encode(canonicalJsonStringify(payload));
  const sigBuf = await crypto.subtle.sign(
    'Ed25519',
    privateKey,
    bytes as unknown as ArrayBuffer,
  );
  return { payload, sig: base64UrlEncode(new Uint8Array(sigBuf)), kid };
}

const NOW = Date.parse('2026-04-22T00:00:00Z');

function payloadFor(overrides: Partial<LicenseToken> = {}): LicenseToken {
  return {
    v: 1,
    pluginId: 'pro.scope',
    pluginVersion: '^1.0.0',
    userId: 'buyer-uuid',
    kind: 'subscription',
    issuedAt: '2026-04-01T00:00:00Z',
    transferable: true,
    ...overrides,
  } as LicenseToken;
}

function paidManifest(id = 'pro.scope', version = '1.0.0'): PluginManifest {
  return {
    schemaVersion: 1,
    id,
    name: id,
    version,
    publisher: { name: 'Tester' },
    description: 'pause test',
    icon: 'https://example.com/icon.svg',
    license: 'Proprietary',
    category: 'utility',
    tags: [],
    type: ['ui-extension'],
    entry: { module: 'index.js' },
    permissions: [],
    pricing: { model: 'subscription', currency: 'USD', amount: 999 },
    refundPolicy: 'none',
  } as unknown as PluginManifest;
}

function freeManifest(id = 'free.tool'): PluginManifest {
  return {
    schemaVersion: 1,
    id,
    name: id,
    version: '1.0.0',
    publisher: { name: 'Tester' },
    description: 'free',
    icon: 'https://example.com/icon.svg',
    license: 'MIT',
    category: 'utility',
    tags: [],
    type: ['ui-extension'],
    entry: { module: 'index.js' },
    permissions: [],
    pricing: { model: 'free' },
    refundPolicy: 'none',
  } as unknown as PluginManifest;
}

// ── stub manager (records pause/resume + load/unload) ────────────────────

interface PauseCall {
  readonly id: string;
  readonly reason: PluginPauseReason;
}

class StubManager {
  readonly loaded = new Set<string>();
  readonly unloaded: string[] = [];
  readonly paused: PauseCall[] = [];
  readonly resumed: string[] = [];
  private readonly entries = new Map<string, PluginEntry>();
  private readonly subscribers = new Set<() => void>();

  async load(m: PluginManifest): Promise<PluginEntry> {
    this.loaded.add(m.id);
    const entry: PluginEntry = { id: m.id, manifest: m, status: 'active' };
    this.entries.set(m.id, entry);
    this.notify();
    return entry;
  }
  unload(id: string): void {
    this.unloaded.push(id);
    const e = this.entries.get(id);
    if (e !== undefined) {
      this.entries.set(id, { ...e, status: 'unloaded' });
      this.notify();
    }
  }
  pause(id: string, reason: PluginPauseReason): void {
    this.paused.push({ id, reason });
    const e = this.entries.get(id);
    if (e !== undefined) {
      this.entries.set(id, { ...e, status: 'paused', pauseReason: reason });
      this.notify();
    }
  }
  resume(id: string): void {
    this.resumed.push(id);
    const e = this.entries.get(id);
    if (e !== undefined && e.status === 'paused') {
      this.entries.set(id, { ...e, status: 'active' });
      this.notify();
    }
  }
  list(): readonly PluginEntry[] { return Array.from(this.entries.values()); }
  get(id: string): PluginEntry | undefined { return this.entries.get(id); }
  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => { this.subscribers.delete(fn); };
  }
  private notify(): void {
    for (const fn of Array.from(this.subscribers)) {
      try { fn(); } catch { /* ignore */ }
    }
  }
}

// ── shared state ────────────────────────────────────────────────────────

let backend: MemoryCacheBackend;
let cache: PluginCache;
let mgr: StubManager;
let primary: TestKey;

beforeAll(async () => {
  primary = await makeTestKey('k1');
});

beforeEach(() => {
  backend = new MemoryCacheBackend();
  cache = new PluginCache({ backend });
  mgr = new StubManager();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  resetPluginManagerForTests();
});

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function ok(b: Uint8Array): Response {
  return new Response(b, { status: 200, statusText: 'OK' });
}

// ── PluginManager.pause / resume primitives ─────────────────────────────

describe('PluginManager · pause / resume', () => {
  /**
   * `WorkerFactory` stub that hands back a no-op worker whose `init`
   * handshake resolves immediately by replying with a `ready` message.
   * We intentionally use the real PluginManager here (not StubManager)
   * because pause/resume are methods on the real implementation.
   */
  function fakeWorkerFactory(): WorkerFactory {
    return {
      create() {
        const listeners = new Set<(ev: MessageEvent) => void>();
        return {
          postMessage(msg: unknown) {
            const data = msg as { kind?: string };
            if (data?.kind === 'init') {
              queueMicrotask(() => {
                for (const fn of listeners) {
                  fn({ data: { kind: 'ready' } } as MessageEvent);
                }
              });
            }
          },
          addEventListener(_type: string, fn: (ev: MessageEvent) => void) {
            listeners.add(fn);
          },
          removeEventListener(_type: string, fn: (ev: MessageEvent) => void) {
            listeners.delete(fn);
          },
          terminate() { listeners.clear(); },
        };
      },
    };
  }

  it('pause(id, reason) sets status to "paused" without unloading', async () => {
    vi.useRealTimers(); // need real microtask flushing for the handshake
    const mgr = getPluginManager();
    const factory = fakeWorkerFactory();
    const services = {
      eventBus: { on: () => () => {}, hasListeners: () => false, listenerCount: () => 0 },
    } as unknown as Parameters<PluginManager['configure']>[0]['services'];
    mgr.configure({ factory, services });
    const entry = await mgr.load(paidManifest(), { bundleUrl: 'about:blank' });
    expect(entry.status).toBe('active');

    mgr.pause('pro.scope', 'license-expired');
    const after = mgr.get('pro.scope');
    expect(after?.status).toBe('paused');
    expect(after?.pauseReason).toBe('license-expired');
    // The host is still alive — no `unloaded` flip happened.
    expect(mgr.list().some((e) => e.id === 'pro.scope' && e.status === 'unloaded')).toBe(false);
  });

  it('pause is idempotent — re-pausing rewrites the reason', async () => {
    vi.useRealTimers();
    const mgr = getPluginManager();
    mgr.configure({
      factory: fakeWorkerFactory(),
      services: { eventBus: { on: () => () => {}, hasListeners: () => false, listenerCount: () => 0 } } as never,
    });
    await mgr.load(paidManifest(), { bundleUrl: 'about:blank' });
    mgr.pause('pro.scope', 'license-expired');
    mgr.pause('pro.scope', 'license-revoked');
    expect(mgr.get('pro.scope')?.pauseReason).toBe('license-revoked');
  });

  it('pause is a no-op for unknown / unloaded / failed entries', () => {
    const mgr = getPluginManager();
    mgr.pause('never.loaded', 'manual');
    expect(mgr.get('never.loaded')).toBeUndefined();
  });

  it('resume(id) restores "active" iff the host is alive', async () => {
    vi.useRealTimers();
    const mgr = getPluginManager();
    mgr.configure({
      factory: fakeWorkerFactory(),
      services: { eventBus: { on: () => () => {}, hasListeners: () => false, listenerCount: () => 0 } } as never,
    });
    await mgr.load(paidManifest(), { bundleUrl: 'about:blank' });
    mgr.pause('pro.scope', 'license-expired');
    mgr.resume('pro.scope');
    expect(mgr.get('pro.scope')?.status).toBe('active');
    expect(mgr.get('pro.scope')?.pauseReason).toBeUndefined();
  });

  it('resume on an unloaded host is a no-op', async () => {
    vi.useRealTimers();
    const mgr = getPluginManager();
    mgr.configure({
      factory: fakeWorkerFactory(),
      services: { eventBus: { on: () => () => {}, hasListeners: () => false, listenerCount: () => 0 } } as never,
    });
    await mgr.load(paidManifest(), { bundleUrl: 'about:blank' });
    mgr.unload('pro.scope');
    mgr.resume('pro.scope');
    expect(mgr.get('pro.scope')?.status).toBe('unloaded');
  });
});

// ── Loader: arm + fire + cancel ─────────────────────────────────────────

describe('PluginLoader · pause-on-expiry timer', () => {
  function buildLoader(opts: {
    licenses: ReadonlyArray<{ pluginId: string; signed: SignedLicense }>;
    fetchImpl?: typeof fetch;
  }): PluginLoader {
    const fetchImpl = opts.fetchImpl ?? (vi.fn() as unknown as typeof fetch);
    const resolver = inMemoryLicenseResolver({
      licenses: opts.licenses,
      userId: 'buyer-uuid',
      publicKeys: [primary.active],
    });
    return new PluginLoader({
      cache,
      fetchOptions: { fetchImpl, preferDevServer: false, baseDelayMs: 1 },
      manager: mgr as unknown as PluginManager,
      licenseResolver: resolver,
      now: () => Date.now(),
    });
  }

  it('arms a timer for a paid license with future expiresAt', async () => {
    const expiresAt = new Date(NOW + 60_000).toISOString(); // +1 min
    const signed = await sign(payloadFor({ expiresAt }), primary.privateKey, 'k1');

    const body = bytes('pro');
    const hash = await computeBundleHash(body);
    const fetchImpl = vi.fn().mockResolvedValue(ok(body)) as unknown as typeof fetch;
    const loader = buildLoader({
      licenses: [{ pluginId: 'pro.scope', signed }],
      fetchImpl,
    });
    const installed: InstalledPlugin = { manifest: paidManifest(), bundleHash: hash };

    const outcome = await loader.loadOne(installed);
    expect(outcome.status).toBe('active');
    expect(mgr.paused.length).toBe(0);

    // Advance just past expiry.
    await vi.advanceTimersByTimeAsync(60_001);
    expect(mgr.paused).toEqual([{ id: 'pro.scope', reason: 'license-expired' }]);

    loader.dispose();
  });

  it('cancels the timer when the manager unloads the plugin', async () => {
    const expiresAt = new Date(NOW + 60_000).toISOString();
    const signed = await sign(payloadFor({ expiresAt }), primary.privateKey, 'k1');

    const body = bytes('pro');
    const hash = await computeBundleHash(body);
    const fetchImpl = vi.fn().mockResolvedValue(ok(body)) as unknown as typeof fetch;
    const loader = buildLoader({
      licenses: [{ pluginId: 'pro.scope', signed }],
      fetchImpl,
    });
    await loader.loadOne({ manifest: paidManifest(), bundleHash: hash });

    // Tear it down before the timer fires.
    mgr.unload('pro.scope');
    await vi.advanceTimersByTimeAsync(60_001);
    expect(mgr.paused.length).toBe(0);

    loader.dispose();
  });

  it('pauses synchronously when license is already expired (clock skew)', async () => {
    // expiresAt is 5 s in the past at NOW.
    const expiresAt = new Date(NOW - 5_000).toISOString();
    // Construct a signed license whose payload says "expired 5 s ago".
    // The verifier would normally reject, but the loader uses graceMs
    // default (24h) so it still passes the gate. The expiry timer then
    // fires synchronously.
    const signed = await sign(payloadFor({ expiresAt }), primary.privateKey, 'k1');

    const body = bytes('pro');
    const hash = await computeBundleHash(body);
    const fetchImpl = vi.fn().mockResolvedValue(ok(body)) as unknown as typeof fetch;
    const loader = buildLoader({
      licenses: [{ pluginId: 'pro.scope', signed }],
      fetchImpl,
    });
    const outcome = await loader.loadOne({ manifest: paidManifest(), bundleHash: hash });
    expect(outcome.status).toBe('active');
    // Synchronously paused — no timer advance needed.
    expect(mgr.paused).toEqual([{ id: 'pro.scope', reason: 'license-expired' }]);

    loader.dispose();
  });

  it('re-arms the timer in 24h chunks for licenses far in the future', async () => {
    // Expiry ~3 days from now: should chunk twice (24h, 24h) then fire.
    const expiresAt = new Date(NOW + 3 * 24 * 60 * 60 * 1000 + 1000).toISOString();
    const signed = await sign(payloadFor({ expiresAt }), primary.privateKey, 'k1');

    const body = bytes('pro');
    const hash = await computeBundleHash(body);
    const fetchImpl = vi.fn().mockResolvedValue(ok(body)) as unknown as typeof fetch;
    const loader = buildLoader({
      licenses: [{ pluginId: 'pro.scope', signed }],
      fetchImpl,
    });
    await loader.loadOne({ manifest: paidManifest(), bundleHash: hash });

    // After 1 day: timer fired but re-armed; no pause yet.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(mgr.paused.length).toBe(0);
    // After 2 days total: still re-arming.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(mgr.paused.length).toBe(0);
    // After 3 days + 2s: real expiry reached.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 2000);
    expect(mgr.paused).toEqual([{ id: 'pro.scope', reason: 'license-expired' }]);

    loader.dispose();
  });

  it('does NOT arm a timer for free plugins', async () => {
    const body = bytes('free');
    const hash = await computeBundleHash(body);
    const fetchImpl = vi.fn().mockResolvedValue(ok(body)) as unknown as typeof fetch;
    const loader = buildLoader({ licenses: [], fetchImpl });
    await loader.loadOne({ manifest: freeManifest(), bundleHash: hash });
    await vi.advanceTimersByTimeAsync(10 * 24 * 60 * 60 * 1000); // 10 days
    expect(mgr.paused.length).toBe(0);
    loader.dispose();
  });

  it('does NOT arm a timer for paid licenses without expiresAt (perpetual)', async () => {
    // one-time / perpetual — no expiresAt field in payload.
    const signed = await sign(payloadFor({ kind: 'one-time', expiresAt: undefined }), primary.privateKey, 'k1');
    const body = bytes('pro');
    const hash = await computeBundleHash(body);
    const fetchImpl = vi.fn().mockResolvedValue(ok(body)) as unknown as typeof fetch;
    const loader = buildLoader({
      licenses: [{ pluginId: 'pro.scope', signed }],
      fetchImpl,
    });
    await loader.loadOne({ manifest: paidManifest(), bundleHash: hash });
    await vi.advanceTimersByTimeAsync(10 * 24 * 60 * 60 * 1000);
    expect(mgr.paused.length).toBe(0);
    loader.dispose();
  });

  it('dispose() cancels every pending timer', async () => {
    const expiresAt = new Date(NOW + 60_000).toISOString();
    const signed = await sign(payloadFor({ expiresAt }), primary.privateKey, 'k1');
    const body = bytes('pro');
    const hash = await computeBundleHash(body);
    const fetchImpl = vi.fn().mockResolvedValue(ok(body)) as unknown as typeof fetch;
    const loader = buildLoader({
      licenses: [{ pluginId: 'pro.scope', signed }],
      fetchImpl,
    });
    await loader.loadOne({ manifest: paidManifest(), bundleHash: hash });

    loader.dispose();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(mgr.paused.length).toBe(0);
  });
});
