/**
 * Thin wrapper around avr8js that mirrors how Velxio's AVRSimulator drives
 * the ATmega328P. Exposes:
 *   - load(hexText)
 *   - runCycles(n)
 *   - getPin(pin)            — digital 0/1
 *   - getPWMDuty(pin)        — 0..1 estimated duty for a PWM pin
 *   - setAnalogVoltage(ch, v) — inject voltage on ADC channel (0..5)
 *   - onPinChange(pin, cb)
 */
import {
  CPU, AVRIOPort, AVRTimer, AVRADC, AVRUSART,
  portBConfig, portCConfig, portDConfig,
  timer0Config, timer1Config, timer2Config,
  adcConfig, usart0Config,
  avrInstruction,
} from 'avr8js';
import { parseIntelHex, bytesToProgramWords } from './intelHex.js';

// ATmega328P PWM OCR addresses → Arduino Uno pin
const PWM_PINS = [
  { ocrAddr: 0x47, pin: 6,  label: 'OCR0A' },
  { ocrAddr: 0x48, pin: 5,  label: 'OCR0B' },
  { ocrAddr: 0x88, pin: 9,  label: 'OCR1AL' },
  { ocrAddr: 0x8A, pin: 10, label: 'OCR1BL' },
  { ocrAddr: 0xB3, pin: 11, label: 'OCR2A' },
  { ocrAddr: 0xB4, pin: 3,  label: 'OCR2B' },
];

// Arduino Uno pin ↔ (port, bit)
// PORTD bit 0..7 → D0..D7
// PORTB bit 0..5 → D8..D13
// PORTC bit 0..5 → A0..A5 (pins 14..19)
const PIN_MAP = {};
for (let i = 0; i < 8; i++) PIN_MAP[i] = { portName: 'D', bit: i };
for (let i = 0; i < 6; i++) PIN_MAP[8 + i] = { portName: 'B', bit: i };
for (let i = 0; i < 6; i++) PIN_MAP[14 + i] = { portName: 'C', bit: i };

export class AVRHarness {
  constructor() {
    this.cpu = null;
    this.ports = { B: null, C: null, D: null };
    this.adc = null;
    this.usart = null;
    this.timers = [];
    this.ocrValues = new Array(PWM_PINS.length).fill(0);
    this.pinListeners = new Map();   // pin → Set<fn>
    this.portValues = { B: 0, C: 0, D: 0 };
    this.serialOut = [];
  }

  load(hexText) {
    const bytes = parseIntelHex(hexText);
    const program = bytesToProgramWords(bytes);
    this._bindCpu(program);
  }

  /** Load a pre-assembled Uint16Array of instruction words. */
  loadProgram(words) {
    const program = new Uint16Array(0x8000 / 2);
    program.set(words);
    this._bindCpu(program);
  }

  _bindCpu(program) {
    this.cpu = new CPU(program, 8192);

    this.ports.B = new AVRIOPort(this.cpu, portBConfig);
    this.ports.C = new AVRIOPort(this.cpu, portCConfig);
    this.ports.D = new AVRIOPort(this.cpu, portDConfig);
    this.adc = new AVRADC(this.cpu, adcConfig);

    this.usart = new AVRUSART(this.cpu, usart0Config, 16_000_000);
    this.usart.onByteTransmit = (v) => this.serialOut.push(String.fromCharCode(v));

    this.timers = [
      new AVRTimer(this.cpu, timer0Config),
      new AVRTimer(this.cpu, timer1Config),
      new AVRTimer(this.cpu, timer2Config),
    ];

    for (const name of ['B', 'C', 'D']) {
      const port = this.ports[name];
      port.addListener((value, _oldValue) => {
        const old = this.portValues[name];
        this.portValues[name] = value;
        const changed = old ^ value;
        for (let bit = 0; bit < 8; bit++) {
          if (changed & (1 << bit)) {
            const arduinoPin = this._portBitToArduinoPin(name, bit);
            if (arduinoPin == null) continue;
            const state = (value >> bit) & 1;
            const set = this.pinListeners.get(arduinoPin);
            if (set) set.forEach(cb => cb(state));
          }
        }
      });
    }
  }

  _portBitToArduinoPin(portName, bit) {
    if (portName === 'B' && bit < 6) return 8 + bit;
    if (portName === 'C' && bit < 6) return 14 + bit;
    if (portName === 'D' && bit < 8) return bit;
    return null;
  }

  runCycles(n) {
    const end = this.cpu.cycles + n;
    while (this.cpu.cycles < end) {
      avrInstruction(this.cpu);
      this.cpu.tick();
    }
  }

  getPin(pin) {
    const m = PIN_MAP[pin];
    if (!m) return 0;
    const port = this.ports[m.portName];
    return (port.pinState(m.bit) === 3 || port.pinState(m.bit) === 1) ? 1 : 0;
    // pinState: 0=input low, 1=input high, 2=output low, 3=output high
  }

  onPinChange(pin, cb) {
    if (!this.pinListeners.has(pin)) this.pinListeners.set(pin, new Set());
    this.pinListeners.get(pin).add(cb);
    return () => this.pinListeners.get(pin).delete(cb);
  }

  /** Inject an analog voltage (0..5 V) onto ADC channel 0..5 (A0..A5). */
  setAnalogVoltage(channel, volts) {
    if (!this.adc) return;
    this.adc.channelValues[channel] = Math.max(0, Math.min(5, volts));
  }

  /**
   * Estimate PWM duty cycle on a supported pin by reading the OCR register.
   * Returns 0..1. Returns null if the pin is not a PWM pin.
   */
  getPWMDuty(pin) {
    const entry = PWM_PINS.find(p => p.pin === pin);
    if (!entry) return null;
    const ocrVal = this.cpu.data[entry.ocrAddr];
    return ocrVal / 255;
  }

  getSerialOutput() {
    return this.serialOut.join('');
  }
}
