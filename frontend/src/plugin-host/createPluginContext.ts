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
  ContextMenuItemDefinition,
  ContextMenuRegistry,
  Disposable,
  EditorActionDefinition,
  EditorActionRegistry,
  EventBusReader,
  LibraryDefinition,
  LibraryRegistry as SdkLibraryRegistry,
  PanelDefinition,
  PanelRegistry,
  PartSimulation,
  PartSimulationRegistry as SdkPartSimulationRegistry,
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
import { InMemoryPluginStorage } from './PluginStorage';
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
 */
export interface PluginHostServices {
  readonly events: EventBusReader;
  /** Override the underlying fetch (tests). */
  readonly fetchImpl?: typeof fetch;
  /** Optional override for max body bytes. */
  readonly fetchMaxBytes?: number;
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
  const userStorage: PluginStorage = wrapStorage(
    new InMemoryPluginStorage('user'),
    manifest,
    'storage.user.read',
    'storage.user.write',
  );
  const workspaceStorage: PluginStorage = wrapStorage(
    new InMemoryPluginStorage('workspace'),
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
