/**
 * ILI9341 part: what the panel does with the bytes the bus hands it.
 *
 * The panel is a device of the board's SPI fabric (project
 * board-buses-2026-09, F3), so the rig here is the real one: a board and a
 * wired component in the store, the real part from PartSimulationRegistry,
 * and a controller port bound to the board's fabric that clocks frames the
 * way an engine adapter does. What stands in for the browser is only what
 * node lacks: window.setTimeout for the part's paint debounce, and a canvas
 * context that keeps the pixels so a test can read them back.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.stubGlobal('window', {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});

import { useSimulatorStore, getBoardSimulator, getBoardPinManager } from '../store/useSimulatorStore';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts';
import { traceDetailed } from '../simulation/PinTrace';
import { busRegistry } from '../simulation/buses';
import type {
  BoardPins,
  SpiControllerConfig,
  SpiControllerPort,
  SpiRouting,
} from '../simulation/buses';

// ── A controller port, as an engine adapter exposes one ─────────────────────

class TestPort implements SpiControllerPort {
  readonly bus = 'spi' as const;
  readonly unit = 0;
  readonly name = 'SPI';
  private handler: ((mosi: number, bits: number) => number) | null = null;
  private blockHandler: ((mosi: Uint8Array, miso: Uint8Array | null) => void) | null = null;
  setFrameHandler(h: ((mosi: number, bits: number) => number) | null): void {
    this.handler = h;
  }
  setBlockHandler(h: ((mosi: Uint8Array, miso: Uint8Array | null) => void) | null): void {
    this.blockHandler = h;
  }
  config(): SpiControllerConfig {
    return { enabled: true, mode: 0, bitOrder: 'msb', bits: 8 };
  }
  routing(): SpiRouting | 'static' {
    return 'static';
  }
  /** Clock one frame, as the engine does. */
  xfer(mosi: number): number {
    if (!this.handler) throw new Error('no frame handler bound');
    return this.handler(mosi, 8);
  }
  /** Clock a whole transaction in one call (DMA, a W buffer). */
  block(bytes: number[]): void {
    if (!this.blockHandler) throw new Error('no block handler bound');
    this.blockHandler(Uint8Array.from(bytes), null);
  }
}

// ── Rig ─────────────────────────────────────────────────────────────────────

interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

const TFT_PINS: Record<string, number> = { SCK: 13, MOSI: 11, MISO: 12, CS: 10, 'D/C': 9 };
const CS = TFT_PINS.CS;
const DC = TFT_PINS['D/C'];

let seq = 0;
let live: Array<{ boardId: string; cleanup: () => void }> = [];

interface Rig {
  boardId: string;
  tftId: string;
  port: TestPort;
  /** The framebuffer the panel writes into (the last one it created). */
  framebuffer: () => Pixels | null;
  /** Drive a board pin, as the sketch would. */
  write: (pin: number, level: boolean) => void;
  /** One CS-low transaction: a command byte then its data bytes. */
  send: (dc: boolean, ...bytes: number[]) => void;
}

function rig(): Rig {
  const boardId = `uno-tft${++seq}`;
  const tftId = `${boardId}-tft`;
  const st = useSimulatorStore.getState();
  st.addBoard('arduino-uno', 0, 0, boardId);
  let wireSeq = 0;
  for (const [pinName, boardPin] of Object.entries(TFT_PINS)) {
    useSimulatorStore.getState().addWire({
      id: `${tftId}-w${++wireSeq}`,
      start: { componentId: tftId, pinName, x: 0, y: 0 },
      end: { componentId: boardId, pinName: String(boardPin), x: 0, y: 0 },
      waypoints: [],
      color: '#0a0',
    } as never);
  }
  useSimulatorStore.setState((s) => ({
    components: [...s.components, { id: tftId, metadataId: 'ili9341', x: 0, y: 0, properties: {} }],
  }) as never);

  const created: Pixels[] = [];
  const ctx = {
    createImageData: (w: number, h: number): Pixels => {
      const d = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      created.push(d);
      return d;
    },
    putImageData: () => {},
    clearRect: () => {},
  };
  const el = {
    id: tftId,
    canvas: { getContext: () => ctx },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  // The engine's side: this board's own pins, and one controller port. The
  // real simulator stays where it is; only the binding is ours, so a frame
  // is clocked exactly when the test says so.
  const pm = getBoardPinManager(boardId)!;
  const pins: BoardPins = {
    onPinChange: (pin, cb) => pm.onPinChange(pin, cb),
    peekPinState: (pin) => pm.peekPinState(pin),
  };
  const port = new TestPort();
  busRegistry.bindEngine(boardId, { pins, spi: [port] });

  const sim = getBoardSimulator(boardId)!;
  const getPin = (name: string) =>
    traceDetailed(useSimulatorStore.getState(), tftId, name, 0).arduinoPin;
  const cleanup = PartSimulationRegistry.get('ili9341')!.attachEvents!(
    el as never,
    sim as never,
    getPin,
    tftId,
  );
  live.push({ boardId, cleanup });

  const write = (pin: number, level: boolean) => pm.setPinState(pin, level);
  return {
    boardId,
    tftId,
    port,
    framebuffer: () => created[created.length - 1] ?? null,
    write,
    send: (dc: boolean, ...bytes: number[]) => {
      write(DC, dc);
      write(CS, false);
      for (const b of bytes) port.xfer(b);
      write(CS, true);
    },
  };
}

beforeEach(() => {
  useSimulatorStore.setState({ components: [], wires: [] } as never);
});
afterEach(() => {
  for (const l of live) {
    l.cleanup();
    useSimulatorStore.getState().removeBoard(l.boardId);
  }
  live = [];
  useSimulatorStore.setState({ components: [], wires: [] } as never);
});

// ── Helpers ─────────────────────────────────────────────────────────────────

const CASET = 0x2a;
const PASET = 0x2b;
const RAMWR = 0x2c;

/** Set a window, in the panel's own coordinates. */
function window16(r: Rig, x0: number, x1: number, y0: number, y1: number): void {
  r.send(false, CASET);
  r.send(true, x0 >> 8, x0 & 0xff, x1 >> 8, x1 & 0xff);
  r.send(false, PASET);
  r.send(true, y0 >> 8, y0 & 0xff, y1 >> 8, y1 & 0xff);
}

/** RGB565 -> the RGBA the part writes. */
const rgba = (color: number): number[] => [
  ((color >> 11) & 0x1f) * 8,
  ((color >> 5) & 0x3f) * 4,
  (color & 0x1f) * 8,
  255,
];

function pixel(fb: Pixels | null, x: number, y: number): number[] {
  if (!fb) return [];
  const i = (y * fb.width + x) * 4;
  return [fb.data[i], fb.data[i + 1], fb.data[i + 2], fb.data[i + 3]];
}

/** Fill the current window with `color`, as a driver's fillRect does. */
function fill(r: Rig, color: number, pixels: number): void {
  r.send(false, RAMWR);
  const bytes: number[] = [];
  for (let i = 0; i < pixels; i++) bytes.push(color >> 8, color & 0xff);
  r.send(true, ...bytes);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('ILI9341: RAMWR rewinds the address cursor', () => {
  it('a first fill of a window lands where CASET/PASET put it', () => {
    const r = rig();
    window16(r, 2, 3, 5, 6);
    fill(r, 0xf800, 4);
    const fb = r.framebuffer();
    expect(pixel(fb, 2, 5)).toEqual(rgba(0xf800));
    expect(pixel(fb, 3, 6)).toEqual(rgba(0xf800));
  });

  it('a SECOND RAMWR into the same window draws again, without a new CASET/PASET', () => {
    // The chip puts the frame-memory pointer back on (SC, SP) at every RAMWR
    // (datasheet 8.2.22). Before the fix the cursor only moved on CASET/PASET,
    // so a driver that keeps its window - a second fillScreen of the same
    // area - wrote past rowEnd and the panel showed nothing.
    const r = rig();
    window16(r, 2, 3, 5, 6);
    fill(r, 0xf800, 4);
    fill(r, 0x001f, 4);
    const fb = r.framebuffer();
    expect(pixel(fb, 2, 5)).toEqual(rgba(0x001f));
    expect(pixel(fb, 3, 5)).toEqual(rgba(0x001f));
    expect(pixel(fb, 2, 6)).toEqual(rgba(0x001f));
    expect(pixel(fb, 3, 6)).toEqual(rgba(0x001f));
  });

  it('RAMWR does not disturb the window itself: the third fill lands there too', () => {
    const r = rig();
    window16(r, 10, 11, 20, 21);
    fill(r, 0xf800, 4);
    fill(r, 0x07e0, 4);
    fill(r, 0x001f, 4);
    const fb = r.framebuffer();
    expect(pixel(fb, 10, 20)).toEqual(rgba(0x001f));
    expect(pixel(fb, 11, 21)).toEqual(rgba(0x001f));
    // And nothing outside it.
    expect(pixel(fb, 12, 20)).toEqual([0, 0, 0, 0]);
  });
});

describe('ILI9341: the fabric gates on the panel own chip select', () => {
  it('bytes clocked while CS is high never reach the panel', () => {
    const r = rig();
    window16(r, 0, 1, 0, 1);
    r.send(false, RAMWR);
    // Somebody else's transaction on the same bus: a card read, say.
    r.write(DC, true);
    r.write(CS, true);
    for (const b of [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]) r.port.xfer(b);
    // Now the panel's own pixels, which must still start at (0, 0).
    r.send(true, 0xf8, 0x00, 0xf8, 0x00);
    const fb = r.framebuffer();
    expect(pixel(fb, 0, 0)).toEqual(rgba(0xf800));
    expect(pixel(fb, 1, 0)).toEqual(rgba(0xf800));
    expect(pixel(fb, 0, 1)).toEqual([0, 0, 0, 0]);
  });

  it('the panel never drives MISO: a frame it hears reads back as the idle line', () => {
    const r = rig();
    r.write(CS, false);
    expect(r.port.xfer(0x2c)).toBe(0xff);
    r.write(CS, true);
  });

  it('a block transfer decodes byte for byte, exactly as the per-frame path does', () => {
    const r = rig();
    window16(r, 4, 5, 8, 9);
    r.write(DC, false);
    r.write(CS, false);
    r.port.block([RAMWR]);
    r.write(DC, true);
    r.port.block([0x07, 0xe0, 0x07, 0xe0, 0x07, 0xe0, 0x07, 0xe0]);
    r.write(CS, true);
    const fb = r.framebuffer();
    expect(pixel(fb, 4, 8)).toEqual(rgba(0x07e0));
    expect(pixel(fb, 5, 9)).toEqual(rgba(0x07e0));
  });

  it('disposing the part takes it off the bus: a later frame paints nothing', () => {
    const r = rig();
    window16(r, 0, 0, 0, 0);
    const l = live.find((x) => x.boardId === r.boardId)!;
    l.cleanup();
    l.cleanup = () => {};
    r.send(false, RAMWR);
    r.send(true, 0xf8, 0x00);
    expect(r.framebuffer(), 'the panel never even made a framebuffer').toBeNull();
  });
});
