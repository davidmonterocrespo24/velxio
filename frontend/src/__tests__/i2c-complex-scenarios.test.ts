/**
 * i2c-complex-scenarios.test.ts
 *
 * Complex multi-device / multi-board I2C scenarios driven by REAL
 * Arduino sketches compiled on demand by arduino-cli — the exact
 * production flow Velxio runs when a user clicks Run.
 *
 * Coverage matrix
 * ---------------
 *   I2C scanner over a populated bus    →  multi-device discovery
 *   DS1307 + LCD-I2C clock combo        →  two devices on same bus,
 *                                          BCD decode + HD44780 print
 *   BMP280 read across a bridged peer   →  multi-board I2C, register
 *                                          reads through the bridge
 *   PCF8574 bidirectional I/O           →  read+write round-trip on
 *                                          the same device
 *
 * Each scenario uses the same `compileSketch()` helper as
 * `i2c-real-firmware.test.ts` (subprocess invocation of arduino-cli,
 * identical to backend/services/arduino_cli.py:compile()).  Tests
 * skip gracefully if arduino-cli or the required library is missing.
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
import { RP2040Simulator } from '../simulation/RP2040Simulator';
import { PinManager } from '../simulation/PinManager';
import {
  I2CMemoryDevice,
  VirtualBMP280,
  VirtualDS1307,
  VirtualPCF8574,
} from '../simulation/I2CBusManager';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/ProtocolParts';
import { bareBoard, putI2cDevice, wireI2cPins, clearBench, type BoardPin } from './helpers/i2cBench';

// Every device is on a bus by its wiring (board-buses F5). The Uno's TWI is
// A4/A5; the Pico's Wire is GP4/GP5.
const UNO_I2C = (boardId: string): [BoardPin, BoardPin] => [
  { boardId, pin: 18 },
  { boardId, pin: 19 },
];
const PICO_I2C = (boardId: string): [BoardPin, BoardPin] => [
  { boardId, pin: 4 },
  { boardId, pin: 5 },
];

/** An Uno with the firmware loaded, on the fabric as `boardId`. */
function unoBoard(hex: string, boardId = 'uno'): AVRSimulator {
  const sim = new AVRSimulator(new PinManager(), 'uno');
  sim.loadHex(hex);
  bareBoard(boardId, 'arduino-uno', sim);
  return sim;
}

/**
 * A second Uno on the fabric, whose header the cases wire to the master's: a
 * device on the peer's A4/A5 is on one net with the master's, so the fabric
 * places it on both boards. The peer's CPU never runs.
 */
function peerUno(peerId = 'peer'): void {
  bareBoard(peerId, 'arduino-uno', new AVRSimulator(new PinManager(), 'uno'));
}

afterEach(() => clearBench());

// ─── Availability gates (same shape as i2c-real-firmware.test.ts) ────────────

const ARDUINO_CLI_AVAILABLE = (() => {
  const r = spawnSync('arduino-cli', ['version'], { encoding: 'utf-8' });
  return r.error == null && r.status === 0;
})();

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

// ─── Compile helper — mirrors backend/services/arduino_cli.py exactly ────────

function sketchSourcePath(name: string): string {
  return resolve(
    __dirname,
    '../../../test/test_custom_chips/sketches',
    name,
    `${name}.ino`,
  );
}

/**
 * Compile a sketch.  Returns the artifact contents — `.hex` text for
 * AVR boards, base64 of `.bin` for RP2040.  Velxio's frontend follows
 * the same split (AVRSimulator.loadHex vs RP2040Simulator.loadBinary).
 */
function compileSketch(name: string, fqbn = 'arduino:avr:uno'): string {
  const sourcePath = sketchSourcePath(name);
  if (!existsSync(sourcePath)) {
    throw new Error(`Sketch source missing: ${sourcePath}`);
  }
  const source = readFileSync(sourcePath, 'utf-8');
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = (hash * 31 + source.charCodeAt(i)) | 0;
  }
  const ext = fqbn.startsWith('rp2040:') ? 'binb64' : 'hex';
  const cachePath = join(
    tmpdir(),
    `velxio-${name}-${fqbn.replace(/[^a-z0-9]/gi, '_')}-${hash >>> 0}.${ext}`,
  );
  if (existsSync(cachePath)) {
    return readFileSync(cachePath, 'utf-8');
  }

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
      '--fqbn', fqbn,
      '--output-dir', buildDir,
      '--build-path', buildDir,
      sketchDir,
    ],
    { encoding: 'utf-8', timeout: 240_000 },
  );
  if (result.error) {
    throw new Error(`arduino-cli not available: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `arduino-cli compile failed (exit ${result.status}):\n${result.stderr}\n${result.stdout}`,
    );
  }

  let artifact: string | null = null;
  if (ext === 'binb64') {
    // RP2040: pick up the raw .bin and base64-encode it.
    for (const candidate of [`${name}.ino.bin`, `${name}.bin`]) {
      const p = join(buildDir, candidate);
      if (existsSync(p)) {
        artifact = readFileSync(p).toString('base64');
        break;
      }
    }
  } else {
    for (const candidate of [`${name}.ino.hex`, `${name}.hex`, 'sketch.ino.hex']) {
      const p = join(buildDir, candidate);
      if (existsSync(p)) {
        artifact = readFileSync(p, 'utf-8');
        break;
      }
    }
  }
  if (!artifact) {
    const files = readdirSync(buildDir, { recursive: true });
    throw new Error(
      `Could not locate ${ext} output in ${buildDir} (saw: ${files.join(', ')})`,
    );
  }
  writeFileSync(cachePath, artifact);
  return artifact;
}

// ─── Step-budget helper ──────────────────────────────────────────────────────

/**
 * Drive a simulator's CPU until predicate() returns true or budget
 * is exhausted.  We check the predicate sparsely (every 1024 steps)
 * because most predicates only flip at I2C transaction boundaries
 * which are >100 cycles apart — checking on every step would just
 * be overhead.
 */
function runUntil(sim: AVRSimulator, budget: number, predicate: () => boolean): number {
  for (let i = 0; i < budget; i++) {
    sim.step();
    if ((i & 0x3ff) === 0 && predicate()) return i + 1;
  }
  return budget;
}

// ─── 1. I2C scanner over a populated bus ─────────────────────────────────────

describe.runIf(ARDUINO_CLI_AVAILABLE)(
  'I2C scenario — scanner finds every registered device + NACKs the rest',
  () => {
    let HEX: string;
    beforeAll(() => {
      HEX = compileSketch('i2c_scanner_multi');
    });

    it('detects exactly the addresses that have a device on the bus', () => {
      const sim = unoBoard(HEX);

      // Devices at 5 distinct addresses spanning the common I2C device-id
      // range, all on the TWI's pins.  The scanner walks 1..126, so a NACK on
      // any other address must NOT produce a Serial byte.
      const REGISTERED = [0x10, 0x27, 0x3c, 0x68, 0x76];
      const [sda, scl] = UNO_I2C('uno');
      for (const addr of REGISTERED) {
        putI2cDevice(new I2CMemoryDevice(addr), sda, scl);
      }

      const out: number[] = [];
      sim.onSerialData = (ch) => out.push(ch.charCodeAt(0));

      // Scanner walks 126 addresses × ~100 µs per attempt = ~13 ms
      // plus Wire.begin overhead.  500 k cycles is generous.
      runUntil(sim, 1_500_000, () => out[out.length - 1] === 0xff);

      // Last byte is the 0xFF terminator; trim it off to get the
      // discovered address list.
      expect(out[out.length - 1]).toBe(0xff);
      const discovered = out.slice(0, -1).sort((a, b) => a - b);
      expect(discovered).toEqual(REGISTERED);
    });

    it('an empty bus produces zero discovered addresses', () => {
      const sim = unoBoard(HEX);
      // No devices on the bus.
      const out: number[] = [];
      sim.onSerialData = (ch) => out.push(ch.charCodeAt(0));

      runUntil(sim, 1_500_000, () => out[out.length - 1] === 0xff);
      expect(out).toEqual([0xff]);
    });

    it('finds devices wired to a peer board whose header shares the net', () => {
      const sim = unoBoard(HEX);
      peerUno();
      const [sda, scl] = UNO_I2C('uno');
      const [psda, pscl] = UNO_I2C('peer');

      // Devices on the Uno's own header...
      putI2cDevice(new I2CMemoryDevice(0x10), sda, scl);
      putI2cDevice(new I2CMemoryDevice(0x27), sda, scl);

      // ...plus devices on the peer board's header, wired to the Uno's.
      putI2cDevice(new I2CMemoryDevice(0x3c), [psda, sda], [pscl, scl]);
      putI2cDevice(new I2CMemoryDevice(0x76), [psda, sda], [pscl, scl]);

      const out: number[] = [];
      sim.onSerialData = (ch) => out.push(ch.charCodeAt(0));

      runUntil(sim, 1_500_000, () => out[out.length - 1] === 0xff);

      const discovered = out.slice(0, -1).sort((a, b) => a - b);
      expect(discovered).toEqual([0x10, 0x27, 0x3c, 0x76]);
    });
  },
);

// ─── 2. DS1307 RTC + LCD-I2C clock combo ─────────────────────────────────────

describe.runIf(LIQUID_CRYSTAL_I2C_AVAILABLE)(
  'I2C scenario — RTC + LCD-I2C clock (two devices, same bus)',
  () => {
    let HEX: string;
    beforeAll(() => {
      HEX = compileSketch('rtc_lcd_clock');
    });

    it('renders "Time:" + valid HH:MM:SS from a real DS1307 + LiquidCrystal_I2C combo', () => {
      const sim = new AVRSimulator(new PinManager(), 'uno');
      bareBoard('uno', 'arduino-uno', sim);
      sim.loadHex(HEX);
      const [sda, scl] = UNO_I2C('uno');

      // Device 1: virtual DS1307 returning host wall-clock time.
      putI2cDevice(new VirtualDS1307(), sda, scl);

      // Device 2: the LCD-I2C part (uses VirtualPCF8574 + HD44780
      // decoder internally), on the bus by its own pins.  Attach against a
      // mock wokwi-lcd1602 shaped element.
      wireI2cPins('lcd-1', sda, scl);
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

      // Init delay is ~1 s + write phase.  Budget 30M cycles.
      // Wait for the LAST seconds digit (row 1, col 7 = flat index
      // 23) to land — that's the final character written by the
      // sketch, after which DDRAM is fully populated.
      runUntil(sim, 30_000_000, () => {
        const c = el.characters as Uint8Array;
        const lastSec = c[23];
        return (
          c[0] === 'T'.charCodeAt(0) &&
          lastSec >= 0x30 &&
          lastSec <= 0x39
        );
      });

      const c = el.characters as Uint8Array;
      const row0 = String.fromCharCode(...c.slice(0, 16));
      const row1 = String.fromCharCode(...c.slice(16, 32));

      expect(row0.startsWith('Time:')).toBe(true);

      // row 1 should be "HH:MM:SS" padded with spaces.
      const time = row1.slice(0, 8);
      expect(time).toMatch(/^\d{2}:\d{2}:\d{2}$/);

      // Sanity: hours/minutes/seconds are in valid ranges.
      const [hh, mm, ss] = time.split(':').map((s) => parseInt(s, 10));
      expect(hh).toBeGreaterThanOrEqual(0);
      expect(hh).toBeLessThanOrEqual(23);
      expect(mm).toBeGreaterThanOrEqual(0);
      expect(mm).toBeLessThanOrEqual(59);
      expect(ss).toBeGreaterThanOrEqual(0);
      expect(ss).toBeLessThanOrEqual(59);

      // Compare against host clock — should be within ~5 s
      // (test runtime + I2C overhead).
      const now = new Date();
      const displayedSecondsOfDay = hh * 3600 + mm * 60 + ss;
      const nowSecondsOfDay =
        now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
      const drift = Math.abs(displayedSecondsOfDay - nowSecondsOfDay);
      // Allow for day rollover at midnight.
      expect(Math.min(drift, 86400 - drift)).toBeLessThan(10);

      detach();
    });
  },
);

// ─── 3. Multi-board BMP280 via bridge ────────────────────────────────────────

describe.runIf(ARDUINO_CLI_AVAILABLE)(
  'I2C scenario — Uno reads BMP280 chip_id from a bridged peer bus',
  () => {
    let HEX: string;
    beforeAll(() => {
      HEX = compileSketch('bmp280_bridge_reader');
    });

    it('returns the BMP280 chip_id (0x58) and status (0x00) over the shared net', () => {
      const sim = unoBoard(HEX);
      peerUno();
      // The BMP280 sits on the peer's header, whose A4/A5 are wired to the
      // Uno's: the net reaches both boards, so the fabric puts the chip on
      // both buses and the Uno's master finds it.
      const [sda, scl] = UNO_I2C('uno');
      const [psda, pscl] = UNO_I2C('peer');
      putI2cDevice(new VirtualBMP280(0x76), [psda, sda], [pscl, scl]);

      const out: number[] = [];
      sim.onSerialData = (ch) => out.push(ch.charCodeAt(0));

      runUntil(sim, 2_000_000, () => out.length >= 2);

      expect(out[0]).toBe(0x58); // BMP280 production chip_id
      expect(out[1]).toBe(0x00); // status: measurement complete
    });

    it('returns NACK behaviour with nothing on the net', () => {
      // Cold simulator — no devices anywhere.  The sketch should still
      // complete (Wire.requestFrom NACKs and returns 0 bytes), and Serial
      // output should be empty since `if (Wire.available())` gates the
      // writes.
      const sim = unoBoard(HEX);

      const out: number[] = [];
      sim.onSerialData = (ch) => out.push(ch.charCodeAt(0));

      // Run long enough for setup() to complete entirely.
      runUntil(sim, 2_000_000, () => false);

      // No bytes should have been emitted.  This proves the
      // sketch's `if (Wire.available())` guards behave correctly
      // — meaning the bus genuinely NACKed when no device matched.
      expect(out).toEqual([]);
    });
  },
);

// ─── 4. PCF8574 bidirectional I/O on a single device ─────────────────────────

describe.runIf(ARDUINO_CLI_AVAILABLE)(
  'I2C scenario — PCF8574 bidirectional read+write round-trips',
  () => {
    let HEX: string;
    beforeAll(() => {
      HEX = compileSketch('pcf8574_bidirectional');
    });

    it('round-trips three different patterns through the same device', () => {
      const sim = unoBoard(HEX);

      const pcf = new VirtualPCF8574(0x27);
      // Default portState = 0xFF (everything externally pulled
      // high), so reads should mirror outputLatch.
      const [sda, scl] = UNO_I2C('uno');
      putI2cDevice(pcf, sda, scl);

      const out: number[] = [];
      sim.onSerialData = (ch) => out.push(ch.charCodeAt(0));

      runUntil(sim, 1_500_000, () => out.length >= 3);

      expect(out[0]).toBe(0xaa);
      expect(out[1]).toBe(0x55);
      expect(out[2]).toBe(0xff);
      // After the last write the latch should hold 0xFF.
      expect(pcf.outputLatch).toBe(0xff);
    });

    it('external input wins when output latch is HIGH (open-drain semantics)', () => {
      const sim = unoBoard(HEX);

      const pcf = new VirtualPCF8574(0x27);
      // External inputs hold lower nibble LOW.  After the sketch
      // releases everything with 0xFF, the read-back should reflect
      // those external lows.
      pcf.portState = 0b11110000;
      const [sda, scl] = UNO_I2C('uno');
      putI2cDevice(pcf, sda, scl);

      const out: number[] = [];
      sim.onSerialData = (ch) => out.push(ch.charCodeAt(0));

      runUntil(sim, 1_500_000, () => out.length >= 3);

      // Round 1: write 0xAA (10101010), AND with portState (11110000)
      //   = 10100000 = 0xA0
      // Round 2: write 0x55 (01010101), AND with 11110000
      //   = 01010000 = 0x50
      // Round 3: write 0xFF, AND with 11110000 = 11110000 = 0xF0
      expect(out[0]).toBe(0xa0);
      expect(out[1]).toBe(0x50);
      expect(out[2]).toBe(0xf0);
    });
  },
);

// ─── 5. Cross-architecture: Pi Pico master reads BMP280 via bridge ──────────
//
// The Pico runs a REAL compiled rp2040 binary (earlephilhower core)
// driven by rp2040js.  Its Wire master TWI talks to a BMP280 that
// lives on a peer board's I2C bus through the cross-board bridge.
//
// This is the ultimate cross-architecture test: AVR firmware → no.
// Real ARM Cortex-M0+ firmware → yes.  Proves the I2CBusManager +
// bridge work uniformly across both simulator backends.

const RP2040_CORE_AVAILABLE = (() => {
  if (!ARDUINO_CLI_AVAILABLE) return false;
  const r = spawnSync('arduino-cli', ['core', 'list'], { encoding: 'utf-8' });
  return r.status === 0 && /rp2040:rp2040/.test(r.stdout);
})();

describe.runIf(RP2040_CORE_AVAILABLE)(
  'I2C scenario — Pi Pico (real RP2040 firmware) reads BMP280 via bridge',
  () => {
    let BIN_B64: string;
    // First-time RP2040 compile pulls in the picotool + GCC toolchain
    // and takes ~60 s on a cold cache.  Subsequent runs hit the
    // in-tmpdir hash cache and complete in <50 ms.
    beforeAll(() => {
      BIN_B64 = compileSketch('pico_i2c_master_reader', 'rp2040:rp2040:rpipico');
    }, 300_000);

    it('master on rp2040js reaches the BMP280 wired to a peer board over the shared net', () => {
      const pm = new PinManager();
      const sim = new RP2040Simulator(pm);
      bareBoard('pico', 'raspberry-pi-pico', sim);
      sim.loadBinary(BIN_B64);

      // The peer board holds the BMP280; its A4/A5 are wired to the Pico's
      // GP4/GP5 (Wire), so the chip is on the Pico's I2C0 bus too.
      peerUno();
      const [sda, scl] = PICO_I2C('pico');
      const [psda, pscl] = UNO_I2C('peer');
      putI2cDevice(new VirtualBMP280(0x76), [psda, sda], [pscl, scl]);

      const out: number[] = [];
      sim.onSerialData = (ch) => out.push(ch.charCodeAt(0));

      // Step the Pico CPU.  Earle's core init + Wire.begin +
      // Serial1.begin + delay(100) + 4 transactions takes a fair
      // chunk of cycles.  125 MHz × 200 ms = 25 M cycles is a
      // generous ceiling for the happy path; we exit early once
      // both expected bytes are received.
      const maxCycles = 60_000_000;
      let consumed = 0;
      while (consumed < maxCycles && out.length < 2) {
        consumed += sim.stepCycles(100_000);
      }

      expect(out[0]).toBe(0x58); // BMP280 chip_id
      expect(out[1]).toBe(0x00); // status
    });
  },
);

// ─── Skip notices ────────────────────────────────────────────────────────────

describe.skipIf(ARDUINO_CLI_AVAILABLE)('I2C scenarios — skipped (no arduino-cli)', () => {
  it('install arduino-cli to enable the complex scenarios', () => {
    expect(true).toBe(true);
  });
});

describe.skipIf(LIQUID_CRYSTAL_I2C_AVAILABLE || !ARDUINO_CLI_AVAILABLE)(
  'I2C scenarios — LCD scenarios skipped (no LiquidCrystal_I2C)',
  () => {
    it('run: arduino-cli lib install "LiquidCrystal_I2C"', () => {
      expect(true).toBe(true);
    });
  },
);

describe.skipIf(RP2040_CORE_AVAILABLE || !ARDUINO_CLI_AVAILABLE)(
  'I2C scenarios — Pico scenarios skipped (no rp2040 core)',
  () => {
    it('run: arduino-cli core install rp2040:rp2040 (earlephilhower URL required)', () => {
      expect(true).toBe(true);
    });
  },
);
