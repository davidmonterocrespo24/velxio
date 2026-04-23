/**
 * Thin REST client for the Pro marketplace.
 *
 * Layered design (each layer testable in isolation):
 *
 *   getMarketplaceBaseUrl()                 (config.ts)
 *           │
 *           ▼
 *   probeDiscovery()  ─►  MarketplaceDiscoveryDocument
 *           │
 *           ▼
 *   MarketplaceClient.{ getInstalls, getLicenses, getDenylist }
 *
 * Discovery probe is **the only** unauthenticated, unbounded call —
 * everything else requires `credentials: 'include'` because the auth
 * cookie is set by Core on `velxio.dev`. Pro lives at `api.velxio.dev`,
 * so CORS + cookie sharing must be in place server-side (PRO-001).
 *
 * The Core never holds Pro's auth state — it just borrows the
 * cookie. If `me/installs` returns 401, the user is simply not logged
 * in to Pro yet; the editor shows a "Sign in to Pro" CTA.
 */

import type {
  InstalledRecord,
  LicenseDenylist,
  LicenseRecord,
  MarketplaceDiscoveryDocument,
  MarketplaceStatus,
  MarketplaceUnavailableReason,
} from './types';
import { MARKETPLACE_DISCOVERY_SCHEMA_VERSION } from './types';

const DEFAULT_TIMEOUT_MS = 10_000;
/** Hard cap so a hostile Pro can't DoS the editor by streaming forever. */
const MAX_DISCOVERY_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

export interface MarketplaceClientOptions {
  /** Override `fetch` for tests. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /**
   * Used to stamp `probedAt` on resulting `MarketplaceStatus`. Override
   * in tests for deterministic outputs.
   */
  readonly now?: () => number;
}

/**
 * Thrown by data-fetch methods (`getInstalls` etc) when the caller
 * invokes them without a successful probe. The store enforces this
 * statically — the typed status union should make it unrepresentable.
 */
export class MarketplaceUnavailableError extends Error {
  override readonly name = 'MarketplaceUnavailableError';
  constructor(readonly reason: MarketplaceUnavailableReason, message?: string) {
    super(message ?? `Marketplace unavailable: ${reason}`);
  }
}

/** Thrown by data-fetch methods when the auth cookie is missing/expired. */
export class MarketplaceAuthRequiredError extends Error {
  override readonly name = 'MarketplaceAuthRequiredError';
  constructor(readonly endpoint: string) {
    super(`Marketplace endpoint requires sign-in: ${endpoint}`);
  }
}

export class MarketplaceClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(opts: MarketplaceClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Probe the well-known discovery doc. Returns a fully-typed status —
   * never throws on the network or HTTP layer; only on caller bugs
   * (invalid baseUrl).
   */
  async probe(discoveryUrl: string | null): Promise<MarketplaceStatus> {
    if (discoveryUrl === null) {
      return { kind: 'unavailable', reason: 'disabled', probedAt: this.now() };
    }

    let res: Response;
    try {
      res = await this.fetchWithTimeout(discoveryUrl, {
        // The discovery doc is public — never send cookies.
        credentials: 'omit',
        headers: { Accept: 'application/json' },
      });
    } catch (err) {
      return {
        kind: 'unavailable',
        reason: 'network',
        probedAt: this.now(),
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    if (res.status === 404 || res.status === 410) {
      return { kind: 'unavailable', reason: 'not-found', probedAt: this.now() };
    }
    if (!res.ok) {
      return {
        kind: 'unavailable',
        reason: 'http-error',
        probedAt: this.now(),
        detail: `${res.status} ${res.statusText}`,
      };
    }

    let text: string;
    try {
      text = await readBoundedText(res, MAX_DISCOVERY_BYTES);
    } catch (err) {
      // Size-cap exceeded or body stream errored — treat as malformed
      // metadata. probe() must never throw on transport-layer issues
      // because callers want a typed status, not exception handling.
      return {
        kind: 'unavailable',
        reason: 'malformed-metadata',
        probedAt: this.now(),
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        kind: 'unavailable',
        reason: 'malformed-metadata',
        probedAt: this.now(),
        detail: 'invalid JSON',
      };
    }

    const validation = validateDiscoveryDocument(parsed);
    if (!validation.ok) {
      return {
        kind: 'unavailable',
        reason: 'malformed-metadata',
        probedAt: this.now(),
        detail: validation.error,
      };
    }

    return { kind: 'available', discovery: validation.document, probedAt: this.now() };
  }

  /** Fetch the user's installed plugins. Requires `available` status. */
  async getInstalls(status: MarketplaceStatus): Promise<ReadonlyArray<InstalledRecord>> {
    const url = this.requireApi(status, '/api/marketplace/me/installs', 'installs');
    const data = await this.getJson(url, { credentials: 'include' });
    if (!Array.isArray(data)) {
      throw new MarketplaceUnavailableError('malformed-metadata', `Expected array from ${url}`);
    }
    return data.filter(isInstalledRecord);
  }

  async getLicenses(status: MarketplaceStatus): Promise<ReadonlyArray<LicenseRecord>> {
    const url = this.requireApi(status, '/api/marketplace/me/licenses', 'licenses');
    const data = await this.getJson(url, { credentials: 'include' });
    if (!Array.isArray(data)) {
      throw new MarketplaceUnavailableError('malformed-metadata', `Expected array from ${url}`);
    }
    return data.filter(isLicenseRecord);
  }

  async getDenylist(status: MarketplaceStatus): Promise<LicenseDenylist> {
    const url = this.requireApi(status, '/api/marketplace/license-denylist.json', 'denylist');
    // Denylist is public so the Core can enforce revocations even
    // when the user isn't logged in to Pro.
    const data = await this.getJson(url, { credentials: 'omit' });
    if (!isLicenseDenylist(data)) {
      throw new MarketplaceUnavailableError('malformed-metadata', `Bad denylist from ${url}`);
    }
    return data;
  }

  private requireApi(
    status: MarketplaceStatus,
    path: string,
    feature: 'installs' | 'licenses' | 'denylist',
  ): string {
    if (status.kind !== 'available') {
      throw new MarketplaceUnavailableError(
        status.kind === 'unavailable' ? status.reason : 'disabled',
      );
    }
    if (status.discovery.features?.[feature] === false) {
      // Pro explicitly disabled this capability — caller should hide UI.
      throw new MarketplaceUnavailableError('disabled', `Feature disabled: ${feature}`);
    }
    return joinUrl(status.discovery.apiBaseUrl, path);
  }

  private async getJson(url: string, init: RequestInit): Promise<unknown> {
    const res = await this.fetchWithTimeout(url, {
      ...init,
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
    });
    if (res.status === 401 || res.status === 403) {
      throw new MarketplaceAuthRequiredError(url);
    }
    if (res.status === 404 || res.status === 410) {
      throw new MarketplaceUnavailableError('not-found', `${url} returned ${res.status}`);
    }
    if (!res.ok) {
      throw new MarketplaceUnavailableError('http-error', `${res.status} for ${url}`);
    }
    const text = await readBoundedText(res, MAX_PAYLOAD_BYTES);
    try {
      return JSON.parse(text);
    } catch {
      throw new MarketplaceUnavailableError('malformed-metadata', `Invalid JSON from ${url}`);
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readBoundedText(res: Response, max: number): Promise<string> {
  const buf = await res.arrayBuffer();
  if (buf.byteLength > max) {
    throw new MarketplaceUnavailableError(
      'malformed-metadata',
      `Response exceeded ${max} bytes`,
    );
  }
  return new TextDecoder('utf-8').decode(buf);
}

function joinUrl(base: string, path: string): string {
  const cleanedBase = base.replace(/\/+$/, '');
  const cleanedPath = path.startsWith('/') ? path : `/${path}`;
  return `${cleanedBase}${cleanedPath}`;
}

interface ValidateOk {
  readonly ok: true;
  readonly document: MarketplaceDiscoveryDocument;
}
interface ValidateErr {
  readonly ok: false;
  readonly error: string;
}

function validateDiscoveryDocument(raw: unknown): ValidateOk | ValidateErr {
  if (!isPlainObject(raw)) return { ok: false, error: 'not an object' };
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== MARKETPLACE_DISCOVERY_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `unsupported schemaVersion: ${String(r.schemaVersion)}`,
    };
  }
  if (typeof r.apiBaseUrl !== 'string' || !/^https?:\/\//i.test(r.apiBaseUrl)) {
    return { ok: false, error: 'apiBaseUrl must be an absolute http(s) URL' };
  }
  // Optional fields validated loosely — unknown fields ignored to keep
  // future Pro additions backward-compatible.
  const document: MarketplaceDiscoveryDocument = {
    schemaVersion: MARKETPLACE_DISCOVERY_SCHEMA_VERSION,
    apiBaseUrl: r.apiBaseUrl,
    name: typeof r.name === 'string' ? r.name : undefined,
    features: isPlainObject(r.features)
      ? {
          installs: r.features.installs === false ? false : undefined,
          licenses: r.features.licenses === false ? false : undefined,
          denylist: r.features.denylist === false ? false : undefined,
          purchases: r.features.purchases === false ? false : undefined,
        }
      : undefined,
    purchaseUrlTemplate:
      typeof r.purchaseUrlTemplate === 'string' ? r.purchaseUrlTemplate : undefined,
  };
  return { ok: true, document };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInstalledRecord(v: unknown): v is InstalledRecord {
  if (!isPlainObject(v)) return false;
  return (
    typeof v.id === 'string' &&
    typeof v.version === 'string' &&
    typeof v.enabled === 'boolean' &&
    typeof v.installedAt === 'string'
  );
}

function isLicenseRecord(v: unknown): v is LicenseRecord {
  if (!isPlainObject(v)) return false;
  return typeof v.pluginId === 'string' && typeof v.token === 'string';
}

function isLicenseDenylist(v: unknown): v is LicenseDenylist {
  if (!isPlainObject(v)) return false;
  return (
    Array.isArray(v.revokedTokens) &&
    v.revokedTokens.every((s) => typeof s === 'string') &&
    Array.isArray(v.bannedPlugins) &&
    v.bannedPlugins.every((s) => typeof s === 'string') &&
    typeof v.generatedAt === 'string'
  );
}
