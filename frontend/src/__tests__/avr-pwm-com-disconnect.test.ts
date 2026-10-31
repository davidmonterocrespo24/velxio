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
