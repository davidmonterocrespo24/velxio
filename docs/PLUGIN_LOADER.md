# Plugin Loader (cache + integrity + retry)

The loader is the glue between *"the Pro backend says these plugins
are installed"* and *"these Workers are running"*. It owns three
concerns:

1. **Cache** — bundle bytes in IndexedDB, keyed by `(id, version)`,
   so editor cold start with N installed plugins is one warm read per
   plugin, not N CDN round-trips.
2. **Integrity** — every byte stream is verified against the SHA-256
   declared in the manifest **before** it touches the cache or the
   `PluginManager`. A tampered bundle never enters the cache and
   never spawns a Worker.
3. **Retry** — CDN flakes get exponential backoff (3 attempts, full
   jitter); permanent 4xx aborts immediately; `408` and `429` are
   treated as transient.

It lives at `frontend/src/plugins/loader/`:

| File | Responsibility |
|---|---|
| `BundleVerifier.ts` | `computeBundleHash` + `verifyBundleHash` (SHA-256, `BundleIntegrityError`) |
| `PluginCache.ts` | IndexedDB wrapper, GC, prune-versions, swappable `MemoryCacheBackend` for tests |
| `BundleFetcher.ts` | `fetchBundle(id, version)` with retries, dev-server fallback, abort timeout |
| `PluginLoader.ts` | Orchestrator: cache → fetch → verify → `PluginManager.load`, GC after batch |
| `index.ts` | Public barrel |

---

## Flow

```
┌────────────────── PluginLoader.loadInstalled([…]) ───────────────────┐
│                                                                      │
│  for each plugin in parallel (Promise.allSettled):                   │
│    ┌─────────────────────────────────────────────────────────────┐   │
│    │ 0. license gate (CORE-007b — runs FIRST, fail-closed)       │   │
│    │     ├─ pricing.model === 'free' → bypass                    │   │
│    │     ├─ no resolver / no token   → 'license-failed'          │   │
│    │     ├─ anonymous user           → 'license-failed'          │   │
│    │     └─ verifyLicense reject     → 'license-failed'          │   │
│    │ 1. cache.get(id, version)                                   │   │
│    │     ├─ hit + hash matches manifest  → use cached bytes      │   │
│    │     ├─ hit + hash drift             → treat as miss         │   │
│    │     └─ miss                         → step 2                │   │
│    │ 2. fetchBundle(id, version)                                 │   │
│    │     ├─ dev shortcut (localhost only)                        │   │
│    │     ├─ retries on 5xx / 408 / 429                           │   │
│    │     ├─ abort on 4xx                                         │   │
│    │     └─ network exhausted → outcome = 'offline'              │   │
│    │ 3. verifyBundleHash(bytes, manifest.bundleHash)             │   │
│    │     └─ mismatch → outcome = 'failed', cache unchanged       │   │
│    │ 4. cache.put(id, version, …)                                │   │
│    │ 5. manager.load(manifest, { bundleUrl: blob:URL })          │   │
│    │     ├─ resolves → outcome = 'active'                        │   │
│    │     └─ throws  → outcome = 'failed'                         │   │
│    │ 6. revoke blob URL                                          │   │
│    └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  cache.gc({ keep: <currently active id:version pairs> })             │
└──────────────────────────────────────────────────────────────────────┘
```

The gate sits at step 0 on purpose: a paid plugin without a valid
license should never burn CDN bandwidth, never touch the cache, never
spawn a worker. See *License gate* below for the full reason matrix.

The orchestration runs **concurrently per plugin** — a slow CDN for
plugin A does not block plugin B. A per-plugin failure surfaces in
its `LoadOutcome` rather than throwing at the top.

## Outcome statuses

| status | Meaning | Plugin running? |
|---|---|---|
| `active` | Verified, cached, manager.load resolved | Yes |
| `failed` | Either integrity mismatch or `manager.load` threw | No |
| `offline` | CDN unreachable AND no cached copy | No |
| `disabled` | `enabled: false` in installed entry — skipped on purpose | No |
| `license-failed` | License gate rejected — see `licenseReason` for the cause | No |

Each outcome also carries `source` (`cache`/`cdn`/`dev`), `cacheHit`,
`fetchAttempts`, and `elapsedMs` for diagnostics in the *Installed
Plugins* panel (CORE-008). On `license-failed`, `licenseReason` is the
typed cause (`no-license`, `not-authenticated`, `wrong-plugin`,
`wrong-user`, `wrong-version`, `expired`, `revoked`, `bad-signature`,
`unknown-kid`, `malformed`) so the UI can render the right copy + CTA
without parsing prose.

## Cache GC

`PluginCache.gc({ keep })` evicts oldest-first by `cachedAt` until
total bytes fit `maxBytes` (default 100 MB), but **never evicts a key
in `keep`**. The loader passes the set of currently-active
`id:version` pairs after each batch, so the cache always has at least
the bundles for plugins the user just loaded.

`pruneVersions(id, keep)` is a separate hook called when a plugin is
upgraded or uninstalled — it drops every cached version of that id
except the keepers, freeing bytes immediately rather than waiting for
GC pressure.

## Integrity verification — defense in depth

Two checkpoints fire SHA-256 on every byte stream:

1. **Loader (this file)** — checks bytes against the manifest before
   they enter the cache. Test: `plugin-loader.test.ts > integrity
   mismatch ends with failed and does not poison the cache`.
2. **Worker (`pluginWorker.ts`)** — re-checks the bundle URL
   contents against the `integrity` field on the init message before
   `import()`. Belt-and-braces: a corrupted IDB read or a malicious
   blob: URL would still fail.

Both call `verifyBundleHash` from `BundleVerifier.ts`. There is no
runtime cost to the worker check beyond one digest of the same bytes
the worker is about to import anyway.

## Dev server fallback

When the editor is on `localhost`, `fetchBundle` tries
`http://localhost:5180/plugins/<id>/bundle.mjs` first. This is the
URL `velxio-plugin dev` (SDK-009) serves the author's working copy
on. Any failure (404, network) silently falls through to the CDN.

The behaviour is opt-out (`preferDevServer: false` in
`BundleFetchOptions`) for users who run the editor locally but don't
want any HTTP-to-localhost traffic.

## License gate (CORE-007b)

The gate is a thin wrapper around `verifyLicense` (CORE-009). It pulls
its inputs through a **`LicenseResolver`** interface so the loader does
not import Zustand stores directly:

```ts
interface LicenseResolver {
  getLicense(pluginId: string): SignedLicense | null;
  getUserId(): string | null;
  getPublicKeys(): ReadonlyArray<ActivePublicKey>;
  getDenylist(): ReadonlySet<string> | undefined;
}
```

Two implementations ship with the loader:

| Factory | Source of truth | Use case |
|---|---|---|
| `defaultLicenseResolver()` | `useMarketplaceStore` + `useAuthStore` + `ACTIVE_PUBLIC_KEYS` | Production wiring at editor startup |
| `inMemoryLicenseResolver({ licenses, userId, publicKeys, denylist })` | Constructor inputs | Tests + dev-mode mocking of paid plugins |

### Resolution order (every reject is fail-closed)

| # | Condition | Outcome |
|---|---|---|
| 1 | `manifest.pricing.model === 'free'` (or absent) | bypass — gate never runs |
| 2 | No `licenseResolver` injected, plugin is paid | `license-failed / no-license` |
| 3 | Resolver returns `null` for the plugin id | `license-failed / no-license` |
| 4 | Resolver returns `userId === null` (anonymous) | `license-failed / not-authenticated` |
| 5 | `verifyLicense` returns `{ ok: false, reason }` | `license-failed / <reason>` |
| 6 | `verifyLicense` returns `{ ok: true }` | proceed to step 1 (cache) |

**Why `not-authenticated` is distinct from `wrong-user`:** the UI
prompts to sign in, not "this license belongs to another account".
Different copy, different CTA.

**Why fail-closed when no resolver is injected:** a deployment that
wires the loader without the resolver is a configuration bug. We'd
rather every paid plugin show the same visible failure than silently
let unlicensed plugins run.

**Why the gate runs before the cache lookup:** `license-failed` should
be the cheapest possible reject. A revoked or expired license must
never trigger a CDN fetch (egress cost) or worker spawn (memory + CPU).

### Token wire format

`LicenseRecord.token` (the string Pro hands to the Core) is parsed by
`defaultLicenseResolver` as **JSON-encoded `SignedLicense`**:

```json
{
  "payload": { "v": 1, "pluginId": "...", "pluginVersion": "^1.0.0", ... },
  "sig": "base64url",
  "kid": "k1"
}
```

A malformed token is treated as `no-license` (parse-fail = no token).
PRO-007 will lock the canonical encoding in its issuer specification.

## Pause-on-expiry timer (CORE-008c)

The license gate runs only at **load time**. A subscription that
expires *while the editor is open* would otherwise stay usable until
the next page reload. The loader closes that gap by arming a
`setTimeout` for any plugin whose license carries a future
`expiresAt`. When the timer fires, the loader calls
`PluginManager.pause(id, 'license-expired')` — the worker stays alive
(renewing + `manager.resume(id)` is O(1) and avoids a re-`import()`),
but the entry's `status` flips to `'paused'` so the UI surfaces the
expired state with a "Renew" CTA.

```
loadOne success ──► armExpiryTimer(id)
                          │
                          ├── licenseResolver.getLicense(id).payload.expiresAt
                          │       (undefined → no timer; perpetual / free)
                          │
                          ▼
                     scheduleExpiryStep(id, expiryMs)
                          │
                          ├── remaining ≤ 0 → manager.pause('license-expired') (sync)
                          │
                          └── setTimeout(min(remaining, 24 h), …)
                                     │
                                     ▼
                                fires → recompute now
                                     ├── still pre-expiry → re-arm
                                     └── reached         → manager.pause(…)
```

### Why 24-hour chunks

Browsers clamp `setTimeout` values larger than `2^31 − 1` ms (~24.8
days) to immediate firing. To keep the contract intuitive for
multi-month subscriptions, every arm is capped at
`MAX_TIMER_DELAY_MS = 24h` and re-arms itself in the callback. The
24-hour cadence also dovetails with the modal's denylist refresh
interval (CORE-008b), so a freshly-revoked token gets caught either
way without us shipping two parallel timers.

### Cleanup

The loader subscribes to the manager once (lazily, on first arm) and
sweeps its timer map on every notify. Any id whose entry is
`unloaded` / `failed` / missing has its pending timer cancelled — so
explicit `manager.unload(id)` from the Installed Plugins panel never
results in a late `pause()` against a dead worker.

`loader.dispose()` clears every pending timer and unsubscribes from
the manager. Production wiring keeps the loader alive for the page
lifetime, but tests call `dispose()` between specs.

### Soft pause vs hard pause

`PluginManager.pause()` is a **soft** pause: it flips status and
notifies subscribers, but does not freeze the worker's RPC channel.
Already-registered host disposables (commands, panels, event
subscriptions) keep firing. This is enough for the licensing flow —
the user renews, the marketplace refresh wakes the row, and
`useInstalledPluginsStore.toggleEnabled` re-routes through
`PluginLoader.loadOne()` which arms a fresh timer.

A **hard** pause (RPC freeze, drop pending callbacks, gate `pin:change`
forwarding) is deferred to **CORE-006b** because it requires a
`pause`/`resume` round-trip the worker runtime does not yet implement.

## Update detection (SDK-008d)

`PluginLoader.checkForUpdates(installed, opts)` is the autonomous
drift detector. The Installed Plugins modal calls it on mount and
on the same 24h cadence as the denylist refresh — we share the
cadence because no realistic release schedule moves faster.

The loader runs a `Promise.allSettled` fan-out over `installed`. Per
plugin (`checkOne`):

1. `await opts.getLatestManifest(id)` → `null` ends with
   `decision: 'no-manifest'` (silent skip — without permissions we
   cannot classify a diff). Throw ends with `decision: 'error'`.
2. `latest.version === installed.version` → `'no-drift'`.
3. `opts.isVersionSkipped(id, latest.version)` → `'skipped'`. The
   user already declined this exact version; a strictly newer
   release will re-evaluate.
4. **Pre-classify locally** with
   `classifyUpdateDiff(diffPermissions(old, new))` from
   `@velxio/sdk/permissions-catalog`. If the result is
   `'requires-consent'`, return immediately. **The loader never
   mounts the consent dialog from a background tick** — that would
   queue dialogs for ten plugins and steal focus. The badge UI in
   the Installed Plugins panel handles the user-triggered click.
5. Auto-approve paths (`'auto-approve'` and
   `'auto-approve-with-toast'`): hand off to
   `installFlowController.requestUpdate()` so the toast sink fires
   uniformly, then `manager.unload(id)` + `loadOne(next)` to swap
   the worker. `InstallFlowBusyError` maps to `decision: 'busy'`
   (try again next tick); other throws map to `'error'`.

`UpdateCheckOutcome` carries the typed `decision`, `installedVersion`,
optional `latestVersion`, optional `reload: LoadOutcome` (only when
the loader actually reloaded), and an optional `error: { name, message }`
for `'error'` paths.

Headless / test setups can omit the controller — the loader proceeds
with `{ kind: 'updated' }` so the auto-reload path still runs without
emitting toasts.

```ts
const outcomes = await loader.checkForUpdates(installed, {
  getLatestManifest: (id) => fetchCatalogManifest(id),  // PRO-003
  isVersionSkipped: (id, v) => store.isVersionSkipped(id, v),
});
```

The store-side adapter is `useInstalledPluginsStore.checkForUpdates()`
— it builds the `InstalledPlugin[]` from
`useMarketplaceStore.installs` + the per-id manifest cache populated
by the manager subscription, then forwards to the loader. It returns
`[]` (silent no-op) when no loader, no resolver, or no
`getLatestManifest` is wired — production today has the latter
absent, pending PRO-003.

## Wiring at editor startup

```ts
import { PluginLoader } from '@/plugins/loader';
import { getPluginManager } from '@/plugins/runtime';

// One-time: configure the manager with production worker factory + services
getPluginManager().configure({ factory, services });

// On editor mount, after the user is authenticated:
const installed = await fetchInstalledPlugins(); // from Pro backend (PRO-003)
const loader = new PluginLoader({
  licenseResolver: defaultLicenseResolver(), // wires CORE-007b license gate
});
const outcomes = await loader.loadInstalled(installed);

// outcomes feeds the Installed Plugins UI (CORE-008)
```

## Test seam

Production uses the IDB-backed `PluginCache`. Tests inject
`MemoryCacheBackend`:

```ts
const cache = new PluginCache({ backend: new MemoryCacheBackend() });
```

Production calls the real `fetch`. Tests inject `fetchImpl`:

```ts
const loader = new PluginLoader({
  cache,
  fetchOptions: { fetchImpl: stubFetch, preferDevServer: false, baseDelayMs: 1 },
  manager: stubManager,
});
```

This is enough to drive the six test files (`plugin-loader-*.ts`,
56 tests total) without touching the network or IndexedDB. The
`plugin-loader-license-gate.test.ts` and
`plugin-loader-pause-on-expiry.test.ts` files use the host's real
`crypto.subtle` (jsdom in Node 20+) to generate Ed25519 keypairs and
sign payloads end-to-end — no key material is mocked.

## What this layer does NOT do

- **Issue or sign licenses.** Pro's issuer (PRO-007) is the only
  signer; the loader is the *consumer*. The verifier itself
  (CORE-009) is also not in this folder — `BundleFetcher` and
  `BundleVerifier` are; license verification lives at
  `frontend/src/plugins/license/`.
- **Manifest fetch.** The `manifest` is part of `InstalledPlugin`;
  the Pro backend serves it. The loader does not parse marketplace
  metadata.
- **Per-plugin egress accounting / rate limit.** That is CORE-006b.
- **License renewal flows / pause-on-expire timers / per-reason copy.**
  Those belong to the Installed Plugins UI (CORE-008b). The loader
  surfaces the typed `licenseReason`; copy + CTA live in the panel.
- **UI rendering.** The loader returns plain `LoadOutcome[]` — the
  *Installed Plugins* panel (CORE-008) renders them.
