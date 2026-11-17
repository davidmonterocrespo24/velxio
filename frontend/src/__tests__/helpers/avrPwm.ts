/**
 * Connect every timer's output-compare units to their pins, the way
 * analogWrite() leaves TCCRnA (COMnA1/COMnB1, and COMnC1 on the Mega's 16-bit
 * timers). Tests that poke OCR registers directly need it: a duty only reaches
 * the pin while its compare unit is connected.
 */
const TCCR_A = [0x44, 0x80, 0xb0, 0x90, 0xa0, 0x120]; // timers 0..5 (3..5: ATmega2560)

export function connectAllCompareOutputs(cpu: { data: Uint8Array }): void {
  for (const addr of TCCR_A) cpu.data[addr] |= 0xa8; // COMnA1 | COMnB1 | COMnC1
}

/**
 * The same for the ATtiny85, whose COM bits live elsewhere: COM0A1 | COM0B1 in
 * TCCR0A (0x4A), COM1A1 in TCCR1 (0x50) and COM1B1 in GTCCR (0x4C), which is
 * where ATTinyCore's analogWrite() sets them.
 */
export function connectTiny85CompareOutputs(cpu: { data: Uint8Array }): void {
  cpu.data[0x4a] |= 0xa0;
  cpu.data[0x50] |= 0x20;
  cpu.data[0x4c] |= 0x20;
}
