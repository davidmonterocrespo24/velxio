/**
 * Active public keys for offline license verification.
 *
 * This module is intentionally a *placeholder* until PRO-007 ships the
 * Pro-side keypair generator and the operations runbook for key
 * rotation. Until then, no real Velxio Pro keys are baked into the
 * client; consumers that try to verify a license without supplying
 * `publicKeys` to `verifyLicense({ publicKeys: ... })` will hit the
 * `unknown-kid` reject path, which is the correct fail-closed default.
 *
 * When PRO-007 lands, this file will export an array of
 * `ActivePublicKey` entries — one per active or grace-period kid —
 * with the public bytes embedded as base64url constants and imported
 * lazily via `crypto.subtle.importKey('raw', ...)`.
 *
 * Why an empty array (and not, say, throwing on import)?
 *   - The license verifier API is fully exercised by tests that pass
 *     their own keys; we do not want test runs to depend on production
 *     key material.
 *   - The plugin loader can already wire a key-resolution callback in
 *     CORE-008's UI work, so there is no production code path that
 *     reads from this list yet — but having the named export reserved
 *     prevents an import refactor when keys land.
 *
 * Rotation procedure (to be documented in `docs/PLUGIN_LICENSING.md`):
 *   1. Generate a new Ed25519 keypair on the Pro server.
 *   2. Add the new public key to this list with `activeUntil = undefined`
 *      (always-active) and a fresh `kid`.
 *   3. Old keys keep their `kid` and gain a finite `activeUntil` set to
 *      "issuance horizon + grace period" — usually 90 days.
 *   4. Ship a Core release. Once all in-flight licenses have rotated,
 *      remove the retired entry.
 */

import type { ActivePublicKey } from './types';

/**
 * Production public keys. Empty until PRO-007 lands.
 *
 * Each entry must be created by importing the raw 32-byte Ed25519
 * public key via:
 *
 *   const key = await crypto.subtle.importKey(
 *     'raw',
 *     base64UrlDecode('<key-bytes>'),
 *     { name: 'Ed25519' },
 *     false,
 *     ['verify'],
 *   );
 *
 * because `CryptoKey` cannot be expressed as a literal.
 */
export const ACTIVE_PUBLIC_KEYS: ReadonlyArray<ActivePublicKey> = [];

/**
 * Lazy resolver for callers that want a single source of truth without
 * importing both the constant and the `ActivePublicKey` type. Returns
 * the same array each call — do not mutate.
 */
export function getActivePublicKeys(): ReadonlyArray<ActivePublicKey> {
  return ACTIVE_PUBLIC_KEYS;
}
