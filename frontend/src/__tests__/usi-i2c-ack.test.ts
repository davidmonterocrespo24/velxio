/**
 * usi-i2c-ack.test.ts
 *
 * Regression tests for the slave-side ACK on the ATtiny85's two-wire USI
 * (the blank-SSD1306-on-ATtiny85 regression).
 *
 * TinyWireM's USI_TWI_Master_Transfer strobes USICR with
 * USIWM1|USICS1|USICLK|USITC (0x2B). In avr8js that is `clockSrc === 3`:
 * DI is sampled at the top of the FALLING USITC write — one toggle AFTER
 * the 9th rising edge. Whoever answers therefore has to hold SDA low from
 * the moment the 8th bit completes until the falling edge that closes the
 * ACK slot. Releasing on the rising edge makes the master read NACK and
 * TinyWireM aborts after the address byte: the exact bug where the
 * INPUT_PULLUP seed (eb3b04ef) stopped masking the missing ACK.
 *
 * Since board-buses F5 the answer comes from the bus fabric's software I2C
 * decoder on PB0/PB2 (the USI IS the pins: AVRSimulator.getBusBinding), with
 * the device on the bus by its wiring like any part. Instead of compiling
 * real firmware, the test replays TinyWireM's exact register sequence (taken
 * from the ATTinyCore disassembly of USI_TWI_Master_Transfer / _Start /
 * _Stop) against a real AVRSimulator.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';
import type { I2CDevice } from '../simulation/I2CBusManager';
import { bareBoard, putI2cDevice, clearBench } from './helpers/i2cBench';

// ATtiny85 register addresses
const DDRB = 0x37;
const PORTB = 0x38;
const USICR = 0x2d;
const USISR = 0x2e;
const USIDR = 0x2f;

const SDA = 1 << 0; // PB0
const SCL = 1 << 2; // PB2

const USICR_STROBE = 0x2b; // USIWM1|USICS1|USICLK|USITC — TinyWireM's clock strobe
const USIOIF = 1 << 6;

const EMPTY_HEX = ':00000001FF\n';

beforeEach(() => {
  let counter = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return ++counter;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearBench();
});

/** Mirror of TinyWireM's master ops, register-accurate. */
class UsiMaster {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private cpu: any;

  constructor(sim: AVRSimulator) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.cpu = (sim as any).cpu;
  }

  private write(addr: number, value: number): void {
    this.cpu.writeData(addr, value);
  }
  private read(addr: number): number {
    return this.cpu.data[addr];
  }

  init(): void {
    this.write(PORTB, SDA);
    this.write(PORTB, SDA | SCL);
    this.write(DDRB, SCL);
    this.write(DDRB, SCL | SDA);
    this.write(USIDR, 0xff);
    this.write(USICR, 0x28); // USIWM1|USICS1 — two-wire mode, hold
    this.write(USISR, 0xf0);
  }

  start(): void {
    this.write(PORTB, this.read(PORTB) | SCL); // release SCL
    this.write(PORTB, this.read(PORTB) & ~SDA); // SDA low while SCL high
    this.write(PORTB, this.read(PORTB) & ~SCL); // SCL low
    this.write(PORTB, this.read(PORTB) | SDA); // release SDA
  }

  /** USI_TWI_Master_Transfer: returns USIDR after the shift completes. */
  private transfer(usisr: number): number {
    this.write(USISR, usisr);
    do {
      this.write(USICR, USICR_STROBE); // positive SCL edge
      this.write(USICR, USICR_STROBE); // negative SCL edge
    } while (!(this.read(USISR) & USIOIF));
    const out = this.read(USIDR);
    this.write(USIDR, 0xff); // release SDA
    this.write(DDRB, this.read(DDRB) | SDA); // SDA back to output
    return out;
  }

  /** Send one byte; returns true when the slave ACKed it. */
  sendByte(value: number): boolean {
    this.write(PORTB, this.read(PORTB) & ~SCL);
    this.write(USIDR, value);
    this.transfer(0xf0); // 8-bit transfer
    this.write(DDRB, this.read(DDRB) & ~SDA); // SDA input for the ACK slot
    const ack = this.transfer(0xfe); // 1-bit transfer
    return (ack & 1) === 0;
  }

  stop(): void {
    this.write(PORTB, this.read(PORTB) & ~SDA);
    this.write(PORTB, this.read(PORTB) | SCL);
    this.write(PORTB, this.read(PORTB) | SDA);
  }
}

function makeSim() {
  const sim = new AVRSimulator(new PinManager(), 'tiny85');
  sim.loadHex(EMPTY_HEX);

  const received: number[] = [];
  let stops = 0;
  const device: I2CDevice = {
    address: 0x3c,
    writeByte(v: number) {
      received.push(v);
      return true;
    },
    readByte: () => 0xff,
    stop() {
      stops++;
    },
  };
  // On the bus by its wiring, as a part is: SDA on PB0, SCL on PB2.
  bareBoard('tiny', 'attiny85', sim);
  putI2cDevice(device, { boardId: 'tiny', pin: 0 }, { boardId: 'tiny', pin: 2 });

  return { sim, received, getStops: () => stops };
}

describe('USI I2C slave-side ACK', () => {
  it('ACKs a registered device through the whole write transaction', () => {
    const { sim, received, getStops } = makeSim();
    const master = new UsiMaster(sim);

    master.init();
    master.start();
    expect(master.sendByte(0x78)).toBe(true); // 0x3C << 1 | W — address ACK
    expect(master.sendByte(0x00)).toBe(true); // control byte
    expect(master.sendByte(0xaf)).toBe(true); // command (display on)
    master.stop();

    expect(received).toEqual([0x00, 0xaf]);
    expect(getStops()).toBe(1);
  });

  it('NACKs an address nobody owns, like real hardware', () => {
    const { sim, received } = makeSim();
    const master = new UsiMaster(sim);

    master.init();
    master.start();
    expect(master.sendByte(0x42 << 1)).toBe(false); // no device at 0x42
    master.stop();
    expect(received).toEqual([]);
  });

  it('keeps ACKing across repeated transactions (Tiny4kOLED frame loop)', () => {
    const { sim, received } = makeSim();
    const master = new UsiMaster(sim);

    master.init();
    for (let frame = 0; frame < 3; frame++) {
      master.start();
      expect(master.sendByte(0x78)).toBe(true);
      expect(master.sendByte(0x40)).toBe(true); // data stream control byte
      expect(master.sendByte(frame)).toBe(true);
      master.stop();
    }
    expect(received).toEqual([0x40, 0, 0x40, 1, 0x40, 2]);
  });
});
