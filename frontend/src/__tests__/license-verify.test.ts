/**
 * End-to-end license verification tests using a real Ed25519 keypair
 * generated via the host's `crypto.subtle`.
 *
 * Each test signs a payload with the test private key, then runs
 * `verifyLicense` against the matching public key. Reject paths
 * mutate the payload or the verification context to provoke each
 * specific reason code.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { base64UrlEncode } from '../plugins/license/base64url';
import { canonicalJsonStringify, utf8Encode } from '../plugins/license/canonicalize';
import {
  type ActivePublicKey,
  type LicenseToken,
  type SignedLicense,
} from '../plugins/license/types';
import { verifyLicense } from '../plugins/license/verify';

interface TestKey {
  readonly active: ActivePublicKey;
  readonly privateKey: CryptoKey;
}

async function makeTestKey(kid: string, activeUntil?: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return {
    privateKey: pair.privateKey,
    active: { kid, key: pair.publicKey, activeUntil },
  };
}

async function sign(payload: LicenseToken, privateKey: CryptoKey, kid?: string): Promise<SignedLicense> {
  const bytes = utf8Encode(canonicalJsonStringify(payload));
  const sigBuf = await crypto.subtle.sign('Ed25519', privateKey, bytes as unknown as ArrayBuffer);
  return { payload, sig: base64UrlEncode(new Uint8Array(sigBuf)), kid };
}

const NOW = Date.parse('2026-04-22T00:00:00Z');

function freshPayload(overrides: Partial<LicenseToken> = {}): LicenseToken {
  return {
    v: 1,
    pluginId: 'logic.analyzer',
    pluginVersion: '^1.0.0',
    userId: 'user-uuid-1',
    kind: 'one-time',
    issuedAt: '2026-04-01T00:00:00Z',
    transferable: true,
    ...overrides,
  } as LicenseToken;
}

let primary: TestKey;

beforeAll(async () => {
  primary = await makeTestKey('k1');
});

describe('verifyLicense — happy path', () => {
  it('accepts a valid one-time license', async () => {
    const signed = await sign(freshPayload(), primary.privateKey, 'k1');
    const result = await verifyLicense(signed, {
      publicKeys: [primary.active],
      expectedPluginId: 'logic.analyzer',
      expectedUserId: 'user-uuid-1',
      pluginVersion: '1.5.0',
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.license.pluginId).toBe('logic.analyzer');
  });

  it('accepts when no kid is set and one of the active keys verifies', async () => {
    const signed = await sign(freshPayload(), primary.privateKey); // no kid
    const result = await verifyLicense(signed, {
      publicKeys: [primary.active],
      expectedPluginId: 'logic.analyzer',
      expectedUserId: 'user-uuid-1',
      pluginVersion: '1.0.0',
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a subscription within the grace window', async () => {
    const expiresAt = new Date(NOW - 12 * 60 * 60 * 1000).toISOString(); // 12h ago, within 24h grace
    const signed = await sign(
      freshPayload({ kind: 'subscription', expiresAt }),
      primary.privateKey,
      'k1',
    );
    const result = await verifyLicense(signed, {
      publicKeys: [primary.active],
      expectedPluginId: 'logic.analyzer',
      expectedUserId: 'user-uuid-1',
      pluginVersion: '1.0.0',
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });
});

describe('verifyLicense — reject paths', () => {
  it('returns malformed when payload is missing required field', async () => {
    const signed = await sign(freshPayload(), primary.privateKey, 'k1');
    // Drop pluginId post-signing.
    const broken = { ...signed, payload: { ...signed.payload, pluginId: '' } as LicenseToken };
    const result = await verifyLicense(broken, {
      publicKeys: [primary.active],
      expectedPluginId: 'logic.analyzer',
      expectedUserId: 'user-uuid-1',
      pluginVersion: '1.0.0',
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('returns malformed when v is not 1', async () => {
    const result = await verifyLicense(
      { payload: { ...freshPayload(), v: 2 as 1 }, sig: 'aaaa' },
      {
        publicKeys: [primary.active],
        expectedPluginId: 'logic.analyzer',
        expectedUserId: 'user-uuid-1',
        pluginVersion: '1.0.0',
        now: NOW,
      },
    );
    expect(result).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('returns malformed when subscription is missing expiresAt', async () => {
    const result = await verifyLicense(
      { payload: { ...freshPayload({ kind: 'subscription' }) }, sig: 'aaaa' },
      {
        publicKeys: [primary.active],
        expectedPluginId: 'logic.analyzer',
        expectedUserId: 'user-uuid-1',
        pluginVersion: '1.0.0',
        now: NOW,
      },
    );
    expect(result).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('returns wrong-plugin when pluginId mismatches', async () => {
    const signed = await sign(freshPayload(), primary.privateKey, 'k1');
    const result = await verifyLicense(signed, {
      publicKeys: [primary.active],
      expectedPluginId: 'other.plugin',
      expectedUserId: 'user-uuid-1',
      pluginVersion: '1.0.0',
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, reason: 'wrong-plugin' });
  });

  it('returns wrong-user when userId mismatches', async () => {
    const signed = await sign(freshPayload(), primary.privateKey, 'k1');
    const result = await verifyLicense(signed, {
      publicKeys: [primary.active],
      expectedPluginId: 'logic.analyzer',
      expectedUserId: 'someone-else',
      pluginVersion: '1.0.0',
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, reason: 'wrong-user' });
  });

  it('returns wrong-version when version is outside the allowed range', async () => {
    const signed = await sign(
      freshPayload({ pluginVersion: '^1.0.0' }),
      primary.privateKey,
      'k1',
    );
    const result = await verifyLicense(signed, {
      publicKeys: [primary.active],
      expectedPluginId: 'logic.analyzer',
      expectedUserId: 'user-uuid-1',
      pluginVersion: '2.0.0',
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, reason: 'wrong-version' });
  });

  it('returns expired when subscription expiry + grace passed', async () => {
    const expiresAt = new Date(NOW - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    const signed = await sign(
      freshPayload({ kind: 'subscription', expiresAt }),
      primary.privateKey,
      'k1',
    );
    const result = await verifyLicense(signed, {
      publicKeys: [primary.active],
      expectedPluginId: 'logic.analyzer',
      expectedUserId: 'user-uuid-1',
      pluginVersion: '1.0.0',
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('does not check expiry for one-time licenses', async () => {
    const signed = await sign(
      freshPayload({ expiresAt: '1990-01-01T00:00:00Z' }), // ancient, but kind=one-time
      primary.privateKey,
      'k1',
    );
    const result = await verifyLicense(signed, {
      publicKeys: [primary.active],
      expectedPluginId: 'logic.analyzer',
      expectedUserId: 'user-uuid-1',
      pluginVersion: '1.0.0',
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it('returns revoked when jti is in denylist', async () => {
    const signed = await sign(freshPayload(), primary.privateKey, 'k1');
    const result = await verifyLicense(signed, {
      publicKeys: [primary.active],
      expectedPluginId: 'logic.analyzer',
      expectedUserId: 'user-uuid-1',
      pluginVersion: '1.0.0',
      now: NOW,
      denylist: new Set([signed.sig]),
    });
    expect(result).toMatchObject({ ok: false, reason: 'revoked' });
  });

  it('returns unknown-kid when license names a key that is not active', async () => {
    const signed = await sign(freshPayload(), primary.privateKey, 'wrong-kid');
    const result = await verifyLicense(signed, {
      publicKeys: [primary.active],
      expectedPluginId: 'logic.analyzer',
      expectedUserId: 'user-uuid-1',
      pluginVersion: '1.0.0',
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, reason: 'unknown-kid' });
  });

  it('returns unknown-kid when the active key has expired (activeUntil in the past)', async () => {
    const retired = await makeTestKey('k0', new Date(NOW - 1000).toISOString());
    const signed = await sign(freshPayload(), retired.privateKey, 'k0');
    const result = await verifyLicense(signed, {
      publicKeys: [retired.active],
      expectedPluginId: 'logic.analyzer',
      expectedUserId: 'user-uuid-1',
      pluginVersion: '1.0.0',
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, reason: 'unknown-kid' });
  });

  it('returns bad-signature when the signature was tampered', async () => {
    const signed = await sign(freshPayload(), primary.privateKey, 'k1');
    // Flip one byte in the base64url signature.
    const tampered = signed.sig.startsWith('A')
      ? 'B' + signed.sig.slice(1)
      : 'A' + signed.sig.slice(1);
    const result = await verifyLicense(
      { ...signed, sig: tampered },
      {
        publicKeys: [primary.active],
        expectedPluginId: 'logic.analyzer',
        expectedUserId: 'user-uuid-1',
        pluginVersion: '1.0.0',
        now: NOW,
      },
    );
    expect(result).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('returns bad-signature when the payload was tampered after signing', async () => {
    const signed = await sign(freshPayload(), primary.privateKey, 'k1');
    const tampered: SignedLicense = {
      ...signed,
      payload: { ...signed.payload, pluginVersion: '*' }, // attacker tries to broaden the range
    };
    const result = await verifyLicense(tampered, {
      publicKeys: [primary.active],
      expectedPluginId: 'logic.analyzer',
      expectedUserId: 'user-uuid-1',
      pluginVersion: '99.0.0',
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('returns bad-signature when no key in the active list matches a kid-less license', async () => {
    const wrongKey = await makeTestKey('k2');
    const signed = await sign(freshPayload(), primary.privateKey); // no kid
    const result = await verifyLicense(signed, {
      publicKeys: [wrongKey.active], // signed with primary, only wrongKey is in active list
      expectedPluginId: 'logic.analyzer',
      expectedUserId: 'user-uuid-1',
      pluginVersion: '1.0.0',
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, reason: 'bad-signature' });
  });
});

describe('verifyLicense — key rotation', () => {
  it('accepts a license signed with an old key while activeUntil is still in the future', async () => {
    const old = await makeTestKey('k-old', new Date(NOW + 60 * 1000).toISOString());
    const fresh = await makeTestKey('k-new');
    const signed = await sign(freshPayload(), old.privateKey, 'k-old');
    const result = await verifyLicense(signed, {
      publicKeys: [fresh.active, old.active],
      expectedPluginId: 'logic.analyzer',
      expectedUserId: 'user-uuid-1',
      pluginVersion: '1.0.0',
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it('tries every active key when no kid is set, succeeds on second match', async () => {
    const a = await makeTestKey('k-a');
    const b = await makeTestKey('k-b');
    const signed = await sign(freshPayload(), b.privateKey); // no kid, signed by b
    const result = await verifyLicense(signed, {
      publicKeys: [a.active, b.active],
      expectedPluginId: 'logic.analyzer',
      expectedUserId: 'user-uuid-1',
      pluginVersion: '1.0.0',
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });
});
