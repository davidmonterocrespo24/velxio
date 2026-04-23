/**
 * High-level loader that turns a list of installed plugins into a
 * running set of Workers.
 *
 * Composition (each piece tested separately):
 *
 *   Installed list ─┐
 *                   │      ┌─────────────────┐
 *                   ├──► PluginCache ◄────────┤  IndexedDB
 *                   │      └────────┬────────┘
 *                   │               │ miss
 *                   │               ▼
 *                   │      ┌─────────────────┐
 *                   ├──► BundleFetcher ──────►  CDN / dev server
 *                   │      └────────┬────────┘
 *                   │               │
 *                   │               ▼
 *                   │      ┌─────────────────┐
 *                   ├──► verifyBundleHash    │  SHA-256 vs manifest
 *                   │      └────────┬────────┘
 *                   │               │
 *                   │               ▼
 *                   └──► PluginManager.load(manifest, { bundleUrl })
 *                              │
 *                              ▼
 *                          Worker spins, ready
 *
 * Concurrency: the loader fans out across all installed plugins via
 * `Promise.allSettled` so one slow CDN fetch can't hold the rest. A
 * per-plugin failure surfaces in the result as `failed` with the
 * error; it does not throw at the top level.
 *
 * Offline behaviour: if the CDN is unreachable AND the bundle is not
 * cached, the plugin is marked `offline` and skipped. The next
 * `loadInstalled()` retries.
 */

import type { PluginManifest } from '@velxio/sdk';

import {
  fetchBundle,
  type BundleFetchOptions,
  type BundleFetchResult,
} from './BundleFetcher';
import { PluginCache, type PluginCacheBackend } from './PluginCache';
import {
  BundleIntegrityError,
  computeBundleHash,
  verifyBundleHash,
} from './BundleVerifier';
import type { LicenseResolver } from './LicenseResolver';
import {
  getPluginManager,
  type LoadOptions,
  type PluginEntry,
  type PluginManager,
} from '../runtime/PluginManager';
import { verifyLicense, type LicenseVerifyReason } from '../license';

// ── Public types ─────────────────────────────────────────────────────────

/**
 * One plugin descriptor as returned by the Pro backend (CORE-008 / PRO-001).
 * The loader consumes a thin slice — it does not care about license tokens
 * or store metadata; CORE-009 verifies licenses *before* a plugin reaches
 * this loader.
 */
export interface InstalledPlugin {
  readonly manifest: PluginManifest;
  /**
   * Hex-encoded SHA-256 of the bundle bytes. The loader rejects any
   * bundle whose content hash differs from this value.
   */
  readonly bundleHash: string;
  /**
   * Optional explicit bundle URL override — used by tests and dev mode.
   * In production the URL is derived from the plugin id and version.
   */
  readonly bundleUrl?: string;
  /** `false` to skip without unloading. Defaults to true. */
  readonly enabled?: boolean;
}

export type LoadOutcomeStatus =
  | 'active'
  | 'failed'
  | 'offline'
  | 'disabled'
  | 'license-failed';

/**
 * Augmented `LicenseVerifyReason` — `no-license` covers the case where
 * no signed token exists for a paid plugin (the verifier never runs).
 * `not-authenticated` covers paid plugins requested by an anonymous
 * session — distinguishing it from `wrong-user` lets the UI prompt for
 * sign-in instead of "license belongs to another account".
 */
export type LoadLicenseReason =
  | LicenseVerifyReason
  | 'no-license'
  | 'not-authenticated';

export interface LoadOutcome {
  readonly id: string;
  readonly version: string;
  readonly status: LoadOutcomeStatus;
  readonly source: 'cache' | 'cdn' | 'dev';
  readonly cacheHit: boolean;
  readonly fetchAttempts: number;
  readonly elapsedMs: number;
  readonly entry?: PluginEntry;
  readonly error?: { name: string; message: string };
  /**
   * Present iff `status === 'license-failed'`. The UI maps the reason to
   * a copy + CTA (CORE-008b owns the per-reason copy).
   */
  readonly licenseReason?: LoadLicenseReason;
}

export interface PluginLoaderOptions {
  readonly cache?: PluginCache;
  readonly cacheBackend?: PluginCacheBackend;
  readonly fetchOptions?: BundleFetchOptions;
  /**
   * Override the manager singleton — tests pass a fresh instance via
   * `resetPluginManagerForTests()` + `getPluginManager()`.
   */
  readonly manager?: PluginManager;
  /**
   * Source of license tokens / public keys / authenticated user id for
   * the gate that runs before paid plugins reach `manager.load`. When
   * absent, **paid plugins always fail closed** with `license-failed /
   * no-license`. Free plugins ignore the resolver entirely.
   */
  readonly licenseResolver?: LicenseResolver;
  /**
   * Inject a clock for deterministic license expiry tests.
   */
  readonly now?: () => number;
}

// ── Loader ───────────────────────────────────────────────────────────────

/**
 * Maximum value the loader passes to `setTimeout` in one arm. Browsers
 * clamp values >`2^31 - 1` ms (~24.8 days) to immediate firing — to keep
 * the contract intuitive we re-arm in 24-hour chunks until the real
 * expiry is reached. 24h also lines up with the modal's denylist refresh
 * cadence so a freshly-revoked token gets caught either way.
 */
const MAX_TIMER_DELAY_MS = 24 * 60 * 60 * 1000;

export class PluginLoader {
  private readonly cache: PluginCache;
  private readonly fetchOptions: BundleFetchOptions;
  private readonly manager: PluginManager;
  private readonly licenseResolver: LicenseResolver | null;
  private readonly now: () => number;
  /**
   * Per-plugin pause-on-expiry timer handles. `setTimeout` returns
   * `number` in browser jsdom and `NodeJS.Timeout` in pure Node — store
   * as `unknown` and reuse the same opaque value for `clearTimeout`.
   */
  private readonly expiryTimers = new Map<string, unknown>();
  private managerUnsubscribe: (() => void) | null = null;

  constructor(opts: PluginLoaderOptions = {}) {
    this.cache = opts.cache ?? new PluginCache(
      opts.cacheBackend !== undefined ? { backend: opts.cacheBackend } : {},
    );
    this.fetchOptions = opts.fetchOptions ?? {};
    this.manager = opts.manager ?? getPluginManager();
    this.licenseResolver = opts.licenseResolver ?? null;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Tear down the loader's resources. Cancels every pending expiry
   * timer and unsubscribes from manager events. Safe to call multiple
   * times. The cache and manager are not owned by the loader, so they
   * are not touched here.
   */
  dispose(): void {
    for (const handle of this.expiryTimers.values()) {
      try { clearTimeout(handle as never); } catch { /* ignore */ }
    }
    this.expiryTimers.clear();
    if (this.managerUnsubscribe !== null) {
      try { this.managerUnsubscribe(); } catch { /* ignore */ }
      this.managerUnsubscribe = null;
    }
  }

  /**
   * Load every enabled plugin in `installed`. Concurrent — one slow
   * fetch does not block the others. Per-plugin errors surface via
   * `LoadOutcome.error`.
   */
  async loadInstalled(
    installed: readonly InstalledPlugin[],
    opts: { managerLoadOpts?: Partial<LoadOptions> } = {},
  ): Promise<LoadOutcome[]> {
    const results = await Promise.allSettled(
      installed.map((p) => this.loadOne(p, opts.managerLoadOpts ?? {})),
    );
    const outcomes: LoadOutcome[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === 'fulfilled') {
        outcomes.push(r.value);
      } else {
        const e = r.reason instanceof Error ? r.reason : new Error(String(r.reason));
        const inst = installed[i]!;
        outcomes.push({
          id: inst.manifest.id,
          version: inst.manifest.version,
          status: 'failed',
          source: 'cdn',
          cacheHit: false,
          fetchAttempts: 0,
          elapsedMs: 0,
          error: { name: e.name, message: e.message },
        });
      }
    }
    // GC after a batch — keep all currently-active versions, evict
    // anything else that pushes us over the byte ceiling.
    const keep = new Set<string>(
      outcomes
        .filter((o) => o.status === 'active')
        .map((o) => `${o.id}:${o.version}`),
    );
    await this.cache.gc({ keep });
    return outcomes;
  }

  /**
   * Load a single plugin. Public so the editor can drive single-plugin
   * installs (e.g., from the Marketplace UI) without rebuilding the
   * full installed list.
   */
  async loadOne(
    plugin: InstalledPlugin,
    managerLoadOpts: Partial<LoadOptions> = {},
  ): Promise<LoadOutcome> {
    const { manifest, bundleHash, enabled } = plugin;
    const startedAt = Date.now();

    if (enabled === false) {
      return {
        id: manifest.id,
        version: manifest.version,
        status: 'disabled',
        source: 'cache',
        cacheHit: false,
        fetchAttempts: 0,
        elapsedMs: 0,
      };
    }

    // 0. License gate (CORE-007b). Cheap reject: a paid plugin without
    // a valid license never touches the CDN, the cache, or the worker.
    // Free plugins (`pricing.model === 'free'`) skip the gate entirely.
    const licenseOutcome = await this.checkLicense(manifest);
    if (licenseOutcome !== null) {
      return {
        id: manifest.id,
        version: manifest.version,
        status: 'license-failed',
        source: 'cache',
        cacheHit: false,
        fetchAttempts: 0,
        elapsedMs: Date.now() - startedAt,
        licenseReason: licenseOutcome.reason,
        ...(licenseOutcome.detail !== undefined
          ? { error: { name: 'LicenseVerifyError', message: licenseOutcome.detail } }
          : {}),
      };
    }

    // 1. Cache lookup. A hit is the cheapest path.
    const cached = await this.cache.get(manifest.id, manifest.version);
    let bytes: Uint8Array | undefined;
    let source: LoadOutcome['source'] = 'cache';
    let cacheHit = false;
    let fetchAttempts = 0;

    if (cached !== undefined && cached.hash === bundleHash.toLowerCase()) {
      bytes = new Uint8Array(cached.bundle);
      cacheHit = true;
    }

    // 2. Fetch if miss. A drift between manifest hash and cached hash
    // is treated as a miss — the cached bytes belong to a previous
    // tampered or stale build.
    if (bytes === undefined) {
      let fetched: BundleFetchResult;
      try {
        fetched = await fetchBundle(manifest.id, manifest.version, this.fetchOptions);
      } catch (err) {
        // Network failure with no cache → offline.
        const e = err instanceof Error ? err : new Error(String(err));
        return {
          id: manifest.id,
          version: manifest.version,
          status: 'offline',
          source: 'cdn',
          cacheHit: false,
          fetchAttempts: 0,
          elapsedMs: Date.now() - startedAt,
          error: { name: e.name, message: e.message },
        };
      }
      bytes = fetched.bytes;
      source = fetched.source;
      fetchAttempts = fetched.attempts;

      // 3. Verify before persisting. A mismatched bundle never
      // touches the cache, so a tampered CDN serve doesn't poison
      // future loads.
      try {
        const hash = await verifyBundleHash(bytes, bundleHash, manifest.id);
        await this.cache.put(manifest.id, manifest.version, {
          bundle: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
          hash,
          manifest,
        });
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        const isIntegrity = e instanceof BundleIntegrityError;
        return {
          id: manifest.id,
          version: manifest.version,
          status: 'failed',
          source,
          cacheHit: false,
          fetchAttempts,
          elapsedMs: Date.now() - startedAt,
          error: { name: isIntegrity ? 'BundleIntegrityError' : e.name, message: e.message },
        };
      }
    }

    // 4. Hand off to PluginManager via a blob: URL of the verified
    // bytes. This is the same pattern the worker uses internally —
    // doing it here means the worker re-import is local and fast.
    const blobUrl = bundlesToBlobUrl(bytes);
    const baseLoadOpts: LoadOptions = {
      bundleUrl: plugin.bundleUrl ?? blobUrl,
      integrity: bundleHash,
      ...managerLoadOpts,
    };

    try {
      const entry = await this.manager.load(manifest, baseLoadOpts);
      // After a successful load: arm a pause-on-expiry timer if the
      // license has a future expiry. The verifier already rejected
      // already-expired tokens, so any expiresAt we see here is in the
      // future. Re-arms on hot reload (manager.load disposes the prior
      // entry, but we own the timer).
      this.armExpiryTimer(manifest.id);
      return {
        id: manifest.id,
        version: manifest.version,
        status: 'active',
        source,
        cacheHit,
        fetchAttempts,
        elapsedMs: Date.now() - startedAt,
        entry,
      };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      return {
        id: manifest.id,
        version: manifest.version,
        status: 'failed',
        source,
        cacheHit,
        fetchAttempts,
        elapsedMs: Date.now() - startedAt,
        error: { name: e.name, message: e.message },
      };
    } finally {
      // The manager has now imported the bytes; revoke to free memory.
      // It's safe even if the worker is still warming up — the URL is
      // resolved synchronously inside `new Worker(blobUrl)`.
      try { URL.revokeObjectURL(blobUrl); } catch { /* ignore */ }
    }
  }

  /** Expose the cache for diagnostics / UI. */
  getCache(): PluginCache { return this.cache; }

  /**
   * Arm a pause-on-expiry timer for a freshly-loaded plugin. Only paid
   * plugins with a `subscription` / `trial` license carry an `expiresAt`
   * — perpetual / free plugins skip silently.
   *
   * Re-arms on hot reload: if there's already a timer for this id,
   * cancel it first. The subscriber for `unloaded` cleanup is registered
   * lazily on first arm so non-Pro deployments don't pay for it.
   */
  private armExpiryTimer(id: string): void {
    this.cancelExpiryTimer(id);

    if (this.licenseResolver === null) return;
    const signed = this.licenseResolver.getLicense(id);
    if (signed === null) return;
    const expiresAt = signed.payload.expiresAt;
    if (expiresAt === undefined) return;
    const expiryMs = Date.parse(expiresAt);
    if (Number.isNaN(expiryMs)) return;

    this.scheduleExpiryStep(id, expiryMs);

    if (this.managerUnsubscribe === null) {
      this.managerUnsubscribe = this.manager.subscribe(this.onManagerNotify);
    }
  }

  /**
   * Schedule one chunk of the expiry timer. If `expiryMs - now()` is
   * larger than `MAX_TIMER_DELAY_MS`, we set a 24-hour timer that
   * re-arms itself — browsers clamp `setTimeout > 2^31-1ms` to immediate
   * firing, and 24h chunks dovetail with the modal's denylist refresh
   * cadence.
   */
  private scheduleExpiryStep(id: string, expiryMs: number): void {
    const remaining = expiryMs - this.now();
    if (remaining <= 0) {
      this.expiryTimers.delete(id);
      try { this.manager.pause(id, 'license-expired'); } catch { /* ignore */ }
      return;
    }
    const delay = Math.min(remaining, MAX_TIMER_DELAY_MS);
    const handle = setTimeout(() => {
      this.expiryTimers.delete(id);
      if (this.now() < expiryMs) {
        this.scheduleExpiryStep(id, expiryMs);
      } else {
        try { this.manager.pause(id, 'license-expired'); } catch { /* ignore */ }
      }
    }, delay);
    this.expiryTimers.set(id, handle);
  }

  private cancelExpiryTimer(id: string): void {
    const handle = this.expiryTimers.get(id);
    if (handle === undefined) return;
    try { clearTimeout(handle as never); } catch { /* ignore */ }
    this.expiryTimers.delete(id);
  }

  /**
   * Sweep timers when the manager fires a status change. Any id whose
   * entry is `unloaded` / `failed` / missing should not have a pending
   * pause timer. Subscribed lazily; one bound reference, no per-call
   * allocation.
   */
  private onManagerNotify = (): void => {
    if (this.expiryTimers.size === 0) return;
    for (const id of Array.from(this.expiryTimers.keys())) {
      const entry = this.manager.get(id);
      if (
        entry === undefined ||
        entry.status === 'unloaded' ||
        entry.status === 'failed'
      ) {
        this.cancelExpiryTimer(id);
      }
    }
  };

  /**
   * Pre-load license check. Returns `null` for plugins that should
   * proceed (free, or paid + verified), or `{ reason, detail }` for the
   * fail-closed path.
   *
   * Resolution order:
   *   1. Free plugins → bypass.
   *   2. No resolver injected → reject `no-license` (configuration bug
   *      when a Pro deployment forgot to wire it; we'd rather fail
   *      visibly than silently let unlicensed plugins run).
   *   3. No license token for this plugin id → `no-license`.
   *   4. No authenticated user → `not-authenticated` (cannot match
   *      `expectedUserId`).
   *   5. Run `verifyLicense` and forward its reason on reject.
   */
  private async checkLicense(
    manifest: PluginManifest,
  ): Promise<{ reason: LoadLicenseReason; detail?: string } | null> {
    if (isFreePlugin(manifest)) return null;

    const resolver = this.licenseResolver;
    if (resolver === null) {
      return { reason: 'no-license', detail: 'no licenseResolver configured' };
    }

    const signed = resolver.getLicense(manifest.id);
    if (signed === null) {
      return { reason: 'no-license', detail: `no license for ${manifest.id}` };
    }

    const userId = resolver.getUserId();
    if (userId === null) {
      return { reason: 'not-authenticated', detail: 'sign-in required for paid plugins' };
    }

    const denylist = resolver.getDenylist();
    const result = await verifyLicense(signed, {
      publicKeys: resolver.getPublicKeys(),
      expectedPluginId: manifest.id,
      expectedUserId: userId,
      pluginVersion: manifest.version,
      now: this.now(),
      ...(denylist !== undefined ? { denylist } : {}),
    });

    if (result.ok) return null;
    return { reason: result.reason, ...(result.detail !== undefined ? { detail: result.detail } : {}) };
  }
}

function isFreePlugin(manifest: PluginManifest): boolean {
  // The SDK manifest schema defaults `pricing` to `{ model: 'free' }`
  // — but a runtime-loaded manifest may not have been parsed by the
  // SDK schema (loader operates on the wire shape). Check defensively.
  const pricing = (manifest as unknown as { pricing?: { model?: string } }).pricing;
  if (pricing === undefined) return true;
  return pricing.model === 'free';
}

// ── Helpers ──────────────────────────────────────────────────────────────

function bundlesToBlobUrl(bytes: Uint8Array): string {
  const blob = new Blob([bytes], { type: 'text/javascript' });
  return URL.createObjectURL(blob);
}

/**
 * Convenience: validate a bundle bytes buffer against an expected hash
 * and return the computed hash. Wraps `verifyBundleHash` for the editor
 * UI's "verify cached bundle" diagnostic.
 */
export async function recomputeAndVerify(
  bytes: Uint8Array,
  expectedHash: string,
  pluginId?: string,
): Promise<string> {
  const computed = await computeBundleHash(bytes);
  await verifyBundleHash(bytes, expectedHash, pluginId);
  return computed;
}
