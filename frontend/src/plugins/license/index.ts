/**
 * Public barrel for the offline license verifier.
 *
 * Consumers (the plugin loader, eventually CORE-008's UI) import only
 * from here. The internal split (`semver`, `canonicalize`, `base64url`)
 * is implementation detail.
 */

export { verifyLicense, type VerifyLicenseOptions } from './verify';

export {
  LICENSE_TOKEN_SCHEMA_VERSION,
  type ActivePublicKey,
  type LicenseToken,
  type LicenseTokenV1,
  type LicenseVerifyReason,
  type LicenseVerifyResult,
  type SignedLicense,
} from './types';

export { satisfies as semverSatisfies, parseVersion, compareVersions } from './semver';

export { canonicalJsonStringify } from './canonicalize';

export { base64UrlEncode, base64UrlDecode } from './base64url';

export { ACTIVE_PUBLIC_KEYS, getActivePublicKeys } from './publicKey';
