// @vitest-environment jsdom
/**
 * MarketplaceClient — probe + REST endpoint behaviour.
 *
 * `fetch` is injected as a stub so we can simulate every wire-level
 * scenario (404, 5xx, malformed JSON, hostile size, missing cookie)
 * without a real server.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  MarketplaceAuthRequiredError,
  MarketplaceClient,
  MarketplaceUnavailableError,
} from '../marketplace/MarketplaceClient';
import {
  MARKETPLACE_DISCOVERY_SCHEMA_VERSION,
  type MarketplaceStatus,
} from '../marketplace/types';

const DISCOVERY_URL = 'https://api.velxio.dev/.well-known/velxio-marketplace.json';

function jsonRes(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

function textRes(body: string, init: ResponseInit = { status: 200 }): Response {
  return new Response(body, init);
}

function makeClient(fetchImpl: typeof fetch, now?: () => number): MarketplaceClient {
  return new MarketplaceClient({ fetchImpl, now: now ?? (() => 1700000000000) });
}

const VALID_DISCOVERY = {
  schemaVersion: MARKETPLACE_DISCOVERY_SCHEMA_VERSION,
  apiBaseUrl: 'https://api.velxio.dev',
  name: 'Velxio Marketplace',
};

describe('MarketplaceClient.probe', () => {
  it('returns disabled when discoveryUrl is null', async () => {
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const status = await client.probe(null);
    expect(status.kind).toBe('unavailable');
    if (status.kind === 'unavailable') {
      expect(status.reason).toBe('disabled');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns available with the parsed discovery doc on 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(VALID_DISCOVERY));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const status = await client.probe(DISCOVERY_URL);
    expect(status.kind).toBe('available');
    if (status.kind === 'available') {
      expect(status.discovery.apiBaseUrl).toBe('https://api.velxio.dev');
      expect(status.discovery.name).toBe('Velxio Marketplace');
    }
  });

  it('omits cookies when probing the well-known doc', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(VALID_DISCOVERY));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.probe(DISCOVERY_URL);
    const init = (fetchImpl.mock.calls[0]?.[1] ?? {}) as RequestInit;
    expect(init.credentials).toBe('omit');
  });

  it('returns not-found on 404', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textRes('nope', { status: 404 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const status = await client.probe(DISCOVERY_URL);
    expect(status).toMatchObject({ kind: 'unavailable', reason: 'not-found' });
  });

  it('returns http-error on 500', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textRes('boom', { status: 500 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const status = await client.probe(DISCOVERY_URL);
    expect(status).toMatchObject({ kind: 'unavailable', reason: 'http-error' });
  });

  it('returns network when fetch rejects (offline)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const status = await client.probe(DISCOVERY_URL);
    expect(status).toMatchObject({ kind: 'unavailable', reason: 'network' });
  });

  it('returns malformed-metadata when JSON is invalid', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textRes('not json {{', { status: 200 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const status = await client.probe(DISCOVERY_URL);
    expect(status).toMatchObject({ kind: 'unavailable', reason: 'malformed-metadata' });
  });

  it('rejects discovery doc with wrong schemaVersion', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ schemaVersion: 99, apiBaseUrl: 'https://x' }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const status = await client.probe(DISCOVERY_URL);
    expect(status).toMatchObject({ kind: 'unavailable', reason: 'malformed-metadata' });
    if (status.kind === 'unavailable' && status.reason === 'malformed-metadata') {
      expect(status.detail).toContain('schemaVersion');
    }
  });

  it('rejects discovery doc with non-http apiBaseUrl', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({ schemaVersion: 1, apiBaseUrl: 'javascript:alert(1)' }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const status = await client.probe(DISCOVERY_URL);
    expect(status).toMatchObject({ kind: 'unavailable', reason: 'malformed-metadata' });
  });

  it('rejects oversized discovery payload', async () => {
    const big = 'x'.repeat(70 * 1024);
    const fetchImpl = vi.fn().mockResolvedValue(textRes(big, { status: 200 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const status = await client.probe(DISCOVERY_URL);
    expect(status).toMatchObject({ kind: 'unavailable', reason: 'malformed-metadata' });
  });
});

function availableStatus(): MarketplaceStatus {
  return {
    kind: 'available',
    discovery: { ...VALID_DISCOVERY },
    probedAt: 1700000000000,
  };
}

describe('MarketplaceClient.getInstalls', () => {
  it('returns the installed list and includes credentials', async () => {
    const installs = [
      { id: 'logic', version: '1.0.0', enabled: true, installedAt: '2026-04-01T00:00:00Z' },
      { id: 'scope', version: '0.2.1', enabled: false, installedAt: '2026-04-10T00:00:00Z' },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(installs));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const result = await client.getInstalls(availableStatus());
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('logic');

    const init = (fetchImpl.mock.calls[0]?.[1] ?? {}) as RequestInit;
    expect(init.credentials).toBe('include');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.velxio.dev/api/marketplace/me/installs',
    );
  });

  it('drops malformed records but keeps valid ones', async () => {
    const installs = [
      { id: 'logic', version: '1.0.0', enabled: true, installedAt: '2026-04-01T00:00:00Z' },
      { id: 'broken' }, // missing version+enabled+installedAt
      null,
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(installs));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const result = await client.getInstalls(availableStatus());
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('logic');
  });

  it('throws MarketplaceAuthRequiredError on 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textRes('unauthenticated', { status: 401 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.getInstalls(availableStatus())).rejects.toBeInstanceOf(
      MarketplaceAuthRequiredError,
    );
  });

  it('throws MarketplaceUnavailableError when status is not available', async () => {
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(
      client.getInstalls({ kind: 'unavailable', reason: 'not-found', probedAt: 0 }),
    ).rejects.toBeInstanceOf(MarketplaceUnavailableError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws MarketplaceUnavailableError when feature is explicitly disabled', async () => {
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const status: MarketplaceStatus = {
      kind: 'available',
      discovery: { ...VALID_DISCOVERY, features: { installs: false } },
      probedAt: 0,
    };
    await expect(client.getInstalls(status)).rejects.toMatchObject({
      name: 'MarketplaceUnavailableError',
      reason: 'disabled',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('MarketplaceClient.getLicenses', () => {
  it('returns licenses with credentials included', async () => {
    const licenses = [
      { pluginId: 'logic', token: 'eyJxxx', expiresAt: '2027-01-01T00:00:00Z' },
      { pluginId: 'scope', token: 'eyJyyy' },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(licenses));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const result = await client.getLicenses(availableStatus());
    expect(result).toHaveLength(2);
    expect(result[1]?.expiresAt).toBeUndefined();
    const init = (fetchImpl.mock.calls[0]?.[1] ?? {}) as RequestInit;
    expect(init.credentials).toBe('include');
  });

  it('throws MarketplaceUnavailableError when payload is not an array', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ error: 'wrong shape' }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.getLicenses(availableStatus())).rejects.toBeInstanceOf(
      MarketplaceUnavailableError,
    );
  });
});

describe('MarketplaceClient.getDenylist', () => {
  it('returns denylist with credentials omitted (public endpoint)', async () => {
    const denylist = {
      revokedTokens: ['tokA', 'tokB'],
      bannedPlugins: ['evil.plugin'],
      generatedAt: '2026-04-22T00:00:00Z',
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(denylist));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const result = await client.getDenylist(availableStatus());
    expect(result.bannedPlugins).toEqual(['evil.plugin']);
    const init = (fetchImpl.mock.calls[0]?.[1] ?? {}) as RequestInit;
    expect(init.credentials).toBe('omit');
  });

  it('throws MarketplaceUnavailableError on bad denylist shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ revokedTokens: 'not-an-array' }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.getDenylist(availableStatus())).rejects.toBeInstanceOf(
      MarketplaceUnavailableError,
    );
  });
});
