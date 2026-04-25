/**
 * Permission catalog — runtime data backing the consent and update-diff UX.
 *
 * Every entry in `PLUGIN_PERMISSIONS` (`./permissions`) has exactly one
 * row here, with:
 *
 *   - `risk` — Low / Medium / High (the marketplace UX policy class).
 *   - `allows` — one-line plain-English description, surfaced in the
 *     consent dialog.
 *   - `denies` — one-line counter-description, shown in the expanded
 *     "What it does NOT allow" view for High-risk rows.
 *
 * The catalog is **the runtime source of truth**. The markdown catalog
 * in `docs/PLUGIN_PERMISSIONS.md` exists for human reading; a sync test
 * (`test/permissions-catalog-sync.test.ts`) parses the table and fails CI
 * if the two drift. This avoids parsing markdown at runtime — the
 * document is for humans, the constant is for code.
 *
 * Re-classifying a permission's risk = breaking change to user-visible
 * consent UX. Touch this file ONLY together with the markdown table and
 * an entry in the project changelog.
 */

import { PLUGIN_PERMISSIONS, type PluginPermission } from './permissions';

export type PermissionRisk = 'low' | 'medium' | 'high';

export interface PermissionCatalogEntry {
  readonly permission: PluginPermission;
  readonly risk: PermissionRisk;
  /** One-line "What it allows" — shown in the consent dialog row. */
  readonly allows: string;
  /** One-line "What it does NOT allow" — shown when the row is expanded. */
  readonly denies: string;
}

/**
 * Catalog. Order is intentional and matches `PLUGIN_PERMISSIONS` so a
 * reader can pair them up by index. The sync test asserts both arrays
 * stay aligned.
 */
export const PERMISSION_CATALOG: ReadonlyArray<PermissionCatalogEntry> = [
  // Simulator
  {
    permission: 'simulator.events.read',
    risk: 'low',
    allows:
      'Subscribing to ctx.events.on(...) — pin changes, serial TX, simulator lifecycle, SPICE step. Read-only stream.',
    denies:
      'Modifying simulator state, writing to pins, intercepting events from other plugins.',
  },
  {
    permission: 'simulator.pins.read',
    risk: 'low',
    allows:
      'Registering a PartSimulation whose onPinStateChange and SDK attachEvents observe pin transitions for a specific component.',
    denies:
      'Reading or driving pins of components your plugin did not register, sniffing the bus globally.',
  },
  {
    permission: 'simulator.pins.write',
    risk: 'medium',
    allows:
      'Driving inputs of a component your simulation owns (e.g. button → MCU pin) and scheduling cycle-accurate pin transitions via handle.schedulePinChange().',
    denies:
      'Forcing pins on components your plugin did not register, mutating MCU registers directly.',
  },
  {
    permission: 'simulator.pwm.read',
    risk: 'low',
    allows:
      'Subscribing to PWM duty-cycle changes on one of your component pins via handle.onPwmChange(pinName, duty => …). Read-only observer.',
    denies:
      "Driving PWM on the MCU side, observing PWM on pins your plugin did not register, intercepting another part's PWM callbacks.",
  },
  {
    permission: 'simulator.spi.read',
    risk: 'low',
    allows:
      'Observing bytes the MCU transmits on the hardware SPI bus via handle.onSpiTransmit(byte => …). Read-only observer, shared bus today.',
    denies:
      'Transmitting SPI bytes as a master, modifying in-flight bytes, observing SPI on another plugin\'s parts in isolation — every subscriber sees the same bus stream.',
  },
  {
    permission: 'simulator.spi.write',
    risk: 'high',
    allows:
      'Registering as a virtual SPI slave via handle.registerSpiSlave(handler). The slave responds with bytes on MISO, which the sketch interprets as real device data (TFT readback, flash memory, microSD).',
    denies:
      'Acting as an SPI master, listening on buses your plugin is not actively slaved to, displacing another plugin\'s slave silently (last-writer-wins logs a warn and stops the previous handler).',
  },
  {
    permission: 'simulator.i2c.read',
    risk: 'low',
    allows:
      'Observing completed I²C transactions on the bus via handle.onI2cTransfer(event => …) (reserved for future use — not emitted by the AVR host yet).',
    denies:
      'Driving the bus as slave, modifying transaction payloads, intercepting another plugin\'s slave traffic.',
  },
  {
    permission: 'simulator.i2c.write',
    risk: 'high',
    allows:
      'Registering as a virtual I²C slave at a 7-bit address via handle.registerI2cSlave(addr, handler). The slave participates in the bus protocol and drives MCU-visible state.',
    denies:
      'Registering on the host\'s reserved ranges, displacing another plugin\'s slave without disposing first (last-writer-wins, but the dispose handle is yours to manage), acting as master.',
  },
  {
    permission: 'simulator.serial.write',
    risk: 'high',
    allows:
      'Injecting bytes into the MCU\'s UART0 RX line via api.serial.write(data) (high-level part API), as if the user typed in the Serial Monitor. Used by virtual modems, GPS feeds, command-response peripherals.',
    denies:
      'Writing to UART ports other than UART0 (single-port today; multi-port via optional port parameter when supported), reading what the MCU subsequently echoes back (subscribe via simulator.events.read or api.serial.onRead), driving any other simulator state.',
  },
  {
    permission: 'simulator.analog.write',
    risk: 'high',
    allows:
      'Injecting an analog voltage on the ADC channel backing a component pin via handle.setAnalogValue(pinName, volts). The host converts to the right board-specific raw sample (10/12-bit).',
    denies:
      'Driving pins your plugin did not register, reading the resulting ADC sample back, modifying the ADC reference voltage or resolution, injecting values on analog pins of components you do not own.',
  },
  {
    permission: 'simulator.sensors.read',
    risk: 'low',
    allows:
      'Subscribing to values from the user-facing SensorControlPanel via handle.onSensorControlUpdate(values => …). Read-only observation of user input sliders/toggles for your component instance.',
    denies:
      'Reading sensor values of components your plugin did not register, driving MCU state directly (setAnalogValue / setPinState require their own gates), modifying the control panel itself.',
  },
  {
    permission: 'simulator.spice.read',
    risk: 'low',
    allows:
      'Registering a SPICE mapper for a component (ctx.spice.registerMapper) and contributing SPICE model cards (ctx.spice.registerModel).',
    denies:
      "Solving the netlist directly, reading other plugins' mappers, reaching into ngspice internals.",
  },
  // Compile
  {
    permission: 'compile.transform.client',
    risk: 'medium',
    allows:
      'Registering a client-side compile middleware (transform sketch source before send to backend). Server middleware is host-only.',
    denies:
      "Server middleware (Python), bypassing arduino-cli, intercepting another plugin's middleware, persistent code modification.",
  },
  // UI
  {
    permission: 'ui.command.register',
    risk: 'low',
    allows: 'Adding entries to the command palette via ctx.commands.register().',
    denies:
      'Removing or replacing built-in commands, simulating user clicks on commands you did not register.',
  },
  {
    permission: 'ui.toolbar.register',
    risk: 'low',
    allows: 'Adding toolbar buttons via ctx.toolbar.register().',
    denies:
      'Reordering or removing built-in toolbar buttons, intercepting clicks on other buttons.',
  },
  {
    permission: 'ui.panel.register',
    risk: 'low',
    allows: 'Adding sidebar/bottom panels via ctx.panels.register().',
    denies: 'Reading content of other panels, replacing built-in panels.',
  },
  {
    permission: 'ui.statusbar.register',
    risk: 'low',
    allows:
      'Adding status-bar items via ctx.statusBar.register() (and the deprecated ctx.statusbar.add() alias).',
    denies: "Reading other plugins' status-bar items.",
  },
  {
    permission: 'ui.context-menu.register',
    risk: 'low',
    allows: 'Adding right-click menu entries via ctx.contextMenu.register().',
    denies:
      'Suppressing built-in context-menu items, intercepting clicks on items you did not register.',
  },
  {
    permission: 'ui.editor.action.register',
    risk: 'low',
    allows: 'Adding Monaco editor actions (Cmd-K-style) via ctx.editorActions.register().',
    denies: 'Listening to keystrokes globally, reading the editor buffer wholesale.',
  },
  {
    permission: 'ui.canvas.overlay.register',
    risk: 'low',
    allows:
      'Drawing overlays on the simulator canvas via ctx.canvasOverlays.register().',
    denies:
      "Capturing the canvas as a bitmap, intercepting mouse events outside your overlay's hit area.",
  },
  // Storage
  {
    permission: 'storage.user.read',
    risk: 'low',
    allows:
      'Reading from the per-user, cross-workspace key-value store via ctx.userStorage.get() / keys().',
    denies:
      "Reading another plugin's storage (the namespace is pluginId-scoped), reading user cookies, reading editor LocalStorage.",
  },
  {
    permission: 'storage.user.write',
    risk: 'medium',
    allows:
      'Writing to the per-user store via ctx.userStorage.set() / delete() / clear(). Capped at 1 MB per plugin per user.',
    denies:
      "Exceeding the quota, writing to other plugins' namespaces, persisting globally across users.",
  },
  {
    permission: 'storage.workspace.read',
    risk: 'low',
    allows:
      'Reading the per-project (workspace-scoped) store via ctx.workspaceStorage.get() / keys().',
    denies:
      "Reading other workspaces' storage, reading workspace files outside the K/V store.",
  },
  {
    permission: 'storage.workspace.write',
    risk: 'medium',
    allows:
      'Writing to the per-project store via ctx.workspaceStorage.set() / delete() / clear(). Same 1 MB cap as user storage.',
    denies:
      'Exceeding the quota, writing to other workspaces, modifying project files outside the K/V store.',
  },
  // Network
  {
    permission: 'http.fetch',
    risk: 'high',
    allows:
      'Calling ctx.fetch(url, init). Each request must match a prefix in manifest.http.allowlist (HTTPS only, ≤10 entries, ≤4 MB per response).',
    denies:
      "HTTP (non-TLS) URLs, allowlist bypass, sending cookies (credentials: 'omit' is forced), reading another plugin's response body.",
  },
  // Content
  {
    permission: 'components.register',
    risk: 'medium',
    allows:
      'Contributing component definitions via ctx.components.register(). Last-writer-wins inside the same plugin; cross-plugin collisions throw.',
    denies:
      'Replacing built-in components, modifying components registered by another plugin, deleting components.',
  },
  {
    permission: 'libraries.provide',
    risk: 'medium',
    allows:
      'Contributing Arduino library bundles via ctx.libraries.register(). Caps: ≤2 MB total, ≤512 KB per file, allow-listed extensions and pragmas.',
    denies:
      'Shipping ELF/HEX binaries, native code, files with ".." in #include, last-writer-wins on cross-plugin id collisions.',
  },
  {
    permission: 'templates.provide',
    risk: 'low',
    allows:
      'Contributing project templates (board + files + components + wires) via ctx.templates.register(). Caps: ≤1 MB total, ≤64 files, ≤500 KB each.',
    denies: 'Replacing built-in templates, instantiating templates without explicit user action.',
  },
  // Settings
  {
    permission: 'settings.declare',
    risk: 'low',
    allows:
      'Calling ctx.settings.declare() to register a settings schema. Reads/writes/onChange need no further permission once declared.',
    denies:
      'Reading another plugin\'s settings, declaring more than one schema (re-declare overwrites in place atomically).',
  },
];

// Lookup index — built once, reused across every consent dialog render.
const CATALOG_INDEX: ReadonlyMap<PluginPermission, PermissionCatalogEntry> = new Map(
  PERMISSION_CATALOG.map((entry) => [entry.permission, entry] as const),
);

/** O(1) lookup. Returns `undefined` for an unknown permission. */
export function getPermissionEntry(
  permission: PluginPermission,
): PermissionCatalogEntry | undefined {
  return CATALOG_INDEX.get(permission);
}

export interface PartitionedPermissions {
  readonly low: ReadonlyArray<PermissionCatalogEntry>;
  readonly medium: ReadonlyArray<PermissionCatalogEntry>;
  readonly high: ReadonlyArray<PermissionCatalogEntry>;
  readonly unknown: ReadonlyArray<PluginPermission>;
}

/**
 * Group a manifest's `permissions[]` by risk class. Unknown permissions
 * (declared by the manifest but missing from the catalog — only happens
 * if the SDK and the host disagree on the catalog version) land in
 * `unknown` so the UI can flag them defensively.
 */
export function partitionPermissionsByRisk(
  permissions: ReadonlyArray<PluginPermission>,
): PartitionedPermissions {
  const low: PermissionCatalogEntry[] = [];
  const medium: PermissionCatalogEntry[] = [];
  const high: PermissionCatalogEntry[] = [];
  const unknown: PluginPermission[] = [];
  for (const perm of permissions) {
    const entry = CATALOG_INDEX.get(perm);
    if (entry === undefined) {
      unknown.push(perm);
      continue;
    }
    if (entry.risk === 'low') low.push(entry);
    else if (entry.risk === 'medium') medium.push(entry);
    else high.push(entry);
  }
  return { low, medium, high, unknown };
}

/**
 * Whether installing/updating a plugin with these permissions requires
 * a consent dialog. `true` iff at least one Medium/High permission is
 * present, OR any unknown permission appears (defensive fail-closed).
 */
export function requiresConsent(
  permissions: ReadonlyArray<PluginPermission>,
): boolean {
  for (const perm of permissions) {
    const entry = CATALOG_INDEX.get(perm);
    if (entry === undefined) return true;
    if (entry.risk !== 'low') return true;
  }
  return false;
}

export interface PermissionDiff {
  readonly added: ReadonlyArray<PluginPermission>;
  readonly removed: ReadonlyArray<PluginPermission>;
}

/**
 * Compute the diff between two permission sets. Order-stable; both
 * inputs are de-duplicated before comparison. Used by the update-diff
 * dialog to decide whether to auto-approve, surface a toast, or block
 * pending consent.
 */
export function diffPermissions(
  oldPermissions: ReadonlyArray<PluginPermission>,
  newPermissions: ReadonlyArray<PluginPermission>,
): PermissionDiff {
  const oldSet = new Set(oldPermissions);
  const newSet = new Set(newPermissions);
  const added: PluginPermission[] = [];
  const removed: PluginPermission[] = [];
  for (const perm of newSet) if (!oldSet.has(perm)) added.push(perm);
  for (const perm of oldSet) if (!newSet.has(perm)) removed.push(perm);
  return { added, removed };
}

export type UpdateDiffDecision =
  /** added=∅: silent install. */
  | { readonly kind: 'auto-approve' }
  /** added contains only Low: surface a toast, then install. */
  | {
      readonly kind: 'auto-approve-with-toast';
      readonly added: ReadonlyArray<PermissionCatalogEntry>;
    }
  /** added contains at least one Medium/High (or unknown): block until user re-consents. */
  | {
      readonly kind: 'requires-consent';
      readonly added: ReadonlyArray<PluginPermission>;
      readonly addedHighRisk: PartitionedPermissions;
      readonly removed: ReadonlyArray<PluginPermission>;
    };

/**
 * Map a `PermissionDiff` to the policy decision the loader takes when an
 * update is detected. Centralizing this here keeps the policy
 * documented (catalog) and tested (one place) instead of being scattered
 * across UI hooks.
 */
export function classifyUpdateDiff(diff: PermissionDiff): UpdateDiffDecision {
  if (diff.added.length === 0) return { kind: 'auto-approve' };
  const partitioned = partitionPermissionsByRisk(diff.added);
  if (partitioned.medium.length === 0 && partitioned.high.length === 0 && partitioned.unknown.length === 0) {
    return { kind: 'auto-approve-with-toast', added: partitioned.low };
  }
  return {
    kind: 'requires-consent',
    added: diff.added,
    addedHighRisk: partitioned,
    removed: diff.removed,
  };
}

// Type-level guard: every PluginPermission has a catalog entry.
// Compile-time check (relaxed at runtime via test/permissions-catalog.test.ts).
type _CatalogIsExhaustive = Exclude<
  PluginPermission,
  (typeof PERMISSION_CATALOG)[number]['permission']
>;
const _exhaustive: _CatalogIsExhaustive[] = [];
void _exhaustive;
void PLUGIN_PERMISSIONS;
