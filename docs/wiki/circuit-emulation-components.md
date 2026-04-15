# Component Catalog

Every component validated by at least one test across the two pipelines. "JS API" is the hand-rolled MNA pipeline; "SPICE card" is the ngspice netlist syntax.

## Passive

### Resistor

| | |
|---|---|
| JS API | `new Resistor(name, nodeA, nodeB, resistance)` |
| SPICE card | `Rname a b value` |
| Parameters | `value` in Ω (use `k`, `Meg`, etc.) |
| Stamp | Linear, symmetric |
| Tested in | `passive.test.js`, `spice_passive.test.js` |

### Voltage source (DC / PULSE / SIN / PWL / AC)

| | |
|---|---|
| JS API | `new VoltageSource(name, nodePlus, nodeMinus, voltage)` — DC only |
| SPICE cards | `V1 + - DC 5` / `V1 + - PULSE(0 5 0 1n 1n 1u 2u)` / `V1 + - SIN(0 1 1k)` / `V1 + - PWL(0 0 1m 5)` / `V1 + - AC 1` |
| Notes | Adds an extra MNA row. Branch current accessible via `circuit.branchCurrent('V1')`. |

### Current source

| | |
|---|---|
| JS API | `new CurrentSource(name, nodeFrom, nodeTo, current)` |
| SPICE card | `I1 from to DC 1m` |
| Convention | Current flows **from** `from` **into** `to` through the source. |

### Capacitor

| | |
|---|---|
| JS API | `new Capacitor(name, a, b, capacitance, initialV = 0)` |
| SPICE card | `C1 a b 100u IC=0` |
| Integration | Hand-rolled: backward Euler. ngspice: trapezoidal by default. |
| Notes | `.ic` or `IC=` sets initial voltage for transient. In DC, cap is open. |

### Inductor (ngspice only)

| | |
|---|---|
| JS API | *(not implemented in the hand-rolled solver)* |
| SPICE card | `L1 a b 10m IC=0` |
| Tested in | `spice_transient.test.js` (RLC ringing), `spice_ac.test.js` (LC bandpass) |

### Potentiometer (two-resistor model)

| | |
|---|---|
| JS API | `new Potentiometer(name, topNode, wiperNode, bottomNode, totalR, wiperPos)` |
| SPICE | Two resistors in series; recompute values from `wiperPos` when user moves wiper |
| `wiperPos` | 0.0 = wiper at bottom, 1.0 = wiper at top |
| Tested in | `passive.test.js` (sweep test), `e2e_pot_pwm_led.test.js`, `spice_avr_mixed.test.js` |

### NTC thermistor

| | |
|---|---|
| JS API | `new NTCThermistor(name, a, b, { R0, T0, beta })` — β-model |
| SPICE | `R` with value computed from temperature: `R(T) = R0 · exp(β · (1/T − 1/T0))` |
| Defaults | `R0 = 10 000 Ω`, `T0 = 298.15 K` (25 °C), `β = 3950` |
| Tested in | `passive.test.js`, `e2e_thermistor.test.js`, `spice_avr_mixed.test.js` |

### Switch

| | |
|---|---|
| JS API | `new Switch(name, a, b, closed)` with `set(true|false)` |
| SPICE card | `S1 a b ctrl 0 SMOD` + `.model SMOD SW(Vt=... Vh=... Ron=... Roff=...)` |
| Hysteresis | **ngspice switch retains state between `Vt−Vh` and `Vt+Vh`** — essential for latches/oscillators |

## Non-linear (diodes)

### Shockley diode

| | |
|---|---|
| JS API | `new Diode(name, anode, cathode, { Is, n, Vclamp })` |
| SPICE | `D1 a c DMOD` + `.model DMOD D(Is=1e-14 N=1)` |
| Equation | `I_d = Is · (exp(V_d / (n·Vt)) − 1)` with `Vt ≈ 0.02585 V` @ 300 K |
| Convergence | `pnjlim` voltage limiting on each Newton iter |
| Tested in | `diodes.test.js`, `spice_active.test.js` |

### LED (colored diode)

| | |
|---|---|
| JS API | `new LED(name, anode, cathode, color)` where color ∈ { `red`, `green`, `yellow`, `blue`, `white` } |
| SPICE | `D1 a c LED_RED` with `.model LED_RED D(Is=1e-20 N=1.7)` etc. |
| Brightness | `I_forward / rated_current`, clipped to [0, 1] |
| Tuned parameters | Red: `Is=1e-20, n=1.7`; Green: `1e-22, 1.9`; Yellow: `1e-21, 1.8`; Blue/White: `1e-28, 2.0` |
| Tested in | `diodes.test.js`, `avr_blink.test.js`, `e2e_pot_pwm_led.test.js` |

Brightness table at 5 V through 220 Ω:

| Color | V_f measured | I_forward | Brightness |
|---|---|---|---|
| Red | ~2.0 V | 13.6 mA | 0.68 |
| Yellow | ~2.1 V | 13.2 mA | 0.66 |
| Green | ~2.2 V | 12.7 mA | 0.64 |
| Blue | ~3.1 V | 8.6 mA | 0.43 |
| White | ~3.1 V | 8.6 mA | 0.43 |

### Zener / PN junction with breakdown (ngspice only)

| | |
|---|---|
| JS API | *(not implemented — Shockley diode only)* |
| SPICE | `.model D1N4733 D(Is=1e-9 BV=5.1 IBV=10m)` |
| Use case | Voltage regulation, overvoltage protection |

## Non-linear (three-terminal)

### NPN BJT

| | |
|---|---|
| JS API | `new BJT_NPN(name, collector, base, emitter, { Is, betaF, betaR })` — simplified Ebers-Moll |
| SPICE | `Q1 c b e Q2N2222` + `.model Q2N2222 NPN(Is=1e-14 Bf=200)` |
| Tested in | `diodes.test.js` (switch mode), `spice_active.test.js` (common-emitter amp) |
| Limitation (JS model) | Doesn't capture deep saturation; `V_CE,sat` measures ~0.7 V instead of 0.1–0.3 V |
| Recommendation | For accurate BJT work, use the ngspice pipeline with Gummel-Poon parameters |

### MOSFET (ngspice only)

| | |
|---|---|
| SPICE | `M1 d g s b NMOS_L1 L=1u W=100u` + `.model NMOS_L1 NMOS(Level=1 Vto=1.0 Kp=50u Lambda=0.01)` |
| Model level | 1 (Shichman-Hodges): `I_d = (Kp · W/L) · ((V_gs − V_th) · V_ds − V_ds²/2)` for linear region |
| Higher levels | Level 3, BSIM3/4 available in full ngspice; not all compiled into WASM build |
| Tested in | `spice_active.test.js` (switch ON/OFF) |

## Controlled sources (SPICE only)

| Card | Type | Example |
|---|---|---|
| `Ename plus minus ctrl+ ctrl− gain` | VCVS (ideal op-amp) | `Eopa out 0 inp inm 1e6` |
| `Gname plus minus ctrl+ ctrl− gm` | VCCS | `Gtc out 0 in 0 1m` |
| `Hname plus minus Vsense gain` | CCVS | Needs a 0 V source to sense current |
| `Fname plus minus Vsense gain` | CCCS | |

We use VCVS extensively for behavioral op-amp modeling. See `spice_active.test.js` (inverting amplifier) and `spice_555_astable.test.js` (Schmitt via `Bopa` limited to 0..5 V by `limit()`).

## Behavioral sources (SPICE only — **key to mixed-signal**)

The `B` card computes a voltage (or current) from an arbitrary expression:

```spice
Bname node+ node− V = expression
Bname node+ node− I = expression
```

Supported functions (non-exhaustive):

- Arithmetic: `+ − * / ^` (exponent)
- Comparisons: `<`, `<=`, `>`, `>=`, `==`, `!=`
- Logical: `&&`, `||`, `!`
- Math: `sin`, `cos`, `tan`, `atan`, `asin`, `acos`, `exp`, `log`, `log10`, `sqrt`, `abs`, `min`, `max`
- Step: `u(x)` — unit step (Heaviside). 1 if x > 0 else 0.
- Clamp: `limit(x, lo, hi)`
- Ternary: `a ? b : c`
- Time: `time` (the current simulation time)

Our truth-table-validated gates:

| Gate | Expression |
|---|---|
| NOT | `5 * (1 - u(V(a) - 2.5))` |
| AND | `5 * u(V(a)-2.5) * u(V(b)-2.5)` |
| NAND | `5 * (1 - u(V(a)-2.5) * u(V(b)-2.5))` |
| OR | `5 * (1 - (1-u(V(a)-2.5)) * (1-u(V(b)-2.5)))` |
| NOR | `5 * (1-u(V(a)-2.5)) * (1-u(V(b)-2.5))` |
| XOR | `5 * (u(V(a)-2.5) + u(V(b)-2.5) - 2*u(V(a)-2.5)*u(V(b)-2.5))` |

For flip-flops / latches, pair the above with a voltage-controlled switch (`S-element`) that has hysteresis; the switch supplies the memory.

## Sensor surrogates

| Sensor | Modeling approach |
|---|---|
| NTC temperature | `NTCThermistor` (β-model) — parameterized by host code from UI |
| Photoresistor / LDR | Resistor with `R(lux) = R_dark / (1 + k·lux)` — user/UI sets resistance |
| Pushbutton | `Switch` toggled between open/closed |
| Potentiometer | `Potentiometer` with UI-driven `wiperPos` |
| Microphone / piezo | `CurrentSource` or `VoltageSource` with PWL waveform |
| Encoder / quadrature | Two digital pins toggled by UI logic (outside the SPICE solver) |

## Integrated circuits (not yet modeled)

For the Velxio integration, these will need either ngspice `.subckt` macromodels (many available in vendor-provided SPICE libraries) or behavioral B-source blocks:

- 555 timer — vendor .subckt or our relaxation-osc behavioral model
- Shift registers (74HC595) — behavioral gate network, clocked switches
- H-bridges (L293D, DRV8833) — 4 MOSFETs or 4 switches
- Optocouplers (4N25, PC817) — BJT + LED pair in one package
- 74HC logic families (74HC00/04/08/14/32) — gate networks in 14-pin packages
- ADCs / DACs — behavioral `u()` thresholds or `limit()` scaled

## Fase 9 — catalog expansion (implemented)

The following mappers were added during fase 9 (commit fase 9.0–9.5) and are live in `frontend/src/simulation/spice/componentToSpice.ts`. The `MAPPERS` table now has 58 entries (up from 25) and `components-metadata.json` has 92 parts (up from 48). Every new component is accessible from the picker UI.

### Fase 9.1 — Logic gates (behavioral B-sources)

Every gate uses an ngspice B-source with `u()` unit-step functions and a 1 MΩ pull-down on the output (to give the node a DC path and prevent "matrix singular" errors).

| metadataId | Inputs | Output expression |
|---|---|---|
| `logic-gate-and`   | A, B           | `Vcc · u(V(A)−T) · u(V(B)−T)` |
| `logic-gate-or`    | A, B           | `Vcc · (1 − (1−u(V(A)−T))·(1−u(V(B)−T)))` |
| `logic-gate-nand`  | A, B           | `Vcc · (1 − u(V(A)−T)·u(V(B)−T))` |
| `logic-gate-nor`   | A, B           | `Vcc · (1−u(V(A)−T)) · (1−u(V(B)−T))` |
| `logic-gate-xor`   | A, B           | `Vcc · (u(V(A)−T) + u(V(B)−T) − 2·u(V(A)−T)·u(V(B)−T))` |
| `logic-gate-xnor`  | A, B           | `Vcc · (1 − XOR)` |
| `logic-gate-not`   | A              | `Vcc · (1 − u(V(A)−T))` |

Threshold `T = Vcc/2`. Multi-input variants (AND-3/4, OR-3/4, NAND-3/4, NOR-3/4) extend the product/sum to more terms.

### Fase 9.2 — Transistors (discrete real parts)

NMOS and PMOS use **Level=1** Shichman-Hodges with numerically sane W/L — the previous Level=3 with `W=0.1` (= 100 mm!) caused ngspice to hang. See [`circuit-emulation-gotchas.md`](circuit-emulation-gotchas.md#mosfet-convergence).

| metadataId | Polarity | Package | Typical use |
|---|---|---|---|
| `bjt-2n2222`  | NPN | TO-92 | General purpose switching |
| `bjt-bc547`   | NPN | TO-92 | Small-signal, hFE ~400 |
| `bjt-2n3055`  | NPN | TO-3  | Power (15 A / 60 V / 115 W) |
| `bjt-2n3906`  | PNP | TO-92 | General purpose (2N3904 complement) |
| `bjt-bc557`   | PNP | TO-92 | Small-signal (BC547 complement) |
| `mosfet-2n7000`   | NMOS | TO-92  | Logic-level (V_th ≈ 1.6 V) |
| `mosfet-irf540`   | NMOS | TO-220 | Power (33 A / 100 V, V_th ≈ 3 V) |
| `mosfet-irf9540`  | PMOS | TO-220 | Power P-channel |
| `mosfet-fqp27p06` | PMOS | TO-220 | Logic-level P-channel |

### Fase 9.3 — Operational amplifiers

All op-amps use a behavioral `B_out = max(vLo, min(vHi, A · (V+ − V−)))` with rails derived from `ctx.vcc`. High input impedance via 10 MΩ (or 1 TΩ for JFET input) resistors to ground on each input pin.

| metadataId | Type | Gain A | Low rail | High rail | Notes |
|---|---|---|---|---|---|
| `opamp-ideal` | VCVS | 10⁶ | unclamped | unclamped | Textbook circuits only |
| `opamp-lm358` | Dual | 10⁵ | 0.05 V | Vcc − 1.5 V | Single-supply, rail-to-rail output |
| `opamp-lm741` | Single | 2·10⁵ | 1.5 V | Vcc − 1.5 V | Classic, needs headroom |
| `opamp-tl072` | Dual (JFET) | 2·10⁵ | 2 V | Vcc − 2 V | Audio / instrumentation |
| `opamp-lm324` | Quad | 10⁵ | 0.05 V | Vcc − 1.5 V | 4× LM358 in one package |

### Fase 9.4 — Power-supply parts

| metadataId | Topology | Behavioral card |
|---|---|---|
| `reg-7805`  | +5 V linear, 2 V dropout | `B_out = min(V(VIN)−V(GND)−2, 5)` |
| `reg-7812`  | +12 V linear | `B_out = min(V(VIN)−V(GND)−2, 12)` |
| `reg-7905`  | −5 V linear (negative rail) | `B_out = max(V(VIN)−V(GND)+2, −5)` |
| `reg-lm317` | Adjustable, 1.25 V reference | `B_out = V(ADJ) + min(V(VIN)−V(ADJ)−2, 1.25)` (referenced to ground for load current return) |
| `battery-9v`        | 9 V with 1.5 Ω ESR | `V + int DC 9`, `R int − 1.5` |
| `battery-aa`        | 1.5 V with 0.15 Ω ESR | " 1.5 / 0.15 |
| `battery-coin-cell` | 3 V with 10 Ω ESR (CR2032) | " 3 / 10 |
| `signal-generator`  | Sine / square / DC | `SIN(off amp freq)` / `PULSE(...)` / `DC off` selected by `waveform` property |

### Fase 9.5 — Schottky, photodiode, multi-input gates

| metadataId | Model / expression |
|---|---|
| `diode-1n5817` | Schottky 20 V, `D(Is=3.3u N=1 Rs=0.025)`, Vf ≈ 0.32 V |
| `diode-1n5819` | Schottky 40 V, `D(Is=3u N=1 Rs=0.027)` |
| `photodiode`   | Regular diode + current source: `I_ph = lux · 100 nA` sinking from cathode to anode |
| `logic-gate-{and,or,nand,nor}-{3,4}` | Same behavioral pattern as 2-input gates, extended to 3 or 4 inputs |

### Fase 10 — Electromechanical + IC packaging (implemented)

#### Relay (SPDT)

| metadataId | Topology |
|---|---|
| `relay` | R + L in parallel for the coil + ngspice `S` switches for NO/NC contacts with native Vt/Vh hysteresis + B-source inverter to implement the normally-closed switch (ngspice SW has no "NC" mode). Optional integrated flyback diode (cathode on COIL+, anode on COIL−). Configurable via `coil_voltage`, `coil_resistance`, `include_flyback` properties. |

#### Optocouplers

Pattern: LED + 0 V current-sense source in series + CCCS (`F` element) mirrors I_LED into the phototransistor output with the part's Current Transfer Ratio (CTR).

| metadataId | CTR |
|---|---|
| `opto-4n25`  | 0.5 (50%) |
| `opto-pc817` | 1.0 (100% typical, 80–600% spread in real parts) |

#### 74HC logic ICs (multi-gate packages — 14-pin DIP)

First mapper pattern in the project that emits **multiple** B-source cards per component (one per internal gate). Pin naming follows the datasheet (e.g. 1A/1B/1Y for gate 1, up to 4Y on quad packages or 6Y on hex inverters).

| metadataId | Contents |
|---|---|
| `ic-74hc00` | 4× 2-input NAND |
| `ic-74hc02` | 4× 2-input NOR |
| `ic-74hc04` | 6× NOT |
| `ic-74hc08` | 4× 2-input AND |
| `ic-74hc14` | 6× Schmitt-trigger NOT (hysteresis via state-dependent threshold) |
| `ic-74hc32` | 4× 2-input OR |
| `ic-74hc86` | 4× 2-input XOR |

Unwired gates are skipped silently (no wasted netlist cards).

#### Flip-flops (digital simulation only)

SPICE can't do edge detection in `.op` without `ddt()`, so flip-flops live in the digital-sim layer (`PartSimulationRegistry`) and **have no SPICE mapper**. They still participate in MCU-driven circuits.

| metadataId | Behaviour on rising CLK |
|---|---|
| `flip-flop-d`  | Q ← D |
| `flip-flop-t`  | Q ← Q ⊕ T (toggle when T=1) |
| `flip-flop-jk` | J=0/K=0 hold, J=1/K=0 set, J=0/K=1 reset, J=1/K=1 toggle |

Implemented via a shared `edgeTriggeredFF` helper that tracks the previous CLK state, detects rising edges, and samples the data inputs.

#### L293D dual H-bridge motor driver

| metadataId | Topology |
|---|---|
| `motor-driver-l293d` | Per channel (2 channels, EN1 + IN1/IN2 + OUT1/OUT2 and EN2 + IN3/IN4 + OUT3/OUT4): `OUT = u(EN−T) · u(IN−T) · V(VCC2)`. When EN=LOW the outputs are high-impedance (weak 10 MΩ pull-down to 0). Resolves V_motor from the wired VCC2 net when available, else from `ctx.vcc`. |

## The `_customComponents` mechanism

Velxio-specific parts (everything not defined in `wokwi-libs/wokwi-elements`) are declared in `scripts/component-overrides.json` under the `_customComponents[]` array. The metadata generator ([`scripts/generate-component-metadata.ts`](../../scripts/generate-component-metadata.ts), function `applyOverrides`) injects them before the standard property-patching loop. An entry must have: `id`, `tagName`, `name`, `category`, `pinCount`, `tags` — other fields default.

Example:

```json
{
  "_customComponents": [
    {
      "id": "logic-gate-xnor",
      "tagName": "wokwi-logic-xnor",
      "name": "XNOR Gate",
      "category": "logic",
      "properties": [],
      "defaultValues": {},
      "pinCount": 3,
      "tags": ["logic", "gate", "xnor", "digital"]
    }
  ]
}
```

A drift detector at [`test/test_circuit/test/metadata_drift.test.js`](../../test/test_circuit/test/metadata_drift.test.js) fails if `components-metadata.json` is out of sync with the overrides file. The frontend CI workflow also regenerates and checks `git diff` on the JSON. Run `cd frontend && npm run generate:metadata` after any change to `component-overrides.json`.

## What the sandbox does **not** include

- **Temperature effects** on any parameter. `.model` cards support `tc1`, `tc2`, but we did not exercise them.
- **Noise sources** (`.noise` analysis). Supported by ngspice; untested here.
- **Monte Carlo** on device parameters. Would be useful for tolerance analysis.
- **Pole-zero / stability analysis**. `.pz` is in ngspice.
- **S-parameter / two-port** analysis. `.sp` available.
- **Behavioral R** (resistor whose value is an expression of another node's voltage) — supported by ngspice via the `R1 a b R='expr'` syntax. Would simplify the photoresistor case.
