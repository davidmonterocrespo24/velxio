# Plugin licensing — offline Ed25519 verification

> **Audience.** Anyone touching the Velxio Pro marketplace plumbing on the
> Core side: the plugin loader (CORE-007), the "Installed Plugins" UI
> (CORE-008), and any future code path that has to decide whether a paid
> plugin is allowed to load right now.

This doc describes the **client-side** half of the licensing system: how
Core takes a signed token from Pro, decides whether to trust it, and
under what conditions it rejects. The Pro server-side half (key
generation, token issuance, denylist publication) is owned by `PRO-007`
and is out of scope here — this doc treats Pro as a black box that
produces tokens signed with a known private key.

## Goals

1. **Offline-first.** Once a license is downloaded, verification must
   work with zero network. Educational deployments often run without
   Internet for hours at a time.
2. **Tamper-evident.** A user (or an attacker who compromised the Pro
   database) cannot grant themselves a paid plugin by editing a token —
   the signature would no longer validate against the embedded public
   key.
3. **Fail-closed.** Any structural ambiguity, unknown signing key, or
   parse error rejects the license. There is no "accept on doubt" path.
4. **Cheap to call.** Verification runs on the plugin loader hot path,
   so the chain bails out early on cheap structural checks before
   spending a `crypto.subtle.verify` call.
5. **Rotatable without code redeploys for grace-period keys.** When a
   key is rotated, we keep the old public key in the active list with a
   finite `activeUntil` until all in-flight tokens have rolled over.

## Wire format

```ts
interface SignedLicense {
  payload: LicenseTokenV1;
  /** base64url(Ed25519(canonicalJsonStringify(payload), privateKey)). */
  sig: string;
  /** Optional key-id hint. When present, only the matching active key is tried. */
  kid?: string;
}

interface LicenseTokenV1 {
  v: 1;
  pluginId: string;
  /** semver range — e.g. "^1.0.0" or "1.2.3". The version the loader is
   *  about to instantiate must satisfy this range. */
  pluginVersion: string;
  userId: string;
  kind: 'one-time' | 'subscription' | 'trial' | 'free';
  /** ISO 8601. REQUIRED for kind ∈ { subscription, trial }. */
  expiresAt?: string;
  /** ISO 8601. */
  issuedAt: string;
  /** When false, the license is bound to the device that first
   *  activated it (out of scope for this verifier — the Pro server
   *  decides at issuance time). */
  transferable: boolean;
  /** Reserved for future fields (organization, seats, ...). */
  meta?: Record<string, string>;
}
```

The verifier exists in `frontend/src/plugins/license/`. Public surface
re-exported from `index.ts`:

```ts
import {
  verifyLicense,
  type SignedLicense,
  type LicenseVerifyResult,
  type ActivePublicKey,
} from '@/plugins/license';
```

## The verification chain

`verifyLicense(signed, opts)` is a single async function whose body is
an early-rejecting chain. Steps run in this order so the cheapest check
disqualifies first:

| # | Check                                  | Reject reason     |
|---|----------------------------------------|-------------------|
| 1 | Structural validation (`v: 1`, fields) | `malformed`       |
| 2 | `expectedPluginId` match               | `wrong-plugin`    |
| 3 | `expectedUserId` match                 | `wrong-user`      |
| 4 | `pluginVersion` semver range satisfied | `wrong-version`   |
| 5 | `expiresAt + grace` (only subs/trial)  | `expired`         |
| 6 | `jti` against denylist                 | `revoked`         |
| 7 | `kid` resolution against active keys   | `unknown-kid`     |
| 8 | `crypto.subtle.verify('Ed25519', …)`   | `bad-signature`   |

**The verifier never throws on bad input.** Every reject is a typed
discriminated-union result `{ ok: false; reason; detail? }`. The only
case that throws is a caller-side bug — e.g., `crypto.subtle` missing in
the host (which on browser targets means a misconfigured test harness,
not a runtime concern).

### Why an early structural pass

Without it, malformed payloads would reach `crypto.subtle.verify`,
which is expensive and async. Empirically the cheap path rejects
~99% of fuzzed inputs without spending a verify call.

### Why a 24-hour grace window

The `expiresAt + grace` check uses a default `graceMs = 24 * 60 * 60 *
1000`. We absorb mildly-skewed system clocks so educational deployments
without NTP do not lose access on the boundary day. The window is
configurable per call (`graceMs: 0` to disable). The Pro server should
mirror the same grace when issuing renewals so the boundary is
symmetric.

### Why the denylist (`jti`) check sits before signature verification

Revocations come from the operator (Pro support refunded the user, or
flagged the token), and they should win even when the signature is
valid. Putting the denylist before the (expensive) signature check is a
free perf win — but more importantly it makes the semantics
unambiguous: a revoked token is dead, period.

The default `jtiOf(signed) = signed.sig` exploits the fact that an
Ed25519 signature is unique per issuance — there is no need to mint a
separate JTI. Callers can pass a custom `jtiOf` if Pro starts emitting
explicit identifiers later.

### Why canonical JSON

Pro and Core each have to compute the byte sequence that was signed.
`JSON.stringify` is not portable across implementations (object
property order is engine-defined), so we ship a tiny canonical
serializer at `canonicalize.ts`:

- Object keys sorted lexicographically at every nesting level.
- `undefined` properties dropped.
- Non-finite numbers (`NaN`, `Infinity`) and unsupported types
  (functions, BigInt, symbols) throw.

This is a strict subset of RFC 8785 (JSON Canonicalization Scheme).
We do not need the full JCS spec because our payload schema is fixed
and contains only strings, booleans, finite numbers, plain objects, and
arrays.

### Why an in-house semver subset

`pluginVersion` is checked against the loader's exact target version
using a tiny semver implementation at `semver.ts`. We support:

- exact (`1.2.3`, `=1.2.3`)
- caret (`^1.2.3`) — with the npm 0.x special-cases:
  `^0.2.x` locks minor, `^0.0.3` locks patch
- tilde (`~1.2.0`) — locks minor
- wildcard (`*`, `1.x`, `1.2.x`)

We deliberately do **not** support pre-release labels, build metadata,
hyphen ranges, or `||` unions. Plugin versions are produced by Pro at
publish time and are guaranteed to be plain `MAJOR.MINOR.PATCH`. Adding
a real semver dependency would balloon the bundle for no gain.

## Key rotation

### The active-keys list

`verifyLicense` takes `publicKeys: ReadonlyArray<ActivePublicKey>`. Each
entry carries `{ kid, key, activeUntil? }`:

- `kid` — short string ID. The Pro server stamps this on every token it
  issues so Core can pick the right key in O(1).
- `key` — a `CryptoKey` imported via
  `crypto.subtle.importKey('raw', bytes, { name: 'Ed25519' }, false, ['verify'])`.
- `activeUntil` (optional, ISO 8601) — when set, the key is only
  considered active up to that timestamp. Past it, it is filtered out
  before signature verification.

**When a token has a `kid`**, only the matching entry is tried. If no
active key matches, the verifier returns `unknown-kid` without any
crypto work.

**When a token has no `kid`**, the verifier tries every active key in
order and accepts the first that validates. This is the path used for
legacy tokens issued before kid-stamping was introduced.

### Rotation procedure

1. Generate a fresh Ed25519 keypair on the Pro server (one-shot).
2. Add the new public key to `frontend/src/plugins/license/publicKey.ts`
   with `activeUntil: undefined` and a fresh `kid`.
3. Add a finite `activeUntil` to the previous key — typically
   `now + 90 days` (matches the longest issuance horizon for trial
   licenses plus the 24-hour grace window).
4. Ship a Core release. The release notes should mention that all
   tokens issued before the new key cut over remain valid for 90 days.
5. After the grace window, remove the retired entry in a follow-up
   release.

### Kill-switch

If a private key is ever exposed, the response is to:

1. Set `activeUntil` on the compromised key to `now - 1ms` (or simply
   delete the entry) and ship.
2. Add every JTI issued under that key to the denylist published at
   `/api/marketplace/license-denylist.json`. Until Core picks up the
   updated denylist (next 24h cycle), the disabled key path already
   blocks new validations.

## Status of the production keys

`publicKey.ts` ships with `ACTIVE_PUBLIC_KEYS = []`. There is no
hardcoded production key in the OSS repo until `PRO-007` lands the
keypair generator and the operations runbook. Until then:

- The verifier API is fully exercised by tests that pass their own
  freshly-generated keypairs (`license-verify.test.ts`).
- Production code paths that try to verify without supplying
  `publicKeys` will hit the `unknown-kid` reject reason — the correct
  fail-closed default.

When real keys are introduced, embed them as base64url strings and
import them lazily via `crypto.subtle.importKey('raw', …)` — `CryptoKey`
cannot be expressed as a literal.

## Integration points

This module is independent of the plugin loader. The loader is expected
to call `verifyLicense` immediately before instantiating a paid plugin's
worker:

```ts
const result = await verifyLicense(signedLicense, {
  publicKeys: ACTIVE_PUBLIC_KEYS,
  expectedPluginId: manifest.id,
  expectedUserId: currentUser.id,
  pluginVersion: manifest.version,
  denylist: marketplaceStore.denylist?.revokedTokens,
});
if (!result.ok) {
  reportLicenseFailure(manifest.id, result.reason, result.detail);
  return;
}
```

The denylist comes from `useMarketplaceStore` (CORE-010) — the
`MarketplaceClient.getDenylist()` call already fetches and caches it.

CORE-008 owns the user-facing copy for each reject reason (`expired` →
"Renew", `bad-signature` → "Contact support", etc.). The verifier
returns the typed `reason` so the UI can branch without parsing strings.

## What this layer does NOT do

- **License acquisition.** Tokens are downloaded by the marketplace
  store via authenticated HTTP. Buying a plugin is a Pro UI flow (out
  of repo).
- **Plugin loading.** The verifier is a guard called by the loader; it
  does not load anything itself.
- **Billing.** Refunds, subscription renewals, and seat management live
  on Pro. The Core receives the result of those decisions encoded as
  signed tokens (or as denylist entries).
- **License migration.** The `v: 1` schema check rejects future-versioned
  tokens. A future `v: 2` will require a separate verifier path; we
  prefer that over silently extending the schema and risking
  signature-stability bugs.

## Tests

| File                                         | What it covers                               |
|----------------------------------------------|----------------------------------------------|
| `__tests__/license-semver.test.ts`           | parseVersion, satisfies (15 tests)           |
| `__tests__/license-canonicalize.test.ts`     | canonicalJsonStringify contract (7 tests)    |
| `__tests__/license-verify.test.ts`           | end-to-end verifier (19 tests)               |

`license-verify.test.ts` generates real Ed25519 keypairs via
`crypto.subtle.generateKey({ name: 'Ed25519' }, …)` and signs payloads
the same way Pro will, so the round-trip is exercised against the same
canonical-JSON encoder. There are no mocks in the crypto path.
