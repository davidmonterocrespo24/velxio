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

- Op-amps (LM358, TL072, etc.) — vendor .subckt available
- 555 timer — vendor .subckt or our relaxation-osc behavioral model
- Voltage regulators (78xx, LDOs) — behavioral with `limit()`
- Shift registers (74HC595) — behavioral gate network, clocked switches
- H-bridges (L293D) — 4 MOSFETs or 4 switches
- ADCs / DACs — behavioral `u()` thresholds or `limit()` scaled

## What the sandbox does **not** include

- **Temperature effects** on any parameter. `.model` cards support `tc1`, `tc2`, but we did not exercise them.
- **Noise sources** (`.noise` analysis). Supported by ngspice; untested here.
- **Monte Carlo** on device parameters. Would be useful for tolerance analysis.
- **Pole-zero / stability analysis**. `.pz` is in ngspice.
- **S-parameter / two-port** analysis. `.sp` available.
- **Behavioral R** (resistor whose value is an expression of another node's voltage) — supported by ngspice via the `R1 a b R='expr'` syntax. Would simplify the photoresistor case.
