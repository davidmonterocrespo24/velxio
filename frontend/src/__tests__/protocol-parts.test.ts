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
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import { LineSensorHub } from '../simulation/line/LineSensorHub';
import type { LineHostPort } from '../simulation/line/LineHost';
import { INITIAL_PAD, type PadEvent, type PadState } from '../simulation/line/padEvent';
import { clearLineGaps, lineGaps } from '../simulation/line/requestLine';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';
import {
  emitIr,
  irAirStats,
  necDecode,
  necEncode,
  resetIrAir,
  NEC_REPEAT_PERIOD_MS,
} from '../simulation/ir';
import { useSimulatorStore } from '../store/useSimulatorStore';
import '../simulation/parts/ProtocolParts';

// ─── Globals ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => 1);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
  it('calls addI2CDevice with address 0x3C', () => {
    const sim = makeI2CSim();
    const logic = PartSimulationRegistry.get('ssd1306')!;
    logic.attachEvents!(makeElement(), sim as any, noPins);
    expect(sim.addI2CDevice).toHaveBeenCalledOnce();
    const device = sim.addI2CDevice.mock.calls[0][0];
    expect(device.address).toBe(0x3c);
  });

  it('cleanup calls removeDevice on i2cBus', () => {
    const sim = makeI2CSim();
    const logic = PartSimulationRegistry.get('ssd1306')!;
    const cleanup = logic.attachEvents!(makeElement(), sim as any, noPins);
    cleanup();
    expect(sim.i2cBus.removeDevice).toHaveBeenCalledWith(0x3c);
  });

  it('decodes horizontal addressing: write data bytes into buffer correctly', () => {
    const sim = makeI2CSim();
    const logic = PartSimulationRegistry.get('ssd1306')!;
    logic.attachEvents!(makeElement(), sim as any, noPins);
    const device = sim.addI2CDevice.mock.calls[0][0];
    // Set column address 0–127, page address 0–7 (via commands)
    device.writeByte(0x00); // control: command stream
    device.writeByte(0x21); // cmd: set column address
    device.writeByte(0x00); // col start = 0
    device.writeByte(0x7f); // col end   = 127
    device.writeByte(0x22); // cmd: set page address
    device.writeByte(0x00); // page start = 0
    device.writeByte(0x07); // page end   = 7
    device.stop(); // flushes command state

    device.writeByte(0x40); // control: data stream
    device.writeByte(0xab); // column 0 of page 0 = 0xAB
    device.stop();

    expect(device.buffer[0]).toBe(0xab);
  });

  it('readByte returns 0xFF (read not supported)', () => {
    const sim = makeI2CSim();
    const logic = PartSimulationRegistry.get('ssd1306')!;
    logic.attachEvents!(makeElement(), sim as any, noPins);
    const device = sim.addI2CDevice.mock.calls[0][0];
    expect(device.readByte()).toBe(0xff);
  });

  it('no-op when simulator has no addI2CDevice', () => {
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
    const sim = makeI2CSim();
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(makeElement(), sim as any, noPins);
    expect(sim.addI2CDevice).toHaveBeenCalledOnce();
    expect(sim.spi).toBeNull();
  });

  it('runs SPI when CS is wired to a GPIO', () => {
    const sim = makeSPISim();
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(
      makeElement(),
      sim as any,
      pinMap({ CS: 5 }),
    );
    // SPI decoder hooks spi.onByte; the I2C path would call addI2CDevice instead.
    expect(typeof sim.spi.onByte).toBe('function');
    expect(sim.addI2CDevice).not.toHaveBeenCalled();
  });

  it('runs I2C when only DC is wired (DC is the I2C address-select, not SPI)', () => {
    const sim = makeI2CSim();
    PartSimulationRegistry.get('ssd1306')!.attachEvents!(
      makeElement(),
      sim as any,
      pinMap({ DC: 4 }),
    );
    expect(sim.addI2CDevice).toHaveBeenCalledOnce();
  });

  it('honors an explicit protocol property (migrated legacy projects)', () => {
    // A project migrated from the old ssd1306-spi entry carries protocol:'spi';
    // it must run SPI even though nothing SPI-specific is wired (CS absent).
    useSimulatorStore.setState({
      components: [{ id: 'oled-legacy', metadataId: 'ssd1306', properties: { protocol: 'spi' } }],
    } as any);
    try {
      const sim = makeSPISim();
      PartSimulationRegistry.get('ssd1306')!.attachEvents!(
        makeElement(),
        sim as any,
        noPins,
        'oled-legacy',
      );
      expect(typeof sim.spi.onByte).toBe('function');
      expect(sim.addI2CDevice).not.toHaveBeenCalled();
    } finally {
      useSimulatorStore.setState({ components: [] } as any);
    }
  });
});

// ─── ds1307 ───────────────────────────────────────────────────────────────────

describe('ds1307 — I2C RTC', () => {
  it('calls addI2CDevice with address 0x68', () => {
    const sim = makeI2CSim();
    const logic = PartSimulationRegistry.get('ds1307')!;
    logic.attachEvents!(makeElement(), sim as any, noPins);
    const dev = sim.addI2CDevice.mock.calls[0][0];
    expect(dev.address).toBe(0x68);
  });

  it('readByte returns valid BCD for seconds (register 0)', () => {
    const sim = makeI2CSim();
    const logic = PartSimulationRegistry.get('ds1307')!;
    logic.attachEvents!(makeElement(), sim as any, noPins);
    const dev = sim.addI2CDevice.mock.calls[0][0];
    dev.writeByte(0x00); // set register pointer to 0 (seconds)
    const seconds = dev.readByte();
    // BCD: upper nibble = tens digit, lower nibble = units digit
    const tens = (seconds >> 4) & 0xf;
    const units = seconds & 0xf;
    expect(tens).toBeLessThanOrEqual(5);
    expect(units).toBeLessThanOrEqual(9);
  });

  it('cleanup removes device from i2cBus', () => {
    const sim = makeI2CSim();
    const logic = PartSimulationRegistry.get('ds1307')!;
    const cleanup = logic.attachEvents!(makeElement(), sim as any, noPins);
    cleanup();
    expect(sim.i2cBus.removeDevice).toHaveBeenCalledWith(0x68);
  });
});

// ─── mpu6050 ──────────────────────────────────────────────────────────────────

describe('mpu6050 — I2C IMU', () => {
  it('calls addI2CDevice with address 0x68 (AD0=0)', () => {
    const sim = makeI2CSim();
    const logic = PartSimulationRegistry.get('mpu6050')!;
    logic.attachEvents!(makeElement(), sim as any, noPins);
    const dev = sim.addI2CDevice.mock.calls[0][0];
    expect(dev.address).toBe(0x68);
  });

  it('uses address 0x69 when element.ad0 is true', () => {
    const sim = makeI2CSim();
    const logic = PartSimulationRegistry.get('mpu6050')!;
    logic.attachEvents!(makeElement({ ad0: true }), sim as any, noPins);
    const dev = sim.addI2CDevice.mock.calls[0][0];
    expect(dev.address).toBe(0x69);
  });

  it('WHO_AM_I register (0x75) returns 0x68', () => {
    const sim = makeI2CSim();
    const logic = PartSimulationRegistry.get('mpu6050')!;
    logic.attachEvents!(makeElement(), sim as any, noPins);
    const dev = sim.addI2CDevice.mock.calls[0][0];
    dev.writeByte(0x75); // set register pointer
    expect(dev.readByte()).toBe(0x68);
  });

  it('ACCEL_ZOUT reports +1g (0x40, 0x00)', () => {
    const sim = makeI2CSim();
    const logic = PartSimulationRegistry.get('mpu6050')!;
    logic.attachEvents!(makeElement(), sim as any, noPins);
    const dev = sim.addI2CDevice.mock.calls[0][0];
    dev.writeByte(0x3f); // ACCEL_ZOUT_H
    expect(dev.readByte()).toBe(0x40);
    expect(dev.readByte()).toBe(0x00);
  });

  it('cleanup removes device', () => {
    const sim = makeI2CSim();
    const logic = PartSimulationRegistry.get('mpu6050')!;
    const cleanup = logic.attachEvents!(makeElement(), sim as any, noPins);
    cleanup();
    expect(sim.i2cBus.removeDevice).toHaveBeenCalledWith(0x68);
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
    expect(port.edges[0]).toEqual([7, false, 10_000 + 16 * 20]);
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
  it('hooks into simulator.spi.onByte', () => {
    const sim = makeSPISim();
    const logic = PartSimulationRegistry.get('microsd-card')!;
    logic.attachEvents!(makeElement(), sim as any, noPins);
    expect(sim.spi.onByte).toBeTypeOf('function');
  });

  it('CMD0 (0x40 + 4 zeroes + CRC) returns R1=0x01 (idle)', () => {
    const sim = makeSPISim();
    const logic = PartSimulationRegistry.get('microsd-card')!;
    logic.attachEvents!(makeElement(), sim as any, noPins);

    const tx = sim.spi.onByte as (b: number) => void;
    // Send CMD0: [0x40, 0x00, 0x00, 0x00, 0x00, 0x95]
    [0x40, 0x00, 0x00, 0x00, 0x00, 0x95].forEach((b) => tx(b));
    // Poll with 0xFF to receive response
    tx(0xff);
    const replies = (sim.spi.completeTransfer as ReturnType<typeof vi.fn>).mock.calls.map(
      ([v]) => v,
    );
    expect(replies).toContain(0x01);
  });

  it('CMD8 returns R7 with echo-back 0x1AA', () => {
    const sim = makeSPISim();
    const logic = PartSimulationRegistry.get('microsd-card')!;
    logic.attachEvents!(makeElement(), sim as any, noPins);

    const tx = sim.spi.onByte as (b: number) => void;
    // CMD8: [0x48, 0x00, 0x00, 0x01, 0xAA, 0x87]
    [0x48, 0x00, 0x00, 0x01, 0xaa, 0x87].forEach((b) => tx(b));
    // Read 5 bytes of R7 response
    for (let i = 0; i < 5; i++) tx(0xff);
    const replies = (sim.spi.completeTransfer as ReturnType<typeof vi.fn>).mock.calls.map(
      ([v]) => v,
    );
    // R7 = 0x01, 0x00, 0x00, 0x01, 0xAA
    expect(replies).toContain(0x01);
    expect(replies).toContain(0xaa);
  });

  it('ACMD41 (CMD55 + CMD41) returns R1=0x00 (ready)', () => {
    const sim = makeSPISim();
    const logic = PartSimulationRegistry.get('microsd-card')!;
    logic.attachEvents!(makeElement(), sim as any, noPins);

    const tx = sim.spi.onByte as (b: number) => void;
    [0x77, 0x00, 0x00, 0x00, 0x00, 0x65].forEach((b) => tx(b)); // CMD55
    tx(0xff); // poll
    sim.spi.completeTransfer.mockClear();
    [0x69, 0x40, 0x00, 0x00, 0x00, 0x77].forEach((b) => tx(b)); // ACMD41
    tx(0xff);
    const replies = (sim.spi.completeTransfer as ReturnType<typeof vi.fn>).mock.calls.map(
      ([v]) => v,
    );
    expect(replies).toContain(0x00);
  });

  it('0xFF clock bytes return 0xFF (idle) when no pending response', () => {
    const sim = makeSPISim();
    const logic = PartSimulationRegistry.get('microsd-card')!;
    logic.attachEvents!(makeElement(), sim as any, noPins);

    const tx = sim.spi.onByte as (b: number) => void;
    tx(0xff);
    expect(sim.spi.completeTransfer).toHaveBeenLastCalledWith(0xff);
  });

  it('cleanup restores previous onByte and is callable without SPI', () => {
    const sim = makeSPISim();
    const logic = PartSimulationRegistry.get('microsd-card')!;
    const cleanup = logic.attachEvents!(makeElement(), sim as any, noPins);
    expect(() => cleanup()).not.toThrow();
    expect(sim.spi.onByte).toBeNull();
  });

  it('no-op when simulator has no spi', () => {
    const sim = { ...makeSPISim(), spi: null };
    const logic = PartSimulationRegistry.get('microsd-card')!;
    expect(() => {
      const c = logic.attachEvents!(makeElement(), sim as any, noPins);
      c();
    }).not.toThrow();
  });
});

// ─── ESP32 paths ──────────────────────────────────────────────────────────────
// The following tests verify the `else if (typeof sim.registerSensor)` branch
// that was added to each component for ESP32 QEMU simulation.

// ─── ssd1306 — ESP32 relay path ───────────────────────────────────────────────

// NOTE: 0x3C = 60 decimal → virtual pin = 200 + 60 = 260
describe('ssd1306 — ESP32 relay path', () => {
  it('registers sensor with type ssd1306 and virtual pin 260 (200+0x3C)', () => {
    const sim = makeEsp32Sim();
    const logic = PartSimulationRegistry.get('ssd1306')!;
    logic.attachEvents!(makeElement(), sim as any, noPins);
    expect(sim.registerSensor).toHaveBeenCalledWith(
      'ssd1306',
      260,
      expect.objectContaining({ addr: 0x3c }),
    );
  });

  it('adds I2C transaction listener for addr 0x3C', () => {
    const sim = makeEsp32Sim();
    const logic = PartSimulationRegistry.get('ssd1306')!;
    logic.attachEvents!(makeElement(), sim as any, noPins);
    expect(sim.addI2CTransactionListener).toHaveBeenCalledWith(0x3c, expect.any(Function));
  });

  it('transaction data is forwarded to VirtualSSD1306 device', () => {
    const el = makeElement();
    const sim = makeEsp32Sim();
    const logic = PartSimulationRegistry.get('ssd1306')!;
    logic.attachEvents!(el, sim as any, noPins);
    // Send a command-mode control byte + set-page command — should not throw
    expect(() => {
      sim._fireTransaction(0x3c, [0x00, 0xb0]);
    }).not.toThrow();
  });

  it('cleanup calls unregisterSensor(260) and removeI2CTransactionListener(0x3C)', () => {
    const sim = makeEsp32Sim();
    const logic = PartSimulationRegistry.get('ssd1306')!;
    const cleanup = logic.attachEvents!(makeElement(), sim as any, noPins);
    cleanup();
    expect(sim.unregisterSensor).toHaveBeenCalledWith(260);
    expect(sim.removeI2CTransactionListener).toHaveBeenCalledWith(0x3c);
  });
});

// ─── ds1307 — ESP32 path ──────────────────────────────────────────────────────

describe('ds1307 — ESP32 path', () => {
  it('registers sensor with type ds1307 and virtual pin 304 (200+0x68)', () => {
    const sim = makeEsp32Sim();
    const logic = PartSimulationRegistry.get('ds1307')!;
    logic.attachEvents!(makeElement(), sim as any, noPins);
    expect(sim.registerSensor).toHaveBeenCalledWith(
      'ds1307',
      304,
      expect.objectContaining({ addr: 0x68 }),
    );
  });

  it('does NOT add I2C transaction listener (read-only: backend handles reads)', () => {
    const sim = makeEsp32Sim();
    const logic = PartSimulationRegistry.get('ds1307')!;
    logic.attachEvents!(makeElement(), sim as any, noPins);
    expect(sim.addI2CTransactionListener).not.toHaveBeenCalled();
  });

  it('cleanup calls unregisterSensor(304)', () => {
    const sim = makeEsp32Sim();
    const logic = PartSimulationRegistry.get('ds1307')!;
    const cleanup = logic.attachEvents!(makeElement(), sim as any, noPins);
    cleanup();
    expect(sim.unregisterSensor).toHaveBeenCalledWith(304);
  });
});

// ─── bmp280 — ESP32 path ──────────────────────────────────────────────────────

describe('bmp280 — ESP32 path', () => {
  it('registers sensor with type bmp280 and virtual pin 318 (200+0x76)', () => {
    const sim = makeEsp32Sim();
    const logic = PartSimulationRegistry.get('bmp280')!;
    logic.attachEvents!(makeElement(), sim as any, noPins, 'bmp-esp-1');
    expect(sim.registerSensor).toHaveBeenCalledWith(
      'bmp280',
      318,
      expect.objectContaining({ addr: 0x76 }),
    );
  });

  it('uses virtual pin 319 (200+0x77) when address is 0x77', () => {
    const sim = makeEsp32Sim();
    const logic = PartSimulationRegistry.get('bmp280')!;
    logic.attachEvents!(makeElement({ address: '0x77' }), sim as any, noPins, 'bmp-esp-2');
    expect(sim.registerSensor).toHaveBeenCalledWith(
      'bmp280',
      319,
      expect.objectContaining({ addr: 0x77 }),
    );
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
      318,
      expect.objectContaining({ temperature: 40 }),
    );
  });

  it('cleanup calls unregisterSensor and unregisters sensor update', () => {
    const sim = makeEsp32Sim();
    const logic = PartSimulationRegistry.get('bmp280')!;
    const cleanup = logic.attachEvents!(makeElement(), sim as any, noPins, 'bmp-esp-6');
    cleanup();
    expect(sim.unregisterSensor).toHaveBeenCalledWith(318);
    // After cleanup, dispatching an update must NOT call updateSensor again
    sim.updateSensor.mockClear();
    dispatchSensorUpdate('bmp-esp-6', { temperature: 99 });
    expect(sim.updateSensor).not.toHaveBeenCalled();
  });
});

// ─── ds3231 — ESP32 path ──────────────────────────────────────────────────────

describe('ds3231 — ESP32 path', () => {
  it('registers sensor with type ds3231 and virtual pin 304 (200+0x68)', () => {
    const sim = makeEsp32Sim();
    const logic = PartSimulationRegistry.get('ds3231')!;
    logic.attachEvents!(makeElement(), sim as any, noPins);
    expect(sim.registerSensor).toHaveBeenCalledWith(
      'ds3231',
      304,
      expect.objectContaining({ addr: 0x68 }),
    );
  });

  it('forwards initial temperature from element.temperature', () => {
    const sim = makeEsp32Sim();
    const logic = PartSimulationRegistry.get('ds3231')!;
    logic.attachEvents!(makeElement({ temperature: '28.5' }), sim as any, noPins);
    const [, , props] = sim.registerSensor.mock.calls[0];
    expect(props.temperature).toBeCloseTo(28.5);
  });

  it('cleanup calls unregisterSensor(304)', () => {
    const sim = makeEsp32Sim();
    const logic = PartSimulationRegistry.get('ds3231')!;
    const cleanup = logic.attachEvents!(makeElement(), sim as any, noPins);
    cleanup();
    expect(sim.unregisterSensor).toHaveBeenCalledWith(304);
  });
});

// ─── ds3231 — AVR / RP2040 path ───────────────────────────────────────────────

describe('ds3231 — AVR/RP2040 path', () => {
  it('adds an I2C device at 0x68 seeded with element.temperature', () => {
    const sim = makeI2CSim();
    const logic = PartSimulationRegistry.get('ds3231')!;
    logic.attachEvents!(makeElement({ temperature: '31.25' }), sim as any, noPins, 'ds3231-avr-1');
    expect(sim.addI2CDevice).toHaveBeenCalledOnce();
    const dev = sim.addI2CDevice.mock.calls[0][0];
    expect(dev.address).toBe(0x68);
    expect(dev.temperatureC).toBeCloseTo(31.25);
  });

  it('SensorControlPanel updates reach the virtual device live', () => {
    const sim = makeI2CSim();
    const logic = PartSimulationRegistry.get('ds3231')!;
    const cleanup = logic.attachEvents!(makeElement(), sim as any, noPins, 'ds3231-avr-2');
    const dev = sim.addI2CDevice.mock.calls[0][0];
    expect(dev.temperatureC).toBeCloseTo(25.0);

    dispatchSensorUpdate('ds3231-avr-2', { temperature: -7.5 });
    expect(dev.temperatureC).toBeCloseTo(-7.5);

    // After cleanup the registry entry is gone — updates no longer land.
    cleanup();
    dispatchSensorUpdate('ds3231-avr-2', { temperature: 60 });
    expect(dev.temperatureC).toBeCloseTo(-7.5);
  });

  it('temperature registers 0x11/0x12 encode integer + quarter-degree fraction', () => {
    const sim = makeI2CSim();
    const logic = PartSimulationRegistry.get('ds3231')!;
    logic.attachEvents!(makeElement({ temperature: '25.75' }), sim as any, noPins, 'ds3231-avr-3');
    const dev = sim.addI2CDevice.mock.calls[0][0];
    // Point at 0x11 and read MSB + LSB like RTClib's getTemperature().
    dev.writeByte(0x11);
    dev.stop();
    expect(dev.readByte()).toBe(25); // integer °C
    expect(dev.readByte()).toBe(0b11 << 6); // 0.75 °C = 3 quarter-steps in bits 7:6
  });
});

// ─── pcf8574 — ESP32 relay path ───────────────────────────────────────────────

describe('pcf8574 — ESP32 relay path', () => {
  it('registers sensor with type pcf8574 and virtual pin 239 (200+0x27)', () => {
    const sim = makeEsp32Sim();
    const logic = PartSimulationRegistry.get('pcf8574')!;
    logic.attachEvents!(makeElement(), sim as any, noPins);
    expect(sim.registerSensor).toHaveBeenCalledWith(
      'pcf8574',
      239,
      expect.objectContaining({ addr: 0x27 }),
    );
  });

  it('adds I2C transaction listener for addr 0x27', () => {
    const sim = makeEsp32Sim();
    const logic = PartSimulationRegistry.get('pcf8574')!;
    logic.attachEvents!(makeElement(), sim as any, noPins);
    expect(sim.addI2CTransactionListener).toHaveBeenCalledWith(0x27, expect.any(Function));
  });

  it('transaction byte is forwarded to VirtualPCF8574 — onWrite fires', () => {
    const el = makeElement();
    const sim = makeEsp32Sim();
    const logic = PartSimulationRegistry.get('pcf8574')!;
    logic.attachEvents!(el, sim as any, noPins);
    // Fire a transaction: MCU wrote byte 0xAB to I2C address 0x27
    sim._fireTransaction(0x27, [0xab]);
    expect((el as any).value).toBe(0xab);
  });

  it('transaction at different address does NOT update element', () => {
    const el = makeElement();
    const sim = makeEsp32Sim();
    const logic = PartSimulationRegistry.get('pcf8574')!;
    logic.attachEvents!(el, sim as any, noPins);
    sim._fireTransaction(0x20, [0xff]); // wrong address
    expect((el as any).value).toBeUndefined();
  });

  it('cleanup calls unregisterSensor(239) and removeI2CTransactionListener(0x27)', () => {
    const sim = makeEsp32Sim();
    const logic = PartSimulationRegistry.get('pcf8574')!;
    const cleanup = logic.attachEvents!(makeElement(), sim as any, noPins);
    cleanup();
    expect(sim.unregisterSensor).toHaveBeenCalledWith(239);
    expect(sim.removeI2CTransactionListener).toHaveBeenCalledWith(0x27);
  });
});

// ─── microSD card — SD-over-SPI storage (Phase 1) ───────────────────────────────
describe('microsd-card — SD-over-SPI storage', () => {
  function setupSD(props: Record<string, unknown> = {}) {
    const sim = makeSPISim();
    const replies: number[] = [];
    sim.spi.completeTransfer = vi.fn((r: number) => replies.push(r));
    const logic = PartSimulationRegistry.get('microsd-card')!;
    const cleanup = logic.attachEvents!(makeElement(props), sim as any, noPins);
    const send = (bytes: number[]) => {
      for (const b of bytes) sim.spi.onByte!(b);
    };
    return { sim, replies, send, cleanup };
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
    // 1-byte Ncr latency: the response is shifted out AFTER the 6 command bytes,
    // so R1 lands on the first 0xFF clock (index 6), not the last command byte.
    const after = (c: number[], extra: number) => {
      replies.length = 0;
      send(c);
      send(FF(extra));
    };
    after(cmd(0), 1);
    expect(replies[6]).toBe(0x01); // idle
    after(cmd(8, 0x1aa), 5);
    expect(replies.slice(6, 11)).toEqual([0x01, 0x00, 0x00, 0x01, 0xaa]); // R7
    after(cmd(55), 1);
    expect(replies[6]).toBe(0x01);
    after(cmd(41), 1);
    expect(replies[6]).toBe(0x00); // ACMD41 ready
    after(cmd(58), 5);
    expect(replies.slice(6, 11)).toEqual([0x00, 0x80, 0xff, 0x80, 0x00]); // OCR (SDSC)
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
});
