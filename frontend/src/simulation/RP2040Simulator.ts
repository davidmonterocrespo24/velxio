import { RP2040, GPIOPinState, ConsoleLogger, LogLevel } from 'rp2040js';
import type { RPI2C } from 'rp2040js';
import { PinManager } from './PinManager';
import { bootromB1 } from './rp2040-bootrom';

/**
 * RP2040Simulator — Emulates Raspberry Pi Pico (RP2040) using rp2040js
 *
 * Features:
 * - ARM Cortex-M0+ dual-core Cortex-M0+ CPU at 125 MHz (single-core emulated)
 * - 30 GPIO pins (GPIO0-GPIO29)  xc fv       nn 
 * - 2× UART, 2× SPI, 2× I2C
 * - ADC on GPIO26-GPIO29 (A0-A3) + internal temp sensor (ch4)
 * - PWM on any GPIO
 * - LED_BUILTIN on GPIO25
 * - Full bootrom B1 for proper boot sequence
 *
 * Arduino-pico pin mapping (Earle Philhower's core):
 *   D0  = GPIO0   … D29 = GPIO29
 *   A0  = GPIO26  … A3  = GPIO29
 *   LED_BUILTIN = GPIO25
 *   Default Serial  → UART0 (GPIO0=TX, GPIO1=RX)
 *   Default I2C     → I2C0  (GPIO4=SDA, GPIO5=SCL)
 *   Default SPI     → SPI0  (GPIO16=MISO, GPIO19=MOSI, GPIO18=SCK, GPIO17=CS)
 */

const F_CPU = 125_000_000; // 125 MHz
const CYCLE_NANOS = 1e9 / F_CPU; // nanoseconds per cycle (~8 ns)
const FPS = 60;
const CYCLES_PER_FRAME = Math.floor(F_CPU / FPS); // ~2 083 333

/** Virtual I2C device interface for RP2040 */
export interface RP2040I2CDevice {
  /** 7-bit I2C address */
  address: number;
  /** Called when master writes a byte */
  writeByte(value: number): boolean;   // return true for ACK
  /** Called when master reads a byte */
  readByte(): number;
  /** Optional: called on STOP condition */
  stop?(): void;
}

export class RP2040Simulator {
  private rp2040: RP2040 | null = null;
  private running = false;
  private animationFrame: number | null = null;
  public pinManager: PinManager;
  private speed = 1.0;
  private gpioUnsubscribers: Array<() => void> = [];
  private flashCopy: Uint8Array | null = null;
  private totalCycles = 0;
  private scheduledPinChanges: Array<{ cycle: number; pin: number; state: boolean }> = [];
  private pioStepAccum = 0;

  /** Serial output callback — fires for each byte the Pico sends on UART0 */
  public onSerialData: ((char: string) => void) | null = null;

  /**
   * Fires for every GPIO pin transition with a millisecond timestamp.
   * Used by the oscilloscope / logic analyzer.
   * timeMs is derived from the RP2040 cycle counter (cycles / F_CPU * 1000).
   */
  public onPinChangeWithTime: ((pin: number, state: boolean, timeMs: number) => void) | null = null;

  /** I2C virtual devices on each bus */
  private i2cDevices: [Map<number, RP2040I2CDevice>, Map<number, RP2040I2CDevice>] = [new Map(), new Map()];
  private activeI2CDevice: [RP2040I2CDevice | null, RP2040I2CDevice | null] = [null, null];

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
    this.flashCopy = bytes;

    this.initMCU(bytes);
    console.log('[RP2040] CPU initialized with bootrom, UART, I2C, SPI, GPIO');
  }

  /** Same interface as AVRSimulator for store compatibility */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  loadHex(_hexContent: string): void {
    console.warn('[RP2040] loadHex() called on RP2040Simulator — use loadBinary() instead');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getADC(): any {
    return this.rp2040?.adc ?? null;
  }

  /** Get underlying RP2040 instance (for advanced usage / tests) */
  getMCU(): RP2040 | null {
    return this.rp2040;
  }

  // ── Private initialization ───────────────────────────────────────────────

  private initMCU(programBytes: Uint8Array): void {
    this.rp2040 = new RP2040();

    // Suppress noisy internal logs (only show errors)
    this.rp2040.logger = new ConsoleLogger(LogLevel.Error);

    // Load RP2040 B1 bootrom — needed for proper boot sequence
    this.rp2040.loadBootrom(bootromB1);

    // Load binary into flash starting at offset 0 (maps to 0x10000000)
    this.rp2040.flash.set(programBytes, 0);

    // Set PC to flash start (boot vector)
    this.rp2040.core.PC = 0x10000000;

    // ── Wire UART0 (default Serial port for Arduino-Pico) ────────────
    let serialBuffer = '';
    this.rp2040.uart[0].onByte = (value: number) => {
      const ch = String.fromCharCode(value);
      serialBuffer += ch;
      if (ch === '\n') {
        console.log('[RP2040 UART0]', serialBuffer.trimEnd());
        serialBuffer = '';
      }
      if (this.onSerialData) {
        this.onSerialData(ch);
      }
    };

    // ── Wire UART1 (Serial1) — also forward to onSerialData for now ──
    this.rp2040.uart[1].onByte = (value: number) => {
      if (this.onSerialData) {
        this.onSerialData(String.fromCharCode(value));
      }
    };

    // ── Wire I2C0 and I2C1 ───────────────────────────────────────────
    this.wireI2C(0);
    this.wireI2C(1);

    // ── Wire SPI0 and SPI1 — default loopback ────────────────────────
    this.rp2040.spi[0].onTransmit = (value: number) => {
      this.rp2040!.spi[0].completeTransmit(value); // loopback
    };
    this.rp2040.spi[1].onTransmit = (value: number) => {
      this.rp2040!.spi[1].completeTransmit(value); // loopback
    };

    // ── Set default ADC values ───────────────────────────────────────
    // Channel 0-3: GPIO26-29, channel 4: internal temp sensor
    // Default to mid-range (~1.65V on 3.3V ref, 12-bit)
    this.rp2040.adc.channelValues[0] = 2048;
    this.rp2040.adc.channelValues[1] = 2048;
    this.rp2040.adc.channelValues[2] = 2048;
    this.rp2040.adc.channelValues[3] = 2048;
    // Internal temp sensor: T = 27 - (V - 0.706) / 0.001721
    // For 27°C: V = 0.706V → ADC = 0.706/3.3 * 4095 ≈ 876
    this.rp2040.adc.channelValues[4] = 876;

    // ── Patch PIO to use synchronous stepping instead of setTimeout ──
    // rp2040js PIO uses setTimeout(() => this.run(), 0) which deadlocks
    // when the CPU busy-waits for PIO FIFO space (e.g. pio_sm_put_blocking).
    // We step PIO synchronously in the execute loop instead.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const pio of (this.rp2040 as any).pio) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pio.run = function (this: any) {
        if (this.runTimer) {
          clearTimeout(this.runTimer);
          this.runTimer = null;
        }
        // No-op: execute loop calls pio.step() synchronously
      };
    }
    this.pioStepAccum = 0;

    // ── Set up GPIO listeners ────────────────────────────────────────
    this.setupGpioListeners();
  }

  private wireI2C(bus: 0 | 1): void {
    if (!this.rp2040) return;
    const i2c: RPI2C = this.rp2040.i2c[bus];
    const devices = this.i2cDevices[bus];
    i2c.onStart = () => {
      i2c.completeStart();
    };

    i2c.onConnect = (address: number) => {
      const device = devices.get(address);
      if (device) {
        this.activeI2CDevice[bus] = device;
        i2c.completeConnect(true); // ACK
      } else {
        this.activeI2CDevice[bus] = null;
        i2c.completeConnect(false); // NACK
      }
    };

    i2c.onWriteByte = (value: number) => {
      const dev = this.activeI2CDevice[bus];
      if (dev) {
        const ack = dev.writeByte(value);
        i2c.completeWrite(ack);
      } else {
        i2c.completeWrite(false);
      }
    };

    i2c.onReadByte = () => {
      const dev = this.activeI2CDevice[bus];
      if (dev) {
        i2c.completeRead(dev.readByte());
      } else {
        i2c.completeRead(0xff);
      }
    };

    i2c.onStop = () => {
      const dev = this.activeI2CDevice[bus];
      if (dev?.stop) dev.stop();
      this.activeI2CDevice[bus] = null;
      i2c.completeStop();
    };
  }

  private setupGpioListeners(): void {
    this.gpioUnsubscribers.forEach(fn => fn());
    this.gpioUnsubscribers = [];

    if (!this.rp2040) return;

    for (let gpioIdx = 0; gpioIdx < 30; gpioIdx++) {
      const pin = gpioIdx;
      const gpio = this.rp2040.gpio[gpioIdx];
      if (!gpio) continue;

      const unsub = gpio.addListener((state: GPIOPinState) => {
        const isHigh = state === GPIOPinState.High || state === GPIOPinState.InputPullUp;
        this.pinManager.triggerPinChange(pin, isHigh);
        if (this.onPinChangeWithTime && this.rp2040) {
          // IClock interface exposes `nanos` (not `timeUs`)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const clk = (this.rp2040 as any).clock;
          const timeMs = clk ? (clk.nanos as number) / 1_000_000 : 0;
          this.onPinChangeWithTime(pin, isHigh, timeMs);
        }
      });
      this.gpioUnsubscribers.push(unsub);
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  start(): void {
    if (this.running || !this.rp2040) {
      console.warn('[RP2040] Already running or not initialized');
      return;
    }

    this.running = true;
    console.log('[RP2040] Starting simulation at 125 MHz...');

    const execute = () => {
      if (!this.running || !this.rp2040) return;

      const cyclesTarget = Math.floor(CYCLES_PER_FRAME * this.speed);
      const { core } = this.rp2040;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const clock = (this.rp2040 as any).clock;

      try {
        let cyclesDone = 0;
        const pioDiv = this.getPIOClockDiv();
        while (cyclesDone < cyclesTarget) {
          if (core.waiting) {
            if (clock) {
              const jump: number = clock.nanosToNextAlarm;
              if (jump <= 0) {
                // No clock alarms — step PIO so it can unblock the CPU
                // (e.g. PIO consuming FIFO data may generate an interrupt)
                this.stepPIO();
                break;
              }
              const jumped = Math.ceil(jump / CYCLE_NANOS);
              const pioSteps = Math.floor(jumped / pioDiv);
              // Advance clock incrementally per PIO step so GPIO transitions
              // get accurate timestamps (not all lumped at the end of the jump).
              const nanoPerPioStep = pioDiv * CYCLE_NANOS;
              const maxSteps = Math.min(pioSteps, 50000);
              let nanosStepped = 0;
              for (let i = 0; i < maxSteps; i++) {
                clock.tick(nanoPerPioStep);
                nanosStepped += nanoPerPioStep;
                this.totalCycles += pioDiv;
                this.stepPIO();
              }
              // Tick any remaining nanoseconds not covered by PIO steps
              const remaining = jump - nanosStepped;
              if (remaining > 0) {
                clock.tick(remaining);
                this.totalCycles += Math.ceil(remaining / CYCLE_NANOS);
              }
              cyclesDone += jumped;
              this.flushScheduledPinChanges();
            } else {
              break;
            }
          } else {
            const cycles: number = core.executeInstruction();
            if (clock) clock.tick(cycles * CYCLE_NANOS);
            cyclesDone += cycles;
            this.totalCycles += cycles;
            // Step PIO synchronously at the PIO clock rate
            this.pioStepAccum += cycles;
            while (this.pioStepAccum >= pioDiv) {
              this.pioStepAccum -= pioDiv;
              this.stepPIO();
            }
            this.flushScheduledPinChanges();
          }
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
    this.totalCycles = 0;
    this.scheduledPinChanges = [];
    if (this.rp2040 && this.flashCopy) {
      this.initMCU(this.flashCopy);
      // Re-register any previously added I2C devices
      // (devices are kept in i2cDevices maps which persist across reset)
      console.log('[RP2040] CPU reset');
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(0.1, Math.min(10.0, speed));
  }

  getSpeed(): number {
    return this.speed;
  }

  /** Returns the CPU clock frequency in Hz. */
  getClockHz(): number {
    return F_CPU;
  }

  /** Returns total CPU cycles executed since last reset/load. */
  getCurrentCycles(): number {
    return this.totalCycles;
  }

  /**
   * Schedule a GPIO pin state change at a specific future cycle count.
   * Enables cycle-accurate protocol simulation (e.g. HC-SR04 echo timing).
   */
  schedulePinChange(pin: number, state: boolean, atCycle: number): void {
    let i = this.scheduledPinChanges.length;
    while (i > 0 && this.scheduledPinChanges[i - 1].cycle > atCycle) i--;
    this.scheduledPinChanges.splice(i, 0, { cycle: atCycle, pin, state });
  }

  /** Get the PIO clock divider from the first enabled state machine. */
  private getPIOClockDiv(): number {
    if (!this.rp2040) return 64;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const pio of (this.rp2040 as any).pio) {
      if (pio.stopped) continue;
      for (const m of pio.machines) {
        if (m.enabled) {
          return Math.max(1, m.clockDivInt || 1);
        }
      }
    }
    return 64; // default
  }

  /** Step PIO state machines synchronously (prevents setTimeout deadlock). */
  private stepPIO(): void {
    if (!this.rp2040) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pio = (this.rp2040 as any).pio;
    if (pio[0] && !pio[0].stopped) pio[0].step();
    if (pio[1] && !pio[1].stopped) pio[1].step();
  }

  private flushScheduledPinChanges(): void {
    if (this.scheduledPinChanges.length === 0) return;
    while (this.scheduledPinChanges.length > 0 && this.scheduledPinChanges[0].cycle <= this.totalCycles) {
      const { pin, state } = this.scheduledPinChanges.shift()!;
      this.setPinState(pin, state);
    }
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

  /**
   * Send text to UART0 RX (as if typed in Serial Monitor).
   */
  serialWrite(text: string): void {
    if (!this.rp2040) return;
    for (let i = 0; i < text.length; i++) {
      this.rp2040.uart[0].feedByte(text.charCodeAt(i));
    }
  }

  /**
   * Register a virtual I2C device on the specified bus (0 or 1).
   * Default bus 0 = Wire, bus 1 = Wire1.
   */
  addI2CDevice(device: RP2040I2CDevice, bus: 0 | 1 = 0): void {
    this.i2cDevices[bus].set(device.address, device);
  }

  /**
   * Remove an I2C device by address.
   */
  removeI2CDevice(address: number, bus: 0 | 1 = 0): void {
    this.i2cDevices[bus].delete(address);
  }

  /**
   * Set ADC channel value (0-4095 for 12-bit).
   * Channels 0-3 = GPIO26-29, channel 4 = internal temperature sensor.
   */
  setADCValue(channel: number, value: number): void {
    if (!this.rp2040) return;
    if (channel >= 0 && channel < 5) {
      this.rp2040.adc.channelValues[channel] = Math.max(0, Math.min(4095, value));
    }
  }

  /**
   * Set SPI onTransmit handler for a bus (0 or 1).
   * callback receives TX byte and must call completeTransmit on the SPI instance.
   */
  setSPIHandler(bus: 0 | 1, handler: (value: number) => number): void {
    if (!this.rp2040) return;
    const spi = this.rp2040.spi[bus];
    spi.onTransmit = (value: number) => {
      const response = handler(value);
      spi.completeTransmit(response);
    };
  }

  // ── Generic sensor registration (board-agnostic API) ──────────────────────
  // RP2040 handles all sensor protocols locally via schedulePinChange,
  // so these return false / no-op — the sensor runs its own frontend logic.

  registerSensor(_type: string, _pin: number, _props: Record<string, unknown>): boolean { return false; }
  updateSensor(_pin: number, _props: Record<string, unknown>): void {}
  unregisterSensor(_pin: number): void {}
}
