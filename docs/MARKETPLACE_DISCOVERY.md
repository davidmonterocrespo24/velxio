# Marketplace discovery (CORE-010)

The open-source Velxio Core does not know about the Pro marketplace at
build time. It **discovers** Pro at runtime by probing
`/.well-known/velxio-marketplace.json`. This file documents the
discovery contract, the runtime states, and the rules the Core enforces
to keep itself decoupled from Pro.

## Why a discovery doc

Three constraints had to be satisfied at once:

1. **Self-host parity**: anyone running Velxio without Pro must get a
   first-class experience, including manually-installed plugins.
2. **No hardcoded URLs**: the Core can't ship hardcoded
   `https://api.velxio.dev/...` strings in its source — that's tight
   coupling and breaks staging environments.
3. **Capability advertisement**: Pro might enable `installs` but disable
   `purchases` (e.g. an enterprise deployment). The Core needs to know
   which UI surfaces to render.

A `/.well-known/` doc satisfies all three: it is the standard pattern
for capability discovery (OAuth2, OIDC, ActivityPub), it lives at a
predictable path, and the response is cacheable + versioned.

## Wire format

```jsonc
// GET https://api.velxio.dev/.well-known/velxio-marketplace.json
{
  "schemaVersion": 1,
  "apiBaseUrl": "https://api.velxio.dev",
  "name": "Velxio Marketplace",
  "features": {
    "installs": true,
    "licenses": true,
    "denylist": true,
    "purchases": true
  },
  "purchaseUrlTemplate": "https://velxio.dev/marketplace/{slug}/buy"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `schemaVersion` | Yes | Must equal `MARKETPLACE_DISCOVERY_SCHEMA_VERSION` (currently `1`). Anything else → `unavailable / malformed-metadata`. |
| `apiBaseUrl` | Yes | Absolute `http(s)` URL the Core uses for `/api/marketplace/...`. Must pass `^https?://` regex. |
| `name` | No | Human-readable label. |
| `features.*` | No | When set to `false` the Core hides that surface entirely. Missing flag = enabled. |
| `purchaseUrlTemplate` | No | Used by the editor's "Buy" button — Core opens the URL in a new tab, never processes payment itself. |

The Core does **not** require `Content-Length`, but it caps the response
at **64 KB** and any larger payload is rejected as `malformed-metadata`.
Data endpoints have a separate **4 MB** cap.

## Endpoints

After a successful probe, the Core knows three URLs:

| URL | Auth | Purpose | Owned by |
|-----|------|---------|----------|
| `${apiBaseUrl}/api/marketplace/me/installs` | Cookie | List of installed plugins for the signed-in user | PRO-003 |
| `${apiBaseUrl}/api/marketplace/me/licenses` | Cookie | License tokens for paid plugins | PRO-007 |
| `${apiBaseUrl}/api/marketplace/license-denylist.json` | Public | Revoked tokens + banned plugin IDs | PRO-007 |

Auth is the same Velxio Core cookie — Pro is expected to share the
session via subdomain cookie scope (`.velxio.dev`). CORS preflight on
`api.velxio.dev` must whitelist the Core origin.

## Status state machine

```
                  initialize()                  refresh()
   idle ──────────────────────► probing ─────────► probing
                                  │                  │
                          probe   │                  │
                                  ▼                  ▼
       ┌──────────► available ◄───────────────────► available
       │              │                                │
       │              ├─ getInstalls   ─► InstalledRecord[]
       │              ├─ getLicenses   ─► LicenseRecord[]
       │              └─ getDenylist   ─► LicenseDenylist
       │
       └─── unavailable
                │
       reasons: disabled | not-found | network |
                http-error | malformed-metadata
```

`MarketplaceClient.probe()` **never throws** on transport-layer issues —
every network failure or schema mismatch becomes a typed
`unavailable` status. Data-fetch methods only throw
`MarketplaceUnavailableError` when called against a non-`available`
status (caller bug) or `MarketplaceAuthRequiredError` on 401/403 (user
not signed in to Pro yet).

`useMarketplaceStore` orchestrates the probe and follows it with a
`Promise.allSettled` over the three data endpoints. `authRequired`
goes true if any authenticated endpoint returned 401 — the editor uses
this to render a "Sign in to Pro" CTA without disabling the rest of the
marketplace UI (the public denylist still loads).

## Configuration

| Env var | Behaviour |
|---------|-----------|
| **unset** | Default to `https://api.velxio.dev`. This is what the public hosted Core uses. |
| `VITE_VELXIO_MARKETPLACE_BASE_URL=https://staging.api.velxio.dev` | Probe staging instead. |
| `VITE_VELXIO_MARKETPLACE_BASE_URL=` (empty) | **Fully disable** the marketplace. Status pinned to `unavailable / disabled`. No HTTP requests are made. Self-hosters who don't want Core pinging velxio.dev set this. |

A typo (e.g. setting the var to `false`) produces a non-empty string and
will still cause the Core to probe — only the literal empty string
disables. This is intentional: silent disabling on typo is worse than a
visible failed probe.

## What this layer does NOT do

- **License verification.** The denylist tells you a token is revoked,
  but actually verifying a signed token is CORE-009.
- **Plugin loading.** This layer is data fetch only. The plugin loader
  (CORE-007) consumes `installs[]` to drive its `loadInstalled()` call.
- **Payment processing.** The Core opens
  `purchaseUrlTemplate` in a new tab and Pro handles checkout.
- **UI rendering.** The "Marketplace" panel + "Installed Plugins" panel
  consume `useMarketplaceStore` but live in CORE-008 / Pro UI tasks.

## Test surfaces

- `frontend/src/__tests__/marketplace-config.test.ts` — env-var
  resolution edge cases.
- `frontend/src/__tests__/marketplace-client.test.ts` — probe transport
  matrix (404, 5xx, network, malformed JSON, oversized body, schema
  mismatch, non-http baseUrl) plus per-endpoint behaviour (cookies,
  401, feature flags, payload validation).
- `frontend/src/__tests__/marketplace-store.test.ts` — end-to-end with
  stub clients: idle → probing → available, disabled short-circuit,
  401 surfaces `authRequired`, concurrent `initialize()` coalesces,
  `refresh()` re-probes, `reset()` clears.

## Wiring example

```ts
// frontend/src/main.tsx
import { useMarketplaceStore } from './store/useMarketplaceStore';

// After auth bootstrap:
void useMarketplaceStore.getState().initialize();
```

Components subscribe with the standard Zustand selector:

```tsx
const status = useMarketplaceStore((s) => s.status);
const authRequired = useMarketplaceStore((s) => s.authRequired);

if (status.kind === 'unavailable' && status.reason === 'disabled') {
  return null; // self-host, hide the entire marketplace surface
}
```
