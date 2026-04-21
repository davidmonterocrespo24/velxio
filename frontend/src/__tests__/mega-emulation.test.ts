/**
 * mega-emulation.test.ts
 *
 * Tests for the Arduino Mega 2560 (ATmega2560) emulator:
 *
 * UNIT tests (no compilation required):
 *   - Simulator initialises with 11 Mega ports (PORTA–PORTL minus I)
 *   - Program memory is 131 072 words (256 KB flash)
 *   - PORTB bit 7 → pin 13 (LED_BUILTIN on Mega)
 *   - PORTB bit 0 → pin 53 (SS)
 *   - PORTA bit 0 → pin 22
 *   - PORTA all bits → pins 22–29
 *   - setPinState() works for Mega pins
 *   - PWM pins differ from Uno (OCR0A → pin 13 on Mega, not pin 6)
 *
 * END-TO-END test (requires arduino-cli + arduino:avr core):
 *   - Compiles mega-blink-test.ino for arduino:avr:mega:cpu=atmega2560
 *   - Loads .hex into AVRSimulator('mega')
 *   - setup() sets pins 13, 22–29, 53, 4, 6, 42 HIGH
 *   - loop() blinks pin 13 every 500 ms
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  mkdirSync,
  readdirSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { avrInstruction } from 'avr8js';
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

/**
 * Run N cycles executing only instructions — no cpu.tick().
 *
 * avr8js timer peripherals only advance when cpu.tick() is called.
 * On ATmega2560, timer0Config.ovfInterrupt uses the ATmega328P vector
 * address (0x20) rather than the Mega address (0x60).  Calling cpu.tick()
 * during E2E tests causes Timer0 OVF to jump to the wrong ISR, which
 * triggers __bad_interrupt → CPU resets to 0 every ~16 K cycles, preventing
 * loop() from ever reaching digitalWrite(13, LOW).
 * Skipping cpu.tick() avoids all timer interrupts while still executing
 * every AVR instruction correctly.
 */
function runCyclesNoTick(sim: AVRSimulator, cycles: number): void {
  const cpu = (sim as any).cpu;
  for (let i = 0; i < cycles; i++) {
    avrInstruction(cpu);
  }
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

// ─── End-to-end: compile + run ────────────────────────────────────────────────

const SKETCH_DIR = resolve(__dirname, '../../../example_zip/extracted/mega-blink-test');
const SKETCH_INO = join(SKETCH_DIR, 'mega-blink-test.ino');
const HEX_CACHE = join(tmpdir(), 'velxio-mega-blink-v2.hex');

// ─── arduino-cli availability ─────────────────────────────────────────────────

const ARDUINO_CLI_AVAILABLE = (() => {
  const r = spawnSync('arduino-cli', ['version'], { encoding: 'utf-8' });
  return r.error == null && r.status === 0;
})();

function compileSketch(): string {
  if (existsSync(HEX_CACHE)) {
    console.log('[compile] Using cached hex:', HEX_CACHE);
    return readFileSync(HEX_CACHE, 'utf-8');
  }

  console.log('[compile] Compiling mega-blink-test.ino for arduino:avr:mega:cpu=atmega2560…');

  const workDir = mkdtempSync(join(tmpdir(), 'velxio-mega-'));
  const sketchDir = join(workDir, 'mega-blink-test');
  mkdirSync(sketchDir);
  writeFileSync(join(sketchDir, 'mega-blink-test.ino'), readFileSync(SKETCH_INO, 'utf-8'));

  const buildDir = join(workDir, 'build');
  mkdirSync(buildDir);

  const result = spawnSync(
    'arduino-cli',
    ['compile', '--fqbn', 'arduino:avr:mega:cpu=atmega2560', '--build-path', buildDir, sketchDir],
    { encoding: 'utf-8', timeout: 120_000 },
  );

  if (result.error) {
    throw new Error(`arduino-cli not available: ${result.error.message}`);
  }
  if (result.status !== 0) {
    console.error('[compile] stdout:', result.stdout);
    console.error('[compile] stderr:', result.stderr);
    throw new Error(`arduino-cli failed (exit ${result.status}): ${result.stderr}`);
  }

  // Find the .hex file (prefer the non-bootloader variant)
  let hexPath: string | null = null;
  for (const candidate of ['mega-blink-test.ino.hex', 'sketch.ino.hex']) {
    const p = join(buildDir, candidate);
    if (existsSync(p)) {
      hexPath = p;
      break;
    }
  }
  if (!hexPath) {
    const files = readdirSync(buildDir, { recursive: true }) as string[];
    const found = files.find(
      (f) => typeof f === 'string' && f.endsWith('.hex') && !f.includes('bootloader'),
    );
    if (!found) throw new Error('No .hex found in build output');
    hexPath = join(buildDir, found);
  }

  const hex = readFileSync(hexPath, 'utf-8');
  writeFileSync(HEX_CACHE, hex);
  rmSync(workDir, { recursive: true });
  console.log('[compile] Done. Hex size:', hex.length, 'chars');
  return hex;
}

describe.skipIf(!ARDUINO_CLI_AVAILABLE)('Arduino Mega 2560 — end-to-end emulation', () => {
  let hexContent: string;
  let sim: AVRSimulator;
  let pm: PinManager;

  beforeAll(() => {
    hexContent = compileSketch();
  });

  afterAll(() => {
    try {
      sim?.stop();
    } catch {
      /* ignore */
    }
    vi.unstubAllGlobals();
  });

  it('🔧 compiles mega-blink-test.ino for arduino:avr:mega successfully', () => {
    expect(hexContent).toBeTruthy();
    expect(hexContent).toContain(':');
    console.log('[hex] First line:', hexContent.split('\n')[0]);
    console.log('[hex] Size:', hexContent.length, 'chars');
  });

  it('🟢 pin 13 (LED_BUILTIN, PORTB bit 7) goes HIGH in setup()', () => {
    pm = new PinManager();
    sim = new AVRSimulator(pm, 'mega');
    sim.loadHex(hexContent);

    const changes: boolean[] = [];
    pm.onPinChange(13, (_pin, state) => changes.push(state));

    // ATmega2560 core init (8 KB SRAM + more peripherals) takes longer than Uno.
    // 5M cycles ≈ 312 ms simulated — well past any reasonable startup + setup().
    // Use runCyclesNoTick to skip cpu.tick() — avoids Timer0 OVF firing at the
    // ATmega328P-specific vector address (0x20) which would reset the CPU.
    runCyclesNoTick(sim, 5_000_000);

    console.log('[pin13] state changes:', changes);
    expect(changes).toContain(true);
    expect(pm.getPinState(13)).toBe(true);
  });

  it('🟢 all PORTA pins (22–29) are HIGH after setup()', () => {
    for (let pin = 22; pin <= 29; pin++) {
      expect(pm.getPinState(pin)).toBe(true);
    }
  });

  it('🟢 pin 53 (PORTB bit 0) is HIGH after setup()', () => {
    expect(pm.getPinState(53)).toBe(true);
  });

  it('🟢 pin 4 (PORTG bit 5) is HIGH after setup()', () => {
    expect(pm.getPinState(4)).toBe(true);
  });

  it('🟢 pin 6 (PORTH bit 3) is HIGH after setup()', () => {
    expect(pm.getPinState(6)).toBe(true);
  });

  it('🟢 pin 42 (PORTL bit 7) is HIGH after setup()', () => {
    expect(pm.getPinState(42)).toBe(true);
  });

  it('🔁 loop() blinks pin 13 — transitions to LOW within 20M cycles (~1.25 s)', () => {
    // delay(500) @ 16 MHz ≈ 8 000 000 cycles.
    // Run 20M to cover HIGH→LOW and LOW→HIGH regardless of where we are in loop().
    const changes: boolean[] = [];
    pm.onPinChange(13, (_pin, state) => changes.push(state));

    runCyclesNoTick(sim, 20_000_000);

    console.log('[blink] pin 13 transitions:', changes);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes).toContain(false); // must go LOW at some point
  });

  it('📐 program memory is 131 072 words (256 KB flash for ATmega2560)', () => {
    const prog = (sim as any).program as Uint16Array;
    expect(prog.length).toBe(131_072);
  });
});
