/**
 * I2C and SPI transfers take their time on the wire (velxio/velxio-prod#159).
 *
 * Every TWI address or data packet is nine SCL periods long (ATmega328P
 * datasheet DS40002061B, sections 22.3.3 and 22.3.4), at SCL = CPU clock /
 * (16 + 2 * TWBR * prescaler) (22.5.2): about 90 us a byte at Wire's 100 kHz.
 * An SPI byte is eight SCK periods, and SPIF is set when the transfer is
 * complete (SPSR). The bus completed every step at once instead: the TWI's
 * within a cycle of the register write, SPI inside the SPDR write itself. A
 * BMP280 chip-id read took 80 us instead of about 440 us, and 64 bytes at
 * 125 kHz took 56 us instead of 4.1 ms, so sketches that time themselves
 * (display frame rates, loop budgets) came out several times too fast.
 *
 * The fixture (avr-i2c-spi-bus-time.ino, compiled by the compile service)
 * times one Wire register read of 0xD0 at 0x76 and 64 SPI.transfer calls at
 * 4 MHz and at 125 kHz with micros(), and prints the three times.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';

const HEX = readFileSync(
  fileURLToPath(new URL('./fixtures/avr-i2c-spi-bus-time/avr-i2c-spi-bus-time.ino.hex', import.meta.url)),
  'utf-8',
);

interface Times {
  id: number;
  i2c: number;
  spi4M: number;
  spi125k: number;
}

let times: Times | null = null;
let addressed: Array<{ address: number; read: boolean }> = [];

beforeAll(() => {
  const sim = new AVRSimulator(new PinManager());
  sim.loadHex(HEX);
  // A BMP280 at 0x76: the register pointer write, then its chip id 0x58.
  addressed = [];
  sim.getBusBinding().i2c[0].setTransactionHandler({
    start: (address, read) => {
      addressed.push({ address, read });
      return address === 0x76;
    },
    write: () => true,
    read: () => 0x58,
    stop: () => {},
  });
  let line = '';
  sim.onSerialData = (ch) => {
    if (ch === '\n') {
      const m = /id=0x([0-9A-F]+) i2c_us=(\d+) spi4M_64B_us=(\d+) spi125k_64B_us=(\d+)/.exec(line);
      if (m && !times) {
        times = { id: parseInt(m[1], 16), i2c: +m[2], spi4M: +m[3], spi125k: +m[4] };
      }
      line = '';
    } else line += ch;
  };
  const cpu = (sim as unknown as { cpu: { cycles: number } }).cpu;
  while (!times && cpu.cycles < 300 * 16_000) sim.step();
  sim.stop();
});

describe('AVR bus transfer time (velxio/velxio-prod#159)', () => {
  it('the sketch reads the chip id and reports its times', () => {
    expect(times).not.toBeNull();
    expect(times!.id).toBe(0x58);
    expect(addressed).toContainEqual({ address: 0x76, read: false });
    expect(addressed).toContainEqual({ address: 0x76, read: true });
  });

  it('a Wire register read at 100 kHz takes about 440 us (4 packets of 9 bits, START, repeated START, STOP)', () => {
    // 4 x 9 SCL periods of 10 us plus 3 conditions: 390 us of bus time, and
    // the Wire library's own work on top.
    expect(times!.i2c).toBeGreaterThanOrEqual(390);
    expect(times!.i2c).toBeLessThan(520);
  });

  it('64 SPI bytes take at least their 8 SCK periods each', () => {
    // 4 MHz: 2 us a byte, 128 us of bus time. 125 kHz: 64 us a byte, 4096 us.
    expect(times!.spi4M).toBeGreaterThanOrEqual(128);
    expect(times!.spi4M).toBeLessThan(260);
    expect(times!.spi125k).toBeGreaterThanOrEqual(4096);
    expect(times!.spi125k).toBeLessThan(4400);
  });
});
