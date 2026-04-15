# API Reference

All public APIs exported from the sandbox.

## `src/index.js` — hand-rolled MNA pipeline

```javascript
import {
  Circuit, GROUND, Vt,
  Resistor, VoltageSource, CurrentSource, Capacitor, Potentiometer, NTCThermistor, Switch,
  Diode, LED, BJT_NPN,
} from '../src/index.js';
```

### `class Circuit`

```javascript
const c = new Circuit();

c.addComponent(component)         // chainable
c.removeComponent(name)
c.getComponent(name)              // → component | undefined
c.solveDC({ maxIter = 100, tol = 1e-7, dt })  // run DC or transient step
c.stepTransient(dt)               // saves prev, solves with dt
c.runTransient(tEnd, dt, sampleEvery = 1) // returns [{ t, nodeVoltages, branchCurrents }, …]
c.nodeVoltage(name)               // shorthand
c.branchCurrent(name)             // only for voltage sources
c.reset()

c.state                           // { nodeVoltages, branchCurrents, prev, converged }
c.nodes                           // Map<nodeName, index>
c.time                            // current transient time
```

### Components — constructor signatures

```javascript
new Resistor(name, a, b, resistance)
new VoltageSource(name, plus, minus, voltage)
  .setVoltage(v)                  // dynamic change
new CurrentSource(name, from, to, current)
new Capacitor(name, a, b, capacitance, initialV = 0)
new Potentiometer(name, top, wiper, bottom, totalR, wiperPos = 0.5)
  .setWiper(pos)                  // pos ∈ [0, 1]
new NTCThermistor(name, a, b, { R0 = 10000, T0 = 298.15, beta = 3950 })
  .setTemperatureC(c)
  .resistance()                   // → Ω
new Switch(name, a, b, closed = false)
  .set(state)

new Diode(name, anode, cathode, { Is = 1e-14, n = 1.0, Vclamp = 40 })
  .currentThrough(circuitState)   // → A
new LED(name, anode, cathode, color = 'red')
  .brightness(circuitState)       // → 0..1
new BJT_NPN(name, collector, base, emitter, { Is = 1e-15, betaF = 100, betaR = 1 })
```

### Constants

- `GROUND` — the string `'gnd'`
- `Vt` — thermal voltage `0.02585` (T=300 K)
- `GMIN` — `1e-12` (stabilization conductance)

## `src/avr/AVRHarness.js`

```javascript
import { AVRHarness } from '../src/avr/AVRHarness.js';

const avr = new AVRHarness();

avr.load(hexText)                          // parse Intel HEX, create CPU
avr.loadProgram(uint16Words)               // pre-assembled program

avr.runCycles(n)                           // advance CPU

avr.getPin(arduinoPinNumber)               // 0 | 1
avr.onPinChange(pin, cb)                   // returns unsubscribe fn
avr.setAnalogVoltage(channel, volts)       // channel 0..5 (A0..A5)
avr.getPWMDuty(pin)                        // 0..1 | null
avr.getSerialOutput()                      // accumulated USART TX bytes as string

avr.cpu                                    // raw avr8js CPU instance
avr.cpu.data[addr]                         // direct register / SRAM access
avr.cpu.cycles                             // total executed cycles
avr.ports.B | ports.C | ports.D            // AVRIOPort instances
avr.adc                                    // AVRADC
avr.timers                                 // AVRTimer[] (3 timers)
avr.usart                                  // AVRUSART
```

## `src/avr/asm.js` — mini assembler

```javascript
import { LDI, OUT, IN, STS, LDS, RJMP, SBRC, SBRS, NOP, assemble } from '../src/avr/asm.js';

LDI(rd, k)                // number (1 word)
OUT(A, rr)                // number
IN(rd, A)                 // number
STS(k, rr)                // [w1, w2] — 2 words
LDS(rd, k)                // [w1, w2]
RJMP(offset)              // number, offset in words from PC+1, signed 12-bit
SBRC(rr, b)               // number
SBRS(rr, b)               // number
NOP()                     // 0x0000

const prog = assemble([
  LDI(16, 0xFF),
  OUT(0x04, 16),
  LDI(16, 0x20),
  OUT(0x05, 16),
  RJMP(-1),
]);
// → Uint16Array
```

## `src/avr/intelHex.js`

```javascript
import { parseIntelHex, bytesToProgramWords } from '../src/avr/intelHex.js';

parseIntelHex(text)                        // → Uint8Array
bytesToProgramWords(bytes, wordCount)      // → Uint16Array (little-endian)
```

## `src/avr/programs.js`

```javascript
import { potToPwmProgram, adcReadProgram } from '../src/avr/programs.js';

potToPwmProgram()          // → Uint16Array — reads A0, writes to OCR0A (pin 6 PWM)
adcReadProgram()           // → Uint16Array — reads A0, stores ADCH→r20, ADCL→r21
```

## `src/spice/SpiceEngine.js`

```javascript
import { getEngine, runNetlist, NL } from '../src/spice/SpiceEngine.js';

await getEngine()                          // → eecircuit-engine Simulation instance

const result = await runNetlist(netlistText);
// result: {
//   raw: ResultType,
//   vec(name): number[] or { real, img }[],
//   dcValue(name): number,
//   vAtLast(name): number or { real, img },
//   findVar(name): number,
//   variableNames: string[],
// }

NL.pulse(name, plus, minus, v1, v2, td, tr, tf, pw, per)  // → string (SPICE card)
NL.sin(name, plus, minus, offset, amp, freq)              // → string
NL.pwl(name, plus, minus, [[t0,v0],[t1,v1],...])         // → string
```

## `src/spice/AVRSpiceBridge.js`

```javascript
import { AVRSpiceBridge } from '../src/spice/AVRSpiceBridge.js';

const bridge = new AVRSpiceBridge(avrHarness, {
  sliceMs: 1,
  analogChannels: [ { channel: 0, node: 'a0' }, ... ],
});

const timeline = await bridge.run(totalMs, (pinSnapshots, t0, t1) => {
  // return a full SPICE netlist string
  // pinSnapshots[pinNumber] = { type: 'digital', v: 0 | 5 } | { type: 'pwm', duty }
});

bridge.adcSamples                          // [{ t, channel, node, v }]
```

## Raw avr8js re-exports (via dependency)

The AVRHarness imports these for use. They are not re-exported from our API but are available via `import from 'avr8js'`:

```typescript
// From avr8js
CPU, AVRIOPort, AVRTimer, AVRADC, AVRUSART, AVRSPI, AVRTWI,
portAConfig, portBConfig, ..., portLConfig,
timer0Config, timer1Config, timer2Config,
adcConfig, usart0Config, spiConfig, twiConfig,
avrInstruction, ATtinyTimer1, attinyTimer1Config
```

## Raw eecircuit-engine API

The SpiceEngine wrapper ultimately calls these. For direct use:

```typescript
import { Simulation, ResultType } from 'eecircuit-engine';

const sim = new Simulation();
await sim.start();
sim.setNetList(netlist);
const result: ResultType = await sim.runSim();

// If something goes wrong
sim.getError()     // string[]
sim.getInfo()      // string
sim.getInitInfo()  // string
sim.isInitialized()// boolean
```

## Patterns / idioms

### Pattern: solve-once DC query

```javascript
const c = new Circuit();
c.addComponent(new VoltageSource('V1', 'a', 'gnd', 5));
c.addComponent(new Resistor('R1', 'a', 'gnd', 1000));
c.solveDC();
console.log(c.nodeVoltage('a'));            // 5
console.log(c.branchCurrent('V1'));         // -5/1000 (source supplies this much current)
```

### Pattern: parameter sweep

```javascript
for (const T of [0, 25, 50]) {
  ntc.setTemperatureC(T);
  c.solveDC();
  console.log(`@${T}C: ${c.nodeVoltage('a0').toFixed(3)} V`);
}
```

### Pattern: transient trace

```javascript
const samples = c.runTransient(/*tEnd*/ 0.01, /*dt*/ 1e-5, /*sampleEvery*/ 10);
for (const s of samples) console.log(s.t, s.nodeVoltages.out);
```

### Pattern: ngspice AC Bode data

```javascript
const { vec } = await runNetlist(`
V1 in 0 AC 1
R1 in out 1k
C1 out 0 1u
.ac dec 20 10 1Meg
.end`);
const freq = vec('frequency').map(c => c.real ?? c);
const vout = vec('v(out)');
const mag_dB = vout.map(c => 20 * Math.log10(Math.hypot(c.real, c.img)));
const phase_deg = vout.map(c => Math.atan2(c.img, c.real) * 180 / Math.PI);
```

### Pattern: AVR drives analog, ngspice solves, AVR reads back

```javascript
const avr = new AVRHarness();
avr.load(hexText);

const bridge = new AVRSpiceBridge(avr, {
  sliceMs: 1,
  analogChannels: [{ channel: 0, node: 'a0' }],
});

await bridge.run(10, (pins) => {
  const duty = pins[9]?.type === 'pwm' ? pins[9].duty : 0;
  return `Circuit
V_PIN9 pin9 0 DC ${duty * 5}
R1 pin9 out 10k
C1 out 0 1u IC=0
R_load out 0 10Meg
Vpot pot_top 0 DC 5
R_pot_top pot_top a0 5k
R_pot_bot a0 0 5k
.tran 10u 1m
.end`;
});
```
