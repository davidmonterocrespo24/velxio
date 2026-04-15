/**
 * SpiceEngine — thin wrapper around eecircuit-engine (ngspice-WASM).
 *
 * This is the **non-lazy** module. It imports `eecircuit-engine` directly
 * and is therefore pulled into every bundle that touches it. Production
 * code should import from `./SpiceEngine.lazy` instead, which code-splits
 * the 39 MB dependency behind a dynamic `import()`.
 *
 * See plan: test/test_circuit/plan/phase_8_velxio_implementation.md
 * See sandbox: test/test_circuit/src/spice/SpiceEngine.js
 */
import { Simulation, type ResultType, type ComplexNumber } from 'eecircuit-engine';

/** One complex number, re-exported for convenience. */
export type { ResultType, ComplexNumber };

/** Per-variable data array returned by `vec()`. */
export type VectorValue = number | ComplexNumber;

/** Cooked result returned by `runNetlist()`. */
export interface SpiceResult {
  /** The underlying ngspice result — use this for edge cases. */
  raw: ResultType;
  /** Array of every variable name ngspice returned. */
  variableNames: string[];
  /** Returns the full data array for a variable. For `.ac` sweeps it's `ComplexNumber[]`; otherwise `number[]`. */
  vec(name: string): VectorValue[];
  /** Returns the first data point for a variable (useful for `.op`). */
  dcValue(name: string): number;
  /** Returns the last data point for a variable. */
  vAtLast(name: string): VectorValue;
  /** Resolves a variable name (case-insensitive, auto-wraps `v()`) to an index, or -1. */
  findVar(name: string): number;
}

// ── Singleton boot ─────────────────────────────────────────────────────────

let singleton: Simulation | null = null;
let bootPromise: Promise<Simulation> | null = null;

async function bootEngine(): Promise<Simulation> {
  if (singleton) return singleton;
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    const t0 = performance.now();
    const sim = new Simulation();
    await sim.start();
    singleton = sim;
    const dt = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[SpiceEngine] boot in ${dt.toFixed(0)}ms`);
    return sim;
  })();
  return bootPromise;
}

/** Returns the (lazy-booted) ngspice Simulation singleton. */
export async function getEngine(): Promise<Simulation> {
  return bootEngine();
}

/** True if the engine has finished booting (i.e., `runSim` is safe). */
export function isEngineReady(): boolean {
  return singleton !== null;
}

// ── Main API ───────────────────────────────────────────────────────────────

/**
 * Submit a netlist, run it, return cooked results.
 *
 * ngspice is serial: concurrent calls are serialized by the caller. If you
 * need parallel simulation, spawn a Web Worker per instance (out of scope here).
 */
export async function runNetlist(netlist: string): Promise<SpiceResult> {
  const sim = await bootEngine();
  const t0 = performance.now();

  sim.setNetList(netlist);
  const raw = await sim.runSim();

  const dt = performance.now() - t0;
  if (dt > 200) {
    // eslint-disable-next-line no-console
    console.log(`[SpiceEngine] slow solve: ${dt.toFixed(0)}ms`);
  }

  const lowerNames = raw.variableNames.map((n) => n.toLowerCase());

  const findVar = (name: string): number => {
    const l = name.toLowerCase();
    let idx = lowerNames.indexOf(l);
    if (idx >= 0) return idx;
    idx = lowerNames.indexOf(`v(${l})`);
    if (idx >= 0) return idx;
    return -1;
  };

  const vec = (name: string): VectorValue[] => {
    const idx = findVar(name);
    if (idx < 0) {
      throw new Error(
        `[SpiceEngine] Variable "${name}" not found. Available: ${raw.variableNames.join(', ')}`,
      );
    }
    // TS union: raw.data[idx].values is number[] | ComplexNumber[]
    return raw.data[idx].values as VectorValue[];
  };

  const dcValue = (name: string): number => {
    const v = vec(name)[0];
    if (typeof v === 'number') return v;
    // Complex at DC: return the real part
    return v.real;
  };

  const vAtLast = (name: string): VectorValue => {
    const v = vec(name);
    return v[v.length - 1];
  };

  return {
    raw,
    variableNames: raw.variableNames,
    findVar,
    vec,
    dcValue,
    vAtLast,
  };
}

// ── Netlist card helpers ───────────────────────────────────────────────────

/**
 * Convenience builders for the most common SPICE source cards.
 * These are pure string helpers; no side effects.
 */
export const NL = {
  /** `Vname plus minus PULSE(v1 v2 td tr tf pw per)` */
  pulse(
    name: string,
    plus: string,
    minus: string,
    v1: number | string,
    v2: number | string,
    td: number | string,
    tr: number | string,
    tf: number | string,
    pw: number | string,
    per: number | string,
  ): string {
    return `${name} ${plus} ${minus} PULSE(${v1} ${v2} ${td} ${tr} ${tf} ${pw} ${per})`;
  },

  /** `Vname plus minus SIN(offset amp freq)` */
  sin(name: string, plus: string, minus: string, offset: number, amp: number, freq: number): string {
    return `${name} ${plus} ${minus} SIN(${offset} ${amp} ${freq})`;
  },

  /** `Vname plus minus PWL(t0 v0 t1 v1 ...)` */
  pwl(name: string, plus: string, minus: string, pairs: Array<[number, number]>): string {
    return `${name} ${plus} ${minus} PWL(${pairs.flat().join(' ')})`;
  },

  /** `Vname plus minus DC value` */
  dc(name: string, plus: string, minus: string, value: number | string): string {
    return `${name} ${plus} ${minus} DC ${value}`;
  },

  /** `Vname plus minus AC amp` (for small-signal sweeps) */
  ac(name: string, plus: string, minus: string, amp: number | string): string {
    return `${name} ${plus} ${minus} AC ${amp}`;
  },
};

// ── Reset (for tests / debugging) ──────────────────────────────────────────

/**
 * Throw away the singleton and force a fresh boot on the next call.
 * Tests can use this to isolate themselves from engine state carried over
 * from previous simulations. Production code should not need this.
 */
export function __resetEngineForTests(): void {
  singleton = null;
  bootPromise = null;
}
