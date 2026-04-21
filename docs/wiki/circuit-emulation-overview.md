# Circuit Emulation — Overview

> Comprehensive documentation of the circuit emulation experiment carried out in `test/test_circuit/`. This page is the index into the detailed pages.

## Purpose

Velxio emulates the **digital side** of Arduino boards (ATmega328P, ATmega2560, ATtiny85, RP2040, ESP32) perfectly — every opcode of every timer and peripheral is executed by `avr8js` / `rp2040js` / qemu. But the **analog side** is purely decorative: wires conduct nothing, resistor values are ignored, LEDs are boolean, potentiometers do not affect `analogRead`.

The circuit emulation experiment aims to close that gap: make Velxio simulate **real electrical behaviour** so that an Arduino sketch reads the true voltage produced by an actual NTC divider, a PWM pin drives an RC filter to a real DC level, a 555 oscillator produces a real square wave, and an op-amp Schmitt trigger cleans a noisy sine.

## Outcome

Two complete implementations were built and tested under `test/test_circuit/`:

| Implementation | Lines | Dependencies | Tests passing | Duration |
|---|---|---|---|---|
| **Hand-rolled MNA solver** (JS) | ~500 | `avr8js`, `vitest` | 25 / 25 | ~2.9 s |
| **ngspice-WASM via `eecircuit-engine`** | ~300 | `eecircuit-engine` (~39 MB), `avr8js`, `vitest` | 22 / 22 | ~3 s |
| **Total** | — | — | **47 / 47** | ~5 s |

Both stacks coexist in the sandbox. The hand-rolled solver serves as a transparent baseline; `ngspice-WASM` is the recommended production path because it covers the full SPICE feature set (DC, transient, AC, noise, `.model`, `.subckt`, etc.) without us maintaining the physics.

## Documentation index

| Page | What it covers |
|---|---|
| [circuit-emulation-overview.md](circuit-emulation-overview.md) | You are here. Goals, outcome, index. |
| [circuit-emulation-architecture.md](circuit-emulation-architecture.md) | Dual pipeline, data flow, module layout, mixed-signal bridge. |
| [circuit-emulation-mna-solver.md](circuit-emulation-mna-solver.md) | Hand-rolled MNA solver: algorithm, stamps, Newton-Raphson, `pnjlim`, transient integration. |
| [circuit-emulation-ngspice.md](circuit-emulation-ngspice.md) | `eecircuit-engine` integration: boot, netlist syntax, result parsing, B-sources, switch-memory tricks. |
| [circuit-emulation-components.md](circuit-emulation-components.md) | Component catalog: R, L, C, D, LED (5 colors), BJT, MOSFET, NTC, op-amp macros, switch, pot — parameters and stamps. |
| [circuit-emulation-avr-bridge.md](circuit-emulation-avr-bridge.md) | How `avr8js` is wrapped like Velxio does it, and how the bridge co-simulates MCU+circuit quasi-statically. |
| [circuit-emulation-tests.md](circuit-emulation-tests.md) | Every test case (47 of them), the physics being validated, and the expected numerical result. |
| [circuit-emulation-gotchas.md](circuit-emulation-gotchas.md) | What broke and how we fixed it — diode overshoot, transient initial state, ADC ADLAR, B-source operators, singular-matrix hangs, more. |
| [circuit-emulation-performance.md](circuit-emulation-performance.md) | Timings per analysis type, memory footprint, comparison between solvers. |
| [circuit-emulation-velxio-integration.md](circuit-emulation-velxio-integration.md) | Proposed integration into the Velxio main app: files to create, data-flow diagram, lazy-load strategy, `metadataId` → SPICE primitive table. |
| [circuit-emulation-api.md](circuit-emulation-api.md) | API reference for every exported function / class in the sandbox. |
| [circuit-emulation-appendix.md](circuit-emulation-appendix.md) | Netlists, AVR opcode cheatsheet, model parameters, glossary. |

## Quick start

```bash
cd test/test_circuit
npm install
npm test                  # all 47 tests
npm run test:phase3       # passive DC (JS baseline)
npm run test:avr          # avr8js integration
npm run test:e2e          # end-to-end Arduino+circuit
```

Specific suites:

```bash
npx vitest run test/spice_passive.test.js          # ngspice DC
npx vitest run test/spice_transient.test.js        # ngspice .tran
npx vitest run test/spice_ac.test.js               # ngspice .ac Bode
npx vitest run test/spice_active.test.js           # diode, BJT, MOSFET, op-amp
npx vitest run test/spice_digital.test.js          # behavioral gates
npx vitest run test/spice_555_astable.test.js      # relaxation oscillator
npx vitest run test/spice_avr_mixed.test.js        # AVR ↔ ngspice co-sim
```

## Scope of the experiment

### What was implemented and tested

- Modified Nodal Analysis (MNA) solver, dense matrix, partial-pivot Gaussian elimination
- Newton-Raphson for non-linear devices with SPICE-style `pnjlim` voltage limiting
- Backward-Euler transient integration
- Component library: resistor, voltage source, current source, capacitor, potentiometer, NTC thermistor, switch, diode (Shockley), LED (5 colors), NPN BJT (simplified Ebers-Moll)
- `eecircuit-engine` wrapper — boot, netlist submission, result parsing for real/complex data
- Co-simulation bridge between `avr8js` and ngspice
- Hand-assembled AVR programs that do `analogRead` + PWM output + register-level ADC reads
- End-to-end pipelines: potentiometer → ADC → PWM → LED brightness; NTC → ADC → temperature recovery within 0.05 °C
- Mixed-signal digital + analog living in the same netlist (gates → RC filter)
- SPICE primitives: `R`, `L`, `C`, `V`, `I`, `D`, `Q` (BJT), `M` (MOSFET L1), `E` (VCVS), `S` (voltage switch), `B` (behavioral)
- SPICE analyses: `.op`, `.tran`, `.ac`

### What was deliberately out of scope

- **Production-ready code** (this is a research sandbox; results feed the production plan).
- **Noise analysis** (`.noise`), S-parameters, pole-zero — ngspice supports these; we did not test them here.
- **Browser integration** — all tests run in Node via Vitest. The same code should work in browser with Vite bundling but has not been verified end-to-end.
- **Cycle-accurate AVR ↔ analog co-sim** — we use a quasi-static approach (resolve the analog network once per 1 ms slice). Sufficient for PWM filtering, ADC reads, LED brightness; insufficient for audio-rate analog feedback.
- **XSPICE digital primitives** — not compiled into the `eecircuit-engine` WASM build; we emulate gates with B-sources instead.

## Licenses / provenance

- `avr8js` — MIT, by Uri Shaked / Wokwi
- `eecircuit-engine` — MIT, by `eelab-dev` (ngspice compiled with Emscripten)
- `vitest` — MIT
- The hand-rolled MNA solver and all test code were written fresh under this sandbox.
