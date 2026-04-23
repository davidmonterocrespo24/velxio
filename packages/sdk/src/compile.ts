/**
 * Compile middleware contract.
 *
 * A compile middleware is a function a plugin registers to inspect or
 * modify sketch files before they reach arduino-cli (pre-compile) or
 * to inspect compiler output afterwards (post-compile).
 *
 * Two tiers:
 *   - `client` tier runs in the browser before the sketch is uploaded.
 *     Requires the `compile.transform.client` permission.
 *   - `server` tier would run on the backend — intentionally not exposed
 *     to plugins in Phase 0 (defer until PRO-* hosting decision).
 */

import type { Disposable } from './components';

export type CompileTier = 'client';

/** One file in a sketch. Matches the backend's `SketchFile` shape. */
export interface SketchFile {
  name: string;
  content: string;
}

/** Context shared across all middlewares for a single compile run. */
export interface CompileContext {
  readonly runId: string;
  readonly board: string;
  /** Wall-clock start of the compile run. */
  readonly startedAt: number;
  /**
   * Plugins may attach arbitrary notes here. The host surfaces them in
   * the compile output panel. Do not rely on them for flow control.
   */
  notes: Array<{ readonly pluginId: string; readonly message: string }>;
}

/**
 * A pre-compile middleware. Receives the files and context; returns the
 * files (possibly modified). Non-mutating: return a new array if you need
 * changes. Middlewares run in registration order.
 */
export type PreCompileMiddleware = (
  files: ReadonlyArray<SketchFile>,
  ctx: CompileContext,
) => Promise<ReadonlyArray<SketchFile>> | ReadonlyArray<SketchFile>;

/** Compile outcome — receives what the backend returned. */
export interface CompileResult {
  readonly ok: boolean;
  readonly durationMs: number;
  readonly hex?: string;
  readonly stderr?: string;
  readonly stdout?: string;
}

/** Post-compile middleware: observe, log, annotate. Cannot change outcome. */
export type PostCompileMiddleware = (
  result: CompileResult,
  ctx: CompileContext,
) => Promise<void> | void;

/** Public registry exposed through `PluginContext.compile`. */
export interface CompileMiddlewareRegistry {
  pre(tier: CompileTier, middleware: PreCompileMiddleware): Disposable;
  post(tier: CompileTier, middleware: PostCompileMiddleware): Disposable;
}
