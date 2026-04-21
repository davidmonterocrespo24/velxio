# API cheatsheet

```js
import {
  Circuit,
  Resistor, VoltageSource, CurrentSource, Capacitor, Potentiometer, NTCThermistor, Switch,
  Diode, LED, BJT_NPN,
} from '../src/index.js';

const c = new Circuit();
c.addComponent(new VoltageSource('V1', 'vcc', 'gnd', 5));
c.addComponent(new Resistor('R1', 'vcc', 'out', 1000));
c.addComponent(new LED('LED1', 'out', 'gnd', 'red'));

c.solveDC();                    // { nodeVoltages, branchCurrents }
c.nodeVoltage('out');           // 2.0 V
c.branchCurrent('V1');          // −0.0136 A (source convention)

// Transient
c.addComponent(new Capacitor('C1', 'out', 'gnd', 1e-6, 0));
const samples = c.runTransient(/* tEnd */ 0.01, /* dt */ 1e-5, /* sampleEvery */ 10);

// Non-linear helpers
led.currentThrough(c.state);    // A
led.brightness(c.state);        // 0..1 (I/ratedCurrent)

// Parametric components
pot.setWiper(0.75);             // 0..1
ntc.setTemperatureC(25);
switch.set(true);
```

## AVR harness

```js
import { AVRHarness } from '../src/avr/AVRHarness.js';
import { potToPwmProgram, adcReadProgram } from '../src/avr/programs.js';

const avr = new AVRHarness();
avr.load(intelHexText);            // or avr.loadProgram(Uint16Array)

avr.runCycles(16_000_000);         // 1 s of 16 MHz AVR
avr.getPin(13);                    // 0 or 1
avr.onPinChange(13, (s) => { ... });
avr.getPWMDuty(9);                 // 0..1
avr.setAnalogVoltage(0, 2.5);      // inject 2.5 V on A0
avr.getSerialOutput();             // String buffer from USART TX
```

## AVR mini-assembler

```js
import { LDI, OUT, IN, STS, LDS, RJMP, SBRC, SBRS, NOP, assemble } from '../src/avr/asm.js';

const prog = assemble([
  LDI(16, 0xFF),
  OUT(0x04, 16),      // DDRB = 0xFF
  LDI(16, 0x20),
  OUT(0x05, 16),      // PORTB |= pin13
  RJMP(-1),           // loop forever (back to self)
]);
```
