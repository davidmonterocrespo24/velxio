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
| `simulator.pins.write`           | Medium | Driving inputs of a component your simulation owns (e.g. button → MCU pin). Reserved for the high-level `PartSimulationAPI` (SDK-003b).         | Forcing pins on components your plugin did not register, mutating MCU registers directly.                                         | Manifest declaration only (gate lands in SDK-003b).  |
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

(Specification — implementation lives in **SDK-008b** because it consumes CORE-008's "Installed Plugins" panel.)

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

(Specification — implementation in **SDK-008b**.)

When a plugin update arrives (CORE-007 loader detects a new version in the registry):

1. Compute `added = new.permissions - old.permissions`.
2. **If `added` is empty**, auto-update silently (still log the version bump in the editor's plugin activity panel).
3. **If `added` contains only Low-risk permissions**, auto-update and surface a dismissible toast: *"<plugin> was updated and now uses: <permissions>"*.
4. **If `added` contains any Medium or High permission**, **block** the update. The plugin keeps running on its old version until the user opens the "Pending updates" panel and re-confirms with a dialog identical to the install consent — but with an "Added since v<old>" header on the changed rows.
5. If the user cancels, the plugin stays pinned at the old version. The loader does not retry the update until the user explicitly clicks "Update now."

Removed permissions never trigger a dialog — narrowing the surface is always strictly safer. The diff is logged so reviewers can spot suspicious oscillation (a plugin that pulls a permission, waits a release, and re-adds it under user fatigue).

The `manifest.permissions` array is sorted at validation time (SDK-001) so the diff is order-stable — no false positives from a re-ordered list.

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

## References

- Catalog source: [`packages/sdk/src/permissions.ts`](../packages/sdk/src/permissions.ts)
- Manifest validation rule for `http.fetch` ⇒ `http.allowlist`: [`packages/sdk/src/manifest.ts`](../packages/sdk/src/manifest.ts)
- Host gate implementation: [`frontend/src/plugin-host/PermissionGate.ts`](../frontend/src/plugin-host/PermissionGate.ts)
- ScopedFetch caps & enforcer: [`frontend/src/plugin-host/ScopedFetch.ts`](../frontend/src/plugin-host/ScopedFetch.ts)
- Plugin SDK author guide: [`docs/PLUGIN_SDK.md`](./PLUGIN_SDK.md)
- Compile middleware contract: [`docs/COMPILE_MIDDLEWARE.md`](./COMPILE_MIDDLEWARE.md)
- Event bus contract: [`docs/EVENT_BUS.md`](./EVENT_BUS.md)
