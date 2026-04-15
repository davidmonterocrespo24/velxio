# Circuit Emulation — Architecture

## High-level data flow

Two pipelines coexist. Both share the same `avr8js` harness and the same Arduino program fixtures; they differ only in the analog solver.

```
┌────────────────────────── Shared ──────────────────────────┐
│                                                            │
│   Arduino sketch source (.ino)  or  pre-built .hex          │
│                 │                                           │
│                 ▼                                           │
│           ┌─────────────┐                                   │
│           │  AVRHarness │  (wraps avr8js)                   │
│           │   (CPU +    │                                   │
│           │    PORTs +  │                                   │
│           │    ADC +    │                                   │
│           │    Timers)  │                                   │
│           └──────┬──────┘                                   │
│                  │                                          │
│    pin state / PWM duty     ADC channel voltages            │
│                  ▼                    ▲                     │
└──────────────────│────────────────────│─────────────────────┘
                   │                    │
    ┌──────────────┼────────────────────┼──────────────┐
    │              ▼                    │              │
    │      ┌─────────────────┐          │              │
    │      │ Pipeline A      │          │              │
    │      │ MNA Solver (JS) │──────────┤              │
    │      │                 │          │              │
    │      │ - Node graph    │          │              │
    │      │ - Stamps        │          │              │
    │      │ - Newton loop   │          │              │
    │      │ - Transient     │          │              │
    │      │   (back-Euler)  │          │              │
    │      └─────────────────┘          │              │
    │                                   │              │
    │      ┌──────────────────┐         │              │
    │      │ Pipeline B       │         │              │
    │      │ SpiceEngine      │─────────┘              │
    │      │ (eecircuit-engine│                        │
    │      │  / ngspice-WASM) │                        │
    │      │                  │                        │
    │      │ - Netlist in     │                        │
    │      │ - ResultType out │                        │
    │      │ - AVRSpiceBridge │                        │
    │      │   for co-sim     │                        │
    │      └──────────────────┘                        │
    │                                                  │
    └──────────────────────────────────────────────────┘
```

## Module layout

```
test/test_circuit/
├── src/
│   ├── solver/                  # Pipeline A — hand-rolled MNA
│   │   ├── linalg.js            # Gaussian elimination with partial pivoting
│   │   └── Circuit.js           # Circuit class, DC + transient solve
│   ├── components/              # Component library for Pipeline A
│   │   ├── passive.js           # R, V, I, C, Pot, NTC, Switch
│   │   └── active.js            # Diode, LED, BJT
│   ├── avr/                     # Shared AVR harness
│   │   ├── intelHex.js          # Intel HEX parser (same format as Velxio)
│   │   ├── AVRHarness.js        # Thin wrapper over avr8js
│   │   ├── asm.js               # Mini AVR assembler (LDI, OUT, STS, LDS, RJMP, SBRC/S, NOP)
│   │   └── programs.js          # Hand-assembled Arduino programs (pot→PWM, adcRead)
│   ├── spice/                   # Pipeline B — ngspice integration
│   │   ├── SpiceEngine.js       # runNetlist() + vec()/dcValue() helpers
│   │   └── AVRSpiceBridge.js    # Quasi-static AVR ↔ ngspice co-simulation
│   └── index.js                 # Re-exports for Pipeline A
├── fixtures/
│   └── blink.hex                # Copied from frontend/src/__tests__/fixtures/
├── test/                        # 14 test files, 47 tests total
├── plan/                        # 8 markdown planning docs
└── autosearch/                  # 4 findings docs
```

## Pipeline A — Hand-rolled MNA

Goal: a transparent, minimal-dependency baseline that we fully control. Useful for:
- Understanding every step of the solver
- Cross-checking ngspice results on toy problems
- Providing a fallback if `eecircuit-engine` cannot be loaded in a constrained environment

**Execution path:**

1. User constructs a `Circuit` object and adds `Component` instances.
2. `circuit.solveDC({maxIter, tol})` is called.
3. Solver identifies voltage-source components and allocates extra MNA rows.
4. For each Newton iteration:
   - Zero the G matrix and b vector (size `N + M`).
   - Add a small shunt conductance `GMIN = 1e-12` on every node for stability.
   - Call `component.stampDC(G, b, ctx)` on every component.
   - Solve `G · x = b` via Gaussian elimination.
   - Apply damping (≤ 0.5 V step per node) and iterate until `max |Δx| < tol` or `maxIter` reached.
5. Store `nodeVoltages` and `branchCurrents` in `state`.

**Transient execution path:**

1. `circuit.runTransient(tEnd, dt, sampleEvery)` seeds `state.prev.nodeVoltages` from each capacitor's `Vinit` (the initial condition).
2. On every step, `state.prev` is the solution from the previous step.
3. The capacitor stamp uses backward Euler: conductance `G_c = C/Δt`, companion current `I_eq = (C/Δt)·V_prev`.
4. Solver runs `solveDC({dt})` with the capacitor stamps using `ctx.prev`.

See [circuit-emulation-mna-solver.md](circuit-emulation-mna-solver.md) for stamp-level detail.

## Pipeline B — ngspice-WASM

Goal: leverage the full, battle-tested ngspice engine (30+ years of development) without reinventing any physics.

**Execution path:**

1. First call to `getEngine()` or `runNetlist()` boots `eecircuit-engine` — downloads and instantiates ~39 MB of WASM+glue; takes ~400 ms.
2. Subsequent calls reuse the same `Simulation` singleton.
3. Each call:
   - Compose a full SPICE netlist string (component cards + `.op` / `.tran` / `.ac` / `.dc` + `.end`).
   - `sim.setNetList(netlist)`.
   - `await sim.runSim()` → returns a `ResultType` with `variableNames[]` and `data[].values[]`.
4. Our wrapper exposes helpers:
   - `vec(name)` → array of numbers (real data) or `[{real, img}]` (complex data from `.ac`).
   - `dcValue(name)` → first value of the vector.
   - `findVar(name)` → index in `variableNames[]`, matching either `"v(node)"` or just `"node"`.

See [circuit-emulation-ngspice.md](circuit-emulation-ngspice.md) for netlist authoring conventions and gotchas.

## Mixed-signal co-simulation

`avr8js` runs the MCU at ~1 MHz (in JS it's slower than real 16 MHz silicon, but cycle-accurate). ngspice runs transient analysis on the analog network. They are **not locked cycle-by-cycle**; instead the bridge operates **quasi-statically** in time slices.

Per slice (default: 1 ms of AVR time = 16 000 cycles):

```
┌─ slice n ────────────────────────────────────────────────┐
│                                                          │
│  1. avr.runCycles(16_000)                                │
│       → new pin states, new PWM duty cycles              │
│                                                          │
│  2. snapshot = { pin6:{type:'pwm',duty:0.5},             │
│                  pin13:{type:'digital',v:5}, ... }       │
│                                                          │
│  3. buildNetlist(snapshot) → string                      │
│       V_PIN6 pin6 0 DC 2.5  ← duty × 5                   │
│       V_PIN13 pin13 0 DC 5                               │
│       ... passive circuit ...                            │
│       .tran 10u 1m                                       │
│       .end                                               │
│                                                          │
│  4. await runNetlist(netlist) → result                   │
│                                                          │
│  5. for each analog channel: inject final v(node) into   │
│     avr.setAnalogVoltage(ch, v)                          │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

This is good enough for:
- ADC sampling of slow analog sources (NTC, pot, photoresistor)
- PWM filtered to DC via RC
- LED current driven by a digital or PWM pin
- Digital outputs driving logic or switches

It is **not good enough** for:
- Audio-rate feedback loops where the analog network reacts on sub-millisecond timescales
- Oscillators where the analog side drives a digital input and vice versa with tight timing
- Noise / jitter analysis

For the tight-coupling cases, a co-simulation framework would need to arbitrate time advancement between the two engines (see [Velxio Integration](circuit-emulation-velxio-integration.md) for future work).

## Shared Arduino harness

Both pipelines use `AVRHarness` to drive `avr8js`. This class **mirrors exactly** what Velxio's `frontend/src/simulation/AVRSimulator.ts` does:

- `new CPU(programUint16, sramBytes)`
- `new AVRIOPort(cpu, portBConfig/portCConfig/portDConfig)`
- `new AVRADC(cpu, adcConfig)` — `adc.channelValues[channel] = volts` to inject analog
- `new AVRTimer(cpu, timer0Config/...)`
- `new AVRUSART(cpu, usart0Config, 16_000_000)`
- Listeners per port: `port.addListener((newValue, oldValue) => ...)` with bit-by-bit diff and Arduino pin mapping (D0–D7, D8–D13, A0–A5 via port C).
- PWM duty read via `cpu.data[ocrAddress]` where ocrAddress for Timer0A is `0x47`, Timer1AL is `0x88`, etc.

This parity is important: any lesson learned in the sandbox transfers one-for-one to Velxio's main app.

See [circuit-emulation-avr-bridge.md](circuit-emulation-avr-bridge.md) for the full harness reference.

## Fixtures and hand-assembled programs

To exercise the full sketch path (C++ → avr-gcc → hex) we would normally compile Arduino code. The sandbox does not have `avr-gcc` installed, so we use:

1. **Copied from Velxio**: `fixtures/blink.hex` — the same Intel HEX used by `frontend/src/__tests__/fixtures/avr-blink/avr-blink.ino.hex`. Tests that load this file exercise the full Arduino core init (reset vectors, library init, `setup()`, `loop()`).

2. **Hand-assembled programs**: `src/avr/programs.js` exposes `potToPwmProgram()` and `adcReadProgram()`, built with the mini-assembler in `src/avr/asm.js`. These bypass the Arduino core and directly configure ADC and Timer0 registers. They produce ~18–22 instruction words each. Full opcode breakdown is in [circuit-emulation-appendix.md](circuit-emulation-appendix.md).
