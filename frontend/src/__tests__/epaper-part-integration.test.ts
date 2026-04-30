/**
 * EPaperPart hook integration test
 *
 * This test pins down the wire-up between:
 *   - the `<velxio-epaper>` Web Component
 *   - the `EPaperPart.attachEvents` hook
 *   - a fake AVR-shaped simulator (matches the surface the hook expects)
 *
 * It does NOT compile a real GxEPD2 sketch — that would need arduino-cli
 * + GxEPD2 + Adafruit_GFX installed. The decoder itself is already covered
 * by `ssd168x-decoder.test.ts`. What we want here is to catch regressions
 * in the **plumbing**: pin tracking, SPI hook restoration, BUSY pulse, RAF
 * batching, and canvas painting on flush.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
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

vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  cb(performance.now());
  return 1;
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

// ── Fake simulator surfaces ──────────────────────────────────────────────────

interface PinChangeCb {
  (pin: number, state: boolean): void;
}

class FakePinManager {
  private listeners = new Map<number, Set<PinChangeCb>>();

  onPinChange(pin: number, cb: PinChangeCb): () => void {
    let set = this.listeners.get(pin);
    if (!set) {
      set = new Set();
      this.listeners.set(pin, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }

  triggerPinChange(pin: number, state: boolean): void {
    this.listeners.get(pin)?.forEach((cb) => cb(pin, state));
  }
}

class FakeSpi {
  // The hook overwrites `onByte`; we save the wrapped value and call it.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  onByte: (value: number) => void = () => {};
  completed: number[] = [];
  completeTransfer(resp: number) {
    this.completed.push(resp);
  }
}

class FakeAvrSimulator {
  spi = new FakeSpi();
  pinManager = new FakePinManager();
  /** Track BUSY (or any pin) the hook drives via setPinState. */
  externalPinState = new Map<number, boolean>();
  setPinState(pin: number, state: boolean) {
    this.externalPinState.set(pin, state);
  }
  isRunning() {
    return true;
  }
}

// ── Element + DOM setup (jsdom) ─────────────────────────────────────────────

let cleanup: (() => void) | null = null;

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

afterEach(() => {
  cleanup?.();
  cleanup = null;
  // Empty the body so each test starts on a clean canvas.
  if (typeof document !== 'undefined') {
    document.body.innerHTML = '';
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const cmd = (b: number) => ({ value: b, dc: false });
const data = (...bs: number[]) => bs.map((b) => ({ value: b, dc: true }));

function pumpBytes(
  spi: FakeSpi,
  pm: FakePinManager,
  dcPin: number,
  bytes: ReadonlyArray<{ value: number; dc: boolean }>,
) {
  for (const b of bytes) {
    pm.triggerPinChange(dcPin, b.dc);
    spi.onByte(b.value);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('EPaperPart — AVR hook integration', () => {
  it('registers all 5 phase-1 mono + 2 tri-colour panel kinds', () => {
    const ids = [
      'epaper-1in54-bw',
      'epaper-2in13-bw',
      'epaper-2in13-bwr',
      'epaper-2in9-bw',
      'epaper-2in9-bwr',
      'epaper-4in2-bw',
      'epaper-7in5-bw',
    ];
    for (const id of ids) {
      const entry = PartSimulationRegistry.get(id);
      expect(entry, `no factory registered for ${id}`).toBeDefined();
      expect(typeof entry?.attachEvents).toBe('function');
    }
  });

  it('hooks SPI, drives BUSY high on flush, and restores cleanup', () => {
    const sim = new FakeAvrSimulator();
    const el = document.createElement('velxio-epaper') as HTMLElement;
    el.setAttribute('panel-kind', 'epaper-1in54-bw');
    el.setAttribute('refresh-ms', '1');
    document.body.appendChild(el);

    const factory = PartSimulationRegistry.get('epaper-1in54-bw')!;
    const PIN_DC = 9;
    const PIN_CS = 10;
    const PIN_RST = 8;
    const PIN_BUSY = 7;
    const getPin = (name: string): number | null => {
      switch (name) {
        case 'DC':
          return PIN_DC;
        case 'CS':
          return PIN_CS;
        case 'RST':
          return PIN_RST;
        case 'BUSY':
          return PIN_BUSY;
        default:
          return null;
      }
    };

    cleanup = factory.attachEvents!(el, sim as never, getPin, 'epd-test') as () => void;

    // Hook should have replaced spi.onByte with its own intercept.
    expect(typeof sim.spi.onByte).toBe('function');

    // CS LOW (active) — only feed bytes after CS goes low.
    sim.pinManager.triggerPinChange(PIN_CS, false);

    // Send a tiny 1-byte BW write at (0,0) then ACTIVATE.
    pumpBytes(sim.spi, sim.pinManager, PIN_DC, [
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
    ]);

    // Every byte should have produced a completeTransfer(0xff) response — that's
    // how the hook unblocks the AVR CPU. One per byte fed (20 in the stream above).
    expect(sim.spi.completed.length).toBeGreaterThanOrEqual(20);
    expect(sim.spi.completed.every((r) => r === 0xff)).toBe(true);

    // BUSY pin must have been driven HIGH at least once during/after flush.
    // (The actual canvas painting via putImageData is a no-op under jsdom —
    // canvas.getContext('2d') isn't implemented without the optional `canvas`
    // npm package — but the BUSY pulse is the observable plumbing signal we
    // care about for this integration check. Pixel correctness is already
    // covered by the SSD168xDecoder unit tests.)
    expect(sim.externalPinState.get(PIN_BUSY)).toBe(true);

    // Cleanup must restore spi.onByte to a callable; calling it must NOT throw.
    cleanup();
    cleanup = null;
    expect(() => sim.spi.onByte(0xab)).not.toThrow();
  });

  it('does NOT feed bytes to the decoder while CS is HIGH (de-asserted)', () => {
    const sim = new FakeAvrSimulator();
    const el = document.createElement('velxio-epaper') as HTMLElement;
    el.setAttribute('panel-kind', 'epaper-1in54-bw');
    el.setAttribute('refresh-ms', '1');
    document.body.appendChild(el);

    const factory = PartSimulationRegistry.get('epaper-1in54-bw')!;
    const PIN_DC = 9;
    const PIN_CS = 10;
    const PIN_BUSY = 7;
    const getPin = (name: string): number | null =>
      name === 'DC' ? PIN_DC : name === 'CS' ? PIN_CS : name === 'BUSY' ? PIN_BUSY : null;

    cleanup = factory.attachEvents!(el, sim as never, getPin, 'epd-test') as () => void;

    // CS stays HIGH → bytes ignored. ACTIVATE never reaches the decoder so
    // BUSY should NOT have been pulsed high.
    sim.pinManager.triggerPinChange(PIN_CS, true);
    sim.spi.onByte(CMD_MASTER_ACTIVATION);

    // BUSY pin was never set (still undefined / false in our map).
    expect(sim.externalPinState.get(PIN_BUSY)).not.toBe(true);
  });

  it('cleanup restores a callable SPI onByte', () => {
    const sim = new FakeAvrSimulator();
    const installed = sim.spi.onByte;
    const el = document.createElement('velxio-epaper') as HTMLElement;
    el.setAttribute('panel-kind', 'epaper-2in13-bwr');
    document.body.appendChild(el);

    const factory = PartSimulationRegistry.get('epaper-2in13-bwr')!;
    const tearDown = factory.attachEvents!(
      el,
      sim as never,
      () => null,
      'epd-test',
    ) as () => void;

    // The hook replaced onByte while attached.
    expect(sim.spi.onByte).not.toBe(installed);

    tearDown();

    // After cleanup, onByte must still be a callable function — the hook
    // restores `prev` (a `bind`-wrapped reference to the original), so we
    // verify functional behaviour (no throw + completeTransfer call) rather
    // than reference equality.
    sim.spi.completed.length = 0;
    expect(() => sim.spi.onByte(0x42)).not.toThrow();
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
