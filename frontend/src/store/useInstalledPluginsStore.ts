/**
 * Reactive view-model for the "Installed Plugins" panel (CORE-008).
 *
 * The store is a *join layer*: it never owns plugin state itself, only
 * stitches together two upstream sources of truth:
 *
 *   - `PluginManager` — what is currently *running* (workers, manifests,
 *     status, errors). Lives in `frontend/src/plugins/runtime/`.
 *   - `useMarketplaceStore` — what the Pro backend says is *installed*
 *     for the user (id, version, enabled flag, bundleHash).
 *
 * For each id either side knows about, a single `PluginPanelRow` is
 * exposed to React. The row carries the minimum the UI needs to render
 * without going back to either upstream — the modal can be a pure render
 * of `getRows()`.
 *
 * Actions (`toggleEnabled`, `uninstall`, `refresh`) optimistically flip
 * local state, perform the side-effect against the runtime, and reconcile
 * via the manager subscription. We do not yet have backend endpoints to
 * persist enable/uninstall to Pro — those land alongside the matching
 * `useMarketplaceStore` mutations in PRO-003 / CORE-008b.
 *
 * NOTE on subscribing: the store reads the manager via
 * `getPluginManager().subscribe(refresh)` once on first use. The handle
 * lives forever on purpose — the editor session is the only consumer
 * and it lasts for the page lifetime. Tests use `__resetForTests()`.
 */

import { create } from 'zustand';

import { useMarketplaceStore } from './useMarketplaceStore';
import {
  getPluginManager,
  type PluginEntry,
  type PluginPauseReason,
  type PluginStatus,
} from '../plugins/runtime/PluginManager';
import type {
  InstalledPlugin,
  LoadLicenseReason,
  LoadOutcome,
  PluginLoader,
  UpdateCheckOutcome,
} from '../plugins/loader';
import type { InstalledRecord, LicenseRecord } from '../marketplace/types';
import type { PluginManifest } from '@velxio/sdk';

// ── Public types ─────────────────────────────────────────────────────────

/**
 * UI state for a single plugin row.
 *
 * `status` is the join — it carries the most informative state the UI
 * has at the moment, even when the manager has not yet been told to
 * load this plugin.
 */
export type PluginPanelStatus =
  | PluginStatus
  | 'installed-not-loaded'
  | 'no-license';

export interface PluginPanelRow {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly publisher?: string;
  readonly category?: string;
  readonly status: PluginPanelStatus;
  /** Whether the user has marked this plugin enabled. */
  readonly enabled: boolean;
  /** Present when the row corresponds to a *running* plugin entry. */
  readonly entry?: PluginEntry;
  /** Present when the user has a license token for this plugin. */
  readonly license?: LicenseRecord;
  /** Present when status is `failed` — plugin runtime error info. */
  readonly error?: { name: string; message: string };
  /** Mirror from the marketplace install record, when present. */
  readonly install?: InstalledRecord;
  /**
   * Typed cause for the most recent license-failed load attempt.
   * Stable across re-renders until a successful load clears it.
   */
  readonly licenseReason?: LoadLicenseReason;
  /**
   * Latest version known to the marketplace (if greater than `version`).
   * Drives the `<PluginUpdateBadge />` in the panel.
   */
  readonly latestVersion?: string;
  /**
   * Why the plugin was paused, when `status === 'paused'`. Mirrors
   * `PluginEntry.pauseReason` from the manager.
   */
  readonly pauseReason?: PluginPauseReason;
}

/**
 * Adapter the store uses to ask "is there a newer version of <id>?".
 * Production wires this against `useMarketplaceStore.getCatalog()` once
 * the catalog endpoint lands (PRO-003); dev/tests can pass a fixed map.
 *
 * The optional `getLatestManifest()` is the auto-update entry point — the
 * loader needs the *full* manifest (with permissions) to classify the
 * diff. Until PRO-003 wires the catalog endpoint, returning `null` is the
 * silent no-op path: the badge still works on user click via the
 * synthesized manifest, but the auto-reload tick stays inert.
 */
export interface LatestVersionResolver {
  getLatestVersion(pluginId: string): string | null;
  getLatestManifest?(
    pluginId: string,
  ): Promise<PluginManifest | null> | PluginManifest | null;
}

export interface InstalledPluginsConfig {
  readonly loader?: PluginLoader;
  readonly latestVersionResolver?: LatestVersionResolver;
}

export interface InstalledPluginsStoreState {
  /** Set of plugin ids whose toggle/uninstall is in flight. */
  readonly busyIds: ReadonlySet<string>;
  /** Last action error, surfaced as a banner in the modal. */
  readonly lastError: string | null;
  /** Set of ids the user disabled in this session (overrides install.enabled). */
  readonly localDisabled: ReadonlySet<string>;
  /** Set of ids the user uninstalled in this session (hidden from the list). */
  readonly localUninstalled: ReadonlySet<string>;
  /** Map of id → typed reason for the latest license-failed load attempt. */
  readonly licenseReasons: ReadonlyMap<string, LoadLicenseReason>;
  /**
   * Map of id → latest version per the marketplace catalog. Populated
   * lazily by `getRows()` via the configured `LatestVersionResolver`.
   * Empty when no resolver is configured.
   */
  readonly latestVersions: ReadonlyMap<string, string>;
  /**
   * Per-plugin skip cursor (SDK-008c). When the user clicks "Skip this
   * version" in the update-diff dialog we remember the version that was
   * just declined so the badge stays hidden until a *newer* one ships.
   * Persisted to `localStorage` so a reload doesn't re-prompt.
   */
  readonly skippedVersions: ReadonlyMap<string, string>;
  /** Increment whenever something downstream changed — drives re-render. */
  readonly tick: number;

  /**
   * Compute the joined rows. Reads upstream stores directly so callers
   * do not need to subscribe to both.
   */
  getRows(): readonly PluginPanelRow[];

  toggleEnabled(id: string): Promise<void>;
  uninstall(id: string): Promise<void>;
  refresh(): Promise<void>;

  /**
   * Mark `version` as the most-recent declined update for `id`. The badge
   * stays hidden while `latestVersion === skippedVersion`; a strictly
   * newer release re-prompts.
   *
   * Persisted to localStorage under `velxio.skippedVersions` (single JSON
   * blob) — no per-key churn, no schema migrations needed.
   */
  markVersionSkipped(id: string, version: string): void;
  /**
   * Whether the badge should stay hidden for this `(id, version)` pair.
   * `true` iff the user has previously declined exactly this version
   * (string equality — semver-aware comparison would silently re-prompt
   * for `1.2.3` vs `1.2.3+build.5`, which is the right thing to do).
   */
  isVersionSkipped(id: string, version: string): boolean;
  /**
   * Pull the marketplace denylist (and other refreshable data) again
   * without touching local optimistic state. Called from the modal on
   * a 24h timer so a token revoked centrally takes effect even on a
   * long-running session.
   */
  refreshDenylist(): Promise<void>;

  /**
   * Walk every installed plugin and ask the loader to detect drift +
   * auto-apply the auto-approve paths (SDK-008d). Returns one outcome
   * per plugin even on failure (`decision: 'error' | 'busy' | 'no-manifest'`).
   *
   * Resolves to an empty array when there is no loader, no resolver, or
   * the resolver does not support `getLatestManifest()`. Never throws —
   * the modal calls it on a slow timer that should not surface
   * transport errors as banners.
   */
  checkForUpdates(): Promise<readonly UpdateCheckOutcome[]>;

  /** Test-only. Clears local state + marketplace test seam. */
  __resetForTests(): void;
}

// ── Internals ────────────────────────────────────────────────────────────

const SKIPPED_VERSIONS_STORAGE_KEY = 'velxio.skippedVersions';

/**
 * Hydrate the skip cursor from localStorage. Returns an empty Map on any
 * failure (Safari private mode, malformed JSON, non-string values) — a
 * corrupt blob must never break the modal.
 */
function loadSkippedVersionsFromStorage(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    if (typeof localStorage === 'undefined') return out;
    const raw = localStorage.getItem(SKIPPED_VERSIONS_STORAGE_KEY);
    if (raw === null) return out;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
    for (const [id, version] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof id !== 'string' || typeof version !== 'string') continue;
      out.set(id, version);
    }
  } catch {
    // localStorage access threw or JSON parse failed — fall back to empty.
  }
  return out;
}

function persistSkippedVersions(map: ReadonlyMap<string, string>): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const obj: Record<string, string> = {};
    for (const [id, version] of map) obj[id] = version;
    localStorage.setItem(SKIPPED_VERSIONS_STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // Quota exceeded / private mode: silently drop. The skip is in-memory
    // for the rest of this session, so the badge stays hidden until reload.
  }
}

let managerUnsubscribe: (() => void) | null = null;

/**
 * Module-local config wired by `configureInstalledPlugins()` at editor
 * startup (after the loader has been constructed with the production
 * `defaultLicenseResolver()`). Tests inject these directly via
 * `configureInstalledPlugins()` and clear them via `__resetForTests()`.
 *
 * The store deliberately does not own a singleton loader — it borrows
 * one. The loader's lifecycle (cache, fetch, manager) is managed at the
 * editor mount point, not here.
 */
let runtimeLoader: PluginLoader | null = null;
let latestVersionResolver: LatestVersionResolver | null = null;

/**
 * Snapshot of the manifest the manager last reported for each id.
 * Lets `toggleEnabled` rebuild an `InstalledPlugin` to feed `loadOne()`
 * after the user re-enables a plugin we just unloaded — the manager has
 * already discarded the entry by then, so we cannot read the manifest
 * back from there.
 *
 * Keyed by id (not id:version) on purpose: the user upgrades, the cached
 * manifest gets replaced, and we never reload an outdated bundle.
 */
const manifestCache = new Map<string, PluginManifest>();

function ensureManagerSubscription(bump: () => void): void {
  if (managerUnsubscribe !== null) return;
  managerUnsubscribe = getPluginManager().subscribe(() => {
    snapshotManifests();
    bump();
  });
  // Snapshot once on first subscribe so anything already loaded by the
  // editor startup is captured immediately.
  snapshotManifests();
}

function snapshotManifests(): void {
  for (const entry of getPluginManager().list()) {
    manifestCache.set(entry.id, entry.manifest);
  }
}

/**
 * Editor startup wiring. Pass the production loader (the one with
 * `defaultLicenseResolver()` injected) and an optional latest-version
 * resolver. Re-enable will reload through the same loader, so cache
 * hits / license gate / integrity check all run again — no shortcut.
 *
 * Idempotent: calling twice replaces the previous wiring (useful for
 * HMR during development).
 */
export function configureInstalledPlugins(config: InstalledPluginsConfig): void {
  runtimeLoader = config.loader ?? null;
  latestVersionResolver = config.latestVersionResolver ?? null;
}

function readMarketplaceInstalls(): ReadonlyArray<InstalledRecord> {
  return useMarketplaceStore.getState().installs ?? [];
}

function readMarketplaceLicenses(): ReadonlyArray<LicenseRecord> {
  return useMarketplaceStore.getState().licenses ?? [];
}

function readManagerEntries(): readonly PluginEntry[] {
  return getPluginManager().list();
}

/**
 * Build the joined row set. Call sites:
 *   - `useInstalledPluginsStore((s) => s.getRows())` from React components
 *   - tests assert against the return value
 */
function buildRows(
  installs: ReadonlyArray<InstalledRecord>,
  entries: readonly PluginEntry[],
  licenses: ReadonlyArray<LicenseRecord>,
  localDisabled: ReadonlySet<string>,
  localUninstalled: ReadonlySet<string>,
  licenseReasons: ReadonlyMap<string, LoadLicenseReason>,
  latestVersions: ReadonlyMap<string, string>,
  skippedVersions: ReadonlyMap<string, string>,
): readonly PluginPanelRow[] {
  const byId = new Map<string, PluginPanelRow>();
  const licenseById = new Map<string, LicenseRecord>();
  for (const lic of licenses) licenseById.set(lic.pluginId, lic);

  for (const inst of installs) {
    if (localUninstalled.has(inst.id)) continue;
    const enabled = !localDisabled.has(inst.id) && inst.enabled;
    const reason = licenseReasons.get(inst.id);
    const latest = latestVersions.get(inst.id);
    const skipped = skippedVersions.get(inst.id);
    const showsLatest =
      latest !== undefined && latest !== inst.version && latest !== skipped;
    byId.set(inst.id, {
      id: inst.id,
      version: inst.version,
      displayName: inst.id,
      status: reason !== undefined
        ? 'no-license'
        : enabled
          ? 'installed-not-loaded'
          : 'unloaded',
      enabled,
      install: inst,
      ...(licenseById.has(inst.id) ? { license: licenseById.get(inst.id)! } : {}),
      ...(reason !== undefined ? { licenseReason: reason } : {}),
      ...(showsLatest ? { latestVersion: latest } : {}),
    });
  }

  // Overlay manager entries — they win the status/displayName/error fields
  // because they reflect what is *actually* running right now.
  for (const entry of entries) {
    if (localUninstalled.has(entry.id)) continue;
    const prev = byId.get(entry.id);
    const enabled = prev?.enabled ?? !localDisabled.has(entry.id);
    const reason = licenseReasons.get(entry.id);
    const latest = latestVersions.get(entry.id);
    const skipped = skippedVersions.get(entry.id);
    const showsLatest =
      latest !== undefined &&
      latest !== entry.manifest.version &&
      latest !== skipped;
    // A pause from the loader's expiry timer (CORE-008c) bypasses the
    // licenseReasons map — the loader doesn't re-run loadOne for pauses.
    // Surface the typed reason so the LicenseStatus component renders
    // the right CTA without us shipping a parallel "pauseReason" map.
    const derivedFromPause = derivePauseLicenseReason(entry.pauseReason);
    const effectiveLicenseReason = reason !== undefined && entry.status !== 'active'
      ? reason
      : derivedFromPause;
    byId.set(entry.id, {
      id: entry.id,
      version: entry.manifest.version,
      displayName: entry.manifest.name ?? entry.id,
      ...(extractPublisher(entry) !== undefined ? { publisher: extractPublisher(entry)! } : {}),
      ...(extractCategory(entry) !== undefined ? { category: extractCategory(entry)! } : {}),
      status: entry.status,
      enabled,
      entry,
      ...(entry.error !== undefined ? { error: entry.error } : {}),
      ...(prev?.install !== undefined ? { install: prev.install } : {}),
      ...(prev?.license !== undefined ? { license: prev.license } : {}),
      ...(licenseById.has(entry.id) && prev?.license === undefined
        ? { license: licenseById.get(entry.id)! }
        : {}),
      // A successful manager load implicitly clears the cached reason —
      // the loader only re-stamps reasons on failed paths.
      ...(effectiveLicenseReason !== undefined ? { licenseReason: effectiveLicenseReason } : {}),
      ...(entry.pauseReason !== undefined ? { pauseReason: entry.pauseReason } : {}),
      ...(showsLatest ? { latestVersion: latest } : {}),
    });
  }

  // Stable sort by displayName for deterministic UI.
  return Array.from(byId.values()).sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );
}

/**
 * Refresh the latest-version map from the resolver. Best-effort, never
 * throws — a failed resolver should not break `getRows()` for everyone.
 */
function pollLatestVersions(ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (latestVersionResolver === null) return out;
  for (const id of ids) {
    try {
      const v = latestVersionResolver.getLatestVersion(id);
      if (v !== null) out.set(id, v);
    } catch {
      // Resolver bug. Skip this id.
    }
  }
  return out;
}

/**
 * Map a PluginManager `pauseReason` to the closest `LoadLicenseReason`
 * so the modal's `LicenseStatus` renders the same CTA whether the plugin
 * was paused at startup (loader → license-failed) or mid-session
 * (CORE-008c expiry timer). `manual` pauses do not surface a license
 * CTA — they're driven by tests / future "snooze" affordances.
 */
function derivePauseLicenseReason(
  reason: PluginPauseReason | undefined,
): LoadLicenseReason | undefined {
  if (reason === undefined) return undefined;
  switch (reason) {
    case 'license-expired': return 'expired';
    case 'license-revoked': return 'revoked';
    case 'manual': return undefined;
  }
}

function extractPublisher(entry: PluginEntry): string | undefined {
  const m = entry.manifest as unknown as { publisher?: { name?: string }; author?: { name?: string } };
  return m.publisher?.name ?? m.author?.name;
}

function extractCategory(entry: PluginEntry): string | undefined {
  const m = entry.manifest as unknown as { category?: string };
  return m.category;
}

// ── Store ────────────────────────────────────────────────────────────────

export const useInstalledPluginsStore = create<InstalledPluginsStoreState>((set, get) => {
  const bump = (): void => set({ tick: get().tick + 1 });
  // Lazy: only subscribe on first access (jsdom-safe in tests).
  const ensureSub = (): void => ensureManagerSubscription(bump);

  return {
    busyIds: new Set<string>(),
    lastError: null,
    localDisabled: new Set<string>(),
    localUninstalled: new Set<string>(),
    licenseReasons: new Map<string, LoadLicenseReason>(),
    latestVersions: new Map<string, string>(),
    skippedVersions: loadSkippedVersionsFromStorage(),
    tick: 0,

    getRows() {
      ensureSub();
      const installs = readMarketplaceInstalls();
      const entries = readManagerEntries();
      // Lazy: refresh latest-version map every time the rows are read.
      // Resolver is expected to be a cheap synchronous lookup against
      // a local marketplace catalog snapshot — no network here.
      const ids = new Set<string>();
      for (const i of installs) ids.add(i.id);
      for (const e of entries) ids.add(e.id);
      const latest = pollLatestVersions(Array.from(ids));
      // Avoid a render-loop: only commit the new map when it differs.
      const prevLatest = get().latestVersions;
      if (!sameStringMap(prevLatest, latest)) {
        set({ latestVersions: latest });
      }
      return buildRows(
        installs,
        entries,
        readMarketplaceLicenses(),
        get().localDisabled,
        get().localUninstalled,
        get().licenseReasons,
        latest,
        get().skippedVersions,
      );
    },

    async toggleEnabled(id: string) {
      ensureSub();
      const rows = get().getRows();
      const row = rows.find((r) => r.id === id);
      if (row === undefined) return;
      const nextEnabled = !row.enabled;

      markBusy(set, get, id, true);
      try {
        const localDisabled = new Set(get().localDisabled);
        if (nextEnabled) localDisabled.delete(id);
        else localDisabled.add(id);
        set({ localDisabled, lastError: null });

        const manager = getPluginManager();
        if (!nextEnabled) {
          // Disable: tear the worker down. The bump will fire and rows
          // re-render with status `installed-not-loaded`.
          manager.unload(id);
          return;
        }

        // Re-enable: route through the loader so the license gate, the
        // SHA-256 integrity check, and the IndexedDB cache all run again
        // — no shortcut. Four things must be true: there is a configured
        // loader, the install record is present, that record carries a
        // bundleHash (the loader requires it), and we have a manifest
        // snapshot to feed the loader.
        if (runtimeLoader === null) return;
        const install = row.install;
        if (install === undefined || install.bundleHash === undefined) return;
        const manifest = manifestCache.get(id) ?? row.entry?.manifest;
        if (manifest === undefined) return;

        const installed: InstalledPlugin = {
          manifest,
          bundleHash: install.bundleHash,
          enabled: true,
        };
        const outcome: LoadOutcome = await runtimeLoader.loadOne(installed);
        const reasons = new Map(get().licenseReasons);
        if (outcome.status === 'license-failed' && outcome.licenseReason !== undefined) {
          reasons.set(id, outcome.licenseReason);
          set({ licenseReasons: reasons });
        } else if (reasons.delete(id)) {
          set({ licenseReasons: reasons });
        }
        if (outcome.status === 'failed' || outcome.status === 'offline') {
          set({ lastError: `Failed to enable ${id}: ${outcome.status}` });
        }
      } catch (err) {
        set({ lastError: errorMessage(err) });
      } finally {
        markBusy(set, get, id, false);
      }
    },

    async uninstall(id: string) {
      ensureSub();
      markBusy(set, get, id, true);
      try {
        const manager = getPluginManager();
        manager.unload(id);
        const localUninstalled = new Set(get().localUninstalled);
        localUninstalled.add(id);
        set({ localUninstalled, lastError: null });
        // Backend DELETE belongs to PRO-003; we mark the row hidden
        // optimistically so the UI is immediately consistent.
      } catch (err) {
        set({ lastError: errorMessage(err) });
      } finally {
        markBusy(set, get, id, false);
      }
    },

    async refresh() {
      try {
        await useMarketplaceStore.getState().refresh();
        set({ tick: get().tick + 1, lastError: null });
      } catch (err) {
        set({ lastError: errorMessage(err) });
      }
    },

    async refreshDenylist() {
      // Pull the latest denylist + license snapshot. No optimistic state
      // is touched. Modal wires this on a 24h interval so a token
      // revoked centrally takes effect even on a long-running session.
      try {
        await useMarketplaceStore.getState().refresh();
        set({ tick: get().tick + 1 });
      } catch {
        // Network failure here is silent — we keep the previous denylist
        // and the user will see no behavior change. Surfacing the error
        // would be noisy because the timer fires on its own schedule.
      }
    },

    async checkForUpdates() {
      ensureSub();
      // No loader, no resolver, or no manifest fetcher → silent no-op.
      // The badge still works on user click via the modal's existing
      // synthesizeLatestManifest() placeholder; auto-update only kicks
      // in once PRO-003 wires the catalog endpoint.
      const loader = runtimeLoader;
      const resolver = latestVersionResolver;
      if (loader === null || resolver === null) return [];
      const fetchManifest = resolver.getLatestManifest;
      if (fetchManifest === undefined) return [];

      // Build the InstalledPlugin shape the loader needs. Only marketplace
      // installs with a known manifest *and* a bundleHash can be reloaded —
      // the loader requires the hash for the integrity check.
      const installs = readMarketplaceInstalls();
      const isSkipped = (id: string, version: string): boolean =>
        get().skippedVersions.get(id) === version;
      const installed: InstalledPlugin[] = [];
      for (const inst of installs) {
        if (get().localUninstalled.has(inst.id)) continue;
        if (inst.bundleHash === undefined) continue;
        const manifest = manifestCache.get(inst.id);
        if (manifest === undefined) continue;
        installed.push({
          manifest,
          bundleHash: inst.bundleHash,
          enabled: true,
        });
      }
      if (installed.length === 0) return [];

      try {
        const outcomes = await loader.checkForUpdates(installed, {
          getLatestManifest: (id) => fetchManifest.call(resolver, id),
          isVersionSkipped: isSkipped,
        });
        // Bump tick so any reload-induced manager mutation drives a
        // re-render (manager.subscribe already bumps on its own, but a
        // run that returns only `no-drift`/`skipped` results without
        // touching the manager would otherwise be invisible).
        set({ tick: get().tick + 1 });
        return outcomes;
      } catch {
        // checkForUpdates is `Promise.allSettled` internally so it should
        // not throw; defense-in-depth in case a future refactor lets one
        // through. Caller must not see the modal break.
        return [];
      }
    },

    markVersionSkipped(id: string, version: string) {
      const next = new Map(get().skippedVersions);
      if (next.get(id) === version) return;
      next.set(id, version);
      persistSkippedVersions(next);
      set({ skippedVersions: next, tick: get().tick + 1 });
    },

    isVersionSkipped(id: string, version: string) {
      return get().skippedVersions.get(id) === version;
    },

    __resetForTests() {
      if (managerUnsubscribe !== null) {
        try { managerUnsubscribe(); } catch { /* ignore */ }
        managerUnsubscribe = null;
      }
      runtimeLoader = null;
      latestVersionResolver = null;
      manifestCache.clear();
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(SKIPPED_VERSIONS_STORAGE_KEY);
        }
      } catch { /* ignore */ }
      set({
        busyIds: new Set<string>(),
        lastError: null,
        localDisabled: new Set<string>(),
        localUninstalled: new Set<string>(),
        licenseReasons: new Map<string, LoadLicenseReason>(),
        latestVersions: new Map<string, string>(),
        skippedVersions: new Map<string, string>(),
        tick: 0,
      });
    },
  };
});

function sameStringMap(
  a: ReadonlyMap<string, string>,
  b: ReadonlyMap<string, string>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function markBusy(
  set: (partial: Partial<InstalledPluginsStoreState>) => void,
  get: () => InstalledPluginsStoreState,
  id: string,
  busy: boolean,
): void {
  const next = new Set(get().busyIds);
  if (busy) next.add(id); else next.delete(id);
  set({ busyIds: next });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
