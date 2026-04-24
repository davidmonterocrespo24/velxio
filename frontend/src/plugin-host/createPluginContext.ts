/**
 * `createPluginContext()` — the host's PluginContext factory.
 *
 * Wires together:
 *   - The shared host registries (components, parts, spice mapper) — these
 *     are SINGLETONS so plugins and built-ins coexist in the same picker /
 *     simulation pipeline.
 *   - Per-plugin UI registries (commands, toolbar, panels, …) — these are
 *     fresh instances per `createPluginContext` call so that disposing one
 *     plugin doesn't tear down items registered by another. A higher-level
 *     "plugin host registry" (CORE-007) will own the union of these.
 *   - A per-plugin storage (in-memory by default, swap for IndexedDB later).
 *   - A scoped fetch built from the manifest's `http.allowlist`.
 *   - An EventBusReader (read-only view of the host's existing event bus).
 *   - An `addDisposable()` collector so the host can `deactivate()` the
 *     plugin cleanly even if the plugin doesn't return its disposables.
 *
 * Every registry method that mutates host state is wrapped in
 * `requirePermission()` — a missing permission throws `PermissionDeniedError`
 * synchronously, before any state changes.
 */

import type {
  CanvasOverlayDefinition,
  CanvasOverlayRegistry,
  CommandDefinition,
  CommandRegistry,
  ComponentDefinition,
  ComponentRegistry as SdkComponentRegistry,
  CompoundComponentDefinition,
  ContextMenuItemDefinition,
  ContextMenuRegistry,
  Disposable,
  EditorActionDefinition,
  EditorActionRegistry,
  EventBusReader,
  HighLevelPartSimulation,
  I2CTransferEvent,
  LibraryDefinition,
  LibraryRegistry as SdkLibraryRegistry,
  PanelDefinition,
  PanelRegistry,
  PartI2CAPI,
  PartPinAPI,
  PartPinLevel,
  PartSerialAPI,
  PartSimulation,
  PartSimulationAPI,
  PartSimulationRegistry as SdkPartSimulationRegistry,
  PinState,
  PluginContext,
  PluginManifest,
  PluginStorage,
  ScopedFetch,
  SettingsAPI,
  SettingsDeclaration,
  SimulatorHandle,
  SpiceMapper,
  SpiceRegistry,
  StatusBarItemDefinition,
  StatusBarRegistry,
  TemplateDefinition,
  TemplateRegistry as SdkTemplateRegistry,
  ToolbarItemDefinition,
  ToolbarRegistry,
} from '@velxio/sdk';
import {
  DuplicateComponentError,
  DuplicateLibraryError,
  DuplicateTemplateError,
} from '@velxio/sdk';

import { requirePermission } from './PermissionGate';
import {
  InMemoryCanvasOverlayRegistry,
  InMemoryCommandRegistry,
  InMemoryContextMenuRegistry,
  InMemoryEditorActionRegistry,
  InMemoryPanelRegistry,
  InMemoryStatusBarRegistry,
  InMemoryToolbarRegistry,
} from './UIRegistries';
import { InMemoryPluginStorage, type StorageBackend } from './PluginStorage';
import { createScopedFetch, type ScopedFetchOptions } from './ScopedFetch';
import { createPluginLogger } from './PluginLogger';
import { SpiceModelRegistry } from './SpiceModelRegistry';
import { HostDisposableStore } from './DisposableStore';

import componentRegistry from '../services/ComponentRegistry';
import { PartSimulationRegistry as hostPartRegistry } from '../simulation/parts/PartSimulationRegistry';
import { getSpiceMapperRegistry, asSdkMapper } from '../simulation/spice/SpiceMapperRegistry';
import { getTemplateRegistry } from './TemplateRegistry';
import { getLibraryRegistry } from './LibraryRegistry';
import { createPluginI18n } from './I18nRegistry';
import { createPluginSettings } from './SettingsRegistry';
import { getHostSlotRegistry } from './HostSlotRegistry';

/**
 * Host-provided services that every plugin sees. Tests can pass mocks here;
 * the production wiring (in `loadPlugin()` / CORE-007) hands the singletons.
 *
 * The two storage backend slots are populated PER PLUGIN by
 * `PluginManager.load()` — it awaits `storageBackendFactory(id, bucket)`
 * before constructing the `PluginHost`. `createPluginContext` itself is
 * still synchronous; it just consumes already-built backends.
 */
export interface PluginHostServices {
  readonly events: EventBusReader;
  /** Override the underlying fetch (tests). */
  readonly fetchImpl?: typeof fetch;
  /** Optional override for max body bytes. */
  readonly fetchMaxBytes?: number;
  /** Pre-built backend for `ctx.userStorage`. Defaults to `MapStorageBackend` (in-memory). */
  readonly userStorageBackend?: StorageBackend;
  /** Pre-built backend for `ctx.workspaceStorage`. Defaults to `MapStorageBackend` (in-memory). */
  readonly workspaceStorageBackend?: StorageBackend;
}

/**
 * UI registries returned alongside the context — the host's slot renderer
 * subscribes to these to project plugin contributions into the editor.
 * The plugin itself only sees them through `ctx`.
 */
export interface PluginUIRegistries {
  readonly commands: InMemoryCommandRegistry;
  readonly toolbar: InMemoryToolbarRegistry;
  readonly panels: InMemoryPanelRegistry;
  readonly statusBar: InMemoryStatusBarRegistry;
  readonly editorActions: InMemoryEditorActionRegistry;
  readonly canvasOverlays: InMemoryCanvasOverlayRegistry;
  readonly contextMenu: InMemoryContextMenuRegistry;
  readonly spiceModels: SpiceModelRegistry;
}

export interface CreatedPluginContext {
  /** The context handed to the plugin's `activate(ctx)`. */
  readonly context: PluginContext;
  /** The fresh UI registries owned by this plugin (renderer reads them). */
  readonly ui: PluginUIRegistries;
  /**
   * Dispose every resource the plugin acquired. Called by the host on
   * plugin uninstall / hot-reload / `deactivate()`. Idempotent.
   */
  dispose(): void;
}

export function createPluginContext(
  manifest: PluginManifest,
  services: PluginHostServices,
): CreatedPluginContext {
  // ── per-plugin UI registries ─────────────────────────────────────────────
  const ui: PluginUIRegistries = {
    commands: new InMemoryCommandRegistry(),
    toolbar: new InMemoryToolbarRegistry(),
    panels: new InMemoryPanelRegistry(),
    statusBar: new InMemoryStatusBarRegistry(),
    editorActions: new InMemoryEditorActionRegistry(),
    canvasOverlays: new InMemoryCanvasOverlayRegistry(),
    contextMenu: new InMemoryContextMenuRegistry(),
    spiceModels: new SpiceModelRegistry(),
  };

  const logger = createPluginLogger(manifest);
  // Per-plugin i18n surface — wraps the shared locale store + this
  // plugin's own bundle. No permission gate: translations are read-only
  // local data, no sensitive surface to protect.
  const i18n = createPluginI18n(manifest, logger);

  // Per-plugin settings surface. Only the entry point (`declare`) is
  // gated on `settings.declare`; reads/writes against the plugin's own
  // namespace need no further permission. The host-side adapter wraps
  // `declare` to enforce the gate and to thread the plugin id through.
  const settingsHost = createPluginSettings(manifest, logger);
  const settings: SettingsAPI = {
    declare: (declaration: SettingsDeclaration) => {
      requirePermission(manifest, 'settings.declare');
      const handle = settingsHost.declare(declaration);
      subscriptions.add(handle);
      return handle;
    },
    get: () => settingsHost.get(),
    set: (partial) => settingsHost.set(partial),
    reset: () => settingsHost.reset(),
    onChange: (fn) => settingsHost.onChange(fn),
  };

  // Single store backing both `ctx.subscriptions` and the host's own
  // tear-down sweep. Every registry adapter pushes its handle here so the
  // plugin's `dispose()` and the host's `dispose()` traverse the SAME
  // LIFO list — no risk of double-dispose, no risk of an
  // adapter-tracked handle living past the plugin's deactivate.
  const subscriptions = new HostDisposableStore(logger, `plugin "${manifest.id}"`);

  // Bridge this plugin's per-plugin UI registries into the host-wide slot
  // aggregator (CORE-002b). The bridge is added LAST so it's first to be
  // disposed on plugin tear-down — that way the SlotOutlet sees the
  // plugin's items leave before the per-plugin registries themselves are
  // torn down. The mount happens at the end of this function, once `ui`
  // is fully constructed. We just reserve the disposal slot here so the
  // tear-down order is documented even though the bridge itself doesn't
  // exist yet.

  // ── gated registry adapters ──────────────────────────────────────────────
  const components: SdkComponentRegistry = {
    register: (definition: ComponentDefinition) => {
      requirePermission(manifest, 'components.register');
      // Plugins must NOT silently shadow built-ins or other plugins. The host
      // registry itself is last-writer-wins (built-ins seed first), but at
      // the plugin gate we refuse collisions with a typed error so authors
      // see the conflict at activation, not at runtime when their picker
      // entry mysteriously points at someone else's renderer.
      if (componentRegistry.get(definition.id) !== undefined) {
        throw new DuplicateComponentError(definition.id, manifest.id);
      }
      const handle = componentRegistry.register(definition);
      subscriptions.add(handle);
      return handle;
    },
    registerCompound: (definition: CompoundComponentDefinition) => {
      // Fan out to the existing register*() entry points so each call goes
      // through its own permission gate + fault-isolation envelope. The
      // closure references `partSimulations` and `spice` declared further
      // down — resolved at call time, never synchronously between consts.
      //
      // Rollback contract: if any sub-registration throws (typically a
      // missing permission), every prior handle is disposed in LIFO order
      // before the throw is re-raised. The component never appears
      // half-registered in the picker.
      const acquired: Disposable[] = [];
      try {
        acquired.push(components.register(definition));
        if (definition.simulation) {
          acquired.push(partSimulations.register(definition.id, definition.simulation));
        }
        if (definition.spice) {
          acquired.push(spice.registerMapper(definition.id, definition.spice));
        }
        if (definition.spiceModels) {
          for (const m of definition.spiceModels) {
            acquired.push(spice.registerModel(m.name, m.card));
          }
        }
      } catch (err) {
        for (let i = acquired.length - 1; i >= 0; i--) {
          try {
            acquired[i].dispose();
          } catch (rollbackErr) {
            logger.error(
              `registerCompound rollback dispose threw for "${definition.id}":`,
              rollbackErr,
            );
          }
        }
        throw err;
      }
      // The acquired sub-handles are already in `subscriptions` (each
      // register*() pushed one). The compound handle is a thin wrapper
      // that disposes them eagerly when the plugin asks; on plugin
      // teardown, `subscriptions.dispose()` would run them again — safe
      // because every host disposable is idempotent.
      let disposed = false;
      const handle: Disposable = {
        dispose: () => {
          if (disposed) return;
          disposed = true;
          for (let i = acquired.length - 1; i >= 0; i--) {
            try {
              acquired[i].dispose();
            } catch (err) {
              logger.error(
                `registerCompound dispose threw for "${definition.id}":`,
                err,
              );
            }
          }
        },
      };
      return handle;
    },
    get: (id) => componentRegistry.get(id),
    list: () => componentRegistry.list(),
  };

  const partSimulations: SdkPartSimulationRegistry = {
    register: (componentId: string, sim: PartSimulation) => {
      // Plugin-registered part simulations require both registration and
      // pin-write permission, since attachEvents is the path that calls
      // `setPinState()`. We gate on register only — the SDK's pins.write
      // gate is intentionally separate so a part can be observe-only.
      requirePermission(manifest, 'simulator.pins.read');
      // Fault-isolate the plugin: any throw from `attachEvents` or
      // `onPinStateChange` is logged via the plugin's logger and swallowed,
      // never bubbled into the host simulator loop. A throwing
      // `attachEvents` returns a no-op cleanup so the host's later
      // teardown call can't double-fault.
      const safeSim: PartSimulation = {};
      if (sim.onPinStateChange) {
        const original = sim.onPinStateChange;
        safeSim.onPinStateChange = (pinName, state, element) => {
          try {
            original(pinName, state, element);
          } catch (err) {
            logger.error(
              `onPinStateChange threw for component "${componentId}" pin "${pinName}":`,
              err,
            );
          }
        };
      }
      if (sim.attachEvents) {
        const original = sim.attachEvents;
        safeSim.attachEvents = (element: HTMLElement, simHandle: SimulatorHandle) => {
          try {
            const cleanup = original(element, simHandle);
            return () => {
              try {
                cleanup();
              } catch (err) {
                logger.error(
                  `attachEvents cleanup threw for component "${componentId}":`,
                  err,
                );
              }
            };
          } catch (err) {
            logger.error(
              `attachEvents threw for component "${componentId}":`,
              err,
            );
            return () => {};
          }
        };
      }
      const handle = hostPartRegistry.registerSdkPart(componentId, safeSim);
      subscriptions.add(handle);
      return handle;
    },
    registerHighLevel: (componentId: string, definition: HighLevelPartSimulation) => {
      // Same register-time gate as `register()` — the author needs
      // `simulator.pins.read` to subscribe to any pin at all. `pin().set()`
      // is additionally gated at call time on `simulator.pins.write`.
      requirePermission(manifest, 'simulator.pins.read');
      // Build a low-level `PartSimulation` whose `attachEvents(element, handle)`
      // constructs a `PartSimulationAPI` from:
      //   - `handle.onPinChange` + `handle.setPinState` → `pin()`
      //   - `services.events.on('serial:tx', …)`        → `serial.onRead`
      //   - `services.events.on('i2c:transfer', …)`     → `i2c.onTransfer`
      // Everything the author subscribes via `api.*` is tracked in a local
      // disposable array so the composed teardown kills every piece — even
      // if the author's own teardown throws.
      const declaredPins = new Set(definition.pins);
      const sim: PartSimulation = {
        attachEvents: (element: HTMLElement, handle: SimulatorHandle) => {
          const api = buildPartSimulationAPI({
            manifest,
            handle,
            events: services.events,
            declaredPins,
            logger,
          });
          let authorTeardown: () => void = () => {};
          try {
            authorTeardown = definition.attach(element, api.api);
          } catch (err) {
            logger.error(
              `high-level attach threw for component "${componentId}":`,
              err,
            );
          }
          return () => {
            // Author teardown first so they get to release any external
            // handles before the pin/serial/i2c subscriptions go away.
            try {
              authorTeardown();
            } catch (err) {
              logger.error(
                `high-level teardown threw for component "${componentId}":`,
                err,
              );
            }
            api.dispose();
          };
        },
      };
      // Route through the existing low-level path so the fault-isolation
      // wrapper we just set up for `register()` doesn't have to be
      // duplicated here. Re-use the same register() path (with its
      // `simulator.pins.read` gate — which we've already passed above,
      // and `requirePermission` is idempotent / cheap).
      return partSimulations.register(componentId, sim);
    },
    get: (componentId) => hostPartRegistry.get(componentId) as PartSimulation | undefined,
  };

  const templates: SdkTemplateRegistry = {
    register: (definition: TemplateDefinition) => {
      requirePermission(manifest, 'templates.provide');
      // Same rationale as DuplicateComponentError: silent shadowing of an
      // existing template id would mean two plugins racing for the same
      // picker entry. Authors get a typed error at activation; to replace
      // their own entry they dispose the old handle first.
      if (getTemplateRegistry().get(definition.id) !== undefined) {
        throw new DuplicateTemplateError(definition.id, manifest.id);
      }
      const handle = getTemplateRegistry().registerFromPlugin(definition, manifest.id);
      subscriptions.add(handle);
      return handle;
    },
    get: (id) => getTemplateRegistry().get(id),
    list: () => getTemplateRegistry().list(),
  };

  const libraries: SdkLibraryRegistry = {
    register: (definition: LibraryDefinition) => {
      requirePermission(manifest, 'libraries.provide');
      // Library ids must be unique across the process — arduino-cli
      // identifies libraries by folder name, and two libraries with the
      // same id would silently collide in the temp build dir.
      if (getLibraryRegistry().get(definition.id) !== undefined) {
        throw new DuplicateLibraryError(definition.id, manifest.id);
      }
      const handle = getLibraryRegistry().registerFromPlugin(definition, manifest.id);
      subscriptions.add(handle);
      return handle;
    },
    get: (id) => getLibraryRegistry().get(id),
    list: () => getLibraryRegistry().list(),
    resolve: (ids) => getLibraryRegistry().resolve(ids),
  };

  const spice: SpiceRegistry = {
    registerMapper: (componentId: string, mapper: SpiceMapper) => {
      requirePermission(manifest, 'simulator.spice.read');
      const hostMapper = (
        comp: Parameters<typeof asSdkMapper extends (...a: never) => never ? never : Parameters<SpiceMapper>[0]>[0],
        netLookup: Parameters<SpiceMapper>[1],
        ctx: Parameters<SpiceMapper>[2],
      ) => mapper(comp, netLookup, ctx);
      // Adapt SDK mapper into the host's HostSpiceMapper shape — the host
      // version takes a richer `ComponentForSpice` view but the SDK type is
      // structurally a subset, so the cast is safe.
      const handle = getSpiceMapperRegistry().register(
        componentId,
        hostMapper as unknown as Parameters<typeof getSpiceMapperRegistry>[0] extends never
          ? never
          : Parameters<ReturnType<typeof getSpiceMapperRegistry>['register']>[1],
      );
      subscriptions.add(handle);
      return handle;
    },
    registerModel: (name: string, card: string) => {
      requirePermission(manifest, 'simulator.spice.read');
      const handle = ui.spiceModels.register(name, card);
      subscriptions.add(handle);
      return handle;
    },
    isReady: () => true,
  };

  // ── gated UI registries ──────────────────────────────────────────────────
  const commands: CommandRegistry = {
    register: (cmd: CommandDefinition) => {
      requirePermission(manifest, 'ui.command.register');
      const handle = ui.commands.register(cmd);
      subscriptions.add(handle);
      return handle;
    },
    execute: (id) => ui.commands.execute(id),
  };

  const toolbar: ToolbarRegistry = {
    register: (item: ToolbarItemDefinition) => {
      requirePermission(manifest, 'ui.toolbar.register');
      const handle = ui.toolbar.register(item);
      subscriptions.add(handle);
      return handle;
    },
  };

  const panels: PanelRegistry = {
    register: (panel: PanelDefinition) => {
      requirePermission(manifest, 'ui.panel.register');
      const handle = ui.panels.register(panel);
      subscriptions.add(handle);
      return handle;
    },
  };

  const statusBar: StatusBarRegistry = {
    register: (item: StatusBarItemDefinition) => {
      requirePermission(manifest, 'ui.statusbar.register');
      const handle = ui.statusBar.register(item);
      subscriptions.add(handle);
      return handle;
    },
    update: (id, patch) => {
      requirePermission(manifest, 'ui.statusbar.register');
      ui.statusBar.update(id, patch);
    },
  };

  const editorActions: EditorActionRegistry = {
    register: (action: EditorActionDefinition) => {
      requirePermission(manifest, 'ui.editor.action.register');
      const handle = ui.editorActions.register(action);
      subscriptions.add(handle);
      return handle;
    },
  };

  const canvasOverlays: CanvasOverlayRegistry = {
    register: (overlay: CanvasOverlayDefinition) => {
      requirePermission(manifest, 'ui.canvas.overlay.register');
      const handle = ui.canvasOverlays.register(overlay);
      subscriptions.add(handle);
      return handle;
    },
  };

  const contextMenu: ContextMenuRegistry = {
    register: (item: ContextMenuItemDefinition) => {
      requirePermission(manifest, 'ui.context-menu.register');
      const handle = ui.contextMenu.register(item);
      subscriptions.add(handle);
      return handle;
    },
  };

  // ── storage + fetch ──────────────────────────────────────────────────────
  // Use pre-built backends if the loader injected them (production: IndexedDB
  // backends pre-loaded asynchronously). Otherwise fall back to in-memory —
  // valid for tests, ephemeral plugin sessions, and the dev path before the
  // loader is wired in.
  const userBackend = services.userStorageBackend;
  const userStorageImpl = userBackend !== undefined
    ? new InMemoryPluginStorage('user', userBackend)
    : new InMemoryPluginStorage('user');
  const workspaceBackend = services.workspaceStorageBackend;
  const workspaceStorageImpl = workspaceBackend !== undefined
    ? new InMemoryPluginStorage('workspace', workspaceBackend)
    : new InMemoryPluginStorage('workspace');
  const userStorage: PluginStorage = wrapStorage(
    userStorageImpl,
    manifest,
    'storage.user.read',
    'storage.user.write',
  );
  const workspaceStorage: PluginStorage = wrapStorage(
    workspaceStorageImpl,
    manifest,
    'storage.workspace.read',
    'storage.workspace.write',
  );

  const fetchOptions: ScopedFetchOptions = {};
  if (services.fetchImpl !== undefined) fetchOptions.fetchImpl = services.fetchImpl;
  if (services.fetchMaxBytes !== undefined) fetchOptions.maxBytes = services.fetchMaxBytes;
  const baseFetch = createScopedFetch(manifest, fetchOptions);
  const fetch: ScopedFetch = async (input, init) => {
    requirePermission(manifest, 'http.fetch');
    return baseFetch(input, init);
  };

  // ── final context ────────────────────────────────────────────────────────
  const context: PluginContext = {
    manifest,
    logger,
    components,
    partSimulations,
    spice,
    templates,
    libraries,
    commands,
    toolbar,
    panels,
    statusBar,
    editorActions,
    canvasOverlays,
    contextMenu,
    events: services.events,
    i18n,
    settings,
    userStorage,
    workspaceStorage,
    fetch,
    subscriptions,
    addDisposable: (d: Disposable) => subscriptions.add(d),
  };

  // ── slot bridge ──────────────────────────────────────────────────────────
  // Wire this plugin's UI registries into the global slot aggregator so
  // `<SlotOutlet />` sees them. We KEEP the bridge handle outside
  // `subscriptions` on purpose: that store reflects what the plugin and
  // the host adapters explicitly tracked, and is read by tests + future
  // diagnostics. The slot bridge is pure host infrastructure — counting
  // it would inflate `subscriptions.size` by 1 for every plugin and
  // surprise authors. Disposed FIRST in the host wrapper so the slot
  // tables empty before the per-plugin registries go away.
  const slotBridge = getHostSlotRegistry().mountPlugin(manifest.id, ui);

  return {
    context,
    ui,
    // The store's own `dispose()` is idempotent + LIFO + error-isolated, so
    // the host wrapper just delegates. After this returns, every later
    // `subscriptions.add()` (e.g. from a still-pending plugin async task)
    // disposes its argument immediately so nothing leaks past activation.
    dispose: () => {
      try {
        slotBridge.dispose();
      } catch (err) {
        logger.error('slot bridge dispose threw:', err);
      }
      subscriptions.dispose();
    },
  };
}

/**
 * Translate a raw bus-level `PinState` (`0` / `1` / `'z'` / `'x'`) into
 * the high-level three-valued `PartPinLevel` that plugins see. Both
 * high-Z (`'z'`) and unknown (`'x'`) collapse to `'floating'` — plugins
 * that care about the distinction can subscribe to `pin:change` directly.
 */
function pinStateToLevel(state: PinState): PartPinLevel {
  if (state === 1) return 'high';
  if (state === 0) return 'low';
  return 'floating';
}

/**
 * Build the live `PartSimulationAPI` for one `attachEvents` call.
 *
 * Factored out so:
 *   1. The wiring logic (state tracking, event subscriptions, permission
 *      gating on `set()`) is unit-testable independent of
 *      `createPluginContext()`.
 *   2. `registerHighLevel()` above stays readable as the thin wrapper
 *      it's meant to be.
 *
 * Returns `{ api, dispose }`: the `api` object is what the plugin's
 * `attach(element, api)` receives; `dispose` releases every subscription
 * opened on behalf of the API (pin trackers, serial listeners, i2c
 * listeners). `dispose` is called by the `attachEvents` teardown
 * synthesized in `registerHighLevel` AFTER the author's own teardown so
 * authors can't observe a half-released API.
 */
function buildPartSimulationAPI(params: {
  manifest: PluginManifest;
  handle: SimulatorHandle;
  events: EventBusReader;
  declaredPins: ReadonlySet<string>;
  logger: ReturnType<typeof createPluginLogger>;
}): { api: PartSimulationAPI; dispose: () => void } {
  const { manifest, handle, events, declaredPins, logger } = params;

  // Per-pin tracked level + listener set. We initialize to 'floating' and
  // let the `onPinChange` subscription bring the value up to date on the
  // first transition. Reading current level from `PinManager.getPinState`
  // would remove the transition-delay but it's intentionally kept off the
  // SDK's `SimulatorHandle` contract to keep it minimal — revisit when we
  // have a concrete plugin that demands synchronous initial reads.
  interface PinTracker {
    level: PartPinLevel;
    listeners: Set<(level: PartPinLevel) => void>;
    subscription: Disposable;
  }
  const trackers = new Map<string, PinTracker>();
  const disposables: Disposable[] = [];

  // Pre-wire trackers for every declared pin so state is observed from the
  // moment `attach(...)` starts — even if the author never subscribes via
  // `onChange`, `pin(name).state` reflects the latest level.
  for (const pinName of declaredPins) {
    const tracker: PinTracker = {
      level: 'floating',
      listeners: new Set(),
      // Placeholder until we wire the real subscription below — TS can't
      // see the assignment happens immediately.
      subscription: { dispose: () => {} },
    };
    const subscription = handle.onPinChange(pinName, (state) => {
      const nextLevel = pinStateToLevel(state);
      if (nextLevel === tracker.level) return;
      tracker.level = nextLevel;
      // Snapshot listeners so a listener unsubscribing itself doesn't
      // skip its siblings in this dispatch. Matches the EventBus contract.
      const snapshot = [...tracker.listeners];
      for (const fn of snapshot) {
        try {
          fn(nextLevel);
        } catch (err) {
          logger.error(
            `pin("${pinName}").onChange listener threw:`,
            err,
          );
        }
      }
    });
    tracker.subscription = subscription;
    disposables.push(subscription);
    trackers.set(pinName, tracker);
  }

  // `api.pin(name)` builds a fresh `PartPinAPI` view each call. The view
  // closes over the same `tracker` so repeated calls observe the same
  // state and share the listener set — this mirrors the ticket spec
  // (`readonly state`) while keeping the view allocation cheap.
  const pin = (name: string): PartPinAPI => {
    const tracker = trackers.get(name);
    if (tracker === undefined) {
      throw new Error(
        `Plugin "${manifest.id}" accessed pin "${name}" which wasn't declared in HighLevelPartSimulation.pins. Declare every pin you intend to touch.`,
      );
    }
    return {
      get state() {
        return tracker.level;
      },
      onChange: (fn) => {
        tracker.listeners.add(fn);
        let disposed = false;
        return {
          dispose: () => {
            if (disposed) return;
            disposed = true;
            tracker.listeners.delete(fn);
          },
        };
      },
      set: (state: 'low' | 'high') => {
        // Per-call gate: registering a high-level part only needs
        // `simulator.pins.read`; mutating MCU-side state needs the
        // stricter `simulator.pins.write`.
        requirePermission(manifest, 'simulator.pins.write');
        const arduinoPin = handle.getArduinoPin(name);
        if (arduinoPin === null) {
          // No wire — silently no-op. The part will re-evaluate on the
          // first `onChange` after the user wires it up.
          return;
        }
        handle.setPinState(arduinoPin, state === 'high');
      },
    };
  };

  // Serial: observe MCU TX (UART0). Write-side (injecting into MCU RX)
  // is left for a future ticket — intentionally NOT advertised on the
  // interface surface until the host plumbing exists.
  const serial: PartSerialAPI = {
    onRead: (fn) => {
      const unsubscribe = events.on('serial:tx', (payload) => {
        try {
          fn(payload.data);
        } catch (err) {
          logger.error('serial.onRead listener threw:', err);
        }
      });
      let disposed = false;
      const d: Disposable = {
        dispose: () => {
          if (disposed) return;
          disposed = true;
          unsubscribe();
        },
      };
      disposables.push(d);
      return d;
    },
  };

  // I2C: observe every transaction on the bus. The listener is
  // responsible for filtering by `event.addr` if the plugin cares about
  // a specific slave address.
  const i2c: PartI2CAPI = {
    onTransfer: (fn) => {
      const unsubscribe = events.on('i2c:transfer', (payload: I2CTransferEvent) => {
        try {
          fn(payload);
        } catch (err) {
          logger.error('i2c.onTransfer listener threw:', err);
        }
      });
      let disposed = false;
      const d: Disposable = {
        dispose: () => {
          if (disposed) return;
          disposed = true;
          unsubscribe();
        },
      };
      disposables.push(d);
      return d;
    },
  };

  const api: PartSimulationAPI = { pin, serial, i2c };

  return {
    api,
    dispose: () => {
      // LIFO unwind so pin trackers go last (they were pushed first).
      for (let i = disposables.length - 1; i >= 0; i--) {
        try {
          disposables[i].dispose();
        } catch (err) {
          logger.error('high-level API disposable threw:', err);
        }
      }
      // Drop listener references eagerly so any leaked `api.pin(n)` views
      // in the author's closure become noticeable no-ops rather than
      // silent memory retainers.
      for (const tracker of trackers.values()) {
        tracker.listeners.clear();
      }
    },
  };
}

/**
 * Wrap an `InMemoryPluginStorage` so reads require `*.read` and writes
 * require `*.write`. `keys()` counts as a read.
 */
function wrapStorage(
  store: InMemoryPluginStorage,
  manifest: PluginManifest,
  readPerm: Parameters<typeof requirePermission>[1],
  writePerm: Parameters<typeof requirePermission>[1],
): PluginStorage {
  // The wrappers are `async` so that a permission throw lands as a rejected
  // promise — matches the SDK's `Promise<void>` contract for storage. With a
  // plain sync throw, `await store.set(...)` would unwind before the await
  // ever ran, surprising callers that wrap in `.catch()` or `try/await`.
  return {
    get: async (key) => {
      requirePermission(manifest, readPerm);
      return store.get(key);
    },
    set: async (key, value) => {
      requirePermission(manifest, writePerm);
      return store.set(key, value);
    },
    delete: async (key) => {
      requirePermission(manifest, writePerm);
      return store.delete(key);
    },
    keys: async () => {
      requirePermission(manifest, readPerm);
      return store.keys();
    },
  };
}
