/**
 * UC8159c (ACeP 7-colour) decoder tests.
 *
 * The 5.65" GoodDisplay GDEP0565D90 / Waveshare 5.65" panel uses this
 * controller. Pixel packing: 2 px / byte, upper nibble = first pixel,
 * each nibble's low 3 bits is a palette index 0..6.
 *
 * Latches on opcode 0x12 (DRF), not 0x20 like SSD168x. Power-on/off and
 * deep sleep flags exposed for diagnostic introspection.
 */
import { describe, it, expect } from 'vitest';
import {
  UC8159cDecoder,
  UC_CMD_PANEL_SETTING,
  UC_CMD_POWER_ON,
  UC_CMD_POWER_OFF,
  UC_CMD_DEEP_SLEEP,
  UC_CMD_DTM1,
  UC_CMD_DISPLAY_REFRESH,
  UC_CMD_RESOLUTION_SETTING,
  UC_CMD_VCOM_DATA_INTERVAL,
  ACEP_PALETTE_RGB,
  type UC8159cFrame,
} from '../simulation/displays/UC8159cDecoder';

const cmd = (c: number): Array<[number, boolean]> => [[c, false]];
const data = (...bs: number[]): Array<[number, boolean]> => bs.map((b) => [b, true] as [number, boolean]);

function feedAll(d: UC8159cDecoder, ...streams: Array<Array<[number, boolean]>>) {
  for (const stream of streams) for (const [b, dc] of stream) d.feed(b, dc);
}

describe('UC8159cDecoder — init + power state', () => {
  it('absorbs the GxEPD2 init sequence without unknown opcodes', () => {
    const d = new UC8159cDecoder({ width: 600, height: 448 });
    feedAll(
      d,
      cmd(UC_CMD_PANEL_SETTING),     data(0xef, 0x08),
      cmd(UC_CMD_RESOLUTION_SETTING), data(0x02, 0x58, 0x01, 0xc0),
      cmd(UC_CMD_VCOM_DATA_INTERVAL), data(0x37),
    );
    expect(d.unknownCmds).toEqual([]);
  });

  it('POWER_ON sets the powered_on flag, POWER_OFF clears it', () => {
    const d = new UC8159cDecoder({ width: 8, height: 1 });
    expect(d.poweredOn).toBe(false);
    feedAll(d, cmd(UC_CMD_POWER_ON));
    expect(d.poweredOn).toBe(true);
    feedAll(d, cmd(UC_CMD_POWER_OFF));
    expect(d.poweredOn).toBe(false);
  });

  it('DEEP_SLEEP + 0xA5 sets the in_deep_sleep flag', () => {
    const d = new UC8159cDecoder({ width: 8, height: 1 });
    feedAll(d, cmd(UC_CMD_DEEP_SLEEP), data(0xa5));
    expect(d.inDeepSleep).toBe(true);
  });

  it('unknown opcodes are logged not raised', () => {
    const d = new UC8159cDecoder({ width: 8, height: 1 });
    feedAll(d, cmd(0xab), data(0x01));
    expect(d.unknownCmds).toContain(0xab);
  });
});

describe('UC8159cDecoder — pixel packing', () => {
  it('writes 2 pixels per byte, upper nibble first', () => {
    // 4-px wide × 1-row panel = 2 bytes of pixel data.
    const seen: UC8159cFrame[] = [];
    const d = new UC8159cDecoder({
      width: 4,
      height: 1,
      onFlush: (f) => seen.push(f),
    });
    feedAll(
      d,
      cmd(UC_CMD_DTM1),
      // 0x40 → upper=0x4 (red), lower=0x0 (black)
      // 0x52 → upper=0x5 (yellow), lower=0x2 (green)
      data(0x40, 0x52),
      cmd(UC_CMD_DISPLAY_REFRESH),
      data(0x00),
    );
    expect(seen.length).toBe(1);
    expect(Array.from(seen[0].pixels)).toEqual([4, 0, 5, 2]);
  });

  it('only stores low 3 bits as the palette index', () => {
    // 0xFE → upper nibble=0xF (mask to 0x7 = 7=clean), lower=0xE (mask to 0x6 = orange)
    const seen: UC8159cFrame[] = [];
    const d = new UC8159cDecoder({
      width: 2,
      height: 1,
      onFlush: (f) => seen.push(f),
    });
    feedAll(d, cmd(UC_CMD_DTM1), data(0xfe), cmd(UC_CMD_DISPLAY_REFRESH));
    expect(Array.from(seen[0].pixels)).toEqual([7, 6]);
  });

  it('stops at width*height; extra bytes are ignored', () => {
    const seen: UC8159cFrame[] = [];
    const d = new UC8159cDecoder({
      width: 2,
      height: 1,
      onFlush: (f) => seen.push(f),
    });
    // 3 bytes = 6 px attempted, but RAM is only 2 pixels.
    feedAll(d, cmd(UC_CMD_DTM1), data(0x40, 0x52, 0x66), cmd(UC_CMD_DISPLAY_REFRESH));
    expect(Array.from(seen[0].pixels)).toEqual([4, 0]);
  });

  it('DTM1 reset cursor each time so the same frame can be redrawn', () => {
    const seen: UC8159cFrame[] = [];
    const d = new UC8159cDecoder({
      width: 2,
      height: 1,
      onFlush: (f) => seen.push(f),
    });
    feedAll(d, cmd(UC_CMD_DTM1), data(0x40), cmd(UC_CMD_DISPLAY_REFRESH));
    feedAll(d, cmd(UC_CMD_DTM1), data(0x52), cmd(UC_CMD_DISPLAY_REFRESH));
    expect(seen.length).toBe(2);
    expect(Array.from(seen[0].pixels)).toEqual([4, 0]);
    expect(Array.from(seen[1].pixels)).toEqual([5, 2]);
  });
});

describe('UC8159cDecoder — refresh latching', () => {
  it('DISPLAY_REFRESH (0x12) fires onFlush; refreshedCount increments', () => {
    const seen: UC8159cFrame[] = [];
    const d = new UC8159cDecoder({
      width: 600,
      height: 448,
      onFlush: (f) => seen.push(f),
    });
    feedAll(d, cmd(UC_CMD_DISPLAY_REFRESH));
    expect(d.refreshedCount).toBe(1);
    expect(seen.length).toBe(1);
    expect(seen[0].pixels.length).toBe(600 * 448);
  });

  it('default RAM is all index-1 (white)', () => {
    const seen: UC8159cFrame[] = [];
    const d = new UC8159cDecoder({
      width: 100,
      height: 1,
      onFlush: (f) => seen.push(f),
    });
    feedAll(d, cmd(UC_CMD_DISPLAY_REFRESH));
    expect(seen[0].pixels.every((p) => p === 1)).toBe(true);
  });
});

describe('UC8159cDecoder — palette table sanity', () => {
  it('all 7 ACeP indices map to distinct RGB triples', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 7; i++) {
      const [r, g, b] = ACEP_PALETTE_RGB[i];
      seen.add(`${r},${g},${b}`);
    }
    expect(seen.size).toBe(7);
  });
});
