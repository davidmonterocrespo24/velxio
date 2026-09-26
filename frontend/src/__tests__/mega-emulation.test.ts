/**
 * mega-emulation.test.ts
 *
 * Unit tests for the Arduino Mega 2560 (ATmega2560) emulator:
 *   - Simulator initialises with 11 Mega ports (PORTA–PORTL minus I)
 *   - Program memory is 131 072 words (256 KB flash)
 *   - PORTB bit 7 → pin 13 (LED_BUILTIN on Mega)
 *   - PORTB bit 0 → pin 53 (SS)
 *   - PORTA bit 0 → pin 22
 *   - PORTA all bits → pins 22–29
 *   - setPinState() works for Mega pins
 *   - PWM pins differ from Uno (OCR0A → pin 13 on Mega, not pin 6)
 *
 * The previous end-to-end block compiled and ran the now-deprecated
 * mega-blink-test example.  That section retired with the example
 * itself; cross-board / multi-protocol Mega coverage lives in the
 * dual-Arduino multi-protocol and Wire E2E suites instead.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';

// ─── RAF stubs ────────────────────────────────────────────────────────────────

vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => 1);
vi.stubGlobal('cancelAnimationFrame', vi.fn());

// ─── Minimal Intel HEX payloads ───────────────────────────────────────────────
//
// MEGA_PORTB_HEX — PORTB test: sets pin 13 HIGH (PORTB bit 7 = 0x80 on Mega)
//   LDI r16, 0xFF   ; 0F EF  — all outputs
//   OUT DDRB, r16   ; 04 B9  — DDRB (I/O 0x04)
//   LDI r16, 0x80   ; 00 E8  — bit 7 = pin 13 on Mega
//   OUT PORTB, r16  ; 05 B9  — PORTB (I/O 0x05)
//   RJMP .-2        ; FF CF  — loop
//
const MEGA_PORTB_HEX = ':0A0000000FEF04B900E805B9FFCFC7\n' + ':00000001FF\n';

// MEGA_PORTB_PIN53_HEX — sets pin 53 HIGH (PORTB bit 0 = 0x01 on Mega)
//   LDI r16, 0xFF   ; 0F EF
//   OUT DDRB, r16   ; 04 B9
//   LDI r16, 0x01   ; 01 E0  — bit 0 = pin 53 on Mega
//   OUT PORTB, r16  ; 05 B9
//   RJMP .-2        ; FF CF
//
const MEGA_PORTB_PIN53_HEX = ':0A0000000FEF04B901E005B9FFCFC6\n' + ':00000001FF\n';

// MEGA_PORTA_HEX — PORTA test: sets all pins 22–29 HIGH (all bits of PORTA)
//   LDI r16, 0xFF   ; 0F EF
//   OUT DDRA, r16   ; 01 B9  — DDRA (I/O 0x01)
//   OUT PORTA, r16  ; 02 B9  — PORTA (I/O 0x02)
//   RJMP .-2        ; FF CF
//
const MEGA_PORTA_HEX = ':080000000FEF01B902B9FFCFB7\n' + ':00000001FF\n';

// MEGA_PORTA_PIN22_HEX — sets only pin 22 HIGH (PORTA bit 0 = 0x01)
//   LDI r16, 0xFF   ; 0F EF
//   OUT DDRA, r16   ; 01 B9
//   LDI r16, 0x01   ; 01 E0  — bit 0 = pin 22
//   OUT PORTA, r16  ; 02 B9
//   RJMP .-2        ; FF CF
//
const MEGA_PORTA_PIN22_HEX = ':0A0000000FEF01B901E002B9FFCFD4\n' + ':00000001FF\n';

// Empty HEX — minimal valid file, no-op program
const EMPTY_HEX = ':00000001FF\n';

// ─── Helper ───────────────────────────────────────────────────────────────────

function runCycles(sim: AVRSimulator, cycles: number): void {
  for (let i = 0; i < cycles; i++) sim.step();
}

// ─── Unit tests ───────────────────────────────────────────────────────────────

describe('AVRSimulator Mega — initialisation', () => {
  let pm: PinManager;
  let sim: AVRSimulator;

  beforeEach(() => {
    pm = new PinManager();
    sim = new AVRSimulator(pm, 'mega');
  });
  afterEach(() => sim.stop());

  it('creates in idle state', () => {
    expect(sim).toBeDefined();
    expect(sim.isRunning()).toBe(false);
  });

  it('loadHex does not throw', () => {
    expect(() => sim.loadHex(EMPTY_HEX)).not.toThrow();
  });

  it('program memory is 131 072 words (256 KB) for Mega', () => {
    sim.loadHex(EMPTY_HEX);
    const prog = (sim as any).program as Uint16Array;
    expect(prog.length).toBe(131_072);
  });

  it('11 Mega ports are initialised (PORTA through PORTL, no PORTI)', () => {
    sim.loadHex(EMPTY_HEX);
    const ports = (sim as any).megaPorts as Map<string, unknown>;
    expect(ports).toBeDefined();
    expect(ports.size).toBe(11);
    const expected = [
      'PORTA',
      'PORTB',
      'PORTC',
      'PORTD',
      'PORTE',
      'PORTF',
      'PORTG',
      'PORTH',
      'PORTJ',
      'PORTK',
      'PORTL',
    ];
    for (const name of expected) {
      expect(ports.has(name)).toBe(true);
    }
  });
});

// ─── Unit tests — PORTB ───────────────────────────────────────────────────────

describe('AVRSimulator Mega — PORTB pin mapping', () => {
  it('pin 13 (PORTB bit 7) fires HIGH when 0x80 is written to PORTB', () => {
    const pm = new PinManager();
    const sim = new AVRSimulator(pm, 'mega');
    sim.loadHex(MEGA_PORTB_HEX);

    const changes: boolean[] = [];
    pm.onPinChange(13, (_pin, state) => changes.push(state));

    // Execute: LDI → OUT DDRB → LDI → OUT PORTB
    runCycles(sim, 20);

    expect(changes).toContain(true);
    expect(pm.getPinState(13)).toBe(true);
    sim.stop();
  });

  it('pin 53 (PORTB bit 0) fires HIGH when 0x01 is written to PORTB', () => {
    const pm = new PinManager();
    const sim = new AVRSimulator(pm, 'mega');
    sim.loadHex(MEGA_PORTB_PIN53_HEX);

    const changes: boolean[] = [];
    pm.onPinChange(53, (_pin, state) => changes.push(state));

    runCycles(sim, 20);

    expect(changes).toContain(true);
    expect(pm.getPinState(53)).toBe(true);
    sim.stop();
  });

  it('pin 12 (PORTB bit 6) does NOT fire when only bit 7 is set', () => {
    const pm = new PinManager();
    const sim = new AVRSimulator(pm, 'mega');
    sim.loadHex(MEGA_PORTB_HEX); // sets only bit 7 (pin 13)

    const pin12Changes: boolean[] = [];
    pm.onPinChange(12, (_pin, state) => pin12Changes.push(state));

    runCycles(sim, 20);

    // pin 12 should NOT have been set HIGH
    expect(pin12Changes).not.toContain(true);
    sim.stop();
  });
});

// ─── Unit tests — PORTA ───────────────────────────────────────────────────────

describe('AVRSimulator Mega — PORTA pin mapping (pins 22–29)', () => {
  it('all PORTA pins (22–29) fire HIGH when 0xFF is written to PORTA', () => {
    const pm = new PinManager();
    const sim = new AVRSimulator(pm, 'mega');
    sim.loadHex(MEGA_PORTA_HEX);

    const fired = new Set<number>();
    for (let pin = 22; pin <= 29; pin++) {
      pm.onPinChange(pin, (p, state) => {
        if (state) fired.add(p);
      });
    }

    runCycles(sim, 20);

    for (let pin = 22; pin <= 29; pin++) {
      expect(fired.has(pin)).toBe(true);
      expect(pm.getPinState(pin)).toBe(true);
    }
    sim.stop();
  });

  it('only pin 22 (PORTA bit 0) fires when 0x01 is written to PORTA', () => {
    const pm = new PinManager();
    const sim = new AVRSimulator(pm, 'mega');
    sim.loadHex(MEGA_PORTA_PIN22_HEX);

    const firedHigh = new Set<number>();
    for (let pin = 22; pin <= 29; pin++) {
      pm.onPinChange(pin, (p, state) => {
        if (state) firedHigh.add(p);
      });
    }

    runCycles(sim, 20);

    expect(firedHigh.has(22)).toBe(true);
    // Pins 23–29 must NOT be HIGH
    for (let pin = 23; pin <= 29; pin++) {
      expect(firedHigh.has(pin)).toBe(false);
    }
    sim.stop();
  });
});

// ─── Unit tests — setPinState ─────────────────────────────────────────────────

describe('AVRSimulator Mega — setPinState (Mega pins)', () => {
  it('setPinState does not throw for various Mega pins', () => {
    const pm = new PinManager();
    const sim = new AVRSimulator(pm, 'mega');
    sim.loadHex(EMPTY_HEX);

    // Pins from different Mega ports
    const megaPins = [
      22,
      29, // PORTA
      53,
      13, // PORTB
      37,
      30, // PORTC
      21,
      38, // PORTD
      0,
      1,
      5, // PORTE
      54,
      61, // PORTF (A0, A7)
      41,
      4, // PORTG
      6,
      9, // PORTH
      15,
      14, // PORTJ
      62,
      69, // PORTK (A8, A15)
      42,
      49, // PORTL
    ];

    for (const pin of megaPins) {
      expect(() => sim.setPinState(pin, true)).not.toThrow();
      expect(() => sim.setPinState(pin, false)).not.toThrow();
    }
    sim.stop();
  });
});

// ─── Unit tests — PWM ─────────────────────────────────────────────────────────

describe('AVRSimulator Mega — PWM OCR mapping differs from Uno', () => {
  it('OCR0A (addr 0x47) maps to pin 13 on Mega (not pin 6 as on Uno)', () => {
    const pm = new PinManager();
    const sim = new AVRSimulator(pm, 'mega');
    sim.loadHex(EMPTY_HEX);

    const cb = vi.fn();
    pm.onPwmChange(13, cb); // Mega: OCR0A → D13

    const cpu = (sim as any).cpu;
    cpu.data[0x47] = 128;

    // Call pollPwmRegisters directly — avoids RAF dependency in unit tests
    (sim as any).pollPwmRegisters();

    expect(cb).toHaveBeenCalledWith(13, 128 / 255);
    sim.stop();
  });

  it('OCR3AL (addr 0x98) maps to pin 5 on Mega', () => {
    const pm = new PinManager();
    const sim = new AVRSimulator(pm, 'mega');
    sim.loadHex(EMPTY_HEX);

    const cb = vi.fn();
    pm.onPwmChange(5, cb);

    const cpu = (sim as any).cpu;
    cpu.data[0x98] = 200;

    (sim as any).pollPwmRegisters();

    expect(cb).toHaveBeenCalledWith(5, 200 / 255);
    sim.stop();
  });

  it('OCR4AL (addr 0xA8) maps to pin 6 on Mega', () => {
    const pm = new PinManager();
    const sim = new AVRSimulator(pm, 'mega');
    sim.loadHex(EMPTY_HEX);

    const cb = vi.fn();
    pm.onPwmChange(6, cb);

    const cpu = (sim as any).cpu;
    cpu.data[0xa8] = 100;

    (sim as any).pollPwmRegisters();

    expect(cb).toHaveBeenCalledWith(6, 100 / 255);
    sim.stop();
  });
});
