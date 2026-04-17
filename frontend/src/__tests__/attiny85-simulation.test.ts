/**
 * attiny85-simulation.test.ts
 *
 * Unit and integration tests for the ATtiny85 emulator variant ('tiny85').
 *
 * UNIT tests (no compilation required):
 *   - AVRSimulator initialises with boardVariant='tiny85'
 *   - Program memory is 4096 words (8 KB flash)
 *   - PORTB listener fires when PB1 goes HIGH (PORTB = 0x02)
 *   - PinManager receives pin 1 HIGH after blink HEX execution
 *   - setPinState() drives PB0-PB5 correctly
 *   - No PORTC/PORTD (ATtiny85 only has PORTB)
 *   - No hardware USART
 *   - PWM OCR0B at address 0x5C triggers pin 1 update
 *   - boardPinMapping: PB0-PB5 → 0-5, GND/VCC → -1
 *
 * END-TO-END test (requires arduino-cli + ATTinyCore):
 *   - Compiles attiny85-blink.ino for ATTinyCore:avr:attinyx5:chip=85
 *   - Loads .hex into AVRSimulator('tiny85')
 *   - Verifies PB1 goes HIGH after setup() runs
 *
 * ─── ATtiny85 register map ────────────────────────────────────────────────────
 *   ATtiny85 PINB  = 0x36  (ATmega328P PINB  = 0x23)
 *   ATtiny85 DDRB  = 0x37  (ATmega328P DDRB  = 0x24)
 *   ATtiny85 PORTB = 0x38  (ATmega328P PORTB = 0x25)
 *   ATtiny85 OCR0B = 0x5C  (ATmega328P OCR0B = 0x48)
 *
 * ─── ATtiny85 blink HEX (hand-assembled) ─────────────────────────────────────
 *   LDI r16, 0xFF   ; 0F EF  — r16 = 0xFF (all outputs)
 *   OUT 0x17, r16   ; 07 BB  — DDRB (I/O 0x17 → mem 0x37): all outputs
 *   LDI r16, 0x02   ; 02 E0  — r16 = 0x02 (PB1)
 *   OUT 0x18, r16   ; 08 BB  — PORTB (I/O 0x18 → mem 0x38): PB1 HIGH
 *   RJMP .-2        ; FF CF  — infinite loop
 *   Checksum: -(sum mod 256) = 0xC3
 *
 * OUT Aa, Rr encoding: 1011 1AAr rrrr AAAA
 *   r16=10000 → r[4]=1 → bit 8 set, so 0xBAxx → 0xBBxx
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import {
  mkdtempSync, writeFileSync, readFileSync,
  rmSync, mkdirSync, readdirSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { avrInstruction } from 'avr8js';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';

// ─── RAF stubs ─────────────────────────────────────────────────────────────────
// Depth-limited: calls cb once synchronously, prevents re-entrancy loops.
beforeEach(() => {
  let counter = 0;
  let depth = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    if (depth === 0) { depth++; cb(0); depth--; }
    return ++counter;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

// ─── Helpers ──────────────────────────────────────────────────────────────────

function runCycles(sim: AVRSimulator, n: number): void {
  for (let i = 0; i < n; i++) sim.step();
}

// ─── Minimal Intel HEX payloads ───────────────────────────────────────────────

const EMPTY_HEX = ':00000001FF\n';

/**
 * TINY85_BLINK_HEX — sets PB1 HIGH then loops.
 * Uses ATtiny85 DDRB (I/O 0x17 → mem 0x37) and PORTB (I/O 0x18 → mem 0x38).
 */
const TINY85_BLINK_HEX =
  ':0A0000000FEF07BB02E008BBFFCFC3\n' +
  ':00000001FF\n';

/**
 * TINY85_PB0_HEX — sets PB0 HIGH (bit 0).
 *   LDI r16, 0xFF → OUT DDRB → LDI r16, 0x01 → OUT PORTB → RJMP .-2
 * Checksum: 0xC4
 */
const TINY85_PB0_HEX =
  ':0A0000000FEF07BB01E008BBFFCFC4\n' +
  ':00000001FF\n';

/**
 * TINY85_PWM_HEX — writes 0x80 to OCR0B (I/O 0x3C → mem 0x5C) to test PWM.
 *   LDI r16, 0xFF → OUT DDRB (0x17) → LDI r16, 0x80 → OUT OCR0B (0x3C) → RJMP .-2
 *
 * OUT 0x3C, r16 encoding:
 *   A = 0x3C = 0b111100; A[5:4]=0b11, A[3:0]=0b1100; r=16
 *   word = 1011 1 11 10000 1100 = 0xBF0C → bytes 0x0C 0xBF
 * Checksum: 0xB5
 */
const TINY85_PWM_HEX =
  ':0A0000000FEF07BB00E80CBFFFCFB5\n' +
  ':00000001FF\n';

// ─── Lifecycle ────────────────────────────────────────────────────────────────

describe('ATtiny85 — lifecycle', () => {
  let pm: PinManager;
  let sim: AVRSimulator;

  beforeEach(() => {
    pm = new PinManager();
    sim = new AVRSimulator(pm, 'tiny85');
  });
  afterEach(() => sim.stop());

  it('starts in idle state', () => {
    expect(sim.isRunning()).toBe(false);
    expect(sim.getSpeed()).toBe(1.0);
  });

  it('loads a valid HEX without throwing', () => {
    expect(() => sim.loadHex(EMPTY_HEX)).not.toThrow();
    expect(() => sim.loadHex(TINY85_BLINK_HEX)).not.toThrow();
  });

  it('start() transitions to running state', () => {
    sim.loadHex(EMPTY_HEX);
    sim.start();
    expect(sim.isRunning()).toBe(true);
    sim.stop();
    expect(sim.isRunning()).toBe(false);
  });

  it('reset() stops simulation and reinitialises', () => {
    sim.loadHex(TINY85_BLINK_HEX);
    sim.start();
    expect(sim.isRunning()).toBe(true);
    sim.reset();
    expect(sim.isRunning()).toBe(false);
  });

  it('clamps speed within [0.1, 10.0]', () => {
    sim.setSpeed(0.001);
    expect(sim.getSpeed()).toBe(0.1);
    sim.setSpeed(999);
    expect(sim.getSpeed()).toBe(10.0);
    sim.setSpeed(2.0);
    expect(sim.getSpeed()).toBe(2.0);
  });
});

// ─── Flash / memory ──────────────────────────────────────────────────────────

describe('ATtiny85 — memory', () => {
  it('program memory is 4096 words (8 KB flash)', () => {
    const pm = new PinManager();
    const sim = new AVRSimulator(pm, 'tiny85');
    sim.loadHex(EMPTY_HEX);
    const prog = (sim as any).program as Uint16Array;
    expect(prog.length).toBe(4096);
    sim.stop();
  });
});

// ─── Peripheral configuration ─────────────────────────────────────────────────

describe('ATtiny85 — peripheral configuration', () => {
  it('portB is initialised, portC and portD are null', () => {
    const pm = new PinManager();
    const sim = new AVRSimulator(pm, 'tiny85');
    sim.loadHex(EMPTY_HEX);
    expect((sim as any).portB).not.toBeNull();
    expect((sim as any).portC).toBeNull();
    expect((sim as any).portD).toBeNull();
    sim.stop();
  });

  it('usart is null (no hardware serial on ATtiny85)', () => {
    const pm = new PinManager();
    const sim = new AVRSimulator(pm, 'tiny85');
    sim.loadHex(EMPTY_HEX);
    expect(sim.usart).toBeNull();
    sim.stop();
  });

  it('megaPorts map is empty (ATtiny85 has only PORTB)', () => {
    const pm = new PinManager();
    const sim = new AVRSimulator(pm, 'tiny85');
    sim.loadHex(EMPTY_HEX);
    const megaPorts = (sim as any).megaPorts as Map<string, unknown>;
    expect(megaPorts.size).toBe(0);
    sim.stop();
  });
});

// ─── Pin state — blink HEX execution ─────────────────────────────────────────

describe('ATtiny85 — pin state from HEX execution', () => {
  it('TINY85_BLINK_HEX: PB1 goes HIGH after 4 steps', () => {
    const pm = new PinManager();
    const sim = new AVRSimulator(pm, 'tiny85');
    sim.loadHex(TINY85_BLINK_HEX);

    const changes: boolean[] = [];
    pm.onPinChange(1, (_pin, state) => changes.push(state));

    // LDI r16,0xFF / OUT DDRB / LDI r16,0x02 / OUT PORTB
    runCycles(sim, 4);

    expect(changes).toContain(true);
    expect(pm.getPinState(1)).toBe(true);
    sim.stop();
  });

  it('TINY85_PB0_HEX: PB0 goes HIGH after 4 steps', () => {
    const pm = new PinManager();
    const sim = new AVRSimulator(pm, 'tiny85');
    sim.loadHex(TINY85_PB0_HEX);

    const changes: boolean[] = [];
    pm.onPinChange(0, (_pin, state) => changes.push(state));

    runCycles(sim, 4);

    expect(changes).toContain(true);
    expect(pm.getPinState(0)).toBe(true);
    sim.stop();
  });

  it('TINY85_BLINK_HEX: only PB1 changes (PB0/PB2 stay LOW)', () => {
    const pm = new PinManager();
    const sim = new AVRSimulator(pm, 'tiny85');
    sim.loadHex(TINY85_BLINK_HEX);

    const pb0Changes: boolean[] = [];
    const pb2Changes: boolean[] = [];
    pm.onPinChange(0, (_p, s) => pb0Changes.push(s));
    pm.onPinChange(2, (_p, s) => pb2Changes.push(s));

    runCycles(sim, 4);

    expect(pb0Changes.filter(Boolean)).toHaveLength(0);
    expect(pb2Changes.filter(Boolean)).toHaveLength(0);
    sim.stop();
  });
});

// ─── setPinState ──────────────────────────────────────────────────────────────

describe('ATtiny85 — setPinState()', () => {
  it('does not throw for valid PB0-PB5', () => {
    const pm = new PinManager();
    const sim = new AVRSimulator(pm, 'tiny85');
    sim.loadHex(EMPTY_HEX);
    for (let pin = 0; pin <= 5; pin++) {
      expect(() => sim.setPinState(pin, true)).not.toThrow();
      expect(() => sim.setPinState(pin, false)).not.toThrow();
    }
    sim.stop();
  });

  it('does not throw for out-of-range pin 6 (no-op)', () => {
    const pm = new PinManager();
    const sim = new AVRSimulator(pm, 'tiny85');
    sim.loadHex(EMPTY_HEX);
    expect(() => sim.setPinState(6, true)).not.toThrow();
    sim.stop();
  });
});

// ─── PWM — OCR0B ─────────────────────────────────────────────────────────────

describe('ATtiny85 — PWM monitoring', () => {
  it('PinManager receives PWM update on pin 1 when OCR0B (0x5C) is written', () => {
    const pm = new PinManager();
    const sim = new AVRSimulator(pm, 'tiny85');
    sim.loadHex(EMPTY_HEX);

    const pwmCb = vi.fn();
    pm.onPwmChange(1, pwmCb);  // PB1 = OCR0B pin

    // Directly write a PWM value to OCR0B in CPU data memory
    const cpu = (sim as any).cpu;
    cpu.data[0x5C] = 128;  // 50% duty cycle

    sim.start();
    sim.stop();

    expect(pwmCb).toHaveBeenCalledWith(1, 128 / 255);
  });

  it('PinManager receives PWM update on pin 0 when OCR0A (0x56) is written', () => {
    const pm = new PinManager();
    const sim = new AVRSimulator(pm, 'tiny85');
    sim.loadHex(EMPTY_HEX);

    const pwmCb = vi.fn();
    pm.onPwmChange(0, pwmCb);  // PB0 = OCR0A pin

    const cpu = (sim as any).cpu;
    cpu.data[0x56] = 64;

    sim.start();
    sim.stop();

    expect(pwmCb).toHaveBeenCalledWith(0, 64 / 255);
  });

  it('ATtiny85 PWM covers 4 pins (OCR0A/OCR0B/OCR1A/OCR1B)', () => {
    const TINY85_PWM_MAP = [
      { addr: 0x56, pin: 0 }, // OCR0A → PB0
      { addr: 0x5C, pin: 1 }, // OCR0B → PB1
      { addr: 0x4E, pin: 1 }, // OCR1A → PB1
      { addr: 0x4B, pin: 4 }, // OCR1B → PB4
    ];

    const pm = new PinManager();
    const sim = new AVRSimulator(pm, 'tiny85');
    sim.loadHex(EMPTY_HEX);

    const cbs: Record<number, ReturnType<typeof vi.fn>> = {};
    const uniquePins = [...new Set(TINY85_PWM_MAP.map((m) => m.pin))];
    uniquePins.forEach((pin) => {
      cbs[pin] = vi.fn();
      pm.onPwmChange(pin, cbs[pin]);
    });

    const cpu = (sim as any).cpu;
    TINY85_PWM_MAP.forEach(({ addr }, i) => {
      cpu.data[addr] = (i + 1) * 50; // 50, 100, 150, 200
    });

    sim.start();
    sim.stop();

    // PB0 should receive OCR0A update
    expect(cbs[0]).toHaveBeenCalled();
    // PB1 should receive at least one OCR update (OCR0B or OCR1A)
    expect(cbs[1]).toHaveBeenCalled();
    // PB4 should receive OCR1B update
    expect(cbs[4]).toHaveBeenCalled();
  });
});

// ─── boardPinMapping ──────────────────────────────────────────────────────────

describe('ATtiny85 — boardPinMapping', () => {
  it('PB0-PB5 map to pins 0-5', async () => {
    const { boardPinToNumber } = await import('../utils/boardPinMapping');
    for (let i = 0; i <= 5; i++) {
      expect(boardPinToNumber('attiny85', `PB${i}`)).toBe(i);
    }
  });

  it('numeric pin names 0-5 map correctly', async () => {
    const { boardPinToNumber } = await import('../utils/boardPinMapping');
    for (let i = 0; i <= 5; i++) {
      expect(boardPinToNumber('attiny85', String(i))).toBe(i);
    }
  });

  it('GND and VCC return -1 (power-only, not GPIOs)', async () => {
    const { boardPinToNumber } = await import('../utils/boardPinMapping');
    expect(boardPinToNumber('attiny85', 'GND')).toBe(-1);
    expect(boardPinToNumber('attiny85', 'VCC')).toBe(-1);
  });

  it('unknown pin names return null', async () => {
    const { boardPinToNumber } = await import('../utils/boardPinMapping');
    expect(boardPinToNumber('attiny85', 'PB6')).toBeNull();
    expect(boardPinToNumber('attiny85', 'A0')).toBeNull();
    expect(boardPinToNumber('attiny85', 'D13')).toBeNull();
    expect(boardPinToNumber('attiny85', 'TX')).toBeNull();
  });

  it("'attiny85' is in BOARD_COMPONENT_IDS", async () => {
    const { BOARD_COMPONENT_IDS } = await import('../utils/boardPinMapping');
    expect(BOARD_COMPONENT_IDS).toContain('attiny85');
  });

  it("isBoardComponent('attiny85') returns true", async () => {
    const { isBoardComponent } = await import('../utils/boardPinMapping');
    expect(isBoardComponent('attiny85')).toBe(true);
    expect(isBoardComponent('attiny85-1')).toBe(true);
  });
});

// ─── End-to-end: arduino-cli compilation (skipped if ATTinyCore not installed) ─

describe('ATtiny85 — end-to-end compilation', () => {
  const FQBN = 'ATTinyCore:avr:attinyx5:chip=85,clock=internal16mhz';

  function isATTinyCoreAvailable(): boolean {
    const cliCheck = spawnSync('arduino-cli', ['version'], { encoding: 'utf8' });
    if (cliCheck.status !== 0) return false;
    const coreCheck = spawnSync('arduino-cli', ['core', 'list'], { encoding: 'utf8' });
    return coreCheck.stdout?.includes('ATTinyCore') ?? false;
  }

  it('compiles blink sketch and PB1 goes HIGH after setup()', () => {
    if (!isATTinyCoreAvailable()) {
      console.log('ATTinyCore not installed — skipping E2E compilation test');
      return;
    }

    const tmpDir = mkdtempSync(join(tmpdir(), 'attiny85-e2e-'));
    const sketchDir = join(tmpDir, 'sketch');
    mkdirSync(sketchDir);
    writeFileSync(join(sketchDir, 'sketch.ino'), `
void setup() {
  pinMode(1, OUTPUT);
  digitalWrite(1, HIGH);
}
void loop() {}
`);

    try {
      const result = spawnSync(
        'arduino-cli', ['compile', '--fqbn', FQBN, '--output-dir', sketchDir, sketchDir],
        { encoding: 'utf8', timeout: 60000 },
      );
      expect(result.status).toBe(0);

      const hexFiles = readdirSync(sketchDir).filter((f) => f.endsWith('.hex'));
      expect(hexFiles.length).toBeGreaterThan(0);

      const hexContent = readFileSync(join(sketchDir, hexFiles[0]), 'utf8');
      const pm = new PinManager();
      const sim = new AVRSimulator(pm, 'tiny85');
      sim.loadHex(hexContent);

      // Run ~800k instructions — enough for setup() to complete at 16 MHz
      const cpu = (sim as any).cpu;
      for (let i = 0; i < 800_000; i++) {
        avrInstruction(cpu);
        cpu.tick();
      }

      expect(pm.getPinState(1)).toBe(true);
      sim.stop();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
