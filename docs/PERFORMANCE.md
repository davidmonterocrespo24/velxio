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
| `BENCH-PIN-02-N{0,1,3,10}` | Guarded `bus.emit('pin:change', …)` after wiring N RpcChannel-backed listeners | Pure emit-overhead micro-bench — pays the production code path (closure call → coalesce-key → `Map.set` → `Array.push`) with N plugin queues, **without** the simulator. N=0 vs N=10 quantifies marginal per-plugin cost. |
| `BENCH-AVR-PLUGINS-N{0,3}` | TOGGLE_HEX (~25 k pin transitions per iter) with EventBus integration mirroring `AVRSimulator.firePinChangeWithTime` + N plugin RpcChannels | Regression detector for the worker-runtime hot path. N=0 carries the bit-diff loop cost (no emits — `hasListeners` short-circuits), N=3 actually emits 75 k RPC sends per iter. Marginal cost per plugin = `((N3-N0)/3)` per emit. |
| `BENCH-FRAME-02-N{0,3}` | One frame's worth of CPU (267_000 cycles ≈ 16 MHz / 60 fps) with EventBus + N plugins | Absolute frame-budget gate (principle #0). Reports `derived.msPerFrame` + `derived.budgetMs = 16.667`. Compared independently of baseline — **any** ms/frame above the budget fails CI even within the 2 % relative tolerance. |

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
| `BENCH-AVR-PLUGINS-*` | 2.0% |
| `BENCH-RP2-*` | 2.0% |
| `BENCH-EVENT-*` | 2.0% |
| `BENCH-PIN-*` | 2.0% |
| `BENCH-PART-*` | 2.0% |
| `BENCH-FRAME-*` | 2.0% |
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

## Plugin runtime overhead — the BENCH-PIN-02 / AVR-PLUGINS / FRAME-02 gates

CORE-006b-step3 added three bench classes that together prove principle #0 ("SDK/plugins cannot regress AVR8 by >1% or SPICE by >2% from any one plugin change") for the worker runtime. They split the cost the simulator pays under N plugin subscribers across three independent layers — each catches a different regression class.

| Class | What it catches | Gate kind |
| --- | --- | --- |
| `BENCH-PIN-02-N{0,1,3,10}` | A regression in `RpcChannel.emitEvent` — coalesce-key build, `Map.set`, `Array.push`, queue size accounting. Fires with no AVR loop, so the cost isn't amortized across 100k cycles. | Relative — 2 % vs baseline per N. |
| `BENCH-AVR-PLUGINS-N{0,3}` | A regression in the port-listener path (the bit-diff loop in `AVRSimulator.firePinChangeWithTime` plus the EventBus emit). N=3 vs N=0 quantifies marginal per-plugin cost on the worst-case workload. | Relative — 2 % vs baseline per N. |
| `BENCH-FRAME-02-N{0,3}` | A regression in the **frame loop as a whole** that breaks the 16.6 ms / 60 fps ceiling. | **Absolute** — `compare.mjs` walks `derived.msPerFrame` and fails if `msPerFrame > budgetMs`, independent of baseline drift. |

### Why the absolute frame gate matters

The relative tolerance (2 %) catches drift around the current operating point. But a future change could legitimately shift the baseline a few percent in either direction (improved scheduling, slower hardware) and still be within tolerance — yet break the 16.6 ms ceiling that "60 fps simulation with 3 plugins active" demands. The absolute gate fires on that scenario without waiting for someone to notice the wall-clock cost on a real Arduino sketch.

The `derived` blob is emitted by the runner (`bench/run.ts`):

```ts
if (name.startsWith('BENCH-FRAME-')) {
  derived.msPerFrame = PLUGIN_HOST_BENCH_METADATA.hzToMsPerFrame(s.hz);
  derived.budgetMs = PLUGIN_HOST_BENCH_METADATA.FRAME_BUDGET_MS;
}
```

`compare.mjs` indexes derived blobs by name (`indexDerived(json)`) and walks them after the relative table:

```js
for (const [name, derived] of lastDerived) {
  if (typeof derived.msPerFrame === 'number' && typeof derived.budgetMs === 'number') {
    if (derived.msPerFrame > derived.budgetMs) {
      budgetViolations.push({ name, msPerFrame: derived.msPerFrame, budgetMs: derived.budgetMs });
    }
  }
}
```

A violation prints under `ABSOLUTE BUDGET VIOLATIONS:` and contributes to the non-zero exit alongside relative regressions.

### Worst-case framing — TOGGLE_HEX is the ceiling, not the typical case

`BENCH-AVR-PLUGINS-*` and `BENCH-FRAME-*` both run TOGGLE_HEX, a tight 4-instruction `IN/EOR/OUT/RJMP` loop that flips PORTB pin 5 every ~4 cycles. That's ~25 000 pin transitions per 100 000-cycle iteration — with 3 plugins, ~75 000 RPC sends per iteration.

Real Arduino sketches (BLINK_HEX-style) toggle a pin a handful of times per second. Six orders of magnitude rarer. So the per-iteration delta we measure here is the **ceiling** on plugin overhead; in production sketches the cost amortizes to essentially zero.

This is intentional. The principle #0 budget is the hard ceiling, but holding the gate to "1 % on TOGGLE" would be impossible — the plugin queue could never meet that target at peak. Instead:

- `BENCH-FRAME-02-N3 ≤ 16.6 ms/frame` is the absolute budget. Even under TOGGLE pressure it must pass — and currently does, with ~7 ms of headroom on a modern x64.
- `BENCH-AVR-PLUGINS-N0` vs `N3` runs at ~7 % delta on TOGGLE today. The CI gate is "no >2 % regression vs the committed baseline", catching a future implementation regression that adds 4–5 % to `RpcChannel.send` without holding anyone to a literal "1 % on TOGGLE" target.

### Why CI smoke-tests but doesn't gate

`frontend-tests.yml` runs the bench harness with `BENCH_ROUNDS=1` (one round, no compare):

```yaml
- name: Smoke-run benchmarks
  run: cd frontend && BENCH_ROUNDS=1 npx vite-node bench/run.ts
```

It catches breakage in the bench code itself — a missing import, a thrown setup error, a fixture compile failure — before it lands on master and blocks the next dev-side `bench:check`. It uploads `bench/results/last-run.json` as an artifact (14-day retention) for inspection.

It does NOT gate on regression deltas because CI runners differ from dev hardware. The committed `baseline.json` is captured on the maintainer's box and would false-fire ~30 % on slower/noisier shared CI. Real perf gating happens locally before PR review (`npm run bench:check`).

### Slow-callback variant — intentionally omitted

The parent task (CORE-006b §3) asked for a "1 plugin sleeps 50 ms" variant to verify the fire-and-forget contract. That requires a real `Worker` (or an async dispatch boundary) because the host's listener is fire-and-forget — `rpc.emitEvent()` never awaits, the queue accepts the message and the worker would process it later. Vite-node can't spawn a real Worker for a bench. The fire-and-forget contract is verified by integration tests in `plugin-runtime-host.test.ts` (queue overflow → drops counter increments without blocking the emitter), so it's covered by tests, not by a bench.

## Files

- `frontend/bench/run.ts` — runner, best-of-N orchestration, derived-metric hookup for AVR-PLUGINS/FRAME
- `frontend/bench/avr.bench.ts` — AVR CPU benches
- `frontend/bench/spice.bench.ts` — NetlistBuilder + ngspice benches
- `frontend/bench/eventbus.bench.ts` — EventBus emit/hasListeners + PinManager dispatch benches
- `frontend/bench/parts.bench.ts` — legacy vs SDK-adapter pin-change dispatch (CORE-002c gate)
- `frontend/bench/plugin-host.bench.ts` — plugin-runtime hot-path benches (PIN-02 + AVR-PLUGINS + FRAME-02), CORE-006b-step3
- `frontend/bench/fixtures/hex.ts` — pre-compiled HEX programs for AVR
- `frontend/bench/fixtures/plugin-host-stub.ts` — noop `RpcEndpoint` + `installMockPluginListeners` (real `RpcChannel` against a stub transport)
- `frontend/bench/compare.mjs` — diff vs baseline + absolute frame-budget gate, exit non-zero on either kind of failure
- `frontend/bench/save-baseline.mjs` — promote last-run.json to baseline
- `frontend/bench/baseline.json` — committed performance contract
- `.github/workflows/perf.yml` — CI gate (runs bench:check on PRs)
- `.github/workflows/frontend-tests.yml` — CI smoke (single round, no gating, artifact upload)
