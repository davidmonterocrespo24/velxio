/**
 * Tiny hand-rolled AVR assembler for the few opcodes we need to build
 * test programs without an avr-gcc toolchain.
 *
 * Only the instructions exercised by the test suites are implemented.
 * All addresses / offsets use AVR's word-addressed convention.
 */

/** LDI Rd, K — Rd ∈ [16..31], K ∈ [0..255]
 * Encoding: 1110 KKKK dddd KKKK
 */
export const LDI = (rd, k) => {
  if (rd < 16 || rd > 31) throw new Error(`LDI: rd=${rd} out of range`);
  if (k < 0 || k > 255) throw new Error(`LDI: k=${k} out of range`);
  const d = rd - 16;
  return 0xE000 | ((k & 0xF0) << 4) | (d << 4) | (k & 0x0F);
};

/** OUT A, Rr — A ∈ [0..63], Rr ∈ [0..31]
 * Encoding: 1011 1AAr rrrr AAAA
 */
export const OUT = (A, rr) => {
  if (A < 0 || A > 63) throw new Error(`OUT: A=${A} out of range`);
  return 0xB800 | ((A & 0x30) << 5) | (rr << 4) | (A & 0x0F);
};

/** IN Rd, A — Rd ∈ [0..31], A ∈ [0..63]
 * Encoding: 1011 0AAd dddd AAAA
 */
export const IN = (rd, A) => {
  return 0xB000 | ((A & 0x30) << 5) | (rd << 4) | (A & 0x0F);
};

/** STS k, Rr — 32-bit instruction, k ∈ [0..65535], Rr ∈ [0..31]
 * Encoding: 1001 001r rrrr 0000  kkkkkkkk kkkkkkkk
 * Returns [word1, word2].
 */
export const STS = (k, rr) => {
  const w1 = 0x9200 | ((rr & 0x10) << 4) | ((rr & 0x0F) << 4);
  return [w1, k & 0xFFFF];
};

/** LDS Rd, k — 32-bit instruction
 * Encoding: 1001 000d dddd 0000  kkkkkkkk kkkkkkkk
 */
export const LDS = (rd, k) => {
  const w1 = 0x9000 | ((rd & 0x10) << 4) | ((rd & 0x0F) << 4);
  return [w1, k & 0xFFFF];
};

/** RJMP — jump by signed word offset from PC+1
 * Encoding: 1100 kkkk kkkk kkkk  (12-bit signed)
 */
export const RJMP = (offset) => {
  const k = offset & 0xFFF;
  return 0xC000 | k;
};

/** SBRC Rr, b — Skip if Bit in Register Clear
 * Encoding: 1111 110r rrrr 0bbb
 */
export const SBRC = (rr, b) => {
  return 0xFC00 | (rr << 4) | (b & 0x07);
};

/** SBRS Rr, b — Skip if Bit in Register Set
 * Encoding: 1111 111r rrrr 0bbb
 */
export const SBRS = (rr, b) => {
  return 0xFE00 | (rr << 4) | (b & 0x07);
};

/** NOP */
export const NOP = () => 0x0000;

/**
 * Assemble a flat list of values (each either a number = 1 word, or an
 * array [w1, w2] = two words) into a Uint16Array.
 */
export function assemble(items) {
  const flat = [];
  for (const it of items) {
    if (Array.isArray(it)) flat.push(...it);
    else flat.push(it);
  }
  return Uint16Array.from(flat);
}
