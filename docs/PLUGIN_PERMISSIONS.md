# Plugin Permissions — Catalog and Threat Model

**Audience.** Plugin authors deciding which permissions to declare,
reviewers triaging marketplace submissions, users about to install a
plugin, and Velxio maintainers extending the surface.

**Source of truth.** The runtime catalog is the
`PLUGIN_PERMISSIONS` array in
[`packages/sdk/src/permissions.ts`](../packages/sdk/src/permissions.ts).
Anything documented here that does not appear in that array is
aspirational; anything in that array missing from this document is a
documentation bug — please open an issue.

---

## TL;DR for plugin authors

1. Declare the **minimum** set of permissions in your `manifest.permissions`. The host throws `PermissionDeniedError` synchronously on any ungated API call — there is no graceful fallback, the call site crashes.
2. If you declare `http.fetch`, you **must** also declare a non-empty `http.allowlist` of HTTPS URL prefixes. The manifest schema rejects a manifest that fails this rule.
3. Your settings, your i18n bundles, and your event subscriptions need **no** permission. They are local read-only data; gating them would be noise.
4. The `register` permissions (`components.register`, `ui.command.register`, ...) are coarse: holding the permission lets you register *any* number of items in that surface. Per-item gating is intentionally out of scope.

---

## Permission catalog

The table below is the canonical reference. Every row maps to one entry in `PLUGIN_PERMISSIONS`. **Risk** is the user-facing risk class shown in the marketplace consent UX (see [Pre-install consent](#pre-install-consent-dialog) below).

| Permission                       | Risk   | What it allows                                                                                                                                  | What it does NOT allow                                                                                                            | Currently enforced by                                |
| -------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `simulator.events.read`          | Low    | Subscribing to `ctx.events.on(...)` — pin changes, serial TX, simulator lifecycle, SPICE step. Read-only stream.                                | Modifying simulator state, writing to pins, intercepting events from other plugins.                                               | Manifest declaration only (gate lands in CORE-006).  |
| `simulator.pins.read`            | Low    | Registering a `PartSimulation` whose `onPinStateChange` and SDK `attachEvents` observe pin transitions for a specific component.                | Reading or driving pins of components your plugin did not register, sniffing the bus globally.                                    | `ctx.partSimulations.register()` gate.               |
| `simulator.pins.write`           | Medium | Driving inputs of a component your simulation owns (e.g. button → MCU pin) and scheduling cycle-accurate pin transitions via `handle.schedulePinChange()`. | Forcing pins on components your plugin did not register, mutating MCU registers directly.                                         | `handle.setPinState/schedulePinChange` (manifest declaration only). |
| `simulator.pwm.read`             | Low    | Subscribing to PWM duty-cycle changes on one of your component pins via `handle.onPwmChange(pinName, duty => …)`. Read-only observer.           | Driving PWM on the MCU side, observing PWM on pins your plugin did not register, intercepting another part's PWM callbacks.       | Manifest declaration only (CORE-002c-step3). Gate lands with the worker-side `ContextStub` call in CORE-006b. |
| `simulator.spi.read`             | Low    | Observing bytes the MCU transmits on the hardware SPI bus via `handle.onSpiTransmit(byte => …)`. Shared bus today — every subscriber sees every byte. | Transmitting SPI bytes as a master, modifying in-flight bytes, filtering by chip-select (CS handling is the part's responsibility). | Manifest declaration only (CORE-002c-step3). Gate lands with the worker-side `ContextStub` call in CORE-006b. |
| `simulator.spi.write`            | High   | Registering as a virtual SPI slave via `handle.registerSpiSlave(handler)`. The slave responds with bytes on MISO, which the sketch interprets as real device data (TFT readback, flash memory, microSD). | Acting as an SPI master, listening on buses your plugin is not actively slaved to, displacing another plugin's slave silently (last-writer-wins logs a warn and stops the previous handler). | `handle.registerSpiSlave` (manifest declaration only). |
| `simulator.i2c.read`             | Low    | Observing completed I²C transactions on the bus via `handle.onI2cTransfer(event => …)` (reserved for future use — wiring lands with CORE-003b). | Driving the bus as slave, modifying transaction payloads, intercepting another plugin's slave traffic.                            | Manifest declaration only — the AVR host does not emit `i2c:transfer` events yet (CORE-003b). |
| `simulator.i2c.write`            | High   | Registering as a virtual I²C slave at a 7-bit address via `handle.registerI2cSlave(addr, handler)`. The slave participates in the bus protocol and drives MCU-visible state. | Registering on the host's reserved ranges, displacing another plugin's slave without disposing first (last-writer-wins, but the dispose handle is yours to manage), acting as master. | `handle.registerI2cSlave` (manifest declaration only). |
| `simulator.analog.write`         | High   | Injecting an analog voltage on the ADC channel backing a component pin via `handle.setAnalogValue(pinName, volts)`. The host converts to the right board-specific raw sample (10/12-bit). | Driving pins your plugin did not register, reading the resulting ADC sample back, modifying the ADC reference voltage or resolution, injecting values on analog pins of components you do not own. | `handle.setAnalogValue` (manifest declaration only). |
| `simulator.sensors.read`         | Low    | Subscribing to values from the user-facing SensorControlPanel via `handle.onSensorControlUpdate(values => …)`. Read-only observation of user input sliders/toggles for your component instance. | Reading sensor values of components your plugin did not register, driving MCU state directly (`setAnalogValue` / `setPinState` require their own gates), modifying the control panel itself. | `handle.onSensorControlUpdate` (manifest declaration only). |
| `simulator.spice.read`           | Low    | Registering a SPICE mapper for a component (`ctx.spice.registerMapper`) and contributing SPICE model cards (`ctx.spice.registerModel`).         | Solving the netlist directly, reading other plugins' mappers, reaching into ngspice internals.                                    | `ctx.spice.registerMapper/Model` gates.              |
| `compile.transform.client`       | Medium | Registering a client-side compile middleware (transform sketch source before send to backend). Server middleware is host-only.                  | Server middleware (Python), bypassing arduino-cli, intercepting another plugin's middleware, persistent code modification.        | Manifest declaration only (gate lands in CORE-006).  |
| `ui.command.register`            | Low    | Adding entries to the command palette via `ctx.commands.register()`.                                                                            | Removing or replacing built-in commands, simulating user clicks on commands you did not register.                                 | `ctx.commands.register()` gate.                      |
| `ui.toolbar.register`            | Low    | Adding toolbar buttons via `ctx.toolbar.register()`.                                                                                            | Reordering or removing built-in toolbar buttons, intercepting clicks on other buttons.                                            | `ctx.toolbar.register()` gate.                       |
| `ui.panel.register`              | Low    | Adding sidebar/bottom panels via `ctx.panels.register()`.                                                                                       | Reading content of other panels, replacing built-in panels.                                                                       | `ctx.panels.register()` gate.                        |
| `ui.statusbar.register`          | Low    | Adding status-bar items via `ctx.statusBar.register()` (and the deprecated `ctx.statusbar.add()` alias).                                        | Reading other plugins' status-bar items.                                                                                          | `ctx.statusBar.register()` + `.add()` gates.         |
| `ui.context-menu.register`       | Low    | Adding right-click menu entries via `ctx.contextMenu.register()`.                                                                               | Suppressing built-in context-menu items, intercepting clicks on items you did not register.                                       | `ctx.contextMenu.register()` gate.                   |
| `ui.editor.action.register`      | Low    | Adding Monaco editor actions (Cmd-K-style) via `ctx.editorActions.register()`.                                                                  | Listening to keystrokes globally, reading the editor buffer wholesale.                                                            | `ctx.editorActions.register()` gate.                 |
| `ui.canvas.overlay.register`     | Low    | Drawing overlays on the simulator canvas via `ctx.canvasOverlays.register()`.                                                                   | Capturing the canvas as a bitmap, intercepting mouse events outside your overlay's hit area.                                      | `ctx.canvasOverlays.register()` gate.                |
| `storage.user.read`              | Low    | Reading from the per-user, cross-workspace key-value store via `ctx.userStorage.get()` / `keys()`.                                              | Reading another plugin's storage (the namespace is `pluginId`-scoped), reading user cookies, reading editor LocalStorage.         | `wrapStorage()` gate around `InMemoryPluginStorage`. |
| `storage.user.write`             | Medium | Writing to the per-user store via `ctx.userStorage.set()` / `delete()` / `clear()`. Capped at 1 MB per plugin per user.                         | Exceeding the quota (host throws `StorageQuotaError`), writing to other plugins' namespaces, persisting globally across users.    | `wrapStorage()` gate.                                |
| `storage.workspace.read`         | Low    | Reading the per-project (workspace-scoped) store via `ctx.workspaceStorage.get()` / `keys()`.                                                   | Reading other workspaces' storage, reading workspace files outside the K/V store.                                                 | `wrapStorage()` gate.                                |
| `storage.workspace.write`        | Medium | Writing to the per-project store via `ctx.workspaceStorage.set()` / `delete()` / `clear()`. Same 1 MB cap as user storage.                      | Exceeding the quota, writing to other workspaces, modifying project files outside the K/V store.                                  | `wrapStorage()` gate.                                |
| `http.fetch`                     | High   | Calling `ctx.fetch(url, init)`. Each request must match a prefix in `manifest.http.allowlist` (HTTPS only, ≤10 entries, ≤4 MB per response).    | HTTP (non-TLS) URLs, allowlist bypass, sending cookies (`credentials: 'omit'` is forced), reading another plugin's response body. | `ctx.fetch()` gate + `createScopedFetch()` enforcer. |
| `components.register`            | Medium | Contributing component definitions via `ctx.components.register()`. Last-writer-wins inside the same plugin; cross-plugin collisions throw.     | Replacing built-in components, modifying components registered by another plugin, deleting components.                            | `ctx.components.register()` gate.                    |
| `libraries.provide`              | Medium | Contributing Arduino library bundles via `ctx.libraries.register()`. Caps: ≤2 MB total, ≤512 KB per file, allow-listed extensions and pragmas.  | Shipping ELF/HEX binaries, native code, files with `..` in `#include`, last-writer-wins on cross-plugin id collisions.            | `ctx.libraries.register()` gate.                     |
| `templates.provide`              | Low    | Contributing project templates (board + files + components + wires) via `ctx.templates.register()`. Caps: ≤1 MB total, ≤64 files, ≤500 KB each. | Replacing built-in templates, instantiating templates without explicit user action.                                               | `ctx.templates.register()` gate.                     |
| `settings.declare`               | Low    | Calling `ctx.settings.declare()` to register a settings schema. Reads/writes/onChange need no further permission once declared.                 | Reading another plugin's settings, declaring more than one schema (re-declare overwrites in place atomically).                    | `ctx.settings.declare()` gate.                       |

### Notes on the catalog

- **"Manifest declaration only"** entries (`simulator.events.read`, `simulator.pins.write`, `compile.transform.client`) are accepted by the manifest validator today but the host adapter does not yet wrap the underlying API behind `requirePermission()`. They will be gated when their corresponding API surface lands (CORE-006 for events/middleware in worker, SDK-003b for the high-level `PartSimulationAPI`). Until then, declaring them is **honest** — the user sees the full intended surface in the consent dialog — but the runtime check is a no-op.
- **`components.register` is medium-risk**, not low, because a malicious plugin could ship a component visually identical to a built-in (e.g. a fake "ATmega328P") with a divergent simulation, deceiving the user. The marketplace review queue (PRO-011) checks for visual/name collisions.
- **`libraries.provide` is medium-risk** for the same reason plus the larger code-shipment surface: arduino-cli identifies libraries by folder name, so a malicious `WiFi` shadow could ship into a sketch silently. Cross-plugin id collisions throw `DuplicateLibraryError` at register time precisely to prevent this.
- **`http.fetch` is the only high-risk permission** in the current catalog. The `http.allowlist` is the entire trust boundary: a plugin that declares `https://api.openai.com/v1/` cannot pivot to `https://attacker.example/`. Allowlist entries are HTTPS-prefix matched (no globs, no path traversal).

### Risk classes

- **Low** — observable / additive only. Worst case: UI clutter, log spam, slightly stale reads. Auto-granted on install (no consent dialog).
- **Medium** — mutates user-visible state or shared resources, but bounded. Shown in the consent dialog with a one-line description.
- **High** — capable of exfiltrating data or introducing arbitrary code paths. Shown in the consent dialog with a multi-line explanation, the allowlist (where applicable), and a "review allowlist" expander.

The risk class is **not** stored in the SDK enum — it is editorial policy enforced by the marketplace UI. Re-classifying a permission requires a coordinated change here + the marketplace consent component + the review queue criteria.

---

## Threat model

### Attacker assumptions

1. **The plugin author is the attacker.** The plugin code is adversarial — it will try to do anything its declared permissions don't strictly forbid.
2. **The plugin bundle has been signed and verified.** Tampering at the CDN is out of scope (CORE-007 + PRO-007 cover integrity). The threat is malicious *intent* in code that legitimately came from the published bundle.
3. **The user does not read permission descriptions carefully.** The consent UX must surface high-risk permissions at a glance; "see full list" disclosures protect us against negligence at install time but cannot prevent it.
4. **The user is logged into Velxio.** Their session cookie is valuable; the runtime treats the editor's `document.cookie` as inaccessible to plugins (the worker has no DOM and `credentials: 'omit'` is forced on `ctx.fetch`).
5. **Two plugins from different authors run in the same editor session.** They MUST NOT be able to read each other's data, intercept each other's API calls, or impersonate each other.

### Out of scope

- **Browser zero-days.** A V8/JS-engine RCE escapes everything; we trust the browser's process model.
- **Side channels** (timing attacks, Spectre, cache probing). We do not partition execution at the CPU level.
- **DoS by CPU consumption.** A plugin with `setInterval(() => {while(true){}})` will hang its worker. CORE-006 will cap per-frame budgets and kill misbehaving workers, but a determined plugin can still degrade the experience.
- **Malicious content displayed to the user.** A `ui.panel.register` plugin can render misleading UI inside its own panel. The marketplace review (PRO-011) is the primary mitigation; we do not sandbox panel HTML beyond CSP.

### Runtime guarantees

Today (Phase 1 — host-process plugins; CORE-006 will move execution into Web Workers):

| Guarantee                                                                                                                            | Mechanism                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| A plugin without permission `X` cannot call any API that requires `X`.                                                               | `requirePermission()` synchronously throws `PermissionDeniedError`; thrown before any side-effects.        |
| A plugin cannot read another plugin's settings, storage, i18n bundle, components, libraries, or templates.                           | Per-plugin namespacing keyed by `manifest.id`; registries store `pluginId` per entry.                      |
| A plugin cannot fetch URLs outside its declared `http.allowlist`.                                                                    | `createScopedFetch` rejects with `HttpAllowlistDeniedError` before issuing the request.                    |
| A plugin cannot exceed 1 MB of storage per (user, pluginId).                                                                         | `InMemoryPluginStorage` throws `StorageQuotaError` on `set()` overflow (TextEncoder byte counting).        |
| A plugin cannot leak its session cookie to its `http.allowlist` endpoints.                                                           | `credentials: 'omit'` is hard-coded in `createScopedFetch`.                                                |
| A throwing plugin callback (event listener, settings `onChange`, i18n `onLocaleChange`, ...) does not crash the host or peer plugins. | Every dispatch site wraps callbacks in try/catch and routes errors to `ctx.logger.error`.                  |
| A plugin's `dispose()` runs even if a previous teardown threw.                                                                       | `HostDisposableStore` LIFO-iterates and isolates each `.dispose()`; the result is logged, never re-raised. |
| A late-registering disposable (post-deactivation) is disposed immediately and warned.                                                | `HostDisposableStore.add()` after `dispose()` no-ops the addition and emits a logger warn.                 |

Pending CORE-006 (Web Worker runtime):

| Guarantee                                                                                                                | Mechanism (planned)                                                                            |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| A plugin cannot reach the editor's DOM, cookies, or `localStorage`.                                                       | Plugin runs in a Worker; only `postMessage` to/from host. No `window`, no `document`.          |
| A plugin cannot block the simulator frame budget.                                                                         | Per-frame CPU budget per worker; soft-kill on overrun (cancel pending message, log).           |
| A plugin cannot impersonate the host's `postMessage` calls to other workers.                                              | The host mediates all inter-worker comms; workers have no `MessageChannel` access.             |
| A plugin's compile middleware cannot read or write disk on the backend.                                                   | Server middleware (CORE-004) runs in the FastAPI process; only `compile.transform.server` workers see the request payload. Client middleware is per-tab, no FS. |

### Capability denylist (always)

A plugin **never** gets:

- Access to the editor's `document`, `window`, `cookies`, `localStorage`, or `sessionStorage`. (Today via convention; post-CORE-006 via Worker isolation.)
- The user's auth token, OAuth identity, or any session credentials.
- The ability to make a non-HTTPS request, or an HTTPS request outside its `http.allowlist`, or an HTTPS request with the user's cookies attached.
- The ability to read or modify another plugin's settings, storage, components, libraries, or templates.
- The ability to replace or unregister built-in components, libraries, or commands.
- The ability to spawn additional Workers, Service Workers, or iframes.
- The ability to use `eval` or `Function` constructors when running inside a CSP'd Worker (CORE-006 will set `script-src 'self'`).
- The ability to access `IndexedDB`, `Cache`, or `FileSystemAccess` directly. Persistence goes through `ctx.userStorage` / `ctx.workspaceStorage` only.

These are bright lines. Adding a permission that loosens any of them requires a security review and an INDEX.md follow-up task.

---

## Pre-install consent dialog

(Implemented in **SDK-008b**. Components live at `frontend/src/components/plugin-host/PluginConsentDialog.tsx` and `PluginUpdateDiffDialog.tsx`. The runtime catalog backing both is `@velxio/sdk/permissions-catalog`.)

When the user clicks **Install** on a plugin:

1. The host parses `manifest.permissions` and partitions them by risk class (Low / Medium / High) using the catalog table above.
2. **If every permission is Low**, install proceeds without a dialog (the listing already shows the permission badges).
3. **If any permission is Medium or High**, a modal appears with three sections:
   - **Plugin identity** — name, publisher, version, signature status (verified / community-signed / unsigned).
   - **What this plugin will be allowed to do** — one row per Medium/High permission with the catalog's "What it allows" copy. High-risk rows expand to show the catalog's "What it does NOT allow" + (for `http.fetch`) the full `http.allowlist`.
   - **Buttons** — `Install` (primary), `Cancel` (default focus). No "remember this for similar plugins" — every install is consent-fresh.
4. If the user cancels, the install transaction rolls back atomically (no half-installed plugin entries; the loader's cache is touched only on confirmed install).

Wording must be plain English, no jargon. The catalog's "What it allows" text is the canonical wording — translators consume it via SDK-005's i18n system in the marketplace shell.

---

## Permission diff on update

(Implemented in **SDK-008b**. The `<PluginUpdateDiffDialog />` component is driven by `classifyUpdateDiff()` from `@velxio/sdk/permissions-catalog`, which returns one of three discriminated cases — `auto-approve` / `auto-approve-with-toast` / `requires-consent`. The dialog renders only the latter two; `auto-approve` is consumed silently by the caller.)

When a plugin update arrives (CORE-007 loader detects a new version in the registry):

1. Compute `added = new.permissions - old.permissions`.
2. **If `added` is empty**, auto-update silently (still log the version bump in the editor's plugin activity panel).
3. **If `added` contains only Low-risk permissions**, auto-update and surface a dismissible toast: *"<plugin> was updated and now uses: <permissions>"*.
4. **If `added` contains any Medium or High permission**, **block** the update. The plugin keeps running on its old version until the user opens the "Pending updates" panel and re-confirms with a dialog identical to the install consent — but with an "Added since v<old>" header on the changed rows.
5. If the user cancels, the plugin stays pinned at the old version. The loader does not retry the update until the user explicitly clicks "Update now."

Removed permissions never trigger a dialog — narrowing the surface is always strictly safer. The diff is logged so reviewers can spot suspicious oscillation (a plugin that pulls a permission, waits a release, and re-adds it under user fatigue).

The `manifest.permissions` array is sorted at validation time (SDK-001) so the diff is order-stable — no false positives from a re-ordered list.

---

## Install/update flow controller (SDK-008c)

The dialogs from SDK-008b are mounted by `InstallFlowController`, a host-side singleton at `frontend/src/plugin-host/InstallFlowController.ts`. It is the single entry point any caller (marketplace listing, Installed Plugins modal, loader-driven update flow) goes through to surface a consent prompt.

The controller is intentionally split in two layers so the consent logic stays unit-testable in plain Vitest:

- **Pure logic** — `InstallFlowController.ts` exposes `requestInstall(manifest, options?)` and `requestUpdate(installed, latest)`. Imports zero React APIs. Maintains an `ActiveDialog | null` snapshot and a `Set<listener>`. Each `requestX` decides whether a dialog is needed (delegating to the SDK's `requiresConsent` / `classifyUpdateDiff` helpers) and either resolves immediately ("auto-approve" path) or constructs a `Promise` that resolves when the user acts.
- **React overlay** — `frontend/src/components/plugin-host/InstallFlowOverlay.tsx` subscribes via `useSyncExternalStore` and renders the dialog matching `ActiveDialog.kind`. `App.tsx` mounts a single `<InstallFlowOverlay controller={getInstallFlowController()} />` inside the router.

### Singleton + sync-throw discipline

Only one consent dialog can be open at a time — overlapping install + update would steal focus. A second `requestX` while a dialog is mounted throws `InstallFlowBusyError` **synchronously**: the public method is **not** declared `async`, so the throw lands on the caller's stack instead of becoming an unhandled rejection on a microtask. The body returns `Promise.resolve(...)` for auto-approve paths and `new Promise((resolve) => …)` for dialog paths to honour the public Promise-returning signature.

Callers SHOULD treat `InstallFlowBusyError` as a programmer error (the marketplace UI MUST disable "Install" buttons while a dialog is open), not a recoverable state.

### Skipped versions persistence

When the user clicks **Skip this version** in `<PluginUpdateDiffDialog />`, the controller calls `sinks.markVersionSkipped(pluginId, version)`. `App.tsx` wires this to `useInstalledPluginsStore.markVersionSkipped`, which writes to a `ReadonlyMap<pluginId, version>` persisted in `localStorage` under `velxio.skippedVersions`.

The store's `buildRows` suppresses the `latestVersion` badge whenever `latest === skippedVersions.get(id)`. A strictly newer release (`latest > skipped`) replaces the cursor (the previous skip no longer applies — the user has not yet seen this one).

The skip is permanent across reloads but **per-version**, not per-plugin — the user is never permanently silenced.

### Auto-approve-with-toast

When `classifyUpdateDiff` returns `auto-approve-with-toast`, the controller invokes `sinks.emitToast?.(InstallToastEvent)` and resolves immediately with `{ kind: 'updated' }` — **no modal mounts**. The event payload carries `pluginId`, `fromVersion`, `toVersion`, and the `PermissionCatalogEntry[]` that were added, ready for the host's notification surface to render. App.tsx leaves the hook unset until the marketplace UI ships its toast container (SDK-008d / PRO-005); events drop silently in the meantime, but the install still proceeds.

### What's NOT in SDK-008c

- The marketplace listing's **Install** button does not yet call `requestInstall` — the caller wiring lands in PRO-005 (the Pro repo).
- The Installed Plugins modal's update badge currently fetches a *placeholder* manifest (clone-and-bump-version) which always classifies as `auto-approve` — the real catalog manifest fetch lands in PRO-003. Until then the dialog only opens via test paths.
- The loader does not auto-trigger `requestUpdate` when polling discovers drift — manual click via the badge is the only entry point. SDK-008d covers loader-driven detection.

---

## Adding or changing a permission

To add a new permission to the catalog:

1. Add the string to `PLUGIN_PERMISSIONS` in `packages/sdk/src/permissions.ts`. Keep the array grouped by section (`// Simulator`, `// UI`, `// Storage`, ...).
2. Add the row to the catalog table in this document (alphabetical within its section). Pick the **least permissive** risk class that honestly describes the surface.
3. Wire the gate at the host call site: `requirePermission(manifest, '<perm>')` at the top of the registry's adapter method.
4. Add an SDK contract test that asserts the new gate throws `PermissionDeniedError` for a manifest without it.
5. Add a host integration test (`plugin-host-sdk00X.test.ts`) that asserts the gated API works *with* the permission and throws *without* it.
6. Update `docs/PLUGIN_SDK.md` in the relevant section to call out the required permission in the example.

Re-classifying an existing permission's risk class:

1. Update this document.
2. Bump the marketplace consent UI's policy file (SDK-008b).
3. Schedule a coordinated re-review of all installed plugins that hold the permission — risk re-classification is a soft form of permission addition from the user's perspective.
4. Announce in the changelog and the plugin authors' newsletter at least one minor version before the change ships.

---

## SDK-008b implementation reference

### Runtime catalog (`@velxio/sdk/permissions-catalog`)

The TS catalog `PERMISSION_CATALOG` is the runtime source of truth for the dialog UX — never parse this markdown at runtime. The CI test `packages/sdk/test/permissions-catalog-sync.test.ts` parses the table above and fails the build if the two drift in either direction. To add or change a permission, update **both** in the same PR.

Public surface from `@velxio/sdk/permissions-catalog`:

| Symbol | Purpose |
| --- | --- |
| `PERMISSION_CATALOG` | `ReadonlyArray<{ permission, risk, allows, denies }>`, one entry per `PluginPermission`. |
| `getPermissionEntry(perm)` | O(1) Map lookup. Returns `undefined` for unknown strings. |
| `partitionPermissionsByRisk(perms)` | Returns `{ low, medium, high, unknown }`. Order-stable inside each bucket. |
| `requiresConsent(perms)` | `true` iff any Medium/High/unknown. |
| `diffPermissions(oldPerms, newPerms)` | `{ added, removed }`. De-duplicates inputs; order-stable. |
| `classifyUpdateDiff(diff)` | Discriminated union: `auto-approve` / `auto-approve-with-toast` / `requires-consent`. Centralizes the policy decision. |

### Pre-install consent component

`<PluginConsentDialog plugin permissions httpAllowlist? onConfirm onCancel />`. Pure presentational — owns no install state. The caller decides what `onConfirm`/`onCancel` mean.

Behavioral invariants (covered by `frontend/src/__tests__/PluginConsentDialog.test.tsx`):

- All-Low permissions → "safe plugin" notice, **no** scroll gate, Install enabled immediately.
- Any Medium/High/unknown → consent section + scroll-to-bottom anti-clickjacking gate before Install enables. The 4 px tolerance is exposed via `isScrolledToBottom(el, toleranceMs)` so tests can drive the math without jsdom layout.
- `http.fetch` row expands to show the manifest's `http.allowlist` verbatim.
- Default focus on Cancel; Escape key fires `onCancel`; backdrop click fires `onCancel`; modal-body click does **not**.
- Unknown permissions trigger a defensive fail-closed banner (the SDK and host disagree on catalog version — surface it, don't hide it).

### Update-diff component

`<PluginUpdateDiffDialog plugin fromVersion toVersion decision httpAllowlist? onUpdate onSkipVersion onUninstall onCancel />`. Driven by an already-classified `UpdateDiffDecision`. The caller MUST call `classifyUpdateDiff(diffPermissions(...))` first and only mount the dialog when `shouldShowUpdateDiffDialog(decision)` returns `true`.

Three render modes derived from `decision.kind`:

| `decision.kind` | Render | Update gated by scroll? | Caller behavior |
| --- | --- | --- | --- |
| `auto-approve` | "No new permissions" notice (defensive — caller should not have rendered this). | No | Install silently. |
| `auto-approve-with-toast` | Informational list of added Low permissions. | No | Surface a toast then install. |
| `requires-consent` | Full risk-grouped list with NEW badges + "Permissions removed" footer + scroll gate. | Yes | Block until user re-consents. |

Behavioral invariants (covered by `frontend/src/__tests__/PluginUpdateDiffDialog.test.tsx`):

- `Skip this version` is per-version (vNew+1 re-prompts). The caller persists the rejection.
- `Uninstall` is offered as an escape hatch — nothing forces an update.
- The "Permissions removed" footer is collapsed by default and only renders when `decision.removed.length > 0`. `auto-approve` discards removed info by construction.
- Helper `decisionNeedsScrollGate(decision)` lets callers conditionally skip the gate (e.g. for trusted publishers the marketplace already vetted).

### Wiring

- The marketplace install flow (PRO-005) consumes `<PluginConsentDialog />` directly when the user clicks Install on a listing.
- The CORE-007 loader's update path will consume `<PluginUpdateDiffDialog />` once the registry surfaces a newer version (deferred to **SDK-008c**, gated on PRO-003 marketplace catalog endpoint).
- The `Report` button currently routes to `mailto:abuse@velxio.dev`. Marketplace-side abuse queue is **PRO-011**.

## References

- Catalog source: [`packages/sdk/src/permissions.ts`](../packages/sdk/src/permissions.ts)
- Runtime catalog: [`packages/sdk/src/permissions-catalog.ts`](../packages/sdk/src/permissions-catalog.ts)
- Consent dialog: [`frontend/src/components/plugin-host/PluginConsentDialog.tsx`](../frontend/src/components/plugin-host/PluginConsentDialog.tsx)
- Update diff dialog: [`frontend/src/components/plugin-host/PluginUpdateDiffDialog.tsx`](../frontend/src/components/plugin-host/PluginUpdateDiffDialog.tsx)
- Manifest validation rule for `http.fetch` ⇒ `http.allowlist`: [`packages/sdk/src/manifest.ts`](../packages/sdk/src/manifest.ts)
- Host gate implementation: [`frontend/src/plugin-host/PermissionGate.ts`](../frontend/src/plugin-host/PermissionGate.ts)
- ScopedFetch caps & enforcer: [`frontend/src/plugin-host/ScopedFetch.ts`](../frontend/src/plugin-host/ScopedFetch.ts)
- Plugin SDK author guide: [`docs/PLUGIN_SDK.md`](./PLUGIN_SDK.md)
- Compile middleware contract: [`docs/COMPILE_MIDDLEWARE.md`](./COMPILE_MIDDLEWARE.md)
- Event bus contract: [`docs/EVENT_BUS.md`](./EVENT_BUS.md)
