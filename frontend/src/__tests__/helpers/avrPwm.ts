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
