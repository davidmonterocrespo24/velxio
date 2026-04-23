/**
 * UI-facing state for the marketplace discovery + data fetch.
 *
 * The store owns one `MarketplaceClient` and re-uses it across calls
 * (no need to reconstruct on every refresh — `fetch` itself is the
 * shared resource). A test seam (`__setClientForTesting`) replaces the
 * client; production code never touches it.
 *
 * Empty-string env var ⇒ status `unavailable / disabled` after init.
 * The UI hides every marketplace surface in this case so a self-hosted
 * Core never tries to talk to velxio.dev.
 */

import { create } from 'zustand';

import { getDiscoveryUrl } from '../marketplace/config';
import {
  MarketplaceAuthRequiredError,
  MarketplaceClient,
  MarketplaceUnavailableError,
} from '../marketplace/MarketplaceClient';
import type {
  InstalledRecord,
  LicenseDenylist,
  LicenseRecord,
  MarketplaceStatus,
} from '../marketplace/types';

export interface MarketplaceStoreState {
  readonly status: MarketplaceStatus;
  readonly installs: ReadonlyArray<InstalledRecord> | null;
  readonly licenses: ReadonlyArray<LicenseRecord> | null;
  readonly denylist: LicenseDenylist | null;
  readonly authRequired: boolean;
  readonly lastError: string | null;
  /**
   * Probe + (if available) load installs + licenses + denylist. Safe
   * to call multiple times — concurrent calls are coalesced via
   * `_pending`. The first call after construction acts as init.
   */
  initialize(opts?: InitializeOptions): Promise<MarketplaceStatus>;
  refresh(): Promise<MarketplaceStatus>;
  /** Explicit logout-from-pro path: drop cached install/license data. */
  reset(): void;
  /** Test seam — never call from production code. */
  __setClientForTesting(client: MarketplaceClient | null, discoveryUrl?: string | null): void;
}

interface InitializeOptions {
  readonly force?: boolean;
}

let sharedClient: MarketplaceClient | null = null;
let cachedDiscoveryUrl: string | null | undefined; // undefined = not resolved yet
let pendingInit: Promise<MarketplaceStatus> | null = null;

export const useMarketplaceStore = create<MarketplaceStoreState>((set, get) => ({
  status: { kind: 'idle' },
  installs: null,
  licenses: null,
  denylist: null,
  authRequired: false,
  lastError: null,

  async initialize(opts: InitializeOptions = {}) {
    const force = opts.force === true;
    if (!force && get().status.kind === 'available') return get().status;
    if (pendingInit) return pendingInit;

    pendingInit = runDiscoveryAndLoad(set, get).finally(() => {
      pendingInit = null;
    });
    return pendingInit;
  },

  async refresh() {
    return get().initialize({ force: true });
  },

  reset() {
    set({
      status: { kind: 'idle' },
      installs: null,
      licenses: null,
      denylist: null,
      authRequired: false,
      lastError: null,
    });
  },

  __setClientForTesting(client, discoveryUrl) {
    sharedClient = client;
    if (arguments.length >= 2) {
      cachedDiscoveryUrl = discoveryUrl;
    }
    pendingInit = null;
    set({
      status: { kind: 'idle' },
      installs: null,
      licenses: null,
      denylist: null,
      authRequired: false,
      lastError: null,
    });
  },
}));

async function runDiscoveryAndLoad(
  set: (partial: Partial<MarketplaceStoreState>) => void,
  get: () => MarketplaceStoreState,
): Promise<MarketplaceStatus> {
  void get; // reserved for future cache-aware behaviour
  set({ status: { kind: 'probing' }, lastError: null });

  const client = sharedClient ?? (sharedClient = new MarketplaceClient());
  const discoveryUrl = cachedDiscoveryUrl !== undefined ? cachedDiscoveryUrl : getDiscoveryUrl();
  cachedDiscoveryUrl = discoveryUrl;

  const status = await client.probe(discoveryUrl);
  set({ status });

  if (status.kind !== 'available') {
    set({ installs: null, licenses: null, denylist: null, authRequired: false });
    return status;
  }

  // Three independent fetches — `Promise.allSettled` so a failing
  // licenses endpoint does not hide the install list and vice-versa.
  const [installsR, licensesR, denylistR] = await Promise.allSettled([
    client.getInstalls(status),
    client.getLicenses(status),
    client.getDenylist(status),
  ]);

  let authRequired = false;
  const errors: string[] = [];

  const installs = unwrap(installsR, errors, (err) => {
    if (err instanceof MarketplaceAuthRequiredError) {
      authRequired = true;
      return null;
    }
    return null;
  });
  const licenses = unwrap(licensesR, errors, (err) => {
    if (err instanceof MarketplaceAuthRequiredError) {
      authRequired = true;
      return null;
    }
    return null;
  });
  const denylist = unwrap(denylistR, errors, () => null);

  set({
    installs: installs ?? null,
    licenses: licenses ?? null,
    denylist: denylist ?? null,
    authRequired,
    lastError: errors.length === 0 ? null : errors.join('; '),
  });
  return status;
}

function unwrap<T>(
  result: PromiseSettledResult<T>,
  errors: string[],
  recover: (err: unknown) => T | null,
): T | null {
  if (result.status === 'fulfilled') return result.value;
  const recovered = recover(result.reason);
  if (recovered !== null) return recovered;
  const reason = result.reason;
  if (reason instanceof MarketplaceAuthRequiredError) return null;
  if (reason instanceof MarketplaceUnavailableError) {
    errors.push(`${reason.name}(${reason.reason}): ${reason.message}`);
  } else if (reason instanceof Error) {
    errors.push(`${reason.name}: ${reason.message}`);
  } else {
    errors.push(String(reason));
  }
  return null;
}
