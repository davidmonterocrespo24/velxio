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
 *   ir-receiver   — click → NEC pulse on OUT pin
 *   ir-remote     — button-press → ir-signal event
 *   microsd-card  — SPI SD init handshake
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// Barrel import seeds built-in parts via `registerCoreParts()` (CORE-002c-step2).
import { PartSimulationRegistry } from '../simulation/parts';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';

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
    onTransmit: null as ((b: number) => void) | null,
    completeTransmit: vi.fn(),
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

describe('dht22 — single-wire sensor', () => {
  it('sets DATA pin HIGH (idle) on attach', () => {
    const sim = makePinSim();
    const logic = PartSimulationRegistry.get('dht22')!;
    logic.attachEvents!(makeElement(), sim as any, pinMap({ DATA: 7 }));
    expect(sim.setPinState).toHaveBeenCalledWith(7, true);
  });

  it('registers onPinChange for DATA pin', () => {
    const sim = makePinSim();
    const logic = PartSimulationRegistry.get('dht22')!;
    logic.attachEvents!(makeElement(), sim as any, pinMap({ DATA: 7 }));
    expect(sim.pinManager.onPinChange).toHaveBeenCalledWith(7, expect.any(Function));
  });

  it('drives DATA in response after LOW → HIGH start sequence', () => {
    const sim = makePinSim();
    const logic = PartSimulationRegistry.get('dht22')!;
    logic.attachEvents!(
      makeElement({ temperature: 25.0, humidity: 50.0 }),
      sim as any,
      pinMap({ DATA: 7 }),
    );

    const cb = sim.pinManager.onPinChange.mock.calls[0][1] as (pin: number, state: boolean) => void;
    sim.setPinState.mockClear();

    cb(7, false); // MCU pulls DATA LOW  (start signal)
    cb(7, true); // MCU releases DATA HIGH → DHT22 should begin response

    // Response should include at least one LOW pulse
    const calls = (sim.setPinState as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([, s]) => s === false)).toBe(true);
  });

  it('no-op if DATA pin not found', () => {
    const sim = makePinSim();
    const logic = PartSimulationRegistry.get('dht22')!;
    expect(() => {
      const c = logic.attachEvents!(makeElement(), sim as any, noPins);
      c();
    }).not.toThrow();
    expect(sim.pinManager.onPinChange).not.toHaveBeenCalled();
  });

  it('cleanup drives DATA HIGH', () => {
    const sim = makePinSim();
    const logic = PartSimulationRegistry.get('dht22')!;
    const cleanup = logic.attachEvents!(makeElement(), sim as any, pinMap({ DATA: 7 }));
    sim.setPinState.mockClear();
    cleanup();
    expect(sim.setPinState).toHaveBeenCalledWith(7, true);
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

// ─── ir-receiver ─────────────────────────────────────────────────────────────

describe('ir-receiver — NEC click simulation', () => {
  it('sets OUT pin HIGH (idle) on attach', () => {
    const sim = makePinSim();
    const logic = PartSimulationRegistry.get('ir-receiver')!;
    logic.attachEvents!(makeElement(), sim as any, pinMap({ OUT: 5 }));
    expect(sim.setPinState).toHaveBeenCalledWith(5, true);
  });

  it('registers a click listener on the element', () => {
    const sim = makePinSim();
    const el = makeElement();
    const logic = PartSimulationRegistry.get('ir-receiver')!;
    logic.attachEvents!(el, sim as any, pinMap({ OUT: 5 }));
    expect(el.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));
  });

  it('click drives OUT LOW (IR burst start) and later HIGH via setTimeout', () => {
    const sim = makePinSim();
    const el = makeElement();
    const logic = PartSimulationRegistry.get('ir-receiver')!;
    logic.attachEvents!(el, sim as any, pinMap({ OUT: 5 }));

    const clickCb = (el.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      ([event]) => event === 'click',
    )?.[1] as (() => void) | undefined;
    expect(clickCb).toBeDefined();

    sim.setPinState.mockClear();
    clickCb!();

    // First call should drive pin LOW (beginning of 9 ms preamble burst)
    const firstLow = (sim.setPinState as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(firstLow).toEqual([5, false]);
  });

  it('NEC sequence produces more than 60 setPinState calls (35+ transitions)', () => {
    const sim = makePinSim();
    const el = makeElement();
    const logic = PartSimulationRegistry.get('ir-receiver')!;
    logic.attachEvents!(el, sim as any, pinMap({ OUT: 5 }));

    const clickCb = (el.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      ([ev]) => ev === 'click',
    )?.[1] as () => void;

    sim.setPinState.mockClear();
    clickCb();
    // Run all queued timeouts to exhaust the chain
    vi.runAllTimers();

    expect((sim.setPinState as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(60);
  });

  it('cleanup removes click listener and sets pin HIGH', () => {
    const sim = makePinSim();
    const el = makeElement();
    const logic = PartSimulationRegistry.get('ir-receiver')!;
    const cleanup = logic.attachEvents!(el, sim as any, pinMap({ OUT: 5 }));
    sim.setPinState.mockClear();
    cleanup();
    expect(el.removeEventListener).toHaveBeenCalledWith('click', expect.any(Function));
    expect(sim.setPinState).toHaveBeenCalledWith(5, true);
  });

  it('no-op when no pin connected (no throw)', () => {
    const sim = makePinSim();
    const logic = PartSimulationRegistry.get('ir-receiver')!;
    expect(() => {
      const c = logic.attachEvents!(makeElement(), sim as any, noPins);
      c();
    }).not.toThrow();
  });
});

// ─── ir-remote ───────────────────────────────────────────────────────────────

describe('ir-remote — button dispatch', () => {
  it('registers button-press listener on element', () => {
    const sim = makePinSim();
    const el = makeElement();
    const logic = PartSimulationRegistry.get('ir-remote')!;
    logic.attachEvents!(el, sim as any, noPins);
    const events = (el.addEventListener as ReturnType<typeof vi.fn>).mock.calls.map(([e]) => e);
    expect(events).toContain('button-press');
  });

  it('button-press fires ir-signal CustomEvent with address and command', () => {
    const sim = makePinSim();
    const el = makeElement();
    const logic = PartSimulationRegistry.get('ir-remote')!;
    logic.attachEvents!(el, sim as any, noPins);

    const onButtonPress = (el.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      ([ev]) => ev === 'button-press',
    )?.[1] as ((e: Event) => void) | undefined;
    expect(onButtonPress).toBeDefined();

    const fakeEvent = new CustomEvent('button-press', { detail: { key: 'power' } });
    onButtonPress!(fakeEvent);

    expect(el.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'ir-signal' }));
    const dispatched = (el.dispatchEvent as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as CustomEvent;
    expect(dispatched.detail.command).toBe(0x45); // POWER key
  });

  it('drives IR pin if connected', () => {
    const sim = makePinSim();
    const el = makeElement();
    const logic = PartSimulationRegistry.get('ir-remote')!;
    logic.attachEvents!(el, sim as any, pinMap({ IR: 4 }));

    const onButtonPress = (el.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      ([ev]) => ev === 'button-press',
    )?.[1] as (e: Event) => void;

    sim.setPinState.mockClear();
    onButtonPress(new CustomEvent('button-press', { detail: { key: 'power' } }));

    // Should start the NEC pulse sequence (first edge LOW)
    expect(sim.setPinState).toHaveBeenCalledWith(4, false);
  });

  it('cleanup removes all listeners', () => {
    const sim = makePinSim();
    const el = makeElement();
    const logic = PartSimulationRegistry.get('ir-remote')!;
    const cleanup = logic.attachEvents!(el, sim as any, noPins);
    cleanup();
    expect(el.removeEventListener).toHaveBeenCalledTimes(2);
  });
});

// ─── microsd-card ─────────────────────────────────────────────────────────────

describe('microsd-card — SPI init handshake', () => {
  it('hooks into simulator.spi.onTransmit', () => {
    const sim = makeSPISim();
    const logic = PartSimulationRegistry.get('microsd-card')!;
    logic.attachEvents!(makeElement(), sim as any, noPins);
    expect(sim.spi.onTransmit).toBeTypeOf('function');
  });

  it('CMD0 (0x40 + 4 zeroes + CRC) returns R1=0x01 (idle)', () => {
    const sim = makeSPISim();
    const logic = PartSimulationRegistry.get('microsd-card')!;
    logic.attachEvents!(makeElement(), sim as any, noPins);

    const tx = sim.spi.onTransmit as (b: number) => void;
    // Send CMD0: [0x40, 0x00, 0x00, 0x00, 0x00, 0x95]
    [0x40, 0x00, 0x00, 0x00, 0x00, 0x95].forEach((b) => tx(b));
    // Poll with 0xFF to receive response
    tx(0xff);
    const replies = (sim.spi.completeTransmit as ReturnType<typeof vi.fn>).mock.calls.map(
      ([v]) => v,
    );
    expect(replies).toContain(0x01);
  });

  it('CMD8 returns R7 with echo-back 0x1AA', () => {
    const sim = makeSPISim();
    const logic = PartSimulationRegistry.get('microsd-card')!;
    logic.attachEvents!(makeElement(), sim as any, noPins);

    const tx = sim.spi.onTransmit as (b: number) => void;
    // CMD8: [0x48, 0x00, 0x00, 0x01, 0xAA, 0x87]
    [0x48, 0x00, 0x00, 0x01, 0xaa, 0x87].forEach((b) => tx(b));
    // Read 5 bytes of R7 response
    for (let i = 0; i < 5; i++) tx(0xff);
    const replies = (sim.spi.completeTransmit as ReturnType<typeof vi.fn>).mock.calls.map(
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

    const tx = sim.spi.onTransmit as (b: number) => void;
    [0x77, 0x00, 0x00, 0x00, 0x00, 0x65].forEach((b) => tx(b)); // CMD55
    tx(0xff); // poll
    sim.spi.completeTransmit.mockClear();
    [0x69, 0x40, 0x00, 0x00, 0x00, 0x77].forEach((b) => tx(b)); // ACMD41
    tx(0xff);
    const replies = (sim.spi.completeTransmit as ReturnType<typeof vi.fn>).mock.calls.map(
      ([v]) => v,
    );
    expect(replies).toContain(0x00);
  });

  it('0xFF clock bytes return 0xFF (idle) when no pending response', () => {
    const sim = makeSPISim();
    const logic = PartSimulationRegistry.get('microsd-card')!;
    logic.attachEvents!(makeElement(), sim as any, noPins);

    const tx = sim.spi.onTransmit as (b: number) => void;
    tx(0xff);
    expect(sim.spi.completeTransmit).toHaveBeenLastCalledWith(0xff);
  });

  it('cleanup restores previous onTransmit and is callable without SPI', () => {
    const sim = makeSPISim();
    const logic = PartSimulationRegistry.get('microsd-card')!;
    const cleanup = logic.attachEvents!(makeElement(), sim as any, noPins);
    expect(() => cleanup()).not.toThrow();
    expect(sim.spi.onTransmit).toBeNull();
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
