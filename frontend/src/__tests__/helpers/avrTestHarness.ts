/**
 * Minimal AVR harness for Phase 8.1 ngspice co-simulation tests.
 *
 * Mirrors what test/test_circuit/src/avr/AVRHarness.js does and what
 * Velxio's main AVRSimulator does, but in a test-scoped form that does
 * not require requestAnimationFrame mocking. Use only from tests.
 *
 * For Phase 8.3+ co-sim wiring (inside the running Velxio app), we'll
 * reuse the production AVRSimulator and add a SPICE bridge around it.
 */
import {
  CPU,
  AVRIOPort,
  AVRTimer,
  AVRADC,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  adcConfig,
  avrInstruction,
} from 'avr8js';

const PWM_PINS: Array<{ ocrAddr: number; pin: number }> = [
  { ocrAddr: 0x47, pin: 6 },
  { ocrAddr: 0x48, pin: 5 },
  { ocrAddr: 0x88, pin: 9 },
  { ocrAddr: 0x8a, pin: 10 },
  { ocrAddr: 0xb3, pin: 11 },
  { ocrAddr: 0xb4, pin: 3 },
];

export class AVRTestHarness {
  cpu!: CPU;
  ports!: { B: AVRIOPort; C: AVRIOPort; D: AVRIOPort };
  adc!: AVRADC;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private timers: any[] = [];

  loadProgram(words: Uint16Array): void {
    const program = new Uint16Array(0x8000 / 2);
    program.set(words);
    this.cpu = new CPU(program, 8192);
    this.ports = {
      B: new AVRIOPort(this.cpu, portBConfig),
      C: new AVRIOPort(this.cpu, portCConfig),
      D: new AVRIOPort(this.cpu, portDConfig),
    };
    this.adc = new AVRADC(this.cpu, adcConfig);
    this.timers = [
      new AVRTimer(this.cpu, timer0Config),
      new AVRTimer(this.cpu, timer1Config),
      new AVRTimer(this.cpu, timer2Config),
    ];
  }

  runCycles(n: number): void {
    const end = this.cpu.cycles + n;
    while (this.cpu.cycles < end) {
      avrInstruction(this.cpu);
      this.cpu.tick();
    }
  }

  setAnalogVoltage(channel: number, volts: number): void {
    this.adc.channelValues[channel] = Math.max(0, Math.min(5, volts));
  }

  /** Returns PWM duty (0..1) by reading the OCR register; null if pin isn't PWM. */
  getPWMDuty(pin: number): number | null {
    const entry = PWM_PINS.find((p) => p.pin === pin);
    if (!entry) return null;
    return this.cpu.data[entry.ocrAddr] / 255;
  }

  /** Read a raw register (ADCL/ADCH/etc.). */
  reg(addr: number): number {
    return this.cpu.data[addr];
  }
}

// ── Mini AVR assembler (opcodes needed by the test programs) ───────────────

/** LDI Rd, K — Rd ∈ [16..31], K ∈ [0..255] */
export const LDI = (rd: number, k: number): number => {
  const d = rd - 16;
  return 0xe000 | ((k & 0xf0) << 4) | (d << 4) | (k & 0x0f);
};

/** OUT A, Rr — A ∈ [0..63], Rr ∈ [0..31] */
export const OUT = (A: number, rr: number): number => {
  return 0xb800 | ((A & 0x30) << 5) | (rr << 4) | (A & 0x0f);
};

/** STS k, Rr — 32-bit instruction */
export const STS = (k: number, rr: number): [number, number] => {
  const w1 = 0x9200 | ((rr & 0x10) << 4) | ((rr & 0x0f) << 4);
  return [w1, k & 0xffff];
};

/** LDS Rd, k — 32-bit instruction */
export const LDS = (rd: number, k: number): [number, number] => {
  const w1 = 0x9000 | ((rd & 0x10) << 4) | ((rd & 0x0f) << 4);
  return [w1, k & 0xffff];
};

/** RJMP k — 12-bit signed offset from PC+1 */
export const RJMP = (offset: number): number => {
  return 0xc000 | (offset & 0xfff);
};

/** SBRC Rr, b — skip if bit clear */
export const SBRC = (rr: number, b: number): number => {
  return 0xfc00 | (rr << 4) | (b & 0x07);
};

/** Assemble a list: numbers are 1 word, arrays are multi-word. */
export function assemble(items: Array<number | number[]>): Uint16Array {
  const flat: number[] = [];
  for (const it of items) {
    if (Array.isArray(it)) flat.push(...it);
    else flat.push(it);
  }
  return Uint16Array.from(flat);
}

// ── Test programs ──────────────────────────────────────────────────────────

/**
 * Pot → PWM program.
 *   setup: Timer0 Fast PWM 8-bit on D6 (OC0A), ADC ch 0, ADLAR=1
 *   loop:  trigger ADC, wait, write ADCH to OCR0A
 */
export function potToPwmProgram(): Uint16Array {
  return assemble([
    LDI(16, 0x40),
    OUT(0x0a, 16), // DDRD bit 6 → pin 6 output
    LDI(16, 0x83),
    OUT(0x24, 16), // TCCR0A = Fast PWM + COM0A1
    LDI(16, 0x01),
    OUT(0x25, 16), // TCCR0B = CS00 (no prescaler)
    LDI(16, 0x60),
    STS(0x7c, 16), // ADMUX = AVCC + ADLAR + ch 0
    LDI(16, 0x87),
    STS(0x7a, 16), // ADCSRA = enable + /128
    LDI(17, 0xc7),
    STS(0x7a, 17), // start conversion
    LDS(17, 0x7a), // read ADCSRA
    SBRC(17, 6),
    RJMP(-4),
    LDS(17, 0x79), // ADCH → r17
    OUT(0x27, 17), // OCR0A ← r17
    RJMP(-11),
  ]);
}

/**
 * ADC read program — reads ADCH → r20, ADCL → r21 in a tight loop.
 * Host reads ADCL (0x78) and ADCH (0x79) directly after running.
 */
export function adcReadProgram(): Uint16Array {
  return assemble([
    LDI(16, 0x60),
    STS(0x7c, 16), // ADMUX = AVCC + ADLAR + ch 0
    LDI(16, 0x87),
    STS(0x7a, 16), // ADCSRA = enable + /128
    LDI(17, 0xc7),
    STS(0x7a, 17), // start conversion
    LDS(17, 0x7a),
    SBRC(17, 6),
    RJMP(-4),
    LDS(20, 0x79), // ADCH → r20
    LDS(21, 0x78), // ADCL → r21
    RJMP(-12),
  ]);
}
