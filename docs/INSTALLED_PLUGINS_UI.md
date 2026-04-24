# Installed Plugins UI

> **Audience.** Anyone touching the `<InstalledPluginsModal />` panel,
> the `useInstalledPluginsStore` join layer, or the upstream stores it
> consumes (`PluginManager`, `useMarketplaceStore`).

The Installed Plugins panel is the user's entry point for inspecting,
toggling, and uninstalling the plugins they own. It is **read-only over
two upstream sources of truth**, plus three side-effects (toggle,
uninstall, refresh). It does not hold plugin state itself — it is a
projection.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│   <InstalledPluginsModal />     (thin React render)              │
│   ├─ <PluginRow />              (per-row layout + actions)       │
│   ├─ <UninstallConfirm />       (destructive op gate)            │
│   ├─ <PluginSettingsDialog />   (placeholder; SDK-006b owns the  │
│   │                              real schema-driven form)        │
│   ├─ <MarketplaceBanner />      (auth/network state hint)        │
│   └─ <EmptyState />                                              │
└──────────────────────────────────────────────────────────────────┘
                          │
                          │ getRows() · toggleEnabled · uninstall · refresh
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│   useInstalledPluginsStore  (Zustand, JOIN LAYER)                │
│   ─ holds: busyIds, lastError, localDisabled, localUninstalled   │
│   ─ getRows() = join(installs, entries, licenses,                │
│                       localDisabled, localUninstalled)           │
└──────────────┬─────────────────────────────────────┬─────────────┘
               │                                     │
   subscribe() │                                     │ getState()
               ▼                                     ▼
   ┌────────────────────────┐            ┌─────────────────────────┐
   │ getPluginManager()     │            │ useMarketplaceStore     │
   │   .list() / .subscribe │            │   .installs             │
   │   .unload(id)          │            │   .licenses             │
   │   (per-page singleton) │            │   .status               │
   └────────────────────────┘            └─────────────────────────┘
       runtime/PluginManager                marketplace + Pro backend
```

## The join

Every row the UI renders comes from `useInstalledPluginsStore.getRows()`,
which builds rows from two upstream sets:

- **Marketplace installs** (`useMarketplaceStore.installs`) — what the
  Pro backend says the user owns. Carries `id`, `version`, `enabled`,
  `installedAt`, `bundleHash`. Source of truth for "what is *installed*".
- **Manager entries** (`getPluginManager().list()`) — what is *currently
  running* in workers. Carries the full `PluginManifest` (so we get
  `name`, `publisher`, `category`), the live `PluginStatus`, and any
  activation error.

When both sides know the same id, the manager entry wins for status,
display name, and error info, but the marketplace `install` field is
preserved on the row (the UI uses it for the version string when the
plugin failed to load and the manifest is unavailable).

| Status emitted               | Trigger                                                 |
|------------------------------|---------------------------------------------------------|
| `active`                     | manager has the entry, status `active`                  |
| `loading`                    | manager just received `load()`, awaiting `ready`        |
| `failed`                     | activate threw / handshake timed out / integrity bad    |
| `unloaded`                   | user disabled it OR install record `enabled: false`     |
| `paused`                     | `manager.pause(id, reason)` ran (CORE-008c expiry timer or future "snooze") |
| `installed-not-loaded`       | install record present + enabled, manager has no entry  |
| `no-license`                 | a license-gate failure is cached for this id (CORE-008b) |

When the loader returns `license-failed`, the typed `LoadLicenseReason`
is stamped onto the row as `licenseReason` (separate from `status`) so
the panel can render the per-reason copy + CTA without parsing prose.
A subsequent successful load implicitly clears the cached reason.

`paused` entries also surface a `pauseReason: PluginPauseReason`
(`license-expired` / `license-revoked` / `manual`). For the two
license-driven reasons, the store *also* derives `licenseReason`
(`expired` / `revoked`) so the same `<LicenseStatus />` renderer used
for `license-failed` rows works without a parallel branch. `manual`
pauses (today: tests + future snooze affordances) skip the license
CTA and just show the "Paused" badge.

## Why a join layer instead of two stores in components

A `<PluginRow />` that pulled from both stores directly would have to:

1. Re-derive the join on every render.
2. Subscribe to two Zustand stores plus the `PluginManager` event.
3. Re-implement the precedence rules (manager entry wins on status,
   marketplace wins on enabled flag, etc.) per call site.

Centralising this in `useInstalledPluginsStore` means the precedence
rules live in *one* place (`buildRows()`), and any future call site
(e.g., a status indicator in the toolbar) reads the same rows. The
modal is a *render*, not a controller.

## Optimistic state

Three sets capture local-only changes that have not (yet) been
persisted to the Pro backend:

- `localDisabled: Set<string>` — overrides `install.enabled` to `false`
  until backend persistence lands (PRO-003 owns the endpoint).
- `localUninstalled: Set<string>` — hides the row entirely. The plugin
  is unloaded from the manager but the marketplace still believes it
  is installed; on next `refresh()` it will reappear unless PRO-003
  has confirmed the DELETE.
- `busyIds: Set<string>` — flagged during `toggleEnabled`/`uninstall`
  so the row buttons show as disabled.

This is intentionally not "true" optimistic UI with rollback — there is
no remote operation to roll back yet. When the backend mutations are
wired, both sides have to reconcile through the same Zustand store; the
job will be to add the network call and roll back the local set on
error.

## What lives in this layer vs what is deferred

This layer shipped in CORE-008. CORE-008b extends it with **reload-on-enable**,
**per-reason license CTAs**, an **update badge**, and a **24h denylist
refresh timer**. Remaining deferrals:

- **Schema-driven settings forms.** SDK-006 already lets a plugin
  declare a settings schema via `ctx.settings.declare()`, but the
  React renderer that turns that schema into an editable form is
  scoped to **SDK-006b**. Until then, the settings dialog shows the
  manifest and a placeholder.
- **Backend persistence of toggle/uninstall.** The DELETE and PATCH
  endpoints belong to **PRO-003**. Today the modal optimistically
  flips local sets and unloads the worker; on next page reload the
  marketplace install record overrides the local state.
- **Pause-on-expiry timer.** A long-running session whose license
  expires *after* the worker started should pause (not terminate) the
  worker and surface the same "License expired" CTA. Requires a new
  `PluginManager.pause(id)` primitive (today only `unload` exists).
  Tracked in CORE-008c.
- **Latest-version backend.** `<PluginUpdateBadge />` is wired but the
  `LatestVersionResolver` is currently a no-op factory. PRO-003 ships
  the marketplace catalog endpoint that exposes per-plugin "latest
  available" versions — at that point we wire a real resolver.

## CORE-008b additions

### Reload on enable

`useInstalledPluginsStore` exposes a startup hook the editor calls once
the loader is constructed:

```ts
import { configureInstalledPlugins } from '@/store/useInstalledPluginsStore';
import { defaultLicenseResolver, PluginLoader } from '@/plugins/loader';

const loader = new PluginLoader({ licenseResolver: defaultLicenseResolver() });
configureInstalledPlugins({ loader });
```

After this hook fires, `toggleEnabled(id)` on a re-enable path:

1. clears the local `localDisabled` flag,
2. snapshots the manifest from `getPluginManager().list()` (captured on
   every notify tick into a module-local `manifestCache`),
3. rebuilds an `InstalledPlugin` from the marketplace `InstalledRecord`
   (requires `bundleHash` to be present — without it the path no-ops),
4. calls `loader.loadOne(installed)` so the **license gate, integrity
   check, and IndexedDB cache all run again** — no shortcut,
5. on `license-failed` stamps `licenseReason` onto the row; on success
   clears any prior cached reason.

If `configureInstalledPlugins()` is never called (unconfigured tests,
script entry points), re-enable cleanly no-ops without throwing.

### Per-reason license copy + CTA

`<LicenseStatus reason={…} row={…} />` maps every `LoadLicenseReason`
to a one-line headline plus an action the user can take:

| reason              | CTA                          |
|---------------------|------------------------------|
| `no-license`        | Buy license on marketplace   |
| `not-authenticated` | Sign in                      |
| `expired`           | Renew license                |
| `wrong-version`     | Update plugin on marketplace |
| `wrong-user`        | Contact support              |
| `wrong-plugin`      | Contact support              |
| `revoked`           | Contact support              |
| `bad-signature`     | Contact support              |
| `unknown-kid`       | Contact support              |
| `malformed`         | Contact support              |

Strings live inline in `InstalledPluginsModal.tsx` for now — SDK-005b
will route them through `useTranslation` when the editor locale picker
lands.

### Update badge

`<PluginUpdateBadge />` is a tiny pill that renders next to the status
badge when `row.latestVersion !== row.version`. The `latestVersion`
field is populated by an injectable `LatestVersionResolver`:

```ts
configureInstalledPlugins({
  loader,
  latestVersionResolver: {
    getLatestVersion: (id) => marketplaceCatalog.get(id)?.latestVersion ?? null,
  },
});
```

The default factory (no resolver injected) returns `null` for every id,
so the badge stays hidden. PRO-003 wires the production catalog.

### 24h denylist refresh

The modal mounts a `setInterval` that calls
`useInstalledPluginsStore.refreshDenylist()` every 24 hours. The
underlying call delegates to `useMarketplaceStore.refresh()` and
**swallows network errors silently** — the timer fires unattended, so a
flaky network must not surface as a banner. The next `toggleEnabled`
reload-on-enable will pick up the freshened denylist.

## Header integration

`AppHeader.tsx` carries a `Plugins` button between the Share button and
the auth UI. Clicking it sets local React state to mount the modal —
nothing else in the page tree is affected.

## Tests

`__tests__/installed-plugins-store.test.ts` (31 tests) covers:

**CORE-008 baseline (15 tests)**
- empty / install-only / entry-only / both-overlap row cases
- failed-state error surface
- license attachment by `pluginId`
- alphabetical sort by `displayName`
- toggle / uninstall optimistic state
- toggle is reversible
- toggle + uninstall manager calls land
- busy flag clears after each action

**CORE-008b (12 tests)**
- re-enable invokes the configured loader with cached manifest + bundleHash
- re-enable skips loader when `bundleHash` is missing on the install record
- `license-failed` outcome stamps `licenseReason` onto the row
- successful re-enable clears a previously-cached license reason
- re-enable without a configured loader cleanly no-ops
- disable still routes through `manager.unload`, not the loader
- `latestVersion` populates when resolver returns a higher version
- `latestVersion` omitted when resolver returns same version or `null`
- a throwing resolver does not break `getRows()` for sibling rows
- `refreshDenylist()` swallows transport errors
- `refreshDenylist()` bumps `tick` on success

**CORE-008c (4 tests)**
- paused entry surfaces `status: 'paused'` and `pauseReason` on the row
- `license-expired` pause derives `licenseReason: 'expired'`
- `license-revoked` pause derives `licenseReason: 'revoked'`
- `manual` pause does NOT surface a license CTA

Pause-on-expiry timer behaviour is covered separately in
`__tests__/plugin-loader-pause-on-expiry.test.ts` (12 tests, real
Ed25519 sign/verify with fake timers).

The modal itself is intentionally not unit-tested at the DOM level —
this repo does not pull in `@testing-library/react`. The store covers
the entire data flow; the modal is a thin render.

## Live stats panel (CORE-006b step 4)

Every row whose `status` is `active` or `paused` mounts a
`<PluginStatsPanel pluginId={row.id} />`. The panel is a collapsible
`<details>` block that surfaces the counters `PluginHost.getStats()`
publishes: the RPC subsystem (pending requests, drops, coalesced,
missed pings), subscribed simulator events + disposables held, and
fetch egress (requests, bytes in / out, rate-limit hits).

Polling is driven by a module-local `setInterval(1000)` in
`frontend/src/plugins/runtime/useHostStats.ts` that publishes a
monotonic tick counter through `useSyncExternalStore`. The timer is
**armed lazily on first subscriber and cleared on last unsubscribe**
— closing the modal stops the wakeup cycle (no background drain).
The hook returns `null` when the plugin has no active host; rows
that are not yet loaded or have been terminated silently skip the
panel.

```
                 ┌─────────────────────────────┐
                 │  <PluginStatsPanel />       │
                 │  usePluginHostStats(id)     │
                 └────────────┬────────────────┘
                              │ subscribe(onChange)
                              ▼
      ┌────────────────────────────────────────────────┐
      │ useHostStats.ts                                │
      │  ├─ 1 Hz setInterval (lazy: ≥1 subscriber)     │
      │  ├─ tick++ on fire                             │
      │  ├─ dispatch all subscribers, fault-isolated   │
      │  └─ getSnapshot() → stable primitive tick      │
      └────────────────────────┬───────────────────────┘
                               │ getPluginManager().get(id)?.stats
                               ▼
                 ┌─────────────────────────────┐
                 │  PluginHost.getStats()      │
                 │   — fresh object per call   │
                 └─────────────────────────────┘
```

Because `PluginHost.getStats()` synthesises a new object on every
call, the hook does **not** try to make the snapshot comparable by
reference: it uses the primitive tick as the React-facing snapshot
(stable within a tick, comparable by value across ticks) and
re-reads fresh stats after each tick. This is the standard
"`useSyncExternalStore` as a re-render trigger" idiom and avoids
the "result of getSnapshot should be cached" warning.

**Why not fold stats into `useInstalledPluginsStore`?** The store is
a join layer — it never owns plugin state itself (see the module
docstring). Stats are transient per-frame data sourced from the
manager; keeping them in a standalone hook preserves the invariant
and scopes polling lifetime to modal open/close without the store
needing a new "is the modal open?" subscriber count.

The summary row (visible when `<details>` is collapsed) highlights
the signals the user wants at a glance: pending requests, drops,
subscribed events count, fetch requests, and rate-limit hits. Drops
and rate-limit hits switch to a danger tone (red) when ≥1 — those
are the two early-warning signs of a plugin the runtime is about
to throttle or tear down. A red alert dot appears when any of the
stress signals (drops, missed pings, rate-limit hits) is non-zero.

`formatBytes` keeps labels ≤7 characters (`2.0 KB`, `1.5 MB`) so
chips do not wrap on the typical modal width. Invalid inputs
(negative, NaN, Infinity) render as `—`.

Tests: `__tests__/PluginStatsPanel.test.tsx` (13 tests) — covers
timer arm/disarm lifecycle, error isolation across subscribers,
hook re-render on tick with fresh stats, `null` return for
missing entries, and `formatBytes` edge cases. The runtime
counter sources themselves are covered by
`plugin-runtime-rpc.test.ts` (RPC stats) and
`plugin-runtime-fetch-egress.test.ts` (fetch stats).

## What this layer does NOT do

- Talk to the Pro backend directly. Marketplace IO is handled by
  `useMarketplaceStore` (which uses `MarketplaceClient`).
- Verify licenses. The verifier from CORE-009 is the only gate.
- Decide whether to load a plugin on startup. The loader (CORE-007)
  owns that decision; the modal observes the result.
- Render plugin UI. Plugins render via the slot system (deferred to
  CORE-002b / CORE-006b).
