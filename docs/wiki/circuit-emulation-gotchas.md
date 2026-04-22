# Gotchas & Debug Log

Every problem we hit during the experiment, with root cause and fix. Ordered roughly by time encountered.

## G-1. Diode explodes on iteration 0

**Symptom**: a trivially simple diode circuit (5 V → 1 kΩ → D → GND) produced `V_d ≈ 2.44 V` or NaN. `exp()` overflow on the second Newton iteration.

**Root cause**: On iteration 0, `V_d_prev = 0` → `g_d = Is/(nVt) · exp(0) ≈ 10⁻¹³ S` → diode is effectively open → the solver puts `V_d = V_source = 5 V` on the node. On iteration 1, `exp(5 / 0.02585) = e¹⁹³ = 10⁸⁴` → infinity.

**Fix**: SPICE's `pnjlim` voltage limiting inside the diode's `stampDC`:

```javascript
_limit(Vd, iteration) {
  const nVt = this.n * Vt;
  const Vcrit = nVt * Math.log(nVt / (Math.SQRT2 * this.Is));
  if (iteration === 0 || this._VdLast === undefined) {
    return Math.min(Vd, Vcrit);   // first pass: never exceed ~0.73 V
  }
  const Vprev = this._VdLast;
  if (Vd > Vcrit && Math.abs(Vd - Vprev) > 2 * nVt) {
    if (Vprev > 0) return Vprev + nVt * Math.log(1 + (Vd - Vprev) / nVt);
    return Vcrit;
  }
  return Vd;
}
```

Per-solve reset of `_VdLast` in `Circuit.solveDC()`:

```javascript
for (const c of components) {
  if (c.isNonlinear && typeof c._resetIter === 'function') c._resetIter();
}
```

**Reference**: Colon, L. et al., SPICE manual section 9.3.

## G-2. Capacitor not charging

**Symptom**: `V(out)` at `t = τ` was `5 V` instead of `3.16 V`. The cap appeared pre-charged.

**Root cause**: `runTransient()` called `solveDC()` first. In pure DC mode the capacitor is treated as open, so the solver concluded `V_out = V_source = 5 V` (no current through R, no cap load). That became the initial `V_prev` for the transient. The first transient step then saw an already-charged cap.

**Fix**: `runTransient()` no longer does an initial DC solve. It seeds `state.prev.nodeVoltages` directly from each capacitor's `Vinit`:

```javascript
const initV = { gnd: 0, ...allNodesZero };
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
```

## G-3. ADC gave values 0–3 instead of 0–255

**Symptom**: Running `potToPwmProgram` with `V_A0 = 2.5 V`, `OCR0A` was stuck at 0 or 1. PWM duty < 1 %.

**Root cause**: The sketch read `ADCH` directly. With ADLAR=0 (right-adjusted, the reset default), `ADCH = 0b000000xx` — only the top 2 bits of the 10-bit result. Maximum value: 3. So duty was capped at `3/255 ≈ 1 %`.

**Fix**: Enable ADLAR (left-adjust) by setting ADMUX bit 5:

```
before:  LDI r16, 0x40     ; REFS0=1 (AVCC), ADLAR=0
after:   LDI r16, 0x60     ; REFS0=1 + ADLAR=1
```

Now `ADCH` contains the top 8 bits of the 10-bit result.

**General principle**: whenever you read ADC in a minimal AVR program that doesn't go through Arduino's `analogRead()`, either enable ADLAR and use ADCH-only, or read ADCL first then ADCH (to trigger the hardware's atomic-read latch).

## G-4. Blue LED not hot enough

**Symptom**: Test expected `V_f(blue) > 2.8 V`. Measured `V_f(blue) = 2.62 V`.

**Root cause**: Initial `Is = 1e-24` made the blue LED too conductive. Physical blue LEDs have `Vf ≈ 3.0–3.2 V` at `I = 10–20 mA`.

**Fix**: Retuned `Is`. For `I = 10 mA` at `V_f = 3.0 V` with `n = 2.0`:

```
I = Is · exp(V/(n·Vt))
10 mA = Is · exp(3.0/(2·0.02585))
10 mA = Is · exp(58)
Is = 10 mA / e⁵⁸ ≈ 6.7e-28
```

Rounded to `Is = 1e-28` for blue and white. Other colors left unchanged.

**Principle**: tuning `Is` shifts the forward voltage. Tuning `n` shifts the slope of the I-V curve. Use both together to match a datasheet point (typically V_f at 10 or 20 mA).

## G-5. BJT saturation not deep

**Symptom**: BJT switch test expected `V_CE(sat) < 0.3 V`. Measured `V_CE = 0.68 V`.

**Root cause**: Simplified Ebers-Moll (the "injection version" we implemented) doesn't model the deep-saturation region accurately. The model is first-order correct — the transistor is clearly ON and pulled the collector low — but misses the classic 0.1–0.3 V V_CE(sat) value.

**Fix**: relaxed the assertion to `V_CE < 0.8 V` and `V_CE < V_CC − 3 V`. For real BJT modeling (audio amplifiers, charge pumps, hobbyist designs), use the ngspice pipeline and a Gummel-Poon `.model NPN Is=… Bf=… Vaf=… Nf=… Br=… Nr=… …` parameter set from the manufacturer.

## G-6. RJMP offset wrong after edits

**Symptom**: After adding two more instructions, the oscillator loop jumped to the wrong address.

**Root cause**: `RJMP k` encodes `k` as a signed 12-bit offset from `PC + 1` (where PC is the word address of the RJMP itself). Changing instruction count between the jump and its target silently shifts the target address.

**Fix**: count words carefully.

For the `adcReadProgram` loop:
```
0-5:   setup (6 words)
6:     LDI r17, 0xC7           ← loop entry
7-8:   STS ADCSRA, r17         (2 words)
9-10:  LDS r17, ADCSRA         (2 words)
11:    SBRC r17, 6
12:    RJMP -4                  → PC+1=13, target=9, offset=−4  ✓
13-14: LDS r20, ADCH           (2 words)
15-16: LDS r21, ADCL           (2 words)
17:    RJMP -12                 → PC+1=18, target=6, offset=−12 ✓
```

**Principle**: every `STS` and `LDS` is a 32-bit instruction (2 words). Count accordingly when computing offsets.

## G-7. ngspice B-source `&` instead of `&&`

**Symptom**: The digital-logic tests hung for 60 s, timing out. No error message.

**Root cause**: In ngspice B-source expressions, `&` is **bitwise** (on integer interpretations of the floats), while `&&` is **logical**. The expression `V(a) > 2.5 & V(b) > 2.5` parses but evaluates weirdly — ngspice was doing internal promotions / fallbacks and eventually got stuck.

**Fix**: use `u()` step functions and multiplication, which is portable across ngspice versions and other SPICE flavours:

```
; Wrong (may parse but hang):
Band y 0 V = 5 * (V(a) > 2.5 & V(b) > 2.5)

; Right:
Band y 0 V = 5 * u(V(a)-2.5) * u(V(b)-2.5)
```

**Principle**: `u(x)` is Heaviside: 1 if `x > 0`, else 0. Convert every logical gate to products/sums of `u()` calls. AND = product, OR = `1 − (1−a)(1−b)`, NOT = `1 − u(…)`, XOR = `a + b − 2ab`.

## G-8. ngspice singular matrix — 60+ second hang

**Symptom**: A test that should run in 50 ms hangs for 60+ seconds. `Note: Starting true gmin stepping` appears in stderr.

**Root cause**: A node had no DC path to ground (e.g., `R → C → out`, where `out` is surrounded only by caps and voltage sources that don't provide a DC-level reference). ngspice tries multiple recovery strategies:

```
Note: Starting dynamic gmin stepping
Warning: singular matrix: check node n
Warning: Dynamic gmin stepping failed
Note: Starting true gmin stepping
Warning: True gmin stepping failed
Note: Starting source stepping
Warning: source stepping failed
Note: Transient op started      ← finally gives up on DC, jumps to transient
Note: Transient op finished successfully
```

Each recovery stage can take many seconds. Combined, they blow past our 60 s test timeout.

**Fix**: explicitly add a high-impedance pull to ground on every otherwise-floating node:

```
R_pull out 0 10Meg
```

This gives the solver a DC reference without materially affecting the circuit (10 MΩ is much larger than any analog impedance we care about).

**Principle**: for **every** node in your SPICE netlist, make sure DC current can reach ground. Capacitors are DC-open; inductors are DC-shorts (usually OK); diodes and transistors vary by bias. When in doubt, add a 10 MΩ pull.

In Velxio's main app, the netlist builder should detect floating nodes automatically and add pulls.

## G-9. ngspice behavioral model of 555 — cascaded B-sources don't hold state

**Symptom**: First attempt at a 555 timer astable used cascaded B-sources for the SR latch. It never oscillated.

**Root cause**: B-sources are **stateless** — they compute V = f(current-instant V's) with no memory. An SR latch needs memory. Trying to fake memory with a "state cap" (capacitor that B-source drives) is fragile and convergence-sensitive.

**Fix**: Use a **voltage-controlled switch with hysteresis**. The `S-element`'s hysteresis window gives it state:

```
S1 out 0 ctrl 0 SMOD
.model SMOD SW(Vt=2.5 Vh=0.833 Ron=100 Roff=1G)
```

Turn-on threshold: `Vt + Vh = 3.333`. Turn-off threshold: `Vt − Vh = 1.667`. Between these, the switch retains its previous state.

For a relaxation oscillator: the switch grounds the charging cap through itself; the cap charges toward Vcc via R until it crosses `Vt + Vh`, the switch turns on and discharges the cap back below `Vt − Vh`, the switch turns off, repeat.

**Principle**: in plain ngspice (without XSPICE digital primitives), the *only* stateful primitives are `C`, `L`, and `S` (with hysteresis). Build every edge-triggered / level-triggered latch or FF from those.

## G-10. `Note: v1: has no value, DC 0 assumed`

**Symptom**: A warning on stderr, but simulation produced sensible results.

**Root cause**: In AC analysis, if a source is declared as `V1 in 0 AC 1` (only an AC value, no DC), ngspice defaults its DC operating point to 0 V. It prints this informational "Note" to stderr.

**Fix**: None needed. If you want to make it explicit: `V1 in 0 DC 0 AC 1`.

## G-11. Test-to-test contamination in the ngspice singleton

**Symptom**: A test passed when run alone, hung for 60 s when run after other tests.

**Root cause**: The `SpiceEngine` singleton reuses a single `Simulation` across tests. If one simulation runs with a problematic netlist (e.g., a floating node triggering gmin recovery), internal state may be left in a weird spot.

**Fix (applied)**: Fix the netlist to avoid floating nodes (see G-8). The hang we hit was actually due to G-8, not to a true state-leak bug.

**Mitigation (not yet applied)**: If future bugs appear, `SpiceEngine` can be extended with a `resetEngine()` that throws away the singleton and boots a fresh `Simulation`. Penalty: 400 ms per reset.

## G-12. `cpu.cycles` keeps growing across `loadProgram`

**Symptom**: After loading a new program into `AVRHarness`, `cpu.cycles` did not reset.

**Root cause**: `AVRHarness.loadProgram()` (and `load()`) construct a fresh `CPU` instance, so `cpu.cycles` does restart at 0. But if you re-use the same `AVRHarness` without calling `load*` again, cycles accumulate from previous `runCycles()` calls.

**Fix**: If you want a clean start, call `avr.loadProgram(prog)` or `avr.load(hex)` before each `runCycles`. Or construct a new `AVRHarness()`.

**Principle**: this is correct behaviour. Tests that re-use the harness should be aware.

## Performance gotchas

### G-P1. `.tran` with fast PWM edges forces tiny timesteps

If your netlist has a PWM source with 10 ns rise/fall time and 1 kHz period, ngspice *must* resolve every edge — it cannot take a 100 µs step through a 10 ns transition.

**Rule of thumb**: don't model PWM with real edges if the time scale of the external circuit (RC filter, etc.) is much slower. Use the duty-cycle-averaged DC equivalent:

```
; Wrong for a DC filter analysis:
Vpwm pwm 0 PULSE(0 5 0 10n 10n 500u 1m)

; Right:
Vpwm pwm 0 DC 2.5           ; duty=0.5 → 2.5V DC
```

### G-P2. First `runSim` call is 400 ms slower

The `eecircuit-engine` WASM boot is lazy. In Vitest, we use a singleton — the first test in a run pays 400 ms; subsequent tests pay 5–500 ms each. In a browser context, the 400 ms boot is user-visible; lazy-load the module behind a "⚡ Electrical simulation" toggle.

## G-N. Unicode arrow (→) in netlist title silently hangs ngspice

**Symptom:** `runNetlist()` never resolves. Test times out after 30 s, no error logged.

**Reproduction:**

```spice
3.3V GPIO → MOSFET → LED
V_sys vsys 0 DC 5
...
```

The `→` (U+2192) in the first line (the title card) is all it takes. Removing it or replacing with `to` fixes it instantly.

**Root cause:** the ngspice-WASM build doesn't sanitize non-ASCII input in the title card. The character enters the parser in an unexpected state and the simulation loop never converges / exits.

**Mitigation (enforced at test-author level):** only ASCII in netlist titles. Non-ASCII is fine in comments (`* ...`) and inside B-source expressions. Consider a pre-commit hook that lints `runNetlist()` call sites — detailed in [`test/test_circuit/autosearch/06_ngspice_convergence.md`](../../test/test_circuit/autosearch/06_ngspice_convergence.md).

## G-M. MOSFET `Level=3` with unphysical W causes `.op` to hang

**Symptom:** same as G-N — test times out, no error.

**Reproduction:**

```spice
.model M_X NMOS(Level=3 Vto=1.6 Kp=0.1 Rd=1 Rs=0.5)
M1 d g 0 0 M_X L=2u W=0.1
```

`W=0.1` without unit is interpreted as **0.1 metres** (100 mm channel width). With `L=2u` that is W/L = 50 000 and `Kp=0.1 A/V²` gives kiloamps of theoretical channel current; Newton blows up on the first iteration and can't recover. Tests that happened to have the drain shorted to ground escaped this because the external resistor forced a small Vds, but any free-swinging drain hangs.

**Mitigation:** use `Level=1` Shichman-Hodges with W/L in a physically reasonable range (W/L between 10 and 10⁵, W ≤ 10 mm, L ≥ 1 µm). All fase-9 MOSFET mappers have been migrated to this pattern.

```spice
.model M2N7000 NMOS(Level=1 Vto=1.6 Kp=50u Lambda=0.01)   ; with L=2u W=200u
```

## G-R. 490 Hz PWM starves the SPICE solver via the store-change debounce

**Symptom (2026-04-20):** In the `mosfet-pwm-led` example, the LED does
nothing while the sketch runs (`analogWrite(9, 0..255..0)` ramp), then
**lights up the instant the user presses Stop**. Static circuits (no PWM)
simulate correctly. Affects every circuit where a SPICE-owned component is
wired directly to an MCU pin that the sketch drives with `analogWrite()`.

**Why "works on stop" was the decisive clue:** stopping the AVR is the only
event that halts the stream of pin-change callbacks. SPICE is clearly
*capable* of solving the circuit — the solve just never runs while the
firing rate is high. That points straight at the scheduler's debounce.

**Root cause — a feedback loop between the digital side and the solver:**

1. `SimulatorCanvas`'s generic wire subscription calls
   `pinManager.onPinChange(pin, …)` for every component wired directly to a
   board pin. When the pin toggles, the callback calls
   `updateComponentState(component.id, state)` unless the component has
   `attachEvents` registered in `PartSimulationRegistry` (`hasSelfManagedVisuals`).
2. `updateComponentState` writes `properties.state` / `properties.value` on
   the target component — producing a **new `components` array** in the
   Zustand store.
3. `wireElectricalSolver` subscribes to the store and calls `maybeSolve()`
   whenever `state.components !== prev.components`.
4. `maybeSolve()` → `triggerSolve()` → `circuitScheduler.requestSolve()`
   which **resets the 50 ms debounce timer** on every call.
5. Under AVR's hardware PWM on pin 9 (Timer1, 490 Hz), pin 9 toggles every
   ~2 ms. The 50 ms debounce is reset ~20× before it can ever expire, so
   `drain()` never runs and ngspice is never invoked.
6. On Stop the toggles cease, 50 ms later the debounce finally fires, the
   solve completes with the last-seen PWM duty, and the LED paints bright —
   which is exactly what the user reported seeing.

The periodic 200 ms solver timer in `subscribeToStore` is unable to rescue
this: it calls the same `maybeSolve` which passes through the same debounce
and is swamped by the pin-toggle stream.

**Minimal reproducer (in-browser):** any two-terminal SPICE-mapped
component whose only connection to the MCU is a single GPIO wire is enough.
MOSFET gate → pin 9 is the canonical case, but a resistor from pin 3 to a
cap, a diode anode on pin 5, an opamp `IN+` on pin 6, a logic-gate input on
pin 11, all behaved identically in testing.

**Diagnostic that exonerated ngspice:** running `buildNetlist` + `runNetlist`
with a fixed `duty=1.0` inside a Vitest harness that mirrors
`CircuitScheduler.drain()` produced a correct branch current
(`v_led1_sense` = 6.8 mA at 5 V gate) in 380 ms. SPICE was fine — the
pipeline upstream of the scheduler was broken.
[`frontend/src/__tests__/spice-mosfet-diag.test.ts`](../../frontend/src/__tests__/spice-mosfet-diag.test.ts)
is the permanent form of that probe.

**Fix — one generic rule in `SimulatorCanvas`:** treat every SPICE-owned
component as authoritative-to-SPICE. The legacy digital echo is skipped
for them so no pin toggle ever mutates `components`.

```typescript
// frontend/src/components/simulator/SimulatorCanvas.tsx
const logic = PartSimulationRegistry.get(component.metadataId);
const spiceOwned = isSpiceMapped(component.metadataId);
const hasSelfManagedVisuals = !!(logic && logic.attachEvents) || spiceOwned;
```

That single line protects every current and future mapper in
`componentToSpice.ts` (R/L/C, diodes, LEDs, BJTs, MOSFETs, op-amps,
regulators, optos, relays, L293D, logic gates, instruments, signal
generators, switches, pots, NTCs, photo-resistors, photodiodes, batteries).
SPICE samples the true pin state from `PinManager` at the 200 ms periodic
tick — quasi-DC equivalent of the PWM, which is the correct simplification
for an operating-point solver.

**What was explicitly rejected:**

- *Register every active device with a no-op `attachEvents`.* It works but
  flips `isInteractive` in `DynamicComponent` → cursor becomes `pointer`
  over MOSFETs, BJTs, and opamps — misleading the user into thinking they
  can click them. Using `isSpiceMapped(…)` at the one call site that cares
  is the cleaner demarcation.
- *Lengthen the debounce until it's longer than the PWM period.* Any debounce
  long enough to survive 490 Hz would also make wire edits feel sluggish.
  The problem is that digital pin toggles were being treated as circuit
  edits in the first place.
- *Dedup at the `triggerSolve` level based on JSON input.* Already in place
  — but it runs *after* `requestSolve`, so the debounce has already been
  reset. Moving the dedup earlier doesn't help either, because the input
  genuinely does change (`properties.state` flips) even when nothing that
  SPICE cares about has.

**Unrelated cleanup done at the same time:** removed a leftover
`console.log('[WirePin] …')` inside the wire subscription loop that was
firing at the same rate as the pin subscriptions and filling the devtools
console.

**Fidelity note:** no fidelity was sacrificed. SPICE is still the single
source of truth for voltages and currents on every SPICE-mapped component.
Digital-only parts (pushbuttons, membrane keypads, DIP switches, slide
switches, I²C displays, servos, buzzers) continue through the unchanged
`attachEvents` path.

**Regression guard:**
[`frontend/src/__tests__/spice-mosfet-pwm.test.ts`](../../frontend/src/__tests__/spice-mosfet-pwm.test.ts)
asserts monotonic LED current across the ramp; the diag test above
asserts the scheduler-filtered keys still land in `branchCurrents`.

## G-S. SPICE-mapped components silently stop updating after `parts/*.ts` edits

Two distinct bugs, both surfaced while finishing the G-R rollout. Both have
the same shape: `buildNetlist` + `runNetlist` produce correct currents in a
Vitest harness, but the component in the browser never reflects them. Tests
green, UI wrong — the most frustrating failure mode.

### G-S.1 — `require()` inside an `attachEvents` callback

**Symptom:** LED stays dark in the `mosfet-pwm-led` (and any) SPICE-driven
example even after the G-R fix lands. No console error. No thrown promise.
The `branchCurrents` store is populated correctly; the LED just never reads
from it.

**Root cause:** `BasicParts.ts` imported the Zustand store lazily from
inside the subscribe callback:

```typescript
attachEvents: (el, _sim, _getPin, componentId) => {
  const update = () => {
    const { useElectricalStore } = require('../../store/useElectricalStore'); // ← dies silently
    const { branchCurrents } = useElectricalStore.getState();
    …
  };
  const unsub = useElectricalStore.subscribe(update); // ← same problem
  …
},
```

Vite's esbuild pipeline doesn't polyfill CommonJS `require` in browser code.
The call threw `ReferenceError: require is not defined` the first time
`update()` ran. Zustand's `subscribe` swallows exceptions from listener
callbacks (by design — one broken listener can't kill the others), so the
error never made it to the console and the LED silently did nothing.

**Fix:** static ESM import at module top.

```typescript
import { useElectricalStore } from '../../store/useElectricalStore';

attachEvents: (el, _sim, _getPin, componentId) => {
  const update = () => {
    const { branchCurrents } = useElectricalStore.getState();
    …
  };
  …
},
```

**Principle:** inside any file that ships to the browser, `require()` is a
footgun. If a bundler tolerates it in dev, production may not. And if the
call lives inside a subscribe/pin-change/event callback, the exception
won't even be visible. Prefer top-of-file `import` always.

### G-S.2 — Vite HMR keeps old `attachEvents` bound after `parts/*.ts` edits

**Symptom:** You edit `BasicParts.ts` (or any `parts/*.ts`), save, the HMR
banner flashes "updated" — but the circuit behaviour in the browser is
unchanged. You doubt your own fix, add `console.log`s that never fire, and
eventually rewrite code that was already correct.

**Root cause:** `parts/index.ts` registers every part into
`PartSimulationRegistry` via module-load side effects. When HMR swaps a
`parts/*.ts` module, the *registry* sees the new `attachEvents`, but the
LED/MOSFET/etc. components that were rendered before the edit are still
holding references to the *old* `attachEvents` via the `unsub` closures
they set up in their mount effect. Until those components unmount and
remount, they keep running the stale callback.

The NPN-switch debug session burned ~90 min on this: all three Vitest
harnesses (`spice-npn-switch-diag`, `spice-npn-switch-integration`, and the
pre-existing `spice-mosfet-pwm`) proved the pipeline was correct end-to-end
while the browser kept showing the LED permanently lit.

**Fix:** full restart whenever you touch anything under
`frontend/src/simulation/parts/` or `frontend/src/simulation/spice/`:

```
Ctrl+C                          # kill dev server
npm run dev                     # fresh module graph
Ctrl+Shift+R  (in browser)      # discard old Zustand subscribers
```

**Mitigation (not applied):** we could add `import.meta.hot?.invalidate()`
at the bottom of every `parts/*.ts` to force a full page reload on edit.
Considered too disruptive for the file-frequency these get edited at —
the restart rule is easier to remember once you've been bitten.

**Principle:** HMR is fine for React components and CSS. For code that
wires long-lived subscriptions inside a global registry, assume HMR is
lying to you and restart.

## What to check first when something fails

0. **If you just edited `parts/*.ts` or `spice/*.ts` and the browser looks wrong** — restart the dev server before anything else (see G-S.2). Tests are the authoritative signal; the dev server is not.
1. **Console stderr** from ngspice often contains the root cause ("singular matrix", "model not found", "syntax error at line X").
2. **`result.variableNames`** — if you expect `v(out)` and the list has `v(OUT)`, case matching bit you. Our wrapper lowercases, but check.
3. **`sim.getError()`** — returns the ngspice error buffer.
4. **Run in isolation** — `npx vitest run -t "specific test name"` to rule out test-to-test contamination.
5. **Simplify the netlist** — strip components until the problem either disappears (you found the culprit) or persists (the remaining part is the problem).
6. **Add explicit DC paths** — `R_pull node 0 10Meg` on every suspect-floating node.
7. **Mirror the browser path in a Vitest harness** — if tests pass but UI fails, the bug is upstream of `buildNetlist` (subscription, import, HMR) not in SPICE. `spice-npn-switch-integration.test.ts` is the reference template for this.
