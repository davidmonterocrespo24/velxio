/**
 * Worker-side `PluginContext` stub.
 *
 * This is what the plugin's `activate(ctx)` actually receives inside the
 * worker. Every method on it serializes its arguments (stripping
 * functions to `{__cb}` markers via `proxy.ts`) and issues an RPC to
 * the host. Disposables that come back are wrapped so that calling
 * `dispose()` issues a `disposable.dispose` request to the host.
 *
 * The goal is **shape parity** with the in-process `PluginContext`
 * built by `frontend/src/plugin-host/createPluginContext.ts`. A plugin
 * written against `@velxio/sdk` types should not be able to tell
 * whether it is running in-process (host singletons) or in a worker.
 *
 * --- DOM-bound APIs (NOT yet supported in worker plugins) ---
 *
 * Some PluginContext methods accept callbacks that receive `HTMLElement`
 * (`partSimulations.register({ attachEvents })`) or return JSX/render
 * functions (`panels.register`, `canvasOverlays.register`). DOM nodes
 * cannot cross the worker boundary, and the SDK does not yet have a
 * declarative SVG / Web-Component contract for render functions.
 *
 * For now: those calls are accepted and routed, but `attachEvents` and
 * `render` callbacks **will never fire** in a worker plugin. A clear
 * warning is logged on the worker side at register time. CORE-006b
 * will introduce the declarative render contract.
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
  DisposableStore,
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
  PluginLogger,
  PluginManifest,
  PluginStorage,
  ScopedFetch,
  SettingsAPI,
  SettingsDeclaration,
  SimulatorEventListener,
  SimulatorEventName,
  SimulatorEvents,
  SpiceMapper,
  SpiceRegistry,
  StatusBarItemDefinition,
  StatusBarRegistry,
  TemplateDefinition,
  TemplateRegistry as SdkTemplateRegistry,
  ToolbarItemDefinition,
  ToolbarRegistry,
  Unsubscribe,
} from '@velxio/sdk';

import { HandleTable, attachInvokeRouter, isDisposableHandle, rehydrate, stripFunctions } from './proxy';
import type { RpcChannel } from './rpc';

// ── Shape of the RPC fetch response (see PluginHost.fetch handler) ───────

interface FetchShim {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly headers: Record<string, string>;
  readonly bytes: Uint8Array;
  readonly url: string;
}

// ── Worker-side disposable store (mirrors HostDisposableStore behaviour) ─

class WorkerDisposableStore implements DisposableStore {
  private readonly disposables: Disposable[] = [];
  private _disposed = false;

  add(d: Disposable): void {
    if (this._disposed) {
      // Late arrival: dispose immediately.
      try {
        d.dispose();
      } catch {
        // swallow — late dispose throws are not the host's problem
      }
      return;
    }
    this.disposables.push(d);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    // LIFO unwind so disposables are torn down in reverse-acquisition
    // order (matches the host's HostDisposableStore semantics).
    for (let i = this.disposables.length - 1; i >= 0; i--) {
      try {
        this.disposables[i]!.dispose();
      } catch {
        // Per SDK contract: throwing disposables don't block peers.
      }
    }
    this.disposables.length = 0;
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  get size(): number {
    return this.disposables.length;
  }
}

// ── Builder ──────────────────────────────────────────────────────────────

export interface ContextStubInit {
  readonly manifest: PluginManifest;
  readonly rpc: RpcChannel;
  /** Fired by the worker `pluginWorker.ts` when the plugin throws. */
  readonly onUncaughtError?: (err: unknown) => void;
}

/**
 * Build a `PluginContext` that lives entirely in the worker.
 *
 * This object is what gets passed to `activate(ctx)`. The function does
 * not start any I/O on its own — it just returns the context and a
 * teardown callback. The caller (`pluginWorker.ts`) decides when to
 * wire up the RPC routes and when to dispose.
 */
export function buildContextStub(init: ContextStubInit): {
  readonly context: PluginContext;
  /** Drop the worker-side state (callback table, subscriptions). */
  dispose(): void;
} {
  const { manifest, rpc } = init;
  const cbTable = new HandleTable<(...args: unknown[]) => unknown>();
  const subscriptions = new WorkerDisposableStore();
  let warnedDomBound = false;

  const warnDomBound = (api: string) => {
    if (warnedDomBound) return;
    warnedDomBound = true;
    rpc.log('warn', [
      `[plugin:${manifest.id}] ${api} accepted in worker context but DOM-bound callbacks (render / attachEvents) will not fire — see docs/PLUGIN_RUNTIME.md`,
    ]);
  };

  // Wire incoming invoke-callback messages to the cb table.
  attachInvokeRouter(rpc, cbTable, (id) => {
    rpc.log('warn', [`[plugin:${manifest.id}] host invoked unknown callback id ${id}`]);
  });

  /**
   * Issue an RPC, replacing functions in `args` with `{__cb}` markers,
   * and rehydrating the response (so a `Disposable` returned by the
   * host becomes a real `{ dispose() }` object on the worker).
   *
   * Disposables returned by registries are auto-added to
   * `subscriptions` so plugins that forget to track handles still get
   * clean teardown on plugin unload.
   */
  const call = async <T = unknown>(method: string, args: unknown[] = [], opts?: { timeoutMs?: number }): Promise<T> => {
    const stripped = args.map((a) => stripFunctions(a, cbTable));
    const raw = await rpc.request<unknown>(method, stripped, opts);
    const hydrated = rehydrate(raw, () => {
      // Host should never ask the worker to invoke a callback as the
      // *response* to a request — only via the dedicated invoke-callback
      // channel. Keep this as a defensive noop.
    }, (dispId) => {
      rpc.request('disposable.dispose', [dispId]).catch(() => {
        // The host might have torn down already; that's fine.
      });
    });
    if (isAutoDisposable(hydrated)) {
      subscriptions.add(hydrated);
    }
    return hydrated as T;
  };

  // ── logger ──────────────────────────────────────────────────────────────
  const logger: PluginLogger = {
    debug: (...args) => rpc.log('debug', sanitizeLogArgs(args)),
    info: (...args) => rpc.log('info', sanitizeLogArgs(args)),
    warn: (...args) => rpc.log('warn', sanitizeLogArgs(args)),
    error: (...args) => rpc.log('error', sanitizeLogArgs(args)),
  };

  // ── components ──────────────────────────────────────────────────────────
  const components: SdkComponentRegistry = {
    register: (def: ComponentDefinition) => {
      // Component metadata is pure data (no functions). Regular path.
      return wrapDisposable(call('components.register', [def]));
    },
    get: (id) => {
      // Synchronous-shape API on a worker boundary is awkward. Plugins
      // that need component lookups should cache them at activate time.
      // We provide a sync stub that returns undefined and warn once.
      void id;
      warnSyncReadOnFirstUse('components.get');
      return undefined;
    },
    list: () => {
      warnSyncReadOnFirstUse('components.list');
      return [];
    },
  };

  // ── partSimulations ─────────────────────────────────────────────────────
  // Two event-plumbing paths exist and compose:
  //   - `attachEvents(element, handle)` — main-thread only. Warn on worker
  //     plugins because DOM access will never fire.
  //   - `events` + `onEvent(DelegatedPartEvent)` — worker-safe. The host
  //     installs delegated listeners on the main thread and pushes events
  //     back through the RPC channel (a function in `sim` is replaced with
  //     a `{__cb}` handle by `stripFunctions`).
  // The warning fires only when `attachEvents` is used alone. A plugin that
  // declared the declarative path alongside is doing the right thing.
  const partSimulations: SdkPartSimulationRegistry = {
    register: (componentId: string, sim: PartSimulation) => {
      const hasDelegation =
        Array.isArray(sim.events) && sim.events.length > 0 && typeof sim.onEvent === 'function';
      if (sim.attachEvents !== undefined && !hasDelegation) {
        warnDomBound('partSimulations.register({ attachEvents })');
      }
      return wrapDisposable(call('partSimulations.register', [componentId, sim]));
    },
    get: () => undefined,
  };

  // ── spice ───────────────────────────────────────────────────────────────
  const spice: SpiceRegistry = {
    registerMapper: (componentId: string, mapper: SpiceMapper) =>
      wrapDisposable(call('spice.registerMapper', [componentId, mapper])),
    registerModel: (name: string, card: string) =>
      wrapDisposable(call('spice.registerModel', [name, card])),
    isReady: () => true,
  };

  // ── templates ───────────────────────────────────────────────────────────
  const templates: SdkTemplateRegistry = {
    register: (def: TemplateDefinition) => wrapDisposable(call('templates.register', [def])),
    get: () => {
      warnSyncReadOnFirstUse('templates.get');
      return undefined;
    },
    list: () => {
      warnSyncReadOnFirstUse('templates.list');
      return [];
    },
  };

  // ── libraries ───────────────────────────────────────────────────────────
  const libraries: SdkLibraryRegistry = {
    register: (def: LibraryDefinition) => wrapDisposable(call('libraries.register', [def])),
    get: () => {
      warnSyncReadOnFirstUse('libraries.get');
      return undefined;
    },
    list: () => {
      warnSyncReadOnFirstUse('libraries.list');
      return [];
    },
    resolve: () => [],
  };

  // ── ui ──────────────────────────────────────────────────────────────────
  const commands: CommandRegistry = {
    register: (def: CommandDefinition) => wrapDisposable(call('commands.register', [def])),
    execute: (id: string) => {
      void call('commands.execute', [id]);
    },
  };
  const toolbar: ToolbarRegistry = {
    register: (item: ToolbarItemDefinition) => wrapDisposable(call('toolbar.register', [item])),
  };
  const panels: PanelRegistry = {
    register: (panel: PanelDefinition) => {
      warnDomBound('panels.register({ render })');
      return wrapDisposable(call('panels.register', [panel]));
    },
  };
  const statusBar: StatusBarRegistry = {
    register: (item: StatusBarItemDefinition) => wrapDisposable(call('statusBar.register', [item])),
    update: (id, patch) => {
      void call('statusBar.update', [id, patch]);
    },
  };
  const editorActions: EditorActionRegistry = {
    register: (action: EditorActionDefinition) => wrapDisposable(call('editorActions.register', [action])),
  };
  // Declarative SVG path (`overlay.svg`) is worker-safe: pure JSON survives
  // the `postMessage` hop, and the host builds real DOM on the main thread.
  // Only warn when the plugin uses the imperative `mount` path alone.
  const canvasOverlays: CanvasOverlayRegistry = {
    register: (overlay: CanvasOverlayDefinition) => {
      const hasDeclarativeSvg = overlay.svg !== undefined;
      if (overlay.mount !== undefined && !hasDeclarativeSvg) {
        warnDomBound('canvasOverlays.register({ mount })');
      }
      return wrapDisposable(call('canvasOverlays.register', [overlay]));
    },
  };
  const contextMenu: ContextMenuRegistry = {
    register: (item: ContextMenuItemDefinition) => wrapDisposable(call('contextMenu.register', [item])),
  };

  // ── events (host pushes events fire-and-forget) ─────────────────────────
  const eventListeners = new Map<SimulatorEventName, Set<SimulatorEventListener<SimulatorEventName>>>();
  // Install a single event-router on the rpc channel: the host's pushes
  // fan out to every registered listener for that topic.
  rpc.setHandlers({
    event: (topic, payload) => {
      const set = eventListeners.get(topic as SimulatorEventName);
      if (set === undefined) return;
      // Snapshot-on-dispatch — listener that mutates the set during
      // dispatch is safe (matches host EventBus semantics).
      const snap = Array.from(set);
      for (const fn of snap) {
        try {
          fn(payload as SimulatorEvents[SimulatorEventName]);
        } catch (err) {
          rpc.log('error', [`[plugin:${manifest.id}] listener for "${topic}" threw:`, err]);
        }
      }
    },
  });
  const events: EventBusReader = {
    on<K extends SimulatorEventName>(event: K, listener: SimulatorEventListener<K>): Unsubscribe {
      let set = eventListeners.get(event);
      if (set === undefined) {
        set = new Set();
        eventListeners.set(event, set);
        // First listener for this topic: tell the host to start
        // forwarding events of this kind to us.
        void call('events.subscribe', [event]);
      }
      set.add(listener as SimulatorEventListener<SimulatorEventName>);
      return () => {
        const s = eventListeners.get(event);
        if (s === undefined) return;
        s.delete(listener as SimulatorEventListener<SimulatorEventName>);
        if (s.size === 0) {
          eventListeners.delete(event);
          // Last listener: tell the host to stop forwarding.
          void call('events.unsubscribe', [event]);
        }
      };
    },
    hasListeners<K extends SimulatorEventName>(event: K): boolean {
      const set = eventListeners.get(event);
      return set !== undefined && set.size > 0;
    },
    listenerCount<K extends SimulatorEventName>(event: K): number {
      return eventListeners.get(event)?.size ?? 0;
    },
  };

  // ── i18n ────────────────────────────────────────────────────────────────
  // Pull the initial locale snapshot once at startup; subscribe for
  // future changes. Plugins synchronously read `ctx.i18n.locale` so we
  // need a local cache.
  let localeCache: string = manifest.i18n?.[0] ?? 'en';
  let availableCache: readonly string[] = manifest.i18n ?? ['en'];
  const localeListeners = new Set<(locale: string) => void>();
  void call<{ locale: string; available: readonly string[] }>('i18n.snapshot').then((snap) => {
    localeCache = snap.locale;
    availableCache = snap.available;
  }).catch(() => {
    // Host might not implement; keep defaults.
  });

  const i18n = {
    get locale(): string {
      return localeCache;
    },
    get availableLocales(): readonly string[] {
      return availableCache;
    },
    t: (_key: string, _vars?: Record<string, string | number>) => {
      // Sync API on a worker boundary again — return a placeholder and
      // request asynchronously. Plugin code that needs the resolved
      // translation should `await ctx.i18n.format(template)` instead.
      return _key;
    },
    format: (template: string, vars?: Record<string, string | number>) =>
      call<string>('i18n.format', [template, vars]),
    onLocaleChange: (fn: (locale: string) => void): Unsubscribe => {
      localeListeners.add(fn);
      // Tell the host to start pushing changes if not already.
      if (localeListeners.size === 1) {
        void call('i18n.subscribeLocale');
      }
      return () => {
        localeListeners.delete(fn);
        if (localeListeners.size === 0) {
          void call('i18n.unsubscribeLocale');
        }
      };
    },
    registerBundle: (bundle: import('@velxio/sdk').PluginI18nBundle) =>
      wrapDisposable(call('i18n.registerBundle', [bundle])),
  } satisfies import('@velxio/sdk').I18nAPI;

  // ── settings ────────────────────────────────────────────────────────────
  const settings: SettingsAPI = {
    declare: (declaration: SettingsDeclaration) => wrapDisposable(call('settings.declare', [declaration])),
    get: () => call('settings.get'),
    set: (partial) => call('settings.set', [partial]),
    reset: () => call('settings.reset'),
    onChange: (fn) => {
      const cbId = cbTable.register(fn as (...args: unknown[]) => unknown);
      // Issue subscribe; host returns disposable id.
      const promise = rpc.request<{ __disp: number }>('settings.onChange', [{ __cb: cbId }]);
      const unsubscribe = (): void => {
        cbTable.delete(cbId);
        void promise.then((handle) => {
          void rpc.request('disposable.dispose', [handle.__disp]).catch(() => {});
        }).catch(() => {});
      };
      // Auto-track for plugin teardown via subscriptions store.
      subscriptions.add({ dispose: unsubscribe });
      return unsubscribe;
    },
  };

  // ── storage ─────────────────────────────────────────────────────────────
  const userStorage: PluginStorage = {
    get: (k) => call('userStorage.get', [k]),
    set: (k, v) => call('userStorage.set', [k, v]),
    delete: (k) => call('userStorage.delete', [k]),
    keys: () => call('userStorage.keys'),
  };
  const workspaceStorage: PluginStorage = {
    get: (k) => call('workspaceStorage.get', [k]),
    set: (k, v) => call('workspaceStorage.set', [k, v]),
    delete: (k) => call('workspaceStorage.delete', [k]),
    keys: () => call('workspaceStorage.keys'),
  };

  // ── fetch ───────────────────────────────────────────────────────────────
  const fetch: ScopedFetch = async (input, init) => {
    // Strip non-serializable parts of init (signal, body streams). Body
    // can be string | Uint8Array | undefined for the worker boundary.
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : (input as Request).url);
    const safeInit: Record<string, unknown> = {};
    if (init?.method !== undefined) safeInit.method = init.method;
    if (init?.headers !== undefined) safeInit.headers = init.headers;
    if (init?.body !== undefined) {
      if (typeof init.body === 'string' || init.body instanceof Uint8Array) {
        safeInit.body = init.body;
      }
    }
    const shim = await call<FetchShim>('fetch', [url, safeInit], { timeoutMs: 30_000 });
    return new Response(shim.bytes, {
      status: shim.status,
      statusText: shim.statusText,
      headers: shim.headers,
    });
  };

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
    events,
    i18n,
    settings,
    userStorage,
    workspaceStorage,
    fetch,
    subscriptions,
    addDisposable: (d: Disposable) => subscriptions.add(d),
  };

  return {
    context,
    dispose: () => {
      subscriptions.dispose();
      cbTable.clear();
      eventListeners.clear();
      localeListeners.clear();
    },
  };
}

// ── small helpers ────────────────────────────────────────────────────────

const warnedSyncReads = new Set<string>();
function warnSyncReadOnFirstUse(method: string): void {
  // No rpc.log here — this fires before the warning channel is wired
  // in some test paths. Use console as a worker-safe fallback.
  if (warnedSyncReads.has(method)) return;
  warnedSyncReads.add(method);
  // eslint-disable-next-line no-console
  console.warn(`[plugin runtime] ${method} is sync-shape but worker-bound: returning empty/undefined; use the async equivalent or cache at activate()`);
}

/**
 * Result of a registry register() call must look like a Disposable
 * synchronously, but in worker land it's a Promise. We return a
 * Disposable wrapper that defers `dispose()` until the promise
 * resolves.
 */
function wrapDisposable(promise: Promise<unknown>): Disposable {
  let actual: Disposable | null = null;
  let disposeRequested = false;
  promise.then((r) => {
    if (isAutoDisposable(r)) {
      actual = r;
      if (disposeRequested) {
        try { actual.dispose(); } catch { /* ignore */ }
      }
    }
  }).catch(() => {
    // If the register call itself failed, dispose is a no-op.
  });
  return {
    dispose: () => {
      if (actual !== null) {
        try { actual.dispose(); } catch { /* ignore */ }
      } else {
        disposeRequested = true;
      }
    },
  };
}

function isAutoDisposable(v: unknown): v is Disposable {
  return typeof v === 'object' && v !== null && typeof (v as Disposable).dispose === 'function';
}

/**
 * Logger args may contain Errors and other non-cloneable shapes. Convert
 * Errors into structured-clone-friendly plain objects, leave everything
 * else alone.
 */
function sanitizeLogArgs(args: unknown[]): unknown[] {
  return args.map((a) => {
    if (a instanceof Error) {
      return { __isError: true, name: a.name, message: a.message, stack: a.stack };
    }
    return a;
  });
}

// `isDisposableHandle` is referenced for documentation completeness — used by
// `rehydrate()` below the surface — keep the import alive.
void isDisposableHandle;
