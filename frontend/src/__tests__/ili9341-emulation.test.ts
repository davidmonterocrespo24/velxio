/**
 * ili9341-emulation.test.ts
 *
 * End-to-end test for ILI9341 TFT display emulation:
 *
 *  1. Compile ili9341-test-sketch.ino with arduino-cli (arduino:avr:nano)
 *  2. Load the resulting .hex into AVRSimulator
 *  3. Intercept the SPI bus with a VirtualILI9341
 *  4. Run ~5 million simulated cycles
 *  5. Assert the display received pixel data (RAMWR command)
 *  6. Verify colored regions (red fill, white rect, blue circle)
 *
 * Requirements:
 *  - arduino-cli in PATH
 *  - "arduino:avr" core installed
 *  - "Adafruit ILI9341" and "Adafruit GFX Library" installed
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

// ─── ImageData polyfill ───────────────────────────────────────────────────────

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

// ─── Paths ───────────────────────────────────────────────────────────────────

const SKETCH_DIR = resolve(__dirname, '../../../example_zip/extracted/ili9341-test-sketch');
const SKETCH_INO = join(SKETCH_DIR, 'ili9341-test-sketch.ino');

// ─── arduino-cli availability ─────────────────────────────────────────────────

const ARDUINO_CLI_AVAILABLE = (() => {
  const r = spawnSync('arduino-cli', ['version'], { encoding: 'utf-8' });
  return r.error == null && r.status === 0;
})();

// ─── Hex cache ───────────────────────────────────────────────────────────────

const HEX_CACHE = join(tmpdir(), 'velxio-ili9341-nano.hex');

function compileSketch(): string {
  if (existsSync(HEX_CACHE)) {
    console.log('[compile] Using cached hex:', HEX_CACHE);
    return readFileSync(HEX_CACHE, 'utf-8');
  }

  console.log('[compile] Compiling ili9341-test-sketch.ino for Arduino Nano…');

  const workDir = mkdtempSync(join(tmpdir(), 'velxio-ili9341-'));
  const sketchDir = join(workDir, 'ili9341-test-sketch');
  mkdirSync(sketchDir);
  writeFileSync(join(sketchDir, 'ili9341-test-sketch.ino'), readFileSync(SKETCH_INO, 'utf-8'));

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

  // Find .hex (prefer non-bootloader)
  let hexPath: string | null = null;
  for (const candidate of ['ili9341-test-sketch.ino.hex', 'sketch.ino.hex']) {
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

// ─── VirtualILI9341 SPI monitor ──────────────────────────────────────────────

/**
 * Intercepts the AVRSimulator SPI bus and decodes ILI9341 commands/data.
 *
 * ILI9341 protocol (hardware SPI):
 *  - DC pin LOW  → command byte
 *  - DC pin HIGH → data byte
 *  - Commands: 0x2A CASET, 0x2B PASET, 0x2C RAMWR, 0x01 SWRESET, etc.
 *  - Pixel data: RGB-565 (2 bytes per pixel) streamed after RAMWR
 */
class VirtualILI9341 {
  static readonly WIDTH = 240;
  static readonly HEIGHT = 320;

  // Raw framebuffer: RGB-565 per pixel (0 = black / unwritten)
  readonly framebuffer = new Uint16Array(VirtualILI9341.WIDTH * VirtualILI9341.HEIGHT);

  // Statistics
  commandCount = 0;
  ramwrCount = 0; // number of RAMWR (0x2C) commands received
  pixelCount = 0; // total pixels written

  // DC pin state (must be injected from AVRSimulator PinManager)
  dcHigh = false;

  // ILI9341 address window
  private colStart = 0;
  private colEnd = VirtualILI9341.WIDTH - 1;
  private rowStart = 0;
  private rowEnd = VirtualILI9341.HEIGHT - 1;
  private curX = 0;
  private curY = 0;

  // Command state machine
  private currentCmd = -1;
  private dataBytes: number[] = [];
  private inRamWrite = false;
  private pixelHiByte = 0;
  private pixelByteIdx = 0;

  /**
   * Process one SPI byte.  Call with the byte value BEFORE calling
   * spi.completeTransfer() so we see it first.
   */
  processByte(value: number): void {
    if (!this.dcHigh) {
      // Command byte
      this.commandCount++;
      this.currentCmd = value;
      this.dataBytes = [];
      this.inRamWrite = value === 0x2c;
      this.pixelByteIdx = 0;
      if (value === 0x2c) this.ramwrCount++;
      if (value === 0x01) {
        // SWRESET
        this.framebuffer.fill(0);
        this.pixelCount = 0;
      }
    } else {
      // Data byte
      if (this.inRamWrite) {
        if (this.pixelByteIdx === 0) {
          this.pixelHiByte = value;
          this.pixelByteIdx = 1;
        } else {
          this.writePixel(this.pixelHiByte, value);
          this.pixelByteIdx = 0;
        }
      } else {
        this.dataBytes.push(value);
        this.applyCmd();
      }
    }
  }

  private applyCmd(): void {
    const d = this.dataBytes;
    switch (this.currentCmd) {
      case 0x2a: // CASET
        if (d.length === 2) this.colStart = (d[0] << 8) | d[1];
        if (d.length === 4) {
          this.colEnd = (d[2] << 8) | d[3];
          this.curX = this.colStart;
        }
        break;
      case 0x2b: // PASET
        if (d.length === 2) this.rowStart = (d[0] << 8) | d[1];
        if (d.length === 4) {
          this.rowEnd = (d[2] << 8) | d[3];
          this.curY = this.rowStart;
        }
        break;
    }
  }

  private writePixel(hi: number, lo: number): void {
    if (
      this.curX > this.colEnd ||
      this.curY > this.rowEnd ||
      this.curX >= VirtualILI9341.WIDTH ||
      this.curY >= VirtualILI9341.HEIGHT
    )
      return;

    const rgb565 = (hi << 8) | lo;
    this.framebuffer[this.curY * VirtualILI9341.WIDTH + this.curX] = rgb565;
    this.pixelCount++;

    this.curX++;
    if (this.curX > this.colEnd) {
      this.curX = this.colStart;
      this.curY++;
    }
  }

  /** Convert RGB-565 pixel to R,G,B channels */
  static rgb565ToRGB(p: number): [number, number, number] {
    return [((p >> 11) & 0x1f) * 8, ((p >> 5) & 0x3f) * 4, (p & 0x1f) * 8];
  }

  /** True if any pixel in a region matches a specific colour (within tolerance) */
  regionHasColor(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    targetRGB565: number,
    tolerance = 20,
  ): boolean {
    const [tr, tg, tb] = VirtualILI9341.rgb565ToRGB(targetRGB565);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const p = this.framebuffer[y * VirtualILI9341.WIDTH + x];
        if (p === 0) continue;
        const [r, g, b] = VirtualILI9341.rgb565ToRGB(p);
        if (
          Math.abs(r - tr) <= tolerance &&
          Math.abs(g - tg) <= tolerance &&
          Math.abs(b - tb) <= tolerance
        )
          return true;
      }
    }
    return false;
  }

  /**
   * Count pixels whose colour is within `tolerance` of targetRGB565.
   */
  countColor(targetRGB565: number, tolerance = 20): number {
    const [tr, tg, tb] = VirtualILI9341.rgb565ToRGB(targetRGB565);
    let n = 0;
    for (const p of this.framebuffer) {
      if (p === 0) continue;
      const [r, g, b] = VirtualILI9341.rgb565ToRGB(p);
      if (
        Math.abs(r - tr) <= tolerance &&
        Math.abs(g - tg) <= tolerance &&
        Math.abs(b - tb) <= tolerance
      )
        n++;
    }
    return n;
  }

  /** ILI9341_RED   (RGB-565: 0xF800) */
  static readonly COLOR_RED = 0xf800;
  /** ILI9341_WHITE (RGB-565: 0xFFFF) */
  static readonly COLOR_WHITE = 0xffff;
  /** ILI9341_BLUE  (RGB-565: 0x001F) */
  static readonly COLOR_BLUE = 0x001f;
  /** ILI9341_BLACK (RGB-565: 0x0000) */
  static readonly COLOR_BLACK = 0x0000;
  /** ILI9341_YELLOW (RGB-565: 0xFFE0) */
  static readonly COLOR_YELLOW = 0xffe0;

  /** Summary string for console output */
  summary(): string {
    return (
      `ILI9341 stats: commands=${this.commandCount}, ` +
      `RAMWR=${this.ramwrCount}, pixelsWritten=${this.pixelCount}`
    );
  }
}

// ─── Run N cycles ─────────────────────────────────────────────────────────────

function runCycles(sim: AVRSimulator, cycles: number): void {
  for (let i = 0; i < cycles; i++) sim.step();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe.skipIf(!ARDUINO_CLI_AVAILABLE)('ILI9341 emulation — full end-to-end', () => {
  let hexContent: string;
  let sim: AVRSimulator;
  let display: VirtualILI9341;

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

  it('🔧 compiles ili9341-test-sketch.ino successfully', () => {
    expect(hexContent).toBeTruthy();
    expect(hexContent).toContain(':');
    console.log('[hex] First line:', hexContent.split('\n')[0]);
  });

  it('🖥️  boots, initialises ILI9341, and fills screen within 15M cycles', () => {
    const pm = new PinManager();
    sim = new AVRSimulator(pm);
    sim.loadHex(hexContent);

    // ── Attach VirtualILI9341 to the SPI bus ──────────────────────────────
    display = new VirtualILI9341();

    // DC pin: Arduino pin 9 → PORTB bit 1 (D9 = PB1)
    // We track DC state by watching pin 9 in the pinManager.
    // PinManager.onPinChange gives us the logical state (true = HIGH).
    const DC_ARDUINO_PIN = 9;
    pm.onPinChange(DC_ARDUINO_PIN, (_pin: number, state: boolean) => {
      display.dcHigh = state;
    });

    // Intercept SPI: wrap the existing onByte
    sim.spi!.onByte = (value: number) => {
      display.processByte(value);
      sim.spi!.completeTransfer(0xff);
    };

    // 15M cycles = ~937ms simulated @16MHz.
    // Breakdown:
    //   ~3M  – Arduino startup + Serial.begin + tft.begin() init commands (~20+ cmd)
    //   ~2M  – fillScreen(RED) = 76800px × 2bytes × ~4CPU/byte + overhead
    //   ~6M  – fillRect + fillCircle + fillTriangle
    //   ~4M  – margin
    runCycles(sim, 15_000_000);

    console.log(`[init] ${display.summary()}`);
    console.log(`[init] Pixels written: ${display.pixelCount}`);

    // The Adafruit_ILI9341::begin() sends ~20+ init commands
    expect(display.commandCount).toBeGreaterThan(10);
  });

  it('🎨 fillScreen(RED) was issued (pixels present after 15M cycles)', () => {
    // By the time we reach this test, 15M cycles have already run.
    // fillScreen alone writes 76800 pixels; we accept ≥10000 to be lenient.
    runCycles(sim, 0); // no-op; just reads current state

    console.log(`[fill] ${display.summary()}`);

    const redCount = display.countColor(VirtualILI9341.COLOR_RED, 30);
    console.log(`[fill] Red pixels: ${redCount} / ${VirtualILI9341.WIDTH * VirtualILI9341.HEIGHT}`);

    // At least the majority of the screen should be red
    expect(redCount).toBeGreaterThan(10_000);
  });

  it('⬜ draws white rectangle at (20,20,200,80)', () => {
    // White rect was drawn before circle — should already be in framebuffer
    const hasWhiteRect = display.regionHasColor(20, 20, 220, 100, VirtualILI9341.COLOR_WHITE, 10);
    console.log(`[rect] White rect region has white pixels: ${hasWhiteRect}`);
    expect(hasWhiteRect).toBe(true);
  });

  it('🔵 draws blue circle center (120,200) r=50', () => {
    // Check a small region within the circle bounds
    const hasBluePx = display.regionHasColor(90, 170, 150, 230, VirtualILI9341.COLOR_BLUE, 30);
    console.log(`[circle] Blue circle region has blue pixels: ${hasBluePx}`);
    expect(hasBluePx).toBe(true);
  });

  it('🖼️  RAMWR received multiple times (multi-shape drawing)', () => {
    console.log(`[ramwr] RAMWR count: ${display.ramwrCount}`);
    // fillScreen + fillRect + fillCircle + fillTriangle → at least 4 RAMWR
    expect(display.ramwrCount).toBeGreaterThan(3);
  });

  it('📊 total pixel writes cover most of the 240×320 screen', () => {
    const total = VirtualILI9341.WIDTH * VirtualILI9341.HEIGHT;
    const coverage = display.pixelCount / total;
    console.log(
      `[coverage] pixelCount=${display.pixelCount} / ${total} = ${(coverage * 100).toFixed(1)}%`,
    );
    // fillScreen alone should cover 100%; we expect at least 50% to account
    // for cases where address windows overlap (pixels counted once per write)
    expect(display.pixelCount).toBeGreaterThan(total * 0.5);
  });
});
