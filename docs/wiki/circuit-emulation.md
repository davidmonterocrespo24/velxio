# Circuit Emulation — Wiki Entry Point

Full electrical simulation experiment for Velxio. Validates that Arduino sketches can be co-simulated with real analog circuit behaviour inside the Velxio emulator.

## TL;DR

- **Where**: all code and tests live in [`test/test_circuit/`](../../test/test_circuit/).
- **What works**: 47 / 47 tests, 14 files, ~5 seconds total.
- **Two pipelines**: hand-rolled MNA solver (fast, 0 extra deps) + ngspice-WASM via `eecircuit-engine` (complete SPICE).
- **Showcase**: an Arduino sketch compiled to `.hex` runs on `avr8js` and reads a real voltage that ngspice computes from an NTC thermistor divider, recovering temperature within 0.05 °C across 0–50 °C.
- **Status**: sandbox is complete; ready to port into `frontend/src/simulation/` behind a feature flag.

## Detailed docs

The full documentation is split into focused pages:

1. [**Overview**](circuit-emulation-overview.md) — goals, outcomes, index.
2. [**Architecture**](circuit-emulation-architecture.md) — dual-pipeline design, data flow, module layout.
3. [**MNA Solver (hand-rolled)**](circuit-emulation-mna-solver.md) — the ~500-line JS SPICE kernel and why we built it first.
4. [**ngspice-WASM (`eecircuit-engine`)**](circuit-emulation-ngspice.md) — installation, API, netlist syntax, gotchas.
5. [**Component Catalog**](circuit-emulation-components.md) — every R/L/C/D/BJT/MOSFET/op-amp/NTC we validated, with parameters.
6. [**AVR Bridge**](circuit-emulation-avr-bridge.md) — how `avr8js` is wrapped (mirroring Velxio) and how `AVRSpiceBridge` does mixed-signal co-simulation.
7. [**Test Catalog**](circuit-emulation-tests.md) — all 47 tests enumerated, with expected results.
8. [**Gotchas**](circuit-emulation-gotchas.md) — every bug we hit and how we fixed it.
9. [**Performance**](circuit-emulation-performance.md) — benchmarks, memory footprint, lazy-load plan.
10. [**Velxio Integration Plan**](circuit-emulation-velxio-integration.md) — concrete files/changes to ship this in the main app. **Superseded by** [`test/test_circuit/plan/phase_8_velxio_implementation.md`](../../test/test_circuit/plan/phase_8_velxio_implementation.md) — more detailed, with new analog components and measurement instruments.
11. [**API Reference**](circuit-emulation-api.md) — every exported function and class.
12. [**Appendix**](circuit-emulation-appendix.md) — reference netlists, AVR opcode tables, model parameters, glossary.

## Quickstart

```bash
cd test/test_circuit
npm install
npm test                        # all 47 tests
```

Specific suites:

```bash
npx vitest run test/spice_passive.test.js          # ngspice DC
npx vitest run test/spice_transient.test.js        # ngspice transient
npx vitest run test/spice_ac.test.js               # ngspice AC / Bode
npx vitest run test/spice_active.test.js           # diode, BJT, MOSFET, op-amp
npx vitest run test/spice_digital.test.js          # behavioral gates
npx vitest run test/spice_555_astable.test.js      # relaxation oscillator
npx vitest run test/spice_avr_mixed.test.js        # AVR ↔ ngspice mixed-signal
```

## Hello-world example

```javascript
import { runNetlist } from '../src/spice/SpiceEngine.js';

const { dcValue } = await runNetlist(`Voltage divider
V1 vcc 0 DC 9
R1 vcc out 1k
R2 out 0 2k
.op
.end`);

console.log(dcValue('v(out)'));   // 6
```

## Mixed-signal showcase

```javascript
import { AVRHarness } from '../src/avr/AVRHarness.js';
import { adcReadProgram } from '../src/avr/programs.js';
import { runNetlist } from '../src/spice/SpiceEngine.js';

// 1. Solve an NTC + pullup divider in ngspice
const { dcValue } = await runNetlist(`NTC divider @25C
Vcc vcc 0 DC 5
Rpull vcc a0 10k
Rntc a0 0 10k
.op
.end`);
const va0 = dcValue('v(a0)');         // 2.500 V

// 2. Hand it to an Arduino sketch running in avr8js
const avr = new AVRHarness();
avr.loadProgram(adcReadProgram());
avr.setAnalogVoltage(0, va0);
avr.runCycles(500_000);

// 3. Inspect the ADC result the sketch saw
const ADCH = avr.cpu.data[0x79];
const ADCL = avr.cpu.data[0x78];
const raw = (ADCH << 2) | (ADCL >> 6);
console.log(raw);                     // 511 → matches 2.5/5 * 1023
```

## What this proves

Velxio can realistically integrate a **full electrical simulator** (ngspice or a hand-rolled fallback) alongside its existing MCU emulators, giving students and hobbyists circuits that behave the way they would on a real breadboard — correct voltages, correct currents, correct LED brightness, correct ADC readings, real op-amp saturation, real RC filter time constants, real Bode plots. All in ~5 seconds of test time, all within a browser-compatible JavaScript/WASM stack.

The groundwork and the port plan are ready. See [Velxio Integration](circuit-emulation-velxio-integration.md) for the next step.
