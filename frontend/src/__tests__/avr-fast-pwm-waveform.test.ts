/**
 * The waveform of a fast PWM pin is the chip's (velxio/velxio-prod#155).
 *
 * "Whenever TCNT0 equals OCR0A or OCR0B, the comparator signals a match. A
 * match will set the Output Compare Flag (OCF0A or OCF0B) at the next timer
 * clock cycle" (ATmega328P datasheet DS40002061B, section 15.5), and the pin
 * changes with the flag. In fast PWM the pin is set at BOTTOM and cleared as
 * TCNT leaves OCR: HIGH for OCR + 1 of TOP + 1 ticks, a one-tick spike at
 * OCR = BOTTOM and a constant HIGH at OCR = MAX (section 15.7.3). avr8js acted
 * on the match when TCNT reached OCR, one tick early, so the scope drew
 * analogWrite(6, 64) as 256 us of 1024 instead of 260 us, OCR0A = 0 as a
 * constant HIGH and OCR0B = 255 as dropping for 4 us every period. Its fast
 * PWM never set channel C at BOTTOM either: OC3C and OC5C on the Mega stayed
 * LOW. The circuit's average already followed (OCR + 1)/(TOP + 1) since
 * release 8 (avr-pwm-duty-by-mode.test.ts).
 *
 * Every sketch here was compiled by the compile service (arduino:avr 1.8.8,
 * ATTinyCore 1.4.1); its source sits next to its hex. The waveform is read
 * where the scope reads it (onPinChangeWithTime), and through the pin's other
 * consumers: the PIN register the CPU reads, the PinManager level and the
 * sketch's own pulseIn().
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';

const hex = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`./fixtures/avr-fast-pwm-waveform/${name}.ino.hex`, import.meta.url)),
    'utf-8',
  );

/** Edges come out between instructions: up to four cycles after the tick. */
const JITTER_US = 0.25;
/** Past the core's init() and the sketch's setup(). */
const SETTLED_US = 5_000;

interface Edge {
  us: number;
  high: boolean;
}

interface Run {
  sim: AVRSimulator;
  pm: PinManager;
  cpu: { cycles: number; data: Uint8Array };
  edges: Map<number, Edge[]>;
  serial: () => string;
  runTo: (us: number) => void;
}

function boot(name: string, variant: 'uno' | 'mega' | 'tiny85', pins: number[]): Run {
  const pm = new PinManager();
  const sim = new AVRSimulator(pm, variant);
  sim.loadHex(hex(name));
  const edges = new Map<number, Edge[]>(pins.map((p) => [p, []]));
  sim.onPinChangeWithTime = (pin, high, ms) => edges.get(pin)?.push({ us: ms * 1000, high });
  let serial = '';
  sim.onSerialData = (c) => (serial += c);
  const cpu = (sim as unknown as { cpu: Run['cpu'] }).cpu;
  const runTo = (us: number) => {
    while (cpu.cycles < us * 16) sim.step();
  };
  return { sim, pm, cpu, edges, serial: () => serial, runTo };
}

interface Wave {
  periods: number[];
  highs: number[];
  /** Two edges of the pin at the same instant: a pulse of no width. */
  zeroWidth: number;
  /** Edges after SETTLED_US. */
  count: number;
}

/** Every full period after SETTLED_US, from a rising edge to the next. */
function wave(edges: Edge[]): Wave {
  const settled = edges.filter((e) => e.us >= SETTLED_US);
  const rises = settled.filter((e) => e.high).map((e) => e.us);
  const periods: number[] = [];
  const highs: number[] = [];
  for (let i = 0; i + 1 < rises.length; i++) {
    periods.push(rises[i + 1] - rises[i]);
    const fall = settled.find((e) => !e.high && e.us >= rises[i] && e.us <= rises[i + 1]);
    highs.push(fall ? fall.us - rises[i] : NaN);
  }
  const zeroWidth = settled.filter((e, i) => i > 0 && e.us === settled[i - 1].us).length;
  return { periods, highs, zeroWidth, count: settled.length };
}

/** The duty the circuit takes for a PWM pin (pwmDuty, release 8), read now. */
function circuitDuty(run: Run, pin: number): number {
  (run.sim as unknown as { pollPwmRegisters(): void }).pollPwmRegisters();
  return run.pm.getPwmValue(pin);
}

/**
 * A pin's steady PWM: every period and every HIGH time as given, and the
 * circuit's average the same share of the period as the scope's waveform.
 */
function expectWave(
  run: Run,
  pin: number,
  periodUs: number,
  highUs: number,
  { circuit = true }: { circuit?: boolean } = {},
): void {
  const w = wave(run.edges.get(pin)!);
  expect(w.periods.length, `pin ${pin}: periods seen`).toBeGreaterThanOrEqual(5);
  expect(w.zeroWidth, `pin ${pin}: pulses of no width`).toBe(0);
  for (const p of w.periods) {
    expect(Math.abs(p - periodUs), `pin ${pin}: period ${p} us`).toBeLessThanOrEqual(JITTER_US);
  }
  for (const h of w.highs) {
    expect(Math.abs(h - highUs), `pin ${pin}: HIGH for ${h} us`).toBeLessThanOrEqual(JITTER_US);
  }
  if (circuit) {
    const duty = circuitDuty(run, pin);
    expect(duty, `pin ${pin}: the circuit's duty`).toBeCloseTo(highUs / periodUs, 9);
  }
}

/** A pin held HIGH: no edge once settled, HIGH, and a duty of 1 for the circuit. */
function expectConstantHigh(run: Run, pin: number): void {
  const w = wave(run.edges.get(pin)!);
  expect(w.count, `pin ${pin}: edges once settled`).toBe(0);
  expect(run.pm.getPinState(pin), `pin ${pin}: level`).toBe(true);
  expect(circuitDuty(run, pin), `pin ${pin}: the circuit's duty`).toBe(1);
}

describe('fast PWM waveform as the chip makes it (velxio/velxio-prod#155)', () => {
  it('analogWrite(6, 64) and analogWrite(5, 1): 260 us and 8 us of 1024 us', () => {
    const run = boot('uno-timer0-analogwrite', 'uno', [6, 5]);
    run.runTo(20_000);
    expectWave(run, 6, 1024, 260);
    expectWave(run, 5, 1024, 8);
    run.sim.stop();
  });

  it('the CPU and the board see pin 6 HIGH 258 us after it rose, and pulseIn() measures 260 us', () => {
    const run = boot('uno-timer0-analogwrite', 'uno', [6, 5]);
    run.runTo(SETTLED_US);
    const rises = () => run.edges.get(6)!.filter((e) => e.high && e.us >= SETTLED_US);
    while (rises().length === 0) run.sim.step();
    run.runTo(rises()[0].us + 258);
    const PIND = 0x29;
    expect((run.cpu.data[PIND] >> 6) & 1, 'PIND6 at +258 us').toBe(1);
    expect(run.pm.getPinState(6), 'PinManager level at +258 us').toBe(true);
    run.runTo(rises()[0].us + 262);
    expect((run.cpu.data[PIND] >> 6) & 1, 'PIND6 at +262 us').toBe(0);

    // The sketch's own pulseIn(6, HIGH), pulseIn(6, LOW) and pulseIn(5, HIGH).
    run.runTo(60_000);
    const lines = run.serial().trim().split(/\r?\n/);
    expect(lines.length).toBe(3);
    for (const line of lines) {
      const [high6, low6, high5] = line.split(' ').map(Number);
      expect(Math.abs(high6 - 260), `pulseIn(6, HIGH) = ${high6}`).toBeLessThanOrEqual(2);
      expect(Math.abs(low6 - 764), `pulseIn(6, LOW) = ${low6}`).toBeLessThanOrEqual(2);
      expect(Math.abs(high5 - 8), `pulseIn(5, HIGH) = ${high5}`).toBeLessThanOrEqual(2);
    }
    run.sim.stop();
  });

  it('OCR0A = 0 is a one-tick spike and OCR0B = 255 a constant HIGH', () => {
    const run = boot('uno-timer0-registers', 'uno', [6, 5]);
    run.runTo(20_000);
    expectWave(run, 6, 1024, 4);
    expectConstantHigh(run, 5);
    run.sim.stop();
  });

  it('inverting fast PWM is LOW for OCR0A + 1 ticks: 764 us HIGH of 1024 at OCR0A = 64', () => {
    const run = boot('uno-timer0-inverting', 'uno', [6]);
    run.runTo(20_000);
    expectWave(run, 6, 1024, 764);
    run.sim.stop();
  });

  it('the compare A interrupt of fast PWM runs with TCNT0 = OCR0A + 1', () => {
    const run = boot('uno-timer0-compa-isr', 'uno', []);
    run.runTo(150_000);
    const m = /tcnt=(\d+) hits=(\d+)/.exec(run.serial());
    expect(m, run.serial()).not.toBeNull();
    expect(Number(m![1])).toBe(0xaf + 1);
    // One per 1024 us period: about 98 by millis() = 100.
    expect(Math.abs(Number(m![2]) - 98)).toBeLessThanOrEqual(1);
    run.sim.stop();
  });

  it('Timer2 fast PWM (TOP 0xFF) and Timer1 fast PWM with ICR1 as TOP, spikes included', () => {
    const run = boot('uno-timer1-timer2-fast', 'uno', [11, 3, 9, 10]);
    run.runTo(20_000);
    expectWave(run, 11, 1024, 260);
    expectWave(run, 3, 1024, 4);
    expectWave(run, 9, 1000, 500);
    expectWave(run, 10, 1000, 0.5);
    run.sim.stop();
  });

  it('Timer2 fast PWM with OCR2A as TOP (and its toggle) and Timer1 8-bit fast PWM', () => {
    const run = boot('uno-timer1-timer2-fast-tops', 'uno', [11, 3, 9]);
    run.runTo(20_000);
    expectWave(run, 3, 400, 100);
    expectWave(run, 11, 800, 400);
    expectWave(run, 9, 1024, 260);
    run.sim.stop();
  });

  it("the Mega's Timer0 pins (13, 4), and Timer3 and Timer5 on every channel, C included", () => {
    const run = boot('mega-fast-pwm', 'mega', [13, 4, 5, 2, 3, 44]);
    run.runTo(20_000);
    expectWave(run, 13, 1024, 260);
    expectWave(run, 4, 1024, 8);
    expectWave(run, 5, 1000, 500);
    expectWave(run, 2, 1000, 250);
    expectWave(run, 3, 1000, 750);
    expectWave(run, 44, 1000, 50);
    run.sim.stop();
  });

  it("the ATtiny85's Timer0 (PB0, PB1) under ATTinyCore's analogWrite", () => {
    const run = boot('tiny85-timer0-analogwrite', 'tiny85', [0, 1]);
    run.runTo(20_000);
    expectWave(run, 0, 1024, 260, { circuit: false });
    expectWave(run, 1, 1024, 8, { circuit: false });
    run.sim.stop();
  });

  it('millis(), tone() and the phase-correct pins keep their timing', () => {
    const run = boot('uno-timers-unchanged', 'uno', [12, 8, 9, 10]);
    run.runTo(1_000_000);
    // millis() counts 1.024 ms overflows: a 100 ms step lasts 99.3 to 100.4 ms.
    const toggles = run.edges.get(12)!.map((e) => e.us);
    expect(toggles.length).toBe(9);
    for (let i = 1; i < toggles.length; i++) {
      const dt = toggles[i] - toggles[i - 1];
      expect(dt, `millis() step ${dt} us`).toBeGreaterThanOrEqual(98_900);
      expect(dt, `millis() step ${dt} us`).toBeLessThanOrEqual(101_100);
    }
    // tone() toggles pin 8 from its compare ISR: 1000 us, give or take its latency.
    const tone = wave(run.edges.get(8)!);
    for (const p of tone.periods) expect(Math.abs(p - 1000)).toBeLessThanOrEqual(1);
    // Phase correct: 64/255 and 1/255 of 510 ticks of 4 us.
    expectWave(run, 9, 2040, 512);
    expectWave(run, 10, 2040, 8);
    run.sim.stop();
  });

  it('Servo (Timer1, normal mode) keeps its 1500 us pulse', () => {
    const run = boot('uno-servo', 'uno', [9]);
    run.runTo(200_000);
    const w = wave(run.edges.get(9)!);
    expect(w.highs.length).toBeGreaterThanOrEqual(3);
    for (const h of w.highs) expect(Math.abs(h - 1500)).toBeLessThanOrEqual(1);
    for (const p of w.periods) expect(Math.abs(p - 20_000)).toBeLessThanOrEqual(10);
    run.sim.stop();
  });
});
