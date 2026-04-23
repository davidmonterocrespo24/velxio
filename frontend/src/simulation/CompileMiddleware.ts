/**
 * Client-tier compile middleware chain.
 *
 * Plugins (and Core built-ins) register pre- and post-compile hooks that
 * the compilation service runs around the HTTP request to the backend.
 *
 * Ordering:
 *   - `pre` middlewares run in **registration order**. Each one receives
 *     the (possibly transformed) files and returns the next files.
 *   - `post` middlewares run in **reverse registration order** (LIFO) after
 *     the backend responds. They cannot change the outcome — only observe.
 *
 * Error handling:
 *   - A throwing `pre` middleware aborts the run. The failure surfaces as
 *     a `compile:done { ok: false }` event and as an `Error` in the caller.
 *   - A throwing `post` middleware is caught and logged; subsequent post
 *     middlewares still run. Compile output is never corrupted by a buggy
 *     plugin.
 *
 * Timeout:
 *   - Each middleware is wrapped in a 5 s timeout. A middleware that
 *     exceeds this is aborted and logged. `pre` timeout aborts the run;
 *     `post` timeout is swallowed (observers cannot stall the UI).
 *
 * The server-tier middleware (running on the FastAPI side) is defined in
 * `backend/app/services/compile_middleware.py` and exists as a separate
 * registry — intentionally not exposed to third-party plugins until the
 * server-side sandbox ships.
 */

import type {
  CompileTier,
  PreCompileMiddleware,
  PostCompileMiddleware,
  CompileContext,
  CompileMiddlewareRegistry,
  CompileResult,
  SketchFile,
  Disposable,
} from '@velxio/sdk';

const MIDDLEWARE_TIMEOUT_MS = 5000;

interface Entry<T> {
  tier: CompileTier;
  fn: T;
  pluginId: string;
}

export class CompileMiddlewareChain implements CompileMiddlewareRegistry {
  private preHooks: Array<Entry<PreCompileMiddleware>> = [];
  private postHooks: Array<Entry<PostCompileMiddleware>> = [];

  pre(tier: CompileTier, middleware: PreCompileMiddleware): Disposable {
    return this.preWithOwner(tier, middleware, 'anonymous');
  }
  post(tier: CompileTier, middleware: PostCompileMiddleware): Disposable {
    return this.postWithOwner(tier, middleware, 'anonymous');
  }

  /** Host-side variant that records the owning plugin for diagnostics. */
  preWithOwner(
    tier: CompileTier,
    middleware: PreCompileMiddleware,
    pluginId: string,
  ): Disposable {
    const entry: Entry<PreCompileMiddleware> = { tier, fn: middleware, pluginId };
    this.preHooks.push(entry);
    return {
      dispose: () => {
        const i = this.preHooks.indexOf(entry);
        if (i >= 0) this.preHooks.splice(i, 1);
      },
    };
  }

  postWithOwner(
    tier: CompileTier,
    middleware: PostCompileMiddleware,
    pluginId: string,
  ): Disposable {
    const entry: Entry<PostCompileMiddleware> = { tier, fn: middleware, pluginId };
    this.postHooks.push(entry);
    return {
      dispose: () => {
        const i = this.postHooks.indexOf(entry);
        if (i >= 0) this.postHooks.splice(i, 1);
      },
    };
  }

  preCount(): number {
    return this.preHooks.length;
  }

  postCount(): number {
    return this.postHooks.length;
  }

  /**
   * Run all pre-compile middlewares. Returns the transformed files array.
   * Throws if any middleware throws or times out — callers should surface
   * the error as a `compile:done { ok: false }` event.
   */
  async runPre(
    files: ReadonlyArray<SketchFile>,
    ctx: CompileContext,
  ): Promise<ReadonlyArray<SketchFile>> {
    let current = files;
    for (const entry of this.preHooks) {
      try {
        const next = await withTimeout(
          Promise.resolve(entry.fn(current, ctx)),
          MIDDLEWARE_TIMEOUT_MS,
          `pre-compile middleware from ${entry.pluginId}`,
        );
        if (!Array.isArray(next) || next.length === 0) {
          throw new Error(
            `pre-compile middleware from ${entry.pluginId} returned no files`,
          );
        }
        current = next;
      } catch (err) {
        console.error(
          `[compile] pre middleware ${entry.pluginId} threw:`,
          err,
        );
        throw err;
      }
    }
    return current;
  }

  /**
   * Run all post-compile middlewares in reverse (LIFO) order. Swallows
   * exceptions and timeouts — never throws. Observers cannot affect the
   * compile outcome.
   */
  async runPost(result: CompileResult, ctx: CompileContext): Promise<void> {
    for (let i = this.postHooks.length - 1; i >= 0; i--) {
      const entry = this.postHooks[i];
      try {
        await withTimeout(
          Promise.resolve(entry.fn(result, ctx)),
          MIDDLEWARE_TIMEOUT_MS,
          `post-compile middleware from ${entry.pluginId}`,
        );
      } catch (err) {
        console.error(
          `[compile] post middleware ${entry.pluginId} threw (suppressed):`,
          err,
        );
      }
    }
  }

  /** Test-only: remove every registered middleware. */
  __clearForTests(): void {
    this.preHooks = [];
    this.postHooks = [];
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ── Singleton ──────────────────────────────────────────────────────────
let globalChain: CompileMiddlewareChain | null = null;

export function getCompileMiddlewareChain(): CompileMiddlewareChain {
  if (globalChain === null) globalChain = new CompileMiddlewareChain();
  return globalChain;
}

export function __resetCompileMiddlewareForTests(): void {
  globalChain = null;
}
