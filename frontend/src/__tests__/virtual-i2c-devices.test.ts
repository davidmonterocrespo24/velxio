/**
 * virtual-i2c-devices.test.ts
 *
 * Unit tests for the virtual I2C sensor library:
 *   VirtualBMP280   — barometric pressure / temperature sensor (0x76 / 0x77)
 *   VirtualDS3231   — real-time clock with on-chip temperature sensor (0x68)
 *   VirtualPCF8574  — 8-bit I/O expander (0x20–0x27 / 0x38–0x3F)
 *
 * Also covers the I2CBusManager routing (connectToSlave / writeByte / readByte)
 * and the pre-existing VirtualDS1307, VirtualTempSensor, I2CMemoryDevice helpers.
 *
 * NOTE: these tests import directly from I2CBusManager.ts which only uses
 * `import type` from avr8js — so they run in the plain Node / Vitest environment
 * without needing the wokwi-libs to be built.
 */

import { describe, it, expect } from 'vitest';
import {
  I2CBusManager,
  I2CMemoryDevice,
  VirtualDS1307,
  VirtualTempSensor,
  VirtualBMP280,
  VirtualDS3231,
  VirtualPCF8574,
} from '../simulation/I2CBusManager';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal mock of AVRTWI used by I2CBusManager */
function makeTWI() {
  const calls: string[] = [];
  let readResult = 0xff;
  let writeAck = true;
  let connectAck = true;

  return {
    calls,
    _setReadResult: (v: number) => {
      readResult = v;
    },
    _setWriteAck: (v: boolean) => {
      writeAck = v;
    },
    _setConnectAck: (v: boolean) => {
      connectAck = v;
    },

    // --- AVRTWI API ---
    set eventHandler(_: any) {
      /* set by I2CBusManager constructor */
    },
    completeStart() {
      calls.push('start');
    },
    completeStop() {
      calls.push('stop');
    },
    completeConnect(ack: boolean) {
      calls.push(`connect:${ack}`);
    },
    completeWrite(ack: boolean) {
      calls.push(`write:${ack}`);
    },
    completeRead(value: number) {
      calls.push(`read:${value}`);
    },
  };
}

// ─── I2CBusManager routing ────────────────────────────────────────────────────

describe('I2CBusManager — routing', () => {
  it('completes start unconditionally', () => {
    const twi = makeTWI();
    const bus = new I2CBusManager(twi as any);
    bus.start(false);
    expect(twi.calls).toContain('start');
  });

  it('NACKs an address with no registered device', () => {
    const twi = makeTWI();
    const bus = new I2CBusManager(twi as any);
    bus.connectToSlave(0x42, true);
    expect(twi.calls).toContain('connect:false');
  });

  it('ACKs when a device is registered at the address', () => {
    const twi = makeTWI();
    const bus = new I2CBusManager(twi as any);
    bus.addDevice(new I2CMemoryDevice(0x42));
    bus.connectToSlave(0x42, true);
    expect(twi.calls).toContain('connect:true');
  });

  it('routes writeByte to active device and returns ACK', () => {
    const twi = makeTWI();
    const bus = new I2CBusManager(twi as any);
    const device = new I2CMemoryDevice(0x50);
    bus.addDevice(device);
    bus.connectToSlave(0x50, true);
    bus.writeByte(0x10); // set register pointer
    expect(twi.calls).toContain('write:true');
  });

  it('routes readByte to active device', () => {
    const twi = makeTWI();
    const bus = new I2CBusManager(twi as any);
    const device = new I2CMemoryDevice(0x50);
    device.registers[0x00] = 0xab;
    bus.addDevice(device);
    bus.connectToSlave(0x50, true);
    bus.writeByte(0x00); // set register pointer to 0
    bus.connectToSlave(0x50, false); // repeated start, read mode
    bus.readByte(true);
    const readCall = twi.calls.find((c) => c.startsWith('read:'));
    expect(readCall).toBe('read:171'); // 0xAB = 171
  });

  it('returns 0xFF on read when no device at address', () => {
    const twi = makeTWI();
    const bus = new I2CBusManager(twi as any);
    bus.readByte(true);
    expect(twi.calls).toContain('read:255');
  });

  it('NACKs write when no active device', () => {
    const twi = makeTWI();
    const bus = new I2CBusManager(twi as any);
    bus.writeByte(0x00);
    expect(twi.calls).toContain('write:false');
  });

  it('removeDevice stops routing to that address', () => {
    const twi = makeTWI();
    const bus = new I2CBusManager(twi as any);
    bus.addDevice(new I2CMemoryDevice(0x42));
    bus.removeDevice(0x42);
    bus.connectToSlave(0x42, true);
    expect(twi.calls).toContain('connect:false');
  });

  it('calls device.stop() on stop condition', () => {
    const twi = makeTWI();
    const bus = new I2CBusManager(twi as any);
    let stopped = false;
    const device: any = {
      address: 0x42,
      writeByte: () => true,
      readByte: () => 0,
      stop: () => {
        stopped = true;
      },
    };
    bus.addDevice(device);
    bus.connectToSlave(0x42, true);
    bus.stop();
    expect(stopped).toBe(true);
    expect(twi.calls).toContain('stop');
  });
});

// ─── I2CMemoryDevice ─────────────────────────────────────────────────────────

describe('I2CMemoryDevice', () => {
  it('first byte sets register pointer, subsequent bytes write data', () => {
    const dev = new I2CMemoryDevice(0x50);
    dev.writeByte(0x05); // register pointer
    dev.writeByte(0xab); // write data to register 5
    expect(dev.registers[0x05]).toBe(0xab);
  });

  it('reads back written data starting at register pointer', () => {
    const dev = new I2CMemoryDevice(0x50);
    dev.registers[0x02] = 0xcc;
    dev.writeByte(0x02); // set pointer
    expect(dev.readByte()).toBe(0xcc);
  });

  it('auto-increments register pointer on read', () => {
    const dev = new I2CMemoryDevice(0x50);
    dev.registers[0x00] = 0x11;
    dev.registers[0x01] = 0x22;
    dev.writeByte(0x00);
    expect(dev.readByte()).toBe(0x11);
    expect(dev.readByte()).toBe(0x22);
  });

  it('fires onRegisterWrite callback', () => {
    const dev = new I2CMemoryDevice(0x50);
    const log: [number, number][] = [];
    dev.onRegisterWrite = (r, v) => log.push([r, v]);
    dev.writeByte(0x0a); // pointer
    dev.writeByte(0xff); // data → register 0x0A
    expect(log).toEqual([[0x0a, 0xff]]);
  });

  it('resets firstByte on stop()', () => {
    const dev = new I2CMemoryDevice(0x50);
    dev.writeByte(0x03); // pointer set, firstByte = false
    dev.stop(); // reset
    dev.writeByte(0x07); // new pointer
    dev.writeByte(0x55); // write to register 7
    expect(dev.registers[0x07]).toBe(0x55);
  });
});

// ─── VirtualDS1307 ────────────────────────────────────────────────────────────

describe('VirtualDS1307', () => {
  it('address is 0x68', () => {
    expect(new VirtualDS1307().address).toBe(0x68);
  });

  it('readByte for reg 0 returns valid BCD seconds (0–59)', () => {
    const dev = new VirtualDS1307();
    dev.writeByte(0x00); // set pointer to seconds
    const raw = dev.readByte();
    const tens = (raw >> 4) & 0xf;
    const units = raw & 0xf;
    expect(tens).toBeLessThanOrEqual(5);
    expect(units).toBeLessThanOrEqual(9);
  });

  it('reads 7 consecutive BCD time registers', () => {
    const dev = new VirtualDS1307();
    dev.writeByte(0x00); // start at seconds
    for (let i = 0; i < 7; i++) {
      const byte = dev.readByte();
      expect(byte).toBeGreaterThanOrEqual(0x00);
      expect(byte).toBeLessThanOrEqual(0x99);
    }
  });

  it('stop() resets firstByte so next write is a new pointer', () => {
    const dev = new VirtualDS1307();
    dev.writeByte(0x02); // set pointer to hours
    dev.stop();
    dev.writeByte(0x00); // new pointer (seconds)
    const raw = dev.readByte();
    // raw should be seconds BCD (tens ≤ 5)
    expect((raw >> 4) & 0xf).toBeLessThanOrEqual(5);
  });
});

// ─── VirtualTempSensor ────────────────────────────────────────────────────────

describe('VirtualTempSensor', () => {
  it('address is 0x48', () => {
    expect(new VirtualTempSensor().address).toBe(0x48);
  });

  it('reads temperature high byte (register 0) correctly', () => {
    const dev = new VirtualTempSensor();
    dev.temperature = 2350; // 23.50°C
    dev.writeByte(0x00);
    expect(dev.readByte()).toBe((2350 >> 8) & 0xff);
  });

  it('reads humidity bytes from registers 2–3', () => {
    const dev = new VirtualTempSensor();
    dev.humidity = 5500; // 55.00%
    dev.writeByte(0x02);
    expect(dev.readByte()).toBe((5500 >> 8) & 0xff);
    expect(dev.readByte()).toBe(5500 & 0xff);
  });
});

// ─── VirtualBMP280 ────────────────────────────────────────────────────────────

describe('VirtualBMP280 — construction & addresses', () => {
  it('default address is 0x76', () => {
    expect(new VirtualBMP280().address).toBe(0x76);
  });

  it('accepts 0x77 as alternate address', () => {
    expect(new VirtualBMP280(0x77).address).toBe(0x77);
  });

  it('chip_id register (0xD0) reads 0x58', () => {
    const dev = new VirtualBMP280();
    dev.writeByte(0xd0);
    expect(dev.readByte()).toBe(0x58);
  });

  it('stop() resets firstByte so register pointer can be re-set', () => {
    const dev = new VirtualBMP280();
    dev.writeByte(0xd0);
    dev.stop();
    dev.writeByte(0xf3); // new pointer → status register
    expect(dev.readByte()).toBe(0x00); // status = 0 (ready)
  });
});

describe('VirtualBMP280 — calibration registers', () => {
  /**
   * Reads an unsigned 16-bit little-endian value from two consecutive register
   * bytes starting at `regAddr`.
   */
  function readU16LE(dev: VirtualBMP280, regAddr: number): number {
    dev.writeByte(regAddr);
    const lo = dev.readByte();
    const hi = dev.readByte();
    dev.stop();
    return lo | (hi << 8);
  }

  function readS16LE(dev: VirtualBMP280, regAddr: number): number {
    const u = readU16LE(dev, regAddr);
    return u > 0x7fff ? u - 0x10000 : u;
  }

  it('dig_T1 (0x88) equals 27504', () => {
    const dev = new VirtualBMP280();
    expect(readU16LE(dev, 0x88)).toBe(27504);
  });

  it('dig_T2 (0x8A) equals 26435', () => {
    expect(readS16LE(new VirtualBMP280(), 0x8a)).toBe(26435);
  });

  it('dig_T3 (0x8C) equals -1000', () => {
    expect(readS16LE(new VirtualBMP280(), 0x8c)).toBe(-1000);
  });

  it('dig_P1 (0x8E) equals 36477', () => {
    expect(readU16LE(new VirtualBMP280(), 0x8e)).toBe(36477);
  });

  it('dig_P2 (0x90) equals -10685', () => {
    expect(readS16LE(new VirtualBMP280(), 0x90)).toBe(-10685);
  });
});

describe('VirtualBMP280 — temperature compensation', () => {
  /**
   * Reads the 6-byte pressure+temperature burst (0xF7–0xFC) and reconstructs
   * the two 20-bit raw ADC values.  Returns { adcP, adcT }.
   */
  function readRawAdc(dev: VirtualBMP280): { adcP: number; adcT: number } {
    dev.writeByte(0xf7);
    const pMsb = dev.readByte();
    const pLsb = dev.readByte();
    const pXlsb = dev.readByte();
    const tMsb = dev.readByte();
    const tLsb = dev.readByte();
    const tXlsb = dev.readByte();
    dev.stop();
    const adcP = (pMsb << 12) | (pLsb << 4) | (pXlsb >> 4);
    const adcT = (tMsb << 12) | (tLsb << 4) | (tXlsb >> 4);
    return { adcP, adcT };
  }

  /**
   * BMP280 Bosch 32-bit integer temperature compensation formula.
   * Returns temperature in 0.01°C.
   */
  function compensateT(adcT: number, digT1 = 27504, digT2 = 26435, digT3 = -1000): number {
    const var1 = (((adcT >> 3) - (digT1 << 1)) * digT2) >> 11;
    const sub = (adcT >> 4) - digT1;
    const var2 = (((sub * sub) >> 12) * digT3) >> 14;
    const tFine = var1 + var2;
    return (tFine * 5 + 128) >> 8;
  }

  /**
   * BMP280 floating-point pressure compensation formula.
   * Returns pressure in Pa.
   */
  function compensateP(
    adcP: number,
    adcT: number,
    digT1 = 27504,
    digT2 = 26435,
    digT3 = -1000,
    digP1 = 36477,
    digP2 = -10685,
    digP3 = 3024,
    digP4 = 2855,
    digP5 = 140,
    digP6 = -7,
    digP7 = 15500,
    digP8 = -14600,
    digP9 = 6000,
  ): number {
    const var1 = (((adcT >> 3) - (digT1 << 1)) * digT2) >> 11;
    const sub = (adcT >> 4) - digT1;
    const var2 = (((sub * sub) >> 12) * digT3) >> 14;
    const tf = var1 + var2;

    let v1 = tf / 2.0 - 64000.0;
    let v2 = (v1 * v1 * digP6) / 32768.0;
    v2 = v2 + v1 * digP5 * 2.0;
    v2 = v2 / 4.0 + digP4 * 65536.0;
    v1 = ((digP3 * v1 * v1) / 524288.0 + digP2 * v1) / 524288.0;
    v1 = (1.0 + v1 / 32768.0) * digP1;
    if (v1 === 0) return 0;
    let p = 1048576.0 - adcP;
    p = ((p - v2 / 4096.0) * 6250.0) / v1;
    return p + ((digP9 * p * p) / 2147483648.0 + (p * digP8) / 32768.0 + digP7) / 16.0;
  }

  it('default 25°C produces compensated temperature within ±0.5°C', () => {
    const dev = new VirtualBMP280();
    const { adcT } = readRawAdc(dev);
    const centideg = compensateT(adcT);
    expect(centideg / 100).toBeCloseTo(25, 0);
  });

  it('setting temperatureC = 20 produces ~20°C compensated output', () => {
    const dev = new VirtualBMP280();
    dev.temperatureC = 20;
    const { adcT } = readRawAdc(dev);
    expect(compensateT(adcT) / 100).toBeCloseTo(20, 0);
  });

  it('setting temperatureC = 0 produces ~0°C compensated output', () => {
    const dev = new VirtualBMP280();
    dev.temperatureC = 0;
    const { adcT } = readRawAdc(dev);
    expect(compensateT(adcT) / 100).toBeCloseTo(0, 0);
  });

  it('setting temperatureC = 85 produces ~85°C compensated output', () => {
    const dev = new VirtualBMP280();
    dev.temperatureC = 85;
    const { adcT } = readRawAdc(dev);
    expect(compensateT(adcT) / 100).toBeCloseTo(85, 0);
  });
});

describe('VirtualBMP280 — pressure compensation', () => {
  function readRawAdc(dev: VirtualBMP280): { adcP: number; adcT: number } {
    dev.writeByte(0xf7);
    const pMsb = dev.readByte(),
      pLsb = dev.readByte(),
      pXlsb = dev.readByte();
    const tMsb = dev.readByte(),
      tLsb = dev.readByte(),
      tXlsb = dev.readByte();
    dev.stop();
    return {
      adcP: (pMsb << 12) | (pLsb << 4) | (pXlsb >> 4),
      adcT: (tMsb << 12) | (tLsb << 4) | (tXlsb >> 4),
    };
  }

  function compensateP(adcP: number, adcT: number): number {
    const digT1 = 27504,
      digT2 = 26435,
      digT3 = -1000;
    const digP1 = 36477,
      digP2 = -10685,
      digP3 = 3024;
    const digP4 = 2855,
      digP5 = 140,
      digP6 = -7;
    const digP7 = 15500,
      digP8 = -14600,
      digP9 = 6000;
    const var1 = (((adcT >> 3) - (digT1 << 1)) * digT2) >> 11;
    const sub = (adcT >> 4) - digT1;
    const var2 = (((sub * sub) >> 12) * digT3) >> 14;
    const tf = var1 + var2;
    let v1 = tf / 2.0 - 64000.0;
    let v2 = (v1 * v1 * digP6) / 32768.0;
    v2 = v2 + v1 * digP5 * 2.0;
    v2 = v2 / 4.0 + digP4 * 65536.0;
    v1 = ((digP3 * v1 * v1) / 524288.0 + digP2 * v1) / 524288.0;
    v1 = (1.0 + v1 / 32768.0) * digP1;
    if (v1 === 0) return 0;
    let p = 1048576.0 - adcP;
    p = ((p - v2 / 4096.0) * 6250.0) / v1;
    return p + ((digP9 * p * p) / 2147483648.0 + (p * digP8) / 32768.0 + digP7) / 16.0;
  }

  it('default 1013.25 hPa produces compensated pressure within ±5 hPa', () => {
    const dev = new VirtualBMP280();
    const { adcP, adcT } = readRawAdc(dev);
    const pHPa = compensateP(adcP, adcT) / 100;
    expect(Math.abs(pHPa - 1013.25)).toBeLessThan(5);
  });

  it('setting pressureHPa = 900 produces ~900 hPa compensated output (±5)', () => {
    const dev = new VirtualBMP280();
    dev.pressureHPa = 900;
    const { adcP, adcT } = readRawAdc(dev);
    expect(Math.abs(compensateP(adcP, adcT) / 100 - 900)).toBeLessThan(5);
  });

  it('setting pressureHPa = 1100 produces ~1100 hPa compensated output (±5)', () => {
    const dev = new VirtualBMP280();
    dev.pressureHPa = 1100;
    const { adcP, adcT } = readRawAdc(dev);
    expect(Math.abs(compensateP(adcP, adcT) / 100 - 1100)).toBeLessThan(5);
  });
});

describe('VirtualBMP280 — ctrl_meas register is writable', () => {
  it('can write and read back ctrl_meas (0xF4)', () => {
    const dev = new VirtualBMP280();
    // Set reg pointer via normal write
    dev.writeByte(0xf4); // pointer → 0xF4
    dev.writeByte(0x57); // write 0x57 (forced mode + oversampling)
    dev.stop();
    dev.writeByte(0xf4); // read back
    expect(dev.readByte()).toBe(0x57);
  });
});

// ─── VirtualDS3231 ────────────────────────────────────────────────────────────

describe('VirtualDS3231 — time registers', () => {
  it('address is 0x68', () => {
    expect(new VirtualDS3231().address).toBe(0x68);
  });

  it('register 0x00 returns valid BCD seconds (0–59)', () => {
    const dev = new VirtualDS3231();
    dev.writeByte(0x00);
    const raw = dev.readByte();
    const tens = (raw >> 4) & 0xf;
    const units = raw & 0xf;
    expect(tens).toBeLessThanOrEqual(5);
    expect(units).toBeLessThanOrEqual(9);
  });

  it('register 0x02 (hours) returns valid BCD 0–23', () => {
    const dev = new VirtualDS3231();
    dev.writeByte(0x02);
    const raw = dev.readByte();
    const tens = (raw >> 4) & 0xf;
    const units = raw & 0xf;
    const hours = tens * 10 + units;
    expect(hours).toBeGreaterThanOrEqual(0);
    expect(hours).toBeLessThanOrEqual(23);
  });

  it('reads 7 consecutive BCD time registers without error', () => {
    const dev = new VirtualDS3231();
    dev.writeByte(0x00);
    for (let i = 0; i < 7; i++) {
      expect(() => dev.readByte()).not.toThrow();
    }
  });

  it('register 0x0E (control) reads 0x00', () => {
    const dev = new VirtualDS3231();
    dev.writeByte(0x0e);
    expect(dev.readByte()).toBe(0x00);
  });

  it('register 0x0F (status) reads 0x00 (OSF cleared)', () => {
    const dev = new VirtualDS3231();
    dev.writeByte(0x0f);
    expect(dev.readByte()).toBe(0x00);
  });
});

describe('VirtualDS3231 — temperature registers', () => {
  it('register 0x11 returns integer part of temperature (25°C = 0x19)', () => {
    const dev = new VirtualDS3231();
    dev.temperatureC = 25.0;
    dev.writeByte(0x11);
    expect(dev.readByte()).toBe(25); // 25 = 0x19
  });

  it('register 0x12 returns 0x00 for integer temperature (no fractional)', () => {
    const dev = new VirtualDS3231();
    dev.temperatureC = 25.0;
    dev.writeByte(0x12);
    expect(dev.readByte()).toBe(0x00);
  });

  it('register 0x12 returns 0x80 for 0.5°C fractional (bits 7:6 = 0b10)', () => {
    const dev = new VirtualDS3231();
    dev.temperatureC = 25.5;
    dev.writeByte(0x12);
    // 0.5°C / 0.25°C = 2 = 0b10 → stored in bits 7:6 = 0x80
    expect(dev.readByte()).toBe(0x80);
  });

  it('handles negative temperature: -5°C MSB = 0xFB (251 as unsigned)', () => {
    const dev = new VirtualDS3231();
    dev.temperatureC = -5.0;
    dev.writeByte(0x11);
    // trunc(-5) & 0xFF = 251
    expect(dev.readByte()).toBe(-5 & 0xff);
  });
});

describe('VirtualDS3231 — stop/firstByte reset', () => {
  it('stop() resets pointer acquisition', () => {
    const dev = new VirtualDS3231();
    dev.writeByte(0x11); // set pointer
    dev.stop();
    dev.writeByte(0x00); // new pointer → seconds
    const raw = dev.readByte();
    expect((raw >> 4) & 0xf).toBeLessThanOrEqual(5); // valid BCD tens digit
  });
});

// ─── VirtualPCF8574 ────────────────────────────────────────────────────────────

describe('VirtualPCF8574 — construction', () => {
  it('default address is 0x27', () => {
    expect(new VirtualPCF8574().address).toBe(0x27);
  });

  it('accepts custom address', () => {
    expect(new VirtualPCF8574(0x20).address).toBe(0x20);
    expect(new VirtualPCF8574(0x3f).address).toBe(0x3f);
  });

  it('default portState and outputLatch are both 0xFF', () => {
    const dev = new VirtualPCF8574();
    expect(dev.portState).toBe(0xff);
    expect(dev.outputLatch).toBe(0xff);
  });
});

describe('VirtualPCF8574 — write', () => {
  it('writeByte updates outputLatch', () => {
    const dev = new VirtualPCF8574();
    dev.writeByte(0b10101010);
    expect(dev.outputLatch).toBe(0b10101010);
  });

  it('writeByte fires onWrite callback with the written value', () => {
    const dev = new VirtualPCF8574();
    const log: number[] = [];
    dev.onWrite = (v) => log.push(v);
    dev.writeByte(0x42);
    expect(log).toEqual([0x42]);
  });

  it('multiple writes update outputLatch each time', () => {
    const dev = new VirtualPCF8574();
    dev.writeByte(0xaa);
    dev.writeByte(0x55);
    expect(dev.outputLatch).toBe(0x55);
  });
});

describe('VirtualPCF8574 — read (open-drain model)', () => {
  it('readByte returns portState & outputLatch (both 0xFF → 0xFF)', () => {
    const dev = new VirtualPCF8574();
    expect(dev.readByte()).toBe(0xff);
  });

  it('readByte: pin driven LOW by Arduino (outputLatch=0) → reads 0 regardless of portState', () => {
    const dev = new VirtualPCF8574();
    dev.portState = 0xff;
    dev.writeByte(0x00); // drive all LOW
    expect(dev.readByte()).toBe(0x00);
  });

  it('readByte: external input LOW overrides Hi-Z output (open-drain)', () => {
    const dev = new VirtualPCF8574();
    dev.portState = 0b00001111; // lower 4 pins pulled low by external device
    dev.outputLatch = 0xff; // Arduino released all pins
    expect(dev.readByte()).toBe(0b00001111);
  });

  it('readByte reflects mix of output-low and external-low', () => {
    const dev = new VirtualPCF8574();
    dev.outputLatch = 0b11110000; // Arduino drives lower 4 LOW, upper 4 Hi-Z
    dev.portState = 0b10101010; // external: alternate HIGH/LOW
    // result: upper 4 from portState masked, lower 4 forced LOW by outputLatch
    expect(dev.readByte()).toBe(0b10100000);
  });
});

describe('VirtualPCF8574 — writeByte returns ACK', () => {
  it('always returns true (ACK)', () => {
    const dev = new VirtualPCF8574();
    expect(dev.writeByte(0x00)).toBe(true);
    expect(dev.writeByte(0xff)).toBe(true);
  });
});
