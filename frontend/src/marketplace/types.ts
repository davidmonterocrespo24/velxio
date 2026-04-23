/**
 * Public type contracts between the open-source Core and the Pro
 * marketplace backend. Keep this file dependency-free — it is the
 * source of truth for what the Core expects from Pro.
 *
 * Schema versions are advanced via Pro's `/.well-known/velxio-marketplace.json`
 * (`schemaVersion` field). The Core hard-rejects any payload whose
 * `schemaVersion` does not match `MARKETPLACE_DISCOVERY_SCHEMA_VERSION`.
 */

/** Bumped any time the wire format below changes incompatibly. */
export const MARKETPLACE_DISCOVERY_SCHEMA_VERSION = 1 as const;

/**
 * Shape of `/.well-known/velxio-marketplace.json`. Pro returns this
 * unauthenticated. The Core treats it as the canonical capability
 * announcement — endpoints below are derived from `apiBaseUrl`.
 */
export interface MarketplaceDiscoveryDocument {
  /** Always equal to {@link MARKETPLACE_DISCOVERY_SCHEMA_VERSION}. */
  readonly schemaVersion: number;
  /**
   * Absolute base URL the Core should use for `/api/marketplace/...`.
   * Pro may host the well-known doc on a different origin from the
   * API (e.g. CDN edge for the doc, regional API for the data).
   */
  readonly apiBaseUrl: string;
  /** Human-readable name shown in the editor's "Marketplace" UI. */
  readonly name?: string;
  /** Optional capability flags so the Core can hide UI gracefully. */
  readonly features?: {
    readonly installs?: boolean;
    readonly licenses?: boolean;
    readonly denylist?: boolean;
    readonly purchases?: boolean;
  };
  /** Public buy-link template (e.g. `https://velxio.dev/marketplace/{slug}/buy`). */
  readonly purchaseUrlTemplate?: string;
}

export interface InstalledRecord {
  readonly id: string;
  readonly version: string;
  readonly enabled: boolean;
  /** ISO-8601 timestamp. */
  readonly installedAt: string;
  /** SHA-256 hex of the bundle Pro currently considers authoritative. */
  readonly bundleHash?: string;
}

export interface LicenseRecord {
  readonly pluginId: string;
  /** Opaque signed token consumed by CORE-009. */
  readonly token: string;
  /** ISO-8601, omitted for perpetual licenses. */
  readonly expiresAt?: string;
}

export interface LicenseDenylist {
  /** Revoked license tokens (exact match). */
  readonly revokedTokens: ReadonlyArray<string>;
  /** Plugin IDs that the Core must refuse to load entirely. */
  readonly bannedPlugins: ReadonlyArray<string>;
  /** ISO-8601 timestamp Pro generated this list. */
  readonly generatedAt: string;
}

/**
 * Discriminated union the Core's UI consumes. Every transition from
 * `unavailable` carries a reason so the editor can show the right
 * message ("offline", "not configured", etc.).
 */
export type MarketplaceStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'probing' }
  | {
      readonly kind: 'available';
      readonly discovery: MarketplaceDiscoveryDocument;
      readonly probedAt: number;
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: MarketplaceUnavailableReason;
      readonly probedAt: number;
      readonly detail?: string;
    };

export type MarketplaceUnavailableReason =
  /** No `VITE_VELXIO_MARKETPLACE_BASE_URL` set or set to empty. Self-host case. */
  | 'disabled'
  /** Well-known returned 404 / 410. Pro is not deployed at this origin. */
  | 'not-found'
  /** Fetch threw or timed out. Likely transient — retry on next refresh. */
  | 'network'
  /** Well-known returned non-OK status that isn't 404 (5xx, 401, etc.). */
  | 'http-error'
  /** Well-known parsed but failed schema validation. */
  | 'malformed-metadata';
