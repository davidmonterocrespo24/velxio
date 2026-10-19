/**
 * protocol-parts.test.ts
 *
 * Tests for the 8 "protocol" components that use I2C, SPI, single-wire, or
 * custom serial communication:
 *
 *   ssd1306       — I2C OLED (VirtualSSD1306)
 *   ds1307        — I2C RTC  (VirtualDS1307)
 *   mpu6050       — I2C IMU  (VirtualMPU6050)
 *   dht22         — single-wire temp/humidity
 *   hx711         — 2-wire load-cell ADC
 *   ir-receiver   — the air → a real NEC envelope on its DAT pin
 *   ir-remote     — a button press → the air
 *   microsd-card  — SPI SD init handshake
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import { LineSensorHub } from '../simulation/line/LineSensorHub';
import type { LineHostPort } from '../simulation/line/LineHost';
import { INITIAL_PAD, type PadEvent, type PadState } from '../simulation/line/padEvent';
import { clearLineGaps, lineGaps } from '../simulation/line/requestLine';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';
import { SENSOR_CONTROLS } from '../simulation/sensorControlConfig';
import { DHT22_RESPONSE_START_US } from '../simulation/line/models/dht22';
import {
  emitIr,
  irAirStats,
  necDecode,
  necEncode,
  resetIrAir,
  NEC_REPEAT_PERIOD_MS,
} from '../simulation/ir';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { busRegistry } from '../simulation/buses';
import type {
  BoardPins,
  BusDiagnostic,
  GuestClock,
  I2cControllerPort,
  I2cTransactionHandler,
  NetResolver,
  SpiControllerPort,
} from '../simulation/buses';
import { i2cPartWorkerPin } from '../simulation/parts/i2cPart';
import { PinManager } from '../simulation/PinManager';
import {
  MPU6050_RULES,
  VirtualMPU6050,
  parseAd0,
  parseMpuVariant,
} from '../simulation/parts/ProtocolParts';

// ─── Globals ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => 1);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // No device and no board of one test on the bus fabric of the next.
  busRegistry.clear();
});

// ─── Mock factories ───────────────────────────────────────────────────────────

function makeElement(props: Record<string, unknown> = {}): HTMLElement {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    ...props,
  } as unknown as HTMLElement;
}

function makeI2CSim() {
  return {
    addI2CDevice: vi.fn(),
    i2cBus: { removeDevice: vi.fn() },
    removeI2CDevice: vi.fn(),
    setPinState: vi.fn(),
    pinManager: {
      onPinChange: vi.fn().mockReturnValue(() => {}),
    },
    spi: null,
    cpu: { data: new Uint8Array(512).fill(0), cycles: 0 },
  };
}

function makePinSim() {
  return {
    pinManager: {
      onPinChange: vi.fn().mockReturnValue(() => {}),
    },
    setPinState: vi.fn(),
    addI2CDevice: vi.fn(),
    i2cBus: { removeDevice: vi.fn() },
    spi: null,
    cpu: { data: new Uint8Array(512).fill(0), cycles: 0 },
  };
}

function makeSPISim() {
  const spi = {
    onByte: null as ((b: number) => void) | null,
    completeTransfer: vi.fn(),
  };
  return {
    spi,
    pinManager: { onPinChange: vi.fn().mockReturnValue(() => {}) },
    setPinState: vi.fn(),
    addI2CDevice: vi.fn(),
    i2cBus: { removeDevice: vi.fn() },
    cpu: { data: new Uint8Array(512).fill(0), cycles: 0 },
  };
}

const pinMap =
  (map: Record<string, number>) =>
  (name: string): number | null =>
    name in map ? map[name] : null;

const noPins = (_name: string): number | null => null;

// ─── A board on the bus fabric (project board-buses-2026-09) ──────────────────
//
// The SPI parts no longer take a simulator's SPI object: they register a
// device with the fabric, which decides from the CIRCUIT which bus they are on
// and only clocks them while their own chip select is active. So a rig for
// them provides what the app provides — where each pin of the part lands, and
// a controller that clocks frames — through the real contracts of
// simulation/buses/types.ts. Nothing here stands in for the part.

/** Where a part pin is wired: a board pin, or a rail. */
type RigPin = number | 'gnd' | 'vcc';

interface SpiRig {
  /** The controller clocks one frame; returns the MISO the guest reads back. */
  xfer(mosi: number): number;
  /** ...and several, in order. */
  send(bytes: number[]): number[];
  /** The MCU puts a level on one of its pins (chip select, D/C). */
  write(pin: number, level: boolean): void;
  /** The MCU was reset (Stop/Run). */
  reset(): void;
  dispose(): void;
}

const RIG_BOARD = 'rig-board';
const RIG_SCK = 13;
const RIG_MOSI = 11;
const RIG_MISO = 12;

/**
 * One board with one SPI controller on pins 13/11/12, and a circuit in which
 * `wiring` says where each pin of `componentId` lands.
 */
function spiRig(componentId: string, wiring: Record<string, RigPin>): SpiRig {
  const levels = new Map<number, boolean>();
  const listeners = new Map<number, Set<(p: number, l: boolean) => void>>();
  const pins: BoardPins = {
    onPinChange(pin, cb) {
      let s = listeners.get(pin);
      if (!s) listeners.set(pin, (s = new Set()));
      s.add(cb);
      return () => listeners.get(pin)?.delete(cb);
    },
    peekPinState: (pin) => levels.get(pin),
  };

  let handler: ((mosi: number, bits: number) => number) | null = null;
  let onReset: (() => void) | null = null;
  const port: SpiControllerPort = {
    bus: 'spi',
    unit: 0,
    name: 'SPI',
    setFrameHandler(h) {
      handler = h;
    },
    config: () => ({ enabled: true, mode: 0, bitOrder: 'msb', bits: 8 }),
    routing: () => ({ sck: RIG_SCK, mosi: RIG_MOSI, miso: RIG_MISO }),
  };

  const resolver: NetResolver = {
    resolve(ref) {
      if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
      if (ref.componentId !== componentId) return { kind: 'floating' };
      const at = wiring[ref.pinName];
      if (at === undefined) return { kind: 'floating' };
      if (at === 'gnd' || at === 'vcc') return { kind: 'rail', rail: at };
      return { kind: 'board', boardId: RIG_BOARD, pin: at };
    },
    boardKind: () => 'arduino-uno',
    boards: () => [RIG_BOARD],
  };

  busRegistry.setResolver(resolver);
  busRegistry.bindEngine(RIG_BOARD, {
    pins,
    spi: [port],
    setResetHandler: (h) => {
      onReset = h;
    },
  });

  const rig: SpiRig = {
    xfer: (mosi) => (handler ? handler(mosi, 8) : 0xff),
    send: (bytes) => bytes.map((b) => rig.xfer(b)),
    write(pin, level) {
      const prev = levels.get(pin);
      levels.set(pin, level);
      if (prev !== level) for (const cb of listeners.get(pin) ?? []) cb(pin, level);
    },
    reset() {
      levels.clear();
      onReset?.();
    },
    dispose: () => busRegistry.clear(),
  };
  return rig;
}

// ─── The same board with an I2C controller (F5) ──────────────────────────────
//
// An I2C part is on the bus its SDA and SCL are wired to, like an SPI part on
// its clock's: it registers with the fabric by its own pin names, and a
// controller routed to that SDA net reaches it. The rig is that controller,
// on SDA 18 / SCL 19 as on an Uno, driven the way a master drives the wire.

const RIG_SDA = 18;
const RIG_SCL = 19;

interface I2cRig {
  /** One write transaction: [address ACK, one ACK per byte]. */
  write(addr: number, bytes: number[]): boolean[];
  /** Point at `reg`, repeated START, read `n` bytes, STOP. Null on a NAK. */
  readReg(addr: number, reg: number, n: number): number[] | null;
  /** Whether anything ACKs the address (an I2C scanner's probe). */
  ack(addr: number): boolean;
  /** The wire itself, one call per START, byte and STOP. */
  bus(): I2cTransactionHandler;
  /** The MCU was reset (Stop/Run). */
  reset(): void;
  dispose(): void;
}

/**
 * The guest's clock as a test moves it: 16 MHz, like an Uno. Timers run when
 * the time they wait for is reached, in order, as an engine runs them between
 * two instructions.
 */
class RigClock implements GuestClock {
  cycles = 0;
  readonly hz = 16_000_000;
  private timers: Array<{ at: number; cb: () => void }> = [];
  now(): number {
    return this.cycles;
  }
  clockHz(): number {
    return this.hz;
  }
  scheduleEdge(): void {}
  at(atCycle: number, cb: () => void): () => void {
    const t = { at: atCycle, cb };
    this.timers.push(t);
    return () => {
      this.timers = this.timers.filter((x) => x !== t);
    };
  }
  /** Move the guest `us` microseconds on, firing every timer on the way. */
  advanceUs(us: number): void {
    const end = this.cycles + Math.round(us * 16);
    for (;;) {
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.cycles = Math.max(this.cycles, due.at);
      due.cb();
    }
    this.cycles = end;
  }
  pending(): number {
    return this.timers.length;
  }
}

function i2cRig(wiring: Record<string, Record<string, RigPin>>, clock?: GuestClock): I2cRig {
  let handler: I2cTransactionHandler | null = null;
  const port: I2cControllerPort = {
    bus: 'i2c',
    unit: 0,
    name: 'TWI',
    setTransactionHandler(h) {
      handler = h;
    },
    routing: () => ({ sda: RIG_SDA, scl: RIG_SCL }),
  };
  const resolver: NetResolver = {
    resolve(ref) {
      if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
      const at = wiring[ref.componentId]?.[ref.pinName];
      if (at === undefined) return { kind: 'floating' };
      if (at === 'gnd' || at === 'vcc') return { kind: 'rail', rail: at };
      return { kind: 'board', boardId: RIG_BOARD, pin: at };
    },
    boardKind: () => 'arduino-uno',
    boards: () => [RIG_BOARD],
  };
  let onReset: (() => void) | null = null;
  busRegistry.setResolver(resolver);
  busRegistry.bindEngine(RIG_BOARD, {
    pins: { onPinChange: () => () => {}, peekPinState: () => undefined },
    spi: [],
    i2c: [port],
    setResetHandler: (h) => {
      onReset = h;
    },
    ...(clock ? { clock } : {}),
  });
  const bus = () => handler!;
  return {
    bus,
    reset: () => onReset?.(),
    write(addr, bytes) {
      const acks = [bus().start(addr, false)];
      if (acks[0]) for (const b of bytes) acks.push(bus().write(b));
      bus().stop();
      return acks;
    },
    readReg(addr, reg, n) {
      if (!bus().start(addr, false) || !bus().write(reg)) {
        bus().stop();
        return null;
      }
      if (!bus().start(addr, true)) {
        bus().stop();
        return null;
      }
      const out = Array.from({ length: n }, () => bus().read());
      bus().stop();
      return out;
    },
    ack(addr) {
      const ok = bus().start(addr, false);
      bus().stop();
      return ok;
    },
    dispose: () => busRegistry.clear(),
  };
}

const HW_I2C_PINS = { SDA: RIG_SDA, SCL: RIG_SCL };
/** The 8-pin SSD1306 module in I2C mode: D1 (DATA) is SDA, D0 (CLK) is SCL. */
const OLED_I2C_PINS = { DATA: RIG_SDA, CLK: RIG_SCL };

/**
 * Simulator mock that triggers the ESP32 dual-path branch in ProtocolParts.
 *
 * Deliberately has no `addI2CDevice` so the `else if (registerSensor)` branch
 * is taken. Captures I2C transaction listeners so tests can fire them.
 */
function makeEsp32Sim() {
  const listeners = new Map<number, (data: number[]) => void>();
  return {
    registerSensor: vi.fn(),
    updateSensor: vi.fn(),
    unregisterSensor: vi.fn(),
    addI2CTransactionListener: vi.fn((addr: number, fn: (d: number[]) => void) => {
      listeners.set(addr, fn);
    }),
    removeI2CTransactionListener: vi.fn((addr: number) => {
      listeners.delete(addr);
    }),
    /** Simulate backend emitting an i2c_transaction for a given address. */
    _fireTransaction(addr: number, data: number[]) {
      listeners.get(addr)?.(data);
    },
    i2cBus: { removeDevice: vi.fn() },
    pinManager: { onPinChange: vi.fn().mockReturnValue(() => {}) },
    setPinState: vi.fn(),
    spi: null,
    cpu: { data: new Uint8Array(512) },
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

describe('Protocol parts — registration', () => {
  const IDS = [
    'ssd1306',
    'ds1307',
    'mpu6050',
    'bmp280',
    'ds3231',
    'pcf8574',
    'dht22',
    'hx711',
    'ir-receiver',
    'ir-remote',
    'microsd-card',
  ];

  it('registers all 11 protocol components', () => {
    for (const id of IDS) {
      expect(PartSimulationRegistry.get(id), `missing: ${id}`).toBeDefined();
    }
  });
});

// ─── ssd1306 ──────────────────────────────────────────────────────────────────

describe('ssd1306 — I2C device', () => {
  it('is on the bus its DATA/CLK are wired to, at 0x3C', () => {
    const rig = i2cRig({ oled: OLED_I2C_PINS });
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(makeElement(), makeI2CSim() as any, noPins, 'oled');
    expect(busRegistry.i2cPlacement('oled')).toEqual({
      boardId: RIG_BOARD,
      sdaPin: RIG_SDA,
      sclPin: RIG_SCL,
      clocked: true,
    });
    expect(rig.ack(0x3c)).toBe(true);
    expect(rig.ack(0x3d)).toBe(false);
  });

  it('cleanup takes it off the bus', () => {
    const rig = i2cRig({ oled: OLED_I2C_PINS });
    const cleanup = PartSimulationRegistry.get('ssd1306')!.attachEvents!(
      makeElement(),
      makeI2CSim() as any,
      noPins,
      'oled',
    );
    cleanup();
    expect(busRegistry.i2cPlacement('oled')).toBeNull();
    expect(rig.ack(0x3c)).toBe(false);
  });

  it('an OLED whose SDA/SCL are not wired does not answer', () => {
    const rig = i2cRig({});
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(makeElement(), makeI2CSim() as any, noPins, 'oled');
    expect(busRegistry.i2cPlacement('oled')).toBeNull();
    expect(rig.ack(0x3c)).toBe(false);
  });

  it('decodes horizontal addressing: write data bytes into the element', () => {
    const rig = i2cRig({ oled: OLED_I2C_PINS });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    const imageData = { width: 128, height: 64, data: new Uint8ClampedArray(128 * 64 * 4) };
    const el = makeElement({ imageData, redraw: vi.fn() });
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(el, makeI2CSim() as any, noPins, 'oled');
    // Command stream: display on, upright (0xAF, 0xA1, 0xC8, as every
    // driver's init leaves it; the panel powers up off), column 0-127, page 0-7.
    expect(rig.write(0x3c, [0x00, 0xaf, 0xa1, 0xc8, 0x21, 0x00, 0x7f, 0x22, 0x00, 0x07])).not.toContain(false);
    // Data stream: column 0 of page 0 = 0xAB (bits 0, 1, 3, 5, 7 lit).
    rig.write(0x3c, [0x40, 0xab]);
    // The panel paints on the next animation frame.
    for (const cb of frames.splice(0, frames.length)) cb(0);
    const px = (y: number) => (el as unknown as { imageData: ImageData }).imageData.data[y * 128 * 4];
    expect([0, 1, 2, 3].map((y) => px(y) > 0)).toEqual([true, true, false, true]);
  });

  it('reads back 0xFF (a write-only panel drives nothing)', () => {
    const rig = i2cRig({ oled: OLED_I2C_PINS });
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(makeElement(), makeI2CSim() as any, noPins, 'oled');
    expect(rig.readReg(0x3c, 0x00, 1)).toEqual([0xff]);
  });

  it('no-op with no canvas identity', () => {
    const sim = { ...makeI2CSim(), addI2CDevice: undefined };
    const logic = PartSimulationRegistry.get('ssd1306')!;
    expect(() => {
      const c = logic.attachEvents!(makeElement(), sim as any, noPins);
      c();
    }).not.toThrow();
  });
});

// ─── ssd1306 — protocol auto-detect (one component, wired like real life) ─────

describe('ssd1306 — protocol auto-detect', () => {
  it('runs I2C when neither CS nor DC is wired', () => {
    i2cRig({ oled: OLED_I2C_PINS });
    const sim = makeI2CSim();
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(makeElement(), sim as any, noPins, 'oled');
    expect(busRegistry.i2cPlacement('oled')).not.toBeNull();
    expect(busRegistry.placement('oled')).toBeNull();
  });

  it('runs SPI when CS is wired to a GPIO', () => {
    // The SPI path joins the board's SPI bus; the I2C one would call
    // addI2CDevice. (It used to hook spi.onByte, the chain that F3 removed.)
    const rig = spiRig('oled-spi', { CLK: RIG_SCK, DATA: RIG_MOSI, CS: 5 });
    try {
      const sim = makeSPISim();
      PartSimulationRegistry.get('ssd1306')!.attachEvents!(
        makeElement(),
        sim as any,
        pinMap({ CS: 5 }),
        'oled-spi',
      );
      expect(busRegistry.placement('oled-spi')).toEqual({
        boardId: RIG_BOARD,
        sckPin: RIG_SCK,
        selected: false,
      });
      expect(sim.addI2CDevice).not.toHaveBeenCalled();
    } finally {
      rig.dispose();
    }
  });

  it('paints the frames clocked while its CS is low, and nothing else', () => {
    // D/C already high when the part attaches (F0: spi-part-state-not-seeded-
    // on-reattach), so every byte here is pixel data.
    const rig = spiRig('oled-spi', { CLK: RIG_SCK, DATA: RIG_MOSI, CS: 5 });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    const flush = () => {
      const due = frames.splice(0, frames.length);
      for (const cb of due) cb(0);
    };
    const el = makeElement({
      imageData: { width: 128, height: 64, data: new Uint8ClampedArray(128 * 64 * 4) },
      redraw: vi.fn(),
    });
    const lit = () => {
      const px = (el as unknown as { imageData: { data: Uint8ClampedArray } }).imageData.data;
      let n = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i] !== 0) n++;
      return n;
    };
    try {
      let setDc: (pin: number, high: boolean) => void = () => {};
      const sim = {
        ...makeSPISim(),
        pinManager: {
          onPinChange: vi.fn((_pin: number, cb: (pin: number, high: boolean) => void) => {
            setDc = cb;
            return () => {};
          }),
          peekPinState: () => true,
        },
      };
      const cleanup = PartSimulationRegistry.get('ssd1306')!.attachEvents!(
        el,
        sim as any,
        pinMap({ CS: 5, DC: 9 }),
        'oled-spi',
      )!;
      // The panel powers up off (datasheet 8.5): switch it on, upright, the
      // way every driver's init does, then back to pixel data.
      rig.write(5, false);
      setDc(9, false);
      rig.send([0xaf, 0xa1, 0xc8]);
      setDc(9, true);
      flush();
      expect(lit()).toBe(0);
      // Somebody else's traffic, clocked while the panel is deselected. A
      // write-only panel drives no MISO either: the line keeps its idle level.
      rig.write(5, true);
      expect(rig.send([0xff, 0xff])).toEqual([0xff, 0xff]);
      flush();
      expect(lit()).toBe(0);
      // Its own: one column of eight pixels per byte.
      rig.write(5, false);
      rig.send([0xff, 0xff]);
      flush();
      expect(lit()).toBe(16);
      cleanup();
      expect(busRegistry.placement('oled-spi')).toBeNull();
    } finally {
      rig.dispose();
    }
  });

  it('over SPI a command alone repaints: invert shows on the next frame without a data byte', () => {
    const rig = spiRig('oled-spi', { CLK: RIG_SCK, DATA: RIG_MOSI, CS: 5 });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    const flush = () => {
      for (const cb of frames.splice(0, frames.length)) cb(0);
    };
    const el = makeElement({
      imageData: { width: 128, height: 64, data: new Uint8ClampedArray(128 * 64 * 4) },
      redraw: vi.fn(),
    });
    const lit = () => {
      const px = (el as unknown as { imageData: { data: Uint8ClampedArray } }).imageData.data;
      let n = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i] !== 0) n++;
      return n;
    };
    try {
      let setDc: (pin: number, high: boolean) => void = () => {};
      const sim = {
        ...makeSPISim(),
        pinManager: {
          onPinChange: vi.fn((_pin: number, cb: (pin: number, high: boolean) => void) => {
            setDc = cb;
            return () => {};
          }),
          peekPinState: () => false,
        },
      };
      PartSimulationRegistry.get('ssd1306')!.attachEvents!(el, sim as any, pinMap({ CS: 5, DC: 9 }), 'oled-spi');
      rig.write(5, false);
      rig.send([0xaf, 0xa1, 0xc8]);
      setDc(9, true);
      rig.send([0xff]);
      flush();
      expect(lit()).toBe(8);
      setDc(9, false);
      rig.send([0xa7]);
      flush();
      expect(lit()).toBe(128 * 64 - 8);
    } finally {
      rig.dispose();
    }
  });

  it('runs I2C when only DC is wired (DC is the I2C address-select, not SPI)', () => {
    i2cRig({ oled: { ...OLED_I2C_PINS, DC: 4 } });
    const sim = makeI2CSim();
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(
      makeElement(),
      sim as any,
      pinMap({ DC: 4 }),
      'oled',
    );
    expect(busRegistry.i2cPlacement('oled')).not.toBeNull();
    expect(busRegistry.placement('oled')).toBeNull();
  });

  it('honors an explicit protocol property (migrated legacy projects)', () => {
    // A project migrated from the old ssd1306-spi entry carries protocol:'spi';
    // it must run SPI even though nothing SPI-specific is wired (CS absent).
    useSimulatorStore.setState({
      components: [{ id: 'oled-legacy', metadataId: 'ssd1306', properties: { protocol: 'spi' } }],
    } as any);
    const rig = spiRig('oled-legacy', { CLK: RIG_SCK, DATA: RIG_MOSI });
    try {
      const sim = makeSPISim();
      PartSimulationRegistry.get('ssd1306')!.attachEvents!(
        makeElement(),
        sim as any,
        noPins,
        'oled-legacy',
      );
      // On the bus, and selected: a panel wired for SPI whose CS pad nobody
      // drives is the only chip on that bus (csWhenFloating: 'selected').
      expect(busRegistry.placement('oled-legacy')).toEqual({
        boardId: RIG_BOARD,
        sckPin: RIG_SCK,
        selected: true,
      });
      expect(busRegistry.i2cPlacement('oled-legacy')).toBeNull();
    } finally {
      rig.dispose();
      useSimulatorStore.setState({ components: [] } as any);
    }
  });
});

// ─── ds1307 ───────────────────────────────────────────────────────────────────

describe('ds1307 — I2C RTC', () => {
  it('answers at 0x68 on the bus it is wired to', () => {
    const rig = i2cRig({ rtc: HW_I2C_PINS });
    PartSimulationRegistry.get('ds1307')!.attachEvents!(makeElement(), makeI2CSim() as any, noPins, 'rtc');
    expect(rig.ack(0x68)).toBe(true);
  });

  it('reads the time of the browser in BCD, with Monday as day 1', () => {
    vi.setSystemTime(new Date(2026, 8, 30, 12, 34, 56, 250)); // a Wednesday
    const rig = i2cRig({ rtc: HW_I2C_PINS });
    PartSimulationRegistry.get('ds1307')!.attachEvents!(makeElement(), makeI2CSim() as any, noPins, 'rtc');
    expect(rig.readReg(0x68, 0x00, 7)).toEqual([0x56, 0x34, 0x12, 0x03, 0x30, 0x09, 0x26]);
  });

  it('cleanup takes it off the bus', () => {
    const rig = i2cRig({ rtc: HW_I2C_PINS });
    const cleanup = PartSimulationRegistry.get('ds1307')!.attachEvents!(
      makeElement(),
      makeI2CSim() as any,
      noPins,
      'rtc',
    );
    cleanup();
    expect(rig.ack(0x68)).toBe(false);
  });
});

// ─── mpu6050 ──────────────────────────────────────────────────────────────────

const attachImu = (id = 'imu', props: Record<string, unknown> = {}) =>
  PartSimulationRegistry.get('mpu6050')!.attachEvents!(
    makeElement(props),
    makeI2CSim() as any,
    noPins,
    id,
  );

/** PWR_MGMT_1 = 0x00. The chip powers on asleep, and a driver's first write is this one. */
const wakeImu = (rig: I2cRig, addr = 0x68) => rig.write(addr, [0x6b, 0x00]);

describe('mpu6050 — I2C IMU', () => {
  it('answers at 0x68 with AD0 low', () => {
    const rig = i2cRig({ imu: HW_I2C_PINS });
    attachImu();
    expect([rig.ack(0x68), rig.ack(0x69)]).toEqual([true, false]);
  });

  it('answers at 0x69 when element.ad0 is true', () => {
    const rig = i2cRig({ imu: HW_I2C_PINS });
    attachImu('imu', { ad0: true });
    expect([rig.ack(0x68), rig.ack(0x69)]).toEqual([false, true]);
  });

  it('follows the AD0 net: tied to a supply 0x69, to ground or left floating 0x68', () => {
    const at = (ad0?: RigPin, props: Record<string, unknown> = {}) => {
      const rig = i2cRig({ imu: { ...HW_I2C_PINS, ...(ad0 !== undefined ? { AD0: ad0 } : {}) } });
      const off = attachImu('imu', props);
      const answer = [rig.ack(0x68), rig.ack(0x69)];
      off();
      rig.dispose();
      return answer;
    };
    expect(at('vcc')).toEqual([false, true]);
    expect(at('gnd')).toEqual([true, false]);
    expect(at()).toEqual([true, false]);
    // A GPIO that drives it is read as low: the address is picked at attach.
    expect(at(7)).toEqual([true, false]);
    // The property overrides the wiring, either way.
    expect(at('vcc', { ad0: 'false' })).toEqual([true, false]);
    expect(at('gnd', { ad0: 'high' })).toEqual([false, true]);
  });

  it('reads the variant property as the worker reads its record', () => {
    const cases: Array<[unknown, string]> = [
      ['mpu9250', 'mpu9250'],
      ['MPU-9250', 'mpu9250'],
      [' Mpu9250 ', 'mpu9250'],
      ['mpu6050', 'mpu6050'],
      ['mpu6500', 'mpu6050'],
      [undefined, 'mpu6050'],
      [9250, 'mpu6050'],
    ];
    for (const [value, die] of cases) expect(parseMpuVariant(value), String(value)).toBe(die);
  });

  it('answers as the die it is set to, and names it in its notes', () => {
    const rig = i2cRig({ imu: HW_I2C_PINS });
    attachImu('imu', { variant: 'MPU-9250' });
    const heard: BusDiagnostic[] = [];
    const off = busRegistry.onDiagnostic((d) => heard.push(d));
    expect(rig.readReg(0x68, 0x75, 1)).toEqual([0x71]);
    // The MPU-9250 powers on awake (PWR_MGMT_1 = 0x01): no note until the
    // sketch puts it to sleep.
    expect(rig.readReg(0x68, 0x6b, 1)).toEqual([0x01]);
    rig.readReg(0x68, 0x3b, 2);
    expect(heard).toEqual([]);
    rig.write(0x68, [0x6b, 0x40]);
    rig.readReg(0x68, 0x3b, 2);
    off();
    expect(heard.map((d) => d.message.split(' ')[0])).toEqual(['MPU9250']);
  });

  it('reads the ad0 property as the worker reads its record', () => {
    const values = MPU_VECTORS.ad0_values;
    expect(values.length).toBeGreaterThan(10);
    for (const [value, forced] of values) {
      const want = forced === null ? null : forced === '69';
      expect(parseAd0(value), JSON.stringify(value)).toBe(want);
    }
  });

  it('WHO_AM_I register (0x75) returns 0x68', () => {
    const rig = i2cRig({ imu: HW_I2C_PINS });
    attachImu();
    expect(rig.readReg(0x68, 0x75, 1)).toEqual([0x68]);
  });

  it('powers on asleep: PWR_MGMT_1 reads 0x40 and the sample block reads zeros until SLEEP is cleared', () => {
    const rig = i2cRig({ imu: HW_I2C_PINS });
    attachImu();
    expect(rig.readReg(0x68, 0x6b, 1)).toEqual([0x40]);
    expect(rig.readReg(0x68, 0x3b, 14)).toEqual(new Array(14).fill(0));
    wakeImu(rig);
    expect(rig.readReg(0x68, 0x6b, 1)).toEqual([0x00]);
    expect(rig.readReg(0x68, 0x3f, 2)).toEqual([0x40, 0x00]);
  });

  it('TEMP_OUT starts at the panel default (24 C), not at a value of the model', () => {
    const rig = i2cRig({ imu: HW_I2C_PINS });
    attachImu();
    wakeImu(rig);
    expect(SENSOR_CONTROLS.mpu6050.defaultValues.temp).toBe(24);
    const [hi, lo] = rig.readReg(0x68, 0x41, 2)!;
    const raw = (((hi << 8) | lo) << 16) >> 16;
    expect(raw / 340 + 36.53).toBeCloseTo(24, 2);
  });

  it('ACCEL_ZOUT reports +1g (0x40, 0x00) at the power-on range', () => {
    const rig = i2cRig({ imu: HW_I2C_PINS });
    attachImu();
    wakeImu(rig);
    expect(rig.readReg(0x68, 0x3f, 2)).toEqual([0x40, 0x00]);
  });

  it('DEVICE_RESET is gone by the next read, so a driver that polls it moves on', () => {
    // Adafruit_MPU6050::reset() waits for bit 7 of PWR_MGMT_1 with no timeout.
    // The model used to store the byte as written, and begin() never returned.
    const rig = i2cRig({ imu: HW_I2C_PINS });
    attachImu();
    rig.write(0x68, [0x6b, 0x80]);
    expect(rig.readReg(0x68, 0x6b, 1)![0] & 0x80).toBe(0);
  });

  it('a repeated START for writing starts a new register pointer (no STOP in between)', () => {
    // M5Unified reads an IMU id twice with no STOP between the two reads: the
    // second pointer write must be taken as a pointer, not as data.
    const rig = i2cRig({ imu: HW_I2C_PINS });
    attachImu();
    const h = busRegistry.fabric(RIG_BOARD).i2cBuses.get(RIG_SDA)!;
    h.start(0x68, false);
    h.write(0x75);
    h.start(0x68, true);
    expect(h.read()).toBe(0x68);
    h.start(0x68, false);
    h.write(0x75);
    h.start(0x68, true);
    expect(h.read()).toBe(0x68);
    h.stop();
    expect(rig.readReg(0x68, 0x75, 1)).toEqual([0x68]);
  });

  it('the panel reaches past the power-on range: 16 g and 2000 deg/s', () => {
    const range = (key: string) => {
      const c = SENSOR_CONTROLS.mpu6050.controls.find((x) => x.key === key);
      return c?.type === 'slider' ? [c.min, c.max] : null;
    };
    for (const key of ['accelX', 'accelY', 'accelZ']) expect(range(key), key).toEqual([-16, 16]);
    for (const key of ['gyroX', 'gyroY', 'gyroZ']) expect(range(key), key).toEqual([-2000, 2000]);
    expect(SENSOR_CONTROLS.mpu6050.defaultValues).toEqual({
      accelX: 0,
      accelY: 0,
      accelZ: 1,
      gyroX: 0,
      gyroY: 0,
      gyroZ: 0,
      temp: 24,
    });
  });

  it('cleanup takes it off the bus', () => {
    const rig = i2cRig({ imu: HW_I2C_PINS });
    const cleanup = attachImu();
    cleanup();
    expect(rig.ack(0x68)).toBe(false);
  });

  it('two IMUs at 0x68: deleting one leaves the other answering', () => {
    const rig = i2cRig({ imuA: HW_I2C_PINS, imuB: HW_I2C_PINS });
    const offA = attachImu('imuA');
    attachImu('imuB');
    offA();
    expect(rig.readReg(0x68, 0x75, 1)).toEqual([0x68]);
  });
});

// ─── mpu6050: the bus vectors it shares with the backend twin ────────────────
//
// test/fixtures/i2c-vectors/mpu6050.json, format in the README next to it.
// The Python twin replays the same file, so the two models cannot drift.

interface VectorStep {
  op: string;
  data?: string;
  reg?: string;
  n?: number;
  expect?: string;
  rw?: string;
  at?: string;
  values?: Record<string, number>;
  us?: number;
}

interface BusVector {
  name: string;
  spec: string;
  driver?: string;
  /** False: the host keeps no guest time. Otherwise it stands at 0 until `advance`. */
  clock?: boolean;
  /** The die the model is built as (the part's `variant` property). */
  variant?: string;
  steps: VectorStep[];
}

interface BusVectorFile {
  address: string;
  ad0_values: Array<[unknown, string | null]>;
  rules: Record<string, unknown>;
  inputs: Record<string, number>;
  vectors: BusVector[];
}

const MPU_VECTORS: BusVectorFile = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../test/fixtures/i2c-vectors/mpu6050.json', import.meta.url)),
    'utf8',
  ),
);
const MPU_ADDR = parseInt(MPU_VECTORS.address, 16);

/** "6B 00", "00*107 40": bytes in hex, XX*N repeats one. */
function hexBytes(text: string): number[] {
  const out: number[] = [];
  for (const token of text.split(/\s+/).filter(Boolean)) {
    const [byte, times] = token.split('*');
    for (let i = times === undefined ? 1 : parseInt(times, 10); i > 0; i--)
      out.push(parseInt(byte, 16));
  }
  return out;
}

const hexText = (bytes: readonly number[]): string =>
  bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/** What replays a vector: the wire, the panel, and the copy a host would mirror. */
interface VectorHost {
  start(read: boolean): boolean;
  write(byte: number): boolean;
  read(): number;
  stop(): void;
  inputs(values: Record<string, number>): void;
  dump(): Uint8Array;
  /** What the INT pad does; a host that cannot see it skips the step. */
  intPad?(): string;
  /** Move the guest's time on. */
  advanceUs?(us: number): void;
}

/** The part on the rig's bus, as a board whose firmware runs in the tab reaches it. */
function partHost(rig: I2cRig, id: string): VectorHost {
  const bus = rig.bus();
  return {
    start: (read) => bus.start(MPU_ADDR, read),
    write: (byte) => bus.write(byte),
    read: () => bus.read(),
    stop: () => bus.stop(),
    inputs: (values) => dispatchSensorUpdate(id, values),
    dump: () => {
      const target = busRegistry
        .fabric(RIG_BOARD)
        .i2cBuses.get(RIG_SDA)!
        .targetsAt(MPU_ADDR)[0].target;
      return (target as { dumpRegisters?: () => Uint8Array }).dumpRegisters!();
    },
  };
}

/**
 * The model alone, under a host that never says where a read begins: it
 * clears the pointer flag on a START for writing and that is all it knows
 * (the overlay's PartI2cTarget). The model then latches on the first byte
 * read after a write or a STOP.
 */
function bareHost(dev: VirtualMPU6050, clock?: RigClock): VectorHost {
  if (clock) dev.setClock(clock);
  return {
    intPad: () => dev.intPad(),
    advanceUs: clock ? (us) => clock.advanceUs(us) : undefined,
    start: (read) => {
      if (!read) dev.stop();
      return true;
    },
    write: (byte) => dev.writeByte(byte),
    read: () => dev.readByte(),
    stop: () => dev.stop(),
    inputs: (values) => dev.setInputs(values),
    dump: () => dev.dumpRegisters(),
  };
}

type BusFlavour = 'repeated-start' | 'stop-start';

function replayVector(host: VectorHost, vector: BusVector, flavour: BusFlavour): void {
  let open = false;
  const start = (read: boolean) => {
    // QEMU hands a device model a repeated START as FINISH and then START.
    if (open && flavour === 'stop-start') host.stop();
    open = true;
    expect(host.start(read), 'the address is acknowledged').toBe(true);
  };
  const stop = () => {
    open = false;
    host.stop();
  };
  const send = (bytes: number[]) => {
    for (const b of bytes) expect(host.write(b), `0x${b.toString(16)} is acknowledged`).toBe(true);
  };
  const recv = (n: number) => Array.from({ length: n }, () => host.read() & 0xff);

  vector.steps.forEach((step, i) => {
    let got: number[] | null = null;
    switch (step.op) {
      case 'write':
        start(false);
        send(hexBytes(step.data!));
        stop();
        break;
      case 'read':
        start(false);
        send([parseInt(step.reg!, 16)]);
        start(true);
        got = recv(step.n!);
        stop();
        break;
      case 'get':
        start(true);
        got = recv(step.n!);
        stop();
        break;
      case 'start':
        start(step.rw === 'r');
        break;
      case 'send':
        send(hexBytes(step.data!));
        break;
      case 'recv':
        got = recv(step.n!);
        break;
      case 'stop':
        stop();
        break;
      case 'inputs':
        host.inputs(step.values!);
        break;
      case 'dump': {
        const at = parseInt(step.at!, 16);
        got = Array.from(host.dump().slice(at, at + hexBytes(step.expect!).length));
        break;
      }
      case 'advance':
        expect(host.advanceUs, `step ${i}: time moves in a vector with no clock`).toBeDefined();
        host.advanceUs!(step.us!);
        break;
      case 'int':
        if (host.intPad) expect(host.intPad(), `step ${i} ${JSON.stringify(step)}`).toBe(step.expect);
        break;
      default:
        throw new Error(`step ${i}: unknown op "${step.op}"`);
    }
    if (got)
      expect(hexText(got), `step ${i} ${JSON.stringify(step)}`).toBe(
        hexText(hexBytes(step.expect!)),
      );
  });
}

/**
 * A model's rules table as the vectors write it: a table keyed by register
 * has hexadecimal keys and bytes, the ranges of registers are hexadecimal
 * pairs, and everything else is a plain number or list.
 */
function rulesAsJson(rules: object): Record<string, unknown> {
  const hex = (n: number) => hexText([n]);
  const value = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      if (v.length > 0 && v.every(Array.isArray)) return v.map(([a, b]) => [hex(a), hex(b)]);
      return v.map(value);
    }
    if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v);
      if (entries.every(([k]) => /^\d+$/.test(k))) {
        return Object.fromEntries(entries.map(([k, x]) => [hex(Number(k)), hex(x as number)]));
      }
      return Object.fromEntries(entries.map(([k, x]) => [k, value(x)]));
    }
    return v;
  };
  return Object.fromEntries(Object.entries(rules).map(([k, v]) => [k, value(v)]));
}

describe('mpu6050 — the rules table', () => {
  it('is the table the shared vectors carry', () => {
    expect(rulesAsJson(MPU6050_RULES)).toEqual(MPU_VECTORS.rules);
  });

  it('starts every vector from the values the panel starts from', () => {
    expect(MPU_VECTORS.inputs).toEqual(SENSOR_CONTROLS.mpu6050.defaultValues);
    expect(new VirtualMPU6050(MPU_ADDR).getInputs()).toEqual(MPU_VECTORS.inputs);
  });
});

describe('mpu6050 — shared bus vectors', () => {
  const flavours: BusFlavour[] = ['repeated-start', 'stop-start'];

  describe.each(flavours)('the part on the bus fabric, %s', (flavour) => {
    it.each(MPU_VECTORS.vectors.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
      // The guest's clock stands still until a step moves it; a vector that
      // says `"clock": false` is a board that keeps no time.
      const clock = vector.clock === false ? undefined : new RigClock();
      const rig = i2cRig({ imu: HW_I2C_PINS }, clock);
      attachImu('imu', vector.variant ? { variant: vector.variant } : {});
      const host = partHost(rig, 'imu');
      if (clock) host.advanceUs = (us) => clock.advanceUs(us);
      host.inputs(MPU_VECTORS.inputs);
      replayVector(host, vector, flavour);
    });
  });

  describe.each(flavours)('the model under a host that does not announce START, %s', (flavour) => {
    it.each(MPU_VECTORS.vectors.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
      const clock = vector.clock === false ? undefined : new RigClock();
      const host = bareHost(
        new VirtualMPU6050(MPU_ADDR, parseMpuVariant(vector.variant)),
        clock,
      );
      host.inputs(MPU_VECTORS.inputs);
      replayVector(host, vector, flavour);
    });
  });
});

// ─── mpu6050: what four drivers put on the wire, and what they read back ─────
//
// Each driver below is its library's own code path, read from the source the
// vector names, against the part. A field write is a read-modify-write in all
// of them, so what they write depends on what the model answered: the traffic
// is compared step by step with the vector of the same name, which is the
// copy the Python twin replays.

/** A driver's side of the wire. Every transaction is kept as a step of the vector format. */
class DriverWire {
  readonly steps: VectorStep[] = [];
  private readonly host: VectorHost;

  constructor(host: VectorHost) {
    this.host = host;
  }

  /** beginTransmission, the bytes, endTransmission(): a STOP ends it. No bytes is a probe. */
  write(...bytes: number[]): void {
    expect(this.host.start(false)).toBe(true);
    for (const b of bytes) expect(this.host.write(b)).toBe(true);
    this.host.stop();
    this.steps.push({ op: 'write', data: hexText(bytes) });
  }

  /** The pointer, a repeated START, n bytes: endTransmission(false) and requestFrom. */
  read(reg: number, n: number): number[] {
    expect(this.host.start(false)).toBe(true);
    expect(this.host.write(reg)).toBe(true);
    expect(this.host.start(true)).toBe(true);
    const got = Array.from({ length: n }, () => this.host.read() & 0xff);
    this.host.stop();
    this.steps.push({ op: 'read', reg: hexText([reg]), n, expect: hexText(got) });
    return got;
  }

  /** requestFrom on its own: n bytes from wherever the pointer is. */
  get(n: number): number[] {
    expect(this.host.start(true)).toBe(true);
    const got = Array.from({ length: n }, () => this.host.read() & 0xff);
    this.host.stop();
    this.steps.push({ op: 'get', n, expect: hexText(got) });
    return got;
  }

  /** Not the driver: the panel moves while the sketch runs. */
  inputs(values: Record<string, number>): void {
    this.host.inputs(values);
    this.steps.push({ op: 'inputs', values });
  }
}

const int16 = (hi: number, lo: number): number => (((hi << 8) | lo) << 16) >> 16;

/** A field of a register that is written by reading the register and writing it back whole. */
function registerField(wire: DriverWire, reg: number, width: number, shift: number) {
  const mask = ((1 << width) - 1) << shift;
  return {
    read: (): number => (wire.read(reg, 1)[0] & mask) >> shift,
    write: (value: number): void => {
      const now = wire.read(reg, 1)[0];
      wire.write(reg, (now & ~mask) | ((value << shift) & mask));
    },
  };
}

/** How many reads of a self-clearing bit a driver's wait loop makes before it moves on. */
function pollUntilClear(bit: { read(): number }): number {
  let reads = 1;
  while (bit.read() === 1) {
    if (++reads > 50) throw new Error('the reset bit never cleared: the driver hangs here');
  }
  return reads;
}

/**
 * Adafruit_MPU6050 2.2.9 on Adafruit BusIO 1.17.4: Adafruit_MPU6050.cpp
 * begin(), _init(), reset() and _read(), with Adafruit_I2CDevice.cpp and
 * Adafruit_BusIO_Register.cpp for the transactions. The same library,
 * compiled, is in mpu6050-real-firmware.test.ts.
 */
function adafruitArduino(wire: DriverWire) {
  const accelRange = registerField(wire, 0x1c, 2, 3);
  const gyroRange = registerField(wire, 0x1b, 2, 3);
  const bandwidth = registerField(wire, 0x1a, 3, 0);
  return {
    /** How often reset() read DEVICE_RESET, or null when begin() says "not found". */
    begin(): number | null {
      wire.write(); // Adafruit_I2CDevice::detected()
      if (wire.read(0x75, 1)[0] !== 0x68) return null;
      const deviceReset = registerField(wire, 0x6b, 1, 7);
      deviceReset.write(1);
      const polls = pollUntilClear(deviceReset);
      wire.write(0x68, 0x07); // sig_path_reset
      wire.write(0x19, 0); // setSampleRateDivisor(0)
      bandwidth.write(0); // MPU6050_BAND_260_HZ
      gyroRange.write(1); // MPU6050_RANGE_500_DEG
      accelRange.write(0); // MPU6050_RANGE_2_G
      wire.write(0x6b, 0x01); // PLL on the X gyro, which is also what wakes the chip
      return polls;
    },
    setAccelerometerRange: accelRange.write,
    setGyroRange: gyroRange.write,
    setFilterBandwidth: bandwidth.write,
    /** getEvent(): m/s2, rad/s and deg C, with SENSORS_GRAVITY_STANDARD and SENSORS_DPS_TO_RADS. */
    getEvent() {
      const b = wire.read(0x3b, 14);
      const accelScale = [16384, 8192, 4096, 2048][accelRange.read()];
      const gyroScale = [131, 65.5, 32.8, 16.4][gyroRange.read()];
      return {
        acceleration: [0, 2, 4].map((i) => (int16(b[i], b[i + 1]) / accelScale) * 9.80665),
        gyro: [8, 10, 12].map((i) => (int16(b[i], b[i + 1]) / gyroScale) * 0.017453293),
        temperature: int16(b[6], b[7]) / 340 + 36.53,
      };
    },
  };
}

/**
 * CircuitPython adafruit_mpu6050 1.3.9 on adafruit_register 1.13.0 and
 * adafruit_bus_device 5.2.17: __init__(), reset() and the three properties.
 * An element of a StructArray is a transaction of its own, so one reading of
 * the acceleration is three reads of two bytes.
 */
function adafruitCircuitPython(wire: DriverWire) {
  const accelRange = registerField(wire, 0x1c, 2, 3);
  const gyroRange = registerField(wire, 0x1b, 2, 3);
  let accelScale = 0;
  const pair = (reg: number) => {
    const [hi, lo] = wire.read(reg, 2);
    return int16(hi, lo);
  };
  return {
    /** How often reset() read _reset. */
    init(): number {
      wire.write(); // the I2CDevice probe, writeto(address, b"")
      if (wire.read(0x75, 1)[0] !== 0x68)
        throw new Error('Failed to find MPU6050 - check your wiring!');
      const reset = registerField(wire, 0x6b, 1, 7);
      reset.write(1);
      const polls = pollUntilClear(reset);
      // _signal_path_reset is RWBits(3, 0x68, 3): the driver sets bits 5:3.
      registerField(wire, 0x68, 3, 3).write(0b111);
      // self._sample_rate_divisor = 0 names no register (the descriptor is
      // sample_rate_divisor), so nothing goes out for it.
      registerField(wire, 0x1a, 3, 0).write(0); // _filter_bandwidth = BAND_260_HZ
      gyroRange.write(1); // RANGE_500_DPS
      accelRange.write(0); // RANGE_2_G
      accelScale = 1 / [16384, 8192, 4096, 2048][accelRange.read()];
      registerField(wire, 0x6b, 3, 0).write(1); // clock_source = CLKSEL_INTERNAL_X
      registerField(wire, 0x6b, 1, 6).write(0); // sleep = False
      return polls;
    },
    acceleration: (): number[] => [0x3b, 0x3d, 0x3f].map((reg) => pair(reg) * accelScale * 9.80665),
    gyro(): number[] {
      const raw = [0x43, 0x45, 0x47].map(pair);
      const scale = [131, 65.5, 32.8, 16.4][gyroRange.read()];
      return raw.map((v) => ((v / scale) * Math.PI) / 180);
    },
    temperature: (): number => pair(0x41) / 340 + 36.53,
  };
}

/**
 * i2cdevlib MPU6050 on I2Cdev over Arduino Wire: MPU6050.cpp initialize() and
 * getMotion6(), I2Cdev.cpp readBytes() and writeBits(). readBytes ends its
 * pointer write with a STOP before it reads.
 */
function i2cdevlib(wire: DriverWire) {
  const readBytes = (reg: number, n: number) => {
    wire.write(reg);
    return wire.get(n);
  };
  const writeBits = (reg: number, bitStart: number, length: number, data: number) => {
    const shift = bitStart - length + 1;
    const mask = ((1 << length) - 1) << shift;
    const now = readBytes(reg, 1)[0];
    wire.write(reg, (now & ~mask) | ((data << shift) & mask));
  };
  return {
    initialize(): void {
      writeBits(0x6b, 2, 3, 1); // setClockSource(MPU6050_CLOCK_PLL_XGYRO)
      writeBits(0x1b, 4, 2, 0); // setFullScaleGyroRange(MPU6050_GYRO_FS_250)
      writeBits(0x1c, 4, 2, 0); // setFullScaleAccelRange(MPU6050_ACCEL_FS_2)
      writeBits(0x6b, 6, 1, 0); // setSleepEnabled(false)
    },
    /** Raw counts: ax, ay, az, gx, gy, gz. */
    getMotion6(): number[] {
      const b = readBytes(0x3b, 14);
      return [0, 2, 4, 8, 10, 12].map((i) => int16(b[i], b[i + 1]));
    },
  };
}

/** rfetick/MPU6050_light: MPU6050_light.cpp begin() with its defaults, and fetchData(). */
function mpu6050Light(wire: DriverWire) {
  const fetchData = () => {
    const b = wire.read(0x3b, 14);
    return {
      accZ: int16(b[4], b[5]) / 16384,
      gyroX: int16(b[8], b[9]) / 65.5,
      temp: (int16(b[6], b[7]) + 12412) / 340,
    };
  };
  return {
    begin(): void {
      wire.write(0x6b, 0x01);
      wire.write(0x19, 0x00);
      wire.write(0x1a, 0x00);
      wire.write(0x1b, 0x08); // setGyroConfig(1): 500 deg/s
      wire.write(0x1c, 0x00); // setAccConfig(0): 2 g
      fetchData(); // begin() ends with an update()
    },
    fetchData,
  };
}

describe('mpu6050 — driver traces', () => {
  /** The vector of a driver, with every byte list written out. */
  const traceOf = (driver: string): VectorStep[] =>
    MPU_VECTORS.vectors
      .find((v) => v.driver === driver)!
      .steps.map((step) => ({
        ...step,
        ...(step.data === undefined ? {} : { data: hexText(hexBytes(step.data)) }),
        ...(step.expect === undefined ? {} : { expect: hexText(hexBytes(step.expect)) }),
      }));

  const onTheBus = (): DriverWire => {
    const rig = i2cRig({ imu: HW_I2C_PINS });
    attachImu();
    return new DriverWire(partHost(rig, 'imu'));
  };

  it('Adafruit_MPU6050: begin() leaves its reset poll after one read; the gallery sketch reads 9.81 m/s2 and 1.745 rad/s', () => {
    const wire = onTheBus();
    const mpu = adafruitArduino(wire);
    expect(mpu.begin()).toBe(1);
    // The gallery example esp32-mpu6050 (data/examples.ts).
    mpu.setAccelerometerRange(2); // MPU6050_RANGE_8_G
    mpu.setGyroRange(1); // MPU6050_RANGE_500_DEG
    mpu.setFilterBandwidth(4); // MPU6050_BAND_21_HZ

    const atRest = mpu.getEvent();
    expect(atRest.acceleration.map((v) => v.toFixed(2))).toEqual(['0.00', '0.00', '9.81']);
    expect(atRest.gyro.map((v) => v.toFixed(3))).toEqual(['0.000', '0.000', '0.000']);
    expect(atRest.temperature.toFixed(1)).toBe('24.0');

    wire.inputs({ gyroX: 100 });
    const turning = mpu.getEvent();
    expect(turning.gyro[0].toFixed(3)).toBe('1.745');
    expect(turning.acceleration[2].toFixed(2)).toBe('9.81');

    expect(wire.steps).toEqual(traceOf('adafruit-mpu6050-arduino'));
  });

  it('CircuitPython adafruit_mpu6050: reset() leaves its poll after one read, and the chip ends up awake', () => {
    const wire = onTheBus();
    const mpu = adafruitCircuitPython(wire);
    expect(mpu.init()).toBe(1);

    wire.inputs({ gyroX: 100 });
    expect(mpu.acceleration().map((v) => v.toFixed(2))).toEqual(['0.00', '0.00', '9.81']);
    expect(mpu.gyro()[0].toFixed(3)).toBe('1.745');
    expect(mpu.temperature().toFixed(1)).toBe('24.0');

    expect(wire.steps).toEqual(traceOf('adafruit-mpu6050-circuitpython'));
  });

  it('i2cdevlib: initialize() finds the chip asleep, wakes it and reads 1 g and 100 deg/s at the power-on ranges', () => {
    const wire = onTheBus();
    const mpu = i2cdevlib(wire);
    mpu.initialize();
    wire.inputs({ gyroX: 100 });
    expect(mpu.getMotion6()).toEqual([0, 0, 16384, 13100, 0, 0]);
    expect(wire.steps).toEqual(traceOf('i2cdevlib'));
  });

  it('MPU6050_light: the gyro reads in its 500 deg/s range, 65.5 counts per deg/s', () => {
    const wire = onTheBus();
    const mpu = mpu6050Light(wire);
    mpu.begin();
    wire.inputs({ gyroX: 100 });
    const data = mpu.fetchData();
    expect(data.gyroX).toBeCloseTo(100, 6);
    expect(data.accZ).toBeCloseTo(1, 6);
    // The library's own offset (12412 / 340) is not the datasheet's 36.53.
    expect(data.temp).toBeCloseTo(24, 1);
    expect(wire.steps).toEqual(traceOf('mpu6050-light'));
  });
});

// ─── mpu6050: reading it asleep says so, once per run ────────────────────────

describe('mpu6050 — the INT pin on the board', () => {
  // The pad's level reaches the board pin INT is wired to, on the guest's
  // clock: a timer at each sample, one at the end of each 50 us pulse, and
  // none at all while no interrupt is enabled.
  const INT_PIN = 2;
  const setup = () => {
    const clock = new RigClock();
    const rig = i2cRig({ imu: HW_I2C_PINS }, clock);
    const pinManager = new PinManager();
    const edges: Array<[boolean, number]> = [];
    const sim = {
      setPinState: (pin: number, level: boolean) => {
        if (pin === INT_PIN) edges.push([level, clock.cycles / 16]);
      },
      pinManager,
    };
    const dispose = PartSimulationRegistry.get('mpu6050')!.attachEvents!(
      makeElement(),
      sim as any,
      (name) => (name === 'INT' ? INT_PIN : null),
      'imu',
    );
    return { clock, rig, edges, dispose };
  };

  it('pulses for 50 us at every sample of the rate the sketch selected', () => {
    const { clock, rig, edges } = setup();
    rig.write(0x68, [0x19, 0x07]); // 1 kHz
    rig.write(0x68, [0x38, 0x01]); // DATA_RDY_EN
    expect(clock.pending()).toBe(0);
    wakeImu(rig);
    edges.length = 0;
    clock.advanceUs(2500);
    expect(edges).toEqual([
      [true, 1000],
      [false, 1050],
      [true, 2000],
      [false, 2050],
    ]);
  });

  it('holds a latched interrupt until INT_STATUS is read, active low when INT_LEVEL says so', () => {
    const { clock, rig, edges } = setup();
    rig.write(0x68, [0x19, 0x07]);
    rig.write(0x68, [0x37, 0xa0]); // INT_LEVEL (active low) + LATCH_INT_EN
    rig.write(0x68, [0x38, 0x01]);
    wakeImu(rig);
    edges.length = 0;
    clock.advanceUs(3500);
    expect(edges).toEqual([[false, 1000]]);
    // Nothing is armed while the line waits for the sketch.
    expect(clock.pending()).toBe(0);
    expect(rig.readReg(0x68, 0x3a, 1)).toEqual([0x01]);
    expect(edges.at(-1)).toEqual([true, 3500]);
  });

  it('drives the pin on a board whose registerSensor declines the part, as AVR and RP2040 do', () => {
    // Their simulators carry a registerSensor that answers false and no
    // hostsCustomChips. The part was taken for worker-hosted there, and the
    // pin INT is wired to never moved on an Uno.
    const clock = new RigClock();
    const rig = i2cRig({ imu: HW_I2C_PINS }, clock);
    const edges: boolean[] = [];
    const registerSensor = vi.fn(() => false);
    const sim = {
      setPinState: (pin: number, level: boolean) => {
        if (pin === INT_PIN) edges.push(level);
      },
      pinManager: new PinManager(),
      registerSensor,
      updateSensor: () => {},
      unregisterSensor: () => {},
    };
    PartSimulationRegistry.get('mpu6050')!.attachEvents!(
      makeElement(),
      sim as any,
      (name) => (name === 'INT' ? INT_PIN : null),
      'imu',
    );
    expect(registerSensor).toHaveBeenCalled();
    rig.write(0x68, [0x19, 0x07]);
    rig.write(0x68, [0x38, 0x01]);
    wakeImu(rig);
    edges.length = 0;
    clock.advanceUs(1500);
    expect(edges).toEqual([true, false]);
  });

  it('arms nothing while no interrupt is enabled, and lets go of the pin when it leaves', () => {
    const { clock, rig, dispose } = setup();
    wakeImu(rig);
    clock.advanceUs(5000);
    expect(clock.pending()).toBe(0);
    rig.write(0x68, [0x38, 0x01]);
    expect(clock.pending()).toBe(1);
    dispose();
    expect(clock.pending()).toBe(0);
  });
});

describe('mpu6050 — the DMP starts on an image the model does not know', () => {
  // The model runs the MotionApps images of i2cdevlib (the shared vectors
  // hold their packets). Any other image writes nothing, and the monitor
  // says why once per run, when the sketch starts the DMP on it.
  const listeners: Array<() => void> = [];
  afterEach(() => {
    for (const off of listeners.splice(0)) off();
  });

  it('tells the monitor once, and again on the next run; a known image and an upload say nothing', () => {
    const rig = i2cRig({ imu: HW_I2C_PINS });
    attachImu();
    const heard: BusDiagnostic[] = [];
    listeners.push(
      busRegistry.onDiagnostic((d) => {
        if (d.code === 'i2c-target-unmodelled') heard.push(d);
      }),
    );
    rig.write(0x68, [0x6b, 0x00]);
    // Reading the revision byte and writing memory start nothing.
    rig.write(0x68, [0x6d, 0x70]);
    rig.write(0x68, [0x6e, 0x06]);
    expect(rig.readReg(0x68, 0x6f, 1)).toEqual([0xa5]);
    rig.write(0x68, [0x6d, 0x03, 0x00]);
    rig.write(0x68, [0x6f, 0xfb, 0x00, 0x00, 0x3e]);
    rig.write(0x68, [0x70, 0x03, 0x00]);
    expect(heard).toEqual([]);
    // DMP_EN and FIFO_EN on bytes that are no image the model knows.
    rig.write(0x68, [0x6a, 0xc0]);
    rig.write(0x68, [0x6a, 0x00]);
    rig.write(0x68, [0x6a, 0xc0]);
    expect(heard.map((d) => [d.boardId, d.owners, d.message.split(':')[0]])).toEqual([
      [RIG_BOARD, ['imu'], 'MPU6050 0x68'],
    ]);
    expect(heard[0].message).toMatch(/DMP image the simulator does not know/);
    rig.reset();
    rig.write(0x68, [0x6a, 0x00]);
    rig.write(0x68, [0x6a, 0xc0]);
    expect(heard).toHaveLength(2);
    // The MotionApps 2.0 image at its start address runs, and says nothing.
    rig.reset();
    rig.write(0x68, [0x6a, 0x00]);
    rig.write(0x68, [0x6d, 0x03, 0x00]);
    rig.write(0x68, [
      0x6f, 0xd8, 0xdc, 0xba, 0xa2, 0xf1, 0xde, 0xb2, 0xb8, 0xb4, 0xa8, 0x81, 0x91, 0xf7, 0x4a,
      0x90, 0x7f,
    ]);
    rig.write(0x68, [0x6a, 0xc0]);
    expect(heard).toHaveLength(2);
  });
});

describe('mpu6050 — offset calibration converges', () => {
  // i2cdevlib MPU6050_Base::PID(), which CalibrateAccel() and
  // CalibrateGyro() run (jrowberg/i2cdevlib master MPU6050.cpp:3290-3370;
  // Electronic Cats 1.4.5 is the same loop), ported line by line: a PI loop
  // that writes the offset registers until the outputs read zero, and
  // gravity on Z. With inert offsets it printed '*' forever unless the panel
  // sat exactly at rest.
  const int16 = (v: number) => (v << 16) >> 16;
  const round = (v: number) => Math.sign(v) * Math.round(Math.abs(v));

  function pid(rig: I2cRig, readAddress: number, kP: number, kI: number, loops: number): string {
    const readWord = (reg: number) => {
      const [h, l] = rig.readReg(0x68, reg, 2)!;
      return int16((h << 8) | l);
    };
    const writeWord = (reg: number, v: number) => rig.write(0x68, [reg, (v >> 8) & 0xff, v & 0xff]);
    const saveAddress = readAddress === 0x3b ? 0x06 : 0x13;
    const shift = 2;
    const bitZero: number[] = [];
    const iTerm: number[] = [];
    let out = '>';
    // 16384 >> AFS_SEL in i2cdevlib; Electronic Cats 1.4.5 has 32768 there,
    // which drives Z to the top of the scale on any part.
    const gravity = 16384 >> ((rig.readReg(0x68, 0x1c, 1)![0] >> 3) & 3);
    for (let i = 0; i < 3; i++) {
      const data = readWord(saveAddress + i * shift);
      if (saveAddress !== 0x13) {
        bitZero[i] = data & 1;
        iTerm[i] = data * 8;
      } else iTerm[i] = data * 4;
    }
    let guard = 0;
    for (let L = 0; L < loops; L++) {
      let eSample = 0;
      for (let c = 0; c < 100; c++) {
        if (++guard > 20_000) throw new Error(`no convergence: ${out}`);
        let eSum = 0;
        for (let i = 0; i < 3; i++) {
          let reading = readWord(readAddress + i * 2);
          if (readAddress === 0x3b && i === 2) reading -= gravity;
          const error = -reading;
          eSum += Math.abs(reading);
          const pTerm = kP * error;
          iTerm[i] += error * 0.001 * kI;
          let data: number;
          if (saveAddress !== 0x13) {
            data = int16(round((pTerm + iTerm[i]) / 8));
            data = int16((data & 0xfffe) | bitZero[i]);
          } else data = int16(round((pTerm + iTerm[i]) / 4));
          writeWord(saveAddress + i * shift, data);
        }
        if (c === 99 && eSum > 1000) {
          c = 0;
          out += '*';
        }
        if (eSum * (readAddress === 0x3b ? 0.05 : 1) < 5) eSample++;
        if (eSum < 100 && c > 10 && eSample >= 10) break;
      }
      out += '.';
      kP *= 0.75;
      kI *= 0.75;
      for (let i = 0; i < 3; i++) {
        let data: number;
        if (saveAddress !== 0x13) {
          data = int16(round(iTerm[i] / 8));
          data = int16((data & 0xfffe) | bitZero[i]);
        } else data = int16(round(iTerm[i] / 4));
        writeWord(saveAddress + i * shift, data);
      }
    }
    return out;
  }

  it('CalibrateAccel(6) and CalibrateGyro(6) null a tilted, drifting chip', () => {
    const rig = i2cRig({ imu: HW_I2C_PINS });
    attachImu();
    dispatchSensorUpdate('imu', {
      accelX: 0.03,
      accelY: -0.02,
      accelZ: 1.01,
      gyroX: 2,
      gyroY: -1.5,
      gyroZ: 0.7,
    });
    wakeImu(rig);
    // x = (100 - map(6, 1, 5, 20, 0)) * .01 = 1.05
    // A '*' is a round of 100 that ended still off by more than 1000 counts,
    // as real parts print at the start; one that never settles prints them
    // forever.
    expect(pid(rig, 0x3b, 0.3 * 1.05, 20 * 1.05, 6)).toMatch(/^>\*{0,3}\.{6}$/);
    expect(pid(rig, 0x43, 0.3 * 1.05, 90 * 1.05, 6)).toMatch(/^>\*{0,3}\.{6}$/);
    const words = (reg: number, n: number) => {
      const b = rig.readReg(0x68, reg, n * 2)!;
      return Array.from({ length: n }, (_, i) => int16((b[2 * i] << 8) | b[2 * i + 1]));
    };
    const [ax, ay, az] = words(0x3b, 3);
    const [gx, gy, gz] = words(0x43, 3);
    // Within what the loop itself calls done: a summed error under 100
    // counts of accelerometer (1/1024 g a step, bit 0 being the revision)
    // and under 5 of gyro.
    expect(Math.abs(ax) + Math.abs(ay) + Math.abs(az - 16384)).toBeLessThan(100);
    expect(Math.abs(gx) + Math.abs(gy) + Math.abs(gz)).toBeLessThan(5);
    // The revision bits of the trims are where the factory left them.
    expect(rig.readReg(0x68, 0x06, 6)!.filter((_, i) => i % 2 === 1).map((b) => b & 1)).toEqual([
      0, 1, 0,
    ]);
  });
});

describe('mpu6050 — read while asleep', () => {
  const NOTE = 'MPU6050 0x68 is in sleep mode: write 0x00 to PWR_MGMT_1 (0x6B) to wake it';

  const listeners: Array<() => void> = [];
  afterEach(() => {
    for (const off of listeners.splice(0)) off();
  });

  function listen(): BusDiagnostic[] {
    const heard: BusDiagnostic[] = [];
    listeners.push(
      busRegistry.onDiagnostic((d) => {
        if (d.code === 'i2c-target-asleep') heard.push(d);
      }),
    );
    return heard;
  }

  it('the first read of the sample block tells the monitor of its board, and only the first', () => {
    const rig = i2cRig({ imu: HW_I2C_PINS });
    attachImu();
    const heard = listen();
    rig.readReg(0x68, 0x3b, 14);
    expect(heard).toEqual([
      { code: 'i2c-target-asleep', bus: 'i2c', boardId: RIG_BOARD, owners: ['imu'], message: NOTE },
    ]);
    rig.readReg(0x68, 0x3b, 14);
    rig.readReg(0x68, 0x43, 6);
    expect(heard).toHaveLength(1);
  });

  it('the identity, the power state and the configuration can be read in silence', () => {
    const rig = i2cRig({ imu: HW_I2C_PINS });
    attachImu();
    const heard = listen();
    rig.readReg(0x68, 0x75, 1);
    rig.readReg(0x68, 0x6b, 1);
    rig.readReg(0x68, 0x19, 4);
    rig.ack(0x68);
    expect(heard).toEqual([]);
  });

  it('a sketch that wakes the chip first never hears it', () => {
    const rig = i2cRig({ imu: HW_I2C_PINS });
    attachImu();
    const heard = listen();
    wakeImu(rig);
    rig.readReg(0x68, 0x3b, 14);
    expect(heard).toEqual([]);
  });

  it('names the address the chip answers at', () => {
    const rig = i2cRig({ imu: HW_I2C_PINS });
    attachImu('imu', { ad0: true });
    const heard = listen();
    rig.readReg(0x69, 0x3b, 2);
    expect(heard.map((d) => d.message)).toEqual([NOTE.replace('0x68', '0x69')]);
  });

  it('the next run is told again: an MCU reset leaves the chip powered, and asleep', () => {
    const rig = i2cRig({ imu: HW_I2C_PINS });
    attachImu();
    const heard = listen();
    rig.readReg(0x68, 0x3b, 14);
    rig.reset();
    expect(rig.readReg(0x68, 0x6b, 1), 'the MCU reset is not a power cycle').toEqual([0x40]);
    rig.readReg(0x68, 0x3b, 14);
    rig.readReg(0x68, 0x3b, 14);
    expect(heard).toHaveLength(2);
  });

  it('a copy taken for a host that mirrors the registers is not a read', () => {
    const rig = i2cRig({ imu: HW_I2C_PINS });
    attachImu();
    const heard = listen();
    partHost(rig, 'imu').dump();
    expect(heard).toEqual([]);
  });

  it('a chip on no bus has nobody to tell', () => {
    i2cRig({});
    attachImu('loose');
    const heard = listen();
    busRegistry.reportI2cTarget('loose', 'i2c-target-asleep', NOTE);
    busRegistry.reportI2cTarget('nobody', 'i2c-target-asleep', NOTE);
    expect(heard).toEqual([]);
  });

  it('two chips asleep on one bus are two notes', () => {
    const rig = i2cRig({ imuA: HW_I2C_PINS, imuB: HW_I2C_PINS });
    attachImu('imuA');
    attachImu('imuB', { ad0: true });
    const heard = listen();
    rig.readReg(0x68, 0x3b, 2);
    rig.readReg(0x69, 0x3b, 2);
    expect(heard.map((d) => d.owners)).toEqual([['imuA'], ['imuB']]);
  });
});

// ─── dht22 ───────────────────────────────────────────────────────────────────

/**
 * A board that hosts line models itself, over a fake port. At module scope
 * because the dht22 section and the infrared one both need it — the two
 * devices differ only in which model they attach.
 */
function makeLineSim() {
  const listeners = new Map<number, Set<(e: PadEvent) => void>>();
  const port: LineHostPort & {
    edges: Array<[number, boolean, number]>;
    rests: Array<[number, boolean, boolean]>;
  } = {
    edges: [],
    rests: [],
    now: () => 10_000,
    clockHz: () => 16e6,
    scheduleEdge: (pin, level, at) => port.edges.push([pin, level, at]),
    onPad: (pin, cb) => {
      if (!listeners.has(pin)) listeners.set(pin, new Set());
      listeners.get(pin)!.add(cb);
      return () => listeners.get(pin)!.delete(cb);
    },
    restPad: (pin, level, driven) => port.rests.push([pin, level, driven]),
  };
  const hub = new LineSensorHub(port);
  const sim = {
    ...makePinSim(),
    lineSupport: () => ({ mode: 'local' as const }),
    lineHub: () => hub,
    /** Emit the guest's drive changes the way a simulator would. */
    guest(pin: number, drives: Array<PadState['drive']>) {
      let prev: PadState = INITIAL_PAD;
      for (const drive of drives) {
        const next: PadState = {
          drive,
          pull: drive === 'z' ? 1 : 0,
          level: drive !== 'low',
          cycle: 10_000,
        };
        listeners.get(pin)?.forEach((cb) => cb({ pin, ...next, prev }));
        prev = next;
      }
    },
  };
  return { sim, hub, port };
}

describe('dht22 — single-wire sensor (the line contract)', () => {
  it('asks the board to host it and rests DATA released on its pull-up', () => {
    const { sim, hub, port } = makeLineSim();
    const logic = PartSimulationRegistry.get('dht22')!;
    logic.attachEvents!(makeElement(), sim as any, pinMap({ DATA: 7 }), 'dht-1');
    expect(hub.size).toBe(1);
    expect(hub.ownsPin(7)).toBe(true);
    expect(port.rests).toEqual([[7, true, false]]);
  });

  it('answers the start signal (LOW, then release) with the 84-edge frame', () => {
    const { sim, port } = makeLineSim();
    const logic = PartSimulationRegistry.get('dht22')!;
    logic.attachEvents!(
      makeElement({ temperature: 25.0, humidity: 50.0 }),
      sim as any,
      pinMap({ DATA: 7 }),
      'dht-2',
    );
    sim.guest(7, ['high', 'low', 'z']);
    expect(port.edges).toHaveLength(84);
    // 16 cycles per us at this rig's 16 MHz, times the sensor's response gap.
    expect(port.edges[0]).toEqual([7, false, 10_000 + 16 * DHT22_RESPONSE_START_US]);
  });

  it('forwards slider changes to the host', () => {
    const { sim, hub } = makeLineSim();
    const logic = PartSimulationRegistry.get('dht22')!;
    const el = makeElement({ temperature: 25.0, humidity: 50.0 }) as any;
    logic.attachEvents!(el, sim as any, pinMap({ DATA: 7 }), 'dht-3');
    const spy = vi.spyOn(hub, 'update');
    dispatchSensorUpdate('dht-3', { temperature: 31 });
    expect(el.temperature).toBe(31);
    expect(spy).toHaveBeenCalledWith(7, { temperature: 31, humidity: 50 });
  });

  it('no-op if DATA pin not found', () => {
    const { sim, hub } = makeLineSim();
    const logic = PartSimulationRegistry.get('dht22')!;
    expect(() => {
      const c = logic.attachEvents!(makeElement(), sim as any, noPins, 'dht-4');
      c();
    }).not.toThrow();
    expect(hub.size).toBe(0);
  });

  it('cleanup releases the line', () => {
    const { sim, hub } = makeLineSim();
    const logic = PartSimulationRegistry.get('dht22')!;
    const cleanup = logic.attachEvents!(makeElement(), sim as any, pinMap({ DATA: 7 }), 'dht-5');
    cleanup();
    expect(hub.size).toBe(0);
    expect(hub.ownsPin(7)).toBe(false);
  });

  it('on a board that cannot host it, refuses out loud and drives nothing', () => {
    clearLineGaps();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sim = makePinSim(); // no declaration at all
    const logic = PartSimulationRegistry.get('dht22')!;
    const cleanup = logic.attachEvents!(makeElement(), sim as any, pinMap({ DATA: 7 }), 'dht-6');
    expect(sim.setPinState).not.toHaveBeenCalled();
    expect(sim.pinManager.onPinChange).not.toHaveBeenCalled();
    expect(lineGaps()).toContainEqual({
      sensorType: 'dht22',
      pin: 7,
      why: expect.any(String),
      componentId: 'dht-6',
    });
    expect(warn).toHaveBeenCalled();
    expect(() => cleanup()).not.toThrow();
    warn.mockRestore();
  });
});

// ─── hx711 ───────────────────────────────────────────────────────────────────

describe('hx711 — load cell amplifier', () => {
  it('drives DOUT LOW (ready) on attach', () => {
    const sim = makePinSim();
    const logic = PartSimulationRegistry.get('hx711')!;
    logic.attachEvents!(makeElement(), sim as any, pinMap({ SCK: 2, DOUT: 3 }));
    expect(sim.setPinState).toHaveBeenCalledWith(3, false);
  });

  it('registers onPinChange for SCK pin', () => {
    const sim = makePinSim();
    const logic = PartSimulationRegistry.get('hx711')!;
    logic.attachEvents!(makeElement(), sim as any, pinMap({ SCK: 2, DOUT: 3 }));
    expect(sim.pinManager.onPinChange).toHaveBeenCalledWith(2, expect.any(Function));
  });

  it('outputs 24 bits on 24 rising SCK edges (MSB first)', () => {
    const sim = makePinSim();
    const logic = PartSimulationRegistry.get('hx711')!;
    // weight=100 → raw = 100000 = 0x0186A0
    logic.attachEvents!(makeElement({ weight: 100 }), sim as any, pinMap({ SCK: 2, DOUT: 3 }));
    const cb = sim.pinManager.onPinChange.mock.calls[0][1] as (p: number, s: boolean) => void;
    sim.setPinState.mockClear();

    // 24 rising edges
    const doutValues: boolean[] = [];
    for (let i = 0; i < 24; i++) {
      cb(2, true); // rising
      const last = (sim.setPinState as ReturnType<typeof vi.fn>).mock.lastCall;
      if (last && last[0] === 3) doutValues.push(last[1]);
      cb(2, false); // falling
    }
    expect(doutValues).toHaveLength(24);

    // Reconstruct 24-bit value
    const reconstructed = doutValues.reduce((acc, bit, i) => acc | ((bit ? 1 : 0) << (23 - i)), 0);
    const expected = (100 * 1000) & 0xff_ffff; // = 100000 = 0x0186A0
    expect(reconstructed).toBe(expected);
  });

  it('drives DOUT HIGH after 25 rising edges (gain select done)', () => {
    const sim = makePinSim();
    const logic = PartSimulationRegistry.get('hx711')!;
    logic.attachEvents!(makeElement(), sim as any, pinMap({ SCK: 2, DOUT: 3 }));
    const cb = sim.pinManager.onPinChange.mock.calls[0][1] as (p: number, s: boolean) => void;
    // 24 data bits + 1 gain pulse
    for (let i = 0; i < 25; i++) {
      cb(2, true);
      cb(2, false);
    }
    // After 25th rising, DOUT goes HIGH
    const highCalls = (sim.setPinState as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([pin, state]) => pin === 3 && state === true,
    );
    expect(highCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('no-op if SCK or DOUT not connected', () => {
    const sim = makePinSim();
    const logic = PartSimulationRegistry.get('hx711')!;
    expect(() => {
      const c = logic.attachEvents!(makeElement(), sim as any, noPins);
      c();
    }).not.toThrow();
    expect(sim.pinManager.onPinChange).not.toHaveBeenCalled();
  });

  it('cleanup drives DOUT HIGH', () => {
    const sim = makePinSim();
    const logic = PartSimulationRegistry.get('hx711')!;
    const cleanup = logic.attachEvents!(makeElement(), sim as any, pinMap({ SCK: 2, DOUT: 3 }));
    sim.setPinState.mockClear();
    cleanup();
    expect(sim.setPinState).toHaveBeenCalledWith(3, true);
  });
});

// ─── Infrared ────────────────────────────────────────────────────────────────

/**
 * These two parts were both dead, and every test in this file's previous IR
 * section passed anyway — they asserted that a click made `setPinState` calls
 * and that a listener got registered, which is true of code that transmits
 * nothing anybody can decode on a pin nobody is watching. So the assertions
 * here are about the LINK: a press on one part reaches another part's pin, and
 * what lands there decodes back to the button that was pressed.
 */

/** The pin levels an edge frame produces, as mark/space microseconds. */
function edgesToPulses(
  edges: Array<[number, boolean, number]>,
  clockHz: number,
): Array<{ level: 0 | 1; us: number }> {
  const out: Array<{ level: 0 | 1; us: number }> = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const us = ((edges[i + 1][2] - edges[i][2]) / clockHz) * 1e6;
    // The pin is active LOW: it is low for a mark.
    out.push({ level: edges[i][1] ? 0 : 1, us });
  }
  return out;
}

describe('ir-receiver — the demodulator', () => {
  beforeEach(() => resetIrAir());

  it('resolves DAT, the pin the element actually declares', () => {
    const { sim, hub } = makeLineSim();
    const logic = PartSimulationRegistry.get('ir-receiver')!;
    logic.attachEvents!(makeElement(), sim as any, pinMap({ DAT: 5 }), 'rx-1');
    expect(hub.size).toBe(1);
    expect(hub.ownsPin(5)).toBe(true);
  });

  it('rests its output HIGH, driven — a demodulator idles high and owns the line', () => {
    const { sim, port } = makeLineSim();
    const logic = PartSimulationRegistry.get('ir-receiver')!;
    logic.attachEvents!(makeElement(), sim as any, pinMap({ DAT: 5 }), 'rx-2');
    expect(port.rests).toEqual([[5, true, true]]);
  });

  it('puts a frame from the air on its pin, active low and back to idle', () => {
    const { sim, port } = makeLineSim();
    const logic = PartSimulationRegistry.get('ir-receiver')!;
    logic.attachEvents!(makeElement(), sim as any, pinMap({ DAT: 5 }), 'rx-3');
    port.edges.length = 0;

    emitIr({ pulses: necEncode(0x00, 0x45), sourceId: 'somebody-else' });

    expect(port.edges.length).toBeGreaterThan(60); // 32 bits, two edges each
    expect(port.edges[0][1]).toBe(false); // the 9 ms header mark pulls it LOW
    expect(port.edges[port.edges.length - 1][1]).toBe(true); // and it ends idle
  });

  it('what lands on the pin decodes back to the address and command sent', () => {
    const { sim, port } = makeLineSim();
    const logic = PartSimulationRegistry.get('ir-receiver')!;
    logic.attachEvents!(makeElement(), sim as any, pinMap({ DAT: 5 }), 'rx-4');
    port.edges.length = 0;

    emitIr({ pulses: necEncode(0x04, 0x1c), sourceId: 'remote-x' });

    const decoded = necDecode(edgesToPulses(port.edges, 16e6));
    expect(decoded.protocol).toBe('NEC');
    expect(decoded.address).toBe(0x04);
    expect(decoded.command).toBe(0x1c);
    expect(decoded.verified).toBe(true);
  });

  it('the timing is real: a NEC header mark is 9 ms on the guest clock', () => {
    const { sim, port } = makeLineSim();
    const logic = PartSimulationRegistry.get('ir-receiver')!;
    logic.attachEvents!(makeElement(), sim as any, pinMap({ DAT: 5 }), 'rx-5');
    port.edges.length = 0;

    emitIr({ pulses: necEncode(0x00, 0x45), sourceId: 'remote-x' });

    // 16 MHz: 9 ms is 144 000 cycles. The old setTimeout(0.562) could not
    // express this at all, which is why no IR library ever decoded it.
    const headerCycles = port.edges[1][2] - port.edges[0][2];
    expect(headerCycles).toBe(Math.round(9000 * 16));
  });

  it('does not hear its own transmission', () => {
    const { sim, port } = makeLineSim();
    const el = makeElement();
    const logic = PartSimulationRegistry.get('ir-receiver')!;
    logic.attachEvents!(el, sim as any, pinMap({ DAT: 5 }), 'rx-6');
    port.edges.length = 0;

    const click = (el.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      ([ev]) => ev === 'click',
    )?.[1] as () => void;
    click();

    expect(irAirStats.emitted).toBe(1);
    expect(port.edges).toHaveLength(0);
  });

  it('two receivers both hear one transmission', () => {
    const a = makeLineSim();
    const b = makeLineSim();
    const logic = PartSimulationRegistry.get('ir-receiver')!;
    logic.attachEvents!(makeElement(), a.sim as any, pinMap({ DAT: 5 }), 'rx-a');
    logic.attachEvents!(makeElement(), b.sim as any, pinMap({ DAT: 9 }), 'rx-b');
    a.port.edges.length = 0;
    b.port.edges.length = 0;

    emitIr({ pulses: necEncode(0x00, 0x45), sourceId: 'remote-x' });

    expect(a.port.edges.length).toBeGreaterThan(60);
    expect(b.port.edges.length).toBeGreaterThan(60);
    expect(b.port.edges[0][0]).toBe(9); // on its own pin, not the other's
  });

  it('a channel isolates a pair; an unset channel still hears everything', () => {
    const tuned = makeLineSim();
    const open = makeLineSim();
    const logic = PartSimulationRegistry.get('ir-receiver')!;
    logic.attachEvents!(
      makeElement({ channel: 'left' }),
      tuned.sim as any,
      pinMap({ DAT: 5 }),
      'rx-l',
    );
    logic.attachEvents!(makeElement(), open.sim as any, pinMap({ DAT: 6 }), 'rx-open');
    tuned.port.edges.length = 0;
    open.port.edges.length = 0;

    emitIr({ pulses: necEncode(0x00, 0x45), sourceId: 'remote-r', channel: 'right' });
    expect(tuned.port.edges).toHaveLength(0);
    expect(open.port.edges.length).toBeGreaterThan(60);

    tuned.port.edges.length = 0;
    emitIr({ pulses: necEncode(0x00, 0x45), sourceId: 'remote-l', channel: 'LEFT' });
    expect(tuned.port.edges.length).toBeGreaterThan(60); // matched case-insensitively
  });

  it('stops listening after cleanup', () => {
    const { sim, port } = makeLineSim();
    const logic = PartSimulationRegistry.get('ir-receiver')!;
    const cleanup = logic.attachEvents!(makeElement(), sim as any, pinMap({ DAT: 5 }), 'rx-7');
    cleanup();
    port.edges.length = 0;
    emitIr({ pulses: necEncode(0x00, 0x45), sourceId: 'remote-x' });
    expect(port.edges).toHaveLength(0);
  });

  it('records a gap, and takes no frame, on a board that cannot host it', () => {
    clearLineGaps();
    const sim = {
      ...makePinSim(),
      lineSupport: () => ({ mode: 'none' as const, why: 'no timed edges' }),
    };
    const logic = PartSimulationRegistry.get('ir-receiver')!;
    logic.attachEvents!(makeElement(), sim as any, pinMap({ DAT: 5 }), 'rx-8');
    expect(lineGaps().map((g) => g.sensorType)).toContain('ir-nec');
    // The user gets a reason in the circuit check rather than a silent pad.
    expect(() => emitIr({ pulses: necEncode(0, 0x45), sourceId: 'remote-x' })).not.toThrow();
  });

  it('no-op when nothing is wired to it (no throw)', () => {
    const { sim } = makeLineSim();
    const logic = PartSimulationRegistry.get('ir-receiver')!;
    expect(() => logic.attachEvents!(makeElement(), sim as any, noPins, 'rx-9')()).not.toThrow();
  });
});

describe('ir-remote — the handset', () => {
  beforeEach(() => resetIrAir());

  /** The element's own listener, as the part registered it. */
  function pressOn(el: HTMLElement, irCode: number, key = 'k'): void {
    const cb = (el.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      ([ev]) => ev === 'button-press',
    )?.[1] as (e: Event) => void;
    cb({ detail: { key, irCode } } as unknown as Event);
  }

  it('asks for no pin at all — it is a remote control', () => {
    const logic = PartSimulationRegistry.get('ir-remote')!;
    const getPin = vi.fn(() => null);
    logic.attachEvents!(makeElement(), makePinSim() as any, getPin, 'tx-1');
    expect(getPin).not.toHaveBeenCalled();
  });

  it('a press transmits the code the ELEMENT reports, not a table of our own', () => {
    const el = makeElement();
    const logic = PartSimulationRegistry.get('ir-remote')!;
    logic.attachEvents!(el, makePinSim() as any, noPins, 'tx-2');

    // 0x30 is what wokwi's element sends for "1". The old table said 0x0c.
    pressOn(el, 0x30, '1');
    expect(irAirStats.last?.command).toBe(0x30);
    expect(irAirStats.last?.protocol).toBe('NEC');
    expect(irAirStats.last?.verified).toBe(true);
  });

  it('reaches a receiver on another board, with no wire between them', () => {
    const rx = makeLineSim();
    PartSimulationRegistry.get('ir-receiver')!.attachEvents!(
      makeElement(),
      rx.sim as any,
      pinMap({ DAT: 5 }),
      'rx-far',
    );
    rx.port.edges.length = 0;

    const el = makeElement({ irAddress: 0x04 });
    PartSimulationRegistry.get('ir-remote')!.attachEvents!(el, makePinSim() as any, noPins, 'tx-3');
    pressOn(el, 0x1c, '5');

    const decoded = necDecode(edgesToPulses(rx.port.edges, 16e6));
    expect(decoded.address).toBe(0x04);
    expect(decoded.command).toBe(0x1c);
  });

  it('a held key repeats, and releasing stops it', () => {
    const el = makeElement();
    PartSimulationRegistry.get('ir-remote')!.attachEvents!(el, makePinSim() as any, noPins, 'tx-4');

    pressOn(el, 0x30);
    expect(irAirStats.emitted).toBe(1);
    vi.advanceTimersByTime(NEC_REPEAT_PERIOD_MS * 3 + 10);
    expect(irAirStats.emitted).toBe(4);
    expect(irAirStats.last?.protocol).toBe('NEC-repeat');

    const release = (el.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      ([ev]) => ev === 'button-release',
    )?.[1] as () => void;
    release();
    vi.advanceTimersByTime(NEC_REPEAT_PERIOD_MS * 5);
    expect(irAirStats.emitted).toBe(4);
  });

  it('cleanup stops a repeat that is still running', () => {
    const el = makeElement();
    const cleanup = PartSimulationRegistry.get('ir-remote')!.attachEvents!(
      el,
      makePinSim() as any,
      noPins,
      'tx-5',
    );
    pressOn(el, 0x30);
    cleanup();
    vi.advanceTimersByTime(NEC_REPEAT_PERIOD_MS * 5);
    expect(irAirStats.emitted).toBe(1);
  });

  it('says so when it transmitted and nothing was listening', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = makeElement();
    PartSimulationRegistry.get('ir-remote')!.attachEvents!(el, makePinSim() as any, noPins, 'tx-6');
    pressOn(el, 0x30);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no receiver took it'));
    warn.mockRestore();
  });

  it('ignores a press with no code on it', () => {
    const el = makeElement();
    PartSimulationRegistry.get('ir-remote')!.attachEvents!(el, makePinSim() as any, noPins, 'tx-7');
    const cb = (el.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      ([ev]) => ev === 'button-press',
    )?.[1] as (e: Event) => void;
    cb({ detail: {} } as unknown as Event);
    expect(irAirStats.emitted).toBe(0);
  });
});

// ─── microsd-card ─────────────────────────────────────────────────────────────

describe('microsd-card — SPI init handshake', () => {
  // The card is a responder on the bus fabric now: it is clocked through its
  // board's SPI controller while its own chip select is low, and its answer is
  // the MISO the guest reads back for that frame. (It used to take over
  // spi.onByte and answer through completeTransfer, the chain F3 removed.)
  const CS = 10;
  function card(props: Record<string, unknown> = {}, wiring: Record<string, RigPin> = { CS }) {
    const rig = spiRig('sd1', { SCK: RIG_SCK, DI: RIG_MOSI, DO: RIG_MISO, ...wiring });
    const cleanup = PartSimulationRegistry.get('microsd-card')!.attachEvents!(
      makeElement(props),
      makeSPISim() as any,
      noPins,
      'sd1',
    );
    if (wiring.CS === CS) rig.write(CS, false); // the host selects the card
    return { rig, cleanup, send: (bytes: number[]) => rig.send(bytes) };
  }

  it('joins the bus its wiring puts it on, and leaves it on cleanup', () => {
    const { rig, cleanup } = card();
    try {
      expect(busRegistry.placement('sd1')).toEqual({
        boardId: RIG_BOARD,
        sckPin: RIG_SCK,
        selected: true,
      });
      cleanup!();
      expect(busRegistry.placement('sd1')).toBeNull();
    } finally {
      rig.dispose();
    }
  });

  it('CMD0 (0x40 + 4 zeroes + CRC) returns R1=0x01 (idle)', () => {
    const { rig, send } = card();
    try {
      // The command, then the 0xFF clocks the host sends to read the answer.
      const replies = [...send([0x40, 0x00, 0x00, 0x00, 0x00, 0x95]), ...send([0xff, 0xff])];
      expect(replies).toContain(0x01);
    } finally {
      rig.dispose();
    }
  });

  it('CMD8 returns R7 with echo-back 0x1AA', () => {
    const { rig, send } = card();
    try {
      send([0x48, 0x00, 0x00, 0x01, 0xaa, 0x87]);
      const replies = send([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
      // R7 = 0x01, 0x00, 0x00, 0x01, 0xAA, behind the N_CR fill byte.
      expect(replies).toContain(0x01);
      expect(replies).toContain(0xaa);
    } finally {
      rig.dispose();
    }
  });

  it('ACMD41 (CMD55 + CMD41) returns R1=0x00 (ready)', () => {
    const { rig, send } = card();
    try {
      send([0x77, 0x00, 0x00, 0x00, 0x00, 0x65]); // CMD55
      send([0xff, 0xff]); // poll
      send([0x69, 0x40, 0x00, 0x00, 0x00, 0x77]); // ACMD41
      expect(send([0xff, 0xff])).toContain(0x00);
    } finally {
      rig.dispose();
    }
  });

  it('0xFF clock bytes return 0xFF (idle) when no pending response', () => {
    const { rig, send } = card();
    try {
      expect(send([0xff])).toEqual([0xff]);
    } finally {
      rig.dispose();
    }
  });

  it('answers nothing at all while its chip select is high', () => {
    const { rig, send } = card();
    try {
      rig.write(CS, true);
      // Another chip's command, clocked on the same wires.
      expect(send([0x40, 0x00, 0x00, 0x00, 0x00, 0x95, 0xff, 0xff])).toEqual(new Array(8).fill(0xff));
      // And the card did not take it as its own: it is still waiting for a
      // command when the host comes back for it.
      rig.write(CS, false);
      expect([...send([0x40, 0x00, 0x00, 0x00, 0x00, 0x95]), ...send([0xff, 0xff])]).toContain(0x01);
    } finally {
      rig.dispose();
    }
  });

  it('a card whose CS nothing drives stays quiet (its DAT3 pull-up deselects it)', () => {
    const { rig, send } = card({}, {});
    try {
      expect(busRegistry.placement('sd1')?.selected).toBe(false);
      expect(send([0x40, 0x00, 0x00, 0x00, 0x00, 0x95, 0xff, 0xff])).toEqual(new Array(8).fill(0xff));
    } finally {
      rig.dispose();
    }
  });

  it('cleanup is callable with no board on the other side', () => {
    const logic = PartSimulationRegistry.get('microsd-card')!;
    expect(() => {
      const c = logic.attachEvents!(makeElement(), makeSPISim() as any, noPins, 'sd-nowhere');
      c!();
    }).not.toThrow();
  });
});

// ─── ESP32 paths ──────────────────────────────────────────────────────────────
// The following tests verify the `else if (typeof sim.registerSensor)` branch
// that was added to each component for ESP32 QEMU simulation.

// ─── ssd1306 — ESP32 relay path ───────────────────────────────────────────────

// NOTE: 0x3C = 60 decimal → virtual pin = 200 + 60 = 260
describe('ssd1306 — ESP32 relay path', () => {
  it('registers a worker record under its own slot, with its address and owner', () => {
    const sim = makeEsp32Sim();
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(makeElement(), sim as any, noPins, 'oled-q1');
    expect(sim.registerSensor).toHaveBeenCalledWith(
      'ssd1306',
      i2cPartWorkerPin('oled-q1'),
      expect.objectContaining({ addr: 0x3c, owner: 'oled-q1' }),
    );
  });

  it('adds I2C transaction listener for addr 0x3C, under its own id', () => {
    const sim = makeEsp32Sim();
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(makeElement(), sim as any, noPins, 'oled-q2');
    // The echo names the part, so two panels at one address are two listeners.
    expect(sim.addI2CTransactionListener).toHaveBeenCalledWith(0x3c, expect.any(Function), 'oled-q2');
  });

  it('transaction data is forwarded to VirtualSSD1306 device', () => {
    const el = makeElement();
    const sim = makeEsp32Sim();
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(el, sim as any, noPins, 'oled-q3');
    // Send a command-mode control byte + set-page command — should not throw
    expect(() => {
      sim._fireTransaction(0x3c, [0x00, 0xb0]);
    }).not.toThrow();
  });

  it('cleanup unregisters its record and removes the listener', () => {
    const sim = makeEsp32Sim();
    const cleanup = PartSimulationRegistry.get('ssd1306')!.attachEvents!(
      makeElement(),
      sim as any,
      noPins,
      'oled-q4',
    );
    cleanup();
    expect(sim.unregisterSensor).toHaveBeenCalledWith(i2cPartWorkerPin('oled-q4'));
    expect(sim.removeI2CTransactionListener).toHaveBeenCalledWith(0x3c, 'oled-q4');
  });

  it('a board whose engine runs in the tab gets no worker record', () => {
    // An in-browser ESP32 engine answers the part from the fabric; a record
    // would file a stub that ACKs the address whatever the wiring.
    const sim = { ...makeEsp32Sim(), hostsCustomChips: () => false };
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(makeElement(), sim as any, noPins, 'oled-q5');
    expect(sim.registerSensor).not.toHaveBeenCalled();
    expect(sim.addI2CTransactionListener).not.toHaveBeenCalled();
  });
});

// ─── ds1307 — ESP32 path ──────────────────────────────────────────────────────

describe('ds1307 — ESP32 path', () => {
  it('registers a worker record under its own slot at 0x68', () => {
    const sim = makeEsp32Sim();
    PartSimulationRegistry.get('ds1307')!.attachEvents!(makeElement(), sim as any, noPins, 'rtc-q1');
    expect(sim.registerSensor).toHaveBeenCalledWith(
      'ds1307',
      i2cPartWorkerPin('rtc-q1'),
      expect.objectContaining({ addr: 0x68, owner: 'rtc-q1' }),
    );
  });

  it('does NOT add I2C transaction listener (read-only: backend handles reads)', () => {
    const sim = makeEsp32Sim();
    PartSimulationRegistry.get('ds1307')!.attachEvents!(makeElement(), sim as any, noPins, 'rtc-q2');
    expect(sim.addI2CTransactionListener).not.toHaveBeenCalled();
  });

  it("the record carries the tab's clock, which the worker's copy shows", () => {
    // The worker's own clock is the server's, in UTC.
    vi.setSystemTime(new Date(2026, 8, 30, 12, 34, 56, 250));
    const sim = makeEsp32Sim();
    PartSimulationRegistry.get('ds1307')!.attachEvents!(makeElement(), sim as any, noPins, 'rtc-q4');
    const [, , props] = sim.registerSensor.mock.calls[0];
    expect(props).toMatchObject({
      epochMs: new Date(2026, 8, 30, 12, 34, 56, 250).getTime(),
      utcOffsetMin: -new Date(2026, 8, 30, 12, 34, 56, 250).getTimezoneOffset() || 0, // +0, never -0, in UTC
    });
  });

  it('cleanup unregisters its own record', () => {
    const sim = makeEsp32Sim();
    const cleanup = PartSimulationRegistry.get('ds1307')!.attachEvents!(
      makeElement(),
      sim as any,
      noPins,
      'rtc-q3',
    );
    cleanup();
    expect(sim.unregisterSensor).toHaveBeenCalledWith(i2cPartWorkerPin('rtc-q3'));
  });
});

// ─── mpu6050 — ESP32 path ─────────────────────────────────────────────────────

describe('mpu6050 — ESP32 path', () => {
  it('registers a worker record at its address that starts from the panel values', () => {
    // The worker builds its own copy of the chip. Without the values in the
    // record it started from defaults of its own (the die at 25 C against the
    // panel's 24) until the first slider moved.
    const sim = makeEsp32Sim();
    PartSimulationRegistry.get('mpu6050')!.attachEvents!(
      makeElement(),
      sim as any,
      noPins,
      'imu-q1',
    );
    expect(sim.registerSensor).toHaveBeenCalledWith('mpu6050', i2cPartWorkerPin('imu-q1'), {
      accelX: 0,
      accelY: 0,
      accelZ: 1,
      gyroX: 0,
      gyroY: 0,
      gyroZ: 0,
      temp: 24,
      addr: 0x68,
      owner: 'imu-q1',
      // The compiled model the tab runs, which the worker runs too
      // (buses/models/mpu6050.c; mpu6050-vectors-wasm.test.ts).
      wasmB64: expect.any(String),
    });
  });

  it('carries address 0x69 when AD0 is high', () => {
    const sim = makeEsp32Sim();
    PartSimulationRegistry.get('mpu6050')!.attachEvents!(
      makeElement({ ad0: true }),
      sim as any,
      noPins,
      'imu-q2',
    );
    expect(sim.registerSensor).toHaveBeenCalledWith(
      'mpu6050',
      i2cPartWorkerPin('imu-q2'),
      expect.objectContaining({ addr: 0x69 }),
    );
  });

  it('carries the variant, and the pin INT is wired to', () => {
    const sim = makeEsp32Sim();
    PartSimulationRegistry.get('mpu6050')!.attachEvents!(
      makeElement({ variant: 'mpu9250' }),
      sim as any,
      (name: string) => (name === 'INT' ? 4 : null),
      'imu-q3',
    );
    expect(sim.registerSensor).toHaveBeenCalledWith(
      'mpu6050',
      i2cPartWorkerPin('imu-q3'),
      expect.objectContaining({ addr: 0x68, variant: 'mpu9250', int_pin: 4 }),
    );
  });

  it('a slider that moves reaches the worker under the same names', () => {
    const sim = makeEsp32Sim();
    PartSimulationRegistry.get('mpu6050')!.attachEvents!(
      makeElement(),
      sim as any,
      noPins,
      'imu-q3',
    );
    dispatchSensorUpdate('imu-q3', { gyroX: 100 });
    expect(sim.updateSensor).toHaveBeenCalledWith(i2cPartWorkerPin('imu-q3'), { gyroX: 100 });
  });
});

// ─── bmp280 — its address ─────────────────────────────────────────────────────

describe('bmp280 — the address SDO selects', () => {
  const CHIP_ID = 0xd0;
  const attachBmp = (props: Record<string, unknown> = {}) =>
    PartSimulationRegistry.get('bmp280')!.attachEvents!(
      makeElement(props),
      makeI2CSim() as any,
      noPins,
      'bmp',
    );

  it('answers at 0x76 when nothing says otherwise', () => {
    const rig = i2cRig({ bmp: HW_I2C_PINS });
    attachBmp();
    expect([rig.ack(0x76), rig.ack(0x77)]).toEqual([true, false]);
  });

  it('answers at 0x77 when element.address says so', () => {
    const rig = i2cRig({ bmp: HW_I2C_PINS });
    attachBmp({ address: '0x77' });
    expect([rig.ack(0x76), rig.ack(0x77)]).toEqual([false, true]);
  });

  it('answers at 0x77 when element.i2cAddress says so, which is what the Grove BMP280 sets', () => {
    // Seeed_BMP280 has 0x77 compiled in and, after requestFrom, waits in
    // while (!Wire.available()) for a byte that a NAK never brings: with the
    // model at 0x76 the gallery example grove-bmp280-xiao-esp32c6 printed
    // nothing after its boot banner.
    const rig = i2cRig({ bmp: HW_I2C_PINS });
    attachBmp({ i2cAddress: '0x77' });
    expect([rig.ack(0x76), rig.ack(0x77)]).toEqual([false, true]);
    expect(rig.readReg(0x77, CHIP_ID, 1)).toEqual([0x58]);
  });

  it('takes the address as a number or in decimal too', () => {
    for (const i2cAddress of [0x77, '119', '0X77']) {
      const rig = i2cRig({ bmp: HW_I2C_PINS });
      const off = attachBmp({ i2cAddress });
      expect([rig.ack(0x76), rig.ack(0x77)], String(i2cAddress)).toEqual([false, true]);
      off();
      rig.dispose();
    }
  });

  it('stays at 0x76 for an address the chip does not have', () => {
    const rig = i2cRig({ bmp: HW_I2C_PINS });
    attachBmp({ i2cAddress: '0x3C' });
    expect([rig.ack(0x3c), rig.ack(0x76), rig.ack(0x77)]).toEqual([false, true, false]);
  });

  it('the worker record of a QEMU board carries the same address', () => {
    const sim = makeEsp32Sim();
    PartSimulationRegistry.get('bmp280')!.attachEvents!(
      makeElement({ i2cAddress: '0x77' }),
      sim as any,
      noPins,
      'bmp-grove',
    );
    expect(sim.registerSensor).toHaveBeenCalledWith(
      'bmp280',
      i2cPartWorkerPin('bmp-grove'),
      expect.objectContaining({ addr: 0x77 }),
    );
  });
});

// ─── bmp280 — ESP32 path ──────────────────────────────────────────────────────

describe('bmp280 — ESP32 path', () => {
  it('registers a worker record under its own slot at 0x76', () => {
    const sim = makeEsp32Sim();
    PartSimulationRegistry.get('bmp280')!.attachEvents!(makeElement(), sim as any, noPins, 'bmp-esp-1');
    expect(sim.registerSensor).toHaveBeenCalledWith(
      'bmp280',
      i2cPartWorkerPin('bmp-esp-1'),
      expect.objectContaining({ addr: 0x76, owner: 'bmp-esp-1' }),
    );
  });

  it('an element with no temperature starts the worker at the panel default (24 C, 1013.25 hPa)', () => {
    const sim = makeEsp32Sim();
    PartSimulationRegistry.get('bmp280')!.attachEvents!(makeElement(), sim as any, noPins, 'bmp-esp-def');
    expect(SENSOR_CONTROLS.bmp280.defaultValues).toMatchObject({ temperature: 24, pressure: 1013.25 });
    expect(sim.registerSensor).toHaveBeenCalledWith(
      'bmp280',
      i2cPartWorkerPin('bmp-esp-def'),
      expect.objectContaining({ temperature: 24, pressure: 1013.25 }),
    );
  });

  it('carries address 0x77 when the element says so', () => {
    const sim = makeEsp32Sim();
    PartSimulationRegistry.get('bmp280')!.attachEvents!(
      makeElement({ address: '0x77' }),
      sim as any,
      noPins,
      'bmp-esp-2',
    );
    expect(sim.registerSensor).toHaveBeenCalledWith(
      'bmp280',
      i2cPartWorkerPin('bmp-esp-2'),
      expect.objectContaining({ addr: 0x77 }),
    );
  });

  it('two sensors at one address are two records', () => {
    const sim = makeEsp32Sim();
    PartSimulationRegistry.get('bmp280')!.attachEvents!(makeElement(), sim as any, noPins, 'bmp-esp-7');
    PartSimulationRegistry.get('bmp280')!.attachEvents!(makeElement(), sim as any, noPins, 'bmp-esp-8');
    const pins = sim.registerSensor.mock.calls.map((c: unknown[]) => c[1]);
    expect(new Set(pins).size).toBe(2);
  });

  it('forwards initial temperature from element.temperature', () => {
    const sim = makeEsp32Sim();
    const logic = PartSimulationRegistry.get('bmp280')!;
    logic.attachEvents!(makeElement({ temperature: '35.5' }), sim as any, noPins, 'bmp-esp-3');
    const [, , props] = sim.registerSensor.mock.calls[0];
    expect(props.temperature).toBeCloseTo(35.5);
  });

  it('forwards initial pressure from element.pressure', () => {
    const sim = makeEsp32Sim();
    const logic = PartSimulationRegistry.get('bmp280')!;
    logic.attachEvents!(makeElement({ pressure: '980.5' }), sim as any, noPins, 'bmp-esp-4');
    const [, , props] = sim.registerSensor.mock.calls[0];
    expect(props.pressure).toBeCloseTo(980.5);
  });

  it('registerSensorUpdate callback calls updateSensor with new values', () => {
    const sim = makeEsp32Sim();
    const logic = PartSimulationRegistry.get('bmp280')!;
    logic.attachEvents!(makeElement(), sim as any, noPins, 'bmp-esp-5');
    dispatchSensorUpdate('bmp-esp-5', { temperature: 40, pressure: 950 });
    expect(sim.updateSensor).toHaveBeenCalledWith(
      i2cPartWorkerPin('bmp-esp-5'),
      expect.objectContaining({ temperature: 40 }),
    );
  });

  it('cleanup calls unregisterSensor and unregisters sensor update', () => {
    const sim = makeEsp32Sim();
    const logic = PartSimulationRegistry.get('bmp280')!;
    const cleanup = logic.attachEvents!(makeElement(), sim as any, noPins, 'bmp-esp-6');
    cleanup();
    expect(sim.unregisterSensor).toHaveBeenCalledWith(i2cPartWorkerPin('bmp-esp-6'));
    // After cleanup, dispatching an update must NOT call updateSensor again
    sim.updateSensor.mockClear();
    dispatchSensorUpdate('bmp-esp-6', { temperature: 99 });
    expect(sim.updateSensor).not.toHaveBeenCalled();
  });
});

// ─── ds3231 — ESP32 path ──────────────────────────────────────────────────────

describe('ds3231 — ESP32 path', () => {
  it('registers a worker record under its own slot at 0x68', () => {
    const sim = makeEsp32Sim();
    PartSimulationRegistry.get('ds3231')!.attachEvents!(makeElement(), sim as any, noPins, 'ds-q1');
    expect(sim.registerSensor).toHaveBeenCalledWith(
      'ds3231',
      i2cPartWorkerPin('ds-q1'),
      expect.objectContaining({ addr: 0x68, owner: 'ds-q1' }),
    );
  });

  it('forwards initial temperature from element.temperature', () => {
    const sim = makeEsp32Sim();
    PartSimulationRegistry.get('ds3231')!.attachEvents!(
      makeElement({ temperature: '28.5' }),
      sim as any,
      noPins,
      'ds-q2',
    );
    const [, , props] = sim.registerSensor.mock.calls[0];
    expect(props.temperature).toBeCloseTo(28.5);
  });

  it("the record starts from the panel's temperature and carries the tab's clock", () => {
    vi.setSystemTime(new Date(2026, 8, 30, 12, 34, 56, 250));
    const sim = makeEsp32Sim();
    PartSimulationRegistry.get('ds3231')!.attachEvents!(makeElement(), sim as any, noPins, 'ds-q4');
    const [, , props] = sim.registerSensor.mock.calls[0];
    expect(props).toMatchObject({
      temperature: SENSOR_CONTROLS.ds3231.defaultValues.temperature,
      epochMs: new Date(2026, 8, 30, 12, 34, 56, 250).getTime(),
      utcOffsetMin: -new Date(2026, 8, 30, 12, 34, 56, 250).getTimezoneOffset() || 0, // +0, never -0, in UTC
    });
  });

  it('a temperature that is not a number leaves the last one in place', () => {
    const rig = i2cRig({ 'ds-q5': HW_I2C_PINS });
    PartSimulationRegistry.get('ds3231')!.attachEvents!(
      makeElement({ temperature: 'warm' }),
      makeI2CSim() as any,
      noPins,
      'ds-q5',
    );
    expect(rig.readReg(0x68, 0x11, 2)).toEqual([25, 0x00]);
    dispatchSensorUpdate('ds-q5', { temperature: NaN });
    expect(rig.readReg(0x68, 0x11, 2)).toEqual([25, 0x00]);
  });

  it('cleanup unregisters its own record', () => {
    const sim = makeEsp32Sim();
    const cleanup = PartSimulationRegistry.get('ds3231')!.attachEvents!(
      makeElement(),
      sim as any,
      noPins,
      'ds-q3',
    );
    cleanup();
    expect(sim.unregisterSensor).toHaveBeenCalledWith(i2cPartWorkerPin('ds-q3'));
  });
});

// ─── ds3231 — on a board whose firmware runs in the tab ───────────────────────

describe('ds3231 — AVR/RP2040 path', () => {
  const tempRegs = (rig: I2cRig) => rig.readReg(0x68, 0x11, 2)!;

  it('answers at 0x68 seeded with element.temperature', () => {
    const rig = i2cRig({ 'ds3231-avr-1': HW_I2C_PINS });
    PartSimulationRegistry.get('ds3231')!.attachEvents!(
      makeElement({ temperature: '31.25' }),
      makeI2CSim() as any,
      noPins,
      'ds3231-avr-1',
    );
    expect(tempRegs(rig)).toEqual([31, 0b01 << 6]);
  });

  it('SensorControlPanel updates reach the virtual device live', () => {
    const rig = i2cRig({ 'ds3231-avr-2': HW_I2C_PINS });
    const cleanup = PartSimulationRegistry.get('ds3231')!.attachEvents!(
      makeElement(),
      makeI2CSim() as any,
      noPins,
      'ds3231-avr-2',
    );
    expect(tempRegs(rig)[0]).toBe(25);
    dispatchSensorUpdate('ds3231-avr-2', { temperature: 30 });
    expect(tempRegs(rig)[0]).toBe(30);
    cleanup();
    expect(rig.ack(0x68)).toBe(false);
  });

  it('temperature registers 0x11/0x12 encode integer + quarter-degree fraction', () => {
    const rig = i2cRig({ 'ds3231-avr-3': HW_I2C_PINS });
    PartSimulationRegistry.get('ds3231')!.attachEvents!(
      makeElement({ temperature: '25.75' }),
      makeI2CSim() as any,
      noPins,
      'ds3231-avr-3',
    );
    // Point at 0x11 and read MSB + LSB like RTClib's getTemperature().
    expect(tempRegs(rig)).toEqual([25, 0b11 << 6]); // 0.75 °C = 3 quarter-steps in bits 7:6
  });
});

// ─── pcf8574 — ESP32 relay path ───────────────────────────────────────────────

describe('pcf8574 — ESP32 relay path', () => {
  it('registers a worker record under its own slot at 0x27', () => {
    const sim = makeEsp32Sim();
    PartSimulationRegistry.get('pcf8574')!.attachEvents!(makeElement(), sim as any, noPins, 'pcf-q1');
    expect(sim.registerSensor).toHaveBeenCalledWith(
      'pcf8574',
      i2cPartWorkerPin('pcf-q1'),
      expect.objectContaining({ addr: 0x27, owner: 'pcf-q1' }),
    );
  });

  it('adds I2C transaction listener for addr 0x27, under its own id', () => {
    const sim = makeEsp32Sim();
    PartSimulationRegistry.get('pcf8574')!.attachEvents!(makeElement(), sim as any, noPins, 'pcf-q2');
    expect(sim.addI2CTransactionListener).toHaveBeenCalledWith(0x27, expect.any(Function), 'pcf-q2');
  });

  it('transaction byte is forwarded to VirtualPCF8574 — onWrite fires', () => {
    const el = makeElement();
    const sim = makeEsp32Sim();
    PartSimulationRegistry.get('pcf8574')!.attachEvents!(el, sim as any, noPins, 'pcf-q3');
    // Fire a transaction: MCU wrote byte 0xAB to I2C address 0x27
    sim._fireTransaction(0x27, [0xab]);
    expect((el as any).value).toBe(0xab);
  });

  it('transaction at different address does NOT update element', () => {
    const el = makeElement();
    const sim = makeEsp32Sim();
    PartSimulationRegistry.get('pcf8574')!.attachEvents!(el, sim as any, noPins, 'pcf-q4');
    sim._fireTransaction(0x20, [0xff]); // wrong address
    expect((el as any).value).toBeUndefined();
  });

  it('cleanup unregisters its record and removes the listener', () => {
    const sim = makeEsp32Sim();
    const cleanup = PartSimulationRegistry.get('pcf8574')!.attachEvents!(
      makeElement(),
      sim as any,
      noPins,
      'pcf-q5',
    );
    cleanup();
    expect(sim.unregisterSensor).toHaveBeenCalledWith(i2cPartWorkerPin('pcf-q5'));
    expect(sim.removeI2CTransactionListener).toHaveBeenCalledWith(0x27, 'pcf-q5');
  });
});

// ─── microSD card — SD-over-SPI storage (Phase 1) ───────────────────────────────
describe('microsd-card — SD-over-SPI storage', () => {
  const CS = 10;
  /** A card selected on the rig's bus; `replies` collects every MISO byte. */
  function setupSD(props: Record<string, unknown> = {}) {
    const rig = spiRig('sd1', { SCK: RIG_SCK, DI: RIG_MOSI, DO: RIG_MISO, CS });
    const logic = PartSimulationRegistry.get('microsd-card')!;
    const cleanup = logic.attachEvents!(makeElement(props), makeSPISim() as any, noPins, 'sd1');
    rig.write(CS, false);
    const replies: number[] = [];
    const send = (bytes: number[]) => {
      for (const b of rig.send(bytes)) replies.push(b);
    };
    return { rig, replies, send, cleanup };
  }

  const cmd = (index: number, arg = 0): number[] => [
    0x40 | index,
    (arg >>> 24) & 0xff,
    (arg >>> 16) & 0xff,
    (arg >>> 8) & 0xff,
    arg & 0xff,
    0x95,
  ];
  const FF = (n: number): number[] => new Array(n).fill(0xff);

  // SDSC byte addressing: block N is byte offset N*512.
  const at = (block: number): number => block * 512;

  /** Read a 512-byte block via CMD17 and return its data bytes. */
  function readSdBlock(send: (b: number[]) => void, replies: number[], block: number): number[] {
    replies.length = 0;
    send(cmd(17, at(block)));
    send(FF(520));
    const t = replies.indexOf(0xfe); // data-start token (latency-robust)
    return replies.slice(t + 1, t + 1 + 512);
  }

  it('init handshake: CMD0/CMD8/ACMD41/CMD58 give the expected R1/R7/OCR', () => {
    const { send, replies } = setupSD();
    // N_CR: nothing comes back on the 6 command bytes, then the card clocks
    // out one fill byte (index 6) and its response from index 7. SdFat throws
    // that fill byte away before it polls, which is why it has to be there.
    const after = (c: number[], extra: number) => {
      replies.length = 0;
      send(c);
      send(FF(extra + 1));
    };
    after(cmd(0), 1);
    expect(replies.slice(6, 8)).toEqual([0xff, 0x01]); // fill, then idle
    after(cmd(8, 0x1aa), 5);
    expect(replies.slice(6, 12)).toEqual([0xff, 0x01, 0x00, 0x00, 0x01, 0xaa]); // R7
    after(cmd(55), 1);
    expect(replies[7]).toBe(0x01);
    after(cmd(41), 1);
    expect(replies[7]).toBe(0x00); // ACMD41 ready
    after(cmd(58), 5);
    expect(replies.slice(7, 12)).toEqual([0x00, 0x80, 0xff, 0x80, 0x00]); // OCR (SDSC)
  });

  it('writes a block (CMD24 + data) and reads it back identically (CMD17)', () => {
    const { send, replies } = setupSD();
    const data = Array.from({ length: 512 }, (_, i) => (i * 7 + 3) & 0xff);
    // CMD24 write block 5, then: gap, start token, 512 data, 2 CRC, + a clock
    send(cmd(24, at(5)));
    send([0xff, 0xfe, ...data, 0xff, 0xff, 0xff]);
    expect(replies).toContain(0x05); // data-response: accepted
    // Read it back
    expect(readSdBlock(send, replies, 5)).toEqual(data);
  });

  it('unwritten blocks read back as zeros', () => {
    const { send, replies } = setupSD();
    expect(readSdBlock(send, replies, 999)).toEqual(new Array(512).fill(0));
  });

  it('CMD9 returns a 16-byte CSD v2 reflecting the configured capacity', () => {
    const { send, replies } = setupSD();
    send(cmd(9));
    send(FF(20));
    const t = replies.indexOf(0xfe);
    const csd = replies.slice(t + 1, t + 1 + 16);
    expect(csd.length).toBe(16);
    expect(csd[0] & 0xc0).toBe(0x40); // CSD structure v2
    // 64 MB -> C_SIZE = 64MB/512KB - 1 = 127 -> low byte 0x7F
    expect(csd[9]).toBe(0x7f);
  });

  it('reads a pre-injected FAT image via element.sdImageData', () => {
    const block0 = Array.from({ length: 512 }, (_, i) => (i ^ 0x5a) & 0xff);
    const block1 = Array.from({ length: 512 }, (_, i) => (i + 200) & 0xff);
    const image = Uint8Array.from([...block0, ...block1]);
    const { send, replies } = setupSD({ sdImageData: image });
    expect(readSdBlock(send, replies, 0)).toEqual(block0);
    expect(readSdBlock(send, replies, 1)).toEqual(block1);
  });

  it('multi-block write (CMD25) stores consecutive blocks until the stop token', () => {
    const { send, replies } = setupSD();
    const a = Array.from({ length: 512 }, (_, i) => (i + 1) & 0xff);
    const b = Array.from({ length: 512 }, (_, i) => (i + 2) & 0xff);
    send(cmd(25, at(10))); // write starting at block 10
    send([0xfc, ...a, 0xff, 0xff]); // block 10 (multi data token 0xFC)
    send([0xfc, ...b, 0xff, 0xff]); // block 11
    send([0xfd]); // stop-transmission token
    expect(readSdBlock(send, replies, 10)).toEqual(a);
    expect(readSdBlock(send, replies, 11)).toEqual(b);
  });

  it('multi-block write survives the chip select SdFat drops between blocks', () => {
    // SdFat's SharedSpiCard (arduino-pico's SD.h, and every build whose bus is
    // shared) releases CS between writeStart, each writeData and writeStop, so
    // the card meets the 0xFC token of the next block in a NEW transaction and
    // has to still be in its data phase. Ending the whole transfer on deselect
    // sent that token, and then 512 bytes of user data, through the command
    // parser.
    const { rig, send, replies } = setupSD();
    const a = Array.from({ length: 512 }, (_, i) => (i + 1) & 0xff);
    const b = Array.from({ length: 512 }, (_, i) => (i + 2) & 0xff);
    const cycleCs = () => {
      rig.write(CS, true);
      rig.write(CS, false);
    };
    send(cmd(25, at(10)));
    send(FF(4)); // R1
    cycleCs();
    send([0xff, 0xfc, ...a, 0xff, 0xff]); // block 10, its own transaction
    send(FF(4));
    expect(replies).toContain(0x05); // data-response: accepted
    cycleCs();
    send([0xff, 0xfc, ...b, 0xff, 0xff]); // block 11
    send(FF(4));
    cycleCs();
    send([0xfd]); // stop-transmission token
    expect(readSdBlock(send, replies, 10)).toEqual(a);
    expect(readSdBlock(send, replies, 11)).toEqual(b);
  });
});
