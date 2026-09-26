/**
 * i2c-lcd-coupling-gap.test.ts
 *
 * Faithful reproduction of the "LCD I2C is currently unavailable"
 * complaint reported on Discord.
 *
 * What works today
 * ----------------
 * VirtualPCF8574 is registered as a part and at the bus level
 * correctly receives every byte the Arduino's Wire library
 * writes to the I2C backpack address (default 0x27).  Its
 * outputLatch holds the last byte, and its onWrite callback
 * fires per byte.  protocol-parts and virtual-i2c-devices tests
 * both confirm this.
 *
 * What does NOT work
 * ------------------
 * The PCF8574 backpack carries an HD44780-style 4-bit interface
 * to a separate LCD1602 (or LCD2004) character module.  Every
 * byte the Arduino writes is a control bundle: RS, RW, EN, BL
 * in the low 4 bits and a 4-bit data nibble in the high 4 bits.
 * Two writes per character: one with EN=1 latches the high
 * nibble, then a follow-up with EN=0 settles it; same for the
 * low nibble.
 *
 * Velxio's wokwi-lcd1602 element accepts characters through its
 * own DOM property (`characters`) — it is NOT driven by the
 * PCF8574 device.  There is no decoder in the codebase that
 * watches PCF8574.onWrite, reassembles bytes into HD44780
 * commands, and updates the LCD element accordingly.  The two
 * components are visually independent.
 *
 * This test reproduces the gap end-to-end using the REAL
 * VirtualPCF8574 and the REAL I2CBusManager.  It drives the
 * same byte sequence that LiquidCrystal_I2C(addr, 16, 2)
 * followed by lcd.print("Hi") would emit on the wire.
 *
 * It then checks two things:
 *
 *   1. The PCF8574 receives the bytes (this should pass — the
 *      I2C path is fine).
 *   2. A mock wokwi-lcd1602 element wired alongside should end
 *      up with the characters "Hi" rendered at row 0.  This
 *      currently FAILS because nothing couples the PCF8574 to
 *      the LCD element.
 *
 * The fix is to either:
 *  (a) ship a `pcf8574-lcd` virtual coupler part that, on
 *      PCF8574.onWrite, runs an HD44780 4-bit decoder and
 *      writes into the connected LCD element's characters
 *      array, OR
 *  (b) ship a `wokwi-lcd-i2c` web component / metadata entry
 *      that bundles the PCF8574 + LCD1602 into one part.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  I2CBusManager,
  VirtualPCF8574,
} from '../simulation/I2CBusManager';
import { HD44780Decoder } from '../simulation/HD44780Decoder';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/ProtocolParts';
import { busRegistry } from '../simulation/buses';
import { bareBoard, putI2cDevice, clearBench } from './helpers/i2cBench';

/**
 * The TWI's manager as the Uno's controller port on the fabric, with the
 * backpack on its pins (A4/A5 = 18/19) the way a part is. What the cases
 * drive into the manager reaches the PCF8574 through the bus, as on the
 * board.
 */
function twiWith(bus: I2CBusManager, pcf: VirtualPCF8574): void {
  bareBoard('uno', 'arduino-uno', {
    getBusBinding: () => ({
      pins: { onPinChange: () => () => {}, peekPinState: () => undefined },
      spi: [],
      i2c: [bus],
    }),
  });
  putI2cDevice(pcf, { boardId: 'uno', pin: 18 }, { boardId: 'uno', pin: 19 });
}

afterEach(() => clearBench());

// Minimal mock of AVRTWI shaped exactly as I2CBusManager calls it.
// We don't need a real CPU for this test — the bug is in what
// happens AFTER bytes reach the bus.
function makeTWI() {
  return {
    set eventHandler(_handler: unknown) {
      /* installed by I2CBusManager */
    },
    completeStart() {},
    completeStop() {},
    completeConnect(_ack: boolean) {},
    completeWrite(_ack: boolean) {},
    completeRead(_value: number) {},
  };
}

// ── HD44780-on-PCF8574 wire format helpers ──────────────────────────────────
//
// PCF8574 byte layout used by LiquidCrystal_I2C (Frank de Brabander):
//
//   bit 7 6 5 4 | 3  2  1  0
//        D7..D4 | BL EN RW RS
//
// where D7..D4 is the high or low data nibble of the byte to
// send to the HD44780.  EN must pulse high then low for the
// LCD to latch each nibble.

const RS_DATA = 0x01;
const RW_WRITE = 0x00;
const EN_HIGH = 0x04;
const BL_ON = 0x08;

function encodeNibble(nibble: number, rs: number): number {
  return ((nibble & 0x0f) << 4) | BL_ON | EN_HIGH | RW_WRITE | rs;
}
function settleNibble(nibble: number, rs: number): number {
  return ((nibble & 0x0f) << 4) | BL_ON | RW_WRITE | rs;
}

/** Emit the 4-byte sequence a single character takes on the wire. */
function emitChar(bus: I2CBusManager, addr: number, c: number) {
  const high = (c >> 4) & 0x0f;
  const low = c & 0x0f;
  bus.connectToSlave(addr, true);
  bus.writeByte(encodeNibble(high, RS_DATA));
  bus.writeByte(settleNibble(high, RS_DATA));
  bus.writeByte(encodeNibble(low, RS_DATA));
  bus.writeByte(settleNibble(low, RS_DATA));
  bus.stop();
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('I2C bug — LCD-I2C coupling gap (Discord: "i2c lcd is unavailable")', () => {
  it('PCF8574 backpack receives every byte the LCD library writes (sanity)', () => {
    const twi = makeTWI();
    const bus = new I2CBusManager(twi as any);
    const pcf = new VirtualPCF8574(0x27);
    const seen: number[] = [];
    pcf.onWrite = (v) => seen.push(v);
    twiWith(bus, pcf);

    emitChar(bus, 0x27, 'H'.charCodeAt(0));
    emitChar(bus, 0x27, 'i'.charCodeAt(0));

    // 4 bytes per char × 2 chars
    expect(seen.length).toBe(8);

    // The last byte should be the low-nibble settle for 'i'
    // (0x69 → low = 0x9 → settle byte = 0x90 | 0x08 (BL) | 0x01 (RS)
    // = 0x99).
    expect(seen[seen.length - 1]).toBe(0x99);
  });

  it('FIXED: HD44780 decoder turns PCF8574 byte stream into character writes', () => {
    // The fix: HD44780Decoder consumes the same byte stream and
    // exposes `characters` to the LCD element.
    const twi = makeTWI();
    const bus = new I2CBusManager(twi as any);
    const pcf = new VirtualPCF8574(0x27);
    const decoder = new HD44780Decoder({ cols: 16, rows: 2 });
    pcf.onWrite = (v) => decoder.feedPCF8574Byte(v);
    twiWith(bus, pcf);

    // Before printing characters the sketch issues a Set DDRAM
    // Address command (0x80 | row*0x40 | col) to position the
    // cursor at row 0, col 0.  LiquidCrystal_I2C does this
    // before every print.
    const sendCmd = (cmd: number) => {
      const high = (cmd >> 4) & 0x0f;
      const low = cmd & 0x0f;
      bus.connectToSlave(0x27, true);
      // High nibble — RS=0 (command), EN pulse
      bus.writeByte((high << 4) | 0x08 | 0x04); // EN=1
      bus.writeByte((high << 4) | 0x08); // EN=0 (latch)
      bus.writeByte((low << 4) | 0x08 | 0x04);
      bus.writeByte((low << 4) | 0x08);
      bus.stop();
    };

    sendCmd(0x80); // Set DDRAM address = 0 (row 0, col 0)
    emitChar(bus, 0x27, 'H'.charCodeAt(0));
    emitChar(bus, 0x27, 'i'.charCodeAt(0));

    const snap = decoder.snapshot();
    expect(snap.characters[0]).toBe('H'.charCodeAt(0));
    expect(snap.characters[1]).toBe('i'.charCodeAt(0));
  });

  it('FIXED: `lcd1602-i2c` part is registered and wires everything up', () => {
    expect(PartSimulationRegistry.get('lcd1602-i2c')).toBeDefined();
    expect(PartSimulationRegistry.get('lcd2004-i2c')).toBeDefined();
  });

  it('FIXED: end-to-end — lcd1602-i2c part renders text on the underlying element', () => {
    // Build a mock wokwi-lcd1602-shaped element and a minimal
    // sim that exposes addI2CDevice — exactly the contract the
    // part attaches against.
    const el: any = {
      pins: 'full',
      characters: new Uint8Array(32),
      backlight: true,
      i2cAddress: '0x27',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const twi = makeTWI();
    const bus = new I2CBusManager(twi as any);
    const sim: any = {
      i2cBus: bus,
      pinManager: { onPinChange: () => () => {} },
    };
    // The backpack is on the bus its SDA/SCL are wired to: the Uno's TWI on
    // A4/A5 (18/19), whose controller port is this manager.
    busRegistry.setResolver({
      resolve: (ref) =>
        ref.kind === 'board'
          ? { kind: 'board', boardId: ref.boardId, pin: ref.pin }
          : ref.componentId === 'lcd-1' && (ref.pinName === 'SDA' || ref.pinName === 'SCL')
            ? { kind: 'board', boardId: 'uno', pin: ref.pinName === 'SDA' ? 18 : 19 }
            : { kind: 'floating' },
      boardKind: () => 'arduino-uno',
      boards: () => ['uno'],
    });
    busRegistry.bindEngine('uno', {
      pins: { onPinChange: () => () => {}, peekPinState: () => undefined },
      spi: [],
      i2c: [bus],
    });

    const detach = PartSimulationRegistry.get('lcd1602-i2c')!.attachEvents!(
      el as HTMLElement,
      sim,
      () => null,
      'lcd-1',
    );

    // The part should have forced I2C pin mode and registered
    // a virtual PCF8574 device at 0x27.
    expect(el.pins).toBe('i2c');

    // Now emit a typical LiquidCrystal_I2C "Hello" sequence:
    //   Set DDRAM addr 0x00, then write 'H' 'e' 'l' 'l' 'o'.
    const sendCmd = (cmd: number) => {
      const h = (cmd >> 4) & 0x0f;
      const l = cmd & 0x0f;
      bus.connectToSlave(0x27, true);
      bus.writeByte((h << 4) | 0x0c);
      bus.writeByte((h << 4) | 0x08);
      bus.writeByte((l << 4) | 0x0c);
      bus.writeByte((l << 4) | 0x08);
      bus.stop();
    };

    sendCmd(0x80);
    for (const ch of 'Hello') emitChar(bus, 0x27, ch.charCodeAt(0));

    // The element's `characters` should now hold "Hello" in the
    // first 5 slots.
    const chars = Array.from(el.characters as Uint8Array);
    expect(chars[0]).toBe('H'.charCodeAt(0));
    expect(chars[1]).toBe('e'.charCodeAt(0));
    expect(chars[2]).toBe('l'.charCodeAt(0));
    expect(chars[3]).toBe('l'.charCodeAt(0));
    expect(chars[4]).toBe('o'.charCodeAt(0));

    detach();
    busRegistry.clear();
  });

  it('FIXED: clear command wipes the display and resets cursor', () => {
    const twi = makeTWI();
    const bus = new I2CBusManager(twi as any);
    const pcf = new VirtualPCF8574(0x27);
    const decoder = new HD44780Decoder({ cols: 16, rows: 2 });
    pcf.onWrite = (v) => decoder.feedPCF8574Byte(v);
    twiWith(bus, pcf);

    // Write some content first.
    const sendCmd = (cmd: number) => {
      const h = (cmd >> 4) & 0x0f;
      const l = cmd & 0x0f;
      bus.connectToSlave(0x27, true);
      bus.writeByte((h << 4) | 0x0c);
      bus.writeByte((h << 4) | 0x08);
      bus.writeByte((l << 4) | 0x0c);
      bus.writeByte((l << 4) | 0x08);
      bus.stop();
    };
    sendCmd(0x80);
    emitChar(bus, 0x27, 0x41); // 'A'
    expect(decoder.snapshot().characters[0]).toBe(0x41);

    // Issue Clear Display (0x01).
    sendCmd(0x01);
    const snap = decoder.snapshot();
    // All 32 cells should be spaces (0x20).
    expect(snap.characters.every((c) => c === 0x20)).toBe(true);
    expect(snap.cursorAddress).toBe(0);
  });

  it('FIXED: row 1 maps to DDRAM 0x40-0x4F', () => {
    const twi = makeTWI();
    const bus = new I2CBusManager(twi as any);
    const pcf = new VirtualPCF8574(0x27);
    const decoder = new HD44780Decoder({ cols: 16, rows: 2 });
    pcf.onWrite = (v) => decoder.feedPCF8574Byte(v);
    twiWith(bus, pcf);

    const sendCmd = (cmd: number) => {
      const h = (cmd >> 4) & 0x0f;
      const l = cmd & 0x0f;
      bus.connectToSlave(0x27, true);
      bus.writeByte((h << 4) | 0x0c);
      bus.writeByte((h << 4) | 0x08);
      bus.writeByte((l << 4) | 0x0c);
      bus.writeByte((l << 4) | 0x08);
      bus.stop();
    };

    sendCmd(0xc0); // Set DDRAM addr 0x40 = row 1, col 0
    emitChar(bus, 0x27, 'X'.charCodeAt(0));

    const snap = decoder.snapshot();
    // Index 16 = row 1 col 0 in the flat 16x2 grid.
    expect(snap.characters[16]).toBe('X'.charCodeAt(0));
  });
});
