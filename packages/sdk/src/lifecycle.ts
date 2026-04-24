/**
 * Plugin lifecycle.
 *
 * A plugin is a module that exports a default plugin object (wrapped by
 * `definePlugin`) with `activate(ctx)` and optional `deactivate()`.
 *
 * The host loader:
 *   1. Validates the manifest.
 *   2. Boots a permission-scoped `PluginContext` for the plugin.
 *   3. Calls `activate(ctx)`.
 *   4. On unload, calls `deactivate()` (if present) and disposes every
 *      `Disposable` the plugin produced.
 */

import type { Disposable, ComponentRegistry } from './components';
import type { PartSimulationRegistry } from './simulation';
import type { SpiceRegistry } from './spice';
import type {
  CommandRegistry,
  ToolbarRegistry,
  PanelRegistry,
  StatusBarRegistry,
  EditorActionRegistry,
  CanvasOverlayRegistry,
  ContextMenuRegistry,
} from './ui';
import type { EventBusReader } from './events';
import type { PluginManifest } from './manifest';
import type { TemplateRegistry } from './templates';
import type { LibraryRegistry } from './libraries';
import type { I18nAPI } from './i18n';
import type { SettingsAPI } from './settings';

/**
 * Storage scoped to the plugin. Two buckets:
 *   - `user`: persists per (user, plugin). Syncs to the cloud when the user is signed in.
 *   - `workspace`: scoped to the current project. Travels with the project.
 *
 * Quota: 1 MB per bucket per plugin. `set()` rejects beyond that.
 */
export interface PluginStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<ReadonlyArray<string>>;
}

/** Default per-plugin per-bucket quota: 1 MB. */
export const PLUGIN_STORAGE_QUOTA_BYTES = 1_048_576 as const;

/**
 * Thrown by `PluginStorage.set()` when writing the value would push the
 * bucket over its byte budget. Message includes the attempted size and the
 * remaining headroom so plugin authors can react (e.g. evict cache entries).
 */
export class StorageQuotaError extends Error {
  public override readonly name = 'StorageQuotaError';
  constructor(
    public readonly bucket: 'user' | 'workspace',
    public readonly attemptedBytes: number,
    public readonly quotaBytes: number,
  ) {
    super(
      `Plugin storage bucket "${bucket}" would exceed quota: attempted ${attemptedBytes} bytes, quota ${quotaBytes} bytes.`,
    );
  }
}

/**
 * Thrown by `ScopedFetch` when a plugin tries to reach a URL that is not in
 * the manifest's `http.allowlist`. The plugin author is expected to surface
 * this as a configuration mistake, not a runtime fallback.
 */
export class HttpAllowlistDeniedError extends Error {
  public override readonly name = 'HttpAllowlistDeniedError';
  constructor(
    public readonly url: string,
    public readonly allowlist: ReadonlyArray<string>,
  ) {
    super(
      `Plugin tried to fetch "${url}" which is not in the manifest http.allowlist (${allowlist.join(', ') || '<empty>'}).`,
    );
  }
}

/**
 * Thrown by `ScopedFetch` when a response body exceeds the byte cap. The
 * cap is enforced two ways:
 *
 *   - Upfront via `Content-Length` header — fast-fail before the body starts
 *     streaming. `observedBytes` equals the declared header value.
 *   - Mid-stream — when the server omits Content-Length (or lies), the
 *     body is read through a counting `ReadableStream` that errors out as
 *     soon as the running total crosses the cap. `observedBytes` is the
 *     count at the point of abort (always `> maxBytes`).
 *
 * Plugins should treat this as a hostile/buggy upstream — the manifest
 * should narrow `http.allowlist` to known-good endpoints, or split large
 * downloads into ranged requests.
 */
export class HttpResponseTooLargeError extends Error {
  public override readonly name = 'HttpResponseTooLargeError';
  constructor(
    public readonly url: string,
    public readonly observedBytes: number,
    public readonly maxBytes: number,
  ) {
    super(
      `Plugin fetch refused: response from "${url}" is too large (${observedBytes} bytes, cap ${maxBytes} bytes).`,
    );
  }
}

/**
 * Thrown by `ctx.fetch` when the plugin has exhausted its per-window
 * request budget. The host enforces this at the runtime layer (not in
 * the manifest) so a plugin cannot self-grant a higher cap.
 *
 * `retryAfterMs` is the time until the *oldest* request in the current
 * sliding window ages out — i.e. the earliest moment a follow-up fetch
 * could succeed. A plugin author can use it to schedule a single retry
 * instead of busy-looping.
 */
export class RateLimitExceededError extends Error {
  public override readonly name = 'RateLimitExceededError';
  constructor(
    public readonly pluginId: string,
    public readonly maxRequests: number,
    public readonly windowMs: number,
    public readonly retryAfterMs: number,
  ) {
    super(
      `Plugin "${pluginId}" exceeded fetch rate limit (${maxRequests} requests per ${windowMs} ms). ` +
      `Retry in ${retryAfterMs} ms.`,
    );
  }
}

/** Host-provided logger — routes to the devtools console with plugin-id prefix. */
export interface PluginLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Scoped fetch. Only reaches URLs in the manifest's `http.allowlist`.
 * Calls to other hosts throw synchronously with `PermissionDeniedError`.
 */
export type ScopedFetch = (
  input: string | URL,
  init?: { method?: string; headers?: Record<string, string>; body?: BodyInit },
) => Promise<Response>;

/**
 * Aggregate of plugin-owned `Disposable`s. The host gives each plugin one
 * of these as `ctx.subscriptions`. Anything the plugin produces — registry
 * handles, event listeners, intervals — should be added so that
 * deactivation reliably tears it all down.
 *
 * Semantics:
 *   - `add(d)` appends. Order is preserved.
 *   - `dispose()` walks LIFO so resources release in reverse-acquisition
 *     order (matches `using`/`finally` semantics).
 *   - `dispose()` is idempotent: a second call is a no-op.
 *   - A throw inside one disposable is logged and swallowed so it cannot
 *     block the rest from being torn down.
 *   - After `dispose()`, `add()` disposes its argument immediately (the
 *     store is closed). This prevents leaks if the plugin races
 *     deactivation with an async operation that produces a disposable.
 */
export interface DisposableStore {
  add(d: Disposable): void;
  dispose(): void;
  /** True after `dispose()` has been called. */
  readonly isDisposed: boolean;
  /** Number of disposables still tracked. Undefined after `dispose()`. */
  readonly size: number;
}

/**
 * The full context handed to the plugin at activation. Every registry
 * here is permission-gated — calls fail fast if the manifest does not
 * declare the matching permission.
 */
export interface PluginContext {
  readonly manifest: PluginManifest;
  readonly logger: PluginLogger;

  readonly components: ComponentRegistry;
  readonly partSimulations: PartSimulationRegistry;
  readonly spice: SpiceRegistry;
  readonly templates: TemplateRegistry;
  readonly libraries: LibraryRegistry;

  readonly commands: CommandRegistry;
  readonly toolbar: ToolbarRegistry;
  readonly panels: PanelRegistry;
  readonly statusBar: StatusBarRegistry;
  readonly editorActions: EditorActionRegistry;
  readonly canvasOverlays: CanvasOverlayRegistry;
  readonly contextMenu: ContextMenuRegistry;

  readonly events: EventBusReader;

  /**
   * Per-plugin internationalisation surface. The plugin registers a
   * `PluginI18nBundle` once, then reads via `t(key, vars?)`. The host owns
   * the active locale; `onLocaleChange` notifies the plugin when it
   * switches. See `@velxio/sdk` `I18nAPI`.
   */
  readonly i18n: I18nAPI;

  /**
   * User-tunable settings declared by this plugin. The plugin defines
   * the schema; the host renders the form and persists values per
   * (user, plugin). See `@velxio/sdk` `SettingsAPI`.
   */
  readonly settings: SettingsAPI;

  /** User-scoped persistent storage. */
  readonly userStorage: PluginStorage;
  /** Workspace-scoped (current project) storage. */
  readonly workspaceStorage: PluginStorage;

  /** Scoped fetch respecting the manifest's `http.allowlist`. */
  readonly fetch: ScopedFetch;

  /**
   * The canonical place to attach plugin-owned disposables. Equivalent to
   * `addDisposable()` but allows the plugin to also call `dispose()`
   * itself if it wants to tear down a sub-tree manually.
   */
  readonly subscriptions: DisposableStore;

  /**
   * Convenience alias for `subscriptions.add(d)`. Kept for the cases where
   * a single conditional disposable read better as a method call than a
   * field access.
   */
  addDisposable(d: Disposable): void;
}

/**
 * The shape a plugin module's default export must match.
 *
 * `activate` runs every time the plugin is loaded (on user install, on
 * editor start, on hot reload during dev). It must be idempotent: all
 * side effects (listener attach, registry entries) go through the
 * `ctx` provided so the host can tear them down.
 */
export interface Plugin {
  /**
   * Returning a `Disposable` (or array thereof) is supported as a
   * convenience — the host will dispose them on deactivate.
   */
  activate(ctx: PluginContext): void | Disposable | ReadonlyArray<Disposable> | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/**
 * Identity helper that gives plugin authors type inference on the
 * argument without forcing a runtime wrapper. Use it as:
 *
 * ```ts
 * import { definePlugin } from '@velxio/sdk';
 * export default definePlugin({
 *   activate(ctx) { … },
 * });
 * ```
 */
export function definePlugin<T extends Plugin>(plugin: T): T {
  return plugin;
}
