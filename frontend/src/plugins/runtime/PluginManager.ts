/**
 * Singleton entry point for plugin lifecycle.
 *
 * The editor uses this:
 *   - `pluginManager.load(manifest, bundleUrl)` → spawn worker, post init
 *   - `pluginManager.unload(id)` → tear down one plugin
 *   - `pluginManager.list()` → enumerate active plugins
 *   - `pluginManager.subscribe(fn)` → reactive UI state
 *
 * Loading is **idempotent**: calling load() twice with the same id
 * uninstalls the prior version first (hot reload). This matches the
 * lifecycle expectations of the Installed Plugins panel (CORE-008).
 *
 * Worker creation is delegated to a `WorkerFactory` so tests can pass
 * a `MessageChannel`-backed stub without touching the real Worker
 * constructor (which jsdom doesn't implement).
 *
 * --- Why a singleton? ---
 *
 * Plugin disposables, command-palette entries, and the SimulatorEvents
 * subscriptions all live in the host's process-level registries. There
 * is exactly one editor session per page, and that session owns one
 * set of registries. A non-singleton manager would invite two managers
 * fighting over the same registry — disposing entries the other one
 * just registered, etc.
 *
 * For testing isolation, `resetPluginManagerForTests()` is exported.
 */

import type { PluginManifest } from '@velxio/sdk';

import type { PluginHostServices } from '../../plugin-host/createPluginContext';
import { PluginHost, type PluginHostStats, type WorkerLike } from './PluginHost';
import type { InitMessage } from './pluginWorker';

// ── Worker factory ───────────────────────────────────────────────────────

/**
 * Strategy for creating a worker for a plugin.
 *
 * Production wires the real `Worker` constructor pointed at the
 * worker entry script. Tests pass a stub that wires both ends of a
 * `MessageChannel` and runs `bootWorker()` directly on the worker
 * port.
 */
export interface WorkerFactory {
  create(): WorkerLike;
}

// ── Public state ─────────────────────────────────────────────────────────

export type PluginStatus = 'loading' | 'active' | 'failed' | 'unloaded' | 'paused';

/**
 * Why a plugin is in `paused` status. Drives the modal CTA copy:
 * `license-expired`/`license-revoked` route to the licensing flow, while
 * `manual` is used by tests and future "snooze plugin" affordances.
 */
export type PluginPauseReason = 'license-expired' | 'license-revoked' | 'manual';

export interface PluginEntry {
  readonly id: string;
  readonly manifest: PluginManifest;
  readonly status: PluginStatus;
  readonly error?: { name: string; message: string };
  readonly stats?: PluginHostStats;
  /** Present when `status === 'paused'`. */
  readonly pauseReason?: PluginPauseReason;
}

export interface LoadOptions {
  readonly bundleUrl: string;
  /** Optional SHA-256 hex digest of the bundle bytes. */
  readonly integrity?: string;
  /**
   * Override the worker creation strategy. Production code rarely
   * passes this; the manager uses the configured global factory.
   */
  readonly workerFactory?: WorkerFactory;
  /** Override host services (test injection). */
  readonly services?: PluginHostServices;
  /**
   * Override init-handshake timeout (ms). Default 10_000. After this,
   * the worker is considered hung and torn down.
   */
  readonly initTimeoutMs?: number;
}

// ── Manager ──────────────────────────────────────────────────────────────

class PluginManagerImpl {
  private readonly hosts = new Map<string, PluginHost>();
  private readonly entries = new Map<string, PluginEntry>();
  private readonly subscribers = new Set<() => void>();
  private defaultFactory: WorkerFactory | null = null;
  private defaultServices: PluginHostServices | null = null;

  /**
   * Wire production defaults. Call once at editor startup. Safe to call
   * multiple times — each call overwrites.
   */
  configure(opts: { factory: WorkerFactory; services: PluginHostServices }): void {
    this.defaultFactory = opts.factory;
    this.defaultServices = opts.services;
  }

  /**
   * Load (or reload) a plugin. Returns once the worker confirms
   * `activate()` resolved. Rejects on init timeout / activate throw /
   * integrity mismatch / etc — in which case the entry is left in
   * `failed` status (visible via `list()`) and the worker terminated.
   */
  async load(manifest: PluginManifest, opts: LoadOptions): Promise<PluginEntry> {
    // Hot reload: dispose any prior version first.
    if (this.hosts.has(manifest.id)) {
      this.unload(manifest.id);
    }

    const factory = opts.workerFactory ?? this.defaultFactory;
    if (factory === null || factory === undefined) {
      throw new Error('PluginManager not configured: no worker factory');
    }
    const services = opts.services ?? this.defaultServices;
    if (services === null || services === undefined) {
      throw new Error('PluginManager not configured: no host services');
    }

    this.setEntry({
      id: manifest.id,
      manifest,
      status: 'loading',
    });

    const worker = factory.create();
    const host = new PluginHost({ manifest, worker, services });
    this.hosts.set(manifest.id, host);

    const initTimeout = opts.initTimeoutMs ?? 10_000;
    try {
      await this.handshake(worker, manifest, opts.bundleUrl, opts.integrity, initTimeout);
      const entry: PluginEntry = {
        id: manifest.id,
        manifest,
        status: 'active',
        stats: host.getStats(),
      };
      this.setEntry(entry);
      return entry;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      host.terminate();
      this.hosts.delete(manifest.id);
      this.setEntry({
        id: manifest.id,
        manifest,
        status: 'failed',
        error: { name: e.name, message: e.message },
      });
      throw e;
    }
  }

  /**
   * Pause a running plugin. The worker stays up — this is a soft pause
   * that flips the entry status to `'paused'` so the UI surfaces the
   * reason (and CTAs to renew/contact support). The plugin's already-
   * registered host disposables continue to fire; renewing the license
   * and calling `resume(id)` is O(1) and avoids a re-import.
   *
   * Hard worker-side pause (freeze pin:change forwarding, drop pending
   * callbacks) is a follow-up for CORE-006b — it requires an RPC
   * `pause`/`resume` round-trip the runtime does not yet implement.
   *
   * Idempotent: pausing an already-paused entry just rewrites the reason.
   * No-op when the entry is not loaded (no `failed`, no `unloaded`).
   */
  pause(id: string, reason: PluginPauseReason): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    if (entry.status === 'failed' || entry.status === 'unloaded') return;
    this.setEntry({
      ...entry,
      status: 'paused',
      pauseReason: reason,
    });
  }

  /**
   * Reverse of `pause`. Only valid when the entry is currently paused
   * AND the worker host is still alive — otherwise the caller should
   * route through `load()` to re-spawn.
   */
  resume(id: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.status !== 'paused') return;
    if (!this.hosts.has(id)) return;
    const next: PluginEntry = {
      id: entry.id,
      manifest: entry.manifest,
      status: 'active',
      ...(entry.error !== undefined ? { error: entry.error } : {}),
    };
    this.setEntry(next);
  }

  /** Tear down. Idempotent — unloading a non-installed id is a no-op. */
  unload(id: string): void {
    const host = this.hosts.get(id);
    if (host !== undefined) {
      host.terminate();
      this.hosts.delete(id);
    }
    if (this.entries.has(id)) {
      this.setEntry({
        ...this.entries.get(id)!,
        status: 'unloaded',
        ...(this.entries.get(id)!.error !== undefined ? { error: this.entries.get(id)!.error! } : {}),
      });
    }
    // Unloaded entries linger in `entries` for the UI to render the row;
    // they're cleaned up on the next `load()` of the same id.
  }

  list(): readonly PluginEntry[] {
    // Refresh stats lazily.
    const out: PluginEntry[] = [];
    for (const entry of this.entries.values()) {
      const host = this.hosts.get(entry.id);
      if (host !== undefined && entry.status === 'active') {
        out.push({ ...entry, stats: host.getStats() });
      } else {
        out.push(entry);
      }
    }
    return out;
  }

  get(id: string): PluginEntry | undefined {
    const entry = this.entries.get(id);
    if (entry === undefined) return undefined;
    const host = this.hosts.get(id);
    if (host !== undefined && entry.status === 'active') {
      return { ...entry, stats: host.getStats() };
    }
    return entry;
  }

  /**
   * Subscribe to entry changes. Returns an unsubscribe function. Fired
   * after every `load`/`unload` and on background status changes.
   */
  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => { this.subscribers.delete(fn); };
  }

  /** Test-only: wipe everything. */
  resetForTests(): void {
    for (const host of this.hosts.values()) {
      try { host.terminate(); } catch { /* ignore */ }
    }
    this.hosts.clear();
    this.entries.clear();
    this.subscribers.clear();
    this.defaultFactory = null;
    this.defaultServices = null;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private setEntry(entry: PluginEntry): void {
    this.entries.set(entry.id, entry);
    this.notify();
  }

  private notify(): void {
    for (const fn of Array.from(this.subscribers)) {
      try { fn(); } catch { /* ignore */ }
    }
  }

  /**
   * Send the init message to a freshly-created worker and wait for
   * either `ready` or `init-error` (or timeout). The worker boots
   * itself by calling `bootWorker(self)` from its top-level script.
   */
  private handshake(
    worker: WorkerLike,
    manifest: PluginManifest,
    bundleUrl: string,
    integrity: string | undefined,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.removeEventListener('message', listener);
        reject(new Error(`Plugin "${manifest.id}" did not become ready within ${timeoutMs}ms`));
      }, timeoutMs);
      const listener = (event: MessageEvent<{ kind?: string; error?: { name?: string; message?: string } }>): void => {
        const data = event.data;
        if (data?.kind === 'ready') {
          clearTimeout(timer);
          worker.removeEventListener('message', listener);
          resolve();
        } else if (data?.kind === 'init-error') {
          clearTimeout(timer);
          worker.removeEventListener('message', listener);
          const err = new Error(data.error?.message ?? 'Plugin activate() failed');
          if (data.error?.name !== undefined) err.name = data.error.name;
          reject(err);
        }
      };
      worker.addEventListener('message', listener as never);
      const init: InitMessage = {
        kind: 'init',
        manifest,
        bundleUrl,
        ...(integrity !== undefined ? { integrity } : {}),
      };
      worker.postMessage(init as never);
    });
  }
}

// ── Singleton ────────────────────────────────────────────────────────────

let instance: PluginManagerImpl | null = null;

export function getPluginManager(): PluginManagerImpl {
  if (instance === null) instance = new PluginManagerImpl();
  return instance;
}

export function resetPluginManagerForTests(): void {
  if (instance !== null) instance.resetForTests();
  instance = null;
}

export type PluginManager = PluginManagerImpl;
