/**
 * Host implementation of `DisposableStore` (SDK-007).
 *
 * The plugin-facing `ctx.subscriptions` is one of these. Every registry
 * adapter in `createPluginContext` also pushes its handle here so that a
 * single `dispose()` call tears down both plugin-managed and host-managed
 * disposables in the same LIFO unwind.
 *
 * Semantics (from the SDK's `DisposableStore` doc):
 *   - LIFO unwind on `dispose()`.
 *   - `dispose()` is idempotent.
 *   - A throw inside one disposable is logged and swallowed.
 *   - After `dispose()`, `add(d)` disposes `d` immediately so racing
 *     async work can't leak.
 */

import type { Disposable, DisposableStore, PluginLogger } from '@velxio/sdk';

export class HostDisposableStore implements DisposableStore {
  private readonly items: Disposable[] = [];
  private _disposed = false;
  private readonly logger: PluginLogger;
  private readonly contextLabel: string;

  constructor(logger: PluginLogger, contextLabel: string) {
    this.logger = logger;
    this.contextLabel = contextLabel;
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  get size(): number {
    return this.items.length;
  }

  add(d: Disposable): void {
    if (this._disposed) {
      // The plugin (or host adapter) raced our teardown. Dispose the
      // arrival immediately so it can't leak — and log so the author
      // notices their async lifecycle bug.
      this.logger.warn(
        `subscriptions.add() called after dispose (${this.contextLabel}); disposing immediately to avoid leak`,
      );
      try {
        d.dispose();
      } catch (err) {
        this.logger.error(
          `late-arrival disposable threw on immediate dispose (${this.contextLabel}):`,
          err,
        );
      }
      return;
    }
    this.items.push(d);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    // LIFO unwind so resources are released in the reverse order they were
    // acquired — matches `using`/`finally` semantics. A throw inside one
    // disposable must NOT block the others from being torn down.
    for (let i = this.items.length - 1; i >= 0; i--) {
      try {
        this.items[i].dispose();
      } catch (err) {
        this.logger.error(
          `dispose threw for one of the tracked subscriptions (${this.contextLabel}):`,
          err,
        );
      }
    }
    this.items.length = 0;
  }
}
