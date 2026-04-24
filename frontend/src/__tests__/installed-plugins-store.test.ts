// @vitest-environment jsdom
/**
 * useInstalledPluginsStore — joins manager + marketplace into the row
 * model the modal renders. The store's job is the *join* (and the
 * optimistic toggle/uninstall side-effects), not owning plugin state
 * itself, so tests focus on:
 *
 *   - row shape: which fields come from the manager vs marketplace
 *   - precedence when both upstream sources know the same id
 *   - optimistic enable/disable + uninstall hides the row
 *   - sort order (alphabetical by displayName)
 *   - busy flag + lastError propagation
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MARKETPLACE_DISCOVERY_SCHEMA_VERSION,
  type InstalledRecord,
  type LicenseRecord,
  type MarketplaceStatus,
} from '../marketplace/types';
import { useMarketplaceStore } from '../store/useMarketplaceStore';
import { useInstalledPluginsStore } from '../store/useInstalledPluginsStore';
import {
  getPluginManager,
  resetPluginManagerForTests,
  type PluginEntry,
} from '../plugins/runtime/PluginManager';

// ── helpers ──────────────────────────────────────────────────────────────

const AVAILABLE: MarketplaceStatus = {
  kind: 'available',
  discovery: {
    schemaVersion: MARKETPLACE_DISCOVERY_SCHEMA_VERSION,
    apiBaseUrl: 'https://api.velxio.dev',
  },
  probedAt: 1700000000000,
};

function seedMarketplace(
  installs: ReadonlyArray<InstalledRecord>,
  licenses: ReadonlyArray<LicenseRecord> = [],
): void {
  // Bypass network — set the resolved data directly on the store.
  useMarketplaceStore.setState({
    status: AVAILABLE,
    installs,
    licenses,
    denylist: null,
    authRequired: false,
    lastError: null,
  } as never);
}

function fakeEntry(id: string, overrides: Partial<PluginEntry> = {}): PluginEntry {
  const base: PluginEntry = {
    id,
    manifest: {
      id,
      name: `Display ${id}`,
      version: '1.0.0',
    } as never,
    status: 'active',
  };
  return { ...base, ...overrides };
}

/** Inject a fake entry into the singleton manager via its private map. */
function injectManagerEntry(entry: PluginEntry): void {
  const manager = getPluginManager() as unknown as {
    entries: Map<string, PluginEntry>;
    notify: () => void;
  };
  manager.entries.set(entry.id, entry);
  manager.notify();
}

beforeEach(() => {
  resetPluginManagerForTests();
  useInstalledPluginsStore.getState().__resetForTests();
  useMarketplaceStore.setState({
    status: { kind: 'idle' },
    installs: null,
    licenses: null,
    denylist: null,
    authRequired: false,
    lastError: null,
  } as never);
});

afterEach(() => {
  resetPluginManagerForTests();
  useInstalledPluginsStore.getState().__resetForTests();
});

// ── tests ────────────────────────────────────────────────────────────────

describe('useInstalledPluginsStore — getRows', () => {
  it('starts empty when no installs and no manager entries', () => {
    const rows = useInstalledPluginsStore.getState().getRows();
    expect(rows).toEqual([]);
  });

  it('lists marketplace installs as installed-not-loaded', () => {
    seedMarketplace([
      { id: 'a-plugin', version: '1.2.3', enabled: true, installedAt: '2026-01-01T00:00:00Z' },
    ]);
    const rows = useInstalledPluginsStore.getState().getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'a-plugin',
      version: '1.2.3',
      status: 'installed-not-loaded',
      enabled: true,
    });
  });

  it('marks a disabled install as unloaded', () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: false, installedAt: '2026-01-01T00:00:00Z' },
    ]);
    const rows = useInstalledPluginsStore.getState().getRows();
    expect(rows[0]?.status).toBe('unloaded');
    expect(rows[0]?.enabled).toBe(false);
  });

  it('manager entry overlays marketplace install (preferring real status + manifest name)', () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z' },
    ]);
    injectManagerEntry(fakeEntry('p', { status: 'active' }));
    const rows = useInstalledPluginsStore.getState().getRows();
    expect(rows[0]).toMatchObject({
      id: 'p',
      status: 'active',
      displayName: 'Display p',
      enabled: true,
    });
    expect(rows[0]?.entry).toBeDefined();
    expect(rows[0]?.install).toBeDefined();
  });

  it('failed manager entry surfaces error info', () => {
    injectManagerEntry(
      fakeEntry('boom', {
        status: 'failed',
        error: { name: 'PluginActivateError', message: 'boom' },
      }),
    );
    const rows = useInstalledPluginsStore.getState().getRows();
    expect(rows[0]).toMatchObject({
      id: 'boom',
      status: 'failed',
      error: { name: 'PluginActivateError', message: 'boom' },
    });
  });

  it('attaches license records to matching rows', () => {
    seedMarketplace(
      [{ id: 'paid', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z' }],
      [{ pluginId: 'paid', token: 'opaque-token', expiresAt: '2027-01-01T00:00:00Z' }],
    );
    const rows = useInstalledPluginsStore.getState().getRows();
    expect(rows[0]?.license).toEqual({
      pluginId: 'paid',
      token: 'opaque-token',
      expiresAt: '2027-01-01T00:00:00Z',
    });
  });

  it('sorts rows by displayName', () => {
    seedMarketplace([
      { id: 'zeta', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z' },
      { id: 'alpha', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z' },
      { id: 'mike', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z' },
    ]);
    const rows = useInstalledPluginsStore.getState().getRows();
    expect(rows.map((r) => r.id)).toEqual(['alpha', 'mike', 'zeta']);
  });
});

describe('useInstalledPluginsStore — toggleEnabled', () => {
  it('flips enabled flag locally without backend (optimistic)', async () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z' },
    ]);
    await useInstalledPluginsStore.getState().toggleEnabled('p');
    const rows = useInstalledPluginsStore.getState().getRows();
    expect(rows[0]?.enabled).toBe(false);
  });

  it('disabling unloads the plugin from the manager', async () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z' },
    ]);
    injectManagerEntry(fakeEntry('p', { status: 'active' }));
    await useInstalledPluginsStore.getState().toggleEnabled('p');
    const entry = getPluginManager().get('p');
    expect(entry?.status).toBe('unloaded');
  });

  it('toggling the same id twice returns to the original enabled state', async () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z' },
    ]);
    await useInstalledPluginsStore.getState().toggleEnabled('p');
    await useInstalledPluginsStore.getState().toggleEnabled('p');
    expect(useInstalledPluginsStore.getState().getRows()[0]?.enabled).toBe(true);
  });

  it('no-op for unknown id (does not error)', async () => {
    await expect(
      useInstalledPluginsStore.getState().toggleEnabled('nonexistent'),
    ).resolves.toBeUndefined();
  });
});

describe('useInstalledPluginsStore — uninstall', () => {
  it('hides the row after uninstall', async () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z' },
    ]);
    await useInstalledPluginsStore.getState().uninstall('p');
    expect(useInstalledPluginsStore.getState().getRows()).toEqual([]);
  });

  it('unloads the running plugin from the manager', async () => {
    injectManagerEntry(fakeEntry('p', { status: 'active' }));
    await useInstalledPluginsStore.getState().uninstall('p');
    const rows = useInstalledPluginsStore.getState().getRows();
    expect(rows).toEqual([]);
    // Manager keeps the unloaded entry briefly, but the row is hidden
    // by the uninstalled set — the user-visible state is correct.
  });
});

describe('useInstalledPluginsStore — busy flag', () => {
  it('clears busy after toggle resolves', async () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z' },
    ]);
    await useInstalledPluginsStore.getState().toggleEnabled('p');
    expect(useInstalledPluginsStore.getState().busyIds.has('p')).toBe(false);
  });

  it('clears busy after uninstall resolves', async () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z' },
    ]);
    await useInstalledPluginsStore.getState().uninstall('p');
    expect(useInstalledPluginsStore.getState().busyIds.has('p')).toBe(false);
  });
});

// ── CORE-008b: reload-on-enable, license reasons, update badge ──────────

import {
  configureInstalledPlugins,
  type LatestVersionResolver,
} from '../store/useInstalledPluginsStore';
import type {
  InstalledPlugin,
  LoadOutcome,
  PluginLoader,
} from '../plugins/loader';

/**
 * Minimal stub that records the InstalledPlugin handed to it and
 * returns a configurable outcome. Lets us assert that re-enable
 * actually routes through the loader (instead of bypassing the
 * license gate / cache / integrity check).
 */
class FakeLoader {
  public calls: InstalledPlugin[] = [];
  public outcome: LoadOutcome;

  constructor(outcome?: Partial<LoadOutcome>) {
    this.outcome = {
      id: outcome?.id ?? 'p',
      version: outcome?.version ?? '1.0.0',
      status: outcome?.status ?? 'active',
      source: outcome?.source ?? 'cache',
      cacheHit: outcome?.cacheHit ?? true,
      fetchAttempts: outcome?.fetchAttempts ?? 0,
      elapsedMs: outcome?.elapsedMs ?? 1,
      ...(outcome?.licenseReason !== undefined ? { licenseReason: outcome.licenseReason } : {}),
    };
  }

  loadOne(plugin: InstalledPlugin): Promise<LoadOutcome> {
    this.calls.push(plugin);
    return Promise.resolve({ ...this.outcome, id: plugin.manifest.id, version: plugin.manifest.version });
  }
}

function asLoader(fake: FakeLoader): PluginLoader {
  return fake as unknown as PluginLoader;
}

describe('useInstalledPluginsStore — CORE-008b reload-on-enable', () => {
  it('re-enable invokes the configured loader with the cached manifest + bundleHash', async () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: false, installedAt: '2026-01-01T00:00:00Z', bundleHash: 'abc123' },
    ]);
    // The manifest snapshot is captured the first time the manager fires
    // a notify for this id — inject an entry so the snapshot picks it up.
    injectManagerEntry(fakeEntry('p', { status: 'unloaded' }));
    const loader = new FakeLoader({ id: 'p', status: 'active' });
    configureInstalledPlugins({ loader: asLoader(loader) });

    await useInstalledPluginsStore.getState().toggleEnabled('p');

    expect(loader.calls).toHaveLength(1);
    expect(loader.calls[0]?.manifest.id).toBe('p');
    expect(loader.calls[0]?.bundleHash).toBe('abc123');
    expect(loader.calls[0]?.enabled).toBe(true);
  });

  it('re-enable skips the loader when no bundleHash is on the install record', async () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: false, installedAt: '2026-01-01T00:00:00Z' },
    ]);
    injectManagerEntry(fakeEntry('p', { status: 'unloaded' }));
    const loader = new FakeLoader();
    configureInstalledPlugins({ loader: asLoader(loader) });

    await useInstalledPluginsStore.getState().toggleEnabled('p');

    expect(loader.calls).toHaveLength(0);
  });

  it('re-enable surfaces license-failed reason into the row', async () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: false, installedAt: '2026-01-01T00:00:00Z', bundleHash: 'h' },
    ]);
    injectManagerEntry(fakeEntry('p', { status: 'unloaded' }));
    const loader = new FakeLoader({ status: 'license-failed', licenseReason: 'expired' });
    configureInstalledPlugins({ loader: asLoader(loader) });

    await useInstalledPluginsStore.getState().toggleEnabled('p');

    const rows = useInstalledPluginsStore.getState().getRows();
    expect(rows[0]?.licenseReason).toBe('expired');
    // Row status is overlaid by the manager entry which is `unloaded` — the
    // license badge is the dedicated channel for the failure detail.
  });

  it('successful re-enable clears a previously-cached license reason', async () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: false, installedAt: '2026-01-01T00:00:00Z', bundleHash: 'h' },
    ]);
    injectManagerEntry(fakeEntry('p', { status: 'unloaded' }));
    const failing = new FakeLoader({ status: 'license-failed', licenseReason: 'no-license' });
    configureInstalledPlugins({ loader: asLoader(failing) });
    await useInstalledPluginsStore.getState().toggleEnabled('p');
    expect(useInstalledPluginsStore.getState().licenseReasons.get('p')).toBe('no-license');

    // Disable then re-enable with a passing loader.
    await useInstalledPluginsStore.getState().toggleEnabled('p');
    const passing = new FakeLoader({ status: 'active' });
    configureInstalledPlugins({ loader: asLoader(passing) });
    await useInstalledPluginsStore.getState().toggleEnabled('p');

    expect(useInstalledPluginsStore.getState().licenseReasons.get('p')).toBeUndefined();
  });

  it('re-enable without a configured loader is a no-op (does not throw)', async () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: false, installedAt: '2026-01-01T00:00:00Z', bundleHash: 'h' },
    ]);
    await expect(
      useInstalledPluginsStore.getState().toggleEnabled('p'),
    ).resolves.toBeUndefined();
  });

  it('disable still unloads when a loader is configured (does not call loadOne)', async () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z', bundleHash: 'h' },
    ]);
    injectManagerEntry(fakeEntry('p', { status: 'active' }));
    const loader = new FakeLoader();
    configureInstalledPlugins({ loader: asLoader(loader) });

    await useInstalledPluginsStore.getState().toggleEnabled('p');

    expect(loader.calls).toHaveLength(0);
    expect(getPluginManager().get('p')?.status).toBe('unloaded');
  });
});

describe('useInstalledPluginsStore — CORE-008b latest-version badge', () => {
  it('attaches latestVersion when resolver returns a newer one', () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z' },
    ]);
    const resolver: LatestVersionResolver = {
      getLatestVersion: () => '1.2.0',
    };
    configureInstalledPlugins({ latestVersionResolver: resolver });

    const rows = useInstalledPluginsStore.getState().getRows();
    expect(rows[0]?.latestVersion).toBe('1.2.0');
  });

  it('omits latestVersion when resolver returns the same version', () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z' },
    ]);
    configureInstalledPlugins({
      latestVersionResolver: { getLatestVersion: () => '1.0.0' },
    });
    const rows = useInstalledPluginsStore.getState().getRows();
    expect(rows[0]?.latestVersion).toBeUndefined();
  });

  it('omits latestVersion when resolver returns null', () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z' },
    ]);
    configureInstalledPlugins({
      latestVersionResolver: { getLatestVersion: () => null },
    });
    const rows = useInstalledPluginsStore.getState().getRows();
    expect(rows[0]?.latestVersion).toBeUndefined();
  });

  it('a throwing resolver does not break getRows for other rows', () => {
    seedMarketplace([
      { id: 'a', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z' },
      { id: 'b', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z' },
    ]);
    configureInstalledPlugins({
      latestVersionResolver: {
        getLatestVersion: (id) => {
          if (id === 'a') throw new Error('boom');
          return '2.0.0';
        },
      },
    });
    const rows = useInstalledPluginsStore.getState().getRows();
    const a = rows.find((r) => r.id === 'a');
    const b = rows.find((r) => r.id === 'b');
    expect(a?.latestVersion).toBeUndefined();
    expect(b?.latestVersion).toBe('2.0.0');
  });
});

describe('useInstalledPluginsStore — CORE-008b refreshDenylist', () => {
  it('exists and resolves without throwing even when marketplace refresh fails', async () => {
    // Replace refresh with a rejecting impl — refreshDenylist must swallow.
    useMarketplaceStore.setState({
      refresh: async () => { throw new Error('network down'); },
    } as never);
    await expect(
      useInstalledPluginsStore.getState().refreshDenylist(),
    ).resolves.toBeUndefined();
  });

  it('bumps tick on success', async () => {
    let called = 0;
    useMarketplaceStore.setState({
      refresh: async () => { called += 1; },
    } as never);
    const before = useInstalledPluginsStore.getState().tick;
    await useInstalledPluginsStore.getState().refreshDenylist();
    expect(called).toBe(1);
    expect(useInstalledPluginsStore.getState().tick).toBe(before + 1);
  });
});

describe('useInstalledPluginsStore — paused entries (CORE-008c)', () => {
  it('paused entry surfaces status="paused" and pauseReason on the row', () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z' },
    ]);
    injectManagerEntry(
      fakeEntry('p', { status: 'paused', pauseReason: 'license-expired' }),
    );
    const rows = useInstalledPluginsStore.getState().getRows();
    expect(rows[0]?.status).toBe('paused');
    expect(rows[0]?.pauseReason).toBe('license-expired');
  });

  it('derives licenseReason="expired" from a license-expired pause', () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z' },
    ]);
    injectManagerEntry(
      fakeEntry('p', { status: 'paused', pauseReason: 'license-expired' }),
    );
    const rows = useInstalledPluginsStore.getState().getRows();
    expect(rows[0]?.licenseReason).toBe('expired');
  });

  it('derives licenseReason="revoked" from a license-revoked pause', () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z' },
    ]);
    injectManagerEntry(
      fakeEntry('p', { status: 'paused', pauseReason: 'license-revoked' }),
    );
    const rows = useInstalledPluginsStore.getState().getRows();
    expect(rows[0]?.licenseReason).toBe('revoked');
  });

  it('manual pause does NOT surface a license CTA', () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z' },
    ]);
    injectManagerEntry(
      fakeEntry('p', { status: 'paused', pauseReason: 'manual' }),
    );
    const rows = useInstalledPluginsStore.getState().getRows();
    expect(rows[0]?.status).toBe('paused');
    expect(rows[0]?.pauseReason).toBe('manual');
    expect(rows[0]?.licenseReason).toBeUndefined();
  });
});

describe('useInstalledPluginsStore — SDK-008c skipped versions', () => {
  it('starts empty when localStorage has no entry', () => {
    expect(useInstalledPluginsStore.getState().skippedVersions.size).toBe(0);
  });

  it('markVersionSkipped persists the value and surfaces via isVersionSkipped', () => {
    const s = useInstalledPluginsStore.getState();
    s.markVersionSkipped('p', '1.2.3');
    expect(useInstalledPluginsStore.getState().isVersionSkipped('p', '1.2.3')).toBe(true);
    expect(useInstalledPluginsStore.getState().isVersionSkipped('p', '1.2.4')).toBe(false);
    expect(useInstalledPluginsStore.getState().isVersionSkipped('q', '1.2.3')).toBe(false);
    // Persisted to localStorage as JSON.
    const raw = localStorage.getItem('velxio.skippedVersions');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ p: '1.2.3' });
  });

  it('marking the same (id, version) twice is a no-op (no tick churn)', () => {
    useInstalledPluginsStore.getState().markVersionSkipped('p', '1.0.0');
    const tickAfter1 = useInstalledPluginsStore.getState().tick;
    useInstalledPluginsStore.getState().markVersionSkipped('p', '1.0.0');
    expect(useInstalledPluginsStore.getState().tick).toBe(tickAfter1);
  });

  it('marking a NEW version replaces the previous skip cursor', () => {
    useInstalledPluginsStore.getState().markVersionSkipped('p', '1.0.0');
    useInstalledPluginsStore.getState().markVersionSkipped('p', '1.1.0');
    expect(useInstalledPluginsStore.getState().isVersionSkipped('p', '1.0.0')).toBe(false);
    expect(useInstalledPluginsStore.getState().isVersionSkipped('p', '1.1.0')).toBe(true);
  });

  it('hides latestVersion in getRows when it equals the skip cursor', () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z' },
    ]);
    configureInstalledPlugins({
      latestVersionResolver: { getLatestVersion: () => '1.5.0' },
    });
    expect(useInstalledPluginsStore.getState().getRows()[0]?.latestVersion).toBe('1.5.0');

    useInstalledPluginsStore.getState().markVersionSkipped('p', '1.5.0');
    expect(useInstalledPluginsStore.getState().getRows()[0]?.latestVersion).toBeUndefined();
  });

  it('a strictly newer version re-surfaces the badge after a skip', () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z' },
    ]);
    let stub = '1.5.0';
    configureInstalledPlugins({
      latestVersionResolver: { getLatestVersion: () => stub },
    });
    useInstalledPluginsStore.getState().markVersionSkipped('p', '1.5.0');
    expect(useInstalledPluginsStore.getState().getRows()[0]?.latestVersion).toBeUndefined();
    stub = '1.6.0';
    expect(useInstalledPluginsStore.getState().getRows()[0]?.latestVersion).toBe('1.6.0');
  });

  it('survives a corrupt localStorage blob (returns empty map)', () => {
    localStorage.setItem('velxio.skippedVersions', 'not json');
    useInstalledPluginsStore.getState().__resetForTests();
    expect(useInstalledPluginsStore.getState().skippedVersions.size).toBe(0);
  });

  it('__resetForTests clears the localStorage entry', () => {
    useInstalledPluginsStore.getState().markVersionSkipped('p', '1.0.0');
    expect(localStorage.getItem('velxio.skippedVersions')).not.toBeNull();
    useInstalledPluginsStore.getState().__resetForTests();
    expect(localStorage.getItem('velxio.skippedVersions')).toBeNull();
  });
});

// ── SDK-008d: checkForUpdates orchestration ────────────────────────────

import type {
  CheckForUpdatesOptions,
  UpdateCheckOutcome,
} from '../plugins/loader';
import type { PluginManifest } from '@velxio/sdk';

interface CheckForUpdatesCall {
  readonly installed: ReadonlyArray<InstalledPlugin>;
  readonly opts: CheckForUpdatesOptions;
}

class FakeLoaderWithUpdates extends FakeLoader {
  public updateCalls: CheckForUpdatesCall[] = [];
  public updateOutcomes: UpdateCheckOutcome[] = [];

  checkForUpdates(
    installed: ReadonlyArray<InstalledPlugin>,
    opts: CheckForUpdatesOptions,
  ): Promise<UpdateCheckOutcome[]> {
    this.updateCalls.push({ installed, opts });
    return Promise.resolve(this.updateOutcomes.slice());
  }
}

describe('useInstalledPluginsStore — SDK-008d checkForUpdates', () => {
  it('returns [] when no loader is configured', async () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z', bundleHash: 'h' },
    ]);
    const out = await useInstalledPluginsStore.getState().checkForUpdates();
    expect(out).toEqual([]);
  });

  it('returns [] when no resolver is configured', async () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z', bundleHash: 'h' },
    ]);
    const loader = new FakeLoaderWithUpdates();
    configureInstalledPlugins({ loader: asLoader(loader) });
    const out = await useInstalledPluginsStore.getState().checkForUpdates();
    expect(out).toEqual([]);
    expect(loader.updateCalls).toEqual([]);
  });

  it('returns [] when resolver does not implement getLatestManifest', async () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z', bundleHash: 'h' },
    ]);
    const loader = new FakeLoaderWithUpdates();
    const resolver: LatestVersionResolver = {
      getLatestVersion: () => '1.1.0',
      // intentionally no getLatestManifest
    };
    configureInstalledPlugins({ loader: asLoader(loader), latestVersionResolver: resolver });
    const out = await useInstalledPluginsStore.getState().checkForUpdates();
    expect(out).toEqual([]);
    expect(loader.updateCalls).toEqual([]);
  });

  it('builds InstalledPlugin[] from marketplace + manifestCache and forwards skip predicate', async () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z', bundleHash: 'hh' },
    ]);
    injectManagerEntry(fakeEntry('p'));
    useInstalledPluginsStore.getState().markVersionSkipped('p', '2.0.0');

    const loader = new FakeLoaderWithUpdates();
    const fetchedManifests: string[] = [];
    const resolver: LatestVersionResolver = {
      getLatestVersion: () => '1.1.0',
      getLatestManifest: (id) => {
        fetchedManifests.push(id);
        return { id, name: id, version: '1.1.0' } as PluginManifest;
      },
    };
    configureInstalledPlugins({ loader: asLoader(loader), latestVersionResolver: resolver });

    await useInstalledPluginsStore.getState().checkForUpdates();
    expect(loader.updateCalls).toHaveLength(1);
    const call = loader.updateCalls[0]!;
    expect(call.installed).toHaveLength(1);
    expect(call.installed[0]?.manifest.id).toBe('p');
    expect(call.installed[0]?.bundleHash).toBe('hh');
    expect(call.installed[0]?.enabled).toBe(true);

    // Forwarded callbacks: getLatestManifest invoked, isVersionSkipped honored.
    const manifest = await call.opts.getLatestManifest('p');
    expect(manifest?.version).toBe('1.1.0');
    expect(fetchedManifests).toContain('p');
    expect(call.opts.isVersionSkipped?.('p', '2.0.0')).toBe(true);
    expect(call.opts.isVersionSkipped?.('p', '1.9.0')).toBe(false);
  });

  it('skips installs without a bundleHash (cannot be reloaded)', async () => {
    seedMarketplace([
      { id: 'a', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z', bundleHash: 'hh' },
      { id: 'b', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z' },
    ]);
    injectManagerEntry(fakeEntry('a'));
    injectManagerEntry(fakeEntry('b'));
    const loader = new FakeLoaderWithUpdates();
    const resolver: LatestVersionResolver = {
      getLatestVersion: () => null,
      getLatestManifest: () => null,
    };
    configureInstalledPlugins({ loader: asLoader(loader), latestVersionResolver: resolver });

    await useInstalledPluginsStore.getState().checkForUpdates();
    const call = loader.updateCalls[0]!;
    expect(call.installed.map((p) => p.manifest.id)).toEqual(['a']);
  });

  it('skips installs with no cached manifest (manager has not seen them yet)', async () => {
    seedMarketplace([
      { id: 'unseen', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z', bundleHash: 'hh' },
    ]);
    // No injectManagerEntry — manifestCache stays empty for `unseen`.
    const loader = new FakeLoaderWithUpdates();
    const resolver: LatestVersionResolver = {
      getLatestVersion: () => '1.1.0',
      getLatestManifest: () => null,
    };
    configureInstalledPlugins({ loader: asLoader(loader), latestVersionResolver: resolver });

    const out = await useInstalledPluginsStore.getState().checkForUpdates();
    expect(out).toEqual([]);
    expect(loader.updateCalls).toEqual([]);
  });

  it('skips ids the user has uninstalled this session', async () => {
    seedMarketplace([
      { id: 'a', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z', bundleHash: 'h' },
      { id: 'b', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z', bundleHash: 'h' },
    ]);
    injectManagerEntry(fakeEntry('a'));
    injectManagerEntry(fakeEntry('b'));
    await useInstalledPluginsStore.getState().uninstall('a');

    const loader = new FakeLoaderWithUpdates();
    const resolver: LatestVersionResolver = {
      getLatestVersion: () => null,
      getLatestManifest: () => null,
    };
    configureInstalledPlugins({ loader: asLoader(loader), latestVersionResolver: resolver });

    await useInstalledPluginsStore.getState().checkForUpdates();
    const call = loader.updateCalls[0]!;
    expect(call.installed.map((p) => p.manifest.id)).toEqual(['b']);
  });

  it('swallows loader errors and returns []', async () => {
    seedMarketplace([
      { id: 'p', version: '1.0.0', enabled: true, installedAt: '2026-01-01T00:00:00Z', bundleHash: 'h' },
    ]);
    injectManagerEntry(fakeEntry('p'));
    const loader = new FakeLoaderWithUpdates();
    loader.checkForUpdates = () => Promise.reject(new Error('catalog 500'));
    const resolver: LatestVersionResolver = {
      getLatestVersion: () => null,
      getLatestManifest: () => null,
    };
    configureInstalledPlugins({ loader: asLoader(loader), latestVersionResolver: resolver });

    const out = await useInstalledPluginsStore.getState().checkForUpdates();
    expect(out).toEqual([]);
  });
});
