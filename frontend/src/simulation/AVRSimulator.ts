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
} from 'avr8js';
import { PinManager } from './PinManager';
import { hexToUint8Array } from '../utils/hexParser';
import { I2CBusManager } from './I2CBusManager';
import type { I2CDevice } from './I2CBusManager';
import {
  getEventBus,
  shouldEmitThrottled,
  TICK_INTERVAL_MS,
  type ThrottleState,
} from './EventBus';

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
// Timer0: OC0A→PB0, OC0B→PB1 (ATtiny85 Timer0 OCR regs at 0x56, 0x5C)
// Timer1: OC1A→PB1, OC1B→PB4 (ATtinyTimer1 OCR regs from attinyTimer1Config)
const PWM_PINS_TINY85 = [
  { ocrAddr: 0x56, pin: 0, label: 'OCR0A' }, // Timer0A → PB0
  { ocrAddr: 0x5c, pin: 1, label: 'OCR0B' }, // Timer0B → PB1
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

export class AVRSimulator {
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
  public spi: AVRSPI | null = null;
  public usart: AVRUSART | null = null;
  public twi: AVRTWI | null = null;
  public i2cBus: I2CBusManager | null = null;
  private program: Uint16Array | null = null;
  private running = false;
  private animationFrame: number | null = null;
  public pinManager: PinManager;
  private speed = 1.0;
  /** 'uno' for ATmega328P boards (Uno, Nano); 'mega' for ATmega2560; 'tiny85' for ATtiny85 */
  private boardVariant: 'uno' | 'mega' | 'tiny85';

  /** Cycle-accurate pin change queue — used by timing-sensitive peripherals (e.g. DHT22). */
  private scheduledPinChanges: Array<{ cycle: number; pin: number; state: boolean }> = [];

  /** Serial output buffer — subscribers receive each byte or line */
  public onSerialData: ((char: string) => void) | null = null;
  /** Fires whenever the sketch changes Serial baud rate (Serial.begin) */
  public onBaudRateChange: ((baudRate: number) => void) | null = null;
  /**
   * Fires for every digital pin transition with a millisecond timestamp
   * derived from the CPU cycle counter (cycles / CPU_HZ * 1000).
   * Used by the oscilloscope / logic analyzer.
   */
  public onPinChangeWithTime: ((pin: number, state: boolean, timeMs: number) => void) | null = null;
  private lastPortBValue = 0;
  private lastPortCValue = 0;
  private lastPortDValue = 0;
  private lastOcrValues: number[] = [];

  private readonly bus = getEventBus();
  private readonly tickThrottle: ThrottleState = { lastEmitMs: 0 };

  constructor(pinManager: PinManager, boardVariant: 'uno' | 'mega' | 'tiny85' = 'uno') {
    this.pinManager = pinManager;
    this.boardVariant = boardVariant;
  }

  private get pwmPins() {
    if (this.boardVariant === 'mega') return PWM_PINS_MEGA;
    if (this.boardVariant === 'tiny85') return PWM_PINS_TINY85;
    return PWM_PINS_UNO;
  }

  /**
   * Load compiled hex file into simulator
   */
  loadHex(hexContent: string): void {
    console.log('Loading HEX file...');

    const bytes = hexToUint8Array(hexContent);

    // ATmega328P: 32 KB = 16 384 words.  ATmega2560: 256 KB = 131 072 words.
    // ATtiny85: 8 KB = 4 096 words, 512 bytes SRAM.
    const progWords =
      this.boardVariant === 'mega' ? 131072 : this.boardVariant === 'tiny85' ? 4096 : 16384;
    // ATmega2560 data space: 0x0000–0x21FF = 8704 bytes total.
    // avr8js: data.length = sramBytes + registerSpace (0x100 = 256).
    // So sramBytes must be >= 8704 − 256 = 8448 to fit RAMEND=0x21FF on the stack.
    // ATmega328P RAMEND = 0x08FF; default 8192 is already a safe over-alloc.
    // ATtiny85 RAMEND = 0x025F; 512 bytes SRAM.
    const sramBytes =
      this.boardVariant === 'mega' ? 8448 : this.boardVariant === 'tiny85' ? 512 : 8192;

    this.program = new Uint16Array(progWords);
    for (let i = 0; i < bytes.length; i += 2) {
      this.program[i >> 1] = (bytes[i] || 0) | ((bytes[i + 1] || 0) << 8);
    }

    console.log(`Loaded ${bytes.length} bytes into program memory`);

    this.cpu = new CPU(this.program, sramBytes);

    if (this.boardVariant === 'tiny85') {
      // ATtiny85: PORTB only (PB0-PB5), Timer1 via ATtinyTimer1, no USART
      this.portB = new AVRIOPort(this.cpu, attiny85PortBConfig as typeof portBConfig);
      this.adc = new AVRADC(this.cpu, adcConfig);
      this.peripherals = [new ATtinyTimer1(this.cpu, attinyTimer1Config)];
      // usart stays null — ATtiny85 has no hardware USART
    } else {
      // ATmega2560 has more vectors before the timers/USART (8 external INTs, etc.),
      // so the interrupt WORD addresses differ from ATmega328P.
      //
      // avr8js config values are WORD addresses = _VECTOR(N) * 2
      // (each JMP vector = 4 bytes = 2 words; cpu.pc * 2 == byte address).
      //
      // ATmega2560 word addresses (_VECTOR(N) → N * 2):
      //   TIMER2_COMPA=_V(13)→0x1A  TIMER2_COMPB=_V(14)→0x1C  TIMER2_OVF=_V(15)→0x1E
      //   TIMER1_CAPT=_V(16)→0x20   TIMER1_COMPA=_V(17)→0x22  TIMER1_COMPB=_V(18)→0x24
      //   TIMER1_COMPC=_V(19)→0x26  TIMER1_OVF=_V(20)→0x28
      //   TIMER0_COMPA=_V(21)→0x2A  TIMER0_COMPB=_V(22)→0x2C  TIMER0_OVF=_V(23)→0x2E
      //   SPI_STC=_V(24)→0x30       USART0_RX=_V(25)→0x32
      //   USART0_UDRE=_V(26)→0x34   USART0_TX=_V(27)→0x36
      //   TWI=_V(39)→0x4E
      const isMega = this.boardVariant === 'mega';
      const activeTimer0Config = isMega
        ? { ...timer0Config, compAInterrupt: 0x2a, compBInterrupt: 0x2c, ovfInterrupt: 0x2e }
        : timer0Config;
      const activeTimer1Config = isMega
        ? {
            ...timer1Config,
            captureInterrupt: 0x20,
            compAInterrupt: 0x22,
            compBInterrupt: 0x24,
            ovfInterrupt: 0x28,
          }
        : timer1Config;
      const activeTimer2Config = isMega
        ? { ...timer2Config, compAInterrupt: 0x1a, compBInterrupt: 0x1c, ovfInterrupt: 0x1e }
        : timer2Config;
      const activeUsart0Config = isMega
        ? {
            ...usart0Config,
            rxCompleteInterrupt: 0x32,
            dataRegisterEmptyInterrupt: 0x34,
            txCompleteInterrupt: 0x36,
          }
        : usart0Config;
      const activeSpiConfig = isMega ? { ...spiConfig, spiInterrupt: 0x30 } : spiConfig;
      const activeTwiConfig = isMega ? { ...twiConfig, twiInterrupt: 0x4e } : twiConfig;

      this.spi = new AVRSPI(this.cpu, activeSpiConfig, 16000000);
      this.spi.onByte = (value) => {
        this.spi!.completeTransfer(value);
      };

      this.usart = new AVRUSART(this.cpu, activeUsart0Config, 16000000);
      this.usart.onByteTransmit = (value: number) => {
        if (this.onSerialData) this.onSerialData(String.fromCharCode(value));
        if (this.bus.hasListeners('serial:tx')) {
          this.bus.emit('serial:tx', { port: 0, data: new Uint8Array([value]) });
        }
      };
      this.usart.onConfigurationChange = () => {
        if (this.onBaudRateChange && this.usart) this.onBaudRateChange(this.usart.baudRate);
      };

      this.twi = new AVRTWI(this.cpu, activeTwiConfig, 16000000);
      this.i2cBus = new I2CBusManager(this.twi);

      this.peripherals = [
        new AVRTimer(this.cpu, activeTimer0Config),
        new AVRTimer(this.cpu, activeTimer1Config),
        new AVRTimer(this.cpu, activeTimer2Config),
        this.usart,
        this.spi,
        this.twi,
      ];

      this.adc = new AVRADC(this.cpu, adcConfig);

      // ── GPIO ports ──────────────────────────────────────────────────────
      this.portB = new AVRIOPort(this.cpu, portBConfig);
      this.portC = new AVRIOPort(this.cpu, portCConfig);
      this.portD = new AVRIOPort(this.cpu, portDConfig);

      if (this.boardVariant === 'mega') {
        this.megaPorts.clear();
        this.megaPortValues.clear();
        for (const { name, config } of MEGA_PORT_CONFIGS) {
          this.megaPorts.set(name, new AVRIOPort(this.cpu, config));
          this.megaPortValues.set(name, 0);
        }
      }
    }

    this.lastPortBValue = 0;
    this.lastPortCValue = 0;
    this.lastPortDValue = 0;
    this.lastOcrValues = new Array(this.pwmPins.length).fill(0);

    this.setupPinHooks();

    const boardName =
      this.boardVariant === 'mega'
        ? 'ATmega2560'
        : this.boardVariant === 'tiny85'
          ? 'ATtiny85'
          : 'ATmega328P';
    console.log(`AVR CPU initialized (${boardName}, ${this.peripherals.length} peripherals)`);
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
    if (!this.cpu) return;
    // Fast-path guard: if nobody cares about per-bit changes, skip the loop
    // entirely. This keeps the port-listener hot path at near-zero overhead
    // when no plugins and no local callbacks are attached.
    const busHasListeners = this.bus.hasListeners('pin:change');
    if (!this.onPinChangeWithTime && !busHasListeners) return;

    const timeMs = this.cpu.cycles / 16_000;
    const changed = newVal ^ oldVal;
    for (let bit = 0; bit < 8; bit++) {
      if (changed & (1 << bit)) {
        const pin = pinMap ? pinMap[bit] : offset + bit;
        if (pin < 0) continue;
        const state = (newVal & (1 << bit)) !== 0;
        if (this.onPinChangeWithTime) this.onPinChangeWithTime(pin, state, timeMs);
        if (busHasListeners) {
          this.bus.emit('pin:change', {
            componentId: 'board:mcu',
            pinName: `D${pin}`,
            state: state ? 1 : 0,
          });
        }
      }
    }
  }

  /**
   * Monitor pin changes and update component states
   */
  private setupPinHooks(): void {
    if (!this.cpu) return;
    console.log('Setting up pin hooks...');

    if (this.boardVariant === 'tiny85') {
      // ATtiny85: PORTB only, PB0-PB5 → pins 0-5
      // Must pass an explicit pinMap so updatePort uses offset 0 instead of the
      // legacy PORTB offset (8) which would map PB1 → pin 9, etc.
      const TINY85_PIN_MAP = [0, 1, 2, 3, 4, 5, -1, -1];
      this.portB!.addListener((value) => {
        if (value !== this.lastPortBValue) {
          this.pinManager.updatePort('PORTB', value, this.lastPortBValue, TINY85_PIN_MAP);
          this.firePinChangeWithTime(value, this.lastPortBValue, null, 0);
          this.lastPortBValue = value;
        }
      });
    } else if (this.boardVariant === 'mega') {
      // Mega: use explicit per-bit pin maps for all 11 ports
      for (const [portName, port] of this.megaPorts) {
        const pinMap = MEGA_PORT_BIT_MAP[portName];
        this.megaPortValues.set(portName, 0);
        port.addListener((value) => {
          const old = this.megaPortValues.get(portName) ?? 0;
          if (value !== old) {
            this.pinManager.updatePort(portName, value, old, pinMap);
            this.firePinChangeWithTime(value, old, pinMap);
            this.megaPortValues.set(portName, value);
          }
        });
      }
    } else {
      // Uno / Nano: simple 3-port setup
      this.portB!.addListener((value) => {
        if (value !== this.lastPortBValue) {
          this.pinManager.updatePort('PORTB', value, this.lastPortBValue);
          this.firePinChangeWithTime(value, this.lastPortBValue, null, 8);
          this.lastPortBValue = value;
        }
      });
      this.portC!.addListener((value) => {
        if (value !== this.lastPortCValue) {
          this.pinManager.updatePort('PORTC', value, this.lastPortCValue);
          this.firePinChangeWithTime(value, this.lastPortCValue, null, 14);
          this.lastPortCValue = value;
        }
      });
      this.portD!.addListener((value) => {
        if (value !== this.lastPortDValue) {
          this.pinManager.updatePort('PORTD', value, this.lastPortDValue);
          this.firePinChangeWithTime(value, this.lastPortDValue, null, 0);
          this.lastPortDValue = value;
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
    const pins = this.pwmPins;
    for (let i = 0; i < pins.length; i++) {
      const { ocrAddr, pin } = pins[i];
      const ocrValue = this.cpu.data[ocrAddr];
      if (ocrValue !== this.lastOcrValues[i]) {
        this.lastOcrValues[i] = ocrValue;
        this.pinManager.updatePwm(pin, ocrValue / 255);
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

    const boardKind =
      this.boardVariant === 'mega'
        ? 'arduino-mega'
        : this.boardVariant === 'tiny85'
          ? 'arduino-uno'
          : 'arduino-uno';
    this.bus.emit('simulator:start', { board: boardKind, mode: 'mcu' });

    try {
      const dbg = (window as unknown as { __spiceDebug?: () => void }).__spiceDebug;
      if (typeof dbg === 'function') dbg();
      else console.warn('[spice] __spiceDebug not attached — wireElectricalSolver never mounted');
    } catch (e) {
      console.warn('[spice] debug dump failed', e);
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
        }

        // Poll PWM registers every frame
        this.pollPwmRegisters();

        // Throttled simulator:tick — only if a plugin is listening. The
        // hasListeners() guard keeps the common case (no plugin) at one
        // cheap branch per frame.
        if (this.bus.hasListeners('simulator:tick')) {
          if (shouldEmitThrottled(this.tickThrottle, timestamp, TICK_INTERVAL_MS)) {
            this.bus.emit('simulator:tick', {
              cycle: this.cpu.cycles,
              ts: timestamp,
            });
          }
        }

        frameCount++;
        if (frameCount % 60 === 0) {
          console.log(`[CPU] Frame ${frameCount}, PC: ${this.cpu.pc}, Cycles: ${this.cpu.cycles}`);
        }
      } catch (error) {
        console.error('Simulation error:', error);
        this.bus.emit('simulator:stop', { reason: 'crash' });
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
    // Reset throttle so a fresh run fires tick immediately.
    this.tickThrottle.lastEmitMs = 0;
    this.tickThrottle.primed = false;

    this.bus.emit('simulator:stop', { reason: 'user' });
    console.log('AVR simulation stopped');
  }

  /**
   * Reset simulator (re-run program from scratch without recompiling)
   */
  reset(): void {
    this.stop();
    this.bus.emit('simulator:reset', {});
    if (this.program) {
      // Re-use the stored hex content path: just reload
      const sramBytes =
        this.boardVariant === 'mega' ? 8448 : this.boardVariant === 'tiny85' ? 512 : 8192;
      console.log('Resetting AVR CPU...');

      this.cpu = new CPU(this.program, sramBytes);

      if (this.boardVariant === 'tiny85') {
        this.portB = new AVRIOPort(this.cpu, attiny85PortBConfig as typeof portBConfig);
        this.adc = new AVRADC(this.cpu, adcConfig);
        this.peripherals = [new ATtinyTimer1(this.cpu, attinyTimer1Config)];
        this.usart = null;
      } else {
        this.spi = new AVRSPI(this.cpu, spiConfig, 16000000);
        this.spi.onByte = (value) => {
          this.spi!.completeTransfer(value);
        };

        this.usart = new AVRUSART(this.cpu, usart0Config, 16000000);
        this.usart.onByteTransmit = (value: number) => {
          if (this.onSerialData) this.onSerialData(String.fromCharCode(value));
          if (this.bus.hasListeners('serial:tx')) {
            this.bus.emit('serial:tx', { port: 0, data: new Uint8Array([value]) });
          }
        };
        this.usart.onConfigurationChange = () => {
          if (this.onBaudRateChange && this.usart) this.onBaudRateChange(this.usart.baudRate);
        };

        this.twi = new AVRTWI(this.cpu, twiConfig, 16000000);
        this.i2cBus = new I2CBusManager(this.twi);

        this.peripherals = [
          new AVRTimer(this.cpu, timer0Config),
          new AVRTimer(this.cpu, timer1Config),
          new AVRTimer(this.cpu, timer2Config),
          this.usart,
          this.spi,
          this.twi,
        ];
        this.adc = new AVRADC(this.cpu, adcConfig);

        this.portB = new AVRIOPort(this.cpu, portBConfig);
        this.portC = new AVRIOPort(this.cpu, portCConfig);
        this.portD = new AVRIOPort(this.cpu, portDConfig);

        if (this.boardVariant === 'mega') {
          this.megaPorts.clear();
          this.megaPortValues.clear();
          for (const { name, config } of MEGA_PORT_CONFIGS) {
            this.megaPorts.set(name, new AVRIOPort(this.cpu, config));
            this.megaPortValues.set(name, 0);
          }
        }
      }

      this.lastPortBValue = 0;
      this.lastPortCValue = 0;
      this.lastPortDValue = 0;
      this.lastOcrValues = new Array(this.pwmPins.length).fill(0);
      this.setupPinHooks();

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

  step(): void {
    if (!this.cpu) return;
    avrInstruction(this.cpu);
    this.cpu.tick();
  }

  /**
   * Set the state of an Arduino pin externally (e.g. from a UI button)
   */
  setPinState(arduinoPin: number, state: boolean): void {
    if (this.boardVariant === 'mega') {
      const entry = MEGA_PIN_TO_PORT[arduinoPin];
      if (entry) {
        const port = this.megaPorts.get(entry.portName);
        port?.setPin(entry.bit, state);
      }
      return;
    }
    if (this.boardVariant === 'tiny85') {
      // ATtiny85: PB0-PB5 = pins 0-5
      if (arduinoPin >= 0 && arduinoPin <= 5 && this.portB) {
        this.portB.setPin(arduinoPin, state);
      }
      return;
    }
    // Uno / Nano
    if (arduinoPin >= 0 && arduinoPin <= 7 && this.portD) {
      this.portD.setPin(arduinoPin, state);
    } else if (arduinoPin >= 8 && arduinoPin <= 13 && this.portB) {
      this.portB.setPin(arduinoPin - 8, state);
    } else if (arduinoPin >= 14 && arduinoPin <= 19 && this.portC) {
      this.portC.setPin(arduinoPin - 14, state);
    }
  }

  /**
   * Send a byte to the Arduino serial port (RX) — as if typed in the Serial Monitor.
   */
  serialWrite(text: string): void {
    if (!this.usart) return;
    for (let i = 0; i < text.length; i++) {
      this.usart.writeByte(text.charCodeAt(i));
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

  // ── Generic sensor registration (board-agnostic API) ──────────────────────
  // AVR handles all sensor protocols locally via schedulePinChange,
  // so these return false / no-op — the sensor runs its own frontend logic.

  registerSensor(_type: string, _pin: number, _props: Record<string, unknown>): boolean {
    return false;
  }
  updateSensor(_pin: number, _props: Record<string, unknown>): void {}
  unregisterSensor(_pin: number): void {}
}
