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

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import { busRegistry } from '../simulation/buses';
import type { I2cTransactionHandler } from '../simulation/buses';
import '../simulation/parts/ProtocolParts';

afterEach(() => busRegistry.clear());

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

/**
 * A board with one I2C controller, the OLED's DATA/CLK wired to its SDA/SCL
 * (the panel is on the bus its wiring says, project board-buses-2026-09 F5).
 * `_devices[0]` is the MASTER's view of the panel at 0x3C: each writeByte is
 * a byte on the wire, opening a write transaction when none is open, and
 * stop() is the STOP. The mocked I2CBusManager used to hand the device
 * itself over; the bytes, and what the panel draws from them, are the same.
 */
function makeSim() {
  let bus: I2cTransactionHandler | null = null;
  busRegistry.setResolver({
    resolve: (ref) =>
      ref.kind === 'board'
        ? { kind: 'board', boardId: ref.boardId, pin: ref.pin }
        : ref.pinName === 'DATA'
          ? { kind: 'board', boardId: 'uno', pin: 18 }
          : ref.pinName === 'CLK'
            ? { kind: 'board', boardId: 'uno', pin: 19 }
            : { kind: 'floating' },
    boardKind: () => 'arduino-uno',
    boards: () => ['uno'],
  });
  busRegistry.bindEngine('uno', {
    pins: { onPinChange: () => () => {}, peekPinState: () => undefined },
    spi: [],
    i2c: [
      {
        bus: 'i2c',
        unit: 0,
        name: 'TWI',
        setTransactionHandler: (h) => {
          bus = h;
        },
        routing: () => ({ sda: 18, scl: 19 }),
      },
    ],
  });
  let open = false;
  const master = {
    address: 0x3c,
    writeByte(b: number): boolean {
      if (!open) open = bus!.start(0x3c, false);
      return bus!.write(b);
    },
    readByte(): number {
      bus!.start(0x3c, true);
      open = true;
      return bus!.read();
    },
    stop(): void {
      open = false;
      bus!.stop();
    },
  };
  return {
    get _devices() {
      return busRegistry.i2cPlacement('oled') ? [master] : [];
    },
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

  it('puts a VirtualSSD1306 on the bus at address 0x3C', () => {
    const el = makeOLEDElement();
    const sim = makeSim();
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(el, sim as any, () => null, 'oled');
    expect(busRegistry.fabric('uno').i2cBuses.get(18)?.targetsAt(0x3c).map((m) => m.owner)).toEqual(['oled']);
  });

  it('calls element.redraw() after a STOP', () => {
    const el = makeOLEDElement();
    const sim = makeSim();
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(el, sim as any, () => null, 'oled');
    const device = sim._devices[0];

    // Simple data write — fill first byte
    sendDataStream(device, [0xff]);

    expect(el.redraw).toHaveBeenCalled();
  });

  it('renders a fully-lit column 0 of page 0 (0xFF → top 8 pixels lit)', () => {
    const el = makeOLEDElement();
    const sim = makeSim();
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(el, sim as any, () => null, 'oled');
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
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(el, sim as any, () => null, 'oled');
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

  it('page addressing (Tiny4kOLED): 0xB0+page / 0x00-0x1F col, no 0x20, cursor persists across data streams', () => {
    const el = makeOLEDElement();
    const sim = makeSim();
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(el, sim as any, () => null, 'oled');
    const device = sim._devices[0];

    // Page-addressing setCursor: page 1, column 8 (col high nibble = 0x10,
    // col low nibble = 0x08). No 0x20 — relies on the power-on page-mode
    // default that Tiny4kOLED / U8g2-page / classic SSD1306 drivers assume.
    sendCommandStream(device, [0xb1, 0x10, 0x08]);
    // TinyWireM flushes its small buffer as distinct 16-byte I2C transactions,
    // so the column pointer MUST persist across separate data streams.
    sendDataStream(device, [0xff, 0x00]); // col 8, 9
    sendDataStream(device, [0x00, 0xff]); // col 10, 11 — cursor continued

    const px = el.imageData.data;
    const lit = (row: number, col: number) => {
      const i = (row * 128 + col) * 4;
      return px[i] + px[i + 1] + px[i + 2] > 0;
    };
    // page 1 → rows 8..15; 0xff lights the whole 8-pixel column.
    expect(lit(8, 8)).toBe(true);
    expect(lit(15, 8)).toBe(true);
    expect(lit(8, 9)).toBe(false); // 0x00
    expect(lit(8, 10)).toBe(false); // 0x00 (start of 2nd stream)
    // col 11 lit proves the cursor advanced across the STOP/new transaction.
    expect(lit(8, 11)).toBe(true);
    expect(lit(15, 11)).toBe(true);
  });

  it('fills all 1024 GDDRAM bytes via horizontal addressing', () => {
    const el = makeOLEDElement();
    const sim = makeSim();
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(el, sim as any, () => null, 'oled');
    const device = sim._devices[0];

    sendCommandStream(device, [0x20, 0x00, 0x21, 0x00, 0x7f, 0x22, 0x00, 0x07]);

    // Fill all 1024 GDDRAM bytes with a checkerboard pattern (0xAA / 0x55)
    const data: number[] = [];
    for (let i = 0; i < 1024; i++) data.push(i % 2 === 0 ? 0xaa : 0x55);
    sendDataStream(device, data);

    // Spot-check: page 7, col 127 = 0x55, so row 56 lit and row 57 dark.
    const at = (row: number) => el.imageData.data[(row * 128 + 127) * 4];
    expect([at(56) > 0, at(57) > 0]).toEqual([true, false]);

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
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(el, sim as any, () => null, 'oled');
    const device = sim._devices[0];

    expect(() => sendDataStream(device, [0xff])).not.toThrow();
  });

  it('Adafruit SSD1306 init sequence: processes multi-byte commands without crashing', () => {
    const el = makeOLEDElement();
    const sim = makeSim();
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(el, sim as any, () => null, 'oled');
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
