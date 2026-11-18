import { describe, it, expect, afterEach } from 'vitest';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';

// analogWrite(pin, 0) and analogWrite(pin, 255) do not touch OCR: the Arduino
// core clears the channel's COM bits (the compare unit lets go of the pin) and
// writes the pin as a plain GPIO. Polling OCR alone kept publishing the last
// duty, so the circuit solver held the pin at that average voltage forever.
const EMPTY_HEX = ':00000001FF\n';
const OCR1AL = 0x88;
const TCCR1A = 0x80;
const COM1A1 = 0x80;

describe('AVR PWM duty follows the compare unit, not OCR alone', () => {
  let sim: AVRSimulator;
  afterEach(() => sim.stop());

  function setup() {
    const pm = new PinManager();
    sim = new AVRSimulator(pm, 'uno');
    sim.loadHex(EMPTY_HEX);
    const cpu = (sim as any).cpu as { data: Uint8Array };
    const poll = () => (sim as any).pollPwmRegisters();
    return { pm, cpu, poll };
  }

  it('drops pin 9 to duty 0 when COM1A is cleared, and restores it when set again', () => {
    const { pm, cpu, poll } = setup();
    cpu.data[OCR1AL] = 192;
    cpu.data[TCCR1A] = COM1A1 | 0x01; // analogWrite(9, 192): COM1A1 + WGM10
    poll();
    expect(pm.getPwmValue(9)).toBeCloseTo(192 / 255);

    cpu.data[TCCR1A] = 0x01; // analogWrite(9, 0): COM1A cleared, OCR still 192
    poll();
    expect(pm.getPwmValue(9)).toBe(0);

    cpu.data[TCCR1A] = COM1A1 | 0x01; // analogWrite(9, 192) again, same OCR
    poll();
    expect(pm.getPwmValue(9)).toBeCloseTo(192 / 255);
  });

  it('leaves the other channel of the same timer alone', () => {
    const { pm, cpu, poll } = setup();
    cpu.data[OCR1AL] = 64;
    cpu.data[0x8a] = 128; // OCR1BL, pin 10
    cpu.data[TCCR1A] = 0x20 | 0x01; // COM1B1 only
    poll();
    expect(pm.getPwmValue(9)).toBe(0);
    expect(pm.getPwmValue(10)).toBeCloseTo(128 / 255);
  });
});

// ATTinyCore 1.4.1 (the core the backend installs) implements analogWrite(pin,
// 0) and analogWrite(pin, 255) the same way: digitalWrite -> turnOffPWM clears
// COM0A1 / COM0B1 in TCCR0A, COM1A1 in TCCR1 and COM1B1 in GTCCR, and leaves
// OCR alone. The tiny85 table carried no COM bits, so the last duty stuck
// (velxio/velxio-prod#141). Data-space addresses are the I/O address + 0x20.
const TINY_TCCR0A = 0x4a;
const TINY_OCR0A = 0x49; // OC0A -> PB0
const TINY_OCR0B = 0x48; // OC0B -> PB1
const TINY_TCCR1 = 0x50;
const TINY_OCR1A = 0x4e; // OC1A -> PB1
const TINY_GTCCR = 0x4c;
const TINY_OCR1B = 0x4b; // OC1B -> PB4

describe('ATtiny85 PWM duty follows the compare unit, not OCR alone', () => {
  let sim: AVRSimulator;
  afterEach(() => sim.stop());

  function setup() {
    const pm = new PinManager();
    sim = new AVRSimulator(pm, 'tiny85');
    sim.loadHex(EMPTY_HEX);
    const cpu = (sim as any).cpu as { data: Uint8Array };
    const poll = () => (sim as any).pollPwmRegisters();
    return { pm, cpu, poll };
  }

  it('drops PB0 to duty 0 when COM0A is cleared (analogWrite(0, 0) after 128)', () => {
    const { pm, cpu, poll } = setup();
    cpu.data[TINY_OCR0A] = 128;
    cpu.data[TINY_TCCR0A] = 0x80 | 0x03; // COM0A1 + fast PWM
    poll();
    expect(pm.getPwmValue(0)).toBeCloseTo(128 / 255);

    cpu.data[TINY_TCCR0A] = 0x03; // turnOffPWM(TIMER0A): COM0A1 cleared, OCR0A still 128
    poll();
    expect(pm.getPwmValue(0)).toBe(0);
  });

  it('drops PB4 to duty 0 when COM1B is cleared in GTCCR', () => {
    const { pm, cpu, poll } = setup();
    cpu.data[TINY_OCR1B] = 200;
    cpu.data[TINY_GTCCR] = 0x40 | 0x20; // PWM1B + COM1B1
    poll();
    expect(pm.getPwmValue(4)).toBeCloseTo(200 / 255);

    cpu.data[TINY_GTCCR] = 0x40; // turnOffPWM(TIMER1B): COM1B1 cleared, OCR1B still 200
    poll();
    expect(pm.getPwmValue(4)).toBe(0);
  });

  it('reads PB1 from whichever of OC0B and OC1A is connected', () => {
    const { pm, cpu, poll } = setup();
    // Timer1 set up the way ATTinyCore's init leaves it, OCR1A holding an
    // old value, COM1A disconnected: PB1 belongs to Timer0's channel B.
    cpu.data[TINY_TCCR1] = 0x80 | 0x40 | 0x01; // CTC1 + PWM1A + CS10, no COM1A
    cpu.data[TINY_OCR1A] = 77;
    cpu.data[TINY_OCR0B] = 64;
    cpu.data[TINY_TCCR0A] = 0x20 | 0x03; // COM0B1 + fast PWM
    poll();
    expect(pm.getPwmValue(1)).toBeCloseTo(64 / 255);

    cpu.data[TINY_TCCR0A] = 0x03; // analogWrite(1, 255): COM0B1 cleared
    poll();
    expect(pm.getPwmValue(1)).toBe(0);

    cpu.data[TINY_TCCR1] = 0x80 | 0x40 | 0x20 | 0x01; // the sketch now drives OC1A on PB1
    poll();
    expect(pm.getPwmValue(1)).toBeCloseTo(77 / 255);
  });
});
