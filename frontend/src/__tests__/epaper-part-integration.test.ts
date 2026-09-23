/**
 * EPaperPart hook integration test
 *
 * This test pins down the wire-up between:
 *   - the `<velxio-epaper>` Web Component
 *   - the `EPaperPart.attachEvents` hook
 *   - the board's SPI fabric (project board-buses-2026-09)
 *
 * It does NOT compile a real GxEPD2 sketch — that would need arduino-cli
 * + GxEPD2 + Adafruit_GFX installed. The decoder itself is already covered
 * by `ssd168x-decoder.test.ts`. What we want here is to catch regressions
 * in the **plumbing**: pin tracking, chip-select gating, BUSY pulse, RAF
 * batching, canvas painting on flush, and leaving the bus on cleanup.
 *
 * The rig is a real board and real wires in the store (that is how the
 * fabric decides which bus a panel is on), plus a stand-in engine that owns
 * the board's pins and one SPI controller port, so a test clocks a frame
 * exactly when it means to. Each engine's own port is covered by its
 * conformance suite (`board-buses/port-conformance-*`), the Raspberry Pi's
 * included, so nothing here needs to stand in for a particular board.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import { lineGaps, clearLineGaps } from '../simulation/line/requestLine';
import { useSimulatorStore, getBoardPinManager } from '../store/useSimulatorStore';
import { traceDetailed } from '../simulation/PinTrace';
import { busRegistry } from '../simulation/buses';
import type {
  BoardPins,
  EngineBinding,
  SpiControllerConfig,
  SpiControllerPort,
  SpiRouting,
} from '../simulation/buses';
import type { PinManager } from '../simulation/PinManager';
import {
  CMD_DATA_ENTRY_MODE,
  CMD_SET_RAMX_RANGE,
  CMD_SET_RAMY_RANGE,
  CMD_SET_RAMX_COUNTER,
  CMD_SET_RAMY_COUNTER,
  CMD_WRITE_BLACK_VRAM,
  CMD_DISP_UPDATE_CTRL_2,
  CMD_MASTER_ACTIVATION,
} from '../simulation/displays/SSD168xDecoder';

// Side-effect import: registers the EPaperPart factory under all panel ids.
import '../simulation/parts/EPaperPart';

// ── Synchronous RAF + ImageData polyfill ─────────────────────────────────────
//
// In Node we don't have a real raf or canvas backing. Stub raf to fire
// immediately so the hook's flush schedules synchronously, and stub
// ImageData so `ctx.createImageData` works.

// The stub runs the callback BEFORE it returns, the opposite order to a real
// rAF, so the id it hands back has to mean "nothing pending" (null). Returning
// a live id latched the part's `rafId` guard after the very first flush and
// every later frame was dropped, which made a panel look frozen on its first
// picture here and nowhere else.
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  cb(performance.now());
  return null as unknown as number;
});
vi.stubGlobal('cancelAnimationFrame', vi.fn());

if (typeof (globalThis as { ImageData?: unknown }).ImageData === 'undefined') {
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
  (globalThis as unknown as { ImageData: unknown }).ImageData = ImageDataPoly;
}

// ── The engine side: a board's pins and one SPI controller port ──────────────

class TestPort implements SpiControllerPort {
  readonly bus = 'spi' as const;
  readonly unit = 0;
  readonly name = 'SPI';
  private handler: ((mosi: number, bits: number) => number) | null = null;
  setFrameHandler(h: ((mosi: number, bits: number) => number) | null): void {
    this.handler = h;
  }
  config(): SpiControllerConfig {
    return { enabled: true, mode: 0, bitOrder: 'msb', bits: 8 };
  }
  routing(): SpiRouting | 'static' {
    return 'static';
  }
  /** The engine clocks one frame and reads MISO back. */
  xfer(mosi: number): number {
    if (!this.handler) throw new Error('no frame handler bound');
    return this.handler(mosi, 8);
  }
}

/**
 * What a part is handed: the board's PinManager (DC, RST, BUSY go through it,
 * as on any board) and the bus binding the fabric takes. `setPinState` is the
 * path a part uses to put a level on an MCU input, recorded here so a test can
 * see what the panel drove on BUSY.
 */
class TestSimulator {
  readonly port = new TestPort();
  readonly externalPinState = new Map<number, boolean>();
  readonly driven: Array<[number, boolean]> = [];
  readonly pinManager: PinManager;
  constructor(pinManager: PinManager) {
    this.pinManager = pinManager;
  }
  getBusBinding(): EngineBinding {
    const pm = this.pinManager;
    const pins: BoardPins = {
      onPinChange: (pin, cb) => pm.onPinChange(pin, cb),
      peekPinState: (pin) => pm.peekPinState(pin),
      driveInput: (pin, level) => this.setPinState(pin, level),
    };
    return { pins, spi: [this.port] };
  }
  setPinState(pin: number, state: boolean): void {
    this.externalPinState.set(pin, state);
    this.driven.push([pin, state]);
    this.pinManager.setPinState(pin, state);
  }
  isRunning(): boolean {
    return true;
  }
}

// ── Element + DOM setup (jsdom) ─────────────────────────────────────────────

beforeAll(async () => {
  // One jsdom for the whole file — `customElements.define` is global per
  // window, so we can't re-create the window between tests without losing
  // the `velxio-epaper` registration.
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
  });
  const w = dom.window as unknown as Record<string, unknown>;
  for (const k of [
    'document',
    'window',
    'HTMLElement',
    'Element',
    'Node',
    'customElements',
    'CustomEvent',
    'HTMLCanvasElement',
  ]) {
    (globalThis as Record<string, unknown>)[k] = w[k];
  }
  // Now load the Web Component (after globals are in place).
  await import('../components/velxio-components/EPaperElement');
});

// ── Rig ─────────────────────────────────────────────────────────────────────

/** The panel's pins, on the pads the gallery example uses. */
const PANEL_WIRING: Record<string, number> = {
  SCK: 13,
  SDI: 11,
  CS: 10,
  DC: 9,
  RST: 8,
  BUSY: 7,
};
const PIN_CS = PANEL_WIRING.CS;
const PIN_DC = PANEL_WIRING.DC;
const PIN_RST = PANEL_WIRING.RST;
const PIN_BUSY = PANEL_WIRING.BUSY;

let seq = 0;
let live: Array<{ boardId: string; cleanup: () => void }> = [];

interface Rig {
  sim: TestSimulator;
  el: HTMLElement;
  pins: PinManager;
  /** Clock `bytes` into the panel with DC at `dc` and its CS asserted. */
  feed: (dc: boolean, ...bytes: number[]) => void;
  /** Drive a board pin, as the sketch would. */
  write: (pin: number, level: boolean) => void;
  /** Take the part off, as a component removal does. */
  detach: () => void;
}

/**
 * A board, a panel wired to it, and the part attached: the whole path a
 * canvas project takes. `wiring` overrides a pin's pad (-1 = a rail, null =
 * not wired at all).
 */
function rig(
  panelKind = 'epaper-1in54-bw',
  opts: { refreshMs?: string; wiring?: Record<string, number | null> } = {},
): Rig {
  const boardId = `uno-epd${++seq}`;
  const componentId = `${boardId}-epd`;
  const wiring = { ...PANEL_WIRING, ...(opts.wiring ?? {}) };
  useSimulatorStore.getState().addBoard('arduino-uno', 0, 0, boardId);
  let wireSeq = 0;
  for (const [pinName, boardPin] of Object.entries(wiring)) {
    if (boardPin === null) continue;
    useSimulatorStore.getState().addWire({
      id: `${componentId}-w${++wireSeq}`,
      start: { componentId, pinName, x: 0, y: 0 },
      // -1 is the rail case: a GND pad, which resolves to a rail, not a GPIO.
      end: { componentId: boardId, pinName: boardPin < 0 ? 'GND.1' : String(boardPin), x: 0, y: 0 },
      waypoints: [],
      color: '#0a0',
    } as never);
  }
  useSimulatorStore.setState((s) => ({
    components: [...s.components, { id: componentId, metadataId: panelKind, x: 0, y: 0, properties: {} }],
  }) as never);

  const el = document.createElement('velxio-epaper') as HTMLElement;
  el.setAttribute('panel-kind', panelKind);
  if (opts.refreshMs) el.setAttribute('refresh-ms', opts.refreshMs);
  document.body.appendChild(el);

  const pins = getBoardPinManager(boardId)!;
  const sim = new TestSimulator(pins);
  busRegistry.bindBoard(boardId, sim);

  const getPin = (name: string) =>
    traceDetailed(useSimulatorStore.getState(), componentId, name, 0).arduinoPin;
  const cleanup = PartSimulationRegistry.get(panelKind)!.attachEvents!(
    el,
    sim as never,
    getPin,
    componentId,
  );
  const entry = { boardId, cleanup };
  live.push(entry);

  const write = (pin: number, level: boolean) => pins.setPinState(pin, level);
  return {
    sim,
    el,
    pins,
    write,
    feed: (dc: boolean, ...bytes: number[]) => {
      write(PIN_DC, dc);
      write(PIN_CS, false);
      for (const b of bytes) sim.port.xfer(b);
      write(PIN_CS, true);
    },
    detach: () => {
      entry.cleanup();
      entry.cleanup = () => {};
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
  // Empty the body so each test starts on a clean canvas.
  if (typeof document !== 'undefined') {
    document.body.innerHTML = '';
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The RGBA on the panel's glass at (x, y).
 *
 * Not the decoder's RAM and not a byte count: `putImageData` has run against
 * the element's real <canvas>, so this is the colour a user would see. A panel
 * that decodes perfectly and paints nowhere reads as undrawn here.
 */
function glassPixel(el: HTMLElement, x: number, y: number): number[] {
  const cv = (el as unknown as { canvas: HTMLCanvasElement | null }).canvas;
  expect(cv, 'the element has no canvas').not.toBeNull();
  const ctx = cv!.getContext('2d');
  expect(ctx, 'no 2d context on the panel canvas').not.toBeNull();
  return Array.from(ctx!.getImageData(x, y, 1, 1).data);
}

const INK = [0x20, 0x20, 0x20, 0xff];
const PAPER = [0xf4, 0xf1, 0xe8, 0xff];

const cmd = (b: number) => ({ value: b, dc: false });
const data = (...bs: number[]) => bs.map((b) => ({ value: b, dc: true }));

function pump(r: Rig, bytes: ReadonlyArray<{ value: number; dc: boolean }>): void {
  for (const b of bytes) r.feed(b.dc, b.value);
}

/** A one-byte black write at (0,0), then ACTIVATE: the smallest full refresh. */
const TINY_REFRESH = [
  cmd(CMD_DATA_ENTRY_MODE),
  ...data(0x03),
  cmd(CMD_SET_RAMX_RANGE),
  ...data(0x00, 0x18),
  cmd(CMD_SET_RAMY_RANGE),
  ...data(0x00, 0x00, 0xc7, 0x00),
  cmd(CMD_SET_RAMX_COUNTER),
  ...data(0x00),
  cmd(CMD_SET_RAMY_COUNTER),
  ...data(0x00, 0x00),
  cmd(CMD_WRITE_BLACK_VRAM),
  ...data(0x7f),
  cmd(CMD_DISP_UPDATE_CTRL_2),
  ...data(0xf7),
  cmd(CMD_MASTER_ACTIVATION),
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe('EPaperPart — on the board bus', () => {
  it('registers all 5 phase-1 mono + 2 tri-colour panel kinds', () => {
    const ids = [
      'epaper-1in54-bw',
      'epaper-2in13-bw',
      'epaper-2in13-bwr',
      'epaper-2in9-bw',
      'epaper-2in9-bwr',
      'epaper-4in2-bw',
      'epaper-7in5-bw',
      'epaper-5in65-7c',
    ];
    for (const id of ids) {
      const entry = PartSimulationRegistry.get(id);
      expect(entry, `no factory registered for ${id}`).toBeDefined();
      expect(typeof entry?.attachEvents).toBe('function');
    }
  });

  it('decodes its own traffic, drives BUSY on flush, and leaves MISO alone', () => {
    const r = rig('epaper-1in54-bw', { refreshMs: '1' });
    const misos = new Set<number>();
    r.write(PIN_CS, false);
    for (const b of TINY_REFRESH) {
      r.write(PIN_DC, b.dc);
      misos.add(r.sim.port.xfer(b.value));
    }
    r.write(PIN_CS, true);

    // The panel reports status on BUSY, never on MISO, so every frame reads
    // back the idle line the fabric resolves.
    expect([...misos]).toEqual([0xff]);
    // BUSY went to the busy level during the refresh.
    expect(r.sim.externalPinState.get(PIN_BUSY)).toBe(true);
    // And the picture reached the glass: the one RAM byte is 0x7f, so the
    // leftmost pixel of row 0 is ink and the seven after it are paper.
    expect(glassPixel(r.el, 0, 0), 'first pixel').toEqual(INK);
    expect(glassPixel(r.el, 1, 0), 'second pixel').toEqual(PAPER);
    expect(glassPixel(r.el, 7, 0), 'eighth pixel').toEqual(PAPER);
  });

  it('a frame clocked while its chip select is high never reaches the panel', () => {
    // A card or a touch controller sharing SCK and MOSI: on a real board the
    // panel latches nothing, and the fabric hands it nothing.
    const r = rig('epaper-1in54-bw', { refreshMs: '1' });
    r.write(PIN_CS, true);
    for (const b of TINY_REFRESH) {
      r.write(PIN_DC, b.dc);
      r.sim.port.xfer(b.value);
    }
    expect(r.sim.externalPinState.get(PIN_BUSY)).not.toBe(true);
    // The same bytes with its own chip select asserted DO refresh it, so the
    // silence above is the gating and not a panel that heard nothing at all.
    pump(r, TINY_REFRESH);
    expect(r.sim.externalPinState.get(PIN_BUSY)).toBe(true);
  });

  it('a chip select tied to GND is selected, as the pad is on hardware', () => {
    const r = rig('epaper-1in54-bw', { refreshMs: '1', wiring: { CS: -1 } });
    for (const b of TINY_REFRESH) {
      r.write(PIN_DC, b.dc);
      r.sim.port.xfer(b.value);
    }
    expect(r.sim.externalPinState.get(PIN_BUSY)).toBe(true);
  });

  it('an SSD168x panel rests its BUSY pad LOW (the other vendor, the other polarity)', () => {
    const r = rig('epaper-1in54-bw');
    expect(r.sim.externalPinState.get(PIN_BUSY)).toBe(false);
  });

  it('RST still reaches the controller through the PinManager, and the panel refreshes after it', () => {
    // RST, DC and BUSY are plain pins, not the bus's business: only CS moved
    // to the fabric. The pulse has to REACH the controller (its RAM comes back
    // clear), and the panel has to keep working afterwards.
    const r = rig('epaper-1in54-bw', { refreshMs: '1' });
    pump(r, TINY_REFRESH);
    expect(glassPixel(r.el, 0, 0), 'first pixel').toEqual(INK);
    r.write(PIN_RST, true);
    r.write(PIN_RST, false); // active LOW: the controller resets here
    r.write(PIN_RST, true);
    // A bare ACTIVATE now shows cleared RAM. Without this the test passes on a
    // panel whose RST goes nowhere.
    pump(r, [cmd(CMD_DISP_UPDATE_CTRL_2), ...data(0xf7), cmd(CMD_MASTER_ACTIVATION)]);
    expect(glassPixel(r.el, 0, 0), 'the reset did not clear the RAM').toEqual(PAPER);
    pump(r, TINY_REFRESH);
    expect(r.sim.externalPinState.get(PIN_BUSY)).toBe(true);
    expect(glassPixel(r.el, 0, 0), 'the panel went deaf after the reset').toEqual(INK);
  });

  it('cleanup takes the panel off the bus, and a later frame decodes nowhere', () => {
    const r = rig('epaper-1in54-bw', { refreshMs: '1' });
    // It was on the bus first: otherwise the silence below is also what a
    // panel that never attached at all would produce.
    pump(r, TINY_REFRESH);
    expect(glassPixel(r.el, 0, 0), 'the panel never painted while attached').toEqual(INK);
    r.detach();
    const busyWrites = r.sim.driven.length;
    r.write(PIN_CS, false);
    for (const b of TINY_REFRESH) {
      r.write(PIN_DC, b.dc);
      // Nothing on the bus: the frame reads back the idle line.
      expect(r.sim.port.xfer(b.value)).toBe(0xff);
    }
    expect(r.sim.driven.length, 'a detached panel drives nothing').toBe(busyWrites);
  });
});

describe('EPaperPart — the QEMU lane (the worker owns the model)', () => {
  it('on a board with no controller port the part registers a worker slave and never drives BUSY', () => {
    // Two writers on one pin, and for an UltraChip panel they disagreed.
    const driven: Array<[number, boolean]> = [];
    type Update = (id: string, f: { width: number; height: number; b64: string; refreshMs: number }) => void;
    const theBridge: { onEpaperUpdate: Update | null; sendSensorAttach: () => void; sendPinEvent: () => void } = {
      onEpaperUpdate: null,
      sendSensorAttach: () => {},
      sendPinEvent: () => {},
    };
    const registered: Array<[string, number]> = [];
    const esp = {
      pinManager: { onPinChange: () => () => {} },
      // What a QEMU shim answers until F4: the board's pins, no SPI port.
      getBusBinding: () => ({ pins: { onPinChange: () => () => {}, peekPinState: () => undefined }, spi: [] }),
      getBridge: () => theBridge,
      registerSensor: (type: string, pin: number) => {
        registered.push([type, pin]);
        return true;
      },
      unregisterSensor: () => {},
      setPinState: (pin: number, state: boolean) => driven.push([pin, state]),
    };
    const el = document.createElement('velxio-epaper') as HTMLElement;
    el.setAttribute('panel-kind', 'epaper-7in5-bw');
    document.body.appendChild(el);
    const off = PartSimulationRegistry.get('epaper-7in5-bw')!.attachEvents!(
      el, esp as never, (name: string) => (name === 'BUSY' ? 4 : 5), 'epd-esp',
    ) as () => void;
    try {
      expect(registered).toEqual([['epaper-ssd168x', 5]]);
      // A frame the worker rendered: the element shows it, the pad is not ours.
      theBridge.onEpaperUpdate!('epd-esp', { width: 8, height: 1, b64: btoa('\x01'.repeat(8)), refreshMs: 1 });
      expect((el as unknown as { busy: boolean }).busy).toBe(true);
      expect(driven).toEqual([]);
    } finally {
      off();
    }
  });
});

describe('EPaperPart — Web Component pinInfo', () => {
  it('reports 8 standard FPC pins for any panel kind', () => {
    for (const kind of [
      'epaper-1in54-bw',
      'epaper-2in13-bwr',
      'epaper-7in5-bw',
    ]) {
      const el = document.createElement('velxio-epaper') as HTMLElement & {
        pinInfo: Array<{ name: string; x: number; y: number }>;
      };
      el.setAttribute('panel-kind', kind);
      document.body.appendChild(el);
      const names = el.pinInfo.map((p) => p.name);
      expect(names).toEqual(['GND', 'VCC', 'SCK', 'SDI', 'CS', 'DC', 'RST', 'BUSY']);
    }
  });
});

// ── The 7.5" UC8179 panel: the one whose BUSY rests the other way round ─────

describe('EPaperPart — UC8179 (7.5")', () => {
  it('decodes a frame, paints it and pulses BUSY', () => {
    const r = rig('epaper-7in5-bw', { refreshMs: '1' });
    r.feed(false, 0x13); // DTM2: the plane this controller displays
    r.feed(true, 0x00, 0xff, 0x0f, 0xf0);
    r.feed(false, 0x12); // DISPLAY_REFRESH
    expect(r.sim.externalPinState.has(PIN_BUSY)).toBe(true);
    // A set bit is white on this controller: 0x00 is eight ink pixels, and
    // the 0xff after it eight paper ones.
    expect(glassPixel(r.el, 0, 0), 'first pixel').toEqual(INK);
    expect(glassPixel(r.el, 7, 0), 'eighth pixel').toEqual(INK);
    expect(glassPixel(r.el, 8, 0), 'ninth pixel').toEqual(PAPER);
  });

  it('rests its BUSY pad HIGH from the moment it is wired, and pulls it LOW to refresh', async () => {
    // Waveshare's ReadBusy is `while (busy == 0)`: at rest the pad must read 1
    // BEFORE any refresh, or that loop never ends.
    const r = rig('epaper-7in5-bw', { refreshMs: '5' });
    const seen = r.sim.driven.filter(([p]) => p === PIN_BUSY).map(([, s]) => s);
    expect(seen).toEqual([true]);

    r.feed(false, 0x13);
    r.feed(true, 0x00);
    r.feed(false, 0x12);
    expect(r.sim.driven.filter(([p]) => p === PIN_BUSY).map(([, s]) => s)).toEqual([true, false]);
    await new Promise((res) => setTimeout(res, 30));
    expect(r.sim.driven.filter(([p]) => p === PIN_BUSY).map(([, s]) => s)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it('a picture sent to 0x10 only refreshes blank, and says why in the Circuit check', () => {
    clearLineGaps();
    const r = rig('epaper-7in5-bw', { refreshMs: '1' });
    r.feed(false, 0x10);
    r.feed(true, 0xff, 0x00, 0xff);
    r.feed(false, 0x12);
    const gap = lineGaps().find((g) => g.componentId?.endsWith('-epd'));
    expect(gap?.code).toBe('epaper-old-plane-only');
    expect(gap?.why).toMatch(/3 image bytes went to command 0x10 only/);
    expect(gap?.why).toMatch(/0x13/);

    // The next frame goes where the controller looks: the complaint goes away.
    r.feed(false, 0x13);
    r.feed(true, 0x00);
    r.feed(false, 0x12);
    expect(lineGaps().find((g) => g.componentId?.endsWith('-epd'))).toBeUndefined();
  });

  it('BUSY wired to a rail is left alone (a rail resolves to -1, not null)', () => {
    const r = rig('epaper-7in5-bw', { wiring: { BUSY: -1 } });
    expect(r.sim.externalPinState.has(-1)).toBe(false);
    expect(r.sim.driven).toEqual([]);
  });
});

// ── The 5.65" ACeP panel: the third controller family, 7 colours ────────────

describe('EPaperPart — UC8159c (5.65" ACeP)', () => {
  it('paints the ACeP palette, two pixels per byte', () => {
    const r = rig('epaper-5in65-7c', { refreshMs: '1' });
    r.feed(false, 0x10); // DTM1
    // 0x34: upper nibble 3 = blue, lower nibble 4 = red. 0x25: green, yellow.
    r.feed(true, 0x34, 0x25);
    r.feed(false, 0x12); // DISPLAY_REFRESH
    expect(glassPixel(r.el, 0, 0), 'blue').toEqual([0x30, 0x60, 0xc0, 0xff]);
    expect(glassPixel(r.el, 1, 0), 'red').toEqual([0xc0, 0x10, 0x10, 0xff]);
    expect(glassPixel(r.el, 2, 0), 'green').toEqual([0x20, 0xa0, 0x40, 0xff]);
    expect(glassPixel(r.el, 3, 0), 'yellow').toEqual([0xe0, 0xc8, 0x30, 0xff]);
    expect(glassPixel(r.el, 4, 0), 'the rest of the panel is clean white')
      .toEqual([0xf0, 0xf0, 0xf0, 0xff]);
  });

  it('rests its BUSY pad HIGH and pulls it LOW to refresh (UltraChip, like the 7.5")', async () => {
    const r = rig('epaper-5in65-7c', { refreshMs: '5' });
    expect(r.sim.driven.filter(([p]) => p === PIN_BUSY).map(([, s]) => s)).toEqual([true]);
    r.feed(false, 0x10);
    r.feed(true, 0x34);
    r.feed(false, 0x12);
    expect(r.sim.driven.filter(([p]) => p === PIN_BUSY).map(([, s]) => s)).toEqual([true, false]);
    await new Promise((res) => setTimeout(res, 30));
    expect(r.sim.driven.filter(([p]) => p === PIN_BUSY).map(([, s]) => s)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it('a frame clocked while its chip select is high never reaches the panel', () => {
    const r = rig('epaper-5in65-7c', { refreshMs: '1' });
    r.write(PIN_CS, true);
    for (const b of [{ value: 0x10, dc: false }, { value: 0x34, dc: true }, { value: 0x12, dc: false }]) {
      r.write(PIN_DC, b.dc);
      r.sim.port.xfer(b.value);
    }
    expect(r.sim.externalPinState.get(PIN_BUSY)).not.toBe(false);
    // The same bytes with its own chip select asserted DO refresh it.
    r.feed(false, 0x10);
    r.feed(true, 0x34);
    r.feed(false, 0x12);
    expect(glassPixel(r.el, 0, 0), 'blue').toEqual([0x30, 0x60, 0xc0, 0xff]);
  });
});
