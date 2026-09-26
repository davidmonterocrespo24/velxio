/**
 * i2c-real-firmware.test.ts
 *
 * Full-fidelity end-to-end I2C tests.  The flow mirrors Velxio
 * production exactly:
 *
 *     [.ino source on disk]
 *           │
 *           ▼   spawnSync('arduino-cli', ['compile', …])
 *     [arduino-cli compile]    ←  same call the FastAPI backend
 *           │                     makes in services/arduino_cli.py
 *           ▼
 *     [intel-hex string]
 *           │
 *           ▼   sim.loadHex(hex)
 *     [AVRSimulator + real avr8js CPU + real AVRTWI peripheral]
 *           │
 *           ▼   sim.step() loop
 *     [real I2CBusManager]
 *           │
 *           ▼
 *     [registered virtual device | bridged peer bus | HD44780 decoder]
 *
 * The only thing skipped relative to production is the FastAPI HTTP
 * transport between frontend and backend, which is plain JSON
 * serialisation of the hex string — no I2C logic lives there.
 *
 * Fixtures
 * --------
 * The sketches live under `velxio/test/test_custom_chips/sketches/`
 * as committed .ino source — the editor content the user would type.
 * Compiled hex files are produced on-demand and cached in the OS
 * tmpdir so subsequent test runs reuse them.
 *
 * Requirements
 * ------------
 * - arduino-cli on PATH
 * - arduino:avr core installed
 * - LiquidCrystal_I2C library installed (for the LCD tests)
 *
 * If any of the above is missing the affected tests skip with a
 * clear note instead of failing — matches the convention in
 * pong-emulation.test.ts and mega-emulation.test.ts.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';
import { I2CMemoryDevice, VirtualPCF8574 } from '../simulation/I2CBusManager';
import { HD44780Decoder } from '../simulation/HD44780Decoder';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/ProtocolParts';
import { bareBoard, putI2cDevice, wireI2cPins, clearBench } from './helpers/i2cBench';

// The Uno's TWI pins (A4 / A5), and a peer Uno's, as board pins of the fabric.
const UNO_SDA = 18;
const UNO_SCL = 19;
const onUno = (boardId: string) => [
  { boardId, pin: UNO_SDA },
  { boardId, pin: UNO_SCL },
];

/** An Uno with the firmware loaded, on the fabric as `boardId`. */
function unoBoard(hex: string, boardId = 'uno'): AVRSimulator {
  const sim = new AVRSimulator(new PinManager(), 'uno');
  sim.loadHex(hex);
  bareBoard(boardId, 'arduino-uno', sim);
  return sim;
}

afterEach(() => clearBench());

// ─── Availability gates ──────────────────────────────────────────────────────

const ARDUINO_CLI_AVAILABLE = (() => {
  const r = spawnSync('arduino-cli', ['version'], { encoding: 'utf-8' });
  return r.error == null && r.status === 0;
})();

/**
 * Cheap probe: is a library installed and usable?  We compile a
 * tiny shim that imports the library header — much faster than
 * parsing `arduino-cli lib list` output and immune to install
 * paths / sketchbook customisations.
 */
function hasLibrary(header: string): boolean {
  if (!ARDUINO_CLI_AVAILABLE) return false;
  const dir = mkdtempSync(join(tmpdir(), 'velxio-libprobe-'));
  const sketchDir = join(dir, 'probe');
  mkdirSync(sketchDir);
  writeFileSync(
    join(sketchDir, 'probe.ino'),
    `#include <${header}>\nvoid setup(){}\nvoid loop(){}\n`,
  );
  const r = spawnSync(
    'arduino-cli',
    ['compile', '--fqbn', 'arduino:avr:uno', sketchDir],
    { encoding: 'utf-8', timeout: 60_000 },
  );
  return r.status === 0;
}

const LIQUID_CRYSTAL_I2C_AVAILABLE = ARDUINO_CLI_AVAILABLE
  ? hasLibrary('LiquidCrystal_I2C.h')
  : false;

// ─── Compile-on-demand helper (mirrors backend/arduino_cli.py) ───────────────

/**
 * Resolve the path to one of the committed test sketches.
 */
function sketchSourcePath(name: string): string {
  return resolve(
    __dirname,
    '../../../test/test_custom_chips/sketches',
    name,
    `${name}.ino`,
  );
}

/**
 * Compile a sketch with arduino-cli (subprocess), exactly like the
 * Velxio FastAPI backend does in services/arduino_cli.py:compile().
 * Caches the produced hex per (sketch, fqbn, source mtime) so repeated
 * test runs against unchanged source are instant.
 *
 * Throws if arduino-cli is unavailable or compilation fails — the
 * caller is expected to gate on `ARDUINO_CLI_AVAILABLE` first.
 */
function compileSketch(name: string, fqbn = 'arduino:avr:uno'): string {
  const sourcePath = sketchSourcePath(name);
  if (!existsSync(sourcePath)) {
    throw new Error(`Sketch source missing: ${sourcePath}`);
  }

  // Cache key — invalidate when the .ino content changes.
  const source = readFileSync(sourcePath, 'utf-8');
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = (hash * 31 + source.charCodeAt(i)) | 0;
  }
  const hexCache = join(
    tmpdir(),
    `velxio-${name}-${fqbn.replace(/[^a-z0-9]/gi, '_')}-${hash >>> 0}.hex`,
  );
  if (existsSync(hexCache)) {
    return readFileSync(hexCache, 'utf-8');
  }

  // Stage the sketch in a temp dir — arduino-cli requires the
  // directory name to match the sketch name (so name/name.ino).
  const work = mkdtempSync(join(tmpdir(), `velxio-${name}-`));
  const sketchDir = join(work, name);
  mkdirSync(sketchDir);
  writeFileSync(join(sketchDir, `${name}.ino`), source);

  const buildDir = join(work, 'build');
  mkdirSync(buildDir);

  const result = spawnSync(
    'arduino-cli',
    [
      'compile',
      '--fqbn',
      fqbn,
      '--output-dir',
      buildDir,
      '--build-path',
      buildDir,
      sketchDir,
    ],
    { encoding: 'utf-8', timeout: 180_000 },
  );

  if (result.error) {
    throw new Error(`arduino-cli not available: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `arduino-cli compile failed (exit ${result.status}):\n${result.stderr}\n${result.stdout}`,
    );
  }

  // Find the produced hex.  arduino-cli emits "<sketch>.ino.hex".
  let hex: string | null = null;
  for (const candidate of [
    `${name}.ino.hex`,
    `${name}.hex`,
    'sketch.ino.hex',
  ]) {
    const p = join(buildDir, candidate);
    if (existsSync(p)) {
      hex = readFileSync(p, 'utf-8');
      break;
    }
  }
  if (!hex) {
    const files = readdirSync(buildDir, { recursive: true });
    throw new Error(
      `Could not locate .hex output in ${buildDir} (saw: ${files.join(', ')})`,
    );
  }

  writeFileSync(hexCache, hex);
  return hex;
}

// ─── Runtime helpers ─────────────────────────────────────────────────────────

const EEPROM_STEP_BUDGET = 1_000_000; // Wire setup() takes ~200k cycles
/**
 * LiquidCrystal_I2C v2.0.0 init contains delay(50) + delay(1000) +
 * 4 × delayMicroseconds(4500) BEFORE the first useful write.  That's
 * ~1.07 s = ~17 M CPU cycles at 16 MHz.  Plus the print() phase.
 * 30 M keeps us comfortably above that with margin for library bumps.
 */
const LCD_STEP_BUDGET = 30_000_000;

function runUntil(sim: AVRSimulator, budget: number, predicate: () => boolean): number {
  for (let i = 0; i < budget; i++) {
    sim.step();
    if ((i & 0x3ff) === 0 && predicate()) return i + 1;
  }
  return budget;
}

// ─── EEPROM-demo tests (compile + load + run) ────────────────────────────────

describe.runIf(ARDUINO_CLI_AVAILABLE)(
  'I2C E2E — Wire master at 0x50 (full Velxio compile flow)',
  () => {
    let HEX: string;
    beforeAll(() => {
      HEX = compileSketch('i2c_eeprom_demo');
    });

    it('single board: master writes 0xAA..0xDD into a device wired to its SDA/SCL', () => {
      const sim = unoBoard(HEX);
      const eeprom = new I2CMemoryDevice(0x50);
      const [sda, scl] = onUno('uno');
      putI2cDevice(eeprom, sda, scl);

      const steps = runUntil(
        sim,
        EEPROM_STEP_BUDGET,
        () =>
          eeprom.registers[0] === 0xaa &&
          eeprom.registers[1] === 0xbb &&
          eeprom.registers[2] === 0xcc &&
          eeprom.registers[3] === 0xdd,
      );
      expect(steps).toBeLessThan(EEPROM_STEP_BUDGET);
      expect(eeprom.registers[0]).toBe(0xaa);
      expect(eeprom.registers[1]).toBe(0xbb);
      expect(eeprom.registers[2]).toBe(0xcc);
      expect(eeprom.registers[3]).toBe(0xdd);
    });

    it('single board: master reads back via Wire.requestFrom and echoes via Serial', () => {
      const sim = unoBoard(HEX);
      const [sda, scl] = onUno('uno');
      putI2cDevice(new I2CMemoryDevice(0x50), sda, scl);

      const serialOut: number[] = [];
      sim.onSerialData = (ch) => serialOut.push(ch.charCodeAt(0));

      runUntil(sim, EEPROM_STEP_BUDGET, () => serialOut.length >= 4);
      expect(serialOut.slice(0, 4)).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
    });

    it('two boards: master on board A reaches a device wired to board B over the shared I2C net', () => {
      const simA = unoBoard(HEX, 'a');
      // The peer board holds the device on its own header; its A4/A5 are
      // wired to A's, so the net reaches both boards and the fabric puts the
      // device on both buses. The peer's CPU never runs (no second CPU to
      // step): what matters is that A's master finds the chip.
      const simB = new AVRSimulator(new PinManager(), 'uno');
      bareBoard('b', 'arduino-uno', simB);
      const eeprom = new I2CMemoryDevice(0x50);
      const [sdaB, sclB] = onUno('b');
      const [sdaA, sclA] = onUno('a');
      putI2cDevice(eeprom, [sdaB, sdaA], [sclB, sclA]);

      const serialOut: number[] = [];
      simA.onSerialData = (ch) => serialOut.push(ch.charCodeAt(0));

      runUntil(simA, EEPROM_STEP_BUDGET, () => serialOut.length >= 4);

      // Writes landed on the device wired to the peer board.
      expect(eeprom.registers[0]).toBe(0xaa);
      expect(eeprom.registers[1]).toBe(0xbb);
      expect(eeprom.registers[2]).toBe(0xcc);
      expect(eeprom.registers[3]).toBe(0xdd);
      // Reads also came back over the same net.
      expect(serialOut.slice(0, 4)).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
    });
  },
);

// ─── LCD-I2C tests (need the LiquidCrystal_I2C library installed) ────────────

describe.runIf(LIQUID_CRYSTAL_I2C_AVAILABLE)(
  'I2C E2E — LiquidCrystal_I2C → HD44780 decoder (full Velxio compile flow)',
  () => {
    let HEX: string;
    beforeAll(() => {
      HEX = compileSketch('lcd_i2c_hello');
    });

    it('renders "Hello" on row 0 and "World" on row 1', () => {
      const sim = unoBoard(HEX);

      const pcf = new VirtualPCF8574(0x27);
      const decoder = new HD44780Decoder({ cols: 16, rows: 2 });
      const bytesSeen: number[] = [];
      pcf.onWrite = (v) => {
        bytesSeen.push(v);
        decoder.feedPCF8574Byte(v);
      };
      const [sda, scl] = onUno('uno');
      putI2cDevice(pcf, sda, scl);

      runUntil(sim, LCD_STEP_BUDGET, () => {
        const c = decoder.snapshot().characters;
        return c[0] === 'H'.charCodeAt(0) && c[20] === 'd'.charCodeAt(0);
      });

      expect(bytesSeen.length).toBeGreaterThan(20);
      const snap = decoder.snapshot();
      expect(String.fromCharCode(...snap.characters.slice(0, 5))).toBe('Hello');
      expect(String.fromCharCode(...snap.characters.slice(16, 21))).toBe('World');
      expect(snap.backlight).toBe(true);
      expect(snap.displayOn).toBe(true);
    });

    it('end-to-end via the lcd1602-i2c part: element.characters reflects the print', () => {
      const sim = unoBoard(HEX);
      // The part registers itself with the fabric by its own pins.
      const [sda, scl] = onUno('uno');
      wireI2cPins('lcd-1', sda, scl);

      // Mock wokwi-lcd1602 element exactly as DynamicComponent
      // would render and pass to the part.
      const el: any = {
        pins: 'full',
        characters: new Uint8Array(32),
        backlight: true,
        i2cAddress: '0x27',
        addEventListener: () => {},
        removeEventListener: () => {},
      };
      const detach = PartSimulationRegistry.get('lcd1602-i2c')!.attachEvents!(
        el as HTMLElement,
        sim as unknown as object as any,
        () => null,
        'lcd-1',
      );

      expect(el.pins).toBe('i2c');

      runUntil(sim, LCD_STEP_BUDGET, () => {
        const c = el.characters as Uint8Array;
        return c[0] === 'H'.charCodeAt(0) && c[20] === 'd'.charCodeAt(0);
      });

      const c = el.characters as Uint8Array;
      expect(String.fromCharCode(...c.slice(0, 5))).toBe('Hello');
      expect(String.fromCharCode(...c.slice(16, 21))).toBe('World');

      detach();
    });
  },
);

// ─── Skip notices when prerequisites are missing ─────────────────────────────

describe.skipIf(ARDUINO_CLI_AVAILABLE)(
  'I2C E2E — skipped because arduino-cli is not on PATH',
  () => {
    it('install arduino-cli to enable the full-fidelity I2C tests', () => {
      expect(true).toBe(true);
    });
  },
);

describe.skipIf(LIQUID_CRYSTAL_I2C_AVAILABLE || !ARDUINO_CLI_AVAILABLE)(
  'I2C E2E — LCD tests skipped because LiquidCrystal_I2C library is missing',
  () => {
    it('run: arduino-cli lib install "LiquidCrystal_I2C"', () => {
      expect(true).toBe(true);
    });
  },
);
