import {
  CPU,
  AVRTimer,
  timer0Config,
  timer1Config,
  timer2Config,
  AVRUSART,
  usart0Config,
  AVRIOPort,
  portAConfig,
  portBConfig,
  portCConfig,
  portDConfig,
  portEConfig,
  portFConfig,
  portGConfig,
  portHConfig,
  portJConfig,
  portKConfig,
  portLConfig,
  avrInstruction,
  AVRADC,
  adcConfig,
  AVRSPI,
  spiConfig,
  AVRTWI,
  twiConfig,
  ATtinyTimer1,
  attinyTimer1Config,
  AVREEPROM,
  EEPROMMemoryBackend,
  eepromConfig,
  AVRUSI,
} from 'avr8js';
import type {
  AVREEPROMConfig,
  AVRExternalInterrupt,
  AVRPinChangeInterrupt,
  AVRPortConfig,
  SPIConfig,
  TWIConfig,
} from 'avr8js';
import type { AVRTimerConfig } from 'avr8js/dist/esm/peripherals/timer';
import type { AVRInterruptConfig } from 'avr8js/dist/esm/cpu/cpu';
import type { ADCConfig, ADCMuxConfiguration } from 'avr8js/dist/esm/peripherals/adc';
import { ADCMuxInputType, ADCReference } from 'avr8js/dist/esm/peripherals/adc';
import { PinManager } from './PinManager';
import type {
  BusCapableSimulator,
  EngineBinding,
  GuestClock,
  SpiControllerConfig,
  SpiControllerPort,
  SpiMode,
  SpiRouting,
  UartConfig,
  UartControllerPort,
  UartRouting,
} from './buses/types';
import { ExternalPinScopeFeed } from './externalPinScope';
import type { LineCapable, LineHostPort, LineSupport } from './line/LineHost';
import { LineSensorHub } from './line/LineSensorHub';
import { hexToUint8Array } from '../utils/hexParser';
import type { SerialLink } from '../store/serialWire';
import { I2CBusManager, nullI2CMaster } from './I2CBusManager';
import { boardPinsFromPinManager } from './buses/boardPins';
import { I2cScopeSynth, SpiScopeSynth, type ScopeSink } from './busScope';
import { ATMEGA328P_TABLE, ATMEGA2560_TABLE } from './buses/boardPinTables/avr';

/**
 * AVRSimulator - Emulates Arduino Uno (ATmega328p) using avr8js
 *
 * Features:
 * - CPU emulation at 16MHz
 * - Timer0/Timer1/Timer2 support (enables millis(), delay(), PWM)
 * - USART support (Serial)
 * - GPIO ports (PORTB, PORTC, PORTD)
 * - ADC support (analogRead())
 * - PWM monitoring via OCR register polling
 * - Pin state tracking via PinManager
 */

interface PwmPinDef {
  ocrAddr: number;
  pin: number;
  label: string;
  /** Data address of the register holding the channel's COMnx bits (TCCRnA;
   *  TCCR1 / GTCCR on the ATtiny85) and their mask. Absent: always connected. */
  comAddr?: number;
  comMask?: number;
  /** The timer the channel belongs to, for the duty its mode gives (pwmDuty); absent on the ATtiny85's Timer1. */
  timer?: PwmTimer;
}

/**
 * A timer's registers, as the duty of its compare outputs needs them
 * (velxio/velxio-prod#155). Data-space addresses, the same on the ATmega328P
 * and the ATmega2560 for Timers 0-2.
 */
interface PwmTimer {
  /** A 16-bit timer: OCRn, ICRn and its TOP are read as two bytes. */
  wide: boolean;
  tccrA: number;
  tccrB: number;
  /** OCRnA, TOP in the modes that count to it. */
  ocrA: number;
  /** ICRn (16-bit timers), TOP in the modes that count to it. */
  icr?: number;
}

const TIMER0: PwmTimer = { wide: false, tccrA: 0x44, tccrB: 0x45, ocrA: 0x47 };
const TIMER1: PwmTimer = { wide: true, tccrA: 0x80, tccrB: 0x81, ocrA: 0x88, icr: 0x86 };
const TIMER2: PwmTimer = { wide: false, tccrA: 0xb0, tccrB: 0xb1, ocrA: 0xb3 };
const TIMER3: PwmTimer = { wide: true, tccrA: 0x90, tccrB: 0x91, ocrA: 0x98, icr: 0x96 };
const TIMER4: PwmTimer = { wide: true, tccrA: 0xa0, tccrB: 0xa1, ocrA: 0xa8, icr: 0xa6 };
const TIMER5: PwmTimer = { wide: true, tccrA: 0x120, tccrB: 0x121, ocrA: 0x128, icr: 0x126 };
/**
 * The ATtiny85's Timer0: the ATmega's 8-bit timer at its own addresses
 * (ATtiny25/45/85 datasheet, chapter 11). ATTinyCore runs it in fast PWM like
 * the Uno's, so analogWrite on PB0 and PB1 is (OCR + 1)/256 too.
 */
const TINY85_TIMER0: PwmTimer = { wide: false, tccrA: 0x4a, tccrB: 0x53, ocrA: 0x49 };

/**
 * A waveform generation mode: the PWM it makes (null for Normal, CTC and the
 * reserved modes), its TOP, and whether COMnA = 01 toggles OCnA in it.
 */
interface WaveMode {
  pwm: 'fast' | 'phase' | null;
  top: number | 'ocra' | 'icr';
  toggleA: boolean;
}
const mode = (pwm: WaveMode['pwm'], top: WaveMode['top'], toggleA = false): WaveMode => ({ pwm, top, toggleA });
/** WGM02:0 of the 8-bit timers (ATmega328P datasheet Tables 15-8 and 18-8). */
const WGM_8BIT: readonly WaveMode[] = [
  mode(null, 0xff),
  mode('phase', 0xff),
  mode(null, 'ocra'),
  mode('fast', 0xff),
  mode(null, 0xff),
  mode('phase', 'ocra', true),
  mode(null, 0xff),
  mode('fast', 'ocra', true),
];
/** WGMn3:0 of the 16-bit timers (Table 16-4); phase and frequency correct counts as phase correct. */
const WGM_16BIT: readonly WaveMode[] = [
  mode(null, 0xffff),
  mode('phase', 0xff),
  mode('phase', 0x1ff),
  mode('phase', 0x3ff),
  mode(null, 'ocra'),
  mode('fast', 0xff),
  mode('fast', 0x1ff),
  mode('fast', 0x3ff),
  mode('phase', 'icr'),
  mode('phase', 'ocra', true),
  mode('phase', 'icr'),
  mode('phase', 'ocra', true),
  mode(null, 'icr'),
  mode(null, 0xffff),
  mode('fast', 'icr', true),
  mode('fast', 'ocra', true),
];

/**
 * The share of the period a compare output holds its pin HIGH, from the
 * timer's live registers (velxio/velxio-prod#155); 0 while the channel is
 * disconnected from the pin (COMnx = 00, how analogWrite(pin, 0) and
 * analogWrite(pin, 255) leave it).
 *
 * Fast PWM sets the pin at BOTTOM and clears it on the compare match, one
 * timer tick after OCR: HIGH for OCR + 1 of TOP + 1 ticks (datasheet section
 * 15.7.3: OCR at BOTTOM is a one-tick spike, OCR at MAX a constant HIGH).
 * Phase correct PWM is HIGH for OCR of TOP. Inverting (COMnx = 11) is the
 * complement; COMnA = 01 toggles OCnA where the mode allows it, a 50 % wave.
 * The circuit used OCR / 255 for every timer: right for the Uno's
 * phase-correct pins (3, 9, 10, 11), slightly low for Timer0's fast PWM pins
 * (5 and 6; 4 and 13 on the Mega), and blind to the 16-bit timers' TOP and
 * high bytes. Normal and CTC modes, which are not PWM, keep that old figure.
 */
function pwmDuty(data: Uint8Array, def: PwmPinDef): number {
  const timer = def.timer;
  if (!timer || def.comMask === undefined) {
    const connected = def.comAddr === undefined || (data[def.comAddr] & (def.comMask ?? 0)) !== 0;
    return connected ? data[def.ocrAddr] / 255 : 0;
  }
  const shift = def.comMask === 0xc0 ? 6 : def.comMask === 0x30 ? 4 : 2;
  const com = (data[timer.tccrA] & def.comMask) >> shift;
  if (com === 0) return 0;
  const tccrA = data[timer.tccrA];
  const tccrB = data[timer.tccrB];
  const wave = timer.wide
    ? WGM_16BIT[((tccrB & 0x18) >> 1) | (tccrA & 0x03)]
    : WGM_8BIT[((tccrB & 0x08) >> 1) | (tccrA & 0x03)];
  if (!wave.pwm) return data[def.ocrAddr] / 255;
  if (com === 1) return shift === 6 && wave.toggleA ? 0.5 : 0;
  const read = (addr: number) => (timer.wide ? data[addr] | (data[addr + 1] << 8) : data[addr]);
  const top =
    wave.top === 'ocra' ? read(timer.ocrA) : wave.top === 'icr' ? read(timer.icr ?? 0) : wave.top;
  const ocr = read(def.ocrAddr);
  const high =
    wave.pwm === 'fast' ? Math.min(1, (ocr + 1) / (top + 1)) : top > 0 ? Math.min(1, ocr / top) : 1;
  return com === 3 ? 1 - high : high;
}

// OCR register addresses → Arduino pin mapping for PWM (ATmega328P / Uno / Nano).
// comAddr/comMask: the channel's COMnx bits in TCCRnA. While they are 0 the
// compare unit is disconnected from the pin and the pin is a plain GPIO, which
// is how the Arduino core implements analogWrite(pin, 0) and
// analogWrite(pin, 255): digitalWrite, OCR left as it was. Reading OCR alone
// kept reporting the last duty, so the circuit solver held the pin at that
// average voltage after analogWrite(0).
const PWM_PINS_UNO: PwmPinDef[] = [
  { ocrAddr: 0x47, pin: 6, label: 'OCR0A', comAddr: 0x44, comMask: 0xc0, timer: TIMER0 }, // Timer0A → D6
  { ocrAddr: 0x48, pin: 5, label: 'OCR0B', comAddr: 0x44, comMask: 0x30, timer: TIMER0 }, // Timer0B → D5
  { ocrAddr: 0x88, pin: 9, label: 'OCR1AL', comAddr: 0x80, comMask: 0xc0, timer: TIMER1 }, // Timer1A → D9
  { ocrAddr: 0x8a, pin: 10, label: 'OCR1BL', comAddr: 0x80, comMask: 0x30, timer: TIMER1 }, // Timer1B → D10
  { ocrAddr: 0xb3, pin: 11, label: 'OCR2A', comAddr: 0xb0, comMask: 0xc0, timer: TIMER2 }, // Timer2A → D11
  { ocrAddr: 0xb4, pin: 3, label: 'OCR2B', comAddr: 0xb0, comMask: 0x30, timer: TIMER2 }, // Timer2B → D3
];

// OCR register addresses → Arduino Mega pin mapping for PWM (ATmega2560)
// Timers 0/1/2 same addresses; Timers 3/4/5 at higher addresses.
const PWM_PINS_MEGA: PwmPinDef[] = [
  { ocrAddr: 0x47, pin: 13, label: 'OCR0A', comAddr: 0x44, comMask: 0xc0, timer: TIMER0 }, // Timer0A → D13
  { ocrAddr: 0x48, pin: 4, label: 'OCR0B', comAddr: 0x44, comMask: 0x30, timer: TIMER0 }, // Timer0B → D4
  { ocrAddr: 0x88, pin: 11, label: 'OCR1AL', comAddr: 0x80, comMask: 0xc0, timer: TIMER1 }, // Timer1A → D11
  { ocrAddr: 0x8a, pin: 12, label: 'OCR1BL', comAddr: 0x80, comMask: 0x30, timer: TIMER1 }, // Timer1B → D12
  { ocrAddr: 0xb3, pin: 10, label: 'OCR2A', comAddr: 0xb0, comMask: 0xc0, timer: TIMER2 }, // Timer2A → D10
  { ocrAddr: 0xb4, pin: 9, label: 'OCR2B', comAddr: 0xb0, comMask: 0x30, timer: TIMER2 }, // Timer2B → D9
  // Timer3 (0x80–0x8D, but OCR3A/B/C at 0x98/0x9A/0x9C)
  { ocrAddr: 0x98, pin: 5, label: 'OCR3AL', comAddr: 0x90, comMask: 0xc0, timer: TIMER3 }, // Timer3A → D5
  { ocrAddr: 0x9a, pin: 2, label: 'OCR3BL', comAddr: 0x90, comMask: 0x30, timer: TIMER3 }, // Timer3B → D2
  { ocrAddr: 0x9c, pin: 3, label: 'OCR3CL', comAddr: 0x90, comMask: 0x0c, timer: TIMER3 }, // Timer3C → D3
  // Timer4 (OCR4A/B/C at 0xA8/0xAA/0xAC)
  { ocrAddr: 0xa8, pin: 6, label: 'OCR4AL', comAddr: 0xa0, comMask: 0xc0, timer: TIMER4 }, // Timer4A → D6
  { ocrAddr: 0xaa, pin: 7, label: 'OCR4BL', comAddr: 0xa0, comMask: 0x30, timer: TIMER4 }, // Timer4B → D7
  { ocrAddr: 0xac, pin: 8, label: 'OCR4CL', comAddr: 0xa0, comMask: 0x0c, timer: TIMER4 }, // Timer4C → D8
  // Timer5 (OCR5A/B/C at 0x128/0x12A/0x12C — extended I/O)
  { ocrAddr: 0x128, pin: 46, label: 'OCR5AL', comAddr: 0x120, comMask: 0xc0, timer: TIMER5 }, // Timer5A → D46
  { ocrAddr: 0x12a, pin: 45, label: 'OCR5BL', comAddr: 0x120, comMask: 0x30, timer: TIMER5 }, // Timer5B → D45
  { ocrAddr: 0x12c, pin: 44, label: 'OCR5CL', comAddr: 0x120, comMask: 0x0c, timer: TIMER5 }, // Timer5C → D44
];

/**
 * ATmega2560 port-bit → Arduino Mega pin mapping.
 * Index = bit position (0–7).  -1 = not exposed on the Arduino Mega header.
 */
const MEGA_PORT_BIT_MAP: Record<string, number[]> = {
  // PA0-PA7 → D22-D29
  PORTA: [22, 23, 24, 25, 26, 27, 28, 29],
  // PB0=D53(SS), PB1=D52(SCK), PB2=D51(MOSI), PB3=D50(MISO), PB4-PB7=D10-D13
  PORTB: [53, 52, 51, 50, 10, 11, 12, 13],
  // PC0-PC7 → D37, D36, D35, D34, D33, D32, D31, D30  (reversed)
  PORTC: [37, 36, 35, 34, 33, 32, 31, 30],
  // PD0=D21(SCL), PD1=D20(SDA), PD2=D19(RX1), PD3=D18(TX1), PD7=D38
  PORTD: [21, 20, 19, 18, -1, -1, -1, 38],
  // PE0=D0(RX0), PE1=D1(TX0), PE3=D5, PE4=D2, PE5=D3
  PORTE: [0, 1, -1, 5, 2, 3, -1, -1],
  // PF0-PF7 → A0-A7 (pin numbers 54-61)
  PORTF: [54, 55, 56, 57, 58, 59, 60, 61],
  // PG0=D41, PG1=D40, PG2=D39, PG5=D4
  PORTG: [41, 40, 39, -1, -1, 4, -1, -1],
  // PH0=D17(RX2), PH1=D16(TX2), PH3=D6, PH4=D7, PH5=D8, PH6=D9
  PORTH: [17, 16, -1, 6, 7, 8, 9, -1],
  // PJ0=D15(RX3), PJ1=D14(TX3)
  PORTJ: [15, 14, -1, -1, -1, -1, -1, -1],
  // PK0-PK7 → A8-A15 (pin numbers 62-69)
  PORTK: [62, 63, 64, 65, 66, 67, 68, 69],
  // PL0=D49, PL1=D48, PL2=D47, PL3=D46, PL4=D45, PL5=D44, PL6=D43, PL7=D42
  PORTL: [49, 48, 47, 46, 45, 44, 43, 42],
};

/**
 * Reverse of MEGA_PORT_BIT_MAP: Arduino Mega pin → { portName, bit }.
 * Pre-built for fast setPinState() lookups.
 */
const MEGA_PIN_TO_PORT = (() => {
  const map: Record<number, { portName: string; bit: number; port?: AVRIOPort }> = {};
  for (const [portName, pins] of Object.entries(MEGA_PORT_BIT_MAP)) {
    pins.forEach((pin, bit) => {
      if (pin >= 0) map[pin] = { portName, bit };
    });
  }
  return map;
})();

// OCR register addresses → ATtiny85 pin mapping for PWM
// Timer0: OC0A→PB0, OC0B→PB1. ATtiny85 OCR0A = I/O 0x09 → data 0x49,
//         OCR0B = I/O 0x08 → data 0x48 (verified vs the ATTinyCore
//         analogWrite disassembly: `out 0x29,OCR0A` / `out 0x28,OCR0B`).
//         The old 0x56/0x5C values were WRONG — they point at PINB (0x56)
//         and EECR (0x5C), so analogWrite() duty was never read and PWM
//         examples (e.g. attiny85-pwm-fade) showed no fade.
// Timer1: OC1A→PB1, OC1B→PB4 (ATtinyTimer1 OCR regs from attinyTimer1Config)
// COM bits: Timer0's COM0A/COM0B in TCCR0A (0x4A), Timer1's COM1A in TCCR1
// (0x50) and COM1B in GTCCR (0x4C). ATTinyCore's analogWrite(pin, 0/255) is
// digitalWrite after turnOffPWM, which clears those bits and leaves OCR as it
// was, as on the Uno; without them the last duty stuck (velxio/velxio-prod#141).
// They also decide which of PB1's two channels (OC0B, OC1A) drives it.
// Timer0's channels take the duty of its mode (pwmDuty), as on the ATmega;
// Timer1's PWM is its own (TOP in OCR1C) and keeps OCR/255.
const PWM_PINS_TINY85: PwmPinDef[] = [
  { ocrAddr: 0x49, pin: 0, label: 'OCR0A', comAddr: 0x4a, comMask: 0xc0, timer: TINY85_TIMER0 }, // Timer0A → PB0
  { ocrAddr: 0x48, pin: 1, label: 'OCR0B', comAddr: 0x4a, comMask: 0x30, timer: TINY85_TIMER0 }, // Timer0B → PB1
  { ocrAddr: 0x4e, pin: 1, label: 'OCR1A', comAddr: 0x50, comMask: 0x30 }, // Timer1A → PB1 (attinyTimer1Config.OCR1A)
  { ocrAddr: 0x4b, pin: 4, label: 'OCR1B', comAddr: 0x4c, comMask: 0x30 }, // Timer1B → PB4 (attinyTimer1Config.OCR1B)
];

/**
 * ATtiny85 PORTB config — registers are at different addresses than ATmega328P.
 * ATtiny85: PINB=0x36, DDRB=0x37, PORTB=0x38  (vs ATmega: 0x23/0x24/0x25)
 */
const attiny85PortBConfig = {
  PIN: 0x36,
  DDR: 0x37,
  PORT: 0x38,
  externalInterrupts: [] as never[],
};

/**
 * ATtiny85 Timer0 config — Arduino `millis()` / `delay()` rely on the
 * TIMER0_OVF interrupt to tick the millisecond counter. avr8js's generic
 * `AVRTimer` is fully data-driven, so we just supply ATtiny85's register
 * addresses (different from the ATmega328P defaults in `timer0Config`)
 * and the right interrupt vector offsets.
 *
 * Refs: <avr/iotnx5.h> for register addresses; ATtiny25/45/85 datasheet
 * (Atmel-2586) for vector indices.
 *   _VECTOR(5)  → TIMER0_OVF   → word 0x0A
 *   _VECTOR(10) → TIMER0_COMPA → word 0x14
 *   _VECTOR(11) → TIMER0_COMPB → word 0x16
 */
/**
 * ATtiny85 ADC config — required because the chip's ADC registers live at
 * completely different memory addresses than the ATmega328P defaults that
 * avr8js's `adcConfig` ships with. Without this, `analogRead()` writes
 * ADSC at ATtiny85's ADCSRA (0x26) and polls forever because avr8js is
 * listening at 0x7A instead.
 *
 * Refs: <avr/iotnx5.h>; ATtiny25/45/85 datasheet (Atmel-2586) sec. 17.
 *   ADMUX  = 0x07 (I/O) -> 0x27 (mem)
 *   ADCSRA = 0x06       -> 0x26
 *   ADCSRB = 0x03       -> 0x23
 *   ADCL   = 0x04       -> 0x24
 *   ADCH   = 0x05       -> 0x25
 *   DIDR0  = 0x14       -> 0x34
 *   ADC_vect = _VECTOR(8) -> word 0x10
 *
 * MUX field is 4 bits (bits 3:0). Single-ended channels 0..3 = PB5/PB2/PB4/PB3.
 * Reference bits REFS1:REFS0 at ADMUX[7:6] select VCC/AREF/Internal1V1 by default;
 * full REFS2 extension lives at ADMUX[4] but the avr8js helper checks bit 3,
 * so the rare 2.56 V internal reference is currently unsupported — every
 * default-ref sketch (`analogReference(DEFAULT)`) works fine.
 */
const attiny85AdcChannels: ADCMuxConfiguration = {
  0: { type: ADCMuxInputType.SingleEnded, channel: 0 }, // PB5
  1: { type: ADCMuxInputType.SingleEnded, channel: 1 }, // PB2
  2: { type: ADCMuxInputType.SingleEnded, channel: 2 }, // PB4
  3: { type: ADCMuxInputType.SingleEnded, channel: 3 }, // PB3
  12: { type: ADCMuxInputType.Constant, voltage: 1.1 }, // VBG
  13: { type: ADCMuxInputType.Constant, voltage: 0 }, // GND
  15: { type: ADCMuxInputType.Temperature },
};

const attiny85AdcConfig: ADCConfig = {
  ADMUX: 0x27,
  ADCSRA: 0x26,
  ADCSRB: 0x23,
  ADCL: 0x24,
  ADCH: 0x25,
  DIDR0: 0x34,
  // ATtiny85 vectors are 1-word RJMP (vs ATmega328P's 2-word JMP) so the
  // avr8js "address" field is the raw vector index, not vector*2.
  adcInterrupt: 0x08, // _VECTOR(8) ADC_vect
  numChannels: 4,
  muxInputMask: 0xf,
  muxChannels: attiny85AdcChannels,
  adcReferences: [
    ADCReference.AVCC, // 00 = VCC
    ADCReference.AREF, // 01 = external AREF (PB0)
    ADCReference.Internal1V1, // 10 = internal 1.1 V
    ADCReference.Reserved, // 11 = reserved
  ],
};

// ATtiny85 EEPROM register map. avr8js's default eepromConfig targets the
// ATmega328P (EECR 0x3F …); the ATtiny85 keeps the same EECR bit layout but
// at different data-space addresses (I/O addr + 0x20, e.g. EECR I/O 0x1C →
// 0x3C). Vectors are 1-word RJMP so the ready-interrupt is the raw index
// (_VECTOR(6) EE_RDY). The Arduino EEPROM library polls EEPE rather than
// using the interrupt, so only the register addresses matter in practice.
const attiny85EepromConfig: typeof eepromConfig = {
  eepromReadyInterrupt: 0x06,
  EECR: 0x3c,
  EEDR: 0x3d,
  EEARL: 0x3e,
  EEARH: 0x3f,
  eraseCycles: 28800,
  writeCycles: 28800,
};

const attiny85Timer0Config: AVRTimerConfig = {
  bits: 8,
  captureInterrupt: 0,
  // ATtiny85 vectors are 1-word RJMP (vs ATmega328P's 2-word JMP) so the
  // avr8js "address" field is the raw vector index, not vector*2.
  compAInterrupt: 0x0a, // _VECTOR(10) TIMER0_COMPA_vect
  compBInterrupt: 0x0b, // _VECTOR(11) TIMER0_COMPB_vect
  compCInterrupt: 0,
  ovfInterrupt: 0x05, // _VECTOR(5)  TIMER0_OVF_vect
  TIFR: 0x58,
  // ATtiny85 Timer0 data-space addresses (I/O + 0x20), verified against the
  // ATTinyCore disassembly: TCCR0A `out 0x2a`→0x4A, OCR0A `out 0x29`→0x49,
  // OCR0B `out 0x28`→0x48. The old 0x4f/0x56/0x5c were wrong (TCNT1/PINB/EECR)
  // which broke analogWrite()/PWM on the ATtiny85.
  OCRA: 0x49,
  OCRB: 0x48,
  OCRC: 0,
  ICR: 0,
  TCNT: 0x52,
  TCCRA: 0x4a,
  TCCRB: 0x53,
  TCCRC: 0,
  TIMSK: 0x59,
  TOV: 0b00000010,
  OCFA: 0b00010000,
  OCFB: 0b00001000,
  OCFC: 0,
  TOIE: 0b00000010,
  OCIEA: 0b00010000,
  OCIEB: 0b00001000,
  OCIEC: 0,
  compPortA: 0x38,
  compPinA: 0,
  compPortB: 0x38,
  compPinB: 1,
  compPortC: 0,
  compPinC: 0,
  externalClockPort: 0x36,
  externalClockPin: 2,
  dividers: { 0: 0, 1: 1, 2: 8, 3: 64, 4: 256, 5: 1024, 6: 0, 7: 0 },
};

/**
 * ── ATmega2560 interrupt wiring ─────────────────────────────────────────────
 *
 * avr8js's port configs carry the ATmega328P's interrupt vectors, and the
 * Mega used them as they came: PCINT0 at word 6, which on the ATmega2560 is
 * INT2's slot. A SoftwareSerial receiver on pin 10 (PB4) enables PCINT0, so
 * the first edge from the other board vectored the core into an INT2 the
 * sketch never defined; avr-libc's __bad_interrupt jumps to the reset vector,
 * and the board rebooted on every byte ("RReRRReceiver Ready...", #397).
 * PORTC and PORTD carried pin-change interrupts the chip does not have, and
 * PORTE's INT4/INT5 (pins 2 and 3, the Mega's usual attachInterrupt pins)
 * were not wired at all.
 *
 * The 2560's vectors are 4 bytes (JMP), so vector n sits at word 2n
 * (iomxx0_1.h): INT0..INT7 = 1..8, PCINT0..PCINT2 = 9..11. Registers: EICRA
 * 0x69 (ISC00..ISC31), EICRB 0x6a (ISC40..ISC71), EIMSK 0x3d, EIFR 0x3c,
 * PCICR 0x68, PCIFR 0x3b, PCMSK0..2 0x6b..0x6d. Pins:
 *   INT0..INT3   PD0..PD3  D21, D20, D19, D18
 *   INT4..INT7   PE4..PE7  D2, D3, then two pads the header leaves out
 *   PCINT0..7    PB0..PB7  D53, D52, D51, D50, D10..D13
 *   PCINT8       PE0       D0
 *   PCINT9..15   PJ0..PJ6  D15, D14, then pads the header leaves out
 *   PCINT16..23  PK0..PK7  A8..A15
 */
const megaExtInt = (n: number): AVRExternalInterrupt => ({
  EICR: n < 4 ? 0x69 : 0x6a,
  EIMSK: 0x3d,
  EIFR: 0x3c,
  index: n,
  iscOffset: (n % 4) * 2,
  interrupt: 2 + 2 * n,
});

/** PCINTn's group: `mask` says which port bits belong to it, `offset` where
 *  bit 0 of the port sits in PCMSKn. */
const megaPinChange = (n: number, mask: number, offset: number): AVRPinChangeInterrupt => ({
  PCIE: n,
  PCICR: 0x68,
  PCIFR: 0x3b,
  PCMSK: 0x6b + n,
  pinChangeInterrupt: 18 + 2 * n,
  mask,
  offset,
});

/** A port's registers alone: the ATmega328P interrupts avr8js attaches to
 *  the same letter do not apply here. */
const megaPortRegs = (c: AVRPortConfig): Pick<AVRPortConfig, 'PIN' | 'DDR' | 'PORT'> => ({
  PIN: c.PIN,
  DDR: c.DDR,
  PORT: c.PORT,
});

/** Ordered list of Mega ports with their configs */
const MEGA_PORT_CONFIGS: Array<{ name: string; config: AVRPortConfig }> = [
  { name: 'PORTA', config: portAConfig },
  {
    name: 'PORTB',
    config: {
      ...megaPortRegs(portBConfig),
      pinChange: megaPinChange(0, 0xff, 0),
      externalInterrupts: [],
    },
  },
  { name: 'PORTC', config: { ...megaPortRegs(portCConfig), externalInterrupts: [] } },
  {
    name: 'PORTD',
    config: {
      ...megaPortRegs(portDConfig),
      externalInterrupts: [megaExtInt(0), megaExtInt(1), megaExtInt(2), megaExtInt(3)],
    },
  },
  {
    name: 'PORTE',
    config: {
      ...megaPortRegs(portEConfig),
      pinChange: megaPinChange(1, 0x01, 0),
      externalInterrupts: [
        null,
        null,
        null,
        null,
        megaExtInt(4),
        megaExtInt(5),
        megaExtInt(6),
        megaExtInt(7),
      ],
    },
  },
  { name: 'PORTF', config: portFConfig },
  { name: 'PORTG', config: portGConfig },
  { name: 'PORTH', config: portHConfig },
  {
    name: 'PORTJ',
    config: {
      ...megaPortRegs(portJConfig),
      pinChange: megaPinChange(1, 0x7f, 1),
      externalInterrupts: [],
    },
  },
  {
    name: 'PORTK',
    config: {
      ...megaPortRegs(portKConfig),
      pinChange: megaPinChange(2, 0xff, 0),
      externalInterrupts: [],
    },
  },
  { name: 'PORTL', config: portLConfig },
];

/**
 * ── ATmega2560 timer wiring ──────────────────────────────────────────────────
 *
 * avr8js ships ATmega328P configs. Timer0/1/2 keep the same register
 * addresses on the Mega, but two things differ and both matter:
 *
 *   1. The compare-output pins (OCnx). On the Uno OC1A is PB1; on the Mega
 *      it is PB5 (D11). Without these overrides a CTC + toggle-on-compare
 *      sketch drives the wrong pad (or none at all, since the DDR bit the
 *      sketch sets belongs to a different pin).
 *   2. Timer3/4/5 do not exist on the ATmega328P, so avr8js has no stock
 *      config for them — they are built below from `timer1Config` (same
 *      16-bit layout, different register block, TIMSK/TIFR and vectors).
 *
 * Interrupt fields are WORD addresses = _VECTOR(N) * 2 (each JMP vector is
 * 4 bytes = 2 words), matching the convention already used for Timer0-2.
 *
 * OCnx → port pin → Arduino pin (ATmega2560 datasheet §13.3 / variants/mega):
 *   OC0A PB7 D13   OC0B PG5 D4
 *   OC1A PB5 D11   OC1B PB6 D12   OC1C PB7 D13
 *   OC2A PB4 D10   OC2B PH6 D9
 *   OC3A PE3 D5    OC3B PE4 D2    OC3C PE5 D3
 *   OC4A PH3 D6    OC4B PH4 D7    OC4C PH5 D8
 *   OC5A PL3 D46   OC5B PL4 D45   OC5C PL5 D44
 */
const MEGA_TIMER0_PINS = {
  compPortA: portBConfig.PORT,
  compPinA: 7,
  compPortB: portGConfig.PORT,
  compPinB: 5,
  externalClockPort: portDConfig.PORT,
  externalClockPin: 7, // T0 → PD7
} as const;

const MEGA_TIMER1_PINS = {
  compPortA: portBConfig.PORT,
  compPinA: 5,
  compPortB: portBConfig.PORT,
  compPinB: 6,
  compPortC: portBConfig.PORT,
  compPinC: 7,
  externalClockPort: portDConfig.PORT,
  externalClockPin: 6, // T1 → PD6
} as const;

const MEGA_TIMER2_PINS = {
  compPortA: portBConfig.PORT,
  compPinA: 4,
  compPortB: portHConfig.PORT,
  compPinB: 6,
  // Timer2 has no T2 input on the Mega — it clocks off TOSC1/TOSC2.
  externalClockPort: 0,
  externalClockPin: 0,
} as const;

/** Timer1's third compare channel (OC1C) — absent on the ATmega328P. */
const MEGA_TIMER1_CHANNEL_C = {
  OCRC: 0x8c,
  compCInterrupt: 0x26, // _VECTOR(19) TIMER1_COMPC
  OCFC: 0b1000,
  OCIEC: 0b1000,
} as const;

/** Timer3/4/5 share Timer1's 16-bit layout; only the addresses move. */
const megaTimer3Config: AVRTimerConfig = {
  ...timer1Config,
  captureInterrupt: 0x3e, // _VECTOR(31)
  compAInterrupt: 0x40, // _VECTOR(32)
  compBInterrupt: 0x42, // _VECTOR(33)
  compCInterrupt: 0x44, // _VECTOR(34)
  ovfInterrupt: 0x46, // _VECTOR(35)
  TIFR: 0x38,
  TIMSK: 0x71,
  TCCRA: 0x90,
  TCCRB: 0x91,
  TCCRC: 0x92,
  TCNT: 0x94,
  ICR: 0x96,
  OCRA: 0x98,
  OCRB: 0x9a,
  OCRC: 0x9c,
  OCFC: 0b1000,
  OCIEC: 0b1000,
  compPortA: portEConfig.PORT,
  compPinA: 3,
  compPortB: portEConfig.PORT,
  compPinB: 4,
  compPortC: portEConfig.PORT,
  compPinC: 5,
  externalClockPort: portEConfig.PORT,
  externalClockPin: 6, // T3 → PE6
};

const megaTimer4Config: AVRTimerConfig = {
  ...timer1Config,
  captureInterrupt: 0x52, // _VECTOR(41)
  compAInterrupt: 0x54, // _VECTOR(42)
  compBInterrupt: 0x56, // _VECTOR(43)
  compCInterrupt: 0x58, // _VECTOR(44)
  ovfInterrupt: 0x5a, // _VECTOR(45)
  TIFR: 0x39,
  TIMSK: 0x72,
  TCCRA: 0xa0,
  TCCRB: 0xa1,
  TCCRC: 0xa2,
  TCNT: 0xa4,
  ICR: 0xa6,
  OCRA: 0xa8,
  OCRB: 0xaa,
  OCRC: 0xac,
  OCFC: 0b1000,
  OCIEC: 0b1000,
  compPortA: portHConfig.PORT,
  compPinA: 3,
  compPortB: portHConfig.PORT,
  compPinB: 4,
  compPortC: portHConfig.PORT,
  compPinC: 5,
  externalClockPort: portHConfig.PORT,
  externalClockPin: 7, // T4 → PH7
};

const megaTimer5Config: AVRTimerConfig = {
  ...timer1Config,
  captureInterrupt: 0x5c, // _VECTOR(46)
  compAInterrupt: 0x5e, // _VECTOR(47)
  compBInterrupt: 0x60, // _VECTOR(48)
  compCInterrupt: 0x62, // _VECTOR(49)
  ovfInterrupt: 0x64, // _VECTOR(50)
  TIFR: 0x3a,
  TIMSK: 0x73,
  // Timer5 lives in extended I/O (0x120+) — reachable via cpu.data / write
  // hooks exactly like the low registers, just not via IN/OUT.
  TCCRA: 0x120,
  TCCRB: 0x121,
  TCCRC: 0x122,
  TCNT: 0x124,
  ICR: 0x126,
  OCRA: 0x128,
  OCRB: 0x12a,
  OCRC: 0x12c,
  OCFC: 0b1000,
  OCIEC: 0b1000,
  compPortA: portLConfig.PORT,
  compPinA: 3,
  compPortB: portLConfig.PORT,
  compPinB: 4,
  compPortC: portLConfig.PORT,
  compPinC: 5,
  externalClockPort: portLConfig.PORT,
  externalClockPin: 2, // T5 → PL2
};

/**
 * DDR register address per ATmega2560 port. Module scope because two things
 * need it: the port listeners (which pass the mask to PinManager) and
 * `mcuDrives`, the "is the sketch driving this pad right now" question.
 */
const MEGA_DDR_ADDRS: Record<string, number> = {
  PORTA: 0x21,
  PORTB: 0x24,
  PORTC: 0x27,
  PORTD: 0x2a,
  PORTE: 0x2d,
  PORTF: 0x30,
  PORTG: 0x33,
  PORTH: 0x101,
  PORTJ: 0x104,
  PORTK: 0x107,
  PORTL: 0x10a,
};

/** DDR addresses for the single-port variants. ATtiny85 has PORTB only. */
const UNO_DDRD = 0x2a;
const UNO_DDRB = 0x24;
const UNO_DDRC = 0x27;
const TINY85_DDRB = 0x37;

/** Every AVR variant here runs at 16 MHz. */
const AVR_CPU_HZ = 16_000_000;

/** SREG's data address and its global interrupt enable bit. */
const SREG = 0x5f;
const SREG_I = 0x80;

/**
 * avr8js's CPU, entering interrupts the way the AVR core does
 * (velxio/velxio-prod#158).
 *
 * "The interrupt execution response for all the enabled AVR interrupts is
 * four clock cycles minimum" (ATmega328P datasheet DS40002061B, section 7.7):
 * the PC is pushed and I cleared, then the vector's jump runs. A device with a
 * 3-byte PC takes five (ATmega2560, section 7.8.1). avr8js charges two on
 * every device, so each interrupt started 125 ns early on the Uno.
 *
 * The same section: "the instruction following SEI will be executed before
 * any pending interrupts", and after RETI the AVR "will always return to the
 * main program and execute one more instruction before any pending interrupt
 * is served". avr8js served a pending interrupt right after either (its issue
 * #38 asked for the RETI rule in 2020), so a level that stays pending, such as
 * a low INT0, starved the main program. Here any instruction that turns I on
 * (SEI, RETI, a write to SREG) lets one more instruction run first, as simavr
 * does; the peripherals tick as usual meanwhile.
 */
class AvrCpu extends CPU {
  /**
   * SREG.I as the previous tick left it, so before the instruction that just
   * ran. Unknown before the first tick: a host that sets I before running
   * anything (a test enabling interrupts on a bare program) gets it at once.
   */
  private interruptsWereOn: boolean | undefined = undefined;

  tick(): void {
    const data = this.data;
    const on = (data[SREG] & SREG_I) !== 0;
    if (on && this.interruptsWereOn === false) {
      this.interruptsWereOn = true;
      data[SREG] &= ~SREG_I;
      super.tick();
      data[SREG] |= SREG_I;
      return;
    }
    super.tick();
    const stillOn = (data[SREG] & SREG_I) !== 0;
    // tick() cleared I: it entered an interrupt, and charged two cycles.
    if (on && !stillOn) this.cycles += this.pc22Bits ? 3 : 2;
    this.interruptsWereOn = stillOn;
  }
}

/** avr8js's TimerMode.FastPWM; the enum is not exported. */
const AVR8JS_FAST_PWM = 3;

type CompareChannel = 'A' | 'B' | 'C';

/**
 * The parts of an avr8js 0.21.0 AVRTimer that chipFastPwm reaches. Its
 * typings declare them private, so the timer is seen through this shape.
 */
interface AvrTimerInternals {
  cpu: CPU;
  config: AVRTimerConfig;
  timerMode: number;
  readonly TOP: number;
  hasOCRC: boolean;
  ocrA: number;
  ocrB: number;
  ocrC: number;
  nextOcrA: number;
  nextOcrB: number;
  nextOcrC: number;
  compA: number;
  compB: number;
  compC: number;
  OCFA: AVRInterruptConfig;
  OCFB: AVRInterruptConfig;
  OCFC: AVRInterruptConfig;
  timerUpdated(value: number, prevValue: number): void;
  updateCompPin(compValue: number, pinName: CompareChannel, bottom?: boolean): void;
}

/**
 * An avr8js timer whose fast PWM compare matches land where the chip's do
 * (velxio/velxio-prod#155).
 *
 * "Whenever TCNT0 equals OCR0A or OCR0B, the comparator signals a match. A
 * match will set the Output Compare Flag (OCF0A or OCF0B) at the next timer
 * clock cycle" (ATmega328P datasheet DS40002061B, section 15.5; the same for
 * the 16-bit timers), and the waveform generator acts on the match then. In
 * fast PWM the pin is set at BOTTOM and cleared as TCNT leaves OCR, so it is
 * HIGH for OCR + 1 of TOP + 1 ticks: OCR at BOTTOM is a one-tick spike and
 * OCR at TOP a constant HIGH (section 15.7.3), and inverting mode is the
 * complement. avr8js acts on a match when TCNT reaches OCR, one tick early:
 * the pin was HIGH for OCR ticks (256 us of 1024 for analogWrite(6, 64),
 * where the chip gives 260), OCR = 0 was a constant HIGH and OCR = TOP fell
 * for one tick. Its fast PWM also never set channel C at BOTTOM, so OC1C,
 * OC3C, OC4C and OC5C on the Mega stayed LOW.
 *
 * In fast PWM only, each count step here applies its matches as the chip
 * does, flag and pin together and in order: the matches before the wrap,
 * then BOTTOM, then the matches after it against the OCR that BOTTOM loads
 * (OCR is double-buffered in this mode). A match at TOP is the wrap itself:
 * BOTTOM wins, and a toggle still toggles. A CPU write to TCNT blocks the
 * match of the next timer clock (section 15.5.2). Every other mode is left to
 * avr8js, so millis() (the overflow), tone() (CTC), Servo (normal mode) and
 * the phase-correct pins, whose duty avr8js gets right, run as before.
 */
function chipFastPwm(timer: AVRTimer): AVRTimer {
  const t = timer as unknown as AvrTimerInternals;
  const stock = AVRTimer.prototype as unknown as AvrTimerInternals;
  const stockUpdated = stock.timerUpdated;
  const stockCompPin = stock.updateCompPin;
  const cpu = t.cpu;
  const { OCFA, OCFB, OCFC, hasOCRC } = t;

  /**
   * One channel's part of a count step from prevValue to value: TCNT leaves
   * OCR before the wrap (or in a step without one), then at the wrap itself
   * when OCR is TOP, then BOTTOM, then the matches after the wrap against the
   * OCR that BOTTOM loads.
   */
  const step = (
    ch: CompareChannel,
    flag: AVRInterruptConfig,
    comp: number,
    ocr: number,
    nextOcr: number,
    prevValue: number,
    value: number,
    wrapped: boolean,
    top: number,
    blockedAt: number,
  ): void => {
    const free = ocr !== blockedAt;
    if (free && prevValue <= ocr && ocr < (wrapped ? top : value)) {
      cpu.setInterruptFlag(flag);
      if (comp) stockCompPin.call(t, comp, ch, false);
    }
    if (!wrapped) return;
    if (free && ocr === top) {
      cpu.setInterruptFlag(flag);
      if (comp === 1) stockCompPin.call(t, comp, ch, false);
    }
    if (comp) stockCompPin.call(t, comp, ch, true);
    if (nextOcr < value) {
      cpu.setInterruptFlag(flag);
      if (comp) stockCompPin.call(t, comp, ch, false);
    }
  };

  // A write to TCNT: avr8js's hook runs a compare on the written value (a
  // no-op, nothing counted), and the next count step must not match on it.
  let inTcntWrite = false;
  let tcntWritten = false;
  const tcntAddr = t.config.TCNT;
  const stockTcntWrite = cpu.writeHooks[tcntAddr];
  cpu.writeHooks[tcntAddr] = (value, oldValue, addr, mask) => {
    tcntWritten = true;
    inTcntWrite = true;
    try {
      return stockTcntWrite(value, oldValue, addr, mask);
    } finally {
      inTcntWrite = false;
    }
  };

  // avr8js applies fast PWM's BOTTOM after the step's matches; the step
  // applies it in its place, so that call does nothing.
  t.updateCompPin = (compValue, pinName, bottom = false) => {
    if (bottom) return;
    stockCompPin.call(t, compValue, pinName, false);
  };

  t.timerUpdated = (value, prevValue) => {
    if (inTcntWrite) return;
    let blockedAt = -1;
    if (tcntWritten) {
      blockedAt = prevValue;
      tcntWritten = false;
    }
    if (t.timerMode !== AVR8JS_FAST_PWM) {
      stockUpdated.call(t, value, prevValue);
      return;
    }
    // A count step is at least one tick, so a step back to the same value
    // went round once.
    const wrapped = prevValue >= value;
    // Most steps leave no OCR behind: nothing to do (a prescaler of 1 steps
    // after every instruction).
    if (
      !wrapped &&
      (t.ocrA < prevValue || t.ocrA >= value) &&
      (t.ocrB < prevValue || t.ocrB >= value) &&
      (!hasOCRC || t.ocrC < prevValue || t.ocrC >= value)
    ) {
      return;
    }
    const top = t.TOP;
    step('A', OCFA, t.compA, t.ocrA, t.nextOcrA, prevValue, value, wrapped, top, blockedAt);
    step('B', OCFB, t.compB, t.ocrB, t.nextOcrB, prevValue, value, wrapped, top, blockedAt);
    if (hasOCRC) {
      step('C', OCFC, t.compC, t.ocrC, t.nextOcrC, prevValue, value, wrapped, top, blockedAt);
    }
  };
  return timer;
}

/**
 * Peripheral configs of each ATmega variant. The ATmega2560 keeps the
 * ATmega328P's register addresses for Timer0-2, USART0, SPI, TWI, ADC and
 * EEPROM; only its vector table differs, because it has more external
 * interrupts in front. avr8js takes WORD addresses, _VECTOR(N) * 2 (each
 * vector is a two-word JMP):
 *
 *   TIMER2_COMPA _V(13) 0x1A   TIMER2_COMPB _V(14) 0x1C   TIMER2_OVF   _V(15) 0x1E
 *   TIMER1_CAPT  _V(16) 0x20   TIMER1_COMPA _V(17) 0x22   TIMER1_COMPB _V(18) 0x24
 *   TIMER1_OVF   _V(20) 0x28   TIMER0_COMPA _V(21) 0x2A   TIMER0_COMPB _V(22) 0x2C
 *   TIMER0_OVF   _V(23) 0x2E   SPI_STC      _V(24) 0x30   USART0_RX    _V(25) 0x32
 *   USART0_UDRE  _V(26) 0x34   USART0_TX    _V(27) 0x36   ADC          _V(29) 0x3A
 *   EE_READY     _V(30) 0x3C   TWI          _V(39) 0x4E
 *
 * A firmware load and a reset both build the chip from this one table. The
 * reset used to rebuild a Mega with the Uno's vectors, so after Stop or Reset
 * every interrupt landed in the wrong slot: millis() stopped, Serial and Wire
 * hung, and a transfer-complete restarted the sketch.
 */
type USARTConfig = typeof usart0Config;

/**
 * One USART of the chip, with the board pins its TXD/RXD sit on (the scope
 * draws the frame there) and how it is reached from the rest of the app.
 */
interface UsartDef {
  config: USARTConfig;
  txPin: number;
  rxPin: number;
}

interface AtmegaPeripheralConfigs {
  timer0: AVRTimerConfig;
  timer1: AVRTimerConfig;
  timer2: AVRTimerConfig;
  /** USART0 first; the ATmega2560 has USART1..3 after it. */
  usarts: UsartDef[];
  spi: SPIConfig;
  twi: TWIConfig;
  adc: ADCConfig;
  eeprom: AVREEPROMConfig;
}

const ATMEGA328P_PERIPHERALS: AtmegaPeripheralConfigs = {
  timer0: timer0Config,
  timer1: timer1Config,
  timer2: timer2Config,
  // PD1 TXD / PD0 RXD: Arduino pins 1 and 0.
  usarts: [{ config: usart0Config, txPin: 1, rxPin: 0 }],
  spi: spiConfig,
  twi: twiConfig,
  adc: adcConfig,
  eeprom: eepromConfig,
};

/**
 * The ATmega2560's USART1..3 (iomxx0_1.h). avr8js ships only usart0Config;
 * the other three are the same peripheral at their own registers and vectors:
 *
 *   USART1_RX _V(36) 0x48  USART1_UDRE _V(37) 0x4A  USART1_TX _V(38) 0x4C
 *   USART2_RX _V(51) 0x66  USART2_UDRE _V(52) 0x68  USART2_TX _V(53) 0x6A
 *   USART3_RX _V(54) 0x6C  USART3_UDRE _V(55) 0x6E  USART3_TX _V(56) 0x70
 *
 * Without them a sketch's Serial1.begin() wrote into plain SRAM and a module
 * on TX1/RX1 (18/19) never heard the board (finding
 * grove-uart-softwareserial-and-mega-uarts).
 */
const MEGA_USART1: USARTConfig = {
  rxCompleteInterrupt: 0x48,
  dataRegisterEmptyInterrupt: 0x4a,
  txCompleteInterrupt: 0x4c,
  UCSRA: 0xc8,
  UCSRB: 0xc9,
  UCSRC: 0xca,
  UBRRL: 0xcc,
  UBRRH: 0xcd,
  UDR: 0xce,
};
const MEGA_USART2: USARTConfig = {
  rxCompleteInterrupt: 0x66,
  dataRegisterEmptyInterrupt: 0x68,
  txCompleteInterrupt: 0x6a,
  UCSRA: 0xd0,
  UCSRB: 0xd1,
  UCSRC: 0xd2,
  UBRRL: 0xd4,
  UBRRH: 0xd5,
  UDR: 0xd6,
};
const MEGA_USART3: USARTConfig = {
  rxCompleteInterrupt: 0x6c,
  dataRegisterEmptyInterrupt: 0x6e,
  txCompleteInterrupt: 0x70,
  UCSRA: 0x130,
  UCSRB: 0x131,
  UCSRC: 0x132,
  UBRRL: 0x134,
  UBRRH: 0x135,
  UDR: 0x136,
};

/**
 * The ATmega2560's ADC multiplexer (datasheet Table 26-4): MUX5 in ADCSRB
 * selects ADC8-15 (MUX5:0 = 1000xx, avr8js folds MUX5 in as channel 0x20+),
 * 0x1E is the 1.1 V bandgap and 0x1F GND. The 328P's table it reused had a
 * 4-bit mask, which dropped MUX5: analogRead(A8..A15) read A0..A7.
 * Differential inputs are not modelled (they read 0 V).
 */
const ATMEGA2560_ADC_CHANNELS: ADCMuxConfiguration = {
  ...Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [i, { type: ADCMuxInputType.SingleEnded, channel: i }]),
  ),
  ...Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [0x20 + i, { type: ADCMuxInputType.SingleEnded, channel: 8 + i }]),
  ),
  0x1e: { type: ADCMuxInputType.Constant, voltage: 1.1 },
  0x1f: { type: ADCMuxInputType.Constant, voltage: 0 },
};

const ATMEGA2560_PERIPHERALS: AtmegaPeripheralConfigs = {
  // The compare-output pads and the third channel of Timer1 are the Mega's,
  // not the 328P's: without them a sketch that sets OCR1A drives no pin (#356).
  timer0: {
    ...timer0Config,
    compAInterrupt: 0x2a,
    compBInterrupt: 0x2c,
    ovfInterrupt: 0x2e,
    ...MEGA_TIMER0_PINS,
  },
  timer1: {
    ...timer1Config,
    captureInterrupt: 0x20,
    compAInterrupt: 0x22,
    compBInterrupt: 0x24,
    ovfInterrupt: 0x28,
    ...MEGA_TIMER1_CHANNEL_C,
    ...MEGA_TIMER1_PINS,
  },
  timer2: {
    ...timer2Config,
    compAInterrupt: 0x1a,
    compBInterrupt: 0x1c,
    ovfInterrupt: 0x1e,
    ...MEGA_TIMER2_PINS,
  },
  usarts: [
    // PE1 TXD0 / PE0 RXD0 (1 / 0), PD3 TXD1 / PD2 RXD1 (18 / 19),
    // PH1 TXD2 / PH0 RXD2 (16 / 17), PJ1 TXD3 / PJ0 RXD3 (14 / 15).
    {
      config: {
        ...usart0Config,
        rxCompleteInterrupt: 0x32,
        dataRegisterEmptyInterrupt: 0x34,
        txCompleteInterrupt: 0x36,
      },
      txPin: 1,
      rxPin: 0,
    },
    { config: MEGA_USART1, txPin: 18, rxPin: 19 },
    { config: MEGA_USART2, txPin: 16, rxPin: 17 },
    { config: MEGA_USART3, txPin: 14, rxPin: 15 },
  ],
  spi: { ...spiConfig, spiInterrupt: 0x30 },
  twi: { ...twiConfig, twiInterrupt: 0x4e },
  // The 2560's references (Table 26-3): REFS 10 is the internal 1.1 V and
  // 11 the internal 2.56 V. With the 328P's table INTERNAL1V1 converted
  // against 5 V and INTERNAL2V56 against 1.1 V (velxio/velxio-prod#154).
  adc: {
    ...adcConfig,
    adcInterrupt: 0x3a,
    numChannels: 16,
    muxInputMask: 0x3f,
    muxChannels: ATMEGA2560_ADC_CHANNELS,
    adcReferences: [
      ADCReference.AREF,
      ADCReference.AVCC,
      ADCReference.Internal1V1,
      ADCReference.Internal2V56,
    ],
  },
  eeprom: { ...eepromConfig, eepromReadyInterrupt: 0x3c },
};

/** What the simulator itself does with a USART's traffic (console, scope). */
interface UsartHooks {
  /** The guest shifted a byte out of this USART; its frame starts at `atCycle`. */
  transmitted(byte: number, atCycle: number): void;
  /** The guest wrote UCSRA/UCSRB/UCSRC/UBRR: the line settings may have changed. */
  configured(): void;
}

/**
 * One USART of the ATmega as the bus fabric sees it (project
 * board-buses-2026-09, F6). Made once per simulator, like the SPI port: avr8js
 * builds a new AVRUSART with every CPU (firmware load, Reset, Stop), and
 * attach() points this same port at the new one, so a handler installed
 * before any of those keeps hearing the guest afterwards, and a byte handed
 * to receive() lands in whichever USART is live.
 *
 * Receiving: avr8js has no RX FIFO. writeByte() refuses a byte while the
 * previous one is still on the wire (rxBusy, one character time) or while the
 * receiver is off, so bytes wait here and go in one at a time, re-armed from
 * onRxComplete, which paces them at the configured rate exactly as the wire
 * would. The queue is this port's, per USART, and a rebuild empties it: on a
 * reset the line is quiet, and what the previous run never read is gone
 * (finding avr-rx-queue-stale-and-throttled).
 *
 * Transmitting: the ATmega's transmitter is double-buffered, and avr8js's is
 * not, so the port takes over the UDR and UCSRA writes (velxio/velxio-prod#161).
 * UDRn is a buffer in front of the shift register. A byte written there moves
 * to the shift register at once when it is idle, or right after the stop bit
 * of the frame on the wire, and UDREn is set as soon as the buffer is free
 * again (ATmega328P datasheet DS40002061B, sections 20.6.1 and 20.6.3). The
 * next byte is queued while the current one shifts out, so frames leave back
 * to back. avr8js set UDRE only when the whole frame was over, which added
 * the UDRE interrupt's latency to every character: +0.4 % at 9600 baud and
 * +4.9 % at 115200 with HardwareSerial. Each byte reaches the console, the
 * fabric and the scope when its frame starts. TXC is set when a frame ends
 * with the buffer empty; writing UDR does not clear it, writing a one does.
 */
class AvrUartPort implements UartControllerPort {
  readonly bus = 'uart' as const;
  readonly unit: number;
  readonly name: string;
  private usart: AVRUSART | null = null;
  private handler: ((byte: number) => void) | null = null;
  private pending: number[] = [];
  private readonly hooks: UsartHooks;
  /** A frame is on the wire (the shift register is busy) until `frameEnd`. */
  private shifting = false;
  private frameEnd = 0;
  /** The byte waiting in UDR for the shift register, or null when UDR is empty. */
  private buffered: number | null = null;

  constructor(unit: number, hooks: UsartHooks) {
    this.unit = unit;
    this.name = `USART${unit}`;
    this.hooks = hooks;
  }

  /** The CPU was (re)built: take over its USART. */
  attach(usart: AVRUSART, cpu: CPU, config: USARTConfig): void {
    this.usart = usart;
    this.pending = [];
    this.shifting = false;
    this.buffered = null;
    // A byte avr8js itself reports (nothing in this tree writes UDR around
    // the hook below, but a caller may hand one over) starts its frame now.
    usart.onByteTransmit = (value: number) => this.emit(usart, value & 0xff, cpu.cycles);
    const udre: AVRInterruptConfig = {
      address: config.dataRegisterEmptyInterrupt,
      flagRegister: config.UCSRA,
      flagMask: UCSRA_UDRE,
      enableRegister: config.UCSRB,
      enableMask: UCSRB_UDRIE,
    };
    const txc: AVRInterruptConfig = {
      address: config.txCompleteInterrupt,
      flagRegister: config.UCSRA,
      flagMask: UCSRA_TXC,
      enableRegister: config.UCSRB,
      enableMask: UCSRB_TXCIE,
    };
    // One frame in CPU cycles, as avr8js times its receiver: (UBRR + 1) clock
    // periods of 16 (8 with U2X) per symbol, start + data + parity + stop.
    const frameCycles = (): number => {
      const ubrr = (cpu.data[config.UBRRH] << 8) | cpu.data[config.UBRRL];
      const perSymbol = (ubrr + 1) * (cpu.data[config.UCSRA] & UCSRA_U2X ? 8 : 16);
      return perSymbol * (1 + usart.bitsPerChar + usart.stopBits + (usart.parityEnabled ? 1 : 0));
    };
    const startFrame = (byte: number, atCycle: number): void => {
      this.shifting = true;
      this.frameEnd = atCycle + frameCycles();
      // The buffer is free again the moment its byte reaches the shift register.
      cpu.setInterruptFlag(udre);
      this.emit(usart, byte, atCycle);
      cpu.addClockEvent(frameDone, this.frameEnd - cpu.cycles);
    };
    const frameDone = (): void => {
      if (usart !== this.usart) return;
      this.shifting = false;
      const next = this.buffered;
      if (next === null) {
        cpu.setInterruptFlag(txc);
        return;
      }
      // Right after the stop bit: the next frame starts where this one ended,
      // not where the clock event happened to run.
      this.buffered = null;
      startFrame(next, this.frameEnd);
    };
    cpu.writeHooks[config.UDR] = (value) => {
      // Nothing reaches a transmitter that is off (velxio/velxio-prod#167):
      // no frame, and UDRE stays as it was, so the sketch keeps running.
      if (!usart.txEnable) return true;
      const byte = value & 0xff;
      if (!this.shifting) startFrame(byte, cpu.cycles);
      else if (this.buffered === null) {
        this.buffered = byte;
        cpu.clearInterrupt(udre);
      }
      // A write while UDRE is clear is ignored by the transmitter (UDRn).
      return true;
    };
    // UCSRA: RXC, UDRE, FE, DOR and UPE are read-only and TXC is cleared by
    // writing a one. avr8js stored the written value masked to U2X and MPCM,
    // which cleared UDRE on every write: HardwareSerial writes UCSRA right
    // after each UDR write, and with UDRE back at one at once that dropped it.
    cpu.writeHooks[config.UCSRA] = (value, oldValue) => {
      cpu.data[config.UCSRA] = (oldValue & UCSRA_READ_ONLY) | (value & (UCSRA_U2X | UCSRA_MPCM));
      cpu.clearInterruptByFlag(txc, value);
      if ((value & UCSRA_U2X) !== (oldValue & UCSRA_U2X)) usart.onConfigurationChange?.();
      return true;
    };
    usart.onRxComplete = () => this.drain();
    usart.onConfigurationChange = () => {
      this.hooks.configured();
      // Serial.begin turned the receiver on: what arrived before it can go in now.
      this.drain();
    };
  }

  /** A frame leaves the transmitter: the fabric, the console and the scope hear it. */
  private emit(usart: AVRUSART, byte: number, atCycle: number): void {
    // A peripheral of a CPU that has been replaced reaches nobody.
    if (usart !== this.usart) return;
    // Neither does a byte written while the transmitter is off. avr8js
    // reports every write to UDR, but with TXEN clear the USART does not
    // drive TXD and shifts nothing out (ATmega328P datasheet, section 20.6
    // and UDRn): a sketch that never calls Serial.begin() prints nothing on
    // a real board, to the monitor or to a board wired to TX, and keeps
    // running (velxio/velxio-prod#167).
    if (!usart.txEnable) return;
    this.handler?.(byte);
    this.hooks.transmitted(byte, atCycle);
  }

  /** The live avr8js peripheral, for the simulator's own reporting. */
  get engine(): AVRUSART | null {
    return this.usart;
  }

  setTxHandler(handler: ((byte: number) => void) | null): void {
    this.handler = handler;
  }

  receive(byte: number): void {
    this.pending.push(byte & 0xff);
    this.drain();
  }

  /** Stop: the wire empties with the power. */
  dropPending(): void {
    this.pending = [];
  }

  /**
   * The frame loop's retry. The queue is normally re-armed from onRxComplete
   * and from a configuration write, but a byte refused for a reason neither
   * of those follows (RX busy at the instant of a Serial.end/begin toggle)
   * would otherwise wait for the next byte to arrive.
   */
  retryPending(): void {
    this.drain();
  }

  private drain(): void {
    const usart = this.usart;
    if (!usart || this.pending.length === 0) return;
    if (usart.writeByte(this.pending[0])) this.pending.shift();
  }

  config(): UartConfig {
    const usart = this.usart;
    // Nothing is configured until the sketch enables the transmitter or the
    // receiver (Serial.begin does both); the reset value of UBRR is not a rate.
    if (!usart || !(usart.rxEnable || usart.txEnable)) return {};
    const parity = usart.parityEnabled ? (usart.parityOdd ? 'O' : 'E') : 'N';
    return { baud: usart.baudRate, frame: `${usart.bitsPerChar}${parity}${usart.stopBits}` };
  }

  routing(): UartRouting | 'static' {
    return 'static';
  }
}

// UCSRnA and UCSRnB bits (the same on every USART here).
const UCSRA_TXC = 0x40;
const UCSRA_UDRE = 0x20;
const UCSRA_U2X = 0x02;
const UCSRA_MPCM = 0x01;
/** RXC, UDRE, FE, DOR, UPE: the flags of UCSRnA a write does not change (TXC is write-one-to-clear). */
const UCSRA_READ_ONLY = 0x80 | UCSRA_TXC | UCSRA_UDRE | 0x10 | 0x08 | 0x04;
const UCSRB_TXCIE = 0x40;
const UCSRB_UDRIE = 0x20;

// SPCR bits (the same on every ATmega here).
const SPCR_SPE = 0x40;
const SPCR_CPOL = 0x08;
const SPCR_CPHA = 0x04;

/**
 * The ATmega's SPI controller as the bus fabric sees it (project
 * board-buses-2026-09, F2-SPEC). One per simulator, created with it and never
 * replaced. avr8js builds a new AVRSPI with every CPU (firmware load, Reset,
 * Stop), and attach() points this same port at the new one, so a handler
 * installed before any of those keeps hearing the bus afterwards.
 *
 * Every frame the guest clocks (a write to SPDR) asks the fabric's handler
 * once and hands its answer to the live CPU once, synchronously, as the byte
 * the guest reads back. With no handler the line idles high: the guest reads
 * 0xFF, never an echo of its own MOSI. The pins are fixed on this family, so
 * the routing is 'static', and avr8js moves no GPIO for a transfer, so a
 * routed pad never shows an edge.
 */
class AvrSpiPort implements SpiControllerPort {
  readonly bus = 'spi' as const;
  readonly unit = 0;
  readonly name = 'SPI';
  private engine: AVRSPI | null = null;
  private cpu: CPU | null = null;
  private spcr = spiConfig.SPCR;
  private handler: ((mosi: number, bits: number) => number) | null = null;
  /** Hears every frame with its answer, to draw it on the scope (busScope.ts). */
  scopeFrame: ((mosi: number, miso: number) => void) | null = null;
  /** The CPU was (re)built: take over its SPI peripheral. */
  attach(engine: AVRSPI, cpu: CPU, config: SPIConfig): void {
    this.engine = engine;
    this.cpu = cpu;
    this.spcr = config.SPCR;
    engine.onByte = (mosi) => this.frame(engine, cpu, mosi);
  }

  private frame(engine: AVRSPI, cpu: CPU, mosi: number): void {
    // A peripheral of a CPU that has been replaced reaches nobody.
    if (engine !== this.engine) {
      engine.completeTransfer(0xff);
      return;
    }
    // The target answers as the frame starts; the guest sees SPIF and reads
    // the byte when the eight SCK periods are over (SPSR: "When a serial
    // transfer is complete, the SPIF Flag is set"), transferCycles after the
    // SPDR write, as avr8js's own default handler does. Completed inside the
    // write, 64 bytes at 125 kHz took 56 us instead of 4.1 ms
    // (velxio/velxio-prod#159).
    const miso = this.handler ? this.handler(mosi, 8) & 0xff : 0xff;
    this.scopeFrame?.(mosi & 0xff, miso);
    cpu.addClockEvent(() => engine.completeTransfer(miso), engine.transferCycles);
  }

  setFrameHandler(handler: ((mosi: number, bits: number) => number) | null): void {
    this.handler = handler;
  }

  config(): SpiControllerConfig {
    const engine = this.engine;
    const cpu = this.cpu;
    if (!engine || !cpu) return { enabled: false };
    const spcr = cpu.data[this.spcr];
    return {
      // avr8js models the master side only: a write to SPDR clocks a frame.
      enabled: (spcr & SPCR_SPE) !== 0,
      // The standard numbering, CPOL << 1 | CPHA. avr8js's spiMode getter packs
      // the two bits the other way round, which swaps modes 1 and 2.
      mode: (((spcr & SPCR_CPOL) !== 0 ? 2 : 0) | ((spcr & SPCR_CPHA) !== 0 ? 1 : 0)) as SpiMode,
      bitOrder: engine.dataOrder === 'lsbFirst' ? 'lsb' : 'msb',
      bits: 8,
      hz: engine.spiFrequency,
    };
  }

  routing(): SpiRouting | 'static' {
    return 'static';
  }
}

export class AVRSimulator implements LineCapable, BusCapableSimulator {
  // Digital input pins are driven from the SPICE solve
  // (connectDigitalInputsToMcu) for nets backed by a real source/element, so
  // `digitalRead()` reflects the real wiring (a pin wired to 5V reads HIGH, a
  // button to 5V reads HIGH when pressed) instead of a hardcoded part seed.
  // The connector skips floating nets, so event-driven parts with no SPICE
  // model (rotary encoder, keypad, dialer, dip-switch, stepper) keep driving
  // their pins via the part layer. Input-control parts (button / slide-switch)
  // check this flag and skip their direct seed — see BasicParts.spiceDriven().
  readonly spiceDrivenInputs = true;
  /** Wire and SPI transfers are drawn on the scope (busScope.ts); the
   *  ATtiny85's USI moves its pins itself. */
  readonly scopeDrawsHardwareBuses = true;
  private cpu: CPU | null = null;
  /** Peripherals kept alive by reference so GC doesn't collect their CPU hooks */
  private peripherals: unknown[] = [];
  private portB: AVRIOPort | null = null;
  private portC: AVRIOPort | null = null;
  private portD: AVRIOPort | null = null;
  /** Extra ports used by the Mega (A, E–L); keyed by port name */
  private megaPorts: Map<string, AVRIOPort> = new Map();
  private megaPortValues: Map<string, number> = new Map();
  private adc: AVRADC | null = null;
  /** The SPI controller port (null on the ATtiny85, which has no SPI peripheral). */
  private readonly spiPort: AvrSpiPort | null;
  /**
   * The UART controller ports, USART0 first (none on the ATtiny85). Made once
   * with the simulator and re-pointed at every rebuilt AVRUSART.
   */
  private readonly uartPorts: AvrUartPort[];
  /** USART0, the console, as the rest of the app reads it (null until a firmware loads). */
  public usart: AVRUSART | null = null;
  public twi: AVRTWI | null = null;
  // The EEPROM's backing store. The backend (the actual cells) is created once
  // and reused across firmware reloads and resets so written values persist
  // between boots, like real hardware (GitHub issue #203); the peripheral is
  // rebuilt with each CPU and kept in `peripherals`.
  private eepromBackend: EEPROMMemoryBackend | null = null;
  public i2cBus!: I2CBusManager;
  private program: Uint16Array | null = null;
  private running = false;
  private animationFrame: number | null = null;
  public pinManager: PinManager;
  private speed = 1.0;
  /** 'uno' for ATmega328P boards (Uno, Nano); 'mega' for ATmega2560; 'tiny85' for ATtiny85 */
  private boardVariant: 'uno' | 'mega' | 'tiny85';

  /** Cycle-accurate pin change queue, flushed after every instruction. */
  private scheduledPinChanges: Array<{ cycle: number; pin: number; state: boolean }> = [];
  /** Line-owning sensor models hosted on this CPU (simulation/line). Built lazily: it closes over the port below. */
  private lines: LineSensorHub | null = null;

  /** Serial output buffer — subscribers receive each byte or line */
  public onSerialData: ((char: string) => void) | null = null;
  /** Fires whenever the sketch changes the USART configuration (Serial.begin). Carries
   *  the full line — rate AND frame format — because a host terminal needs both to
   *  decode the wire, and `Serial.begin(9600, SERIAL_7E1)` is a legal sketch. */
  public onBaudRateChange: ((baudRate: number, link: SerialLink) => void) | null = null;

  /** The line UART0 is clocking right now, or null before the sketch configures it. */
  public serialLink(): SerialLink | null {
    const usart = this.usart;
    if (!usart || !(usart.baudRate > 0)) return null;
    return {
      source: 'uart',
      baud: usart.baudRate,
      dataBits: usart.bitsPerChar,
      parity: usart.parityEnabled ? (usart.parityOdd ? 'odd' : 'even') : 'none',
      stopBits: usart.stopBits,
    };
  }
  /**
   * Fires for every digital pin transition with a millisecond timestamp
   * derived from the CPU cycle counter (cycles / CPU_HZ * 1000).
   * Used by the oscilloscope / logic analyzer.
   */
  public onPinChangeWithTime: ((pin: number, state: boolean, timeMs: number) => void) | null = null;
  /**
   * The other half of that channel: levels the CIRCUIT puts on a pin.
   * avr8js notifies a port listener on a PORT/DDR write and on nothing else,
   * so a button pulling an INPUT_PULLUP pad to GND moved the PIN register —
   * digitalRead saw it — while the scope kept drawing the pull-up's HIGH.
   */
  private externalScope = new ExternalPinScopeFeed(() =>
    this.cpu ? this.cpu.cycles / (this.clockFrequency / 1000) : 0,
  );
  private lastPortBValue = 0;
  private lastPortCValue = 0;
  private lastPortDValue = 0;
  // Last DDR seen per port. avr8js calls a port listener on a DDR change even
  // when the masked value is unchanged, and the release of a single-wire line
  // (DDR 1 -> 0 with PORT already what it was) is exactly such a change: it
  // must reach PinManager.updatePort so the pad's drive state is reported.
  private lastDdr: Map<string, number> = new Map();
  /** The duty last reported per PWM channel (pwmPins order). */
  private lastPwmDuties: number[] = [];
  /**
   * Last known TXEN bit value per USART, used to detect 0→1 transitions and
   * seed the TX pin baseline at idle HIGH the moment the firmware enables the
   * USART. Without this seed the oscilloscope shows a floating/LOW baseline
   * until the first byte transmits, which doesn't match real hardware.
   */
  private lastTxEnable: boolean[] = [];

  /**
   * Wire and SPI on the scope (velxio/velxio-prod#160): avr8js moves no pin
   * for a TWI or SPI transfer, so these draw each step on SDA/SCL and
   * SCK/MOSI/MISO, for the scope only (busScope.ts). None on the ATtiny85,
   * whose USI the fabric decodes from its pins.
   */
  private twiScope: I2cScopeSynth | null = null;
  private spiScope: SpiScopeSynth | null = null;

  /** What getBusBinding() hands the fabric, built once. */
  private busBinding: EngineBinding | null = null;
  /** Told about every MCU reset, after the board's pins went back to undriven. */
  private busResetHandler: (() => void) | null = null;

  constructor(pinManager: PinManager, boardVariant: 'uno' | 'mega' | 'tiny85' = 'uno') {
    this.pinManager = pinManager;
    this.boardVariant = boardVariant;
    // The ATtiny85's USI is not an SPI controller avr8js can report frames for
    // (see getBusBinding), so that variant keeps no port.
    this.spiPort = boardVariant === 'tiny85' ? null : new AvrSpiPort();
    // One port per USART of the variant; the ATtiny85 has none (its core's
    // Serial is a software UART on two pins, which the fabric decodes there).
    this.uartPorts = this.usartDefs().map(
      (def, unit) =>
        new AvrUartPort(unit, {
          transmitted: (byte, atCycle) => this.usartTransmitted(unit, def, byte, atCycle),
          configured: () => this.handleUartConfigChange(unit, def),
        }),
    );
    // Create the bus up-front with a placeholder master so that
    // Interconnect can install cross-board bridges and parts can
    // register devices BEFORE the firmware loads.  The real AVRTWI
    // takes over via `i2cBus.attachMaster(twi)` inside loadHex.
    // On the ATmegas it is also the TWI's controller port (getBusBinding),
    // with the pins the board table fixes.
    this.i2cBus = new I2CBusManager(nullI2CMaster(), {
      unit: 0,
      name: boardVariant === 'tiny85' ? 'USI' : 'TWI',
    });
    // The TWI spends bus time on every step (velxio/velxio-prod#159): each
    // address or data packet is nine SCL periods (ATmega328P datasheet,
    // sections 22.3.3 and 22.3.4), and a START, a repeated START or a STOP
    // about one. SCL = CPU clock / (16 + 2 * TWBR * 4^TWPS) (section 22.5.2),
    // read when the step starts. Completing at once made a 100 kHz register
    // read take 80 us instead of about 440 us. Bus-free time and clock
    // stretching are not modelled.
    this.i2cBus.setBusTiming((phase, complete) => {
      const cpu = this.cpu;
      if (!cpu || !this.twi) {
        complete();
        return;
      }
      const sclCycles = this.twiSclCycles(cpu);
      cpu.addClockEvent(complete, phase === 'byte' ? 9 * sclCycles : sclCycles);
    });
    if (boardVariant !== 'tiny85') this.attachBusScopes(boardVariant);
    // Seed the input register to the pull's resting level the instant the
    // firmware enables it (INPUT_PULLUP -> HIGH). Real silicon does this in
    // nanoseconds; without the seed, digitalRead returned 0 from pinMode
    // until the first SPICE solve (~400 ms) — long enough for setup()-time
    // button checks and emergency-stop latches to fire spuriously (2026-07
    // audit, reproduced deterministically). The SPICE connector overrides
    // with the solved level on sourced nets right after, so a button held
    // at boot still reads pressed within one solve.
    pinManager.onPullChange = (pin, pull) => {
      if (pull === 0) return;
      if (pinManager.getOutputPins().has(pin)) return;
      this.setPinState(pin, pull === 1);
    };
  }

  private get pwmPins() {
    if (this.boardVariant === 'mega') return PWM_PINS_MEGA;
    if (this.boardVariant === 'tiny85') return PWM_PINS_TINY85;
    return PWM_PINS_UNO;
  }

  /**
   * Hand the scope the Wire and SPI edges drawn so far (busScope.ts), reached
   * by the clock or not: the run stopped, or a caller that steps the CPU
   * itself is about to read the scope.
   */
  flushScopeEdges(): void {
    this.twiScope?.flush();
    this.spiScope?.flush();
  }

  /** Hand the scope the Wire and SPI edges the clock has reached: once a frame. */
  releaseScopeEdges(): void {
    this.twiScope?.release();
    this.spiScope?.release();
  }

  /**
   * A pad's own edge is about to reach the scope (the sketch's PORT write, a
   * level the circuit put on it): a Wire or SPI drawing on that pad gives way
   * first, so the scope gets the pad's samples in time order (busScope.ts).
   */
  private padScopeEdge(pin: number, timeMs: number): void {
    this.twiScope?.padEdge(pin, timeMs);
    this.spiScope?.padEdge(pin, timeMs);
  }

  /** The scope slot, for the levels the circuit puts on a pad (externalScope). */
  private readonly padScope = (pin: number, state: boolean, timeMs: number): void => {
    const sink = this.onPinChangeWithTime;
    if (!sink) return;
    this.padScopeEdge(pin, timeMs);
    sink(pin, state, timeMs);
  };

  /** One SCL period in CPU cycles: 16 + 2 * TWBR * 4^TWPS (ATmega328P 22.5.2). */
  private twiSclCycles(cpu: CPU): number {
    const prescaler = 1 << (2 * (cpu.data[twiConfig.TWSR] & 0x03));
    return 16 + 2 * cpu.data[twiConfig.TWBR] * prescaler;
  }

  /**
   * Draw Wire and SPI on the scope: the TWI's steps on SDA and SCL, each SPI
   * frame on SCK, MOSI and MISO, at the pins the board table fixes, timed on
   * the same clock and the same SCL period the TWI spends (velxio/velxio-prod#160).
   */
  private attachBusScopes(variant: 'uno' | 'mega'): void {
    const table = variant === 'mega' ? ATMEGA2560_TABLE : ATMEGA328P_TABLE;
    const pins = (bus: 'i2c' | 'spi') =>
      table.controllers.find((c) => c.bus === bus && c.unit === 0)?.defaultPins ?? {};
    const first = (p: number | number[] | undefined) => (Array.isArray(p) ? p[0] : p);
    const i2c = pins('i2c');
    const spi = pins('spi');
    const sink = () => this.onPinChangeWithTime as ScopeSink | null;
    const nowMs = () => this.scopeClockMs();
    this.twiScope = new I2cScopeSynth({
      sink,
      sda: () => first(i2c.sda),
      scl: () => first(i2c.scl),
      nowMs,
      timing: () => {
        const cpu = this.cpu;
        if (!cpu) return null;
        // SCL's two halves, in ms at 16 MHz.
        const halfMs = this.twiSclCycles(cpu) / 16_000 / 2;
        return { lowMs: halfMs, highMs: halfMs };
      },
    });
    this.i2cBus.setScopeTap(this.twiScope);
    const port = this.spiPort;
    if (!port) return;
    this.spiScope = new SpiScopeSynth({
      sink,
      sck: () => first(spi.sck),
      mosi: () => first(spi.mosi),
      miso: () => first(spi.miso),
      nowMs,
      config: () => port.config(),
    });
    const scope = this.spiScope;
    port.scopeFrame = (mosi, miso) => scope.frame(mosi, miso, 8);
  }

  /** The USARTs this variant has, with their pins. */
  private usartDefs(): UsartDef[] {
    if (this.boardVariant === 'tiny85') return [];
    return (this.boardVariant === 'mega' ? ATMEGA2560_PERIPHERALS : ATMEGA328P_PERIPHERALS).usarts;
  }

  /**
   * Wire avr8js's EEPROM peripheral to the freshly-built CPU. Called after
   * every CPU (re)construction. The backend (the actual cells) is created
   * once per simulator instance and reused, so a value written in one run is
   * still there on the next boot — matching real hardware, where re-flashing
   * a sketch leaves EEPROM intact (GitHub issue #203). Without this peripheral
   * the Arduino EEPROM library's `while (EECR & (1<<EEPE))` write-completion
   * poll never exits and the sketch hangs on the first EEPROM access.
   */
  private attachEeprom(): void {
    const cpu = this.cpu;
    if (!cpu) return;
    const size = this.boardVariant === 'mega' ? 4096 : this.boardVariant === 'tiny85' ? 512 : 1024;
    const backend = this.eepromBackend ?? new EEPROMMemoryBackend(size);
    this.eepromBackend = backend;
    const config =
      this.boardVariant === 'tiny85'
        ? attiny85EepromConfig
        : this.boardVariant === 'mega'
          ? ATMEGA2560_PERIPHERALS.eeprom
          : ATMEGA328P_PERIPHERALS.eeprom;
    this.peripherals.push(new AVREEPROM(cpu, backend, config));
  }

  /**
   * Load compiled hex file into simulator
   */
  loadHex(hexContent: string): void {
    console.log('Loading HEX file...');

    const bytes = hexToUint8Array(hexContent);

    // ATmega328P: 32 KB = 16 384 words.  ATmega2560: 256 KB = 131 072 words.
    // ATtiny85: 8 KB = 4 096 words.
    const progWords =
      this.boardVariant === 'mega' ? 131072 : this.boardVariant === 'tiny85' ? 4096 : 16384;

    this.program = new Uint16Array(progWords);
    for (let i = 0; i < bytes.length; i += 2) {
      this.program[i >> 1] = (bytes[i] || 0) | ((bytes[i + 1] || 0) << 8);
    }

    console.log(`Loaded ${bytes.length} bytes into program memory`);

    this.buildMcu();
    // Flashing reboots the chip: its pads float until the new sketch drives them.
    this.announceMcuReset();

    const boardName =
      this.boardVariant === 'mega'
        ? 'ATmega2560'
        : this.boardVariant === 'tiny85'
          ? 'ATtiny85'
          : 'ATmega328P';
    console.log(`AVR CPU initialized (${boardName}, ${this.peripherals.length} peripherals)`);
  }

  /**
   * Build the CPU and every peripheral for the loaded program. The one place
   * that does it: a firmware load and a reset (the Reset button, Stop) get the
   * same chip, with the variant's own vectors and bridges. The ports that face
   * the rest of the app (the SPI controller port, the I2C bus) outlive the CPU
   * and are re-pointed at the new peripherals here.
   */
  private buildMcu(): void {
    if (!this.program) return;
    // ATmega2560 data space: 0x0000–0x21FF = 8704 bytes total.
    // avr8js: data.length = sramBytes + registerSpace (0x100 = 256).
    // So sramBytes must be >= 8704 − 256 = 8448 to fit RAMEND=0x21FF on the stack.
    // ATmega328P RAMEND = 0x08FF; default 8192 is already a safe over-alloc.
    // ATtiny85 RAMEND = 0x025F; 512 bytes SRAM.
    const sramBytes =
      this.boardVariant === 'mega' ? 8448 : this.boardVariant === 'tiny85' ? 512 : 8192;
    const cpu = new AvrCpu(this.program, sramBytes);
    this.cpu = cpu;

    if (this.boardVariant === 'tiny85') {
      // ATtiny85: PORTB only (PB0-PB5). Timer0 powers millis()/delay() in
      // ATTinyCore via TIMER0_OVF. Timer1 is the high-speed 8-bit PWM
      // timer (PLL clock). No hardware USART on this chip.
      //
      // Known limitation (task #116): the Timer0 OVF interrupt does fire at
      // the correct cadence (1.024 ms simulated, verified via debug
      // instrumentation), but real ATTinyCore-compiled `delay()` does not
      // observably advance — the LED stays stuck either HIGH or LOW
      // depending on which phase the firmware was in when the first OVF
      // hit. Likely a subtle interaction between the avr8js clearInterrupt
      // semantics (only clears the pending queue entry, leaves TIFR bit
      // set) and ATTinyCore's ISR relying on hardware auto-clear of TOV0.
      // Workaround attempts (manual TIFR clear after ISR entry) did not
      // change the visible behavior. Needs a deeper avr8js dive.
      this.portB = new AVRIOPort(cpu, attiny85PortBConfig as typeof portBConfig);
      this.adc = new AVRADC(cpu, attiny85AdcConfig);
      this.usart = null;
      this.peripherals = [
        chipFastPwm(new AVRTimer(cpu, attiny85Timer0Config)),
        new ATtinyTimer1(cpu, attinyTimer1Config),
        // The ATtiny85 also has no hardware TWI: TinyWireM / Tiny4kOLED drive
        // I2C through the USI peripheral in two-wire mode, PB0 (SDA) / PB2
        // (SCL). The USI shifts the bits out through PORTB, so the whole
        // transaction is on the board's pins, and the bus fabric's software
        // decoder reads it there and answers with SDA held low (the level the
        // USI samples): see getBusBinding. Rebuilt with every CPU, like the
        // rest of the peripherals.
        new AVRUSI(cpu, this.portB, 0x36 /* PINB */, 0 /* PB0 = SDA */, 2 /* PB2 = SCL */),
      ];
    } else {
      const cfg = this.boardVariant === 'mega' ? ATMEGA2560_PERIPHERALS : ATMEGA328P_PERIPHERALS;

      const spi = new AVRSPI(cpu, cfg.spi, AVR_CPU_HZ);
      this.spiPort?.attach(spi, cpu, cfg.spi);

      // Every USART of the variant, each behind its port: the console, the
      // scope and the bus fabric all read them through AvrUartPort.attach.
      const usarts = cfg.usarts.map((def) => new AVRUSART(cpu, def.config, AVR_CPU_HZ));
      usarts.forEach((usart, unit) => this.uartPorts[unit].attach(usart, cpu, cfg.usarts[unit].config));
      this.usart = usarts[0];

      this.twi = new AVRTWI(cpu, cfg.twi, AVR_CPU_HZ);
      // Attach the real AVRTWI to the bus created in the constructor;
      // any devices already registered + bridges already installed are
      // preserved across firmware (re)loads.
      this.i2cBus.attachMaster(this.twi);

      this.peripherals = [
        chipFastPwm(new AVRTimer(cpu, cfg.timer0)),
        chipFastPwm(new AVRTimer(cpu, cfg.timer1)),
        chipFastPwm(new AVRTimer(cpu, cfg.timer2)),
        ...usarts,
        spi,
        this.twi,
      ];

      if (this.boardVariant === 'mega') {
        // Timer3/4/5 drive nine of the Mega's fifteen PWM pins and are the
        // usual choice for user-defined CTC / ISR timing, so they have to
        // tick like the others (#356).
        this.peripherals.push(
          chipFastPwm(new AVRTimer(cpu, megaTimer3Config)),
          chipFastPwm(new AVRTimer(cpu, megaTimer4Config)),
          chipFastPwm(new AVRTimer(cpu, megaTimer5Config)),
        );
      }

      this.adc = new AVRADC(cpu, cfg.adc);

      // ── GPIO ports ──────────────────────────────────────────────────────
      if (this.boardVariant === 'mega') {
        this.megaPorts.clear();
        this.megaPortValues.clear();
        for (const { name, config } of MEGA_PORT_CONFIGS) {
          this.megaPorts.set(name, new AVRIOPort(cpu, config));
          this.megaPortValues.set(name, 0);
        }
        // The three ports the Uno code paths name are the Mega's own
        // instances. A second AVRIOPort on the same registers, which is what
        // this used to build first, is a zombie: the later instance takes
        // over its register hooks, but it stays in cpu.gpioPorts with the
        // 328P's INT0/INT1 on PD2/PD3 and answers every EIMSK write.
        this.portB = this.megaPorts.get('PORTB')!;
        this.portC = this.megaPorts.get('PORTC')!;
        this.portD = this.megaPorts.get('PORTD')!;
      } else {
        this.portB = new AVRIOPort(cpu, portBConfig);
        this.portC = new AVRIOPort(cpu, portCConfig);
        this.portD = new AVRIOPort(cpu, portDConfig);
      }
    }

    this.attachEeprom();

    // Everything below mirrors the old CPU's registers: the new one starts
    // with every port, DDR and OCR at zero and the USART disabled.
    this.lastPortBValue = 0;
    this.lastPortCValue = 0;
    this.lastPortDValue = 0;
    this.lastDdr.clear();
    this.lastPwmDuties = new Array(this.pwmPins.length).fill(0);
    this.lastTxEnable = this.uartPorts.map(() => false);

    this.setupPinHooks();
  }

  /**
   * The MCU restarted (firmware load, Reset, Stop). Its pads float again, so
   * the board's pin levels are wiped (listeners hear the ones that were high
   * go low, as on a power cut), and only then is the bus fabric told: a chip
   * select it re-reads now is "not driven", never the level of the old run.
   */
  private announceMcuReset(): void {
    this.pinManager.hardResetPinStates();
    // The new CPU's clock starts at 0, and the bus with it.
    this.twiScope?.reset();
    this.spiScope?.reset();
    this.busResetHandler?.();
  }

  /**
   * Expose ADC instance so components (potentiometer, etc.) can inject voltages
   */
  getADC(): AVRADC | null {
    return this.adc;
  }

  /** Returns the CPU clock frequency in Hz (16 MHz for AVR). */
  getClockHz(): number {
    return 16_000_000;
  }

  /**
   * Returns the current CPU cycle count.
   * Used by timing-sensitive peripherals to schedule future pin changes.
   */
  getCurrentCycles(): number {
    return this.cpu?.cycles ?? 0;
  }

  /**
   * Schedule a pin state change at a specific future CPU cycle count.
   * The change fires between AVR instructions, enabling cycle-accurate protocol simulation.
   * Used by DHT22 and other timing-sensitive single-wire peripherals.
   */
  schedulePinChange(pin: number, state: boolean, atCycle: number): void {
    // Callers are expected to push entries in ascending cycle order.
    // Insert at the correct position to maintain sort (linear scan from end, O(1) for ordered pushes).
    let i = this.scheduledPinChanges.length;
    while (i > 0 && this.scheduledPinChanges[i - 1].cycle > atCycle) i--;
    this.scheduledPinChanges.splice(i, 0, { cycle: atCycle, pin, state });
  }

  /**
   * A USART shifted a byte out: the console hears USART0 (the monitor is
   * that port and no other), and the oscilloscope sees the frame on the TX
   * pin of whichever USART it was.
   */
  private usartTransmitted(unit: number, def: UsartDef, byte: number, atCycle: number): void {
    if (unit === 0 && this.onSerialData) this.onSerialData(String.fromCharCode(byte));
    this.emitUartTxFrame(this.uartPorts[unit].engine, def.txPin, byte, atCycle);
  }

  /**
   * Synthesize a real bit-level UART frame on the TX pin so an oscilloscope
   * sees a waveform during Serial.print, matching real ATmega328P / ATmega2560
   * behavior. avr8js's USART only intercepts the byte at the UDR register
   * level: it never toggles PD1 (Uno/Nano) / PE1 (Mega) or the TXD of the
   * Mega's other USARTs, so without this shim the TX pin is flat in the scope
   * while real hardware would show the UART frame at the configured baud rate.
   *
   * Frame layout (8N1, the Arduino default):
   *   [start LOW] [data LSB ... data MSB] [parity?] [stop1] [stop2?]
   *
   * We honour avr8js's USART configuration getters (bitsPerChar, parityEnabled,
   * parityOdd, stopBits, baudRate) so unusual configurations stay accurate.
   *
   * Each transition is emitted via onPinChangeWithTime so the oscilloscope
   * stamps it with simulator time (cpu.cycles / 16_000 ms), giving bit-level
   * timing that holds at any sweep speed. The scope channel only: the bus
   * fabric hears the byte from the port, and a decoder on a hardware TX pad
   * would otherwise read every byte a second time.
   *
   * The frame starts at `startCycle`, where the shift register loads it: at
   * the UDR write when the transmitter was idle, right after the previous
   * stop bit when the byte waited in the buffer (AvrUartPort).
   */
  private emitUartTxFrame(
    usart: AVRUSART | null,
    txPin: number,
    byte: number,
    startCycle = this.cpu?.cycles ?? 0,
  ): void {
    if (!usart || !this.cpu || !this.onPinChangeWithTime) return;
    if (!usart.txEnable) return;

    const baud = usart.baudRate;
    if (!baud || baud <= 0) return;

    const freqHz = 16_000_000;
    const cyclesPerBit = freqHz / baud;

    // Build the frame bit-by-bit. UART idles HIGH; start = LOW; data LSB first;
    // optional parity; stop bit(s) HIGH.  Idle->start gives the first transition.
    const dataBits = usart.bitsPerChar; // typically 8
    const bits: boolean[] = [false]; // start bit
    let onesCount = 0;
    for (let i = 0; i < dataBits; i++) {
      const b = (byte >> i) & 1;
      bits.push(b !== 0);
      onesCount += b;
    }
    if (usart.parityEnabled) {
      // Even parity = bit that makes total ones even; odd = total ones odd.
      const parity = usart.parityOdd ? onesCount % 2 === 0 : onesCount % 2 !== 0;
      bits.push(parity);
    }
    for (let i = 0; i < usart.stopBits; i++) bits.push(true);

    // Emit only the bits that change state to keep buffer churn minimal.
    // The "previous" state at startCycle is idle HIGH.
    let prevState = true;
    for (let i = 0; i < bits.length; i++) {
      if (bits[i] !== prevState) {
        const timeMs = (startCycle + i * cyclesPerBit) / 16_000;
        this.onPinChangeWithTime(txPin, bits[i], timeMs);
        prevState = bits[i];
      }
    }
    // After the stop bit(s) the line is already HIGH (idle) so no trailing
    // transition is needed: the next byte will start from HIGH automatically.
  }

  /**
   * The sketch wrote a USART's configuration registers (Serial.begin). USART0
   * is the console, so its line is reported to the monitor. Every USART seeds
   * its TX pin at idle HIGH the first time TXEN flips on: without the seed the
   * scope's "initial state before the first byte" defaults to LOW, hiding the
   * start-bit transition of the very first byte sent.
   */
  private handleUartConfigChange(unit: number, def: UsartDef): void {
    const usart = this.uartPorts[unit].engine;
    if (!usart || !this.cpu) return;
    if (unit === 0 && this.onBaudRateChange) {
      this.onBaudRateChange(usart.baudRate, {
        source: 'uart',
        baud: usart.baudRate,
        dataBits: usart.bitsPerChar,
        parity: usart.parityEnabled ? (usart.parityOdd ? 'odd' : 'even') : 'none',
        stopBits: usart.stopBits,
      });
    }
    const tx = usart.txEnable;
    if (tx && !this.lastTxEnable[unit] && this.onPinChangeWithTime) {
      const timeMs = this.cpu.cycles / 16_000;
      this.onPinChangeWithTime(def.txPin, true, timeMs);
    }
    this.lastTxEnable[unit] = tx;
  }

  /** Flush all scheduled pin changes whose target cycle has been reached. */
  private flushScheduledPinChanges(): void {
    if (this.scheduledPinChanges.length === 0 || !this.cpu) return;
    const now = this.cpu.cycles;
    while (this.scheduledPinChanges.length > 0 && this.scheduledPinChanges[0].cycle <= now) {
      const { pin, state } = this.scheduledPinChanges.shift()!;
      this.setPinState(pin, state);
    }
  }

  /**
   * Fire onPinChangeWithTime for every bit that differs between newVal and oldVal.
   * @param pinMap  Optional explicit per-bit Arduino pin numbers (Mega).
   * @param offset  Legacy pin offset (Uno/Nano): PORTB→8, PORTC→14, PORTD→0.
   */
  private firePinChangeWithTime(
    newVal: number,
    oldVal: number,
    pinMap: number[] | null,
    offset = 0,
  ): void {
    if (!this.onPinChangeWithTime || !this.cpu) return;
    const timeMs = this.cpu.cycles / 16_000;
    const changed = newVal ^ oldVal;
    for (let bit = 0; bit < 8; bit++) {
      if (changed & (1 << bit)) {
        const pin = pinMap ? pinMap[bit] : offset + bit;
        if (pin < 0) continue;
        const state = (newVal & (1 << bit)) !== 0;
        // The core just drove this pad, so whatever the external door last
        // reported here is stale: the next injected level must be reported
        // even when it repeats that memory.
        this.externalScope.forget(pin);
        this.padScopeEdge(pin, timeMs);
        this.onPinChangeWithTime(pin, state, timeMs);
      }
    }
  }

  /**
   * Monitor pin changes and update component states
   */
  private setupPinHooks(): void {
    if (!this.cpu) return;
    console.log('Setting up pin hooks...');

    // DDR register addresses (used to distinguish OUTPUT pins from
    // INPUT_PULLUP — see PinManager.updatePort ddrMask param).
    //   ATmega328P/Uno/Nano: DDRB=0x24, DDRC=0x27, DDRD=0x2A
    //   ATtiny85:            DDRB=0x37
    //   ATmega2560: per-port table below
    const cpu = this.cpu;
    const readDdr = (addr: number) => cpu.data[addr] ?? 0;

    if (this.boardVariant === 'tiny85') {
      // ATtiny85: PORTB only, PB0-PB5 → pins 0-5
      // Must pass an explicit pinMap so updatePort uses offset 0 instead of the
      // legacy PORTB offset (8) which would map PB1 → pin 9, etc.
      const TINY85_PIN_MAP = [0, 1, 2, 3, 4, 5, -1, -1];
      this.portB!.addListener((value) => {
        const ddr = readDdr(0x37);
        if (value !== this.lastPortBValue || ddr !== this.lastDdr.get('PORTB')) {
          this.pinManager.updatePort(
            'PORTB',
            value,
            this.lastPortBValue,
            TINY85_PIN_MAP,
            ddr,
            cpu.cycles,
          );
          this.firePinChangeWithTime(value, this.lastPortBValue, null, 0);
          this.lastPortBValue = value;
          this.lastDdr.set('PORTB', ddr);
        }
      });
    } else if (this.boardVariant === 'mega') {
      // Mega: use explicit per-bit pin maps for all 11 ports
      for (const [portName, port] of this.megaPorts) {
        const pinMap = MEGA_PORT_BIT_MAP[portName];
        const ddrAddr = MEGA_DDR_ADDRS[portName];
        this.megaPortValues.set(portName, 0);
        port.addListener((value) => {
          const old = this.megaPortValues.get(portName) ?? 0;
          const ddr = ddrAddr ? readDdr(ddrAddr) : undefined;
          if (value !== old || ddr !== this.lastDdr.get(portName)) {
            this.pinManager.updatePort(portName, value, old, pinMap, ddr, cpu.cycles);
            this.firePinChangeWithTime(value, old, pinMap);
            this.megaPortValues.set(portName, value);
            if (ddr !== undefined) this.lastDdr.set(portName, ddr);
          }
        });
      }
    } else {
      // Uno / Nano: simple 3-port setup
      this.portB!.addListener((value) => {
        const ddr = readDdr(0x24);
        if (value !== this.lastPortBValue || ddr !== this.lastDdr.get('PORTB')) {
          this.pinManager.updatePort(
            'PORTB',
            value,
            this.lastPortBValue,
            undefined,
            ddr,
            cpu.cycles,
          );
          this.firePinChangeWithTime(value, this.lastPortBValue, null, 8);
          this.lastPortBValue = value;
          this.lastDdr.set('PORTB', ddr);
        }
      });
      this.portC!.addListener((value) => {
        const ddr = readDdr(0x27);
        if (value !== this.lastPortCValue || ddr !== this.lastDdr.get('PORTC')) {
          this.pinManager.updatePort(
            'PORTC',
            value,
            this.lastPortCValue,
            undefined,
            ddr,
            cpu.cycles,
          );
          this.firePinChangeWithTime(value, this.lastPortCValue, null, 14);
          this.lastPortCValue = value;
          this.lastDdr.set('PORTC', ddr);
        }
      });
      this.portD!.addListener((value) => {
        const ddr = readDdr(0x2a);
        if (value !== this.lastPortDValue || ddr !== this.lastDdr.get('PORTD')) {
          this.pinManager.updatePort(
            'PORTD',
            value,
            this.lastPortDValue,
            undefined,
            ddr,
            cpu.cycles,
          );
          this.firePinChangeWithTime(value, this.lastPortDValue, null, 0);
          this.lastPortDValue = value;
          this.lastDdr.set('PORTD', ddr);
        }
      });
    }

    console.log('Pin hooks configured successfully');
  }

  /**
   * Poll OCR registers and notify PinManager of PWM duty cycle changes
   */
  private pollPwmRegisters(): void {
    if (!this.cpu) return;
    // Precise simulated time of this poll (sub-frame). Parts that schedule
    // audio use it to recover the real onset time instead of the frame edge.
    const timeMs = this.cpu.cycles / 16_000;
    const pins = this.pwmPins;
    const data = this.cpu.data;
    for (let i = 0; i < pins.length; i++) {
      const def = pins[i] as PwmPinDef;
      const duty = pwmDuty(data, def);
      if (duty !== this.lastPwmDuties[i]) {
        this.lastPwmDuties[i] = duty;
        this.pinManager.updatePwm(def.pin, duty, timeMs);
      }
    }
  }

  /**
   * Start simulation loop
   */
  start(): void {
    if (this.running || !this.cpu) {
      console.warn('Simulator already running or not initialized');
      return;
    }

    this.running = true;
    console.log('Starting AVR simulation...');
    // Browser-only debug hook. Guarded so node-side vitest runs don't
    // ReferenceError on `window` and spam stderr.
    if (typeof window !== 'undefined') {
      const dbg = (window as unknown as { __spiceDebug?: () => void }).__spiceDebug;
      if (typeof dbg === 'function') dbg();
      else console.warn('[spice] __spiceDebug not attached — startSimulation never called');
    }

    // ATmega328p @ 16MHz
    const CPU_HZ = 16_000_000;
    const CYCLES_PER_MS = CPU_HZ / 1000;

    // Cap: never execute more than 50ms worth of cycles in one frame.
    // This prevents a runaway burst when the tab was backgrounded and
    // then becomes visible again (browser may deliver a huge delta).
    const MAX_DELTA_MS = 50;

    let lastTimestamp = 0;
    let frameCount = 0;
    // What the last frame left of its budget: the fraction of a cycle the
    // budget does not round to, less the few cycles its last instruction (and
    // an interrupt entry) ran past the target. Carried into the next frame so
    // that a second of frames is a second of guest time, exactly.
    let cycleCarry = 0;

    const execute = (timestamp: number) => {
      if (!this.running || !this.cpu) return;

      // Clamp delta so we never overshoot after a paused/backgrounded tab.
      // MAX_DELTA_MS already handles large initial deltas (e.g. first frame),
      // so no separate first-frame guard is needed.
      const rawDelta = timestamp - lastTimestamp;
      const deltaMs = Math.min(rawDelta, MAX_DELTA_MS);
      lastTimestamp = timestamp;

      // The frame emulates the wall time that passed: that many CPU CYCLES.
      // An AVR instruction takes one to four of them (ATmega328P datasheet,
      // Instruction Set Summary) and avr8js charges each its cost on
      // cpu.cycles, so the loop runs to a cycle target. It used to run this
      // budget as a count of INSTRUCTIONS, which put about 1.3 times the wall
      // time on the guest clock every frame (1.297 cycles per instruction on
      // a Blink, 2 on a tight loop): delay(1000) lasted 0.77 s of wall time
      // (velxio/velxio-prod#139).
      const cpu = this.cpu;
      const budget = CYCLES_PER_MS * deltaMs * this.speed + cycleCarry;
      const startCycles = cpu.cycles;
      const targetCycles = startCycles + Math.floor(budget);

      try {
        let i = 0;
        // A CPU rebuilt under the loop (a firmware load) starts its own count:
        // the frame ends there rather than run the new one to the old target.
        while (cpu.cycles < targetCycles && this.cpu === cpu) {
          avrInstruction(cpu); // Execute the AVR instruction
          cpu.tick(); // Update peripheral timers and cycles
          if (this.scheduledPinChanges.length > 0) this.flushScheduledPinChanges();
          // Poll PWM sub-frame (every 256 instructions, about 20 µs) so short
          // OCR pulses (e.g. a metronome click that starts and ends within one
          // 16ms frame) aren't merged or lost at the frame boundary. That is
          // far finer than any audible pulse yet light enough not to perturb
          // frame pacing.
          if ((i & 0xff) === 0) this.pollPwmRegisters();
          i++;
        }
        cycleCarry =
          this.cpu === cpu
            ? Math.max(-16, Math.min(1, budget - (cpu.cycles - startCycles)))
            : 0;

        // Final poll at the frame edge to catch the last change.
        this.pollPwmRegisters();

        // Try to drain any pending RX byte every frame. The primary
        // drain path is onRxComplete (re-fires after each successful
        // delivery), but that callback only ever fires AFTER a byte was
        // accepted — if the very first delivery attempt fails (sketch
        // hasn't called Serial.begin yet, so rxEnable is false) nothing
        // would ever re-kick the queue and bytes from a sibling board
        // sit there forever. A per-frame retry is cheap (no-op when the
        // queue is empty or rxBusyValue is set) and makes the link
        // self-heal across both startup races and Serial.end()/begin()
        // toggles in the sketch.
        for (const port of this.uartPorts) port.retryPending();
        // The Wire and SPI edges the clock reached this frame go to the
        // scope in one go.
        this.releaseScopeEdges();

        frameCount++;
        if (frameCount % 60 === 0) {
          console.log(`[CPU] Frame ${frameCount}, PC: ${this.cpu.pc}, Cycles: ${this.cpu.cycles}`);
        }
      } catch (error) {
        console.error('Simulation error:', error);
        this.stop();
        return;
      }

      this.animationFrame = requestAnimationFrame(execute);
    };

    this.animationFrame = requestAnimationFrame(execute);
  }

  /**
   * Stop simulation
   */
  stop(): void {
    if (!this.running) return;

    this.running = false;
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this.scheduledPinChanges = [];
    this.lines?.reset();
    this.externalScope.reset();
    this.flushScopeEdges();

    // Drop any bytes the previous run had queued for the sketch's RX
    // but never delivered (RX disabled, busy, or the sketch hadn't
    // reached Serial.begin yet). Without this the next run starts with
    // a stale tail that drains into the fresh USART before the sketch
    // is ready, and from the user's point of view the link is "dead".
    for (const port of this.uartPorts) port.dropPending();

    console.log('AVR simulation stopped');
  }

  /**
   * Reset simulator (re-run program from scratch without recompiling)
   */
  reset(): void {
    this.stop();
    // A reset is a reboot whether or not the loop was running (stop() returns
    // early when it was not): the edge queue and every hosted line model start
    // over with the CPU.
    this.scheduledPinChanges = [];
    this.lines?.reset();
    this.externalScope.reset();
    if (this.program) {
      console.log('Resetting AVR CPU...');
      // The same chip a firmware load builds, variant and all. EEPROM cells
      // survive (attachEeprom reuses the backend), as on real hardware.
      this.buildMcu();
      this.announceMcuReset();
      console.log('AVR CPU reset complete');
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(0.1, Math.min(10.0, speed));
    console.log(`Simulation speed set to ${this.speed}x`);
  }

  getSpeed(): number {
    return this.speed;
  }

  /** One instruction, exactly as the frame loop runs it: execute, tick, and
   *  apply every scheduled pin edge that came due. */
  step(): void {
    if (!this.cpu) return;
    avrInstruction(this.cpu);
    this.cpu.tick();
    if (this.scheduledPinChanges.length > 0) this.flushScheduledPinChanges();
  }

  /**
   * Schedule a callback N CPU cycles from now — cycle-accurate timing for
   * external bit-bang sources (a custom chip's UART TX driving a GPIO that
   * SoftwareSerial samples). Returns false when no CPU is live (not
   * started / stopped); callers should drop rather than queue.
   */
  addClockEvent(callback: () => void, cycles: number): boolean {
    if (!this.cpu) return false;
    this.cpu.addClockEvent(callback, cycles);
    return true;
  }

  /** CPU clock in Hz — every supported AVR variant here runs at 16 MHz. */
  get clockFrequency(): number {
    return 16000000;
  }

  /** The guest clock every scope sample of this board is stamped on, in ms
   *  (cycles / 16 000, as firePinChangeWithTime stamps them). */
  scopeClockMs(): number {
    return this.cpu ? this.cpu.cycles / 16_000 : 0;
  }

  /**
   * Set the state of an Arduino pin externally (e.g. from a UI button)
   */
  setPinState(arduinoPin: number, state: boolean): void {
    if (this.boardVariant === 'mega') {
      const entry = MEGA_PIN_TO_PORT[arduinoPin];
      if (!entry) return;
      this.megaPorts.get(entry.portName)?.setPin(entry.bit, state);
    } else if (this.boardVariant === 'tiny85') {
      // ATtiny85: PB0-PB5 = pins 0-5
      if (!(arduinoPin >= 0 && arduinoPin <= 5 && this.portB)) return;
      this.portB.setPin(arduinoPin, state);
    } else if (arduinoPin >= 0 && arduinoPin <= 7 && this.portD) {
      this.portD.setPin(arduinoPin, state);
    } else if (arduinoPin >= 8 && arduinoPin <= 13 && this.portB) {
      this.portB.setPin(arduinoPin - 8, state);
    } else if (arduinoPin >= 14 && arduinoPin <= 19 && this.portC) {
      this.portC.setPin(arduinoPin - 14, state);
    } else {
      return; // not a pad this variant has
    }
    // The oscilloscope hears about an injected level HERE or not at all:
    // avr8js's port listeners, which firePinChangeWithTime rides on, fire on
    // PORT/DDR writes only. A pin the sketch drives as an OUTPUT is left out
    // because silicon leaves it out — setPin moves the PIN register for bits
    // whose DDR says input, so reporting it would draw a level the pad does
    // not have.
    if (this.mcuDrives(arduinoPin)) return;
    // The wire's level channel hears it too. This is the single door every
    // external level comes through (a button, a tilt switch, a line model's
    // edge, the SPICE connector), and the PinManager's `pinStates` is the
    // level the wire holds; without this line it held the PORT latch, so a
    // custom chip watching a pin a part drives saw the pull-up's HIGH for
    // ever while the sketch's digitalRead saw every press (finding
    // chip-board-pin-read-blind-to-other-parts). Left out while the sketch
    // drives the pad, as the register is: the injected level is not on the
    // wire then.
    this.pinManager.triggerPinChange(arduinoPin, state, 'external');
    this.externalScope.emit(this.padScope, arduinoPin, state);
  }

  /**
   * Is the sketch DRIVING this pad right now?
   *
   * Asked of the DDR register rather than `pinManager.getOutputPins()`,
   * because that set is sticky by design — "pins the MCU has driven this
   * session" — and a bidirectional line stays in it for ever. A DHT22's DATA
   * pin is driven low by the sketch's start signal and then released for the
   * sensor to answer on; with the sticky set as the guard, every bit of that
   * answer would be dropped on the way to the scope.
   */
  private mcuDrives(pin: number): boolean {
    const cpu = this.cpu;
    if (!cpu) return false;
    const ddrAt = (addr: number, bit: number) => ((cpu.data[addr] ?? 0) & (1 << bit)) !== 0;
    if (this.boardVariant === 'mega') {
      const entry = MEGA_PIN_TO_PORT[pin];
      const addr = entry ? MEGA_DDR_ADDRS[entry.portName] : undefined;
      return addr !== undefined && entry !== undefined && ddrAt(addr, entry.bit);
    }
    if (this.boardVariant === 'tiny85') return pin <= 5 && ddrAt(TINY85_DDRB, pin);
    if (pin <= 7) return ddrAt(UNO_DDRD, pin);
    if (pin <= 13) return ddrAt(UNO_DDRB, pin - 8);
    if (pin <= 19) return ddrAt(UNO_DDRC, pin - 14);
    return false;
  }

  /**
   * Send text to the Arduino serial port (RX), as if typed in the Serial
   * Monitor: USART0's RX, through its port, which paces the bytes at the
   * configured rate (avr8js has no RX FIFO; see AvrUartPort).
   */
  serialWrite(text: string): void {
    const port = this.uartPorts[0];
    if (!port) return;
    for (let i = 0; i < text.length; i++) port.receive(text.charCodeAt(i));
  }

  /**
   * Feed bytes into a hardware UART's RX from a wired peer board via
   * Interconnect. Uniform seam across simulators (`sim.feedUart(uart, data)`);
   * a part on the canvas reaches the same RX through the bus fabric instead.
   *
   * `uart` is the USART index: 0 on every ATmega, 0..3 on the Mega. A unit
   * this chip does not have reports false.
   *
   * @returns true when the bytes were queued for delivery.
   */
  feedUart(uart: number, data: string): boolean {
    const port = this.uartPorts[uart];
    if (!port) return false;
    for (let i = 0; i < data.length; i++) port.receive(data.charCodeAt(i));
    return true;
  }

  // ── Bus fabric (project board-buses-2026-09) ──────────────────────────────

  /**
   * What the bus fabric needs from this board: its pins, its SPI controller
   * and its resets. Built once; the port in it outlives every CPU rebuild.
   *
   * The ATtiny85 reports no SPI controller. ATTinyCore runs SPI on the USI in
   * three-wire mode, but avr8js's AVRUSI has no byte callback (it only shifts
   * the data register on each clock strobe) and models a single data pin for
   * both DI and DO (PB0 here, the two-wire SDA), so there is no frame to hand
   * the fabric and no place to put its MISO. Bit-banged buses (shiftOut,
   * software SPI) reach the fabric through its software-bus decoder instead,
   * on this board as on any other.
   *
   * I2C is the TWI on the ATmegas: the I2CBusManager is its controller port
   * (unit 0, pins fixed by the board table), made once and re-pointed at
   * every new AVRTWI. The ATtiny85 reports no I2C controller either, for the
   * same reason as SPI and one more: its USI in two-wire mode IS the pins.
   * TinyWireM shifts every bit out through PORTB, so the board's PB0/PB2
   * carry the whole transaction as edges, and the fabric's software decoder
   * reads it there and answers with SDA held low, which is what the USI
   * samples. A port fed from those same edges would hand every target each
   * transaction twice.
   */
  getBusBinding(): EngineBinding {
    if (!this.busBinding) {
      this.busBinding = {
        pins: boardPinsFromPinManager(this.pinManager, (pin, level) => this.setPinState(pin, level)),
        spi: this.spiPort ? [this.spiPort] : [],
        i2c: this.boardVariant === 'tiny85' ? [] : [this.i2cBus],
        uart: this.uartPorts,
        clock: this.guestClock(),
        setResetHandler: (handler) => {
          this.busResetHandler = handler;
        },
      };
    }
    return this.busBinding;
  }

  /**
   * The guest's clock for the software UART: the cycle counter every pin
   * callback already runs on, the edge queue the line models use, and a timer
   * on avr8js's own clock events, which fire between instructions at their
   * cycle. A timer belongs to the CPU it was set on; a rebuilt CPU drops it,
   * and the fabric restarts its decoders on that reset anyway.
   */
  private guestClock(): GuestClock {
    return {
      now: () => this.getCurrentCycles(),
      clockHz: () => this.getClockHz(),
      scheduleEdge: (pin, level, atCycle) => this.schedulePinChange(pin, level, atCycle),
      at: (atCycle, cb) => {
        const cpu = this.cpu;
        if (!cpu) return () => {};
        const event = cpu.addClockEvent(cb, atCycle - cpu.cycles);
        return () => {
          cpu.clearClockEvent(event);
        };
      },
    };
  }

  // ── Line-owning sensors (simulation/line) ─────────────────────────────────
  // The models run here, in the browser, on this CPU's own cycle counter:
  // edges are flushed after every instruction and nothing in this family
  // advances the clock without executing, so the contract holds by
  // construction. The legacy `registerSensor` stays a no-op for callers that
  // still probe it; the line contract is the path a part takes.

  lineSupport(): LineSupport {
    return { mode: 'local' };
  }

  lineHub(): LineSensorHub {
    if (!this.lines) {
      const port: LineHostPort = {
        now: () => this.getCurrentCycles(),
        clockHz: () => this.getClockHz(),
        scheduleEdge: (pin, level, atCycle) => this.schedulePinChange(pin, level, atCycle),
        onPad: (pin, cb) => this.pinManager.onPadChange(pin, cb),
        // avr8js has no notion of a host-owned pad: an injected level simply
        // becomes the PIN register's value, and a released line on its pull-up
        // reads exactly the level the pull produces. Seeding it is the rest.
        restPad: (pin, level) => this.setPinState(pin, level),
      };
      this.lines = new LineSensorHub(port);
    }
    return this.lines;
  }

  /** Pads a hosted line model drives itself — the SPICE-threshold connector
   *  asks before pushing a solved level into the guest (connectDigitalInputsToMcu). */
  ownsPin(pin: number): boolean {
    return this.lines?.ownsPin(pin) ?? false;
  }

  registerSensor(_type: string, _pin: number, _props: Record<string, unknown>): boolean {
    return false;
  }
  updateSensor(_pin: number, _props: Record<string, unknown>): void {}
  unregisterSensor(_pin: number): void {}
}
