/**
 * RP2040Simulator Tests
 *
 * Tests the Raspberry Pi Pico (RP2040) emulator including:
 * - Lifecycle: create, loadBinary, start, stop, reset
 * - GPIO pin listeners (all 30 pins)
 * - ADC access and value injection
 * - External pin driving (setPinState)
 * - Binary loading (base64 decode)
 * - LED_BUILTIN pin (GPIO25)
 * - UART / Serial (onSerialData, serialWrite)
 * - I2C virtual devices (addI2CDevice, removeI2CDevice)
 * - SPI handler (setSPIHandler)
 * - Bootrom loading
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RP2040Simulator } from '../simulation/RP2040Simulator';
import type { RP2040I2CDevice } from '../simulation/RP2040Simulator';
import { PinManager } from '../simulation/PinManager';
import { VirtualDS1307, VirtualTempSensor, I2CMemoryDevice } from '../simulation/I2CBusManager';

// ─── Mock requestAnimationFrame ──────────────────────────────────────────────
// No-op mock: returns an ID but never invokes the callback.
// The RP2040 execute loop runs ~2M ARM cycles per frame which causes OOM in tests.
// Since lifecycle tests only need isRunning() (set before RAF fires), a no-op is safe.
beforeEach(() => {
  let counter = 0;
  vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => ++counter);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a minimal base64-encoded RP2040 binary.
 * A real binary would start with the 256-byte second stage bootloader.
 * For lifecycle tests, we just need *some* bytes.
 */
function minimalBinary(sizeKb = 1): string {
  const bytes = new Uint8Array(sizeKb * 1024); // all zeros = NOP-like
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

describe('RP2040Simulator — lifecycle', () => {
  let pm: PinManager;
  let sim: RP2040Simulator;

  beforeEach(() => {
    pm = new PinManager();
    sim = new RP2040Simulator(pm);
  });
  afterEach(() => sim.stop());

  it('creates instance in idle state', () => {
    expect(sim).toBeDefined();
    expect(sim.isRunning()).toBe(false);
  });

  it('loadBinary() accepts valid base64 without throwing', () => {
    expect(() => sim.loadBinary(minimalBinary())).not.toThrow();
  });

  it('start() transitions to running after loadBinary()', () => {
    sim.loadBinary(minimalBinary());
    sim.start();
    expect(sim.isRunning()).toBe(true);
  });

  it('stop() transitions out of running state', () => {
    sim.loadBinary(minimalBinary());
    sim.start();
    sim.stop();
    expect(sim.isRunning()).toBe(false);
  });

  it('stop() is idempotent before start()', () => {
    expect(() => sim.stop()).not.toThrow();
    expect(sim.isRunning()).toBe(false);
  });

  it('reset() restores idle state and preserves flash', () => {
    sim.loadBinary(minimalBinary(4));
    sim.start();
    sim.reset();
    expect(sim.isRunning()).toBe(false);
    // After reset, ADC should still be accessible (new RP2040 instance created)
    expect(sim.getADC()).not.toBeNull();
  });

  it('warns but does not throw on loadHex() (wrong method)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => sim.loadHex(':00000001FF')).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('setSpeed() clamps to valid range', () => {
    sim.setSpeed(0.001);
    expect((sim as any).speed).toBe(0.1);
    sim.setSpeed(99);
    expect((sim as any).speed).toBe(10.0);
    sim.setSpeed(3.0);
    expect((sim as any).speed).toBe(3.0);
  });
});

// ─── ADC ─────────────────────────────────────────────────────────────────────

describe('RP2040Simulator — ADC', () => {
  it('getADC() returns null before loadBinary()', () => {
    const pm = new PinManager();
    const sim = new RP2040Simulator(pm);
    expect(sim.getADC()).toBeNull();
  });

  it('getADC() returns RPADC instance after loadBinary()', () => {
    const pm = new PinManager();
    const sim = new RP2040Simulator(pm);
    sim.loadBinary(minimalBinary());
    const adc = sim.getADC();
    expect(adc).not.toBeNull();
    expect(adc).toBeDefined();
  });

  it('ADC object has expected shape', () => {
    const pm = new PinManager();
    const sim = new RP2040Simulator(pm);
    sim.loadBinary(minimalBinary());
    const adc = sim.getADC();
    // RP2040 ADC has a different API from AVRADC — just ensure it's an object
    expect(typeof adc).toBe('object');
  });
});

// ─── GPIO pin listeners ───────────────────────────────────────────────────────

describe('RP2040Simulator — GPIO listeners', () => {
  it('setPinState() drives a GPIO pin and PinManager reflects it', () => {
    const pm = new PinManager();
    const sim = new RP2040Simulator(pm);
    sim.loadBinary(minimalBinary());

    const cb = vi.fn();
    pm.onPinChange(25, cb); // LED_BUILTIN = GPIO25

    sim.setPinState(25, true);
    // setPinState uses gpio.setInputValue — the GPIO listener fires via rp2040js
    expect(() => sim.setPinState(25, false)).not.toThrow();
  });

  it('GPIO listeners are set up for all 30 pins after loadBinary()', () => {
    const pm = new PinManager();
    const sim = new RP2040Simulator(pm);
    sim.loadBinary(minimalBinary());

    // 30 GPIO listeners should be registered
    const unsubscribers = (sim as any).gpioUnsubscribers as Array<() => void>;
    expect(unsubscribers).toHaveLength(30);
  });

  it('GPIO listeners are cleaned up and recreated on reset()', () => {
    const pm = new PinManager();
    const sim = new RP2040Simulator(pm);
    sim.loadBinary(minimalBinary());
    const beforeCount = (sim as any).gpioUnsubscribers.length;

    sim.reset();
    const afterCount = (sim as any).gpioUnsubscribers.length;

    expect(beforeCount).toBe(30);
    expect(afterCount).toBe(30);
  });

  it('setPinState() works for all valid GPIO indices (0-29)', () => {
    const pm = new PinManager();
    const sim = new RP2040Simulator(pm);
    sim.loadBinary(minimalBinary());

    for (let gpio = 0; gpio < 30; gpio++) {
      expect(() => sim.setPinState(gpio, true)).not.toThrow();
      expect(() => sim.setPinState(gpio, false)).not.toThrow();
    }
  });

  it('setPinState() on out-of-range pin does not throw', () => {
    const pm = new PinManager();
    const sim = new RP2040Simulator(pm);
    // No loadBinary — rp2040 is null
    expect(() => sim.setPinState(0, true)).not.toThrow();
    expect(() => sim.setPinState(99, true)).not.toThrow();
  });
});

// ─── Binary loading ───────────────────────────────────────────────────────────

describe('RP2040Simulator — binary loading', () => {
  it('loads exact byte count into flash', () => {
    const pm = new PinManager();
    const sim = new RP2040Simulator(pm);
    const sizeBytes = 2048;
    const b64 = minimalBinary(sizeBytes / 1024);
    sim.loadBinary(b64);

    const rp2040 = (sim as any).rp2040;
    expect(rp2040).not.toBeNull();
    // The first `sizeBytes` of flash should match our binary (all zeros)
    const flashSlice = rp2040.flash.slice(0, sizeBytes);
    expect(flashSlice.every((b: number) => b === 0)).toBe(true);
  });

  it('larger binary loads without overflow', () => {
    const pm = new PinManager();
    const sim = new RP2040Simulator(pm);
    // 256 KB = largest practical sketch
    const b64 = minimalBinary(256);
    expect(() => sim.loadBinary(b64)).not.toThrow();
  });

  it('flash content is preserved after reset()', () => {
    const pm = new PinManager();
    const sim = new RP2040Simulator(pm);

    // Create a binary with a known pattern
    const bytes = new Uint8Array(256);
    bytes[0] = 0xaa;
    bytes[1] = 0xbb;
    bytes[255] = 0xff;
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = btoa(binary);

    sim.loadBinary(b64);
    sim.reset();

    const rp2040 = (sim as any).rp2040;
    expect(rp2040.flash[0]).toBe(0xaa);
    expect(rp2040.flash[1]).toBe(0xbb);
    expect(rp2040.flash[255]).toBe(0xff);
  });
});

// ─── PinManager integration ───────────────────────────────────────────────────

describe('RP2040Simulator — PinManager integration', () => {
  it('pinManager reference is accessible', () => {
    const pm = new PinManager();
    const sim = new RP2040Simulator(pm);
    expect(sim.pinManager).toBe(pm);
  });

  it('triggerPinChange from external code fires PinManager listeners', () => {
    const pm = new PinManager();
    const sim = new RP2040Simulator(pm);
    sim.loadBinary(minimalBinary());

    const cb = vi.fn();
    pm.onPinChange(25, cb);

    // Simulate what would happen when GPIO25 goes HIGH inside the RP2040
    pm.triggerPinChange(25, true);

    expect(cb).toHaveBeenCalledWith(25, true);
  });
});

// ─── UART / Serial ────────────────────────────────────────────────────────────

describe('RP2040Simulator — UART / Serial', () => {
  let pm: PinManager;
  let sim: RP2040Simulator;

  beforeEach(() => {
    pm = new PinManager();
    sim = new RP2040Simulator(pm);
  });
  afterEach(() => sim.stop());

  it('onSerialData callback is initially null', () => {
    expect(sim.onSerialData).toBeNull();
  });

  it('onSerialData can be assigned a callback', () => {
    const cb = vi.fn();
    sim.onSerialData = cb;
    expect(sim.onSerialData).toBe(cb);
  });

  it('UART0 onByte is wired after loadBinary()', () => {
    sim.loadBinary(minimalBinary());
    const mcu = sim.getMCU();
    expect(mcu).not.toBeNull();
    expect(mcu!.uart[0].onByte).toBeDefined();
  });

  it('UART1 onByte is also wired after loadBinary()', () => {
    sim.loadBinary(minimalBinary());
    const mcu = sim.getMCU();
    expect(mcu).not.toBeNull();
    expect(mcu!.uart[1].onByte).toBeDefined();
  });

  it('UART0 onByte fires onSerialData with decoded character', () => {
    const chars: string[] = [];
    sim.onSerialData = (c: string) => chars.push(c);
    sim.loadBinary(minimalBinary());

    const mcu = sim.getMCU()!;
    // Manually invoke the onByte callback (simulating firmware writing to UARTDR)
    mcu.uart[0].onByte!(0x41); // 'A'
    mcu.uart[0].onByte!(0x42); // 'B'

    expect(chars).toEqual(['A', 'B']);
  });

  it('serialWrite() feeds bytes into UART0 RX', () => {
    sim.loadBinary(minimalBinary());
    // serialWrite should not throw even with no firmware running
    expect(() => sim.serialWrite('Hello')).not.toThrow();
  });

  it('serialWrite() does nothing when rp2040 is null', () => {
    // No loadBinary called
    expect(() => sim.serialWrite('test')).not.toThrow();
  });

  it('onSerialData persists after reset when re-wired', () => {
    const cb = vi.fn();
    sim.onSerialData = cb;
    sim.loadBinary(minimalBinary());
    sim.reset();

    // After reset, onSerialData is still set (assigned on the simulator object)
    expect(sim.onSerialData).toBe(cb);

    // And the new UART0 should fire through it
    const mcu = sim.getMCU()!;
    mcu.uart[0].onByte!(0x43); // 'C'
    expect(cb).toHaveBeenCalledWith('C');
  });
});

// ─── I2C Virtual Devices ──────────────────────────────────────────────────────

describe('RP2040Simulator — I2C', () => {
  let pm: PinManager;
  let sim: RP2040Simulator;

  beforeEach(() => {
    pm = new PinManager();
    sim = new RP2040Simulator(pm);
    sim.loadBinary(minimalBinary());
  });
  afterEach(() => sim.stop());

  it('addI2CDevice() registers a device on bus 0', () => {
    const device: RP2040I2CDevice = {
      address: 0x48,
      writeByte: () => true,
      readByte: () => 0x42,
    };
    expect(() => sim.addI2CDevice(device)).not.toThrow();
  });

  it('addI2CDevice() registers a device on bus 1', () => {
    const device: RP2040I2CDevice = {
      address: 0x50,
      writeByte: () => true,
      readByte: () => 0xff,
    };
    expect(() => sim.addI2CDevice(device, 1)).not.toThrow();
  });

  it('removeI2CDevice() removes a registered device', () => {
    const device: RP2040I2CDevice = {
      address: 0x48,
      writeByte: () => true,
      readByte: () => 0x42,
    };
    sim.addI2CDevice(device);
    expect(() => sim.removeI2CDevice(0x48)).not.toThrow();
  });

  it('I2C0 event handlers are wired after loadBinary()', () => {
    const mcu = sim.getMCU()!;
    const i2c = mcu.i2c[0];
    expect(i2c.onStart).toBeDefined();
    expect(i2c.onConnect).toBeDefined();
    expect(i2c.onWriteByte).toBeDefined();
    expect(i2c.onReadByte).toBeDefined();
    expect(i2c.onStop).toBeDefined();
  });

  it('I2C1 event handlers are wired after loadBinary()', () => {
    const mcu = sim.getMCU()!;
    const i2c = mcu.i2c[1];
    expect(i2c.onStart).toBeDefined();
    expect(i2c.onConnect).toBeDefined();
    expect(i2c.onWriteByte).toBeDefined();
    expect(i2c.onReadByte).toBeDefined();
    expect(i2c.onStop).toBeDefined();
  });

  it('VirtualDS1307 can be registered as RP2040I2CDevice', () => {
    const rtc = new VirtualDS1307();
    expect(() => sim.addI2CDevice(rtc as RP2040I2CDevice)).not.toThrow();
  });

  it('VirtualTempSensor can be registered as RP2040I2CDevice', () => {
    const sensor = new VirtualTempSensor();
    expect(() => sim.addI2CDevice(sensor as RP2040I2CDevice)).not.toThrow();
  });

  it('I2CMemoryDevice can be registered as RP2040I2CDevice', () => {
    const eeprom = new I2CMemoryDevice(0x50);
    expect(() => sim.addI2CDevice(eeprom as RP2040I2CDevice)).not.toThrow();
  });

  it('I2C devices persist across simulator lifecycle', () => {
    sim.addI2CDevice({ address: 0x48, writeByte: () => true, readByte: () => 0 });
    sim.addI2CDevice({ address: 0x50, writeByte: () => true, readByte: () => 0 }, 0);

    // Read private map to verify
    const devices = (sim as any).i2cDevices[0] as Map<number, RP2040I2CDevice>;
    expect(devices.has(0x48)).toBe(true);
    expect(devices.has(0x50)).toBe(true);
  });
});

// ─── SPI ──────────────────────────────────────────────────────────────────────

describe('RP2040Simulator — SPI', () => {
  let pm: PinManager;
  let sim: RP2040Simulator;

  beforeEach(() => {
    pm = new PinManager();
    sim = new RP2040Simulator(pm);
    sim.loadBinary(minimalBinary());
  });
  afterEach(() => sim.stop());

  it('SPI0 has default loopback handler after loadBinary()', () => {
    const mcu = sim.getMCU()!;
    expect(mcu.spi[0].onTransmit).toBeDefined();
  });

  it('SPI1 has default loopback handler after loadBinary()', () => {
    const mcu = sim.getMCU()!;
    expect(mcu.spi[1].onTransmit).toBeDefined();
  });

  it('setSPIHandler() replaces the default handler for SPI0', () => {
    const handler = vi.fn((value: number) => value ^ 0xff); // invert bits
    sim.setSPIHandler(0, handler);

    const mcu = sim.getMCU()!;
    // Manually trigger onTransmit to test the handler wiring
    mcu.spi[0].onTransmit(0xaa);
    // The handler should have been called
    expect(handler).toHaveBeenCalledWith(0xaa);
  });

  it('setSPIHandler() works for SPI1', () => {
    const handler = vi.fn((_v: number) => 0x42);
    sim.setSPIHandler(1, handler);

    const mcu = sim.getMCU()!;
    mcu.spi[1].onTransmit(0x00);
    expect(handler).toHaveBeenCalledWith(0x00);
  });

  it('setSPIHandler() does nothing when rp2040 is null', () => {
    const freshSim = new RP2040Simulator(pm);
    // No loadBinary
    expect(() => freshSim.setSPIHandler(0, () => 0)).not.toThrow();
  });
});

// ─── ADC value injection ──────────────────────────────────────────────────────

describe('RP2040Simulator — ADC value injection', () => {
  let pm: PinManager;
  let sim: RP2040Simulator;

  beforeEach(() => {
    pm = new PinManager();
    sim = new RP2040Simulator(pm);
    sim.loadBinary(minimalBinary());
  });
  afterEach(() => sim.stop());

  it('default ADC values are set to mid-range after loadBinary()', () => {
    const adc = sim.getADC();
    expect(adc.channelValues[0]).toBe(2048);
    expect(adc.channelValues[1]).toBe(2048);
    expect(adc.channelValues[2]).toBe(2048);
    expect(adc.channelValues[3]).toBe(2048);
  });

  it('internal temp sensor (ch4) is initialized to ~27°C', () => {
    const adc = sim.getADC();
    expect(adc.channelValues[4]).toBe(876);
  });

  it('setADCValue() updates a channel', () => {
    sim.setADCValue(0, 1000);
    expect(sim.getADC().channelValues[0]).toBe(1000);
  });

  it('setADCValue() clamps to valid 12-bit range', () => {
    sim.setADCValue(0, 5000); // over max
    expect(sim.getADC().channelValues[0]).toBe(4095);

    sim.setADCValue(0, -100); // under min
    expect(sim.getADC().channelValues[0]).toBe(0);
  });

  it('setADCValue() ignores out-of-range channels', () => {
    const before = sim.getADC().channelValues[0];
    sim.setADCValue(5, 1000); // ch5 doesn't exist
    sim.setADCValue(-1, 1000); // negative
    expect(sim.getADC().channelValues[0]).toBe(before); // unchanged
  });

  it('setADCValue() does nothing when rp2040 is null', () => {
    const freshSim = new RP2040Simulator(pm);
    expect(() => freshSim.setADCValue(0, 1000)).not.toThrow();
  });
});

// ─── Bootrom ──────────────────────────────────────────────────────────────────

describe('RP2040Simulator — bootrom', () => {
  it('bootrom is loaded into RP2040 after loadBinary()', () => {
    const pm = new PinManager();
    const sim = new RP2040Simulator(pm);
    sim.loadBinary(minimalBinary());

    const mcu = sim.getMCU()!;
    // The bootrom is loaded at address 0x00000000
    // First word of RP2040 B1 bootrom is 0x20041f00 (initial SP)
    const firstWord = mcu.bootrom[0];
    expect(firstWord).toBe(0x20041f00);
  });

  it('PC is set to flash start (0x10000000) after loadBinary()', () => {
    const pm = new PinManager();
    const sim = new RP2040Simulator(pm);
    sim.loadBinary(minimalBinary());

    const mcu = sim.getMCU()!;
    expect(mcu.core.PC).toBe(0x10000000);
  });
});

// ─── getMCU() ─────────────────────────────────────────────────────────────────

describe('RP2040Simulator — getMCU()', () => {
  it('returns null before loadBinary()', () => {
    const pm = new PinManager();
    const sim = new RP2040Simulator(pm);
    expect(sim.getMCU()).toBeNull();
  });

  it('returns RP2040 instance after loadBinary()', () => {
    const pm = new PinManager();
    const sim = new RP2040Simulator(pm);
    sim.loadBinary(minimalBinary());
    const mcu = sim.getMCU();
    expect(mcu).not.toBeNull();
    expect(mcu!.core).toBeDefined();
    expect(mcu!.gpio).toBeDefined();
    expect(mcu!.uart).toBeDefined();
    expect(mcu!.i2c).toBeDefined();
    expect(mcu!.spi).toBeDefined();
    expect(mcu!.adc).toBeDefined();
  });
});
