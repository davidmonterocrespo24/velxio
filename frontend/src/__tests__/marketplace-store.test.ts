// @vitest-environment jsdom
/**
 * useMarketplaceStore — orchestrates probe + concurrent install/
 * license/denylist fetch, surfaces a UI-friendly state.
 *
 * The store is reset between tests via `__setClientForTesting(null)`
 * so module state doesn't leak between runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MarketplaceAuthRequiredError,
  MarketplaceClient,
  MarketplaceUnavailableError,
} from '../marketplace/MarketplaceClient';
import {
  MARKETPLACE_DISCOVERY_SCHEMA_VERSION,
  type InstalledRecord,
  type LicenseDenylist,
  type LicenseRecord,
  type MarketplaceStatus,
} from '../marketplace/types';
import { useMarketplaceStore } from '../store/useMarketplaceStore';

const DISCOVERY: MarketplaceStatus = {
  kind: 'available',
  discovery: {
    schemaVersion: MARKETPLACE_DISCOVERY_SCHEMA_VERSION,
    apiBaseUrl: 'https://api.velxio.dev',
  },
  probedAt: 1700000000000,
};

function disabledStatus(): MarketplaceStatus {
  return { kind: 'unavailable', reason: 'disabled', probedAt: 1700000000000 };
}

function notFoundStatus(): MarketplaceStatus {
  return { kind: 'unavailable', reason: 'not-found', probedAt: 1700000000000 };
}

interface StubBehaviour {
  readonly status: MarketplaceStatus;
  readonly installs?: ReadonlyArray<InstalledRecord> | (() => Promise<never>);
  readonly licenses?: ReadonlyArray<LicenseRecord> | (() => Promise<never>);
  readonly denylist?: LicenseDenylist | (() => Promise<never>);
}

function stubClient(behaviour: StubBehaviour): MarketplaceClient {
  return {
    async probe() {
      return behaviour.status;
    },
    async getInstalls() {
      const v = behaviour.installs;
      if (typeof v === 'function') return v();
      return v ?? [];
    },
    async getLicenses() {
      const v = behaviour.licenses;
      if (typeof v === 'function') return v();
      return v ?? [];
    },
    async getDenylist() {
      const v = behaviour.denylist;
      if (typeof v === 'function') return v();
      return (
        v ?? {
          revokedTokens: [],
          bannedPlugins: [],
          generatedAt: '2026-04-22T00:00:00Z',
        }
      );
    },
  } as unknown as MarketplaceClient;
}

beforeEach(() => {
  useMarketplaceStore.getState().__setClientForTesting(null, undefined);
});

afterEach(() => {
  useMarketplaceStore.getState().__setClientForTesting(null, undefined);
  vi.restoreAllMocks();
});

describe('useMarketplaceStore', () => {
  it('starts in idle status with no data', () => {
    const s = useMarketplaceStore.getState();
    expect(s.status.kind).toBe('idle');
    expect(s.installs).toBeNull();
    expect(s.licenses).toBeNull();
    expect(s.denylist).toBeNull();
    expect(s.authRequired).toBe(false);
  });

  it('marks status as disabled when discovery URL is null (self-host)', async () => {
    const client = stubClient({ status: disabledStatus() });
    useMarketplaceStore.getState().__setClientForTesting(client, null);

    const status = await useMarketplaceStore.getState().initialize();
    expect(status).toMatchObject({ kind: 'unavailable', reason: 'disabled' });

    const s = useMarketplaceStore.getState();
    expect(s.installs).toBeNull();
    expect(s.licenses).toBeNull();
    expect(s.denylist).toBeNull();
  });

  it('on probe success loads installs + licenses + denylist concurrently', async () => {
    const installs: InstalledRecord[] = [
      { id: 'logic', version: '1.0.0', enabled: true, installedAt: '2026-04-01' },
    ];
    const licenses: LicenseRecord[] = [{ pluginId: 'logic', token: 'tk' }];
    const denylist: LicenseDenylist = {
      revokedTokens: [],
      bannedPlugins: ['evil'],
      generatedAt: '2026-04-22',
    };
    const client = stubClient({ status: DISCOVERY, installs, licenses, denylist });
    useMarketplaceStore.getState().__setClientForTesting(client, 'https://api.velxio.dev/.well-known/velxio-marketplace.json');

    await useMarketplaceStore.getState().initialize();

    const s = useMarketplaceStore.getState();
    expect(s.status.kind).toBe('available');
    expect(s.installs).toEqual(installs);
    expect(s.licenses).toEqual(licenses);
    expect(s.denylist).toEqual(denylist);
    expect(s.authRequired).toBe(false);
    expect(s.lastError).toBeNull();
  });

  it('on probe 404 marks unavailable and clears any previous data', async () => {
    const client = stubClient({ status: notFoundStatus() });
    useMarketplaceStore.getState().__setClientForTesting(client, 'https://api.velxio.dev/.well-known/velxio-marketplace.json');

    await useMarketplaceStore.getState().initialize();

    const s = useMarketplaceStore.getState();
    expect(s.status).toMatchObject({ kind: 'unavailable', reason: 'not-found' });
    expect(s.installs).toBeNull();
    expect(s.licenses).toBeNull();
  });

  it('sets authRequired and keeps denylist when installs/licenses 401', async () => {
    const denylist: LicenseDenylist = {
      revokedTokens: [],
      bannedPlugins: [],
      generatedAt: '2026-04-22',
    };
    const client = stubClient({
      status: DISCOVERY,
      installs: () => Promise.reject(new MarketplaceAuthRequiredError('installs')),
      licenses: () => Promise.reject(new MarketplaceAuthRequiredError('licenses')),
      denylist,
    });
    useMarketplaceStore.getState().__setClientForTesting(client, 'https://api.velxio.dev/.well-known/velxio-marketplace.json');

    await useMarketplaceStore.getState().initialize();

    const s = useMarketplaceStore.getState();
    expect(s.authRequired).toBe(true);
    expect(s.installs).toBeNull();
    expect(s.licenses).toBeNull();
    expect(s.denylist).toEqual(denylist);
    expect(s.lastError).toBeNull(); // auth-required is not an error in the user-facing sense
  });

  it('records error when an endpoint fails for a non-auth reason', async () => {
    const client = stubClient({
      status: DISCOVERY,
      installs: [],
      licenses: () =>
        Promise.reject(new MarketplaceUnavailableError('http-error', 'license db down')),
    });
    useMarketplaceStore.getState().__setClientForTesting(client, 'https://api.velxio.dev/.well-known/velxio-marketplace.json');

    await useMarketplaceStore.getState().initialize();

    const s = useMarketplaceStore.getState();
    expect(s.status.kind).toBe('available');
    expect(s.installs).toEqual([]);
    expect(s.licenses).toBeNull();
    expect(s.lastError).toContain('http-error');
  });

  it('coalesces concurrent initialize() calls', async () => {
    const probeSpy = vi.fn().mockResolvedValue(DISCOVERY);
    const installsSpy = vi.fn().mockResolvedValue([]);
    const denylistDoc: LicenseDenylist = {
      revokedTokens: [],
      bannedPlugins: [],
      generatedAt: '2026-04-22',
    };
    const client = {
      probe: probeSpy,
      getInstalls: installsSpy,
      getLicenses: vi.fn().mockResolvedValue([]),
      getDenylist: vi.fn().mockResolvedValue(denylistDoc),
    } as unknown as MarketplaceClient;
    useMarketplaceStore.getState().__setClientForTesting(client, 'https://api.velxio.dev/.well-known/velxio-marketplace.json');

    const a = useMarketplaceStore.getState().initialize();
    const b = useMarketplaceStore.getState().initialize();
    await Promise.all([a, b]);

    expect(probeSpy).toHaveBeenCalledTimes(1);
    expect(installsSpy).toHaveBeenCalledTimes(1);
  });

  it('refresh() forces a re-probe even after available', async () => {
    const probeSpy = vi
      .fn<[], Promise<MarketplaceStatus>>()
      .mockResolvedValueOnce(DISCOVERY)
      .mockResolvedValueOnce({ ...DISCOVERY, probedAt: 1700000000001 });
    const denylistDoc: LicenseDenylist = {
      revokedTokens: [],
      bannedPlugins: [],
      generatedAt: '2026-04-22',
    };
    const client = {
      probe: probeSpy,
      getInstalls: vi.fn().mockResolvedValue([]),
      getLicenses: vi.fn().mockResolvedValue([]),
      getDenylist: vi.fn().mockResolvedValue(denylistDoc),
    } as unknown as MarketplaceClient;
    useMarketplaceStore.getState().__setClientForTesting(client, 'https://api.velxio.dev/.well-known/velxio-marketplace.json');

    await useMarketplaceStore.getState().initialize();
    await useMarketplaceStore.getState().refresh();

    expect(probeSpy).toHaveBeenCalledTimes(2);
  });

  it('reset() returns to idle and drops cached data', async () => {
    const denylistDoc: LicenseDenylist = {
      revokedTokens: [],
      bannedPlugins: [],
      generatedAt: '2026-04-22',
    };
    const client = stubClient({ status: DISCOVERY, denylist: denylistDoc });
    useMarketplaceStore.getState().__setClientForTesting(client, 'https://api.velxio.dev/.well-known/velxio-marketplace.json');
    await useMarketplaceStore.getState().initialize();
    expect(useMarketplaceStore.getState().status.kind).toBe('available');

    useMarketplaceStore.getState().reset();
    const s = useMarketplaceStore.getState();
    expect(s.status.kind).toBe('idle');
    expect(s.installs).toBeNull();
    expect(s.licenses).toBeNull();
    expect(s.denylist).toBeNull();
  });
});
