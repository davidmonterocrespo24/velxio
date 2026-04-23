/**
 * Public types for offline plugin license verification.
 *
 * These shapes are the wire contract between Pro's license issuer
 * (PRO-007) and the Core's verifier. Pro must produce JSON exactly
 * matching `LicenseToken` and sign the **canonical** JSON bytes (see
 * `verify.ts` for the canonicalization rule).
 */

/**
 * Bumped any time the payload shape changes incompatibly. The verifier
 * only accepts payloads with `v: 1`.
 */
export const LICENSE_TOKEN_SCHEMA_VERSION = 1 as const;

export interface LicenseTokenV1 {
  /** Always equal to {@link LICENSE_TOKEN_SCHEMA_VERSION}. */
  readonly v: 1;
  readonly pluginId: string;
  /**
   * Semver range the license is valid for. `^1.0.0` covers every 1.x.y;
   * a single `"1.2.3"` only covers that exact version.
   *
   * Supported ranges: exact (`"1.2.3"`), caret (`"^1.2.3"`), tilde
   * (`"~1.2.3"`), wildcard (`"1.x"`, `"1.2.x"`, `"*"`).
   */
  readonly pluginVersion: string;
  /** UUID of the buyer. */
  readonly userId: string;
  readonly kind: 'one-time' | 'subscription' | 'trial' | 'free';
  /** ISO-8601 timestamp. Required for `subscription` and `trial`. */
  readonly expiresAt?: string;
  readonly issuedAt: string;
  /** Whether the license can be used on multiple devices of the same user. */
  readonly transferable: boolean;
  /** Reserved for future use (organization seats, env hints). */
  readonly meta?: Readonly<Record<string, string>>;
}

export type LicenseToken = LicenseTokenV1;

/**
 * The full license envelope as Pro serves it. `sig` is the base64url
 * encoding of the Ed25519 signature over the canonical JSON of `payload`.
 *
 * `kid` ("key id") names which signing key was used so the verifier can
 * pick the right public key without trying every active key. Optional
 * — when absent the verifier tries every active key in turn.
 */
export interface SignedLicense {
  readonly payload: LicenseToken;
  readonly sig: string;
  readonly kid?: string;
}

/**
 * Why a license was rejected. Names are stable strings — UI maps them
 * to localized error messages.
 */
export type LicenseVerifyReason =
  | 'malformed'
  | 'unknown-kid'
  | 'bad-signature'
  | 'wrong-user'
  | 'wrong-plugin'
  | 'wrong-version'
  | 'expired'
  | 'revoked';

export type LicenseVerifyResult =
  | { readonly ok: true; readonly license: LicenseToken }
  | { readonly ok: false; readonly reason: LicenseVerifyReason; readonly detail?: string };

/**
 * One entry in the verifier's active-keys list. Multiple entries enable
 * key rotation: a freshly-rotated public key is added at the front, and
 * the old key stays in the list with `activeUntil` so already-issued
 * licenses keep verifying for a documented grace window.
 */
export interface ActivePublicKey {
  readonly kid: string;
  /** Imported `CryptoKey` ready for `crypto.subtle.verify`. */
  readonly key: CryptoKey;
  /** ISO-8601. Verifier rejects this key after that timestamp. */
  readonly activeUntil?: string;
}
