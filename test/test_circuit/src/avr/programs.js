/**
 * Hand-assembled AVR programs used by the end-to-end tests.
 *
 * We cannot invoke avr-gcc in this sandbox, so we hand-roll the opcodes.
 * Each builder returns a Uint16Array ready to feed to AVRHarness.loadProgram().
 */
import { LDI, OUT, STS, LDS, RJMP, SBRC, assemble } from './asm.js';

/**
 * ADC-read-and-store sketch:
 *   setup:
 *     - ADMUX  = 0x60        ; AVCC ref, ADLAR=1, channel 0 (A0)
 *     - ADCSRA = 0x87        ; enable, /128 prescaler
 *   loop:
 *     - start conversion, wait
 *     - copy ADCH → r20      (keeps latest reading in a known register)
 *     - copy ADCL → r21
 *     - loop
 *
 * After running a few thousand cycles, the host can read the ADC result
 * from either r20 (high byte, left-adjusted = top 8 bits of the 10-bit value)
 * or ADCH/ADCL via cpu.data[].
 */
export function adcReadProgram() {
  return assemble([
    LDI(16, 0x60), STS(0x7C, 16),   // ADMUX
    LDI(16, 0x87), STS(0x7A, 16),   // ADCSRA
    // loop
    LDI(17, 0xC7), STS(0x7A, 17),   // start conversion
    LDS(17, 0x7A),                  // read ADCSRA
    SBRC(17, 6),                    // skip RJMP if ADSC clear
    RJMP(-4),
    LDS(20, 0x79),                  // ADCH → r20
    LDS(21, 0x78),                  // ADCL → r21
    RJMP(-12),                      // back to 'start conversion' (word 6)
  ]);
}

/**
 * Pot-to-PWM sketch:
 *   setup:
 *     - DDRD |= (1<<6)       ; pin 6 as output (OC0A / Timer0A PWM)
 *     - TCCR0A = 0x83        ; Fast PWM 8-bit, COM0A1 non-inverting
 *     - TCCR0B = 0x01        ; no prescaler
 *     - ADMUX  = 0x60        ; AVCC ref, ADLAR=1, channel 0 (A0)
 *     - ADCSRA = 0x87        ; ADC enable, prescaler 128
 *   loop:
 *     - ADCSRA |= (1<<ADSC)  ; start conversion (write 0xC7)
 *     - wait while ADSC set
 *     - load ADCH  (upper 8 bits of 10-bit result = ADCL>>2)
 *     - OCR0A = ADCH         ; PWM duty = ADC high byte
 *     - loop
 */
export function potToPwmProgram() {
  // Word layout:
  //  0: LDI r16, 0x40
  //  1: OUT DDRD (0x0A), r16
  //  2: LDI r16, 0x83
  //  3: OUT TCCR0A (0x24), r16
  //  4: LDI r16, 0x01
  //  5: OUT TCCR0B (0x25), r16
  //  6: LDI r16, 0x40
  //  7-8: STS ADMUX  (0x7C), r16
  //  9: LDI r16, 0x87
  // 10-11: STS ADCSRA (0x7A), r16
  //   ── loop @ 12 ──
  // 12: LDI r17, 0xC7
  // 13-14: STS ADCSRA (0x7A), r17
  //   ── wait @ 15 ──
  // 15-16: LDS r17, ADCSRA (0x7A)
  // 17: SBRC r17, 6           ; skip if ADSC bit is CLEAR (conversion done)
  // 18: RJMP -4               ; back to 15
  // 19-20: LDS r17, ADCH (0x79)
  // 21: OUT OCR0A (0x27), r17
  // 22: RJMP -11              ; back to 12
  return assemble([
    LDI(16, 0x40),
    OUT(0x0A, 16),
    LDI(16, 0x83),
    OUT(0x24, 16),
    LDI(16, 0x01),
    OUT(0x25, 16),
    LDI(16, 0x60),
    STS(0x7C, 16),
    LDI(16, 0x87),
    STS(0x7A, 16),
    LDI(17, 0xC7),
    STS(0x7A, 17),
    LDS(17, 0x7A),
    SBRC(17, 6),
    RJMP(-4),
    LDS(17, 0x79),
    OUT(0x27, 17),
    RJMP(-11),
  ]);
}
