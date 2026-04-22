# Hand-Rolled MNA Solver

Location: [`test/test_circuit/src/solver/`](../../test/test_circuit/src/solver/)

## Modified Nodal Analysis in 500 lines of JavaScript

Modified Nodal Analysis (MNA) is the standard algorithm every SPICE uses. We implement a minimal version: dense matrices, Gaussian elimination, Newton-Raphson for non-linear devices, backward-Euler for transient.

### Why implement it at all?

1. A **transparent baseline** to cross-check ngspice on toy problems.
2. A **fallback** for Velxio environments where `eecircuit-engine` (39 MB) cannot be loaded.
3. **Educational value**: every line is readable; comparing this to ngspice makes ngspice's behaviour concrete.

## The matrix

For a circuit with `N` non-ground nodes and `M` voltage sources, the MNA system has size `(N + M) × (N + M)`.

```
┌                    ┐ ┌        ┐   ┌        ┐
│   G      B         │ │ V_node │   │ I_src  │
│                    │ │        │ = │        │
│   C      0         │ │ I_vs   │   │ V_vs   │
└                    ┘ └        ┘   └        ┘
```

- `G` (N×N): nodal conductance matrix
- `B, C` (N×M, M×N): connection of voltage sources to nodes (+1 / −1)
- Bottom-right 0 block: fixed by definition
- Right-hand side: currents injected at nodes, and the voltage value of each source.

Everything is packed into a single `(N+M)×(N+M)` matrix and RHS vector, and solved in one Gaussian-elimination pass.

### Ground handling

Node `"gnd"` is **not in the matrix**. References to it by components simply skip the stamp on that row/column (a `nodeIndex(gnd) === -1` check).

### Numerical stabilization

Every solve adds `GMIN = 1e-12 S` on every node's self-admittance. This prevents singular matrices when a node has only capacitors or only ideal voltage sources (which, in pure DC mode, could otherwise leave a node with no conductance path).

## The solver loop

```javascript
solveDC({ maxIter = 100, tol = 1e-7, dt }) {
  // 1. Discover voltage sources → extra rows
  this.vsources = components.filter(c => c.isVoltageSource);
  const N = this.nodes.size;
  const M = this.vsources.length;
  const dim = N + M;

  // 2. Reset per-solve state on non-linear devices (pnjlim history etc.)
  for (const c of components) {
    if (c.isNonlinear && typeof c._resetIter === 'function') c._resetIter();
  }

  let x = new Array(dim).fill(0);

  // 3. Newton loop (linear circuits converge in one iteration)
  for (let iter = 0; iter < maxIter; iter++) {
    const G = zeros(dim, dim);
    const b = new Array(dim).fill(0);

    // 4. Numerical stabilization
    for (let i = 0; i < N; i++) G[i][i] += GMIN;

    // 5. Stamp every component at the current x
    const ctx = { nodeIndex, vsourceIndex, nodeVoltageFromX, dt, prev, iteration: iter };
    for (const c of components) c.stampDC(G, b, ctx);

    // 6. Solve G·x' = b
    const xNew = solveLinear(G, b);

    // 7. Converge check + damping (|Δ| ≤ 0.5 V per step after iter 0)
    const maxDelta = max(|xNew[i] - x[i]|);
    x = applyDamping(xNew, x, iter);

    if (!hasNonlinear()) break;         // linear: one iter is enough
    if (maxDelta < tol) break;          // non-linear: converged
  }

  // 8. Store results
  this.state.nodeVoltages = { gnd: 0, ...mapToNames(x) };
  this.state.branchCurrents = mapSourcesToX(x);
}
```

### Why the per-solve `_resetIter()`

Non-linear components carry state between Newton iterations (the `pnjlim` algorithm needs `V_d_prev`). At the start of each solve, we reset that state so the next solve starts from a clean guess. Otherwise a stale `V_d_prev` from a previous simulation would bias the first iteration.

## Stamp catalog

Every component exposes `stampDC(G, b, ctx)`. Here is what each one does.

### Resistor (linear)

```
     a ── R ── b
```

`g = 1/R` stamped on the 2×2 sub-block formed by rows/cols `a` and `b`:

```
G[a][a] += g
G[b][b] += g
G[a][b] -= g
G[b][a] -= g
```

### Voltage source (linear, adds MNA row)

```
     plus ── V1 ── minus
```

For the new row `iv = N + sourceIndex`:

```
G[plus][iv] += 1
G[iv][plus] += 1
G[minus][iv] -= 1
G[iv][minus] -= 1
b[iv] += V1
```

The extra unknown `x[iv]` **is** the current through the source (with sign convention: positive when current enters the `plus` node from outside).

### Current source

Contributes only to `b`:

```
b[from] -= I
b[to]   += I
```

### Capacitor (backward Euler, transient only)

Two behaviours:

- **Pure DC (`ctx.dt` undefined)**: treat as a very large resistor (1e-12 S) between terminals — keeps the matrix non-singular without significantly loading the circuit.
- **Transient (`ctx.dt` given)**: companion model.

```
g_eq = C / dt
V_prev = V(a, t-dt) − V(b, t-dt)         (from ctx.prev)
I_eq = g_eq * V_prev
```

Stamped exactly like a resistor of conductance `g_eq`, plus a current injection of `I_eq` into node `a` and `−I_eq` into node `b`.

At `t = 0`, `ctx.prev` is seeded from the capacitor's `Vinit` initial condition (see `Circuit.runTransient()`).

### Diode / LED (Shockley, non-linear)

The hardest stamp. Current is `I_d = Is · (exp(V_d / (n·Vt)) − 1)`. Linearize each iteration around the previous guess `V_d_prev`:

```
g_d = (Is / (n·Vt)) · exp(V_d_prev / (n·Vt))
I_eq = I_d(V_d_prev) − g_d · V_d_prev
```

Stamp:

```
G[a][a] += g_d
G[c][c] += g_d
G[a][c] -= g_d
G[c][a] -= g_d
b[a]   -= I_eq
b[c]   += I_eq
```

### The `pnjlim` trap

On iteration 0, `V_d_prev` is 0, so `g_d` is tiny (`Is/nVt ≈ 10⁻¹³ S`). The diode behaves as open, so the first solve yields `V_d` ≈ `V_source` (e.g., 5 V). On iteration 1, `exp(5 / 0.026) ≈ 10⁸⁴` — numerical overflow. NaN cascades.

**Fix**: SPICE's `pnjlim` voltage limiting. On iteration 0, clamp `V_d` to `Vcrit`:

```
Vcrit = n·Vt · ln(n·Vt / (√2 · Is))
```

For a default diode (`Is=1e-14, n=1`), `Vcrit ≈ 0.73 V`. On later iterations, apply a logarithmic step limit when `V_d` would jump more than `2·n·Vt`:

```javascript
if (Vd > Vcrit && |Vd - V_prev| > 2·n·Vt) {
  Vd = V_prev + n·Vt · ln(1 + (Vd - V_prev)/(n·Vt));
}
```

This is standard SPICE practice. Result: diode circuits converge reliably in 4–8 iterations.

### LED = Diode with color-specific `Is`, `n`

```javascript
const LED_PARAMS = {
  red:    { Is: 1e-20, n: 1.7, ratedCurrent: 0.020 },
  green:  { Is: 1e-22, n: 1.9, ratedCurrent: 0.020 },
  yellow: { Is: 1e-21, n: 1.8, ratedCurrent: 0.020 },
  blue:   { Is: 1e-28, n: 2.0, ratedCurrent: 0.020 },
  white:  { Is: 1e-28, n: 2.0, ratedCurrent: 0.020 },
};
```

`brightness(state) = min(1, I_forward / ratedCurrent)`. These parameters were tuned so that `Vf` at 10 mA matches typical datasheets (red ≈ 2.0 V, blue ≈ 3.1 V).

### NPN BJT (simplified Ebers-Moll)

Models `I_C = α_F · I_F − I_R` and `I_B = (1 − α_F)·I_F + (1 − α_R)·I_R` with forward/reverse conductance linearizations. The full stamp touches the 3×3 sub-block {C, B, E}.

**Accuracy caveat**: this is the "injection version" of Ebers-Moll. It does not capture deep saturation (`V_CE,sat ≈ 0.1–0.3 V`) accurately — our tests expect `V_CE < 0.8 V` rather than `< 0.3 V`. For educational circuits this is acceptable. For analog design tasks, the Gummel-Poon model would be needed.

### NTC thermistor

Parametric resistor with `R(T) = R0 · exp(β · (1/T − 1/T0))`. `setTemperatureC(c)` updates the effective resistance; `stampDC` delegates to an internal `Resistor` stamp.

### Potentiometer

Two resistors `R_top = (1 − wiperPos) · totalR` and `R_bot = wiperPos · totalR`. `setWiper(pos)` in [0, 1] updates both. Delegates to `Resistor` stamps.

### Switch

`R = 0.001 Ω` closed, `R = 1e9 Ω` open. Delegates to `Resistor` stamp.

## Linear solver

`solveLinear(A, b)` in [`linalg.js`](../../test/test_circuit/src/solver/linalg.js). Gaussian elimination with partial pivoting, O(n³). For the circuits we target (< 50 nodes), this is perfectly adequate. If we ever need > 100 nodes, a sparse solver (CSR matrix, UMFPACK-style) would be warranted.

## Transient stepping

```javascript
runTransient(tEnd, dt, sampleEvery = 1) {
  this.time = 0;

  // Seed prev state from cap initial conditions
  const initV = { gnd: 0, ...eachNodeZero };
  for (const comp of this.components) {
    if (comp.Vinit !== undefined && typeof comp.a === 'string') {
      initV[comp.a] = (initV[comp.b] ?? 0) + comp.Vinit;
    }
  }
  this.state = {
    nodeVoltages: { ...initV },
    branchCurrents: {},
    prev: { nodeVoltages: { ...initV }, branchCurrents: {} },
  };

  const samples = [{ t: 0, nodeVoltages: {...initV}, branchCurrents: {} }];
  while (this.time < tEnd - dt/2) {
    this.stepTransient(dt);   // saves state.prev = current, solves DC with dt
    if (++n % sampleEvery === 0) samples.push({ t: this.time, ...snapshot() });
  }
  return samples;
}
```

### Why we don't call `solveDC()` first at t=0

An earlier bug: the initial `solveDC()` treated the capacitor as open → `V_out = V_source`. That became `V_prev`. The first transient step then saw an already-charged cap and produced a wrong trajectory.

The correct approach: **seed `prev` directly from `Vinit` without an initial DC solve**.

## Limitations and future work

- **Fixed timestep**. No LTE (Local Truncation Error) control → `dt` must be hand-picked. Adequate for testing; not production-grade.
- **Backward Euler only**. Trapezoidal would halve the integration error but needs two-step state. Deferred.
- **Dense matrix**. Fine up to ~50 nodes.
- **No inductor model**. Would need companion model: `G_L = 2L/dt, I_eq = V_prev·G_L + I_prev`. Plus tracking inductor branch currents.
- **No MOSFET model** (the ngspice pipeline covers this).

See [circuit-emulation-velxio-integration.md](circuit-emulation-velxio-integration.md) for which of these would need to be added before Velxio could use this solver as a production fallback.

## Comparing solver vs ngspice on the same problem

Voltage divider: V=9V, R1=1k, R2=2k → V(out) = 6V.

| Method | V(out) | Time |
|---|---|---|
| Hand-rolled MNA | 6.000000 V | ~1 ms |
| ngspice | 6.000000 V | ~10 ms (plus one-time 400 ms boot) |

RC charging to 1τ with R=10k, C=100µF, V=5V, dt=5ms:

| Method | V(τ)  | Expected | Error |
|---|---|---|---|
| Hand-rolled MNA | 3.16 V | 3.16 V | < 0.3 % |
| ngspice | 3.16 V | 3.16 V | < 0.3 % |

LED forward voltage, 220 Ω + red LED @ 5V:

| Method | V(anode) | I_forward | Expected range |
|---|---|---|---|
| Hand-rolled MNA | 2.00 V | 13.6 mA | 1.8–2.3 V, 10–16 mA |
| ngspice (1N4148 model) | 0.68 V | 4.3 mA | (different model — not comparable) |

Conclusions:

- On passive circuits, the two solvers agree to many digits.
- On non-linear circuits, the outcome depends on the `.model` parameters. The hand-rolled LED model was tuned for pedagogical accuracy; ngspice uses whatever model you supply.
- Hand-rolled is ~10× faster for trivial circuits but loses ground on anything complex (dense vs sparse matters at > 20 nodes; also, no `.ac` analysis at all).
