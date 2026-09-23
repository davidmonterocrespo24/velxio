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
} from 'avr8js';
import type { AVREEPROMConfig, SPIConfig, TWIConfig } from 'avr8js';
import type { AVRTimerConfig } from 'avr8js/dist/esm/peripherals/timer';
import type { ADCConfig, ADCMuxConfiguration } from 'avr8js/dist/esm/peripherals/adc';
import { ADCMuxInputType, ADCReference } from 'avr8js/dist/esm/peripherals/adc';
import { PinManager } from './PinManager';
import type {
  BusCapableSimulator,
  EngineBinding,
  SpiControllerConfig,
  SpiControllerPort,
  SpiMode,
  SpiRouting,
} from './buses/types';
import { ExternalPinScopeFeed } from './externalPinScope';
import type { LineCapable, LineHostPort, LineSupport } from './line/LineHost';
import { LineSensorHub } from './line/LineSensorHub';
import { hexToUint8Array } from '../utils/hexParser';
import type { SerialLink } from '../store/serialWire';
import { I2CBusManager, nullI2CMaster } from './I2CBusManager';
import type { I2CDevice } from './I2CBusManager';
import { attachUsiI2c } from './UsiI2cBridge';
import { boardPinsFromPinManager } from './buses/boardPins';

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

// OCR register addresses → Arduino pin mapping for PWM (ATmega328P / Uno / Nano)
const PWM_PINS_UNO = [
  { ocrAddr: 0x47, pin: 6, label: 'OCR0A' }, // Timer0A → D6
  { ocrAddr: 0x48, pin: 5, label: 'OCR0B' }, // Timer0B → D5
  { ocrAddr: 0x88, pin: 9, label: 'OCR1AL' }, // Timer1A low byte → D9
  { ocrAddr: 0x8a, pin: 10, label: 'OCR1BL' }, // Timer1B low byte → D10
  { ocrAddr: 0xb3, pin: 11, label: 'OCR2A' }, // Timer2A → D11
  { ocrAddr: 0xb4, pin: 3, label: 'OCR2B' }, // Timer2B → D3
];

// OCR register addresses → Arduino Mega pin mapping for PWM (ATmega2560)
// Timers 0/1/2 same addresses; Timers 3/4/5 at higher addresses.
const PWM_PINS_MEGA = [
  { ocrAddr: 0x47, pin: 13, label: 'OCR0A' }, // Timer0A → D13
  { ocrAddr: 0x48, pin: 4, label: 'OCR0B' }, // Timer0B → D4
  { ocrAddr: 0x88, pin: 11, label: 'OCR1AL' }, // Timer1A → D11
  { ocrAddr: 0x8a, pin: 12, label: 'OCR1BL' }, // Timer1B → D12
  { ocrAddr: 0xb3, pin: 10, label: 'OCR2A' }, // Timer2A → D10
  { ocrAddr: 0xb4, pin: 9, label: 'OCR2B' }, // Timer2B → D9
  // Timer3 (0x80–0x8D, but OCR3A/B/C at 0x98/0x9A/0x9C)
  { ocrAddr: 0x98, pin: 5, label: 'OCR3AL' }, // Timer3A → D5
  { ocrAddr: 0x9a, pin: 2, label: 'OCR3BL' }, // Timer3B → D2
  { ocrAddr: 0x9c, pin: 3, label: 'OCR3CL' }, // Timer3C → D3
  // Timer4 (OCR4A/B/C at 0xA8/0xAA/0xAC)
  { ocrAddr: 0xa8, pin: 6, label: 'OCR4AL' }, // Timer4A → D6
  { ocrAddr: 0xaa, pin: 7, label: 'OCR4BL' }, // Timer4B → D7
  { ocrAddr: 0xac, pin: 8, label: 'OCR4CL' }, // Timer4C → D8
  // Timer5 (OCR5A/B/C at 0x128/0x12A/0x12C — extended I/O)
  { ocrAddr: 0x128, pin: 46, label: 'OCR5AL' }, // Timer5A → D46
  { ocrAddr: 0x12a, pin: 45, label: 'OCR5BL' }, // Timer5B → D45
  { ocrAddr: 0x12c, pin: 44, label: 'OCR5CL' }, // Timer5C → D44
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
const PWM_PINS_TINY85 = [
  { ocrAddr: 0x49, pin: 0, label: 'OCR0A' }, // Timer0A → PB0
  { ocrAddr: 0x48, pin: 1, label: 'OCR0B' }, // Timer0B → PB1
  { ocrAddr: 0x4e, pin: 1, label: 'OCR1A' }, // Timer1A → PB1 (attinyTimer1Config.OCR1A)
  { ocrAddr: 0x4b, pin: 4, label: 'OCR1B' }, // Timer1B → PB4 (attinyTimer1Config.OCR1B)
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

/** Ordered list of Mega ports with their avr8js configs */
const MEGA_PORT_CONFIGS = [
  { name: 'PORTA', config: portAConfig },
  { name: 'PORTB', config: portBConfig },
  { name: 'PORTC', config: portCConfig },
  { name: 'PORTD', config: portDConfig },
  { name: 'PORTE', config: portEConfig },
  { name: 'PORTF', config: portFConfig },
  { name: 'PORTG', config: portGConfig },
  { name: 'PORTH', config: portHConfig },
  { name: 'PORTJ', config: portJConfig },
  { name: 'PORTK', config: portKConfig },
  { name: 'PORTL', config: portLConfig },
];

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
interface AtmegaPeripheralConfigs {
  timer0: AVRTimerConfig;
  timer1: AVRTimerConfig;
  timer2: AVRTimerConfig;
  usart0: typeof usart0Config;
  spi: SPIConfig;
  twi: TWIConfig;
  adc: ADCConfig;
  eeprom: AVREEPROMConfig;
}

const ATMEGA328P_PERIPHERALS: AtmegaPeripheralConfigs = {
  timer0: timer0Config,
  timer1: timer1Config,
  timer2: timer2Config,
  usart0: usart0Config,
  spi: spiConfig,
  twi: twiConfig,
  adc: adcConfig,
  eeprom: eepromConfig,
};

const ATMEGA2560_PERIPHERALS: AtmegaPeripheralConfigs = {
  timer0: { ...timer0Config, compAInterrupt: 0x2a, compBInterrupt: 0x2c, ovfInterrupt: 0x2e },
  timer1: {
    ...timer1Config,
    captureInterrupt: 0x20,
    compAInterrupt: 0x22,
    compBInterrupt: 0x24,
    ovfInterrupt: 0x28,
  },
  timer2: { ...timer2Config, compAInterrupt: 0x1a, compBInterrupt: 0x1c, ovfInterrupt: 0x1e },
  usart0: {
    ...usart0Config,
    rxCompleteInterrupt: 0x32,
    dataRegisterEmptyInterrupt: 0x34,
    txCompleteInterrupt: 0x36,
  },
  spi: { ...spiConfig, spiInterrupt: 0x30 },
  twi: { ...twiConfig, twiInterrupt: 0x4e },
  adc: { ...adcConfig, adcInterrupt: 0x3a },
  eeprom: { ...eepromConfig, eepromReadyInterrupt: 0x3c },
};

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
  /** The CPU was (re)built: take over its SPI peripheral. */
  attach(engine: AVRSPI, cpu: CPU, config: SPIConfig): void {
    this.engine = engine;
    this.cpu = cpu;
    this.spcr = config.SPCR;
    engine.onByte = (mosi) => this.frame(engine, mosi);
  }

  private frame(engine: AVRSPI, mosi: number): void {
    // A peripheral of a CPU that has been replaced reaches nobody.
    if (engine !== this.engine) {
      engine.completeTransfer(0xff);
      return;
    }
    const miso = this.handler ? this.handler(mosi, 8) & 0xff : 0xff;
    engine.completeTransfer(miso);
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
  private cpu: CPU | null = null;
  /** Peripherals kept alive by reference so GC doesn't collect their CPU hooks */
  private peripherals: unknown[] = [];
  /**
   * Pending RX bytes waiting to be fed to the USART. avr8js's writeByte
   * rejects (returns false, drops the byte) whenever rxBusyValue is set
   * — and rxBusyValue stays set for `cyclesPerChar` after each call.
   * A naive `for c of text: usart.writeByte(c)` loop therefore only
   * delivers the first character. We buffer the rest here and drain
   * one byte at a time on each frame's tick.
   */
  private serialRxQueue: number[] = [];
  private portB: AVRIOPort | null = null;
  private portC: AVRIOPort | null = null;
  private portD: AVRIOPort | null = null;
  /** Extra ports used by the Mega (A, E–L); keyed by port name */
  private megaPorts: Map<string, AVRIOPort> = new Map();
  private megaPortValues: Map<string, number> = new Map();
  private adc: AVRADC | null = null;
  /** The SPI controller port (null on the ATtiny85, which has no SPI peripheral). */
  private readonly spiPort: AvrSpiPort | null;
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
  private lastOcrValues: number[] = [];
  /**
   * Last known TXEN bit value, used to detect 0→1 transitions and seed the
   * TX pin baseline at idle HIGH the moment the firmware enables the USART.
   * Without this seed the oscilloscope shows a floating/LOW baseline until
   * the first byte transmits, which doesn't match real hardware.
   */
  private lastTxEnable = false;

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
    // Create the bus up-front with a placeholder master so that
    // Interconnect can install cross-board bridges and parts can
    // register devices BEFORE the firmware loads.  The real AVRTWI
    // takes over via `i2cBus.attachMaster(twi)` inside loadHex.
    this.i2cBus = new I2CBusManager(nullI2CMaster());
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
    const cpu = new CPU(this.program, sramBytes);
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
        new AVRTimer(cpu, attiny85Timer0Config),
        new ATtinyTimer1(cpu, attinyTimer1Config),
        // The ATtiny85 also has no hardware TWI: TinyWireM / Tiny4kOLED drive
        // I2C through the USI peripheral on PB0 (SDA) / PB2 (SCL). Bridge that
        // onto the shared I2C bus so devices (SSD1306 OLED, etc.) receive data.
        // Rebuilt with every CPU, or a Stop/Run leaves the bus without a master.
        attachUsiI2c(cpu, this.portB, this.i2cBus),
      ];
    } else {
      const cfg = this.boardVariant === 'mega' ? ATMEGA2560_PERIPHERALS : ATMEGA328P_PERIPHERALS;

      const spi = new AVRSPI(cpu, cfg.spi, AVR_CPU_HZ);
      this.spiPort?.attach(spi, cpu, cfg.spi);

      const usart = new AVRUSART(cpu, cfg.usart0, AVR_CPU_HZ);
      this.usart = usart;
      usart.onByteTransmit = (value: number) => {
        if (this.onSerialData) this.onSerialData(String.fromCharCode(value));
        // Synthesize the UART frame on PD1 so the oscilloscope sees a real
        // waveform during Serial.print. See emitUartTxFrame() for details.
        this.emitUartTxFrame(value);
      };
      usart.onRxComplete = () => this.drainSerialRxQueue();
      usart.onConfigurationChange = () => {
        if (this.onBaudRateChange) {
          this.onBaudRateChange(usart.baudRate, {
            source: 'uart',
            baud: usart.baudRate,
            dataBits: usart.bitsPerChar,
            parity: usart.parityEnabled ? (usart.parityOdd ? 'odd' : 'even') : 'none',
            stopBits: usart.stopBits,
          });
        }
        // Seed idle HIGH on the TX pin the first time TXEN flips on.
        this.handleUartConfigChange();
      };

      this.twi = new AVRTWI(cpu, cfg.twi, AVR_CPU_HZ);
      // Attach the real AVRTWI to the bus created in the constructor;
      // any devices already registered + bridges already installed are
      // preserved across firmware (re)loads.
      this.i2cBus.attachMaster(this.twi);

      this.peripherals = [
        new AVRTimer(cpu, cfg.timer0),
        new AVRTimer(cpu, cfg.timer1),
        new AVRTimer(cpu, cfg.timer2),
        usart,
        spi,
        this.twi,
      ];

      this.adc = new AVRADC(cpu, cfg.adc);

      // ── GPIO ports ──────────────────────────────────────────────────────
      this.portB = new AVRIOPort(cpu, portBConfig);
      this.portC = new AVRIOPort(cpu, portCConfig);
      this.portD = new AVRIOPort(cpu, portDConfig);

      if (this.boardVariant === 'mega') {
        this.megaPorts.clear();
        this.megaPortValues.clear();
        for (const { name, config } of MEGA_PORT_CONFIGS) {
          this.megaPorts.set(name, new AVRIOPort(cpu, config));
          this.megaPortValues.set(name, 0);
        }
      }
    }

    this.attachEeprom();

    // Everything below mirrors the old CPU's registers: the new one starts
    // with every port, DDR and OCR at zero and the USART disabled.
    this.lastPortBValue = 0;
    this.lastPortCValue = 0;
    this.lastPortDValue = 0;
    this.lastDdr.clear();
    this.lastOcrValues = new Array(this.pwmPins.length).fill(0);
    this.lastTxEnable = false;

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
   * Synthesize a real bit-level UART frame on the TX pin so an oscilloscope
   * sees a waveform during Serial.print, matching real ATmega328P / ATmega2560
   * behavior. avr8js's USART only intercepts the byte at the UDR0 register
   * level — it never toggles PD1 (Uno/Nano) / PE1 (Mega), so without this
   * shim the TX pin is flat in the scope while real hardware would show the
   * UART frame at the configured baud rate.
   *
   * Frame layout (8N1, the Arduino default):
   *   [start LOW] [data LSB ... data MSB] [parity?] [stop1] [stop2?]
   *
   * We honour avr8js's USART configuration getters (bitsPerChar, parityEnabled,
   * parityOdd, stopBits, baudRate) so unusual configurations stay accurate.
   *
   * Each transition is emitted via onPinChangeWithTime so the oscilloscope
   * stamps it with simulator time (cpu.cycles / 16_000 ms), giving bit-level
   * timing that holds at any sweep speed.
   */
  private emitUartTxFrame(byte: number): void {
    const usart = this.usart;
    if (!usart || !this.cpu || !this.onPinChangeWithTime) return;
    if (!usart.txEnable) return;

    const baud = usart.baudRate;
    if (!baud || baud <= 0) return;

    // ATmega328P (Uno/Nano) UART0: TX = PD1 → Arduino pin 1
    // ATmega2560 (Mega)    UART0: TX = PE1 → Arduino pin 1 (Mega TX0)
    // ATtiny85 has no hardware USART so this method is never called.
    const txPin = 1;

    const freqHz = 16_000_000;
    const cyclesPerBit = freqHz / baud;
    const startCycle = this.cpu.cycles;

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
    // transition is needed — the next byte will start from HIGH automatically.
  }

  /**
   * Seed the TX pin at idle HIGH when the firmware sets TXEN for the first
   * time (typically inside Serial.begin).  Without this seed the scope's
   * "initial state before the first byte" defaults to LOW, hiding the start
   * bit transition of the very first byte sent.
   */
  private handleUartConfigChange(): void {
    if (!this.usart || !this.cpu) return;
    const tx = this.usart.txEnable;
    if (tx && !this.lastTxEnable && this.onPinChangeWithTime) {
      const timeMs = this.cpu.cycles / 16_000;
      this.onPinChangeWithTime(1, true, timeMs);
    }
    this.lastTxEnable = tx;
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
    for (let i = 0; i < pins.length; i++) {
      const { ocrAddr, pin } = pins[i];
      const ocrValue = this.cpu.data[ocrAddr];
      if (ocrValue !== this.lastOcrValues[i]) {
        this.lastOcrValues[i] = ocrValue;
        this.pinManager.updatePwm(pin, ocrValue / 255, timeMs);
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

    const execute = (timestamp: number) => {
      if (!this.running || !this.cpu) return;

      // Clamp delta so we never overshoot after a paused/backgrounded tab.
      // MAX_DELTA_MS already handles large initial deltas (e.g. first frame),
      // so no separate first-frame guard is needed.
      const rawDelta = timestamp - lastTimestamp;
      const deltaMs = Math.min(rawDelta, MAX_DELTA_MS);
      lastTimestamp = timestamp;

      const cyclesPerFrame = Math.floor(CYCLES_PER_MS * deltaMs * this.speed);

      try {
        for (let i = 0; i < cyclesPerFrame; i++) {
          avrInstruction(this.cpu); // Execute the AVR instruction
          this.cpu.tick(); // Update peripheral timers and cycles
          if (this.scheduledPinChanges.length > 0) this.flushScheduledPinChanges();
          // Poll PWM sub-frame (~every 256 cycles = 16µs) so short OCR pulses
          // (e.g. a metronome click that starts and ends within one 16ms frame)
          // aren't merged or lost at the frame boundary. 256 cycles is far finer
          // than any audible pulse yet light enough not to perturb frame pacing.
          if ((i & 0xff) === 0) this.pollPwmRegisters();
        }

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
        if (this.serialRxQueue.length > 0) this.drainSerialRxQueue();

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

    // Drop any bytes the previous run had queued for the sketch's RX
    // but never delivered (RX disabled, busy, or the sketch hadn't
    // reached Serial.begin yet). Without this the next run starts with
    // a stale tail that drains into the fresh USART before the sketch
    // is ready, and from the user's point of view the link is "dead".
    this.serialRxQueue = [];

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
    this.externalScope.emit(this.onPinChangeWithTime, arduinoPin, state);
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
   * Send a byte to the Arduino serial port (RX) — as if typed in the Serial Monitor.
   *
   * AVR has no hardware RX FIFO, so avr8js's writeByte() rejects every
   * call while rxBusyValue is set (one full cyclesPerChar after the
   * previous byte). A naive loop would only deliver the first character.
   * Queue the bytes here and drain one at a time from onRxComplete.
   */
  serialWrite(text: string): void {
    if (!this.usart) return;
    for (let i = 0; i < text.length; i++) {
      this.serialRxQueue.push(text.charCodeAt(i));
    }
    this.drainSerialRxQueue();
  }

  /**
   * Feed bytes into a hardware UART's RX from an external part (GPS module,
   * a wired peer board via Interconnect, …). Uniform seam across simulators
   * (`sim.feedUart(uart, data)`) — Interconnect already probes for it.
   *
   * The AVR core only emulates USART0 (Uno/Nano pins 0/1; Mega RX0). Mega
   * USART1-3 are not modelled by avr8js, so `uart > 0` reports false and the
   * caller can fall back to bit-level transport (e.g. SoftwareSerial).
   *
   * @returns true when the bytes were queued for delivery.
   */
  feedUart(uart: number, data: string): boolean {
    if (uart !== 0 || !this.usart) return false;
    this.serialWrite(data);
    return true;
  }

  /**
   * Pump the next pending RX byte into the USART. Called once from
   * serialWrite() to kick the pipeline, then re-armed from
   * usart.onRxComplete after every byte the sketch actually receives.
   * The cyclesPerChar gap that avr8js enforces between writeByte calls
   * gives the sketch time to read UDR0 between bytes — same pacing the
   * real chip sees at the configured baud rate.
   */
  private drainSerialRxQueue(): void {
    if (!this.usart) return;
    if (this.serialRxQueue.length === 0) return;
    const next = this.serialRxQueue[0];
    if (this.usart.writeByte(next)) {
      this.serialRxQueue.shift();
    }
  }

  /**
   * Register a virtual I2C device on the bus (e.g. RTC, sensor).
   */
  addI2CDevice(device: I2CDevice): void {
    if (this.i2cBus) {
      this.i2cBus.addDevice(device);
    }
  }

  /**
   * Remove a virtual I2C device by address.  Mirrors RP2040Simulator's
   * `removeI2CDevice(addr, bus)` shape so Interconnect / parts can use
   * the same uniform API across boards.
   */
  removeI2CDevice(address: number, _bus: 0 | 1 = 0): void {
    this.i2cBus?.removeDevice(address);
  }

  /**
   * Get the I2CBusManager for a given hardware I2C bus.  AVR has only
   * one TWI so `bus` is ignored.  Available from construction time so
   * Interconnect can install cross-board I2C bridges immediately
   * (the bus's master peripheral is swapped in later by `loadHex`).
   */
  getI2CBus(_bus: 0 | 1 = 0): I2CBusManager {
    return this.i2cBus;
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
   */
  getBusBinding(): EngineBinding {
    if (!this.busBinding) {
      this.busBinding = {
        pins: boardPinsFromPinManager(this.pinManager, (pin, level) => this.setPinState(pin, level)),
        spi: this.spiPort ? [this.spiPort] : [],
        setResetHandler: (handler) => {
          this.busResetHandler = handler;
        },
      };
    }
    return this.busBinding;
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
