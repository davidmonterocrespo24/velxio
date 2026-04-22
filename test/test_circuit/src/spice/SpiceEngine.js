import { Simulation } from 'eecircuit-engine';

/**
 * Thin wrapper around eecircuit-engine (ngspice-WASM).
 *
 * Provides:
 *   - Boot-once singleton (ngspice WASM takes ~400 ms to spin up)
 *   - runNetlist(text) → ResultType
 *   - result helpers: getVector(name), voltage(node, pointIdx), sweep(name)
 */
let singleton = null;
let bootPromise = null;

async function bootEngine() {
  if (singleton) return singleton;
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    const sim = new Simulation();
    await sim.start();
    singleton = sim;
    return sim;
  })();
  return bootPromise;
}

export async function getEngine() {
  return bootEngine();
}

/**
 * Submit a netlist, run it, return the raw ResultType plus a few helpers.
 * The ngspice engine is serial — running another simulation clobbers the prior one,
 * so all tests that share state must await their own run.
 */
export async function runNetlist(netlist) {
  const sim = await bootEngine();
  sim.setNetList(netlist);
  const raw = await sim.runSim();

  const lowerNames = raw.variableNames.map(n => n.toLowerCase());
  const findVar = (name) => {
    const lname = name.toLowerCase();
    let idx = lowerNames.indexOf(lname);
    if (idx >= 0) return idx;
    // Also accept v(node) ↔ node
    idx = lowerNames.indexOf(`v(${lname})`);
    if (idx >= 0) return idx;
    // tran sweep variable is "time"; AC is "frequency"
    return -1;
  };

  const vec = (name) => {
    const idx = findVar(name);
    if (idx < 0) throw new Error(`Variable "${name}" not found. Available: ${raw.variableNames.join(', ')}`);
    if (raw.dataType === 'complex') {
      return raw.data[idx].values;  // [{real, img}]
    }
    return raw.data[idx].values;    // number[]
  };

  const vAtLast = (name) => {
    const v = vec(name);
    const last = v[v.length - 1];
    return typeof last === 'number' ? last : last;
  };

  const dcValue = (name) => {
    const v = vec(name);
    return v[0];
  };

  return { raw, vec, dcValue, vAtLast, findVar, variableNames: raw.variableNames };
}

/**
 * Build common netlist snippets.
 */
export const NL = {
  /** Generic PULSE source: V pin1 pin2 PULSE(V1 V2 TD TR TF PW PER) */
  pulse: (name, p, n, v1, v2, td, tr, tf, pw, per) =>
    `${name} ${p} ${n} PULSE(${v1} ${v2} ${td} ${tr} ${tf} ${pw} ${per})`,
  /** Generic SIN source */
  sin: (name, p, n, offset, amp, freq) =>
    `${name} ${p} ${n} SIN(${offset} ${amp} ${freq})`,
  /** Piece-wise linear source: pairs [[t0,v0],[t1,v1],...] */
  pwl: (name, p, n, pairs) =>
    `${name} ${p} ${n} PWL(${pairs.flat().join(' ')})`,
};
