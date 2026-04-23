/**
 * Offline license verification.
 *
 * Verification chain (every step is a possible early reject — order
 * is deliberate so we never spend a `crypto.subtle` call when a cheap
 * structural check already disqualifies the token):
 *
 *   1. Structural validation (`v: 1`, required fields).
 *   2. `expectedPluginId` match.
 *   3. `expectedUserId` match.
 *   4. `pluginVersion` semver range covers the version we want to load.
 *   5. `expiresAt` (with grace window) — only enforced for kinds that
 *      carry an expiry.
 *   6. Denylist (`jti` lookup).
 *   7. `kid` resolution → `unknown-kid` if no active key matches.
 *   8. Signature verification via `crypto.subtle.verify('Ed25519', …)`.
 *
 * The verifier **never throws** on bad input — every reject is a typed
 * `LicenseVerifyResult { ok: false; reason }`. The only thrown errors
 * are caller-side bugs (missing `crypto.subtle`, etc.).
 *
 * Key rotation: callers pass an array of active keys. When a license
 * carries a `kid`, the matching entry is used directly. When no `kid`
 * is present, the verifier tries each key in order and accepts the
 * first that validates. `activeUntil` lets the deployment retire an
 * old key after the grace window without code changes.
 */

import { base64UrlDecode } from './base64url';
import { canonicalJsonStringify, utf8Encode } from './canonicalize';
import { satisfies } from './semver';
import {
  LICENSE_TOKEN_SCHEMA_VERSION,
  type ActivePublicKey,
  type LicenseToken,
  type LicenseVerifyReason,
  type LicenseVerifyResult,
  type SignedLicense,
} from './types';

export interface VerifyLicenseOptions {
  readonly publicKeys: ReadonlyArray<ActivePublicKey>;
  readonly expectedPluginId: string;
  readonly expectedUserId: string;
  /** The exact plugin version the loader is about to instantiate. */
  readonly pluginVersion: string;
  /**
   * `Date.now()` equivalent. Override in tests for determinism. Defaults
   * to the real wall-clock.
   */
  readonly now?: number;
  /**
   * Grace period applied to `expiresAt`. Defaults to 24h to absorb a
   * mildly-skewed system clock without breaking offline use. Set to 0
   * to disable.
   */
  readonly graceMs?: number;
  /**
   * Revoked license identifiers. The default `jtiOf` derives the JTI
   * from the signature itself (signatures are unique per issuance).
   */
  readonly denylist?: ReadonlySet<string>;
  readonly jtiOf?: (signed: SignedLicense) => string;
  /**
   * Override `crypto.subtle` for tests. Defaults to the host's.
   */
  readonly subtle?: SubtleCrypto;
}

const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;

export async function verifyLicense(
  signed: SignedLicense,
  opts: VerifyLicenseOptions,
): Promise<LicenseVerifyResult> {
  const subtle = opts.subtle ?? globalThis.crypto?.subtle;
  if (!subtle) {
    return { ok: false, reason: 'malformed', detail: 'crypto.subtle unavailable' };
  }

  const struct = validateStructure(signed);
  if (!struct.ok) return reject(struct.reason, struct.detail);
  const license = struct.license;

  if (license.pluginId !== opts.expectedPluginId) {
    return reject('wrong-plugin', `expected ${opts.expectedPluginId}, got ${license.pluginId}`);
  }

  if (license.userId !== opts.expectedUserId) {
    return reject('wrong-user', `expected ${opts.expectedUserId}, got ${license.userId}`);
  }

  if (!satisfies(opts.pluginVersion, license.pluginVersion)) {
    return reject(
      'wrong-version',
      `plugin version ${opts.pluginVersion} not in range ${license.pluginVersion}`,
    );
  }

  const now = opts.now ?? Date.now();
  const grace = opts.graceMs ?? DEFAULT_GRACE_MS;
  if (license.kind === 'subscription' || license.kind === 'trial') {
    // expiresAt is required for these kinds — the structural check
    // already enforced that, so we can read it directly.
    const expiry = Date.parse(license.expiresAt!);
    if (Number.isFinite(expiry) && now > expiry + grace) {
      return reject('expired', `expired at ${license.expiresAt}`);
    }
  }

  const jti = (opts.jtiOf ?? defaultJti)(signed);
  if (opts.denylist?.has(jti)) {
    return reject('revoked', `jti ${jti} in denylist`);
  }

  const keys = resolveKeys(opts.publicKeys, signed.kid, now);
  if (keys.length === 0) {
    return reject(
      'unknown-kid',
      signed.kid !== undefined ? `kid ${signed.kid} not active` : 'no active keys',
    );
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = base64UrlDecode(signed.sig);
  } catch (err) {
    return reject('bad-signature', err instanceof Error ? err.message : String(err));
  }

  // Canonical JSON of the payload — Pro must produce exactly the same
  // bytes when signing.
  const messageBytes = utf8Encode(canonicalJsonStringify(license));

  for (const entry of keys) {
    let valid = false;
    try {
      // Use the typed `as BufferSource` view to make the older lib.dom
      // signatures happy; modern targets accept the Uint8Array directly.
      valid = await subtle.verify(
        'Ed25519',
        entry.key,
        sigBytes as unknown as ArrayBuffer,
        messageBytes as unknown as ArrayBuffer,
      );
    } catch (err) {
      return reject('bad-signature', err instanceof Error ? err.message : String(err));
    }
    if (valid) return { ok: true, license };
  }
  return reject('bad-signature', 'no active key validated the signature');
}

function reject(reason: LicenseVerifyReason, detail?: string): LicenseVerifyResult {
  return { ok: false, reason, detail };
}

function defaultJti(signed: SignedLicense): string {
  return signed.sig;
}

function resolveKeys(
  publicKeys: ReadonlyArray<ActivePublicKey>,
  kid: string | undefined,
  now: number,
): ReadonlyArray<ActivePublicKey> {
  const usable = publicKeys.filter((k) => isStillActive(k, now));
  if (kid === undefined) return usable;
  const match = usable.find((k) => k.kid === kid);
  return match ? [match] : [];
}

function isStillActive(key: ActivePublicKey, now: number): boolean {
  if (key.activeUntil === undefined) return true;
  const until = Date.parse(key.activeUntil);
  if (!Number.isFinite(until)) return true;
  return now <= until;
}

interface StructOk {
  readonly ok: true;
  readonly license: LicenseToken;
}
interface StructErr {
  readonly ok: false;
  readonly reason: LicenseVerifyReason;
  readonly detail?: string;
}

function validateStructure(signed: SignedLicense): StructOk | StructErr {
  if (!isPlainObject(signed)) return { ok: false, reason: 'malformed', detail: 'not an object' };
  if (typeof signed.sig !== 'string' || signed.sig === '') {
    return { ok: false, reason: 'malformed', detail: 'missing sig' };
  }
  if (!isPlainObject(signed.payload)) {
    return { ok: false, reason: 'malformed', detail: 'missing payload' };
  }
  const p = signed.payload as Record<string, unknown>;
  if (p.v !== LICENSE_TOKEN_SCHEMA_VERSION) {
    return { ok: false, reason: 'malformed', detail: `unsupported v: ${String(p.v)}` };
  }
  for (const key of ['pluginId', 'pluginVersion', 'userId', 'kind', 'issuedAt'] as const) {
    if (typeof p[key] !== 'string' || (p[key] as string) === '') {
      return { ok: false, reason: 'malformed', detail: `missing ${key}` };
    }
  }
  if (
    p.kind !== 'one-time' &&
    p.kind !== 'subscription' &&
    p.kind !== 'trial' &&
    p.kind !== 'free'
  ) {
    return { ok: false, reason: 'malformed', detail: `unknown kind: ${String(p.kind)}` };
  }
  if (typeof p.transferable !== 'boolean') {
    return { ok: false, reason: 'malformed', detail: 'transferable must be boolean' };
  }
  if (p.kind === 'subscription' || p.kind === 'trial') {
    if (typeof p.expiresAt !== 'string' || !Number.isFinite(Date.parse(p.expiresAt))) {
      return { ok: false, reason: 'malformed', detail: 'expiresAt required and parsable' };
    }
  }
  if (p.expiresAt !== undefined && typeof p.expiresAt !== 'string') {
    return { ok: false, reason: 'malformed', detail: 'expiresAt must be string or absent' };
  }
  return { ok: true, license: signed.payload };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
