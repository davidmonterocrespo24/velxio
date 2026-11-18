/**
 * The character LCDs draw createChar()'s custom characters
 * (velxio/velxio-prod#162).
 *
 * The HD44780 keeps eight user 5x8 patterns in CGRAM: Set CGRAM address
 * (0x40 | addr) points the address counter there, the data bytes that follow
 * fill it, and character codes 0-7 draw them; bit 3 of the code has no
 * effect, so 8-15 draw the same eight (HD44780U datasheet, Table 5 notes 3
 * and 4; bit 4 of a row is its leftmost dot). LiquidCrystal's createChar()
 * sends exactly that. The parallel LCD ignored the 0x40 command and wrote the
 * eight pattern bytes into the text (DDRAM) at the cursor; the I2C one kept
 * them, but neither drew them: the element's font has blank slots 0-31.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { PinManager } from '../simulation/PinManager';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/ComplexParts';
import '../simulation/parts/ProtocolParts';
import { I2CBusManager } from '../simulation/I2CBusManager';
import { busRegistry } from '../simulation/buses';
import { clearBench } from './helpers/i2cBench';

/** A heart: rows of five dots, bit 4 the leftmost (as createChar takes them). */
const HEART = [0b00000, 0b01010, 0b11111, 0b11111, 0b11111, 0b01110, 0b00100, 0b00000];
/** The same rows as the element draws them: bit 0 is its leftmost dot. */
const mirror = (row: number) =>
  ((row & 1) << 4) | ((row & 2) << 2) | (row & 4) | ((row & 8) >> 2) | ((row & 16) >> 4);
const HEART_FONT = HEART.map(mirror);

/** What LiquidCrystal sends after its power-on nibbles: 4-bit, 2 lines, display on, clear, entry left. */
const INIT = [0x28, 0x0c, 0x01, 0x06];

/** createChar(0, HEART), then setCursor(0, 0) and the codes 0, 'A', 8. */
const SKETCH: Array<[rs: boolean, byte: number]> = [
  ...INIT.map((b) => [false, b] as [boolean, number]),
  [false, 0x40],
  ...HEART.map((b) => [true, b] as [boolean, number]),
  [false, 0x80],
  [true, 0x00],
  [true, 0x41],
  [true, 0x08],
];

afterEach(() => clearBench());

describe('parallel LCD custom characters (velxio/velxio-prod#162)', () => {
  const PINS: Record<string, number> = { RS: 12, E: 11, D4: 5, D5: 4, D6: 3, D7: 2 };

  function lcd() {
    const pm = new PinManager();
    const el: Record<string, unknown> = { addEventListener: () => {}, removeEventListener: () => {} };
    PartSimulationRegistry.get('lcd1602')!.attachEvents!(
      el as unknown as HTMLElement,
      { pinManager: pm } as never,
      (name: string) => PINS[name] ?? null,
      'lcd1',
    );
    const set = (pin: string, v: boolean) => pm.triggerPinChange(PINS[pin]!, v, 'mcu');
    const nibble = (rs: boolean, n: number) => {
      set('RS', rs);
      set('D4', !!(n & 1));
      set('D5', !!(n & 2));
      set('D6', !!(n & 4));
      set('D7', !!(n & 8));
      set('E', true);
      set('E', false);
    };
    // LiquidCrystal's begin(): 0x3 three times, then 0x2, as single nibbles.
    for (const n of [0x3, 0x3, 0x3, 0x2]) nibble(false, n);
    const send = (rs: boolean, b: number) => {
      nibble(rs, b >> 4);
      nibble(rs, b & 0x0f);
    };
    return { el, send };
  }

  it("keeps the pattern out of the text: the screen shows the codes 0, 'A', 8", () => {
    const { el, send } = lcd();
    for (const [rs, b] of SKETCH) send(rs, b);
    const chars = Array.from(el.characters as Uint8Array);
    expect(chars.slice(0, 4)).toEqual([0x00, 0x41, 0x08, 0x20]);
    expect(chars.slice(4, 16).every((c) => c === 0x20)).toBe(true);
  });

  it('draws codes 0 and 8 with the CGRAM pattern', () => {
    const { el, send } = lcd();
    for (const [rs, b] of SKETCH) send(rs, b);
    const font = el.font as Uint8Array;
    expect(font).toBeInstanceOf(Uint8Array);
    expect(Array.from(font.slice(0, 8))).toEqual(HEART_FONT);
    expect(Array.from(font.slice(8 * 8, 9 * 8))).toEqual(HEART_FONT);
    // 'A' keeps the ROM glyph.
    expect(Array.from(font.slice(0x41 * 8, 0x42 * 8)).some((r) => r !== 0)).toBe(true);
  });
});

describe('I2C LCD custom characters (velxio/velxio-prod#162)', () => {
  it('draws codes 0 and 8 with the CGRAM pattern createChar wrote', () => {
    const el: Record<string, unknown> = {
      pins: 'full',
      characters: new Uint8Array(32),
      backlight: true,
      i2cAddress: '0x27',
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const master = {
      set eventHandler(_h: unknown) {},
      completeStart() {},
      completeStop() {},
      completeConnect(_ack: boolean) {},
      completeWrite(_ack: boolean) {},
      completeRead(_value: number) {},
    };
    const bus = new I2CBusManager(master as never);
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
    } as never);
    const detach = PartSimulationRegistry.get('lcd1602-i2c')!.attachEvents!(
      el as unknown as HTMLElement,
      { i2cBus: bus, pinManager: { onPinChange: () => () => {} } } as never,
      () => null,
      'lcd-1',
    );
    // The backpack's byte: D7..D4 | BL EN RW RS. EN high then low latches a nibble.
    const send = (rs: boolean, b: number) => {
      bus.connectToSlave(0x27, true);
      for (const n of [b >> 4, b & 0x0f]) {
        bus.writeByte((n << 4) | 0x08 | 0x04 | (rs ? 1 : 0));
        bus.writeByte((n << 4) | 0x08 | (rs ? 1 : 0));
      }
      bus.stop();
    };
    for (const n of [0x3, 0x3, 0x3, 0x2]) {
      bus.connectToSlave(0x27, true);
      bus.writeByte((n << 4) | 0x0c);
      bus.writeByte((n << 4) | 0x08);
      bus.stop();
    }
    for (const [rs, b] of SKETCH) send(rs, b);
    expect(Array.from(el.characters as Uint8Array).slice(0, 3)).toEqual([0x00, 0x41, 0x08]);
    const font = el.font as Uint8Array;
    expect(font).toBeInstanceOf(Uint8Array);
    expect(Array.from(font.slice(0, 8))).toEqual(HEART_FONT);
    expect(Array.from(font.slice(8 * 8, 9 * 8))).toEqual(HEART_FONT);
    detach();
    busRegistry.clear();
  });
});
