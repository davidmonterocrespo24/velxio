/**
 * ACMD13 SD_STATUS on the emulated microSD card (velxio/velxio-prod#76).
 *
 * SD Physical Layer Simplified Specification, Part 1:
 *  - 4.10.2 "SD Status", Table 4-44: the SD Status is a 512-bit register,
 *    sent MSB first, whose fields sit at fixed bit positions (511..0);
 *  - 7.3.1.3, Table 7-4 (application commands in SPI mode): ACMD13 SD_STATUS
 *    answers with R2 and then the register as a data block;
 *  - 7.3.2.3 "Format R2": two bytes, the first one is R1;
 *  - 7.3.3.2 "Start Block Tokens": a single block read starts with 0xFE, and
 *    every data block ends with its CRC16 (CCITT; 0xFFFF-filled while CRC is
 *    off, which the host then does not check).
 *
 * ESP-IDF v5's sdmmc_card_init reads the register after the SCR
 * (sdmmc_init_sd_ssr in sdmmc_sd.c, an SDMMC_INIT_STEP: its failure fails the
 * mount) and decodes DAT_BUS_WIDTH, AU_SIZE, the three erase fields and the
 * DISCARD/FULE support bits from it. Arduino's SD.h never sends ACMD13. The
 * card answered R2 and nothing more, so an IDF v5 sdspi mount clocked 0xFF
 * waiting for the start token until it timed out (sdmmc_card_init failed
 * 0x107), and the integration round trip (test/esp32js-integration
 * sd-e2e.spec.ts) skipped itself.
 */
import { describe, expect, it } from 'vitest';
import { SdSpiCard } from '../simulation/parts/sdSpiCard';

/** A selected card and a way to clock a command through it. */
function card() {
  const c = new SdSpiCard(null);
  c.setCs(true);
  /** Clock one command and `clocks` 0xFF bytes after it; what came back, from the command's first byte. */
  const command = (index: number, arg = 0, clocks = 100, crc = 0x01): number[] => {
    const frame = [0x40 | index, (arg >>> 24) & 0xff, (arg >>> 16) & 0xff, (arg >>> 8) & 0xff, arg & 0xff, crc];
    return [...frame, ...new Array<number>(clocks).fill(0xff)].map((b) => c.transfer(b));
  };
  /** The init a host runs (CMD0, CMD8, ACMD41 until ready): the card leaves the idle state. */
  const init = () => {
    command(0, 0, 2, 0x95);
    command(8, 0x1aa, 6, 0x87);
    command(55, 0, 2);
    command(41, 0x40000000, 2);
  };
  return { card: c, command, init };
}

/** The data block that follows a command's response: its 64 bytes and the two CRC bytes. */
function block(replies: number[], from: number, length: number): { data: number[]; crc: number[]; token: number } {
  const token = replies.indexOf(0xfe, from);
  expect(token, 'a start block token (0xFE) after the response').toBeGreaterThan(0);
  // Between the response and the token the card only holds the line high.
  expect(replies.slice(from, token).every((b) => b === 0xff)).toBe(true);
  return {
    token,
    data: replies.slice(token + 1, token + 1 + length),
    crc: replies.slice(token + 1 + length, token + 3 + length),
  };
}

/** Bits `msb` down to `msb - width + 1` of the 512-bit register, MSB first on the wire (Table 4-44). */
function field(reg: number[], msb: number, width: number): number {
  let v = 0;
  for (let bit = msb; bit > msb - width; bit--) {
    const fromTop = 511 - bit;
    v = v * 2 + ((reg[fromTop >> 3] >> (7 - (fromTop & 7))) & 1);
  }
  return v;
}

/** CRC-16-CCITT (x^16 + x^12 + x^5 + 1, preset 0), the data-block CRC of the SD spec (4.5). */
function crc16(data: number[]): number {
  let crc = 0;
  for (const byte of data) {
    for (let b = 7; b >= 0; b--) {
      const top = ((crc >> 15) & 1) ^ ((byte >> b) & 1);
      crc = (crc << 1) & 0xffff;
      if (top) crc ^= 0x1021;
    }
  }
  return crc;
}

describe('ACMD13 SD_STATUS (SD Physical Layer 4.10.2, 7.3.1.3): the card sends its SD Status (#76)', () => {
  it('answers R2, then the 512-bit SD Status as one 64-byte data block', () => {
    const { command, init } = card();
    init();
    command(55, 0, 2);
    const replies = command(13);
    // Nothing on the command's own six bytes, the N_CR fill byte, then R2: R1 (ready, no error) and the status byte.
    expect(replies.slice(0, 7)).toEqual(new Array(7).fill(0xff));
    expect(replies.slice(7, 9)).toEqual([0x00, 0x00]);
    const { data, crc, token } = block(replies, 9, 64);
    expect(data).toHaveLength(64);
    expect(crc).toHaveLength(2);
    // CRC off (no CMD59): the card fills the CRC field, and stops driving after the block.
    expect(crc).toEqual([0xff, 0xff]);
    expect(replies.slice(token + 67)).toEqual(new Array(replies.length - token - 67).fill(0xff));
  });

  it('describes the card this model is, field by field (Table 4-44)', () => {
    const { command, init } = card();
    init();
    command(55, 0, 2);
    const replies = command(13);
    const reg = block(replies, 9, 64).data;
    const fields: Record<string, [msb: number, width: number, want: number, why: string]> = {
      DAT_BUS_WIDTH: [511, 2, 0b00, '1 bit: SPI mode runs the bus on one data line (ACMD6 is an SD-mode command)'],
      SECURED_MODE: [509, 1, 0, 'not in secured mode'],
      SD_CARD_TYPE: [495, 16, 0x0000, 'a regular SD RD/WR card: the model takes writes'],
      SIZE_OF_PROTECTED_AREA: [479, 32, 0, 'no protected area'],
      SPEED_CLASS: [447, 8, 0x00, 'Class 0: the model makes no performance claim'],
      PERFORMANCE_MOVE: [439, 8, 0x00, 'sequential write performance not defined'],
      AU_SIZE: [431, 4, 0x0, 'allocation unit not defined (the model has no AU geometry)'],
      ERASE_SIZE: [423, 16, 0, 'erase time-out calculation not supported (the model has no erase timing)'],
      ERASE_TIMEOUT: [407, 6, 0, 'erase time-out calculation not supported'],
      ERASE_OFFSET: [401, 2, 0, 'no erase offset'],
      UHS_SPEED_GRADE: [399, 4, 0, 'not a UHS card'],
      UHS_AU_SIZE: [395, 4, 0, 'not a UHS card'],
      VIDEO_SPEED_CLASS: [391, 8, 0, 'no video speed class'],
      VSC_AU_SIZE: [377, 10, 0, 'no video speed class'],
      SUS_ADDR: [367, 22, 0, 'no suspended address'],
      APP_PERF_CLASS: [339, 4, 0, 'no application performance class'],
      PERFORMANCE_ENHANCE: [335, 8, 0, 'no performance enhancement'],
      DISCARD_SUPPORT: [313, 1, 0, 'no discard: CMD38 does not take the discard argument here'],
      FULE_SUPPORT: [312, 1, 0, 'no full user area logical erase'],
    };
    for (const [name, [msb, width, want, why]] of Object.entries(fields)) {
      expect(field(reg, msb, width), `${name} [${msb}:${msb - width + 1}]: ${why}`).toBe(want);
    }
    // Every reserved bit reads 0 (the spec's reserved fields; [311:0] is the manufacturer's, left 0).
    const reserved: Array<[number, number]> = [
      [508, 7],
      [501, 6],
      [427, 4],
      [383, 6],
      [345, 6],
      [327, 14],
      [311, 312],
    ];
    for (const [msb, width] of reserved) {
      for (let bit = msb; bit > msb - width; bit--) expect(field(reg, bit, 1), `reserved bit ${bit}`).toBe(0);
    }
  });

  it('closes the block with the CRC16 of its 64 bytes once the host turned CRC on (CMD59), as ESP-IDF does', () => {
    const { command, init } = card();
    init();
    command(59, 1, 2);
    command(55, 0, 2);
    const replies = command(13);
    const { data, crc } = block(replies, 9, 64);
    const want = crc16(data);
    expect(crc).toEqual([want >> 8, want & 0xff]);
  });

  it('leaves CMD13 SEND_STATUS (no CMD55 in front) as it was: R2 and no data block, and the card answers its next command', () => {
    const { card: c, command, init } = card();
    init();
    const status = command(13, 0, 80);
    expect(status.slice(7, 9)).toEqual([0x00, 0x00]);
    expect(status.slice(9)).toEqual(new Array(status.length - 9).fill(0xff));
    // After an ACMD13 the card is back at its command phase: the next command is a plain one again.
    command(55, 0, 2);
    command(13);
    c.loadImage(Uint8Array.from({ length: 512 }, (_, i) => (i * 3 + 1) & 0xff));
    const read = command(17, 0, 520);
    expect(read[7]).toBe(0x00);
    const { data } = block(read, 8, 512);
    expect(data).toEqual(Array.from({ length: 512 }, (_, i) => (i * 3 + 1) & 0xff));
  });
});
