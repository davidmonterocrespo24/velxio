/**
 * Minimal Intel HEX payloads used by AVR benchmarks.
 *
 * Inlined here (not files on disk) so each bench process pays zero I/O cost
 * before measurement starts. A bench loads the HEX once at module init.
 */

/**
 * BLINK_HEX — 5 instructions, infinite loop after setting pin 13 HIGH.
 *   LDI r16, 0xFF       ; 0F EF
 *   OUT DDRB, r16       ; 04 B9
 *   LDI r16, 0x20       ; 00 E2
 *   OUT PORTB, r16      ; 05 B9
 *   RJMP .-2            ; FF CF (infinite loop)
 */
export const BLINK_HEX = ':0A0000000FEF04B900E205B9FFCFCD\n:00000001FF\n';

/**
 * TOGGLE_HEX — toggles pin 13 every loop iteration via XOR on PORTB.
 * Used to measure CPU + port-listener overhead.
 *
 *   LDI r16, 0xFF       ; 0F EF       — DDRB high
 *   OUT 0x04, r16       ; 04 B9
 *   LDI r17, 0x20       ; 10 E2       — bit 5 mask
 *   IN  r16, 0x05       ; 05 B3       — read PORTB
 *   EOR r16, r17        ; 01 27       — toggle bit
 *   OUT 0x05, r16       ; 05 B9       — write PORTB
 *   RJMP .-6            ; FC CF       — back to IN
 */
export const TOGGLE_HEX =
  ':100000000FEF04B910E205B30127' +
  '05B9FCCFE2\n' +
  ':00000001FF\n';

/**
 * NOP_HEX — fills program memory with NOPs and rjmps back to the start.
 * The fastest possible loop; baseline for CPU dispatch overhead alone.
 *
 *   NOP × 31           ; 00 00 …
 *   RJMP .-64          ; E0 CF
 */
export function buildNopLoopHex(nopCount: number = 31): string {
  if (nopCount < 1 || nopCount > 100) {
    throw new RangeError(`buildNopLoopHex: nopCount out of range [1,100]: ${nopCount}`);
  }
  const totalBytes = nopCount * 2 + 2;
  const dataLen = totalBytes;
  const addr = '0000';
  const recordType = '00';
  const nops = '0000'.repeat(nopCount);
  // RJMP backwards: opcode 0xC000 | (offset & 0x0FFF). Offset is in words, signed.
  // We want to jump to address 0 from end. PC after RJMP is at end+2 in words.
  // offset_words = -(nopCount + 1)  → encode as 12-bit two's complement.
  const offsetWords = (-(nopCount + 1)) & 0x0fff;
  const rjmp = 0xc000 | offsetWords;
  const rjmpHi = (rjmp >> 8) & 0xff;
  const rjmpLo = rjmp & 0xff;
  const data = nops + rjmpLo.toString(16).padStart(2, '0').toUpperCase() + rjmpHi.toString(16).padStart(2, '0').toUpperCase();

  const len = dataLen.toString(16).padStart(2, '0').toUpperCase();
  // Checksum = two's complement of (len + addr_hi + addr_lo + type + data) bytes.
  let sum = dataLen;
  sum += 0x00; // addr hi
  sum += 0x00; // addr lo
  sum += 0x00; // record type
  for (let i = 0; i < data.length; i += 2) {
    sum += parseInt(data.substring(i, i + 2), 16);
  }
  const checksum = ((-sum) & 0xff).toString(16).padStart(2, '0').toUpperCase();
  return `:${len}${addr}${recordType}${data}${checksum}\n:00000001FF\n`;
}
