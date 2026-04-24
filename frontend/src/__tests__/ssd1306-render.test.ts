/**
 * ssd1306-render.test.ts
 *
 * Tests the SSD1306 OLED simulation's rendering path:
 *   - GDDRAM is filled correctly via I2C writes
 *   - syncElement() converts 1-bit GDDRAM → RGBA ImageData
 *   - element.imageData is updated and element.redraw() is called
 *
 * This covers the bug fix where syncElement() was calling el.buffer /
 * el.renderFrame() (non-existent) instead of el.imageData / el.redraw().
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
// Barrel import seeds built-in parts via `registerCoreParts()` (CORE-002c-step2).
import { PartSimulationRegistry } from '../simulation/parts';

// ─── Polyfill ImageData for Node/Vitest (no browser) ─────────────────────────

beforeAll(() => {
  if (typeof globalThis.ImageData === 'undefined') {
    class ImageDataPolyfill {
      readonly width: number;
      readonly height: number;
      readonly data: Uint8ClampedArray;

      constructor(widthOrData: number | Uint8ClampedArray, height: number) {
        if (typeof widthOrData === 'number') {
          this.width = widthOrData;
          this.height = height;
          this.data = new Uint8ClampedArray(widthOrData * height * 4);
        } else {
          this.width = widthOrData.length / 4 / height;
          this.height = height;
          this.data = new Uint8ClampedArray(widthOrData);
        }
      }
    }
    (globalThis as any).ImageData = ImageDataPolyfill;
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a mock wokwi-ssd1306 element with the real ImageData API. */
function makeOLEDElement() {
  const imageData = new ImageData(128, 64);
  const redraw = vi.fn();
  return {
    imageData,
    redraw,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as HTMLElement & { imageData: ImageData; redraw: ReturnType<typeof vi.fn> };
}

/** Build a minimal AVR simulator stub that supports addI2CDevice. */
function makeSim() {
  const devices: any[] = [];
  return {
    addI2CDevice: vi.fn((d: any) => devices.push(d)),
    i2cBus: { removeDevice: vi.fn() },
    _devices: devices,
  };
}

/**
 * Simulate the Adafruit SSD1306 library's I2C init + fill sequence.
 *
 * The library sends:
 *   START → addr 0x3C write → 0x00 (cmd ctrl) → [commands…] → STOP
 *   START → addr 0x3C write → 0x40 (data ctrl) → [data…] → STOP
 *
 * In our model the I2CBusManager calls device.writeByte() for every byte
 * after the address phase, starting with the control byte.
 */
function sendCommandStream(device: any, cmds: number[]) {
  device.writeByte(0x00); // control byte: command stream (Co=0, D/C#=0)
  for (const b of cmds) device.writeByte(b);
  device.stop();
}

function sendDataStream(device: any, data: number[]) {
  device.writeByte(0x40); // control byte: GDDRAM data
  for (const b of data) device.writeByte(b);
  device.stop();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SSD1306 — ImageData rendering (syncElement fix)', () => {
  it('registers ssd1306 in PartSimulationRegistry', () => {
    expect(PartSimulationRegistry.get('ssd1306')).toBeDefined();
  });

  it('creates a VirtualSSD1306 device at address 0x3C', () => {
    const el = makeOLEDElement();
    const sim = makeSim();
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(el, sim as any, () => null);
    expect(sim.addI2CDevice).toHaveBeenCalledOnce();
    expect(sim._devices[0].address).toBe(0x3c);
  });

  it('calls element.redraw() after a STOP', () => {
    const el = makeOLEDElement();
    const sim = makeSim();
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(el, sim as any, () => null);
    const device = sim._devices[0];

    // Simple data write — fill first byte
    sendDataStream(device, [0xff]);

    expect(el.redraw).toHaveBeenCalled();
  });

  it('renders a fully-lit column 0 of page 0 (0xFF → top 8 pixels lit)', () => {
    const el = makeOLEDElement();
    const sim = makeSim();
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(el, sim as any, () => null);
    const device = sim._devices[0];

    // Set horizontal addressing, col 0–127, page 0–7
    sendCommandStream(device, [
      0x20,
      0x00, // horizontal addressing mode
      0x21,
      0x00,
      0x7f, // col 0–127
      0x22,
      0x00,
      0x07, // page 0–7
    ]);

    // Write 0xFF to column 0 of page 0 → all 8 bits set → rows 0–7, col 0 lit
    sendDataStream(device, [0xff]);

    const px = el.imageData.data; // RGBA

    // Row 0, col 0 → pixel index 0
    const idx = (0 * 128 + 0) * 4;
    expect(px[idx + 3]).toBe(255); // alpha = 255 (opaque)
    expect(px[idx] + px[idx + 1] + px[idx + 2]).toBeGreaterThan(0); // not black

    // Row 7, col 0 → pixel index (7 * 128 + 0) * 4
    const idx7 = (7 * 128 + 0) * 4;
    expect(px[idx7 + 3]).toBe(255);
    expect(px[idx7] + px[idx7 + 1] + px[idx7 + 2]).toBeGreaterThan(0);
  });

  it('renders an unlit pixel as black (RGB = 0)', () => {
    const el = makeOLEDElement();
    const sim = makeSim();
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(el, sim as any, () => null);
    const device = sim._devices[0];

    sendCommandStream(device, [0x20, 0x00, 0x21, 0x00, 0x7f, 0x22, 0x00, 0x07]);
    // 0x01 → only bit 0 set → only row 0 of page 0 is lit; row 1 is off
    sendDataStream(device, [0x01]);

    const px = el.imageData.data;

    // Row 0 col 0 → lit
    const idxLit = (0 * 128 + 0) * 4;
    expect(px[idxLit] + px[idxLit + 1] + px[idxLit + 2]).toBeGreaterThan(0);

    // Row 1 col 0 → unlit (bit 1 of 0x01 = 0)
    const idxOff = (1 * 128 + 0) * 4;
    expect(px[idxOff]).toBe(0);
    expect(px[idxOff + 1]).toBe(0);
    expect(px[idxOff + 2]).toBe(0);
  });

  it('fills all 1024 GDDRAM bytes via horizontal addressing', () => {
    const el = makeOLEDElement();
    const sim = makeSim();
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(el, sim as any, () => null);
    const device = sim._devices[0];

    sendCommandStream(device, [0x20, 0x00, 0x21, 0x00, 0x7f, 0x22, 0x00, 0x07]);

    // Fill all 1024 GDDRAM bytes with a checkerboard pattern (0xAA / 0x55)
    const data: number[] = [];
    for (let i = 0; i < 1024; i++) data.push(i % 2 === 0 ? 0xaa : 0x55);
    sendDataStream(device, data);

    // Spot-check: page 7, col 127 = index 7*128+127 = 1023
    expect(device.buffer[1023]).toBe(0x55);

    // All 128*64 pixels must have alpha=255
    const px = el.imageData.data;
    let allOpaque = true;
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] !== 255) {
        allOpaque = false;
        break;
      }
    }
    expect(allOpaque).toBe(true);
  });

  it('does not throw when element has no imageData yet (null/undefined)', () => {
    const el = {
      imageData: undefined,
      redraw: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLElement;

    const sim = makeSim();
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(el, sim as any, () => null);
    const device = sim._devices[0];

    expect(() => sendDataStream(device, [0xff])).not.toThrow();
  });

  it('Adafruit SSD1306 init sequence: processes multi-byte commands without crashing', () => {
    const el = makeOLEDElement();
    const sim = makeSim();
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(el, sim as any, () => null);
    const device = sim._devices[0];

    // Minimal Adafruit init (from Adafruit_SSD1306.cpp begin())
    const initCmds = [
      0xae, // Display OFF
      0xd5,
      0x80, // Set display clock divide
      0xa8,
      0x3f, // Set multiplex ratio (64-1)
      0xd3,
      0x00, // Set display offset
      0x40, // Set start line
      0x8d,
      0x14, // Charge pump ON
      0x20,
      0x00, // Horizontal addressing
      0xa1, // Segment remap
      0xc8, // COM output scan direction
      0xda,
      0x12, // COM pins hardware config
      0x81,
      0xcf, // Contrast
      0xd9,
      0xf1, // Pre-charge period
      0xdb,
      0x40, // VCOMH deselect level
      0xa4, // Display from RAM
      0xa6, // Normal display
      0x2e, // Deactivate scroll
      0xaf, // Display ON
    ];

    expect(() => {
      sendCommandStream(device, initCmds);
      // After init, write one page of data
      sendCommandStream(device, [0x21, 0x00, 0x7f, 0x22, 0x00, 0x07]);
      sendDataStream(device, new Array(1024).fill(0x00));
    }).not.toThrow();

    expect(el.redraw).toHaveBeenCalled();
  });
});
