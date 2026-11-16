/**
 * Test-only compatibility shim that exposes the legacy SpiceEngine
 * `runNetlist(netlist) → SpiceResult` shape on top of the new
 * NgSpiceNodeAdapter.  Lets the existing ~22 test files migrate to
 * the single real-WASM solver without rewriting every assertion.
 *
 * Phase 1c F2 of the mixed-mode migration.  Once every test file
 * is comfortable on the new solver, this helper becomes thin
 * enough that test authors can use SolverPort directly.
 */
import {
  NgSpiceNodeAdapter,
} from '../../simulation/spice/adapters/NgSpiceNodeAdapter';

/** Test-local copy of the complex-number shape consumers expect. */
export interface ComplexNumber {
  real: number;
  img: number;
}

let singleton: NgSpiceNodeAdapter | null = null;

function getAdapter(): NgSpiceNodeAdapter {
  if (!singleton) singleton = new NgSpiceNodeAdapter();
  return singleton;
}

/** Detect the analysis directive inside a netlist string. */
function detectAnalysis(netlist: string):
  | { kind: 'op' }
  | { kind: 'tran'; step: string; stop: string; start?: string }
  | { kind: 'ac'; sweep: 'dec' | 'oct' | 'lin'; points: number; fstart: number; fstop: number } {
  const lines = netlist.split('\n');
  for (const line of lines) {
    const trimmed = line.trim().toLowerCase();
    if (trimmed.startsWith('.op')) return { kind: 'op' };
    if (trimmed.startsWith('.tran ')) {
      const parts = trimmed.split(/\s+/);
      // `.tran tstep tstop [tstart]`: a deck that settles first stores from tstart.
      return parts[3]
        ? { kind: 'tran', step: parts[1] ?? '1u', stop: parts[2] ?? '1m', start: parts[3] }
        : { kind: 'tran', step: parts[1] ?? '1u', stop: parts[2] ?? '1m' };
    }
    if (trimmed.startsWith('.ac ')) {
      const parts = trimmed.split(/\s+/);
      return {
        kind: 'ac',
        sweep: (parts[1] as 'dec' | 'oct' | 'lin') ?? 'dec',
        points: parseInt(parts[2] ?? '20', 10),
        fstart: parseFloat(parts[3] ?? '1'),
        fstop: parseFloat(parts[4] ?? '1e6'),
      };
    }
  }
  return { kind: 'op' };
}

export type VectorValue = number | ComplexNumber;

export interface SpiceTestResult {
  variableNames: string[];
  vec(name: string): VectorValue[];
  dcValue(name: string): number;
  vAtLast(name: string): VectorValue;
  findVar(name: string): number;
}

/**
 * Same surface as the legacy `SpiceEngine.runNetlist`.  Drop-in
 * replacement for test files.
 */
export async function runNetlist(netlist: string): Promise<SpiceTestResult> {
  const adapter = getAdapter();
  await adapter.init();
  await adapter.loadCircuit(netlist);
  const analysis = detectAnalysis(netlist);
  // First do a "quick" solve so we know which vectors exist; then
  // request all of them.
  // Run the analysis ONCE with no vectorsOfInterest; then enumerate +
  // read every vector from the resulting plot without re-running.
  // Re-running creates a new plot and invalidates pointers, so the
  // single-solve path is mandatory for tests that read every vector.
  await adapter.solve(analysis, { vectorsOfInterest: [] });
  const allRead = adapter.readAllCurrentVectors();
  const rawVecs = allRead.rawNames;
  // Translate ngspice's raw vector names to the legacy SpiceResult
  // convention so existing tests don't need to change every readVec:
  //   bare net  ('n1', 'vcc_rail')  → 'v(n1)', 'v(vcc_rail)'
  //   '<src>#branch'                → 'i(<src>)'
  //   'time' / 'frequency'          → unchanged (axes)
  const SPECIAL_AXES = new Set(['time', 'frequency']);
  const ngspiceNameFor = (legacyName: string): string => {
    const l = legacyName.toLowerCase();
    if (SPECIAL_AXES.has(l)) return l;
    const mV = l.match(/^v\((.+)\)$/);
    if (mV) return mV[1]!;
    const mI = l.match(/^i\((.+)\)$/);
    if (mI) return `${mI[1]!}#branch`;
    return l;
  };
  const legacyNameFor = (ngName: string): string => {
    const l = ngName.toLowerCase();
    if (SPECIAL_AXES.has(l)) return l;
    const m = l.match(/^(.+)#branch$/);
    if (m) return `i(${m[1]!})`;
    return `v(${l})`;
  };
  const lowered = rawVecs.map(legacyNameFor);
  const result = {
    analysis,
    vectors: allRead.vectors,
    timeAxis: new Float64Array(0),
    solveMs: 0,
    warnings: [] as string[],
  };
  // For .tran, find the time axis among the read vectors.
  if (analysis.kind === 'tran') {
    const tVec = result.vectors.get('time');
    if (tVec) result.timeAxis = tVec.real;
  }

  const find = (name: string): number => {
    const l = name.toLowerCase();
    let idx = lowered.indexOf(l);
    if (idx >= 0) return idx;
    // Also try with v() wrapping for bare net names.
    idx = lowered.indexOf(`v(${l})`);
    if (idx >= 0) return idx;
    return -1;
  };
  const getVec = (name: string): VectorValue[] => {
    const ngKey = ngspiceNameFor(name);
    const lower = name.toLowerCase();
    let vec = result.vectors.get(ngKey);
    if (!vec) vec = result.vectors.get(lower);
    if (!vec) vec = result.vectors.get(`v(${lower})`);
    if (!vec) {
      throw new Error(
        `[testSolver] Variable "${name}" not found. Available: ${lowered.join(', ')}`,
      );
    }
    if (vec.imag) {
      const arr: VectorValue[] = [];
      for (let i = 0; i < vec.real.length; i++) {
        arr.push({ real: vec.real[i] ?? 0, img: vec.imag[i] ?? 0 } as unknown as ComplexNumber);
      }
      return arr;
    }
    return Array.from(vec.real);
  };

  return {
    variableNames: lowered,
    findVar: find,
    vec: getVec,
    dcValue: (name) => {
      const v = getVec(name)[0];
      if (typeof v === 'number') return v;
      return (v as { real: number }).real;
    },
    vAtLast: (name) => {
      const v = getVec(name);
      return v[v.length - 1]!;
    },
  };
}

/** Test teardown helper — release the singleton between describe blocks. */
export function __disposeTestSolver(): void {
  if (singleton) {
    try { singleton.dispose(); } catch { /* ignore */ }
  }
  singleton = null;
}

/**
 * SPICE source-card helpers, mirroring the legacy `SpiceEngine.NL`
 * surface so existing tests don't need to inline the printf-style
 * builders.
 */
export const NL = {
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
  sin(
    name: string,
    plus: string,
    minus: string,
    offset: number,
    amp: number,
    freq: number,
  ): string {
    return `${name} ${plus} ${minus} SIN(${offset} ${amp} ${freq})`;
  },
  pwl(name: string, plus: string, minus: string, pairs: Array<[number, number]>): string {
    return `${name} ${plus} ${minus} PWL(${pairs.flat().join(' ')})`;
  },
  dc(name: string, plus: string, minus: string, value: number | string): string {
    return `${name} ${plus} ${minus} DC ${value}`;
  },
  ac(name: string, plus: string, minus: string, amp: number | string): string {
    return `${name} ${plus} ${minus} AC ${amp}`;
  },
};
