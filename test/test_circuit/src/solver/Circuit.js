import { solveLinear, zeros } from './linalg.js';

const GROUND = 'gnd';
const Vt = 0.02585;   // thermal voltage at 300 K
const GMIN = 1e-12;   // minimum shunt conductance for numerical stability

/**
 * Modified Nodal Analysis solver.
 *
 * Usage:
 *   const c = new Circuit();
 *   c.addComponent(new VoltageSource('V1', 'a', 'gnd', 5));
 *   c.addComponent(new Resistor('R1', 'a', 'b', 1000));
 *   c.addComponent(new Resistor('R2', 'b', 'gnd', 2000));
 *   c.solveDC();
 *   c.nodeVoltage('b');  // → 3.333 V
 */
export class Circuit {
  constructor() {
    this.components = [];
    this.nodes = new Map();     // nodeName → index (gnd is not in the matrix)
    this.vsources = [];         // components that add extra MNA rows
    this.state = {
      nodeVoltages: {},         // nodeName → V  (gnd = 0)
      branchCurrents: {},       // vsourceName → I
      prev: null,               // previous-step state for transient
    };
    this.time = 0;
  }

  addComponent(c) {
    this.components.push(c);
    for (const n of c.nodes()) this._ensureNode(n);
    return this;
  }

  removeComponent(name) {
    this.components = this.components.filter(c => c.name !== name);
  }

  getComponent(name) {
    return this.components.find(c => c.name === name);
  }

  _ensureNode(name) {
    if (name === GROUND) return;
    if (!this.nodes.has(name)) this.nodes.set(name, this.nodes.size);
  }

  _nodeIndex(name) {
    if (name === GROUND) return -1;
    return this.nodes.get(name);
  }

  /** Build and solve the DC system. Returns { nodeVoltages, branchCurrents }. */
  solveDC(opts = {}) {
    const maxIter = opts.maxIter ?? 100;
    const tol = opts.tol ?? 1e-7;

    this.vsources = this.components.filter(c => c.isVoltageSource);
    const N = this.nodes.size;
    const M = this.vsources.length;
    const dim = N + M;

    // Newton-Raphson for non-linear elements (diodes, LEDs, BJTs)
    let x = new Array(dim).fill(0);
    let converged = false;

    // Reset non-linear device per-solve state so pnjlim starts clean
    for (const c of this.components) {
      if (c.isNonlinear && typeof c._resetIter === 'function') c._resetIter();
    }

    for (let iter = 0; iter < maxIter; iter++) {
      const G = zeros(dim, dim);
      const b = new Array(dim).fill(0);

      // Tiny shunt to ground on every node for numerical stability
      for (let i = 0; i < N; i++) G[i][i] += GMIN;

      const ctx = {
        nodeIndex: (n) => this._nodeIndex(n),
        vsourceIndex: (name) => {
          const idx = this.vsources.findIndex(v => v.name === name);
          return idx < 0 ? -1 : N + idx;
        },
        nodeVoltageFromX: (n) => {
          if (n === GROUND) return 0;
          const i = this._nodeIndex(n);
          return x[i] ?? 0;
        },
        dt: opts.dt,
        prev: this.state.prev,
        time: this.time,
        iteration: iter,
      };

      for (const c of this.components) c.stampDC(G, b, ctx);

      let xNew;
      try {
        xNew = solveLinear(G, b);
      } catch (e) {
        throw new Error(`DC solve failed at iteration ${iter}: ${e.message}`);
      }

      // Convergence check
      let maxDelta = 0;
      for (let i = 0; i < dim; i++) {
        maxDelta = Math.max(maxDelta, Math.abs(xNew[i] - x[i]));
      }

      // Damping: if any diode/BJT node moves more than 0.2 V, limit the step
      const dampedX = xNew.map((v, i) => {
        const delta = v - x[i];
        if (Math.abs(delta) > 0.5 && iter > 0) {
          return x[i] + Math.sign(delta) * 0.5;
        }
        return v;
      });

      x = dampedX;

      const hasNonlinear = this.components.some(c => c.isNonlinear);
      if (!hasNonlinear) { converged = true; break; }
      if (maxDelta < tol) { converged = true; break; }
    }

    if (!converged) {
      // Attach warning but keep state
      this.state.converged = false;
    } else {
      this.state.converged = true;
    }

    // Save results
    this.state.nodeVoltages = { [GROUND]: 0 };
    for (const [name, idx] of this.nodes) {
      this.state.nodeVoltages[name] = x[idx];
    }
    this.state.branchCurrents = {};
    for (let i = 0; i < this.vsources.length; i++) {
      this.state.branchCurrents[this.vsources[i].name] = x[N + i];
    }
    return this.state;
  }

  /** Advance time by dt, solving transient using backward Euler. */
  stepTransient(dt) {
    this.state.prev = {
      nodeVoltages: { ...this.state.nodeVoltages },
      branchCurrents: { ...this.state.branchCurrents },
    };
    const res = this.solveDC({ dt });
    this.time += dt;
    return res;
  }

  /** Run transient from t=0 to tEnd with fixed dt. Returns array of snapshots. */
  runTransient(tEnd, dt, sampleEvery = 1) {
    const samples = [];
    this.time = 0;
    // Seed prev state from capacitor initial voltages.
    const initVoltages = { gnd: 0 };
    for (const [n] of this.nodes) initVoltages[n] = 0;
    for (const comp of this.components) {
      if (comp.Vinit !== undefined && typeof comp.a === 'string') {
        initVoltages[comp.a] = (initVoltages[comp.b] ?? 0) + comp.Vinit;
      }
    }
    this.state = {
      nodeVoltages: { ...initVoltages },
      branchCurrents: {},
      prev: { nodeVoltages: { ...initVoltages }, branchCurrents: {} },
    };
    samples.push({ t: 0, nodeVoltages: { ...initVoltages }, branchCurrents: {} });
    let n = 0;
    while (this.time < tEnd - dt / 2) {
      this.stepTransient(dt);
      n++;
      if (n % sampleEvery === 0) samples.push({ t: this.time, ...this._snapshot() });
    }
    return samples;
  }

  _snapshot() {
    return {
      nodeVoltages: { ...this.state.nodeVoltages },
      branchCurrents: { ...this.state.branchCurrents },
    };
  }

  nodeVoltage(name) {
    return this.state.nodeVoltages[name] ?? 0;
  }

  branchCurrent(name) {
    return this.state.branchCurrents[name] ?? 0;
  }

  reset() {
    this.state = { nodeVoltages: {}, branchCurrents: {}, prev: null };
    this.time = 0;
  }
}

export { GROUND, Vt, GMIN };
