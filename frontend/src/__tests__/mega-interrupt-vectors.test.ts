/**
 * The ATmega2560's interrupt vectors, pin by pin.
 *
 * avr8js's port configs carry the ATmega328P's vectors and the Mega used
 * them as they came, so a pin-change interrupt on PORTB vectored to word 6:
 * PCINT0's slot on the 328P, INT2's on the 2560. A SoftwareSerial receiver
 * on pin 10 enabled PCINT0, the first edge from the other board landed in an
 * INT2 the sketch never defined, and avr-libc's __bad_interrupt reset the
 * board on every byte (#397, the Mega's "RReRRReceiver Ready" loop).
 *
 * Each case here enables one interrupt through its registers, raises the
 * edge on the pad, and checks which vector the core enters: the 2560's
 * vectors are 4 bytes, so vector n sits at word 2n (INT0..7 = 1..8,
 * PCINT0..2 = 9..11). The program is a single `rjmp .-2`, so a pc that moved
 * can only be an interrupt entry.
 */
import { describe, expect, it } from 'vitest';
import type { CPU } from 'avr8js';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';

/** `rjmp .-2` at address 0: the core spins there until an interrupt moves it. */
const SPIN_HEX = ':02000000FFCF30\n:00000001FF\n';

const SREG = 0x5f;
const EIFR = 0x3c;
const EIMSK = 0x3d;
const EICRA = 0x69;
const EICRB = 0x6a;
const PCIFR = 0x3b;
const PCICR = 0x68;
const PCMSK0 = 0x6b;
const PCMSK1 = 0x6c;
const PCMSK2 = 0x6d;

function boot(variant: 'uno' | 'mega') {
  const sim = new AVRSimulator(new PinManager(), variant);
  sim.loadHex(SPIN_HEX);
  const cpu = (sim as unknown as { cpu: CPU }).cpu;
  cpu.data[SREG] = 0x80; // global interrupt enable
  return { sim, cpu };
}

/** Raise the pad and run one instruction: the word the core executes next. */
function vectorAfterRisingEdge(sim: AVRSimulator, cpu: CPU, pin: number): number {
  sim.setPinState(pin, true);
  sim.step();
  return cpu.pc;
}

describe('ATmega2560 interrupt vectors', () => {
  it('PCINT0 (PORTB, pin 10) enters vector 9 at word 18, not the 328P word 6', () => {
    const { sim, cpu } = boot('mega');
    cpu.writeData(PCICR, 1 << 0);
    cpu.writeData(PCMSK0, 1 << 4); // PB4 = D10
    expect(vectorAfterRisingEdge(sim, cpu, 10)).toBe(18);
  });

  it('PCINT1 covers PE0 (pin 0) and PJ0 (pin 15), both at word 20', () => {
    for (const pin of [0, 15]) {
      const { sim, cpu } = boot('mega');
      cpu.writeData(PCICR, 1 << 1);
      cpu.writeData(PCMSK1, 0xff);
      expect(vectorAfterRisingEdge(sim, cpu, pin), `pin ${pin}`).toBe(20);
    }
  });

  it('PCINT2 (PORTK, A8 = pin 62) enters word 22', () => {
    const { sim, cpu } = boot('mega');
    cpu.writeData(PCICR, 1 << 2);
    cpu.writeData(PCMSK2, 1 << 0);
    expect(vectorAfterRisingEdge(sim, cpu, 62)).toBe(22);
  });

  it('PORTC and PORTD have no pin-change interrupt on this chip', () => {
    for (const pin of [30, 38]) {
      const { sim, cpu } = boot('mega');
      cpu.writeData(PCICR, 0x07);
      cpu.writeData(PCMSK0, 0xff);
      cpu.writeData(PCMSK1, 0xff);
      cpu.writeData(PCMSK2, 0xff);
      expect(vectorAfterRisingEdge(sim, cpu, pin), `pin ${pin}`).toBe(0);
      expect(cpu.data[PCIFR]).toBe(0);
    }
  });

  it('INT0 on pin 21 (PD0) enters word 2, INT3 on pin 18 (PD3) word 8', () => {
    for (const [pin, n] of [
      [21, 0],
      [18, 3],
    ]) {
      const { sim, cpu } = boot('mega');
      cpu.writeData(EICRA, 0b11 << (n * 2)); // rising edge
      cpu.writeData(EIMSK, 1 << n);
      expect(vectorAfterRisingEdge(sim, cpu, pin), `INT${n}`).toBe(2 + 2 * n);
    }
  });

  it('INT4 on pin 2 and INT5 on pin 3 (PORTE, EICRB) enter words 10 and 12', () => {
    for (const [pin, n] of [
      [2, 4],
      [3, 5],
    ]) {
      const { sim, cpu } = boot('mega');
      cpu.writeData(EICRB, 0b11 << ((n - 4) * 2)); // rising edge
      cpu.writeData(EIMSK, 1 << n);
      expect(vectorAfterRisingEdge(sim, cpu, pin), `INT${n}`).toBe(2 + 2 * n);
    }
  });

  it('an edge on an INT pin whose mask bit is clear raises nothing', () => {
    const { sim, cpu } = boot('mega');
    cpu.writeData(EICRB, 0b11);
    cpu.writeData(EIMSK, 0);
    expect(vectorAfterRisingEdge(sim, cpu, 2)).toBe(0);
    expect(cpu.data[EIFR]).toBe(0);
  });

  it('the 328P keeps PCINT0 at word 6 (Uno pin 10 = PB2)', () => {
    const { sim, cpu } = boot('uno');
    cpu.writeData(PCICR, 1 << 0);
    cpu.writeData(PCMSK0, 1 << 2);
    expect(vectorAfterRisingEdge(sim, cpu, 10)).toBe(6);
  });
});
