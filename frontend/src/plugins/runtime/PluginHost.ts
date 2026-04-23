/**
 * Main-thread host for one worker-resident plugin.
 *
 * One `PluginHost` instance owns:
 *   - one `Worker` (or `MessagePort`-backed test stub)
 *   - one `RpcChannel` over that worker
 *   - one in-process `PluginContext` built via `createPluginContext()` —
 *     this is the *real* implementation backed by the host registries
 *     (`HostI18nRegistry`, `HostSettingsRegistry`, `componentRegistry`,
 *     etc). The PluginHost just routes RPC requests from the worker
 *     into that in-process context.
 *
 * Why route through `createPluginContext` instead of re-implementing?
 *   The in-process path already does permission gating, fault
 *   isolation, atomic re-declare, etc. Re-implementing would mean
 *   maintaining two divergent code paths. The RPC layer is purely
 *   transport — semantics live in the existing host-side code.
 *
 * --- Event forwarding ---
 *
 * The worker calls `events.subscribe('pin:change')` to opt in. The
 * PluginHost installs an EventBus listener that **fire-and-forgets**
 * the payload to the worker via `rpc.emitEvent()`. Because the RPC
 * channel has a bounded queue with coalescing on `pin:change`, even a
 * sleeping plugin can't stall the simulator — the host just drops
 * old events.
 *
 * --- Disposable forwarding ---
 *
 * When the worker calls `commands.register({ handler: {__cb: 7} })`,
 * the host:
 *   1. Rehydrates the cb marker into a function that fires
 *      `rpc.invokeCallback(7, args)` when triggered.
 *   2. Calls the in-process `ctx.commands.register({ handler })`.
 *   3. Receives a `Disposable` back, registers it in the host's
 *      `disposalTable`, returns `{ __disp: id }` to the worker.
 *
 * When the worker fires `disposable.dispose(id)`, the host looks up
 * the entry in the table, calls `dispose()`, and removes it.
 *
 * --- Teardown ---
 *
 * `host.terminate()`:
 *   1. Disposes the in-process context (LIFO unwinds every
 *      registered command/panel/listener/etc).
 *   2. Sweeps the disposalTable for anything the worker registered
 *      directly via `disposable.dispose` race conditions.
 *   3. Disposes the RPC channel (rejects pending requests).
 *   4. Calls `worker.terminate()` to nuke the JS context.
 */

import type {
  EventBusReader,
  PluginContext,
  PluginManifest,
  SimulatorEventName,
  Unsubscribe,
} from '@velxio/sdk';

import { createPluginContext, type PluginHostServices, type PluginUIRegistries } from '../../plugin-host/createPluginContext';
import { HandleTable, isCallbackHandle, rehydrate, stripFunctions } from './proxy';
import { RpcChannel, type RpcEndpoint, type RpcStats } from './rpc';

// ── Worker-like interface ────────────────────────────────────────────────

/**
 * Subset of `Worker` we actually use. Lets tests pass a `MessagePort`
 * that wraps a `MessageChannel` and skip the real Worker bootstrap.
 */
export interface WorkerLike extends RpcEndpoint {
  terminate(): void;
}

// ── Init ─────────────────────────────────────────────────────────────────

export interface PluginHostInit {
  readonly manifest: PluginManifest;
  readonly worker: WorkerLike;
  readonly services: PluginHostServices;
  /** Override ping interval (ms). Default 10_000; set to 0 to disable. */
  readonly pingIntervalMs?: number;
  /** If a ping doesn't get a pong within this many ms, terminate. Default 5_000. */
  readonly pingTimeoutMs?: number;
}

export interface PluginHostStats {
  readonly rpc: RpcStats;
  readonly disposablesHeld: number;
  readonly subscribedEvents: readonly SimulatorEventName[];
  readonly missedPings: number;
}

// ── PluginHost ───────────────────────────────────────────────────────────

export class PluginHost {
  readonly manifest: PluginManifest;
  private readonly worker: WorkerLike;
  private readonly rpc: RpcChannel;
  private readonly inProcess: { context: PluginContext; ui: PluginUIRegistries; dispose(): void };

  private readonly disposalTable = new HandleTable<{ dispose(): void }>();
  private readonly eventSubs = new Map<SimulatorEventName, Unsubscribe>();
  private readonly localeChangeUnsub: { fn: Unsubscribe | null } = { fn: null };

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private missedPings = 0;
  private terminated = false;

  constructor(init: PluginHostInit) {
    this.manifest = init.manifest;
    this.worker = init.worker;
    this.inProcess = createPluginContext(init.manifest, init.services);
    this.rpc = new RpcChannel(this.worker, {
      onError: (err) => this.inProcess.context.logger.error('[plugin runtime] RPC error:', err),
    });

    this.rpc.setHandlers({
      request: (method, args) => this.dispatch(method, args),
      log: (level, args) => this.handleLog(level, args),
    });

    const pingInterval = init.pingIntervalMs ?? 10_000;
    if (pingInterval > 0) {
      const pingTimeout = init.pingTimeoutMs ?? 5_000;
      this.pingTimer = setInterval(() => {
        if (this.terminated) return;
        this.rpc.ping(pingTimeout).then(() => {
          this.missedPings = 0;
        }).catch(() => {
          this.missedPings++;
          if (this.missedPings >= 2) {
            this.inProcess.context.logger.error(
              `[plugin runtime] worker unresponsive (${this.missedPings} missed pings) — terminating`,
            );
            this.terminate();
          }
        });
      }, pingInterval);
    }
  }

  /** UI registries owned by this plugin — host renderer subscribes to these. */
  get ui(): PluginUIRegistries {
    return this.inProcess.ui;
  }

  /** Stats for the Installed Plugins UI. */
  getStats(): PluginHostStats {
    return {
      rpc: this.rpc.getStats(),
      disposablesHeld: this.disposalTable.size,
      subscribedEvents: Array.from(this.eventSubs.keys()),
      missedPings: this.missedPings,
    };
  }

  /**
   * Tear everything down. Idempotent. Order matters:
   *   1. Stop pinging.
   *   2. Drop event subscriptions (so no late event triggers a post on
   *      a disposed channel).
   *   3. Dispose the in-process context (LIFO on every registered
   *      command/panel/etc).
   *   4. Sweep the disposalTable for stragglers (typically empty —
   *      every Disposable registered there is also in the in-process
   *      context's subscriptions store, so step 3 already disposed
   *      them. The sweep is defensive).
   *   5. Dispose RPC, terminate worker.
   */
  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const [, unsub] of this.eventSubs) {
      try { unsub(); } catch { /* ignore */ }
    }
    this.eventSubs.clear();
    if (this.localeChangeUnsub.fn !== null) {
      try { this.localeChangeUnsub.fn(); } catch { /* ignore */ }
      this.localeChangeUnsub.fn = null;
    }
    try { this.inProcess.dispose(); } catch { /* ignore */ }
    for (const [, d] of this.disposalTable.drain()) {
      try { d.dispose(); } catch { /* ignore */ }
    }
    this.rpc.dispose();
    try { this.worker.terminate(); } catch { /* ignore */ }
  }

  // ── Routing ────────────────────────────────────────────────────────────

  private async dispatch(method: string, rawArgs: readonly unknown[]): Promise<unknown> {
    if (this.terminated) {
      throw new Error('Plugin host is terminated');
    }
    const ctx = this.inProcess.context;

    // Rehydrate any callback markers in the args into local functions
    // that bounce calls back into the worker.
    const args = rawArgs.map((a) => rehydrate(
      a,
      (cbId, cbArgs) => this.rpc.invokeCallback(cbId, cbArgs),
      // Worker doesn't send Disposables to us (only the other way), so
      // disposer is unused.
      undefined,
    ));

    switch (method) {
      // ── components ───────────────────────────────────────────────────
      case 'components.register':
        return this.handleDisposable(ctx.components.register(args[0] as never));

      // ── partSimulations ──────────────────────────────────────────────
      case 'partSimulations.register': {
        // attachEvents callbacks accept a real HTMLElement on the host
        // side. The worker can never actually use that — strip it before
        // delegating. The host-side createPluginContext already wraps
        // attachEvents in fault isolation, so we let the wrapper see the
        // proxy callback (it will be invoked with whatever element the
        // host renderer eventually mounts).
        return this.handleDisposable(ctx.partSimulations.register(args[0] as string, args[1] as never));
      }

      // ── spice ────────────────────────────────────────────────────────
      case 'spice.registerMapper':
        return this.handleDisposable(ctx.spice.registerMapper(args[0] as string, args[1] as never));
      case 'spice.registerModel':
        return this.handleDisposable(ctx.spice.registerModel(args[0] as string, args[1] as string));

      // ── templates ────────────────────────────────────────────────────
      case 'templates.register':
        return this.handleDisposable(ctx.templates.register(args[0] as never));

      // ── libraries ────────────────────────────────────────────────────
      case 'libraries.register':
        return this.handleDisposable(ctx.libraries.register(args[0] as never));

      // ── ui ───────────────────────────────────────────────────────────
      case 'commands.register':
        return this.handleDisposable(ctx.commands.register(args[0] as never));
      case 'commands.execute':
        return ctx.commands.execute(args[0] as string);
      case 'toolbar.register':
        return this.handleDisposable(ctx.toolbar.register(args[0] as never));
      case 'panels.register':
        return this.handleDisposable(ctx.panels.register(args[0] as never));
      case 'statusBar.register':
        return this.handleDisposable(ctx.statusBar.register(args[0] as never));
      case 'statusBar.update':
        ctx.statusBar.update(args[0] as string, args[1] as never);
        return undefined;
      case 'editorActions.register':
        return this.handleDisposable(ctx.editorActions.register(args[0] as never));
      case 'canvasOverlays.register':
        return this.handleDisposable(ctx.canvasOverlays.register(args[0] as never));
      case 'contextMenu.register':
        return this.handleDisposable(ctx.contextMenu.register(args[0] as never));

      // ── events ───────────────────────────────────────────────────────
      case 'events.subscribe':
        return this.subscribeEvent(args[0] as SimulatorEventName, ctx.events);
      case 'events.unsubscribe':
        return this.unsubscribeEvent(args[0] as SimulatorEventName);

      // ── i18n ─────────────────────────────────────────────────────────
      case 'i18n.snapshot':
        return { locale: ctx.i18n.locale, available: ctx.i18n.availableLocales };
      case 'i18n.format':
        return ctx.i18n.format(args[0] as string, args[1] as Record<string, string | number> | undefined);
      case 'i18n.subscribeLocale':
        if (this.localeChangeUnsub.fn === null) {
          this.localeChangeUnsub.fn = ctx.i18n.onLocaleChange((locale) => {
            this.rpc.emitEvent('i18n:locale-change', { locale });
          });
        }
        return undefined;
      case 'i18n.unsubscribeLocale':
        if (this.localeChangeUnsub.fn !== null) {
          this.localeChangeUnsub.fn();
          this.localeChangeUnsub.fn = null;
        }
        return undefined;
      case 'i18n.registerBundle':
        return this.handleDisposable(ctx.i18n.registerBundle(args[0] as never));

      // ── settings ─────────────────────────────────────────────────────
      case 'settings.declare':
        return this.handleDisposable(ctx.settings.declare(args[0] as never));
      case 'settings.get':
        return ctx.settings.get();
      case 'settings.set':
        return ctx.settings.set(args[0] as never);
      case 'settings.reset':
        return ctx.settings.reset();
      case 'settings.onChange': {
        // The arg is a CallbackHandle; rehydrate already wrapped it in
        // a function. Register it; return a {__disp} handle.
        const fn = args[0] as (values: unknown) => void;
        if (typeof fn !== 'function') throw new Error('settings.onChange expects a callback');
        const unsub = ctx.settings.onChange(fn as never);
        const id = this.disposalTable.register({ dispose: unsub });
        return { __disp: id };
      }

      // ── storage ──────────────────────────────────────────────────────
      case 'userStorage.get':
        return ctx.userStorage.get(args[0] as string);
      case 'userStorage.set':
        return ctx.userStorage.set(args[0] as string, args[1]);
      case 'userStorage.delete':
        return ctx.userStorage.delete(args[0] as string);
      case 'userStorage.keys':
        return ctx.userStorage.keys();
      case 'workspaceStorage.get':
        return ctx.workspaceStorage.get(args[0] as string);
      case 'workspaceStorage.set':
        return ctx.workspaceStorage.set(args[0] as string, args[1]);
      case 'workspaceStorage.delete':
        return ctx.workspaceStorage.delete(args[0] as string);
      case 'workspaceStorage.keys':
        return ctx.workspaceStorage.keys();

      // ── fetch ────────────────────────────────────────────────────────
      case 'fetch':
        return this.handleFetch(ctx, args[0] as string, args[1] as RequestInit | undefined);

      // ── disposable lifecycle ─────────────────────────────────────────
      case 'disposable.dispose': {
        const id = args[0] as number;
        const d = this.disposalTable.get(id);
        if (d !== undefined) {
          this.disposalTable.delete(id);
          try { d.dispose(); } catch (err) {
            this.inProcess.context.logger.error(`[plugin runtime] dispose threw for id ${id}:`, err);
          }
        }
        return undefined;
      }

      default:
        throw new Error(`Unknown plugin RPC method: ${method}`);
    }
  }

  private subscribeEvent(topic: SimulatorEventName, events: EventBusReader): { __disp: number } | undefined {
    if (this.eventSubs.has(topic)) {
      // Already subscribed — idempotent. Return undefined; worker just
      // wanted to ensure forwarding is on.
      return undefined;
    }
    const unsub = events.on(topic, (payload) => {
      // Fire-and-forget: never await. If the worker is slow, the rpc
      // queue coalesces (pin:change) or drops oldest.
      this.rpc.emitEvent(topic, payload);
    });
    this.eventSubs.set(topic, unsub);
    return undefined;
  }

  private unsubscribeEvent(topic: SimulatorEventName): undefined {
    const unsub = this.eventSubs.get(topic);
    if (unsub === undefined) return undefined;
    try { unsub(); } catch { /* ignore */ }
    this.eventSubs.delete(topic);
    return undefined;
  }

  /**
   * Take a Disposable from the in-process context and convert to a
   * `{__disp}` handle for the worker.
   */
  private handleDisposable(d: { dispose(): void }): { __disp: number } {
    const id = this.disposalTable.register(d);
    return { __disp: id };
  }

  /**
   * Run a fetch call through the in-process scoped fetch and convert
   * the Response into a structured-clone-friendly `FetchShim`.
   *
   * The shim transfers the response body as a Uint8Array (cloned, not
   * transferred — most plugins won't need zero-copy and a transfer
   * confiscates the host-side buffer).
   */
  private async handleFetch(ctx: PluginContext, url: string, init: RequestInit | undefined): Promise<unknown> {
    const response = await ctx.fetch(url, init);
    const buffer = await response.arrayBuffer();
    const headers: Record<string, string> = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    return {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      headers,
      bytes: new Uint8Array(buffer),
      url: response.url,
    };
  }

  private handleLog(level: 'debug' | 'info' | 'warn' | 'error', args: readonly unknown[]): void {
    const logger = this.inProcess.context.logger;
    // Rehydrate any error-shaped objects back into Errors for nicer
    // console output. Strip `{__isError}` markers.
    const rehydrated = args.map((a) => {
      if (typeof a === 'object' && a !== null && '__isError' in a) {
        const e = a as { name?: string; message?: string; stack?: string };
        const err = new Error(e.message ?? '');
        if (e.name !== undefined) err.name = e.name;
        if (e.stack !== undefined) err.stack = e.stack;
        return err;
      }
      return a;
    });
    switch (level) {
      case 'debug': logger.debug(...rehydrated); return;
      case 'info': logger.info(...rehydrated); return;
      case 'warn': logger.warn(...rehydrated); return;
      case 'error': logger.error(...rehydrated); return;
    }
  }
}

// `isCallbackHandle` and `stripFunctions` are part of the proxy contract;
// keep imports alive for downstream tooling that introspects this module.
void isCallbackHandle;
void stripFunctions;
