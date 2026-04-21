/**
 * pong-emulation.test.ts
 *
 * Full end-to-end test of the pong Wokwi example:
 *
 *  1. Compile pong.ino with arduino-cli (arduino:avr:nano)
 *  2. Load the resulting .hex into AVRSimulator
 *  3. Attach a VirtualSSD1306 to the I2C bus (address 0x3C)
 *  4. Run ~1 second of simulated time (16 000 000 cycles)
 *  5. Simulate UP/DOWN button presses (D2 / D3, active-LOW INPUT_PULLUP)
 *  6. Assert the SSD1306 display has received pixel data
 *  7. Print an ASCII-art snapshot of the display to the console
 *
 * Requirements:
 *  - arduino-cli in PATH
 *  - "arduino:avr" core installed
 *  - Adafruit SSD1306 + Adafruit GFX libraries installed
 *
 * The test compiles pong once, caches the hex in a temp file, and reuses it.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';
import type { I2CDevice } from '../simulation/I2CBusManager';

// ─── ImageData polyfill (Node / Vitest) ──────────────────────────────────────

if (typeof globalThis.ImageData === 'undefined') {
  class ImageDataPoly {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
      this.data = new Uint8ClampedArray(w * h * 4);
    }
  }
  (globalThis as any).ImageData = ImageDataPoly;
}

// ─── RAF stub ────────────────────────────────────────────────────────────────

vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => 1);
vi.stubGlobal('cancelAnimationFrame', vi.fn());

// ─── Paths ────────────────────────────────────────────────────────────────────

const PONG_INO = resolve(__dirname, '../../../example_zip/extracted/pong/pong.ino');

// ─── arduino-cli availability ─────────────────────────────────────────────────

const ARDUINO_CLI_AVAILABLE = (() => {
  const r = spawnSync('arduino-cli', ['version'], { encoding: 'utf-8' });
  return r.error == null && r.status === 0;
})();

// ─── Compile helper ──────────────────────────────────────────────────────────

const HEX_CACHE = join(tmpdir(), 'velxio-pong-nano.hex');

function compileSketch(): string {
  // Return cached hex if we already compiled
  if (existsSync(HEX_CACHE)) {
    console.log('[compile] Using cached hex:', HEX_CACHE);
    return readFileSync(HEX_CACHE, 'utf-8');
  }

  console.log('[compile] Compiling pong.ino for Arduino Nano…');

  // arduino-cli requires: folder name === sketch name (pong/pong.ino)
  // Create a temp PARENT, then a "pong" subdirectory inside it
  const workDir = mkdtempSync(join(tmpdir(), 'velxio-pong-'));
  const sketchDir = join(workDir, 'pong');
  mkdirSync(sketchDir);
  writeFileSync(join(sketchDir, 'pong.ino'), readFileSync(PONG_INO, 'utf-8'));

  const buildDir = join(workDir, 'build');
  mkdirSync(buildDir);

  const result = spawnSync(
    'arduino-cli',
    ['compile', '--fqbn', 'arduino:avr:nano:cpu=atmega328old', '--build-path', buildDir, sketchDir],
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

  // Find the .hex file in buildDir (prefer pong.ino.hex, not the bootloader variant)
  let hexPath: string | null = null;
  for (const f of ['pong.ino.hex', 'sketch.ino.hex', 'pong.hex']) {
    const p = join(buildDir, f);
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
  writeFileSync(HEX_CACHE, hex); // cache for next run
  rmSync(workDir, { recursive: true }); // cleanup
  console.log('[compile] Done. Hex size:', hex.length, 'chars');
  return hex;
}

// ─── Minimal VirtualSSD1306 (standalone — no DOM/PartRegistry needed) ────────

class HeadlessSSD1306 implements I2CDevice {
  address = 0x3c;
  buffer = new Uint8Array(128 * 8); // GDDRAM 1-bit
  renderCount = 0;

  private ctrlByte = true;
  private isData = false;
  private col = 0;
  page = 0;
  private colStart = 0;
  colEnd = 127;
  private pageStart = 0;
  pageEnd = 7;
  private memMode = 0;
  private cmdBuf: number[] = [];
  private cmdWant = 0;

  private static cmdParams(cmd: number): number {
    if ([0x20, 0x81, 0x8d, 0xa8, 0xd3, 0xd5, 0xd8, 0xd9, 0xda, 0xdb].includes(cmd)) return 1;
    if (cmd === 0x21 || cmd === 0x22) return 2;
    return 0;
  }

  writeByte(value: number): boolean {
    if (this.ctrlByte) {
      this.isData = (value & 0x40) !== 0;
      this.ctrlByte = false;
      this.cmdBuf = [];
      this.cmdWant = 0;
      return true;
    }
    if (this.isData) {
      this.buffer[this.page * 128 + this.col] = value;
      this.advance();
      return true;
    }
    if (this.cmdWant > 0) {
      this.cmdBuf.push(value);
      this.cmdWant--;
      if (this.cmdWant === 0) this.applyCmd();
      return true;
    }
    this.cmdBuf = [value];
    this.cmdWant = HeadlessSSD1306.cmdParams(value);
    if (this.cmdWant === 0) this.applyCmd();
    return true;
  }

  private applyCmd(): void {
    const [cmd, p1, p2] = this.cmdBuf;
    if (cmd === 0x20) {
      this.memMode = p1 & 0x03;
    } else if (cmd === 0x21) {
      this.colStart = p1 & 0x7f;
      this.colEnd = p2 & 0x7f;
      this.col = this.colStart;
    } else if (cmd === 0x22) {
      this.pageStart = p1 & 0x07;
      this.pageEnd = p2 & 0x07;
      this.page = this.pageStart;
    }
  }

  private advance(): void {
    if (this.memMode === 0) {
      if (++this.col > this.colEnd) {
        this.col = this.colStart;
        if (++this.page > this.pageEnd) this.page = this.pageStart;
      }
    } else if (this.memMode === 1) {
      if (++this.page > this.pageEnd) {
        this.page = this.pageStart;
        if (++this.col > this.colEnd) this.col = this.colStart;
      }
    } else {
      if (++this.col > this.colEnd) this.col = this.colStart;
    }
  }

  readByte(): number {
    return 0xff;
  }

  stop(): void {
    this.ctrlByte = true;
    this.renderCount++;
  }

  /** True if any pixel in the buffer is set */
  hasPixels(): boolean {
    return this.buffer.some((b) => b !== 0);
  }

  /** Count of lit pixels across all 128×64 = 8192 pixels */
  litPixelCount(): number {
    let n = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      let b = this.buffer[i];
      while (b) {
        n += b & 1;
        b >>= 1;
      }
    }
    return n;
  }

  /** Render the GDDRAM as ASCII art (# = lit, space = off) */
  toAsciiArt(): string {
    const lines: string[] = [];
    for (let row = 0; row < 64; row += 2) {
      // 2 rows per line to keep compact
      let line = '';
      for (let col = 0; col < 128; col++) {
        const page = Math.floor(row / 8);
        const bit = row % 8;
        const lit = (this.buffer[page * 128 + col] >> bit) & 1;
        line += lit ? '█' : ' ';
      }
      lines.push(line);
    }
    return lines.join('\n');
  }
}

// ─── Run N cycles ─────────────────────────────────────────────────────────────

function runCycles(sim: AVRSimulator, cycles: number): void {
  for (let i = 0; i < cycles; i++) sim.step();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe.skipIf(!ARDUINO_CLI_AVAILABLE)('Pong emulation — full end-to-end', () => {
  let hexContent: string;
  let sim: AVRSimulator;
  let oled: HeadlessSSD1306;

  beforeAll(() => {
    // Compile (or load cached)
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

  it('🔧 compiles pong.ino successfully', () => {
    expect(hexContent).toBeTruthy();
    expect(hexContent).toContain(':'); // valid Intel HEX starts with ':'
    console.log('[hex] First line:', hexContent.split('\n')[0]);
  });

  it('🖥️  boots: SSD1306 init commands fire in the first 2M cycles', () => {
    const pm = new PinManager();
    sim = new AVRSimulator(pm);
    sim.loadHex(hexContent);

    oled = new HeadlessSSD1306();
    sim.i2cBus!.addDevice(oled);

    // 2 million cycles ≈ 125ms simulated.
    // The SSD1306 init sequence + first display.display() (Adafruit splash)
    // completes in this window — gives us ~20-50 I2C STOP events.
    runCycles(sim, 2_000_000);

    console.log(`[boot] I2C STOP count after 2M cycles: ${oled.renderCount}`);
    expect(oled.renderCount).toBeGreaterThan(20); // init commands alone = ~25+
  });

  it("🎮 game loop starts after pong's 2-second setup wait (~35M more cycles)", () => {
    // pong.ino setup(): while(millis() - start < 2000) { } — pure spinning.
    // At 16MHz: 2000ms × 16,000 cycles/ms = 32,000,000 cycles to wait through.
    // After that, game loop runs: ball updated every 16ms, paddle every 64ms.
    const rendersBeforeWait = oled.renderCount;

    runCycles(sim, 35_000_000); // clears 2s spin + a few hundred ms of gameplay

    const newRenders = oled.renderCount - rendersBeforeWait;
    console.log(`[game] New renders after passing 2s wait: ${newRenders}`);
    console.log(`[game] Total I2C STOP count: ${oled.renderCount}`);
    console.log(`[game] Lit pixels: ${oled.litPixelCount()} / 8192`);

    // After the spin loop, setup calls display.display() once more (the court),
    // and the game loop starts calling display.display() every 16–64ms.
    expect(newRenders).toBeGreaterThan(0);
    expect(oled.hasPixels()).toBe(true);
  });

  it('📺 display shows game content ≥50 lit pixels', () => {
    console.log(`[display] Lit pixels: ${oled.litPixelCount()} / 8192`);
    expect(oled.litPixelCount()).toBeGreaterThan(50);
  });

  it('🕹️  UP button press (D2 LOW, INPUT_PULLUP) updates display', () => {
    const pixelsBefore = oled.litPixelCount();
    const rendersBefore = oled.renderCount;

    // Press UP button (D2 = pin 2, active LOW INPUT_PULLUP).
    // Run 3M cycles while held (~188ms simulated = ~11 paddle updates @ 64ms each).
    sim.setPinState(2, false); // pressed
    runCycles(sim, 3_000_000);
    sim.setPinState(2, true); // released
    runCycles(sim, 500_000);

    const pixelsAfter = oled.litPixelCount();
    console.log(`[UP btn] pixels before: ${pixelsBefore} → after: ${pixelsAfter}`);
    console.log(`[UP btn] new renders: ${oled.renderCount - rendersBefore}`);

    // After a button press, the paddle moves and the frame is re-drawn
    expect(oled.renderCount).toBeGreaterThan(rendersBefore);
  });

  it('🕹️  DOWN button press (D3 LOW) also triggers display updates', () => {
    const rendersBefore = oled.renderCount;

    sim.setPinState(3, false); // DOWN pressed
    runCycles(sim, 3_000_000);
    sim.setPinState(3, true); // released
    runCycles(sim, 500_000);

    console.log(`[DOWN btn] new renders: ${oled.renderCount - rendersBefore}`);
    expect(oled.renderCount).toBeGreaterThan(rendersBefore);
  });

  it('🖼️  prints final display frame as ASCII art', () => {
    // Run a bit more so we get a fresh full frame
    runCycles(sim, 2_000_000);

    const art = oled.toAsciiArt();
    console.log('\n── Pong display snapshot (128×32 ASCII) ──');
    console.log(art);
    console.log('──────────────────────────────────────────');
    console.log(`Total lit pixels: ${oled.litPixelCount()}`);

    expect(art.length).toBeGreaterThan(0);
  });
});
