import { RP2040, GPIOPinState } from 'rp2040js';
import { PinManager } from './PinManager';

/**
 * RP2040Simulator — Emulates Raspberry Pi Pico (RP2040) using rp2040js
 *
 * Features:
 * - ARM Cortex-M0+ CPU emulation at 125 MHz
 * - 30 GPIO pins (GPIO0-GPIO29)
 * - ADC on GPIO26-GPIO29 (A0-A3)
 * - LED_BUILTIN on GPIO25
 *
 * Arduino-pico pin mapping (Earle Philhower's core):
 *   D0  = GPIO0   … D29 = GPIO29
 *   A0  = GPIO26  … A3  = GPIO29
 *   LED_BUILTIN = GPIO25
 */

const F_CPU = 125_000_000; // 125 MHz
const CYCLE_NANOS = 1e9 / F_CPU; // nanoseconds per cycle (~8 ns)
const FPS = 60;
const CYCLES_PER_FRAME = Math.floor(F_CPU / FPS); // ~2 083 333

export class RP2040Simulator {
  private rp2040: RP2040 | null = null;
  private running = false;
  private animationFrame: number | null = null;
  public pinManager: PinManager;
  private speed = 1.0;
  private gpioUnsubscribers: Array<() => void> = [];

  constructor(pinManager: PinManager) {
    this.pinManager = pinManager;
  }

  /**
   * Load a compiled binary into the RP2040 flash memory.
   * Accepts a base64-encoded string of the raw .bin file output by arduino-cli.
   */
  loadBinary(base64: string): void {
    console.log('[RP2040] Loading binary...');

    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    console.log(`[RP2040] Binary size: ${bytes.length} bytes`);

    this.rp2040 = new RP2040();

    // Load binary into flash starting at offset 0 (maps to 0x10000000)
    this.rp2040.flash.set(bytes, 0);

    // Set up GPIO listeners
    this.setupGpioListeners();

    console.log('[RP2040] CPU initialized, GPIO listeners attached');
  }

  /** Same interface as AVRSimulator for store compatibility */
  loadHex(_hexContent: string): void {
    console.warn('[RP2040] loadHex() called on RP2040Simulator — use loadBinary() instead');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getADC(): any {
    return this.rp2040?.adc ?? null;
  }

  private setupGpioListeners(): void {
    this.gpioUnsubscribers.forEach(fn => fn());
    this.gpioUnsubscribers = [];

    if (!this.rp2040) return;

    for (let gpioIdx = 0; gpioIdx < 30; gpioIdx++) {
      const pin = gpioIdx;
      const gpio = this.rp2040.gpio[gpioIdx];
      if (!gpio) continue;

      const unsub = gpio.addListener((state: GPIOPinState, _oldState: GPIOPinState) => {
        const isHigh = state === GPIOPinState.High;
        this.pinManager.triggerPinChange(pin, isHigh);
      });
      this.gpioUnsubscribers.push(unsub);
    }
  }

  start(): void {
    if (this.running || !this.rp2040) {
      console.warn('[RP2040] Already running or not initialized');
      return;
    }

    this.running = true;
    console.log('[RP2040] Starting simulation at 125 MHz...');

    let frameCount = 0;
    const execute = (_timestamp: number) => {
      if (!this.running || !this.rp2040) return;

      const cyclesTarget = Math.floor(CYCLES_PER_FRAME * this.speed);
      const { core } = this.rp2040;
      // Access the internal clock — rp2040js attaches it to the RP2040 instance
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const clock = (this.rp2040 as any).clock;

      try {
        let cyclesDone = 0;
        while (cyclesDone < cyclesTarget) {
          if (core.waiting) {
            if (clock) {
              const jump: number = clock.nanosToNextAlarm;
              clock.tick(jump);
              cyclesDone += Math.ceil(jump / CYCLE_NANOS);
            } else {
              break;
            }
          } else {
            const cycles: number = core.executeInstruction();
            if (clock) clock.tick(cycles * CYCLE_NANOS);
            cyclesDone += cycles;
          }
        }

        frameCount++;
        if (frameCount % 60 === 0) {
          console.log(`[RP2040] Frame ${frameCount}, PC: 0x${core.PC.toString(16)}`);
        }
      } catch (error) {
        console.error('[RP2040] Simulation error:', error);
        this.stop();
        return;
      }

      this.animationFrame = requestAnimationFrame(execute);
    };

    this.animationFrame = requestAnimationFrame(execute);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    console.log('[RP2040] Simulation stopped');
  }

  reset(): void {
    this.stop();
    if (this.rp2040) {
      const flashCopy = new Uint8Array(this.rp2040.flash);
      this.rp2040 = new RP2040();
      this.rp2040.flash.set(flashCopy, 0);
      this.setupGpioListeners();
      console.log('[RP2040] CPU reset');
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(0.1, Math.min(10.0, speed));
  }

  /**
   * Drive a GPIO pin externally (e.g. from a button or slider).
   * GPIO n = Arduino D(n) for Raspberry Pi Pico.
   */
  setPinState(arduinoPin: number, state: boolean): void {
    if (!this.rp2040) return;
    const gpio = this.rp2040.gpio[arduinoPin];
    if (gpio) {
      gpio.setInputValue(state);
    }
  }
}
