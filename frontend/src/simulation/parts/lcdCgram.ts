/**
 * The HD44780's custom characters, drawn by the wokwi LCD elements
 * (velxio/velxio-prod#162).
 *
 * The controller keeps eight user 5x8 patterns in CGRAM (64 bytes, written
 * after a Set CGRAM address command, as LiquidCrystal's createChar() does),
 * and character codes 0-7 draw them; bit 3 of the code has no effect, so
 * 8-15 draw the same eight (HD44780U datasheet, Table 5 note 4). The element
 * draws each code from its `font` (8 rows a glyph), whose ROM slots 0-31 are
 * blank, so the LCD parts hand it a copy of that font with slots 0-15 taken
 * from CGRAM. A CGRAM row has its leftmost dot in bit 4 (Table 5 note 3); the
 * element's font has it in bit 0.
 */
import { fontA00 } from '@wokwi/elements/dist/esm/lcd1602-font-a00';

/** A CGRAM row (leftmost dot in bit 4) as the element's font holds it (leftmost dot in bit 0). */
function mirrorRow(row: number): number {
  let out = 0;
  for (let bit = 0; bit < 5; bit++) if (row & (1 << bit)) out |= 1 << (4 - bit);
  return out;
}

/**
 * `base` (the element's font, the A00 ROM when it has none) with codes 0-7
 * and 8-15 drawn from the 64 bytes of `cgram`.
 */
export function fontWithCgram(cgram: ArrayLike<number>, base?: unknown): Uint8Array {
  const rom = base instanceof Uint8Array && base.length >= fontA00.length ? base : fontA00;
  const font = new Uint8Array(rom);
  for (let code = 0; code < 16; code++) {
    for (let row = 0; row < 8; row++) {
      font[code * 8 + row] = mirrorRow((cgram[(code & 7) * 8 + row] ?? 0) & 0x1f);
    }
  }
  return font;
}
