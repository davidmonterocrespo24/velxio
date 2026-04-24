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

import {
  classifyUpdateDiff,
  diffPermissions,
  type PluginManifest,
} from '@velxio/sdk';

import { getEventBus, type HostEventBus } from '../../simulation/EventBus';
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
import {
  InstallFlowBusyError,
  type InstallFlowController,
  type UpdateDecision,
} from '../../plugin-host/InstallFlowController';

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
   * Optional `InstallFlowController` used by `checkForUpdates()` to
   * surface the toast event for `auto-approve-with-toast` paths. When
   * absent, the loader still performs auto-approve reloads but the toast
   * sink is not invoked.
   */
  readonly installFlowController?: InstallFlowController;
  /**
   * Inject a clock for deterministic license expiry tests.
   */
  readonly now?: () => number;
  /**
   * Override the EventBus used for `'plugin:update:applied'` emits. When
   * absent, the loader uses `getEventBus()` (the production singleton).
   * Tests inject a fresh `HostEventBus` to isolate listeners.
   */
  readonly eventBus?: HostEventBus;
}

// ── Update detection types ───────────────────────────────────────────────

/**
 * Outcome of a single drift check inside `checkForUpdates()`. The
 * discriminator is `decision`. Only `'auto-approve' | 'auto-approve-with-toast'`
 * carry a `reload` field — those are the paths where the loader actually
 * tries to swap the worker.
 *
 * `'requires-consent'` deliberately does not auto-reload: the user must
 * see the diff. The badge UI in the Installed Plugins panel already
 * handles the click → `controller.requestUpdate()` flow.
 */
export type UpdateCheckDecision =
  /** No drift — installed version matches latest. */
  | 'no-drift'
  /** Latest is the version the user previously skipped — honored. */
  | 'skipped'
  /** Resolver could not produce a manifest for this id (no fetch wired). */
  | 'no-manifest'
  /** Permissions did not change — silent reload. */
  | 'auto-approve'
  /** Only Low-risk permissions added — toast emitted, then reload. */
  | 'auto-approve-with-toast'
  /** Medium/High permissions added — wait for user click on the badge. */
  | 'requires-consent'
  /** Another consent/update flow is already open; try again next tick. */
  | 'busy'
  /** Free plugin, skipped — no license check; no path here. */
  | 'error';

export interface UpdateCheckOutcome {
  readonly id: string;
  readonly installedVersion: string;
  /** Latest version the resolver reported. Absent when `decision='no-manifest'`. */
  readonly latestVersion?: string;
  readonly decision: UpdateCheckDecision;
  /**
   * Present when the loader actually attempted a reload (auto-approve
   * paths only). Mirrors the shape of `loadOne()`'s outcome.
   */
  readonly reload?: LoadOutcome;
  readonly error?: { name: string; message: string };
}

/**
 * Per-call options for `checkForUpdates()`. The two callbacks live here
 * (not in `PluginLoaderOptions`) so the loader stays decoupled from
 * Zustand stores — the editor wires these against
 * `useInstalledPluginsStore` at call time.
 */
export interface CheckForUpdatesOptions {
  /**
   * Fetch the *real* latest manifest (with its permissions) for `id`.
   * Returning `null` skips this id silently — the loader cannot
   * classify a diff without the new permission set.
   *
   * Production wires this against the marketplace catalog endpoint
   * (PRO-003). Until then a placeholder may return `null` for everything
   * — the auto-update path is a no-op and only the badge surfaces drift.
   */
  readonly getLatestManifest: (
    pluginId: string,
  ) => Promise<PluginManifest | null> | PluginManifest | null;
  /**
   * Whether the user has previously declined exactly this `(id, version)`
   * pair. Optional — when absent, no skips are honored. Wired against
   * `useInstalledPluginsStore.isVersionSkipped` in production.
   */
  readonly isVersionSkipped?: (pluginId: string, version: string) => boolean;
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
  private readonly installFlowController: InstallFlowController | null;
  private readonly eventBus: HostEventBus;
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
    this.installFlowController = opts.installFlowController ?? null;
    this.eventBus = opts.eventBus ?? getEventBus();
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

  /**
   * Detect drift between each `installed` entry and the catalog's latest
   * version, then route every drift through one of four paths:
   *
   *   - `auto-approve`            → silent unload + reload.
   *   - `auto-approve-with-toast` → silent unload + reload, plus emit a
   *                                  toast through the `InstallFlowController`
   *                                  so the user sees what changed.
   *   - `requires-consent`        → no-op here. The Installed Plugins
   *                                  panel surfaces a badge that, on
   *                                  click, opens the consent dialog.
   *                                  Auto-mounting that dialog from a
   *                                  background tick would steal focus
   *                                  and queue dialogs for every plugin
   *                                  with a permission-changing update —
   *                                  user-visible spam.
   *   - `skipped`                 → no-op when `latest === isVersionSkipped(id)`.
   *
   * Concurrent — siblings run via `Promise.allSettled`. A failure on one
   * plugin (`getLatestManifest` throws, classifier diverges, manager
   * load rejects) surfaces as `decision: 'error'` for that id without
   * blocking the rest.
   *
   * Idempotent under repeated calls: if `latest === installed.version`
   * after a successful auto-update, the next tick decides `'no-drift'`
   * and does nothing.
   */
  async checkForUpdates(
    installed: readonly InstalledPlugin[],
    opts: CheckForUpdatesOptions,
  ): Promise<UpdateCheckOutcome[]> {
    const tasks = installed.map((plugin) => this.checkOne(plugin, opts));
    const settled = await Promise.allSettled(tasks);
    const out: UpdateCheckOutcome[] = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i]!;
      if (r.status === 'fulfilled') {
        out.push(r.value);
      } else {
        const e = r.reason instanceof Error ? r.reason : new Error(String(r.reason));
        const inst = installed[i]!;
        out.push({
          id: inst.manifest.id,
          installedVersion: inst.manifest.version,
          decision: 'error',
          error: { name: e.name, message: e.message },
        });
      }
    }
    return out;
  }

  /**
   * Resolve the decision for one installed plugin. Pulled out of
   * `checkForUpdates` to keep `Promise.allSettled` simple and to make the
   * 4-way branch trivially testable.
   */
  private async checkOne(
    plugin: InstalledPlugin,
    opts: CheckForUpdatesOptions,
  ): Promise<UpdateCheckOutcome> {
    const installedManifest = plugin.manifest;
    const id = installedManifest.id;
    const installedVersion = installedManifest.version;
    let latestManifest: PluginManifest | null;
    try {
      latestManifest = await opts.getLatestManifest(id);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      return {
        id,
        installedVersion,
        decision: 'error',
        error: { name: e.name, message: e.message },
      };
    }
    if (latestManifest === null) {
      return { id, installedVersion, decision: 'no-manifest' };
    }
    const latestVersion = latestManifest.version;
    if (latestVersion === installedVersion) {
      return { id, installedVersion, latestVersion, decision: 'no-drift' };
    }
    if (opts.isVersionSkipped?.(id, latestVersion) === true) {
      return { id, installedVersion, latestVersion, decision: 'skipped' };
    }

    // Pre-classify locally so we can avoid mounting the consent dialog
    // for `requires-consent` paths from a background tick.
    const oldPerms = installedManifest.permissions ?? [];
    const newPerms = latestManifest.permissions ?? [];
    const permDiff = diffPermissions(oldPerms, newPerms);
    const decision = classifyUpdateDiff(permDiff);

    if (decision.kind === 'requires-consent') {
      return { id, installedVersion, latestVersion, decision: 'requires-consent' };
    }

    // Auto-approve paths. Hand off to the controller so the toast sink is
    // invoked uniformly (the controller owns `emitToast` wiring).
    let userDecision: UpdateDecision;
    if (this.installFlowController !== null) {
      try {
        userDecision = await this.installFlowController.requestUpdate(
          { manifest: installedManifest },
          { manifest: latestManifest },
        );
      } catch (err) {
        if (err instanceof InstallFlowBusyError) {
          return { id, installedVersion, latestVersion, decision: 'busy' };
        }
        const e = err instanceof Error ? err : new Error(String(err));
        return {
          id,
          installedVersion,
          latestVersion,
          decision: 'error',
          error: { name: e.name, message: e.message },
        };
      }
    } else {
      // No controller wired — proceed without surfacing a toast. Used by
      // headless dev/test setups that just want the auto-reload behavior.
      userDecision = { kind: 'updated' };
    }

    if (userDecision.kind !== 'updated') {
      // Should not happen for auto-approve paths, but guard defensively.
      return { id, installedVersion, latestVersion, decision: 'error',
        error: { name: 'UnexpectedUpdateDecision', message: userDecision.kind } };
    }

    // Reload. Tear the worker down first so the new bundleHash takes effect.
    this.manager.unload(id);
    const next: InstalledPlugin = {
      manifest: latestManifest,
      bundleHash: plugin.bundleHash,
      ...(plugin.bundleUrl !== undefined ? { bundleUrl: plugin.bundleUrl } : {}),
      enabled: true,
    };
    let reload: LoadOutcome;
    try {
      reload = await this.loadOne(next);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      return {
        id,
        installedVersion,
        latestVersion,
        decision: 'error',
        error: { name: e.name, message: e.message },
      };
    }
    // SDK-008f: emit `'plugin:update:applied'` only when the swap actually
    // produced a live worker. A failed reload (license-failed, integrity
    // mismatch, offline) is reported back via `reload.status` and does NOT
    // count as an applied update — telemetry plugins would surface a
    // false positive otherwise. Hot-path-guarded per PERF-001.
    if (
      reload.status === 'active' &&
      this.eventBus.hasListeners('plugin:update:applied')
    ) {
      this.eventBus.emit('plugin:update:applied', {
        pluginId: id,
        fromVersion: installedVersion,
        toVersion: latestVersion,
        decision: decision.kind,
        addedPermissions: permDiff.added,
      });
    }
    return {
      id,
      installedVersion,
      latestVersion,
      decision: decision.kind,
      reload,
    };
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
