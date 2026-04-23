/**
 * License resolution for the plugin loader.
 *
 * The loader receives only `InstalledPlugin` records — no auth context,
 * no license tokens, no signing keys. To verify a paid plugin's license
 * before instantiating it, the loader needs three things:
 *
 *   - the SignedLicense for the plugin id (Pro-issued)
 *   - the user id the license must belong to
 *   - the active Ed25519 public keys to verify the signature
 *
 * Wiring the loader directly to `useMarketplaceStore` + `useAuthStore`
 * would make the orchestration coupled to React/Zustand and untestable
 * without a jsdom environment. Instead, the loader takes a
 * `LicenseResolver` interface and the editor wires the production
 * implementation at startup.
 *
 * Tests inject `inMemoryLicenseResolver()`; production uses
 * `defaultLicenseResolver()` which reads from the live Zustand stores.
 */

import { useAuthStore } from '../../store/useAuthStore';
import { useMarketplaceStore } from '../../store/useMarketplaceStore';
import {
  ACTIVE_PUBLIC_KEYS,
  type ActivePublicKey,
  type SignedLicense,
} from '../license';

// ── Public interface ─────────────────────────────────────────────────────

export interface LicenseResolver {
  /**
   * Return the signed license for a plugin id, or `null` if the user
   * does not hold a license for this plugin. The loader treats `null`
   * as `no-license` and rejects paid plugins.
   */
  getLicense(pluginId: string): SignedLicense | null;
  /**
   * UUID of the currently authenticated user, or `null` if anonymous.
   * Used for `expectedUserId` in the verifier — no user means we cannot
   * even attempt to verify a paid license.
   */
  getUserId(): string | null;
  /** Active Ed25519 public keys. Empty array fails closed via `unknown-kid`. */
  getPublicKeys(): ReadonlyArray<ActivePublicKey>;
  /**
   * JTIs of revoked tokens. Optional — when absent, the verifier skips
   * the denylist step. Present-but-empty Set still triggers the lookup.
   */
  getDenylist(): ReadonlySet<string> | undefined;
}

// ── Production resolver ──────────────────────────────────────────────────

/**
 * Reads from the live Zustand stores plus the embedded public-key list.
 * Pure read — no subscriptions, called per-load. Cheap because each
 * `getState()` is a Map lookup.
 */
export function defaultLicenseResolver(): LicenseResolver {
  return {
    getLicense(pluginId: string): SignedLicense | null {
      const records = useMarketplaceStore.getState().licenses;
      if (records === null) return null;
      const record = records.find((r) => r.pluginId === pluginId);
      if (record === undefined) return null;
      return parseLicenseToken(record.token);
    },
    getUserId(): string | null {
      return useAuthStore.getState().user?.id ?? null;
    },
    getPublicKeys(): ReadonlyArray<ActivePublicKey> {
      return ACTIVE_PUBLIC_KEYS;
    },
    getDenylist(): ReadonlySet<string> | undefined {
      const denylist = useMarketplaceStore.getState().denylist;
      if (denylist === null) return undefined;
      return new Set(denylist.revokedTokens);
    },
  };
}

// ── In-memory resolver (tests + dev-mode mock) ───────────────────────────

export interface InMemoryLicenseResolverInit {
  readonly licenses?: ReadonlyArray<{ pluginId: string; signed: SignedLicense }>;
  readonly userId?: string | null;
  readonly publicKeys?: ReadonlyArray<ActivePublicKey>;
  readonly denylist?: ReadonlySet<string>;
}

/**
 * Build a stateless resolver from concrete inputs — used by tests and by
 * dev-mode plugin authors who want to load a paid plugin locally without
 * wiring the full Pro stack.
 */
export function inMemoryLicenseResolver(init: InMemoryLicenseResolverInit = {}): LicenseResolver {
  const byId = new Map<string, SignedLicense>();
  for (const e of init.licenses ?? []) byId.set(e.pluginId, e.signed);
  const userId = init.userId === undefined ? null : init.userId;
  const publicKeys = init.publicKeys ?? [];
  const denylist = init.denylist;
  return {
    getLicense(pluginId: string): SignedLicense | null {
      return byId.get(pluginId) ?? null;
    },
    getUserId(): string | null {
      return userId;
    },
    getPublicKeys(): ReadonlyArray<ActivePublicKey> {
      return publicKeys;
    },
    getDenylist(): ReadonlySet<string> | undefined {
      return denylist;
    },
  };
}

// ── Wire format ──────────────────────────────────────────────────────────

/**
 * `LicenseRecord.token` is documented as an "opaque signed token" — in
 * practice the Pro backend serves a JSON-encoded `SignedLicense`. Parse
 * defensively: a malformed token is indistinguishable from "no license"
 * for the loader's purposes (both fall through to `no-license`).
 */
function parseLicenseToken(token: string): SignedLicense | null {
  try {
    const parsed = JSON.parse(token) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.sig !== 'string' || obj.sig === '') return null;
    if (obj.payload === null || typeof obj.payload !== 'object') return null;
    return parsed as SignedLicense;
  } catch {
    return null;
  }
}
