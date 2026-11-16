/**
 * The duty a PWM pin hands the circuit follows its timer's mode
 * (velxio/velxio-prod#155).
 *
 * The circuit used OCR/255 for every timer. That is right for the Uno's
 * phase-correct pins (3, 9, 10, 11: OCR/TOP), but Timer0 runs fast PWM (pins
 * 5 and 6, and 4 and 13 on the Mega), where the pin is set at BOTTOM and
 * cleared one tick after the compare match: high for OCR + 1 of TOP + 1
 * ticks (ATmega328P datasheet DS40002061B, section 15.7.3; "fast PWM holds
 * the output high one cycle longer than the compare register value",
 * righto.com, Secrets of Arduino PWM). analogWrite(5, 1) is 2/256, not
 * 1/255. Inverting mode is the complement, and Timers 1, 3, 4 and 5 count to
 * a 16-bit TOP (8, 9 or 10 bits, ICRn or OCRnA) with 16-bit compare values,
 * of which only the low byte was read.
 *
 * The fixture (avr-pwm-fast-phase.ino) runs analogWrite(6, 64),
 * analogWrite(5, 1), analogWrite(9, 64) and analogWrite(10, 1).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';

const HEX = readFileSync(
  fileURLToPath(new URL('./fixtures/avr-pwm-fast-phase/avr-pwm-fast-phase.ino.hex', import.meta.url)),
  'utf-8',
);
const EMPTY_HEX = ':00000001FF\n';

interface Rig {
  sim: AVRSimulator;
  pm: PinManager;
  data: Uint8Array;
  poll: () => void;
}

function rig(hex: string, variant: 'uno' | 'mega' = 'uno'): Rig {
  const pm = new PinManager();
  const sim = new AVRSimulator(pm, variant);
  sim.loadHex(hex);
  const data = (sim as unknown as { cpu: { data: Uint8Array } }).cpu.data;
  const poll = () => (sim as unknown as { pollPwmRegisters(): void }).pollPwmRegisters();
  return { sim, pm, data, poll };
}

describe('AVR PWM duty by timer mode (velxio/velxio-prod#155)', () => {
  it("analogWrite on the Uno: (OCR+1)/256 on Timer0's fast PWM pins, OCR/255 on the phase-correct ones", () => {
    const { sim, pm, poll } = rig(HEX);
    const cpu = (sim as unknown as { cpu: { cycles: number } }).cpu;
    while (cpu.cycles < 2 * 16_000) sim.step();
    poll();
    expect(pm.getPwmValue(6)).toBeCloseTo(65 / 256, 9);
    expect(pm.getPwmValue(5)).toBeCloseTo(2 / 256, 9);
    expect(pm.getPwmValue(9)).toBeCloseTo(64 / 255, 9);
    expect(pm.getPwmValue(10)).toBeCloseTo(1 / 255, 9);
    sim.stop();
  });

  it('fast PWM with OCR at MAX is constantly high', () => {
    const { sim, pm, data, poll } = rig(EMPTY_HEX);
    data[0x44] = 0x80 | 0x03; // TCCR0A: COM0A1, WGM01:0 = 3 (fast PWM, TOP 0xFF)
    data[0x47] = 255; // OCR0A
    poll();
    expect(pm.getPwmValue(6)).toBe(1);
    sim.stop();
  });

  it('inverting fast PWM is the complement', () => {
    const { sim, pm, data, poll } = rig(EMPTY_HEX);
    data[0x44] = 0xc0 | 0x03; // COM0A1:0 = 3 (set on match, clear at BOTTOM)
    data[0x47] = 63;
    poll();
    expect(pm.getPwmValue(6)).toBeCloseTo(1 - 64 / 256, 9);
    sim.stop();
  });

  it('Timer1 fast PWM with ICR1 as TOP reads the 16-bit OCR1A and ICR1', () => {
    // Mode 14 (WGM13:0 = 1110): 50.05 % at OCR1A = 1000, ICR1 = 1999.
    const { sim, pm, data, poll } = rig(EMPTY_HEX);
    data[0x80] = 0x80 | 0x02; // TCCR1A: COM1A1, WGM11
    data[0x81] = 0x18 | 0x01; // TCCR1B: WGM13, WGM12, CS10
    data[0x86] = 1999 & 0xff; // ICR1L
    data[0x87] = 1999 >> 8; // ICR1H
    data[0x88] = 1000 & 0xff; // OCR1AL
    data[0x89] = 1000 >> 8; // OCR1AH
    poll();
    expect(pm.getPwmValue(9)).toBeCloseTo(1001 / 2000, 9);
    sim.stop();
  });

  it('Timer1 phase-correct 10-bit: OCR1A/1023', () => {
    const { sim, pm, data, poll } = rig(EMPTY_HEX);
    data[0x80] = 0x80 | 0x03; // COM1A1, WGM11:10 = 3 (phase correct, TOP 0x3FF)
    data[0x81] = 0x01;
    data[0x88] = 512 & 0xff;
    data[0x89] = 512 >> 8;
    poll();
    expect(pm.getPwmValue(9)).toBeCloseTo(512 / 1023, 9);
    sim.stop();
  });

  it("the Mega's Timer0 pins (13 and 4) are fast PWM too", () => {
    const { sim, pm, data, poll } = rig(EMPTY_HEX, 'mega');
    data[0x44] = 0x80 | 0x20 | 0x03; // COM0A1, COM0B1, fast PWM
    data[0x47] = 127; // OCR0A -> D13
    data[0x48] = 0; // OCR0B -> D4: a one-tick spike
    poll();
    expect(pm.getPwmValue(13)).toBeCloseTo(128 / 256, 9);
    expect(pm.getPwmValue(4)).toBeCloseTo(1 / 256, 9);
    sim.stop();
  });
});
