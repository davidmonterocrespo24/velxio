/**
 * mega-timer-output.test.ts
 *
 * Hardware compare-output (OCnx) coverage for the ATmega2560.
 *
 * avr8js ships ATmega328P timer configs whose compare-output pins point at
 * the Uno mapping (OC1A = PB1, OC1B = PB2, OC0A = PD6 …). The Mega routes the
 * same channels to different port pins, and it has three extra 16-bit timers
 * (Timer3/4/5) that avr8js has no stock config for. These tests pin down the
 * Mega mapping by driving the timers in CTC + toggle-on-compare mode and
 * watching the Arduino pin that should carry the square wave.
 *
 * Frequencies: OCRnA = 799 with CS = /1 toggles every 800 cycles,
 * i.e. 16 MHz / (2 * 800) = 10 kHz — the classic "clock out on a pin" sketch.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';

const EMPTY_HEX = ':00000001FF\n';

/** Toggle period in CPU cycles for OCRnA = TOGGLE_TOP. */
const TOGGLE_TOP = 799;
const TOGGLE_PERIOD = TOGGLE_TOP + 1;

type TimerRegs = {
  /** DDR register that must be set for the OCnx pin to drive the pad. */
  ddr: number;
  /** Bit index of the OCnx pin inside its port. */
  ddrBit: number;
  tccrA: number;
  tccrB: number;
  /** Low byte of OCRnA — the TOP register in WGM_2 (CTC). */
  ocrALow: number;
  /** Low byte of the channel's own OCRnx (equals ocrALow for channel A). */
  ocrLow: number;
  /** COM bit that selects "toggle on compare match" for this channel. */
  comBit: number;
};

function makeSim(): { pm: PinManager; sim: AVRSimulator } {
  const pm = new PinManager();
  const sim = new AVRSimulator(pm, 'mega');
  sim.loadHex(EMPTY_HEX);
  return { pm, sim };
}

function write(sim: AVRSimulator, addr: number, value: number): void {
  (sim as unknown as { cpu: { writeData(a: number, v: number): void } }).cpu.writeData(addr, value);
}

/** Configure a 16-bit timer for CTC (WGM_2) + toggle on compare, /1 prescaler. */
function startCtcToggle(sim: AVRSimulator, regs: TimerRegs): void {
  write(sim, regs.ddr, 1 << regs.ddrBit);
  write(sim, regs.tccrA, 1 << regs.comBit);
  // 16-bit registers latch the high byte first. OCRnA is TOP in CTC, so it is
  // always written; a B/C channel matches at the same value (what a sketch
  // does with `OCR1B = OCR1A`).
  write(sim, regs.ocrALow + 1, (TOGGLE_TOP >> 8) & 0xff);
  write(sim, regs.ocrALow, TOGGLE_TOP & 0xff);
  if (regs.ocrLow !== regs.ocrALow) {
    write(sim, regs.ocrLow + 1, (TOGGLE_TOP >> 8) & 0xff);
    write(sim, regs.ocrLow, TOGGLE_TOP & 0xff);
  }
  write(sim, regs.tccrB, (1 << 3) | (1 << 0)); // WGM12 | CS10
}

function countToggles(pm: PinManager, sim: AVRSimulator, pin: number, cycles: number): number {
  let toggles = 0;
  pm.onPinChange(pin, () => toggles++);
  for (let i = 0; i < cycles; i++) sim.step();
  return toggles;
}

// PORTB = 0x25 / DDRB = 0x24, PORTE / DDRE = 0x2d, PORTL / DDRL = 0x10a.
const TIMER1_OC1A: TimerRegs = {
  ddr: 0x24,
  ddrBit: 5, // OC1A = PB5 = D11
  tccrA: 0x80,
  tccrB: 0x81,
  ocrALow: 0x88,
  ocrLow: 0x88,
  comBit: 6, // COM1A0
};

const TIMER1_OC1B: TimerRegs = {
  ddr: 0x24,
  ddrBit: 6, // OC1B = PB6 = D12
  tccrA: 0x80,
  tccrB: 0x81,
  ocrALow: 0x88,
  ocrLow: 0x8a,
  comBit: 4, // COM1B0
};

const TIMER3_OC3A: TimerRegs = {
  ddr: 0x2d,
  ddrBit: 3, // OC3A = PE3 = D5
  tccrA: 0x90,
  tccrB: 0x91,
  ocrALow: 0x98,
  ocrLow: 0x98,
  comBit: 6, // COM3A0
};

const TIMER5_OC5A: TimerRegs = {
  ddr: 0x10a,
  ddrBit: 3, // OC5A = PL3 = D46
  tccrA: 0x120,
  tccrB: 0x121,
  ocrALow: 0x128,
  ocrLow: 0x128,
  comBit: 6, // COM5A0
};

describe('AVRSimulator Mega — Timer1 compare output pins', () => {
  let sim: AVRSimulator | null = null;
  afterEach(() => {
    sim?.stop();
    sim = null;
  });

  it('OC1A toggles D11 (PB5) at the CTC rate, not D9 (Uno mapping)', () => {
    const h = makeSim();
    sim = h.sim;
    startCtcToggle(h.sim, TIMER1_OC1A);

    const toggles = countToggles(h.pm, h.sim, 11, TOGGLE_PERIOD * 10);

    // 10 compare matches in 10 periods; allow one for the boundary.
    expect(toggles).toBeGreaterThanOrEqual(9);
  });

  it('OC1A does NOT drive D52 (PB1 — the ATmega328P OC1A pin)', () => {
    const h = makeSim();
    sim = h.sim;
    startCtcToggle(h.sim, TIMER1_OC1A);

    const toggles = countToggles(h.pm, h.sim, 52, TOGGLE_PERIOD * 10);

    expect(toggles).toBe(0);
  });

  it('OC1B toggles D12 (PB6)', () => {
    const h = makeSim();
    sim = h.sim;
    startCtcToggle(h.sim, TIMER1_OC1B);

    const toggles = countToggles(h.pm, h.sim, 12, TOGGLE_PERIOD * 10);

    expect(toggles).toBeGreaterThanOrEqual(9);
  });
});

describe('AVRSimulator Mega — Timer3/4/5 exist and drive their pins', () => {
  let sim: AVRSimulator | null = null;
  afterEach(() => {
    sim?.stop();
    sim = null;
  });

  it('registers six AVR timers (Timer0–Timer5)', () => {
    const h = makeSim();
    sim = h.sim;
    const peripherals = (h.sim as unknown as { peripherals: object[] }).peripherals;
    const timers = peripherals.filter((p) => p.constructor.name === 'AVRTimer');
    expect(timers.length).toBe(6);
  });

  it('OC3A toggles D5 (PE3)', () => {
    const h = makeSim();
    sim = h.sim;
    startCtcToggle(h.sim, TIMER3_OC3A);

    const toggles = countToggles(h.pm, h.sim, 5, TOGGLE_PERIOD * 10);

    expect(toggles).toBeGreaterThanOrEqual(9);
  });

  it('OC5A toggles D46 (PL3) — extended I/O registers', () => {
    const h = makeSim();
    sim = h.sim;
    startCtcToggle(h.sim, TIMER5_OC5A);

    const toggles = countToggles(h.pm, h.sim, 46, TOGGLE_PERIOD * 10);

    expect(toggles).toBeGreaterThanOrEqual(9);
  });
});
