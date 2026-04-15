# Performance Analysis

Measurements on WSL2 / Ubuntu 22.04 / Node.js 22.22.2 / Intel i7-12700.

## Full suite

```
Test Files  14 passed (14)
Tests       47 passed (47)
Duration    ~5 s total (wall clock)
            ~8 s user+sys CPU time
```

Breakdown by file (rounded):

| Suite | Tests | Duration |
|---|---|---|
| `avr_blink.test.js` | 2 | 2.4 s |
| `spice_transient.test.js` | 2 | 630 ms |
| `spice_555_astable.test.js` | 1 | 610 ms |
| `spice_active.test.js` | 6 | 600 ms |
| `spice_digital.test.js` | 4 | 420 ms |
| `spice_avr_mixed.test.js` | 3 | 800 ms |
| `spice_passive.test.js` | 3 | 360 ms |
| `spice_ac.test.js` | 2 | 340 ms |
| `ngspice_smoke.test.js` | 1 | 370 ms |
| `diodes.test.js` | 7 | 15 ms |
| `passive.test.js` | 11 | 10 ms |
| `e2e_pot_pwm_led.test.js` | 1 | 90 ms |
| `e2e_thermistor.test.js` | 1 | 120 ms |
| `transient_rc.test.js` | 3 | 25 ms |

Observations:

- **`avr_blink.test.js` dominates** (2.4 s of 5 s total). This is because it runs 2 × 2 seconds of real AVR time at 16 MHz = 32 M cycles per test, executed by `avr8js` in JavaScript. Nothing to optimise — that's the entire point of the test.
- **Hand-rolled MNA tests are essentially free** (passive: 10 ms for 11 tests, diodes: 15 ms for 7). A single `solveDC()` takes < 1 ms.
- **ngspice tests are dominated by the 400 ms first-boot cost**, which is paid once per test process. Each subsequent `runSim()` is 5–500 ms.
- **`spice_transient.test.js` costs 630 ms** largely because the RLC ringing test runs 30 ms of transient at 10 µs step = 3000 points with an inductor requiring fine integration.

## Per-analysis benchmarks (ngspice)

One-off timings for common patterns. Boot cost of 400 ms amortized over all runs in a process.

| Analysis | Circuit | Points | Time |
|---|---|---|---|
| `.op` | 3 R + 1 V | 1 | 5–10 ms |
| `.op` | 1 D + 1 R + 1 V | 1 | 20–30 ms |
| `.op` | 1 BJT + 3 R + 1 V | 1 | 50–80 ms |
| `.op` | 1 MOSFET-L1 + 1 R + 1 V | 1 | 40–60 ms |
| `.tran 10u 3m` | RC filter | 300 | 100–150 ms |
| `.tran 10u 30m` | RLC ringing | 3000 | 450 ms |
| `.tran 0.1m 40m` | Bridge rectifier (4 diodes) | 400 | 280 ms |
| `.tran 0.5u 2m` | Relaxation oscillator | 4000 | 600 ms |
| `.ac dec 20 10 1Meg` | RC low-pass | 100 | 8–12 ms |
| `.ac dec 30 10 1Meg` | LC bandpass | 150 | 10–15 ms |

## Hand-rolled MNA benchmarks

For the trivially small circuits we target (< 20 nodes):

| Operation | Time |
|---|---|
| `solveDC()` — 4 linear components | < 0.5 ms |
| `solveDC()` — 4 diodes + 3 R (Newton, 6 iterations) | ~3 ms |
| `solveTransient` — RC, 600 steps | ~20 ms |
| `solveTransient` — 4-diode bridge rectifier, 400 steps | *not implemented (no inductor, and BJT/diode-heavy circuits not profiled)* |

At larger circuit sizes (50+ nodes), the dense Gaussian elimination becomes quadratic and eventually uncompetitive with ngspice's sparse solver. For Velxio's expected circuit sizes (≤ 30 nodes in typical hobby circuits), hand-rolled is competitive with ngspice on DC but loses on transient.

## Memory footprint

| Pipeline | On-disk (npm install) | Runtime heap |
|---|---|---|
| Hand-rolled MNA | ~0 (no extra deps) | trivial |
| `avr8js` shared harness | ~1.5 MB | a few MB for CPU + SRAM + listeners |
| `eecircuit-engine` | **39 MB** | ~15–20 MB when booted (WASM linear memory) |

**Velxio production impact**: adding ngspice-WASM grows the browser bundle by 39 MB (the WASM is bundled inside the JS module). Unacceptable as a hard dependency for every page load; tolerable behind a lazy-loaded "⚡ Electrical simulation" feature flag. The user clicks to activate; the browser fetches, caches, and initializes; ~400 ms later they can simulate.

## Scalability projections

Rough extrapolation of ngspice to larger circuits (based on ngspice's sparse solver being `O(n^1.2)` ish for well-conditioned circuits):

| # nodes | Expected `.op` time | Expected `.tran` (1000 steps) |
|---|---|---|
| 10 | 5 ms | 100 ms |
| 30 | 15 ms | 300 ms |
| 100 | 60 ms | 1.5 s |
| 300 | 300 ms | 8 s |

In Velxio, the expected typical circuit has 10–30 components. Each component contributes 1–3 nodes (most are 2-terminal). So 20–90 nodes. We are firmly in the sub-second-per-simulation zone.

For the Velxio UI to feel responsive, one `solveDC()` should complete in < 100 ms. That is the budget for a real-time "update voltages overlay" flow.

## Co-simulation overhead

`AVRSpiceBridge.run(10, buildNetlist)` runs 10 slices. Per slice:

| Phase | Time |
|---|---|
| `avr.runCycles(16000)` (1 ms of AVR) | ~3 ms in JS |
| Build netlist string | < 1 ms |
| `runNetlist()` (ngspice `.tran 10u 1m`) | 40–100 ms |
| Inject ADC voltage | < 1 ms |
| Per-slice total | 45–105 ms |

For 1 simulated second of real AVR time: 1000 slices × ~70 ms = **~70 seconds wall-clock**. That's a 70× slowdown. Acceptable for test scenarios; **too slow for live interactive use** in Velxio.

### Mitigations for live use in Velxio

1. **Larger slices**: 10 ms instead of 1 ms → 7× fewer ngspice calls. OK if the analog network's time constants are > 10 ms.
2. **Don't solve the analog circuit unless pins changed**: debounce `onPinChange` 50 ms; only `runNetlist` when the user moves a knob or the AVR toggles a pin.
3. **DC-only mode by default**: `.op` is ~10× faster than `.tran`. Only escalate to `.tran` when the user asks for a waveform view.
4. **Cache netlists**: if the component graph hasn't changed, reuse the previous netlist and only change the source values. Avoids string manipulation overhead.
5. **Web Worker**: move ngspice to a worker so the main thread stays responsive while simulations run.

With all mitigations, target: **< 100 ms of added simulation latency** per UI interaction.

## Solver comparison on the same problem

Voltage divider, V=9 V, R1=1k, R2=2k, R3=3k (parallel with R2):

| Solver | Wall-clock | Notes |
|---|---|---|
| Hand-rolled MNA | 0.4 ms | dense matrix |
| ngspice (first call) | 410 ms | includes 400 ms boot |
| ngspice (warm) | 8 ms | singleton reused |

RC charging, 1 ms of transient at 10 µs step (100 points):

| Solver | Wall-clock | Notes |
|---|---|---|
| Hand-rolled MNA | 3 ms | backward Euler |
| ngspice | 20 ms | trapezoidal default |

LED @ 220 Ω, 5 V (non-linear, 5 Newton iters):

| Solver | Wall-clock | Notes |
|---|---|---|
| Hand-rolled MNA | 2 ms | pnjlim + damping |
| ngspice | 35 ms | model setup + solve |

## What's fast and what's slow (rule of thumb)

**Fast** (≤ 10 ms):
- Hand-rolled `.op` on < 20 linear components
- ngspice `.op` on linear circuit
- ngspice `.ac` on linear circuit

**Medium** (10–100 ms):
- ngspice `.op` on 1–3 non-linear devices
- ngspice `.tran` on < 500 time points, passive only

**Slow** (100 ms – 1 s):
- ngspice `.tran` with non-linear devices and > 1000 time points
- ngspice oscillator simulations (need many cycles)

**Always slow** (> 1 s):
- `avr8js.runCycles(N)` where N > 10 million — this is the MCU side, not the analog side

## Optimizing a netlist

1. **Widen timesteps**. `.tran 1m 100m` with no fast edges will be fast. Add fast rise/fall times → slow.
2. **Avoid false non-linearity**. A comparator modeled with a B-source using `u()` is fast. A comparator modeled with a real op-amp macro is slow.
3. **Prefer `.op` over `.tran`** whenever the analysis doesn't need time-domain information.
4. **Remove unused components**. An unused LED model with temperature params slows down every iteration.
5. **Set `.options abstol=1n reltol=1m`** if you don't need 10-ppm accuracy — default tolerances are tight.
