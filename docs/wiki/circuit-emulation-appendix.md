# Appendix — Netlists, Opcodes, Model Parameters, Glossary

## A. Reference netlists (one per analysis type)

### A.1 `.op` — DC operating point

```spice
Voltage divider DC op-point
V1 vcc 0 DC 9
R1 vcc out 1k
R2 out 0 2k
.op
.end
```

### A.2 `.tran` — transient analysis

```spice
RC charging
V1 vcc 0 PULSE(0 5 0 1n 1n 10 20)
R1 vcc out 10k
C1 out 0 100u IC=0
.ic v(out)=0
.tran 10m 3
.end
```

### A.3 `.ac` — AC small-signal sweep

```spice
RC low-pass AC sweep
V1 in 0 AC 1
R1 in out 1k
C1 out 0 159.155n
.ac dec 20 10 1Meg
.end
```

### A.4 `.dc` — DC sweep

```spice
Diode I-V curve
V1 a 0 DC 0
D1 a 0 DMOD
.model DMOD D(Is=1e-14 N=1)
.dc V1 0 1 0.01
.end
```

### A.5 Behavioral logic gates (B-source)

```spice
NAND gate
Va a 0 DC 5
Vb b 0 DC 5
Bnand y 0 V = 5 * (1 - u(V(a)-2.5) * u(V(b)-2.5))
Rload y 0 1k
.op
.end
```

### A.6 Schmitt-switch relaxation oscillator (simplified 555)

```spice
Relaxation oscillator
Vcc vcc 0 DC 5
R1 vcc cap 10k
Ccap cap 0 10n IC=0
Sdis cap 0 cap 0 SMOD
.model SMOD SW(Vt=2.5 Vh=0.833 Ron=100 Roff=1G)
Sbuf out vcc cap 0 SOUT
.model SOUT SW(Vt=2.5 Vh=0.833 Ron=10 Roff=1G)
Rpd out 0 100k
.tran 0.5u 2m
.end
```

### A.7 Bridge rectifier with sine source

```spice
Full-wave bridge rectifier
V1 a b SIN(0 6 50)
D1 a p DMOD
D2 b p DMOD
D3 n a DMOD
D4 n b DMOD
R1 p n 1k
.model DMOD D(Is=1e-14 N=1)
.tran 0.1m 40m
.end
```

### A.8 Common-emitter BJT amplifier

```spice
Common-emitter with 2N2222
Vcc vcc 0 DC 12
Vin in 0 SIN(0 0.01 1k)
Cin in b 1u
RB1 vcc b 47k
RB2 b 0 10k
RC vcc c 4.7k
RE e 0 1k
CE e 0 100u
Q1 c b e Q2N2222
Cout c out 1u
Rout out 0 100k
.model Q2N2222 NPN(Is=1e-14 Bf=200 Vaf=75)
.tran 10u 6m
.end
```

### A.9 Ideal op-amp (VCVS) as inverting amplifier

```spice
Op-amp inverting amplifier, gain -10
Vin in 0 DC 0.2
Rin in n 1k
Rf n out 10k
Eopa out 0 0 n 1e6
.op
.end
```

### A.10 N-MOSFET switch

```spice
N-MOS switch
Vcc vcc 0 DC 5
Vgate gate 0 DC 5
RL vcc drain 1k
M1 drain gate 0 0 NMOS_L1 L=1u W=100u
.model NMOS_L1 NMOS(Level=1 Vto=1.0 Kp=50u Lambda=0.01)
.op
.end
```

## B. AVR opcode encodings (the ones we use)

| Instruction | Encoding (bits 15..0) | Bytes | Notes |
|---|---|---|---|
| `LDI Rd, K` | `1110 KKKK dddd KKKK` | 2 | `d = Rd − 16`, `Rd ∈ [16..31]` |
| `OUT A, Rr` | `1011 1AAr rrrr AAAA` | 2 | `A ∈ [0..63]` (I/O space) |
| `IN Rd, A` | `1011 0AAd dddd AAAA` | 2 | |
| `STS k, Rr` | `1001 001r rrrr 0000`  + `kkkkkkkk kkkkkkkk` | 4 | 32-bit instruction, `k` is 16-bit address |
| `LDS Rd, k` | `1001 000d dddd 0000`  + `kkkkkkkk kkkkkkkk` | 4 | 32-bit |
| `RJMP k` | `1100 kkkk kkkk kkkk` | 2 | signed 12-bit word offset from PC+1 |
| `SBRC Rr, b` | `1111 110r rrrr 0bbb` | 2 | skip if bit clear |
| `SBRS Rr, b` | `1111 111r rrrr 0bbb` | 2 | skip if bit set |
| `NOP` | `0000 0000 0000 0000` | 2 | |
| `CALL k` | `1001 010k kkkk 111k` + `kkkkkkkk kkkkkkkk` | 4 | not used here |
| `RET` | `1001 0101 0000 1000` | 2 | not used here |

## C. ATmega328P register addresses (used in our programs)

| Register | I/O addr | SRAM addr | Purpose |
|---|---|---|---|
| DDRB | 0x04 | 0x24 | Port B data direction |
| PORTB | 0x05 | 0x25 | Port B output |
| PINB | 0x03 | 0x23 | Port B input |
| DDRC | 0x07 | 0x27 | Port C data direction |
| PORTC | 0x08 | 0x28 | Port C output |
| DDRD | 0x0A | 0x2A | Port D data direction |
| PORTD | 0x0B | 0x2B | Port D output |
| TCCR0A | 0x24 | 0x44 | Timer0 control A |
| TCCR0B | 0x25 | 0x45 | Timer0 control B |
| TCNT0 | 0x26 | 0x46 | Timer0 counter |
| OCR0A | 0x27 | 0x47 | Timer0 compare A (PWM D6) |
| OCR0B | 0x28 | 0x48 | Timer0 compare B (PWM D5) |
| OCR2A | — | 0xB3 | Timer2 compare A (PWM D11) |
| OCR2B | — | 0xB4 | Timer2 compare B (PWM D3) |
| TCCR1A | — | 0x80 | Timer1 control A |
| TCCR1B | — | 0x81 | Timer1 control B |
| OCR1AL | — | 0x88 | Timer1A compare low (PWM D9) |
| OCR1AH | — | 0x89 | Timer1A compare high |
| OCR1BL | — | 0x8A | Timer1B compare low (PWM D10) |
| ADCL | — | 0x78 | ADC result low byte |
| ADCH | — | 0x79 | ADC result high byte |
| ADCSRA | — | 0x7A | ADC control and status A |
| ADMUX | — | 0x7C | ADC multiplexer |

Registers above 0x5F can only be accessed via `STS` / `LDS` (32-bit instructions), not `OUT` / `IN`.

## D. ADMUX / ADCSRA bit fields

### ADMUX (0x7C)

| Bit | Name | Purpose |
|---|---|---|
| 7 | REFS1 | Voltage reference selection bit 1 |
| 6 | REFS0 | Voltage reference selection bit 0 — `01` = AVCC with cap at AREF |
| 5 | ADLAR | ADC Left Adjust Result — `0` = right, `1` = left |
| 4 | — | reserved |
| 3..0 | MUX3..0 | Channel select — `0000` = ADC0 (A0), `0001` = A1, … |

Common values:
- `0x40` = AVCC ref, right-adjusted, A0
- `0x60` = AVCC ref, **left-adjusted**, A0 (we use this!)
- `0xC0` = Internal 1.1V ref, right-adjusted, A0

### ADCSRA (0x7A)

| Bit | Name | Purpose |
|---|---|---|
| 7 | ADEN | ADC Enable |
| 6 | ADSC | ADC Start Conversion — write 1 to start; auto-clears when done |
| 5 | ADATE | Auto Trigger Enable |
| 4 | ADIF | ADC Interrupt Flag |
| 3 | ADIE | ADC Interrupt Enable |
| 2..0 | ADPS2..0 | Prescaler Select — `111` = /128 (= 125 kHz ADC clock at 16 MHz) |

Common values:
- `0x87` = ADEN + prescaler /128 (initial setup)
- `0xC7` = ADEN + **ADSC** + /128 (start conversion)

### Conversion timing

- First conversion: 25 ADC clock cycles
- Subsequent: 13 ADC clock cycles
- At 125 kHz ADC clock: first ≈ 200 µs, subsequent ≈ 104 µs

## E. TCCR0A / TCCR0B bit fields

### TCCR0A (0x24, I/O)

| Bit | Purpose |
|---|---|
| 7 | COM0A1 — 1 for non-inverting PWM on OC0A |
| 6 | COM0A0 |
| 5 | COM0B1 |
| 4 | COM0B0 |
| 3..2 | — |
| 1 | WGM01 — Waveform Generation Mode bit 1 |
| 0 | WGM00 — bit 0 |

### TCCR0B (0x25, I/O)

| Bit | Purpose |
|---|---|
| 7 | FOC0A / FOC0B — force compare |
| 5..4 | — |
| 3 | WGM02 |
| 2..0 | CS02..0 — clock source |

**Mode 3: Fast PWM 8-bit** — `WGM02:0 = 011`. Counter counts 0..255, TOP = 0xFF.

Settings we use (for the `potToPwmProgram`):
- `TCCR0A = 0x83` = COM0A1=1 + WGM01=1 + WGM00=1 → non-inverting Fast PWM on D6
- `TCCR0B = 0x01` = CS00=1 → no prescaler (16 MHz counter → 62.5 kHz PWM frequency)

## F. LED model parameters (tuned for typical datasheet Vf @ 10 mA)

```javascript
const LED_PARAMS = {
  red:    { Is: 1e-20, n: 1.7, ratedCurrent: 0.020 },   // V_f ≈ 2.0 V
  green:  { Is: 1e-22, n: 1.9, ratedCurrent: 0.020 },   // V_f ≈ 2.2 V
  yellow: { Is: 1e-21, n: 1.8, ratedCurrent: 0.020 },   // V_f ≈ 2.1 V
  blue:   { Is: 1e-28, n: 2.0, ratedCurrent: 0.020 },   // V_f ≈ 3.1 V
  white:  { Is: 1e-28, n: 2.0, ratedCurrent: 0.020 },
};
```

Shockley: `I = Is · (exp(V / (n · Vt)) − 1)`, with `Vt = 0.02585 V` at 300 K.

To tune another color: pick a datasheet point `(V_f, I)` and solve for `Is`:

```
Is = I · exp(−V / (n · Vt))
```

## G. NTC β-model

```javascript
R(T) = R0 · exp(β · (1/T − 1/T0))  // T in Kelvin
```

Common 10 kΩ NTC (β=3950, T₀=25 °C = 298.15 K):

| T (°C) | T (K) | R (kΩ) | V_A0 @ 10k pullup to 5V |
|---|---|---|---|
| −20 | 253.15 | 95.4 | 4.52 V |
| 0 | 273.15 | 33.6 | 3.85 V |
| 25 | 298.15 | 10.0 | 2.50 V |
| 50 | 323.15 | 3.59 | 1.32 V |
| 100 | 373.15 | 0.68 | 0.32 V |

Inverse (recovering T from measured R):

```
T = 1 / (1/T0 + (1/β) · ln(R / R0))
```

This is what `e2e_thermistor.test.js` does to convert ADC readings back to Celsius.

## H. Glossary

- **MNA (Modified Nodal Analysis)** — SPICE's core algorithm. Unknowns are node voltages plus branch currents of voltage sources.
- **Companion model** — linearization of a reactive element (C, L) into an equivalent resistor + source at each timestep.
- **Backward Euler** — simple first-order implicit integration, unconditionally stable but damps high-frequency content.
- **Trapezoidal integration** — second-order, SPICE's default; more accurate but can ring.
- **Newton-Raphson** — iterative method for non-linear equations. Converges quadratically near a solution.
- **`pnjlim`** — SPICE's internal voltage limiter for PN junctions; prevents `exp()` overflow on early iterations.
- **GMIN** — minimum conductance added to every node; prevents singular matrices.
- **Shockley equation** — `I = Is · (exp(V/(nVt)) − 1)`. Governs ideal pn junctions.
- **Ebers-Moll** — simplified BJT model; predecessor to the more accurate Gummel-Poon.
- **Schmitt trigger** — a comparator with hysteresis; outputs digital clean levels from noisy analog inputs.
- **XSPICE** — ngspice extension that adds digital primitives (AND, OR, FF, etc.) as first-class elements. Not compiled into the current `eecircuit-engine` WASM.
- **B-source** — ngspice behavioral voltage/current source: `B1 n+ n- V = expression`.
- **S-element** — ngspice voltage-controlled switch with optional hysteresis.
- **VCVS/VCCS/CCVS/CCCS** — voltage-controlled-voltage / voltage-controlled-current / current-controlled-voltage / current-controlled-current sources; implement ideal op-amps, gain blocks, etc.
- **PWL** — piecewise-linear source, `PWL(t0 v0 t1 v1 …)`. Useful for arbitrary-shape stimuli.
- **Intel HEX** — ASCII file format for program memory, used by Arduino, avr-objcopy, etc.
- **PORTB / PORTC / PORTD** — 8-bit I/O registers on ATmega328P. Drive the Arduino pin sets.
- **ADLAR** — ADC Left Adjust Result. When set, the 10-bit ADC result is aligned so that ADCH has the top 8 bits.
- **OCR** — Output Compare Register. Compared against a timer counter to drive PWM.
- **Quasi-static co-simulation** — digital and analog engines advance independently on a coarse time grid, not cycle-locked.

## I. Useful external references

- ngspice manual — <https://ngspice.sourceforge.io/docs.html>
- `eecircuit-engine` on GitHub — <https://github.com/eelab-dev/EEcircuit-engine>
- EEcircuit online — <https://eecircuit.com/>
- AVR instruction set manual — <https://www.microchip.com/content/dam/mchp/documents/OTH/ProductDocuments/DataSheets/AVR-Instruction-Set-Manual.pdf>
- ATmega328P datasheet — <https://www.microchip.com/en-us/product/atmega328p>
- `avr8js` on GitHub — <https://github.com/wokwi/avr8js>
- Wokwi elements — <https://github.com/wokwi/wokwi-elements>
- SPICE model library (Linear Technology) — <https://www.analog.com/en/design-center/design-tools-and-calculators/ltspice-simulator.html>
- Gummel-Poon BJT model explanation — standard SPICE references
