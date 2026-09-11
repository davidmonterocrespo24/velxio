/**
 * oneWireHost — the byte-level 1-Wire master a board simulator lets a part
 * register on one of its pins.
 *
 * Why a type of its own: a Linux guest reads its 1-Wire sensors through the
 * kernel's w1 bus (`/sys/bus/w1/devices/28-<id>/w1_slave`), and an in-browser
 * Python engine reads them through the same file names. Neither side can
 * bit-bang the line in real time, so the board answers *bus operations*
 * (reset, a byte, a block, a search triplet) rather than edges, and whoever
 * models the sensor implements this interface over its own state. The board
 * shim owns the pin -> master table and the request grammar
 * (`W1 <pin> RESET | RB | WB <hex> | RBLK <n> | WBLK <hex> | TRIPLET <d>`);
 * the part owns the protocol. A DS18B20 model is one implementation; nothing
 * here knows its name.
 */

export interface OneWireByteMaster {
  /** Reset pulse. True when at least one slave answered with presence. */
  reset(): boolean;
  /** One bit slot: write `bit` (1 = release), return what the line read. */
  touchBit(bit: 0 | 1): 0 | 1;
  readBit(): 0 | 1;
  writeBit(bit: 0 | 1): void;
  readByte(): number;
  writeByte(value: number): void;
  readBlock(length: number): number[];
  writeBlock(bytes: number[]): void;
  /**
   * One ROM-search step: read the id bit and its complement, then write the
   * direction taken. Returns [idBit, cmpBit, directionWritten].
   */
  triplet(direction: 0 | 1): [0 | 1, 0 | 1, 0 | 1];
  /** ROM ids of every slave on the line, as 16-char lowercase hex. */
  roms(): string[];
}
