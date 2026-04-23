// @vitest-environment jsdom
/**
 * License gate inside `PluginLoader.loadOne` (CORE-007b).
 *
 * Each test verifies the gate's branching:
 *
 *   - free plugins bypass the gate (no resolver consulted)
 *   - paid + no resolver → license-failed / no-license
 *   - paid + resolver returns no token → license-failed / no-license
 *   - paid + anonymous user → license-failed / not-authenticated
 *   - paid + valid signed token → activates normally, manager called
 *   - each verifier reject path (wrong-plugin, wrong-user, wrong-version,
 *     expired, revoked) surfaces as license-failed with the reason
 *
 * The gate is checked BEFORE the cache + fetch path. We assert both the
 * outcome status and that the manager + fetch were never invoked on a
 * reject — that's the whole point of running the gate first.
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
  type LicenseResolver,
} from '../plugins/loader';
import { base64UrlEncode } from '../plugins/license/base64url';
import { canonicalJsonStringify, utf8Encode } from '../plugins/license/canonicalize';
import {
  type ActivePublicKey,
  type LicenseToken,
  type SignedLicense,
} from '../plugins/license/types';
import type {
  LoadOptions,
  PluginEntry,
  PluginManager,
} from '../plugins/runtime/PluginManager';

// ── crypto helpers (same shape as license-verify.test.ts) ───────────────

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

function payload(overrides: Partial<LicenseToken> = {}): LicenseToken {
  return {
    v: 1,
    pluginId: 'pro.scope',
    pluginVersion: '^1.0.0',
    userId: 'buyer-uuid',
    kind: 'one-time',
    issuedAt: '2026-04-01T00:00:00Z',
    transferable: true,
    ...overrides,
  } as LicenseToken;
}

// ── manifest helpers ────────────────────────────────────────────────────

function manifest(
  id: string,
  opts: { paid?: boolean; version?: string } = {},
): PluginManifest {
  const pricing = opts.paid === true
    ? ({ model: 'one-time', currency: 'USD', amount: 999 } as never)
    : ({ model: 'free' } as never);
  return {
    schemaVersion: 1,
    id,
    name: id,
    version: opts.version ?? '1.0.0',
    publisher: { name: 'Tester' },
    description: 'gate test',
    icon: 'https://example.com/icon.svg',
    license: 'Proprietary',
    category: 'utility',
    tags: [],
    type: ['ui-extension'],
    entry: { module: 'index.js' },
    permissions: [],
    pricing,
    refundPolicy: 'none',
  } as PluginManifest;
}

// ── stub manager ────────────────────────────────────────────────────────

class StubManager {
  readonly calls: Array<{ manifest: PluginManifest; opts: LoadOptions }> = [];
  async load(m: PluginManifest, opts: LoadOptions): Promise<PluginEntry> {
    this.calls.push({ manifest: m, opts });
    return { id: m.id, manifest: m, status: 'active' };
  }
  unload(_id: string): void { /* noop */ }
  list(): readonly PluginEntry[] { return []; }
  get(): PluginEntry | undefined { return undefined; }
  subscribe(): () => void { return () => {}; }
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function ok(b: Uint8Array): Response {
  return new Response(b, { status: 200, statusText: 'OK' });
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
});

afterEach(() => {
  vi.useRealTimers();
});

// ── loader factory ──────────────────────────────────────────────────────

function buildLoader(opts: {
  resolver?: LicenseResolver;
  fetchImpl?: typeof fetch;
}): PluginLoader {
  const fetchImpl = opts.fetchImpl ?? (vi.fn() as unknown as typeof fetch);
  return new PluginLoader({
    cache,
    fetchOptions: {
      fetchImpl,
      preferDevServer: false,
      baseDelayMs: 1,
    },
    manager: mgr as unknown as PluginManager,
    ...(opts.resolver !== undefined ? { licenseResolver: opts.resolver } : {}),
    now: () => NOW,
  });
}

// ── tests ───────────────────────────────────────────────────────────────

describe('PluginLoader · license gate · bypass paths', () => {
  it('free plugin bypasses the gate even without a resolver', async () => {
    const body = bytes('free plugin');
    const hash = await computeBundleHash(body);
    const fetchImpl = vi.fn().mockResolvedValue(ok(body)) as unknown as typeof fetch;
    const loader = buildLoader({ fetchImpl });
    const installed: InstalledPlugin[] = [
      { manifest: manifest('free.tool'), bundleHash: hash },
    ];
    const [outcome] = await loader.loadInstalled(installed);
    expect(outcome?.status).toBe('active');
    expect(mgr.calls.length).toBe(1);
  });

  it('manifest with no `pricing` field is treated as free', async () => {
    const m = manifest('legacy');
    delete (m as unknown as { pricing?: unknown }).pricing;
    const body = bytes('legacy');
    const hash = await computeBundleHash(body);
    const fetchImpl = vi.fn().mockResolvedValue(ok(body)) as unknown as typeof fetch;
    const loader = buildLoader({ fetchImpl });
    const [outcome] = await loader.loadInstalled([{ manifest: m, bundleHash: hash }]);
    expect(outcome?.status).toBe('active');
  });
});

describe('PluginLoader · license gate · fail-closed paths', () => {
  it('paid plugin without a resolver fails with no-license', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const loader = buildLoader({ fetchImpl });
    const [outcome] = await loader.loadInstalled([
      { manifest: manifest('pro.scope', { paid: true }), bundleHash: 'irrelevant' },
    ]);
    expect(outcome?.status).toBe('license-failed');
    expect(outcome?.licenseReason).toBe('no-license');
    expect(mgr.calls.length).toBe(0);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('paid plugin with no license token in resolver → no-license', async () => {
    const resolver = inMemoryLicenseResolver({
      userId: 'buyer-uuid',
      publicKeys: [primary.active],
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const loader = buildLoader({ resolver, fetchImpl });
    const [outcome] = await loader.loadInstalled([
      { manifest: manifest('pro.scope', { paid: true }), bundleHash: 'x' },
    ]);
    expect(outcome?.status).toBe('license-failed');
    expect(outcome?.licenseReason).toBe('no-license');
  });

  it('paid plugin with anonymous user → not-authenticated', async () => {
    const signed = await sign(payload(), primary.privateKey, 'k1');
    const resolver = inMemoryLicenseResolver({
      licenses: [{ pluginId: 'pro.scope', signed }],
      userId: null,
      publicKeys: [primary.active],
    });
    const loader = buildLoader({ resolver });
    const [outcome] = await loader.loadInstalled([
      { manifest: manifest('pro.scope', { paid: true }), bundleHash: 'x' },
    ]);
    expect(outcome?.status).toBe('license-failed');
    expect(outcome?.licenseReason).toBe('not-authenticated');
    expect(mgr.calls.length).toBe(0);
  });
});

describe('PluginLoader · license gate · happy path', () => {
  it('paid plugin with valid signed license activates', async () => {
    const signed = await sign(payload(), primary.privateKey, 'k1');
    const resolver = inMemoryLicenseResolver({
      licenses: [{ pluginId: 'pro.scope', signed }],
      userId: 'buyer-uuid',
      publicKeys: [primary.active],
    });
    const body = bytes('pro plugin');
    const hash = await computeBundleHash(body);
    const fetchImpl = vi.fn().mockResolvedValue(ok(body)) as unknown as typeof fetch;
    const loader = buildLoader({ resolver, fetchImpl });
    const [outcome] = await loader.loadInstalled([
      { manifest: manifest('pro.scope', { paid: true }), bundleHash: hash },
    ]);
    expect(outcome?.status).toBe('active');
    expect(mgr.calls.length).toBe(1);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});

describe('PluginLoader · license gate · verifier reasons forward through', () => {
  async function probeReject(opts: {
    payloadOverrides?: Partial<LicenseToken>;
    manifestOverrides?: { paid?: boolean; version?: string };
    denylistJti?: string;
    expectedUserId?: string;
  }): Promise<{ status: string; reason: string | undefined }> {
    const signed = await sign(payload(opts.payloadOverrides), primary.privateKey, 'k1');
    const resolver = inMemoryLicenseResolver({
      licenses: [{ pluginId: 'pro.scope', signed }],
      userId: opts.expectedUserId ?? 'buyer-uuid',
      publicKeys: [primary.active],
      ...(opts.denylistJti !== undefined
        ? { denylist: new Set([opts.denylistJti]) }
        : {}),
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const loader = buildLoader({ resolver, fetchImpl });
    const [outcome] = await loader.loadInstalled([
      {
        manifest: manifest('pro.scope', { paid: true, ...opts.manifestOverrides }),
        bundleHash: 'x',
      },
    ]);
    return { status: outcome?.status ?? 'missing', reason: outcome?.licenseReason };
  }

  it('wrong-plugin', async () => {
    const r = await probeReject({ payloadOverrides: { pluginId: 'someone-else' } });
    expect(r.status).toBe('license-failed');
    expect(r.reason).toBe('wrong-plugin');
  });

  it('wrong-user', async () => {
    const r = await probeReject({ expectedUserId: 'different-user' });
    expect(r.status).toBe('license-failed');
    expect(r.reason).toBe('wrong-user');
  });

  it('wrong-version', async () => {
    const r = await probeReject({
      payloadOverrides: { pluginVersion: '^2.0.0' },
      manifestOverrides: { paid: true, version: '1.0.0' },
    });
    expect(r.status).toBe('license-failed');
    expect(r.reason).toBe('wrong-version');
  });

  it('expired (subscription past grace)', async () => {
    const expiresAt = new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString();
    const r = await probeReject({
      payloadOverrides: { kind: 'subscription', expiresAt },
    });
    expect(r.status).toBe('license-failed');
    expect(r.reason).toBe('expired');
  });

  it('revoked (jti in denylist)', async () => {
    const signed = await sign(payload(), primary.privateKey, 'k1');
    const resolver = inMemoryLicenseResolver({
      licenses: [{ pluginId: 'pro.scope', signed }],
      userId: 'buyer-uuid',
      publicKeys: [primary.active],
      denylist: new Set([signed.sig]),
    });
    const loader = buildLoader({ resolver });
    const [outcome] = await loader.loadInstalled([
      { manifest: manifest('pro.scope', { paid: true }), bundleHash: 'x' },
    ]);
    expect(outcome?.status).toBe('license-failed');
    expect(outcome?.licenseReason).toBe('revoked');
  });

  it('unknown-kid (no matching public key)', async () => {
    const other = await makeTestKey('k2');
    const signed = await sign(payload(), other.privateKey, 'k2');
    const resolver = inMemoryLicenseResolver({
      licenses: [{ pluginId: 'pro.scope', signed }],
      userId: 'buyer-uuid',
      publicKeys: [primary.active],
    });
    const loader = buildLoader({ resolver });
    const [outcome] = await loader.loadInstalled([
      { manifest: manifest('pro.scope', { paid: true }), bundleHash: 'x' },
    ]);
    expect(outcome?.status).toBe('license-failed');
    expect(outcome?.licenseReason).toBe('unknown-kid');
  });
});
