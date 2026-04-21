# ngspice-WASM Integration

Location: [`test/test_circuit/src/spice/`](../../test/test_circuit/src/spice/)

## Why `eecircuit-engine`

When the user pushed back on "no quiero inventar nada raro", we surveyed the landscape:

| Package | Status 2026-04 | Decision |
|---|---|---|
| [`eecircuit-engine`](https://www.npmjs.com/package/eecircuit-engine) 1.7.0 | Active, published npm | **Chosen** |
| [`tscircuit/ngspice`](https://github.com/tscircuit/ngspice) | GitHub only, not on npm | Deferred (requires fork+publish) |
| [ngspice.js](https://ngspice.js.org/) | Demo site, no npm API | Declined |
| [SpiceJS](https://www.spicejs.org/) | Web UI, no programmable API | Declined |
| `webspice` on npm | Unrelated (NASA observation geometry) | Declined |
| `vollgas` | Pure-digital logic-gate sim | Declined |

`eecircuit-engine` is ngspice compiled with Emscripten to WebAssembly + a thin TypeScript wrapper. It is published by `eelab-dev`, used as the engine behind [eecircuit.com](https://eecircuit.com/). MIT licensed, has TypeScript types.

## Installation

```bash
cd test/test_circuit
npm install eecircuit-engine
```

Resulting size on disk:

```
node_modules/eecircuit-engine/
├── LICENSE
├── README.md
├── dist/
│   ├── eecircuit-engine.mjs     ← ESM entry
│   ├── eecircuit-engine.umd.js  ← UMD bundle
│   ├── main.d.ts                ← TypeScript types
│   └── (WASM binary embedded as base64 inside the JS bundle)
└── package.json

Total: 39 MB
```

Yes, 39 MB is large. In Velxio production this must be **lazy-loaded**: the user hits a "⚡ Electrical simulation" toggle, and only then is the bundle fetched. The size trade-off is documented in [performance](circuit-emulation-performance.md).

## API surface (from `dist/main.d.ts`)

```typescript
export declare class Simulation {
  start: () => Promise<void>;
  setNetList: (input: string) => void;
  runSim: () => Promise<ResultType>;
  getInfo: () => string;
  getInitInfo: () => string;
  getError: () => string[];
  isInitialized: () => boolean;
}

export declare type ResultType = {
  header: string;
  numVariables: number;
  variableNames: string[];
  numPoints: number;
  dataType: "real";
  data: RealDataType[];   // data[i].values: number[]
} | {
  header: string;
  numVariables: number;
  variableNames: string[];
  numPoints: number;
  dataType: "complex";
  data: ComplexDataType[]; // data[i].values: {real, img}[]
};
```

That's the entire public API. Everything else — analyses, models, components — is expressed through the netlist string.

## The wrapper

[`src/spice/SpiceEngine.js`](../../test/test_circuit/src/spice/SpiceEngine.js) wraps this with conveniences:

```javascript
import { runNetlist, NL } from '../src/spice/SpiceEngine.js';

// Simple DC
const { dcValue } = await runNetlist(`VDIV
V1 vcc 0 DC 9
R1 vcc out 1k
R2 out 0 2k
.op
.end`);
console.log(dcValue('v(out)'));   // 6

// Transient: vec(name) returns array
const { vec } = await runNetlist(`
V1 in 0 PULSE(0 5 0 1n 1n 10m 20m)
R1 in out 10k
C1 out 0 100u IC=0
.tran 100u 30m
.end`);
const time = vec('time');
const vout = vec('v(out)');

// AC sweep: vec returns complex
const { vec: vecAC } = await runNetlist(`
V1 in 0 AC 1
R1 in out 1k
C1 out 0 1u
.ac dec 20 10 1Meg
.end`);
const freq = vecAC('frequency');         // [{real, img}] — img is 0 for freq
const vout = vecAC('v(out)');            // [{real, img}]
const mag_dB = vout.map(c => 20*Math.log10(Math.sqrt(c.real**2 + c.img**2)));
```

Key design decisions:

- **Singleton engine**. Booting takes 400 ms; we boot once per test process.
- **`findVar(name)`** accepts either `"v(node)"` or `"node"` — ngspice typically uses the former for voltages and `time` / `frequency` for the sweep variables.
- **Case-insensitive**. SPICE is historically case-preserving-but-insensitive; ngspice tends to lowercase node names.
- **`NL.pulse / NL.sin / NL.pwl`** helpers format the common source cards correctly.

## Netlist syntax (ngspice)

This section summarizes the SPICE cards we validated. For the full reference, see the [ngspice manual](https://ngspice.sourceforge.io/docs.html).

### Passive

```spice
R1 node1 node2 1k        ; resistor in Ω (k=1e3, Meg=1e6, u=1e-6, n=1e-9, p=1e-12)
C1 node1 node2 100u IC=0 ; capacitor, optional initial condition
L1 node1 node2 10m       ; inductor
V1 plus  minus DC 5      ; voltage source
I1 from  to    DC 1m     ; current source
```

### Sources

```spice
* Pulse: V1 P N PULSE(V_init V_final T_delay T_rise T_fall T_pulse_width T_period)
Vclk clk 0 PULSE(0 5 0 10n 10n 1u 2u)

* Sinusoidal: V1 P N SIN(V_offset V_amp freq)
Vosc osc 0 SIN(0 1 1k)

* Piecewise linear: V1 P N PWL(t0 v0 t1 v1 t2 v2 ...)
Vsig sig 0 PWL(0 0 1m 5 2m 5 3m 0)

* For AC analysis: add "AC amp" on the source card
V1 in 0 AC 1             ; 1V AC small-signal
V1 in 0 DC 0 AC 1        ; DC bias + AC probe
```

### Active devices

```spice
* Diode
D1 anode cathode DMOD
.model DMOD D(Is=1e-14 N=1)
* ngspice ships common models; for 1N4148:
.model D1N4148 D(Is=2.52n N=1.752 Rs=0.568 Ibv=0.1u Bv=100)

* BJT (npn/pnp)
Q1 collector base emitter Q2N2222
.model Q2N2222 NPN(Is=1e-14 Bf=200 Vaf=75)

* MOSFET (L1 Shichman-Hodges)
M1 drain gate source bulk NMOS_L1 L=1u W=100u
.model NMOS_L1 NMOS(Level=1 Vto=1.0 Kp=50u Lambda=0.01)
```

### Controlled sources (ideal op-amps etc.)

```spice
* Voltage-controlled voltage source (VCVS)
Eopa  out 0    inp_plus inp_minus  1e6    ; V_out = 1e6·(V(inp_plus) - V(inp_minus))
* Voltage-controlled current source (VCCS)
Gx    out 0    inp_plus inp_minus  1m     ; I_out = 1m·ΔV
* Current-controlled voltage source (CCVS): needs a voltage source to sense current
* H1 out 0 V_sense 100
* Current-controlled current source (CCCS): F1 out 0 V_sense 100
```

### Behavioral (B-source) — the mixed-signal key

`B` sources compute a voltage (or current) from an arbitrary expression of node voltages and other quantities:

```spice
B1 out 0 V = 5 * u(V(a) - 2.5)                    ; simple inverter
B2 and 0 V = 5 * u(V(a)-2.5) * u(V(b)-2.5)        ; AND
B3 xor 0 V = 5 * (u(V(a)-2.5) + u(V(b)-2.5) - 2*u(V(a)-2.5)*u(V(b)-2.5))
```

Supported functions include `u(x)` (Heaviside step), `sin`, `cos`, `exp`, `log`, `sqrt`, `abs`, `min`, `max`, `limit(x, lo, hi)`, ternary `a?b:c` — see the ngspice manual for the full list.

**Important gotchas** (documented separately in [gotchas](circuit-emulation-gotchas.md)):

- Use `&&` / `||` for logical (not `&` / `|`, which are bitwise and behave differently in B-sources).
- `u(x-threshold)` is the most portable way to get digital-like behaviour.

### Voltage-controlled switches (stateful)

```spice
S1 out 0 ctrl 0 SMOD
.model SMOD SW(Vt=2.5 Vh=0.833 Ron=100 Roff=1G)
```

`Vt` is the threshold, `Vh` is the hysteresis half-width: switch turns ON when `V(ctrl) > Vt+Vh`, OFF when `V(ctrl) < Vt−Vh`. **Between** the thresholds the switch retains its state. This is the only stateful element we found in the current `eecircuit-engine` build that does not require XSPICE. Essential for building relaxation oscillators / latches behaviorally.

### Analyses

```spice
.op                         ; DC operating point
.tran tstep tstop           ; transient; e.g. .tran 10u 5m
.tran tstep tstop tstart    ; transient with start time
.tran tstep tstop tstart tmax  ; with max step
.ac DEC ppd fstart fstop    ; AC sweep (decade, points-per-decade)
.dc Vsrc vstart vstop vstep ; DC sweep
.noise v(n1,n2) Vsrc DEC ...; noise analysis (not validated here)
```

Every netlist must end with `.end`.

## Result parsing

```javascript
const result = await sim.runSim();
// result.dataType: "real" | "complex"
// result.variableNames: string[]     e.g. ["time", "v(in)", "v(out)"]
// result.data: { name, type, values }[]
```

For `.op`: `numPoints=1`, `values[0]` is the single operating-point value.
For `.tran`: `values` is the time series, and `variableNames[0]` is usually `"time"`.
For `.ac`: `dataType='complex'`, `variableNames[0]` is `"frequency"`, and voltage values are `{real, img}`.

Our wrapper's `dcValue(name)` just returns `vec(name)[0]`; for `.op` that is the operating point.

## Lessons learned (ngspice warnings)

ngspice emits informational and warning messages on stderr. We see them in test output:

```
Note: v1: has no value, DC 0 assumed           ; harmless — you declared V1 with only AC amp
Warning: singular matrix: check node n          ; FIX: add a pull to ground on the floating node
Note: Starting dynamic gmin stepping            ; recovery strategy kicking in
Warning: Dynamic gmin stepping failed           ; still singular
Note: Starting source stepping                  ; last-ditch recovery
Warning: source stepping failed                 ; now we're in trouble
Note: Transient op started                      ; gave up on DC, jumping to t=0
Note: Transient op finished successfully        ; got it eventually
```

The `Warning: singular matrix` path can cost 60+ seconds. Always ensure every node has a DC path to ground — add a `R_pull node 0 1Meg` if necessary (documented in [gotchas](circuit-emulation-gotchas.md)).

## Performance

Benchmark numbers on WSL2 / Node 22 / Core i7-12700:

| Task | Time |
|---|---|
| First-time engine boot | ~400 ms |
| `.op` with 3 passive components | 5–10 ms |
| `.op` with diode | 20–30 ms |
| `.op` with BJT | 50–80 ms |
| `.tran 3m 1u` (10 passive components) | 100–300 ms |
| `.tran 30m 10u` with switches (555-core) | ~400 ms |
| `.tran 40m 0.1m` with 4 diodes (bridge rectifier) | ~300 ms |
| `.ac dec 30 10 1Meg` (RC low-pass) | ~10 ms |

For the sandbox the engine is a singleton, so the 400 ms boot is paid only once per `vitest` process.

## Code example — every analysis in one file

The smoke test is the simplest possible demonstration:

```javascript
import { Simulation } from 'eecircuit-engine';

const sim = new Simulation();
await sim.start();

sim.setNetList(`Voltage divider
V1 vcc 0 DC 9
R1 vcc out 1k
R2 out 0 2k
.op
.end`);
const result = await sim.runSim();

console.log(result.variableNames);   // ["v(vcc)", "v(out)", "i(v1)"]
const idx = result.variableNames.indexOf("v(out)");
console.log(result.data[idx].values[0]);  // 6
```

That is all.

## Code reviewed here

- [`src/spice/SpiceEngine.js`](../../test/test_circuit/src/spice/SpiceEngine.js) — wrapper + helpers.
- [`src/spice/AVRSpiceBridge.js`](../../test/test_circuit/src/spice/AVRSpiceBridge.js) — quasi-static co-sim (see [AVR bridge](circuit-emulation-avr-bridge.md)).
- [`test/ngspice_smoke.test.js`](../../test/test_circuit/test/ngspice_smoke.test.js) — first working simulation.
- [`test/spice_*.test.js`](../../test/test_circuit/test/) — all 22 ngspice-backed tests.
