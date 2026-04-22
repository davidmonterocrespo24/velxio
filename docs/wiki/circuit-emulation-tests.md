# Test Catalog — All 47 Tests

Every test in [`test/test_circuit/test/`](../../test/test_circuit/test/) enumerated: the circuit under test, what physics it validates, and the numerical expectation.

## Baseline — hand-rolled MNA solver (25 tests)

### `passive.test.js` — 11 tests

Tests the linear DC solver on textbook passives.

| # | Test | Circuit | Expected | Tolerance |
|---|---|---|---|---|
| 1 | Voltage divider | 9V → 1k + 2k | V(out) = 6.0 V | 3 decimals |
| 2 | Equal-R divider | 5V → 1k + 1k | V(b) = 2.5 V | 3 decimals |
| 3 | Ohm's law | 5V, 220Ω | I = 22.7 mA | 5 decimals |
| 4 | Three 3kΩ parallel | series with 1k | V(p) = 1.5 V | 3 decimals |
| 5 | Current source + R | 1 mA into 2.2kΩ | V = 2.2 V | 3 decimals |
| 6 | Pot wiper at 50% | 10k pot, 5V | V = 2.5 V | 2 decimals |
| 7 | Pot sweep 0→1 | 5 steps | monotonic increase | ≥ −10 mV slack |
| 8 | NTC resistance @ 25°C | β=3950 | R = 10 000 Ω | within 1 Ω |
| 9 | NTC temperature monotonicity | T ∈ {0, 25, 50} | R(0) > R(25) > R(50) | textbook ranges |
| 10 | NTC + 10k divider | T ∈ {0, 25, 50} | V_A0 matches expected per table | per-point tolerance |
| 11 | Switch open/closed | 5V → 1k → switch → GND | open: 4.9–5.0 V, closed: < 50 mV | |

### `transient_rc.test.js` — 3 tests

| # | Test | Circuit | Expected | Tolerance |
|---|---|---|---|---|
| 1 | RC charging @ τ | 10k, 100µF, 5V | V(τ) ≈ 3.16 V | ±5% |
| 2 | 5τ settling | 1k, 1µF, 3.3V | V(5τ) > 99% V | hard bound |
| 3 | Capacitor discharge | pre-charged 5V → 10k | V(τ) in [1.5, 2.2] V | manual bounds |

### `diodes.test.js` — 7 tests

| # | Test | Circuit | Expected |
|---|---|---|---|
| 1 | Forward diode + 1k + 5V | Shockley default | V_d ∈ [0.55, 0.75] V, I ∈ [4, 5] mA |
| 2 | Reverse diode | diode blocks | V_a < 10 mV |
| 3 | Red LED + 220Ω + 5V | | V_f ∈ [1.8, 2.3] V, I ∈ [10, 16] mA, brightness > 0.5 |
| 4 | Blue LED higher Vf than red | | V_blue > V_red, V_blue ∈ [2.8, 3.6] V |
| 5 | LED brightness with supply | V ∈ {2.0, 3.0, 5.0} | monotonic, dim at 2V, bright at 5V |
| 6 | BJT switch ON | V_b = 5V, R_b = 10k | V_CE < 0.8 V |
| 7 | BJT switch OFF | V_b = 0 | V_CE > 4.9 V |

### `avr_blink.test.js` — 2 tests

Uses the real `fixtures/blink.hex` (copied from Velxio's test fixtures).

| # | Test | What it validates |
|---|---|---|
| 1 | Toggles pin 13 | After 2 s of AVR time, observed ≥ 3 edge transitions on D13; both 0 and 1 states visible |
| 2 | Drives simulated LED | Pin-13 voltage fed into a `VoltageSource`, 220 Ω + red LED; LED brightness switches between < 1% and > 50% |

### `e2e_pot_pwm_led.test.js` — 1 test

Uses `potToPwmProgram()` (hand-assembled: reads A0, writes to OCR0A for PWM on D6).

Circuit: `+5V → pot (10k) → A0 / GND` plus `D6 → 220Ω → red LED → GND`.

Sweep wiper 0.0 → 0.25 → 0.50 → 0.75 → 1.00:

| Wiper | V_A0 | PWM duty | I_LED | Brightness |
|---|---|---|---|---|
| 0.00 | 0.000 V | 0.0 % | 0.00 mA | 0.000 |
| 0.25 | 1.250 V | 24.7 % | 0.00 mA | 0.000 |
| 0.50 | 2.500 V | 49.8 % | 3.26 mA | 0.163 |
| 0.75 | 3.750 V | 74.9 % | 8.77 mA | 0.439 |
| 1.00 | 5.000 V | 100.0 % | 14.38 mA | 0.719 |

Assertions: duty at 0% < 5%, duty at 100% > 90%, brightness monotonic, final > 0.5, initial < 0.05.

### `e2e_thermistor.test.js` — 1 test

Uses `adcReadProgram()` + NTC + pullup divider.

Circuit: `+5V → 10kΩ → A0 → NTC → GND`.

Per temperature T ∈ {0, 15, 25, 35, 50} °C:

| T_set | V_A0 | ADC raw | R_ntc (true) | R_meas (recovered) | T_meas |
|---|---|---|---|---|---|
| 0 °C | 3.854 V | 789 | 33 621 Ω | 33 718 Ω | −0.05 °C |
| 15 °C | 3.065 V | 627 | 15 837 Ω | 15 833 Ω | 15.01 °C |
| 25 °C | 2.500 V | 511 | 10 000 Ω | 9 980 Ω | 25.04 °C |
| 35 °C | 1.971 V | 403 | 6 506 Ω | 6 500 Ω | 35.02 °C |
| 50 °C | 1.320 V | 270 | 3 588 Ω | 3 586 Ω | 50.02 °C |

Assertion: `|T_meas − T_set| < 1 °C` at every point. Achieved: < 0.05 °C.

## ngspice — `spice_*.test.js` (22 tests)

### `ngspice_smoke.test.js` — 1 test

The minimal possible smoke test.

| # | Test | Netlist | Expected |
|---|---|---|---|
| 1 | Boot + voltage divider | `V 9 → R 1k → R 2k → GND, .op` | `V(out) = 6.0` |

### `spice_passive.test.js` — 3 tests

All run with `.op`:

| # | Circuit | Expected |
|---|---|---|
| 1 | 9V → 1k + 2k | V(out) = 6 V |
| 2 | Three 3kΩ parallel + 1k series from 3V | V(p) = 1.5 V |
| 3 | 1 mA current source into 2.2kΩ | V(a) = 2.2 V |

### `spice_transient.test.js` — 2 tests

| # | Test | `.tran` | Expected |
|---|---|---|---|
| 1 | RC charging | 10m 3 | V(τ) ≈ 3.16 V, V(5τ) > 90% |
| 2 | RLC underdamped oscillation | 10u 30m, R=1Ω, L=10mH, C=10µF | zero-crossings imply f ≈ 503 Hz, ±15 % |

### `spice_ac.test.js` — 2 tests

| # | Test | `.ac` | Expected |
|---|---|---|---|
| 1 | RC low-pass Bode | 20 ppd, 10 Hz – 1 MHz | f₋₃dB ∈ [900, 1100] Hz; low-freq gain ≈ 0 dB; −20 dB/decade rolloff; phase @ cutoff ≈ −45° |
| 2 | Parallel-tank RLC bandpass | 30 ppd, 10 Hz – 1 MHz | peak near 5033 Hz (±20%), passive so max gain ≈ 0 dB; 10×f₀ rejection > 15 dB below peak |

### `spice_active.test.js` — 6 tests

| # | Test | Analysis | Expected |
|---|---|---|---|
| 1 | Diode forward (1N4148 model) | `.op` | V_a ∈ [0.55, 0.80] V |
| 2 | Bridge rectifier (4 diodes + sine 6V/50Hz) | `.tran 0.1m 40m` | peak output 4.2–5.4 V, always positive |
| 3 | Common-emitter amp (2N2222, 12V, ~1kHz input, bypassed R_E) | `.tran 10u 6m` | voltage gain > 30 |
| 4 | N-MOS Level-1 switch, V_gate=5V | `.op` | V(drain) < 1.0 V |
| 5 | N-MOS Level-1 off, V_gate=0 | `.op` | V(drain) > 4.9 V |
| 6 | Op-amp inverting amp (E-source, R_in=1k, R_f=10k) | `.op` | V(out) ≈ −2.0 V |

### `spice_digital.test.js` — 4 tests

All gates implemented with B-sources using `u()` step function.

| # | Gate | Rows tested |
|---|---|---|
| 1 | AND | 4 (truth table) |
| 2 | NAND | 4 |
| 3 | XOR | 4 |
| 4 | AND → RC low-pass | `.tran 10u 20m` — verifies filter ripple < 1.5 V, raw AND swings 0–5 V, filtered mean in (0, 5) |

### `spice_555_astable.test.js` — 1 test

RC relaxation oscillator built from a Schmitt-switch (S-element with hysteresis).

- R = 10 kΩ, C = 10 nF
- `SMOD: Vt=2.5, Vh=0.833, Ron=100, Roff=1G`
- `.tran 0.5u 2m`

Expected: output toggles, ≥ 3 rising edges detected in the steady-state window; measured frequency between 500 Hz and 50 kHz (wide range because behavioral model differs from ideal 555 math).

Typical measured: ~7 kHz.

### `spice_avr_mixed.test.js` — 3 tests

The flagship mixed-signal demonstrator.

#### Test 1 — NTC → ngspice → ADC → sketch

For each T ∈ {0, 25, 50} °C:
1. ngspice `.op` solves `10k pullup + R_ntc(T)`
2. `avr.setAnalogVoltage(0, V(a0))`
3. `avr.runCycles(500_000)` runs `adcReadProgram()`
4. Read `ADCH/ADCL` registers directly → reconstruct 10-bit result

Expected results match textbook within ±5 LSB:

| T | V(a0) from ngspice | ADC raw from avr8js |
|---|---|---|
| 0 °C | 3.854 V | 789 |
| 25 °C | 2.500 V | 512 |
| 50 °C | 1.320 V | 270 |

#### Test 2 — Sketch → PWM → ngspice RC → filtered DC

For V_A0 ∈ {1.0, 2.5, 4.0} V:
1. Run `potToPwmProgram()` with the given analog voltage
2. Read PWM duty (must match `V_A0 / 5` ± 0.05)
3. Feed `duty × 5` as DC source into `R=10k, R_load=10MΩ` in ngspice
4. `.op` gives filtered DC output — should match duty × 5 within 0.1 V

Measured:

| V_A0 | duty | V_filt | expected |
|---|---|---|---|
| 1.0 V | 20.0 % | 0.999 V | 1.00 V |
| 2.5 V | 50.2 % | 2.507 V | 2.51 V |
| 4.0 V | 80.0 % | 3.996 V | 4.00 V |

#### Test 3 — Co-simulation loop (AVRSpiceBridge)

The bridge runs the AVR in 1 ms slices, re-solving ngspice between each. Pot wiper is moved mid-test.

- wiper = 0.25 → 5 slices run → expected ADC ≈ 256 (0.25 × 1023). Measured: **256**. Tolerance ±20 LSB.
- wiper moves to 0.75 → 5 more slices → expected ADC ≈ 767. Measured: **768**.

Demonstrates that ngspice + avr8js can be cleanly co-simulated quasi-statically.

## Pass/fail history

All 47 tests passed as of 2026-04-15. Running `npm test` from `test/test_circuit/` is the canonical verification. Expected wall-clock: ~5 seconds on an i7.

Full command output:

```
 ✓ test/ngspice_smoke.test.js        (1 test)  372ms
 ✓ test/spice_passive.test.js        (3 tests) 358ms
 ✓ test/spice_transient.test.js      (2 tests) 629ms
 ✓ test/spice_ac.test.js             (2 tests) 340ms
 ✓ test/spice_active.test.js         (6 tests) 600ms
 ✓ test/spice_digital.test.js        (4 tests) 420ms
 ✓ test/spice_555_astable.test.js    (1 test)  609ms
 ✓ test/spice_avr_mixed.test.js      (3 tests) 800ms
 ✓ test/passive.test.js             (11 tests)   8ms
 ✓ test/transient_rc.test.js         (3 tests)  22ms
 ✓ test/diodes.test.js               (7 tests)  15ms
 ✓ test/avr_blink.test.js            (2 tests) 2400ms
 ✓ test/e2e_pot_pwm_led.test.js      (1 test)   90ms
 ✓ test/e2e_thermistor.test.js       (1 test)  121ms

 Test Files  14 passed (14)
 Tests       47 passed (47)
 Duration    ~5 s
```
