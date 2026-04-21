# AVR Integration & Mixed-Signal Bridge

Location: [`test/test_circuit/src/avr/`](../../test/test_circuit/src/avr/), [`test/test_circuit/src/spice/AVRSpiceBridge.js`](../../test/test_circuit/src/spice/AVRSpiceBridge.js)

## Mirroring Velxio's `AVRSimulator.ts`

The sandbox harness is a deliberately faithful reproduction of what Velxio already does in `frontend/src/simulation/AVRSimulator.ts`:

```typescript
// Velxio (trimmed)
this.cpu = new CPU(programWords, 8192);
this.portB = new AVRIOPort(this.cpu, portBConfig);
this.portC = new AVRIOPort(this.cpu, portCConfig);
this.portD = new AVRIOPort(this.cpu, portDConfig);
this.adc  = new AVRADC(this.cpu, adcConfig);
this.peripherals = [
  new AVRTimer(this.cpu, timer0Config),
  new AVRTimer(this.cpu, timer1Config),
  new AVRTimer(this.cpu, timer2Config),
  new AVRUSART(this.cpu, usart0Config, 16_000_000),
  new AVRSPI(this.cpu, spiConfig, 16_000_000),
  new AVRTWI(this.cpu, twiConfig, 16_000_000),
];

// Execution loop:
avrInstruction(this.cpu);
this.cpu.tick();
```

```javascript
// Sandbox: test/test_circuit/src/avr/AVRHarness.js
this.cpu = new CPU(program, 8192);
this.ports.B = new AVRIOPort(this.cpu, portBConfig);
this.ports.C = new AVRIOPort(this.cpu, portCConfig);
this.ports.D = new AVRIOPort(this.cpu, portDConfig);
this.adc = new AVRADC(this.cpu, adcConfig);
this.timers = [
  new AVRTimer(this.cpu, timer0Config),
  new AVRTimer(this.cpu, timer1Config),
  new AVRTimer(this.cpu, timer2Config),
];
this.usart = new AVRUSART(this.cpu, usart0Config, 16_000_000);

// Execution loop:
avrInstruction(this.cpu);
this.cpu.tick();
```

If it works in the sandbox, it works in Velxio. Confirmed with `fixtures/blink.hex` which is a byte-for-byte copy of `frontend/src/__tests__/fixtures/avr-blink/avr-blink.ino.hex`.

## Intel HEX parser

Velxio uses `utils/hexParser.ts`. The sandbox reimplements the same Intel HEX format from scratch in [`src/avr/intelHex.js`](../../test/test_circuit/src/avr/intelHex.js):

```javascript
export function parseIntelHex(text) {
  const bytes = [];
  let highAddr = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith(':')) continue;
    const byteCount = parseInt(line.slice(1, 3), 16);
    const addr = parseInt(line.slice(3, 7), 16);
    const type = parseInt(line.slice(7, 9), 16);
    if (type === 0) {
      const fullAddr = (highAddr << 16) | addr;
      for (let i = 0; i < byteCount; i++) {
        bytes[fullAddr + i] = parseInt(line.slice(9 + i*2, 11 + i*2), 16);
      }
    } else if (type === 1) break;       // EOF
    else if (type === 4) highAddr = parseInt(line.slice(9, 13), 16);
  }
  return new Uint8Array(bytes);
}

export function bytesToProgramWords(bytes, wordCount = 0x8000 / 2) {
  const prog = new Uint16Array(wordCount);
  for (let i = 0; i < bytes.length; i += 2) {
    prog[i >> 1] = (bytes[i] || 0) | ((bytes[i + 1] || 0) << 8);
  }
  return prog;
}
```

Handles record types:
- `00` — data (the bulk)
- `01` — EOF
- `04` — extended linear address (for programs > 64 KB; not needed for ATmega328P's 32 KB flash but included for future-proofing)

## AVRHarness API

[`src/avr/AVRHarness.js`](../../test/test_circuit/src/avr/AVRHarness.js)

```javascript
const avr = new AVRHarness();

// Load program (two ways)
avr.load(hexText);                       // Intel HEX string
avr.loadProgram(uint16ArrayOfWords);     // pre-assembled

// Execute
avr.runCycles(16_000_000);               // 1 second at 16 MHz

// Read pin state
avr.getPin(13);                          // 0 or 1 (D13 = PORTB bit 5)
avr.getPin(6);                           // D6 = PORTD bit 6
avr.getPin(14);                          // A0 as digital = PORTC bit 0

// Register for pin changes
const unsub = avr.onPinChange(13, (state) => console.log('D13 now', state));

// Inject analog voltage (0..5V) on ADC channel 0..5
avr.setAnalogVoltage(0, 2.5);            // A0 = 2.5V

// Read PWM duty from OCR register (0..1)
avr.getPWMDuty(6);                       // D6 → Timer0A → OCR0A at 0x47
avr.getPWMDuty(9);                       // D9 → Timer1A → OCR1AL at 0x88

// Raw CPU access (for testing / debugging)
avr.cpu.data[0x79];                      // ADCH register
avr.cpu.data[0x88];                      // OCR1AL register
avr.cpu.cycles;                          // total executed cycles

// USART TX (serial output)
avr.getSerialOutput();                   // string of all bytes transmitted so far
```

### Pin-to-port mapping (Arduino Uno convention)

| Arduino pin | Port | Bit | Used for |
|---|---|---|---|
| D0 | PORTD | 0 | RX |
| D1 | PORTD | 1 | TX |
| D2 | PORTD | 2 | Interrupt 0 |
| D3 | PORTD | 3 | Timer2B PWM |
| D4 | PORTD | 4 | |
| D5 | PORTD | 5 | Timer0B PWM |
| D6 | PORTD | 6 | Timer0A PWM |
| D7 | PORTD | 7 | |
| D8 | PORTB | 0 | |
| D9 | PORTB | 1 | Timer1A PWM (16-bit!) |
| D10 | PORTB | 2 | Timer1B PWM |
| D11 | PORTB | 3 | Timer2A PWM |
| D12 | PORTB | 4 | |
| D13 | PORTB | 5 | LED_BUILTIN |
| A0 | PORTC | 0 | ADC ch 0 |
| A1 | PORTC | 1 | ADC ch 1 |
| A2 | PORTC | 2 | ADC ch 2 |
| A3 | PORTC | 3 | ADC ch 3 |
| A4 | PORTC | 4 | ADC ch 4 / SDA |
| A5 | PORTC | 5 | ADC ch 5 / SCL |

### PWM OCR register addresses (ATmega328P)

| Pin | Timer | Register | Address |
|---|---|---|---|
| D3 | Timer2B | OCR2B | 0xB4 |
| D5 | Timer0B | OCR0B | 0x48 |
| D6 | Timer0A | OCR0A | 0x47 |
| D9 | Timer1A | OCR1AL (low byte of 16-bit) | 0x88 |
| D10 | Timer1B | OCR1BL | 0x8A |
| D11 | Timer2A | OCR2A | 0xB3 |

Our harness reads the low byte and divides by 255 to estimate duty. For Timer1 this is valid only when the timer is configured for 8-bit PWM mode (which our `potToPwmProgram` does not use — it uses Timer0 instead via OCR0A).

### ADC register model

`avr8js`'s `AVRADC` exposes `channelValues: number[]` (one slot per channel). Writing a value in **volts** (0..5) injects it; the ADC performs the 10-bit quantization automatically on the next `analogRead()`.

To read the result directly without writing a sketch that stores it to a register, you can also read `cpu.data[0x78]` (ADCL) and `cpu.data[0x79]` (ADCH).

**Right-adjusted (default, ADLAR=0)**:
```
ADCH = 0b000000xx   ; top 2 bits of 10-bit result
ADCL = 0bxxxxxxxx   ; bottom 8 bits
result = (ADCH << 8) | ADCL;
```

**Left-adjusted (ADLAR=1)** — useful if you only want to read ADCH:
```
ADCH = 0bxxxxxxxx   ; top 8 bits
ADCL = 0bxx000000   ; bottom 2 bits
result = (ADCH << 2) | (ADCL >> 6);
```

**Gotcha we hit**: the `potToPwmProgram` sketch initially read only ADCH and wrote it to OCR0A. With ADLAR=0 this only gave the top 2 bits (0..3) — duty was stuck at 0–1 %. Changing ADMUX from `0x40` to `0x60` (enable ADLAR) fixed it.

## Hand-assembled Arduino programs

[`src/avr/asm.js`](../../test/test_circuit/src/avr/asm.js) exposes a mini-assembler covering the opcodes we need.

### Supported opcodes

```javascript
LDI(rd, k)       // Load immediate, rd ∈ [16,31], k ∈ [0,255]
OUT(A, rr)       // Out to I/O, A ∈ [0,63]
IN(rd, A)        // In from I/O
STS(k, rr)       // Store to data space (32-bit instruction)
LDS(rd, k)       // Load from data space (32-bit)
RJMP(offset)     // Relative jump (12-bit signed word offset)
SBRC(rr, b)      // Skip if bit in register clear
SBRS(rr, b)      // Skip if bit in register set
NOP()            // No operation

// Assemble a list (numbers = 1 word, arrays = 2 words)
assemble([ LDI(16, 0x40), OUT(0x0A, 16), RJMP(-1) ])
  → Uint16Array [0xE400, 0xB90A, 0xCFFF]
```

### Encoding reference (ATmega AVR instruction set)

| Opcode | Encoding |
|---|---|
| `LDI Rd, K` | `1110 KKKK dddd KKKK` — `d = Rd − 16` |
| `OUT A, Rr` | `1011 1AAr rrrr AAAA` |
| `IN Rd, A` | `1011 0AAd dddd AAAA` |
| `STS k, Rr` | `1001 001r rrrr 0000` + 16-bit `k` |
| `LDS Rd, k` | `1001 000d dddd 0000` + 16-bit `k` |
| `RJMP k` | `1100 kkkk kkkk kkkk` (signed 12-bit offset from PC+1) |
| `SBRC Rr, b` | `1111 110r rrrr 0bbb` |
| `SBRS Rr, b` | `1111 111r rrrr 0bbb` |
| `NOP` | `0000 0000 0000 0000` |

### The two test programs

#### `potToPwmProgram()`

Equivalent Arduino sketch:
```c
void setup() {
  pinMode(6, OUTPUT);
}
void loop() {
  int v = analogRead(A0);      // 10-bit
  analogWrite(6, v >> 2);       // map to 8-bit PWM on D6
}
```

Actual implementation:
1. Set DDRD bit 6 → pin 6 as output
2. Configure Timer0 for Fast PWM 8-bit, non-inverting on OC0A (D6)
3. ADMUX = 0x60 → AVCC reference, ADLAR=1 (left-adjust), channel 0
4. ADCSRA = 0x87 → ADC enable + prescaler 128 (ADC clock = 125 kHz)
5. Loop:
   - Write ADSC bit to start conversion
   - Busy-wait until ADSC clears
   - Read ADCH (top 8 bits of left-adjusted result)
   - Write to OCR0A (PWM duty)

22 words (44 bytes).

#### `adcReadProgram()`

Simpler variant used by the thermistor test: reads ADC repeatedly and stores the raw bytes into registers `r20` (ADCH) and `r21` (ADCL). The host test then reads them from `cpu.data[r20_addr]` or reconstructs the 10-bit result from `(ADCH << 2) | (ADCL >> 6)`.

## AVRSpiceBridge — the co-simulation layer

[`src/spice/AVRSpiceBridge.js`](../../test/test_circuit/src/spice/AVRSpiceBridge.js)

### Constructor

```javascript
const bridge = new AVRSpiceBridge(avr, {
  sliceMs: 1,                // AVR runs in 1 ms slices between ngspice solves
  analogChannels: [           // which ngspice nodes feed which ADC channels
    { channel: 0, node: 'a0' },
    { channel: 1, node: 'a1' },
  ],
});
```

### Runtime

```javascript
await bridge.run(totalMs, (pinSnapshots, sliceStartMs, sliceEndMs) => {
  // Return a full ngspice netlist string.
  // pinSnapshots[6] = { type: 'pwm', duty: 0.5 }  (only if duty > 0)
  //               or { type: 'digital', v: 0 | 5 }
  return `My circuit
V_PIN6 pin6 0 DC ${pinSnapshots[6].type === 'pwm' ? pinSnapshots[6].duty * 5 : pinSnapshots[6].v}
R1 pin6 out 10k
C1 out 0 1u IC=0
.tran 10u 1m
.end`;
});
```

### Algorithm, step by step

```
for slice in slices:
  # 1. Run the AVR for this slice
  avr.runCycles(16_000_000 * sliceMs / 1000)

  # 2. Snapshot pin states
  snapshot = {}
  for pin in 0..13:
    duty = avr.getPWMDuty(pin)
    if duty is not null and duty > 0:
      snapshot[pin] = { type: 'pwm', duty }
    else:
      snapshot[pin] = { type: 'digital', v: avr.getPin(pin) * 5 }

  # 3. Build netlist
  netlist = buildNetlist(snapshot, t0, t1)

  # 4. Solve it
  result = await runNetlist(netlist)

  # 5. Inject voltages back into ADC channels
  for { channel, node } in analogChannels:
    v = result.vec(f'v({node})')
    v_end = v[-1]                       # last time point
    avr.setAnalogVoltage(channel, v_end)
    adcSamples.push({ t: t1/1000, channel, node, v: v_end })
```

### Design choices

- **Slice-based**: PWM duty and digital levels are treated as constant within one slice. Works because our analog circuits have time constants (RC filters, ADC sample-and-hold) that are an order of magnitude slower than the slice length.
- **PWM → DC-equivalent**: we convert PWM to its duty-averaged DC voltage and hand that to ngspice as a constant source. If you need to study the PWM ripple itself, you would instead emit a `PULSE()` source — at the cost of ngspice having to take sub-microsecond timesteps.
- **Chicken-and-egg at slice 0**: the first slice runs the AVR before ngspice has computed any voltage. The AVR therefore starts with `channelValues[ch] = 0`. By slice 2 the ADC sees the real voltage. In practice, for tests we run several slices to let the system settle; in production UIs this is unnoticeable.

### Limitations

- **Not cycle-accurate**. Tight feedback loops (an analog oscillator whose output drives an MCU interrupt input with microsecond-tight requirements) cannot be expressed.
- **No back-annotation of MCU GPIO from SPICE**. We inject ADC voltages but we don't let an analog node drive a digital input pin with logic-level thresholds. Supported in principle — you'd read the SPICE result and call `avr.ports.X.setPin(bit, value)` — but the harness doesn't expose that today.

### Showcase test

`test/spice_avr_mixed.test.js` runs three co-simulated scenarios:

1. **NTC → ngspice → ADC → sketch**. At 0/25/50 °C, ngspice solves the NTC+pullup divider, we feed the result into `AVRHarness.setAnalogVoltage(0, v)`, run the `adcReadProgram`, and verify the register content matches the expected ADC code within ±2 LSB.
2. **Sketch → PWM → ngspice RC → DC**. The `potToPwmProgram` sketch computes a PWM duty from a simulated pot voltage; the DC-equivalent of the PWM is fed to an RC filter in ngspice; the settled voltage matches `duty × 5 V` within 100 mV.
3. **Full bridge loop — pot wiper move**. The bridge runs 10 slices (5 ms total). Wiper at 0.25 → ADC reads 256. Wiper moves to 0.75 → ADC reads 768. Monotonic, ±5 LSB accuracy.
