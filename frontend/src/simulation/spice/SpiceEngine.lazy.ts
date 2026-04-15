/**
 * Lazy entry for the SPICE engine.
 *
 * Downstream code should import from this file — it uses a dynamic
 * `import()` so Vite code-splits `eecircuit-engine` (~39 MB) into a
 * separate chunk loaded only when the user first activates the
 * electrical simulation mode.
 *
 * Runtime semantics are identical to `./SpiceEngine`.
 */
import type { SpiceResult, VectorValue, ResultType, ComplexNumber } from './SpiceEngine';

export type { SpiceResult, VectorValue, ResultType, ComplexNumber };

let modulePromise: Promise<typeof import('./SpiceEngine')> | null = null;

function loadModule(): Promise<typeof import('./SpiceEngine')> {
  if (!modulePromise) {
    modulePromise = import('./SpiceEngine');
  }
  return modulePromise;
}

/**
 * Fetch the SPICE module (downloads ~39 MB WASM on first call) and boot
 * the engine. Resolves when `runNetlist` is ready to accept input.
 *
 * Call this from a UI affordance (e.g. the "⚡ Electrical" toggle) to
 * show a progress indicator on first activation.
 */
export async function preloadSpiceEngine(): Promise<void> {
  const mod = await loadModule();
  await mod.getEngine();
}

/**
 * Submit a netlist and await its results. Triggers lazy-load on first call.
 */
export async function runNetlist(netlist: string): Promise<SpiceResult> {
  const mod = await loadModule();
  return mod.runNetlist(netlist);
}

/**
 * True once the module is loaded *and* the engine has finished booting.
 * Useful for a UI "Ready" indicator.
 */
export async function isEngineReady(): Promise<boolean> {
  if (!modulePromise) return false;
  const mod = await modulePromise;
  return mod.isEngineReady();
}

/**
 * Re-export `NL` helpers (pure strings, zero-cost so no need to lazy-split).
 * We lazily assign them on first `runNetlist` call; guard with a getter so
 * consumers can do `const { NL } = await import('./SpiceEngine.lazy')`.
 */
export async function getNL() {
  const mod = await loadModule();
  return mod.NL;
}
