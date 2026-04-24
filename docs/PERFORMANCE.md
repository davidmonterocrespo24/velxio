# Performance benchmarks

Velxio's simulator hot path is the AVR8 instruction loop and the SPICE
netlist build/solve. This doc covers how we keep both honest with a
benchmark suite and a CI gate.

## TL;DR

```bash
cd frontend
npm run bench           # ~60s, runs 3 rounds, writes bench/results/last-run.json
npm run bench:check     # runs bench then compares to bench/baseline.json
npm run bench:save      # promote last-run.json → baseline.json (commit it)
```

CI runs `bench:check` on PRs that touch the simulator. A regression
beyond the per-prefix tolerance fails the PR.

## What we measure

| Bench id | What it covers | Why it exists |
| --- | --- | --- |
| `BENCH-AVR-01` | Blink loop, no port listeners | Pure CPU dispatch of a real sketch |
| `BENCH-AVR-02` | PORTB toggle, no listeners | Same, plus PORT register writes |
| `BENCH-AVR-03` | NOP loop | Floor — measures dispatch overhead alone |
| `BENCH-AVR-04` | PORTB toggle + 1 listener | Cost of ONE pin observer (fans into PinManager later) |
| `BENCH-AVR-05` | PORTB toggle + 3 listeners | Cost of full GPIO observation matrix |
| `BENCH-SPICE-01` | NetlistBuilder, 2-resistor divider | Smallest non-trivial circuit; measures per-component overhead |
| `BENCH-SPICE-02` | NetlistBuilder, 30-resistor 6×5 mesh | Stresses Union-Find merge + canonicalization |
| `BENCH-SPICE-03` | ngspice `.op` divider | Tracks upstream eecircuit-engine perf — not our code |
| `BENCH-PART-01` | Legacy `pinManager.onPinChange` direct subscribe | Floor for the adapter-overhead comparison — how built-in parts worked before CORE-002c |
| `BENCH-PART-02` | SDK `handle.onPinChange` through `registerSdkPart()` adapter | Ceiling for the adapter-overhead comparison — how every built-in now works after the CORE-002c mass migration; the BENCH-PART-01 vs -02 delta is the pure cost of the closure layer + boolean→number coercion the SDK shape adds per pin-change dispatch |

Each bench runs `tinybench` for ~2 s with 10+ samples, and the runner
repeats the matrix 3 times keeping the **best (highest) hz** per task.
Best-of-N is standard for noisy hosts (Windows dev box, shared CI
runners) — single-run jitter is 3–5%, best-of-3 jitter is < 1.5%.

For AVR benches, the runner also reports `equivalentMhz`:

```
equivalentMhz = (cycles_per_iteration × ops_per_second) / 1e6
```

A good Velxio dev machine sees ~30–40 equivalent MHz of AVR throughput.
The real Arduino runs at 16 MHz, so Velxio simulates ~2× real-time even
in the noisy `with-3-listeners` case.

## Tolerances

`bench/compare.mjs` enforces these regression budgets:

| Prefix | Tolerance |
| --- | --- |
| `BENCH-AVR-*` | 2.0% |
| `BENCH-RP2-*` | 2.0% |
| `BENCH-EVENT-*` | 2.0% |
| `BENCH-PIN-*` | 2.0% |
| `BENCH-PART-*` | 2.0% |
| `BENCH-SPICE-*` | 5.0% |
| (default) | 5.0% |

These are **CI noise budgets**, not the SDK overhead budgets from
Velxio Pro principle #0 ("AVR8 < 1%, SPICE < 2% degradation per
plugin"). The 1% / 2% targets need a more careful methodology
(consistent host, fixed CPU governor, multi-trial Welch t-test) — that
methodology comes with `CORE-001` (the SDK extraction task) which
introduces SDK-specific micro-benches.

The CI gate exists for one reason: catch regressions a human reviewer
would miss. A 5% drop on a CPU loop that handles every running sketch
is enormous. A 1% drop is invisible in noise from a 30-second run.

## Adding a benchmark

1. Add a fixture or driver function to `frontend/bench/<area>.bench.ts`.
2. Call `bench.add('BENCH-<AREA>-<NN> short label', () => { ... })` from
   the area's `register…Benches(bench)` function.
3. Wire it into the runner if it's a new area:

   ```ts
   // bench/run.ts
   import { registerMyAreaBenches } from './myarea.bench';
   // inside makeBench():
   registerMyAreaBenches(b);
   ```
4. Run `npm run bench` once locally to verify it executes.
5. Run `npm run bench:save` to add it to the baseline.
6. Commit `bench/baseline.json` along with the new bench file.

## Tracking improvements

Bench naming uses a stable id prefix (`BENCH-AVR-04`) so that renaming
the description ("toggle PORTB with 1 listener") doesn't break the
baseline lookup. Don't change the id of an existing bench — add a new
one if the workload meaningfully changes.

When you intentionally improve the hot path, run `npm run bench:save`
to lock in the new floor. Reviewers can see the delta in
`bench/baseline.json` and approve the new contract.

## SDK adapter overhead — the BENCH-PART-* gate

CORE-002c moved 30 built-in parts from the legacy `simulator.pinManager.onPinChange(arduinoPin, cb)` path onto the SDK's `handle.onPinChange(pinName, cb)` shape. The adapter resolves the pin name once at subscribe time, then wraps the user callback with a `(pin, boolean) => cb(state ? 1 : 0)` coercion closure before installing it in the PinManager.

The whole point of principle #0 ("SDK must not regress AVR by >1%") is that this closure layer is supposed to be invisible at the scale of a running sketch. **`BENCH-PART-01` vs `BENCH-PART-02` is how we prove it.** Both drive `pinManager.triggerPinChange(pin, state)` directly — the point is to isolate the adapter cost, not re-measure AVR CPU dispatch, which `BENCH-AVR-04` / `-05` already cover.

At the time the gate landed, the measured delta was **1.47% slower** for the SDK path, comfortably under the 2% tolerance and inside the ±4.24% relative margin of error on the legacy bench itself (i.e., the two numbers are noise-band identical on a dev host). If a future refactor pushes the SDK path past 2% slower than the direct path, CI blocks the PR — the assertion "adapter overhead is noise" stops being true and needs either a real optimization or a deliberate, reviewed re-baseline.

## Files

- `frontend/bench/run.ts` — runner, best-of-N orchestration
- `frontend/bench/avr.bench.ts` — AVR CPU benches
- `frontend/bench/spice.bench.ts` — NetlistBuilder + ngspice benches
- `frontend/bench/eventbus.bench.ts` — EventBus emit/hasListeners + PinManager dispatch benches
- `frontend/bench/parts.bench.ts` — legacy vs SDK-adapter pin-change dispatch (CORE-002c gate)
- `frontend/bench/fixtures/hex.ts` — pre-compiled HEX programs for AVR
- `frontend/bench/compare.mjs` — diff vs baseline, exit non-zero on regression
- `frontend/bench/save-baseline.mjs` — promote last-run.json to baseline
- `frontend/bench/baseline.json` — committed performance contract
- `.github/workflows/perf.yml` — CI gate (runs bench:check on PRs)
