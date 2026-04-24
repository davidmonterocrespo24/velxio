/**
 * ProtocolParts.ts — Simulation for I2C, SPI, and custom-protocol components.
 *
 * Migrated partially to the SDK-native `definePartSimulation()` shape
 * (CORE-002c-step4 5/5). Three protocol parts move to the SDK:
 *
 *   hx711        — 2-wire load-cell amplifier (SCK + DOUT bit-banging);
 *                  uses `handle.onPinChange` + `handle.setPinState`.
 *   ir-receiver  — click-driven NEC IR demodulated output pulse train;
 *                  uses `handle.setPinState` + `setTimeout`.
 *   ir-remote    — button-press → NEC pulse + `ir-signal` CustomEvent
 *                  relay; same shape as ir-receiver.
 *
 * Eight parts stay on the legacy 3-arg `attachEvents` shape inside
 * `registerLegacyProtocolParts(registry)`:
 *
 *   ssd1306, ds1307, mpu6050, bmp280, ds3231, pcf8574
 *                — I²C peripherals with an ESP32 branch that delegates
 *                  to the backend QEMU slave via `sim.registerSensor(...)`
 *                  + `sim.addI2CTransactionListener(...)`. `handle.registerI2cSlave`
 *                  covers AVR/RP2040 only — ESP32 I²C plugin support
 *                  requires the ESP32 bridge SDK (tracked as
 *                  CORE-003c under step4a follow-ups).
 *
 *   dht22       — AVR/RP2040 path is SDK-portable via
 *                  `handle.schedulePinChange` + `handle.cyclesNow`, but
 *                  the ESP32 branch routes the whole protocol to the
 *                  backend QEMU DHT22 emulator — same ESP32 blocker
 *                  as the I²C peripherals above.
 *
 *   microsd-card — SPI slave state machine that hooks the non-standard
 *                  `spi.onTransmit` / `spi.completeTransmit` surface
 *                  (a pre-existing latent mis-naming — AVR8js exposes
 *                  `onByte`/`completeTransfer`, not these names).
 *                  Migrating to `handle.registerSpiSlave` would change
 *                  behavior (fix the latent bug), which is out of scope
 *                  for a pure refactor. Tracked under step4 follow-ups.
 */

import type { PartSimulation, PinState } from '@velxio/sdk';
import { definePartSimulation } from '@velxio/sdk';
import type { PartRegistry } from './PartSimulationRegistry';
import { VirtualDS1307, VirtualBMP280, VirtualDS3231, VirtualPCF8574 } from '../I2CBusManager';
import type { I2CDevice } from '../I2CBusManager';
import { registerSensorUpdate, unregisterSensorUpdate } from '../SensorUpdateRegistry';
import { useSimulatorStore } from '../../store/useSimulatorStore';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const isHigh = (state: PinState): boolean => state === 1;

type Disposable = { dispose(): void };

// ─── hx711 (SDK-migrated) ────────────────────────────────────────────────────

/**
 * HX711 — 24-bit ADC for load cells.
 *
 * Protocol:
 *  - DOUT LOW  = conversion ready
 *  - MCU reads 24 rising CLK edges → DOUT sends 24 bits MSB-first
 *  - 1 extra CLK pulse → gain 128 (channel A, default)
 *  - After 25th pulse falling edge: new conversion starts
 *
 * Default weight: 100 g. Change via `element.weight` (grams). Raw ADC =
 * weight × 1000 (signed 24-bit two's complement). Taring is handled by the
 * sketch; this model always returns `weight × 1000`.
 */
const hx711Part = definePartSimulation({
  attachEvents: (element, handle) => {
    const pinSCK = handle.getArduinoPin('SCK');
    const pinDOUT = handle.getArduinoPin('DOUT');
    if (pinSCK === null || pinDOUT === null) return () => {};

    const rawFromWeight = (el: HTMLElement): number => {
      const w = (el as HTMLElement & { weight?: number }).weight ?? 100;
      const raw = Math.round(w * 1000);
      return Math.max(-8_388_608, Math.min(8_388_607, raw)) & 0xff_ffff;
    };

    let rawValue = rawFromWeight(element);
    let bitCount = 0;
    let finishing = false;

    // DOUT LOW = conversion ready
    handle.setPinState(pinDOUT, false);

    const disp = handle.onPinChange('SCK', (state) => {
      const rising = isHigh(state);
      if (rising) {
        if (bitCount < 24) {
          const bit = (rawValue >> (23 - bitCount)) & 1;
          handle.setPinState(pinDOUT, bit === 1);
          bitCount++;
        } else {
          // 25th pulse → gain select. DOUT HIGH marks end of word.
          handle.setPinState(pinDOUT, true);
          finishing = true;
        }
      } else {
        // Falling edge after the 25th pulse → conversion complete
        if (finishing) {
          finishing = false;
          bitCount = 0;
          rawValue = rawFromWeight(element);
          // DOUT LOW = new conversion ready (simulate ~10 ms conversion time)
          setTimeout(() => handle.setPinState(pinDOUT, false), 10);
        }
      }
    });

    return () => {
      disp.dispose();
      handle.setPinState(pinDOUT, true); // DOUT HIGH = device idle / power down
    };
  },
});

// ─── IR NEC helpers (shared by ir-receiver and ir-remote) ────────────────────

/**
 * Returns interleaved `[duration_ms, level, …]` pairs for a standard NEC
 * frame (preamble + 32 data bits + final burst). `level` is `0` for the
 * active-low IR burst (mark) and `1` for the space.
 */
function necBitSequence(address: number, command: number): number[] {
  const frames: number[] = [];
  const push = (duration: number, level: number) => {
    frames.push(duration, level);
  };

  // Preamble: 9 ms mark + 4.5 ms space
  push(9, 0);
  push(4.5, 1);

  // 32 bits: addr, ~addr, cmd, ~cmd (LSB first)
  const bytes = [
    address & 0xff,
    ~address & 0xff,
    command & 0xff,
    ~command & 0xff,
  ];
  for (const byte of bytes) {
    for (let b = 0; b < 8; b++) {
      const bit = (byte >> b) & 1;
      push(0.562, 0); // 562 µs mark
      push(bit ? 1.687 : 0.562, 1); // space: 1687 µs = '1', 562 µs = '0'
    }
  }

  // Final 562 µs burst
  push(0.562, 0);

  return frames;
}

function driveNECSequence(
  handle: Parameters<NonNullable<PartSimulation['attachEvents']>>[1],
  pin: number,
  address: number,
  command: number,
): void {
  const frames = necBitSequence(address, command);
  let i = 0;

  const step = (): void => {
    if (i >= frames.length) {
      handle.setPinState(pin, true); // idle HIGH
      return;
    }
    const duration = frames[i++];
    const level = frames[i++];
    handle.setPinState(pin, level === 1);
    setTimeout(step, duration);
  };

  step();
}

// ─── ir-receiver (SDK-migrated) ──────────────────────────────────────────────

/**
 * IR receiver (e.g. VS1838B) — click on the element to generate a 38 kHz
 * NEC frame on the demodulated OUT/DATA pin (active-low: LOW = IR burst).
 *
 * Address and command are taken from `element.irAddress` / `element.irCommand`
 * at click-time so the user can tune them from dev-tools.
 */
const irReceiverPart = definePartSimulation({
  attachEvents: (element, handle) => {
    const pin = handle.getArduinoPin('OUT') ?? handle.getArduinoPin('DATA');
    if (pin === null) return () => {};

    handle.setPinState(pin, true); // idle HIGH

    const onClick = () => {
      const el = element as HTMLElement & {
        irAddress?: number;
        irCommand?: number;
      };
      const address = (el.irAddress ?? 0x00) & 0xff;
      const command = (el.irCommand ?? 0x45) & 0xff;
      driveNECSequence(handle, pin, address, command);
    };

    element.addEventListener('click', onClick);

    return () => {
      element.removeEventListener('click', onClick);
      handle.setPinState(pin, true);
    };
  },
});

// ─── ir-remote (SDK-migrated) ────────────────────────────────────────────────

const IR_REMOTE_COMMANDS: Record<string, number> = {
  '0': 0x16,
  '1': 0x0c,
  '2': 0x18,
  '3': 0x5e,
  '4': 0x08,
  '5': 0x1c,
  '6': 0x5a,
  '7': 0x42,
  '8': 0x52,
  '9': 0x4a,
  'vol+': 0x40,
  'vol-': 0x00,
  'ch+': 0x48,
  'ch-': 0x0d,
  power: 0x45,
  mute: 0x09,
  ok: 0x1b,
  up: 0x46,
  down: 0x15,
  left: 0x44,
  right: 0x43,
};

const irRemotePart = definePartSimulation({
  attachEvents: (element, handle) => {
    const pin = handle.getArduinoPin('IR') ?? handle.getArduinoPin('OUT');

    if (pin !== null) handle.setPinState(pin, true); // idle HIGH when wired

    const el = element as HTMLElement & { irAddress?: number };
    const address = (el.irAddress ?? 0x00) & 0xff;

    const onButtonPress = (e: Event) => {
      const key = (((e as CustomEvent).detail?.key ?? '') as string).toLowerCase();
      const command = (IR_REMOTE_COMMANDS[key] ?? 0x45) & 0xff;
      element.dispatchEvent(
        new CustomEvent('ir-signal', {
          bubbles: true,
          detail: { address, command, key },
        }),
      );
      if (pin !== null) driveNECSequence(handle, pin, address, command);
    };

    const onClick = () => {
      // Fallback for plain click — send POWER code
      const command = 0x45;
      element.dispatchEvent(
        new CustomEvent('ir-signal', {
          bubbles: true,
          detail: { address, command, key: 'power' },
        }),
      );
      if (pin !== null) driveNECSequence(handle, pin, address, command);
    };

    element.addEventListener('button-press', onButtonPress);
    element.addEventListener('click', onClick);

    return () => {
      element.removeEventListener('button-press', onButtonPress);
      element.removeEventListener('click', onClick);
      if (pin !== null) handle.setPinState(pin, true);
    };
  },
});

// ─── Legacy protocol parts (I²C + DHT22 + microSD) ───────────────────────────

/**
 * The parts below reach into host surfaces that aren't (yet) part of the
 * board-agnostic SDK:
 *   - ESP32 QEMU delegation via `sim.registerSensor(…)` + `sim.addI2CTransactionListener(…)`
 *   - MicroSD's `spi.onTransmit` / `spi.completeTransmit` naming (distinct
 *     from AVR8js's `onByte`/`completeTransfer`).
 *
 * They stay on the legacy 3-arg registry shape until the CORE-003c ESP32
 * bridge SDK lands (see step4a follow-ups).
 */
function registerLegacyProtocolParts(registry: PartRegistry): void {
  // ── SSD1306 OLED ──────────────────────────────────────────────────────────

  /**
   * SSD1306Core — shared GDDRAM buffer + command/data decoder.
   */
  class SSD1306Core {
    readonly buffer = new Uint8Array(128 * 8);

    private col = 0;
    private page = 0;
    private colStart = 0;
    private colEnd = 127;
    private pageStart = 0;
    private pageEnd = 7;
    private memMode = 0;

    private cmdBuf: number[] = [];
    private cmdWant = 0;

    static cmdParams(cmd: number): number {
      if (
        cmd === 0x20 ||
        cmd === 0x81 ||
        cmd === 0x8d ||
        cmd === 0xa8 ||
        cmd === 0xd3 ||
        cmd === 0xd5 ||
        cmd === 0xd8 ||
        cmd === 0xd9 ||
        cmd === 0xda ||
        cmd === 0xdb
      )
        return 1;
      if (cmd === 0x21 || cmd === 0x22) return 2;
      return 0;
    }

    writeData(value: number): void {
      this.buffer[this.page * 128 + this.col] = value;
      this.advanceCursor();
    }

    writeCommand(value: number): void {
      if (this.cmdWant > 0) {
        this.cmdBuf.push(value);
        this.cmdWant--;
        if (this.cmdWant === 0) this.applyCmd();
        return;
      }
      this.cmdBuf = [value];
      this.cmdWant = SSD1306Core.cmdParams(value);
      if (this.cmdWant === 0) this.applyCmd();
    }

    private applyCmd(): void {
      const [cmd, p1, p2] = this.cmdBuf;
      switch (cmd) {
        case 0x20:
          this.memMode = p1 & 0x03;
          break;
        case 0x21:
          this.colStart = p1 & 0x7f;
          this.colEnd = p2 & 0x7f;
          this.col = this.colStart;
          break;
        case 0x22:
          this.pageStart = p1 & 0x07;
          this.pageEnd = p2 & 0x07;
          this.page = this.pageStart;
          break;
        default:
          // 0x40–0x7F: display start line, skipped
          break;
      }
    }

    private advanceCursor(): void {
      if (this.memMode === 0) {
        this.col++;
        if (this.col > this.colEnd) {
          this.col = this.colStart;
          this.page++;
          if (this.page > this.pageEnd) this.page = this.pageStart;
        }
      } else if (this.memMode === 1) {
        this.page++;
        if (this.page > this.pageEnd) {
          this.page = this.pageStart;
          this.col++;
          if (this.col > this.colEnd) this.col = this.colStart;
        }
      } else {
        this.col++;
        if (this.col > this.colEnd) this.col = this.colStart;
      }
    }

    syncElement(element: HTMLElement): void {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const el = element as any;
      if (!el) return;

      let imgData: ImageData | undefined = el.imageData;
      if (!imgData || imgData.width !== 128 || imgData.height !== 64) {
        try {
          imgData = new ImageData(128, 64);
        } catch {
          return;
        }
      }

      const px = imgData.data;

      for (let page = 0; page < 8; page++) {
        for (let col = 0; col < 128; col++) {
          const byte = this.buffer[page * 128 + col];
          for (let bit = 0; bit < 8; bit++) {
            const row = page * 8 + bit;
            const lit = (byte >> bit) & 1;
            const idx = (row * 128 + col) * 4;
            px[idx] = lit ? 200 : 0;
            px[idx + 1] = lit ? 230 : 0;
            px[idx + 2] = lit ? 255 : 0;
            px[idx + 3] = 255;
          }
        }
      }

      el.imageData = imgData;
      if (typeof el.redraw === 'function') el.redraw();
    }
  }

  class VirtualSSD1306 implements I2CDevice {
    address: number;
    private readonly core = new SSD1306Core();
    private ctrlByte = true;
    private isData = false;
    private element: HTMLElement;

    constructor(address: number, element: HTMLElement) {
      this.address = address;
      this.element = element;
    }

    get buffer(): Uint8Array {
      return this.core.buffer;
    }

    writeByte(value: number): boolean {
      if (this.ctrlByte) {
        this.isData = (value & 0x40) !== 0;
        this.ctrlByte = false;
        return true;
      }
      if (this.isData) {
        this.core.writeData(value);
      } else {
        this.core.writeCommand(value);
      }
      return true;
    }

    readByte(): number {
      return 0xff;
    }

    stop(): void {
      this.ctrlByte = true;
      this.core.syncElement(this.element);
    }
  }

  /**
   * Remove a virtual I²C device from both AVR (i2cBus) and RP2040 simulators.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function removeI2CDevice(simulator: any, address: number): void {
    simulator.i2cBus?.removeDevice(address);
    simulator.removeI2CDevice?.(address, 0);
    simulator.removeI2CDevice?.(address, 1);
  }

  function attachSSD1306SPI(
    element: HTMLElement,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    simulator: any,
    getPin: (name: string) => number | null,
  ): () => void {
    const pinManager = simulator.pinManager;
    const spi = simulator.spi;
    if (!pinManager || !spi) return () => {};

    const core = new SSD1306Core();
    let dcState = false;
    const unsubs: (() => void)[] = [];

    const pinDC = getPin('DC');
    if (pinDC !== null) {
      unsubs.push(
        pinManager.onPinChange(pinDC, (_: number, s: boolean) => {
          dcState = s;
        }),
      );
    }

    let dirty = false;
    let rafId: number | null = null;
    const scheduleSync = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (dirty) {
          core.syncElement(element);
          dirty = false;
        }
      });
    };

    const prevOnByte = spi.onByte;
    spi.onByte = (value: number) => {
      if (!dcState) {
        core.writeCommand(value);
      } else {
        core.writeData(value);
        dirty = true;
        scheduleSync();
      }
      spi.completeTransfer(0xff);
    };

    return () => {
      spi.onByte = prevOnByte;
      if (rafId !== null) cancelAnimationFrame(rafId);
      unsubs.forEach((u) => u());
    };
  }

  registry.register('ssd1306', {
    attachEvents: (element, simulator, getPin, componentId) => {
      const { components } = useSimulatorStore.getState();
      const comp = components.find((c) => c.id === componentId);
      const protocol = (comp?.properties?.protocol as string) ?? 'i2c';

      if (protocol === 'spi') {
        return attachSSD1306SPI(element, simulator, getPin);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sim = simulator as any;
      const i2cAddr = 0x3c;

      if (typeof sim.addI2CDevice === 'function') {
        const device = new VirtualSSD1306(i2cAddr, element);
        sim.addI2CDevice(device);
        return () => removeI2CDevice(sim, device.address);
      } else if (typeof sim.registerSensor === 'function') {
        const virtualPin = 200 + i2cAddr;
        const device = new VirtualSSD1306(i2cAddr, element);
        sim.registerSensor('ssd1306', virtualPin, { addr: i2cAddr });
        sim.addI2CTransactionListener(i2cAddr, (data: number[]) => {
          data.forEach((b: number) => device.writeByte(b));
          device.stop();
        });
        return () => {
          sim.unregisterSensor(virtualPin);
          sim.removeI2CTransactionListener(i2cAddr);
        };
      }

      return () => {};
    },
  });

  // ── DS1307 RTC ────────────────────────────────────────────────────────────

  registry.register('ds1307', {
    attachEvents: (_element, simulator, _getPin) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sim = simulator as any;

      if (typeof sim.addI2CDevice === 'function') {
        const rtc = new VirtualDS1307();
        sim.addI2CDevice(rtc);
        return () => removeI2CDevice(sim, rtc.address);
      } else if (typeof sim.registerSensor === 'function') {
        const virtualPin = 200 + 0x68;
        sim.registerSensor('ds1307', virtualPin, { addr: 0x68 });
        return () => sim.unregisterSensor(virtualPin);
      }

      return () => {};
    },
  });

  // ── MPU-6050 IMU ──────────────────────────────────────────────────────────

  class VirtualMPU6050 implements I2CDevice {
    address: number;
    registers = new Uint8Array(256);
    private regPtr = 0;
    private firstByte = true;

    constructor(address: number) {
      this.address = address;

      this.registers[0x75] = 0x68; // WHO_AM_I
      this.registers[0x6b] = 0x00; // PWR_MGMT_1 awake

      // ACCEL: Z = +1g = +16384 (0x4000)
      this.registers[0x3b] = 0x00;
      this.registers[0x3c] = 0x00;
      this.registers[0x3d] = 0x00;
      this.registers[0x3e] = 0x00;
      this.registers[0x3f] = 0x40;
      this.registers[0x40] = 0x00;

      const tempRaw = Math.round((25 - 36.53) * 340) & 0xffff;
      this.registers[0x41] = (tempRaw >> 8) & 0xff;
      this.registers[0x42] = tempRaw & 0xff;
    }

    writeByte(value: number): boolean {
      if (this.firstByte) {
        this.regPtr = value;
        this.firstByte = false;
      } else {
        this.registers[this.regPtr] = value;
        this.regPtr = (this.regPtr + 1) & 0xff;
      }
      return true;
    }

    readByte(): number {
      const val = this.registers[this.regPtr];
      this.regPtr = (this.regPtr + 1) & 0xff;
      return val;
    }

    stop(): void {
      this.firstByte = true;
    }
  }

  registry.register('mpu6050', {
    attachEvents: (element, simulator, _getPin, componentId) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sim = simulator as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const el = element as any;
      const addr = el.ad0 === true || el.ad0 === 'true' ? 0x69 : 0x68;

      if (typeof sim.addI2CDevice === 'function') {
        const device = new VirtualMPU6050(addr);
        sim.addI2CDevice(device);

        const writeI16 = (regH: number, raw: number) => {
          const v = Math.max(-32768, Math.min(32767, Math.round(raw))) & 0xffff;
          device.registers[regH] = (v >> 8) & 0xff;
          device.registers[regH + 1] = v & 0xff;
        };

        registerSensorUpdate(componentId, (values) => {
          if ('accelX' in values) writeI16(0x3b, (values.accelX as number) * 16384);
          if ('accelY' in values) writeI16(0x3d, (values.accelY as number) * 16384);
          if ('accelZ' in values) writeI16(0x3f, (values.accelZ as number) * 16384);
          if ('gyroX' in values) writeI16(0x43, (values.gyroX as number) * 131);
          if ('gyroY' in values) writeI16(0x45, (values.gyroY as number) * 131);
          if ('gyroZ' in values) writeI16(0x47, (values.gyroZ as number) * 131);
          if ('temp' in values) writeI16(0x41, ((values.temp as number) - 36.53) * 340);
        });

        return () => {
          removeI2CDevice(sim, device.address);
          unregisterSensorUpdate(componentId);
        };
      } else if (typeof sim.registerSensor === 'function') {
        const virtualPin = 200 + addr;
        sim.registerSensor('mpu6050', virtualPin, { addr });

        registerSensorUpdate(componentId, (values) => {
          sim.updateSensor(virtualPin, values);
        });

        return () => {
          sim.unregisterSensor(virtualPin);
          unregisterSensorUpdate(componentId);
        };
      }

      return () => {};
    },
  });

  // ── DHT22 ─────────────────────────────────────────────────────────────────

  function buildDHT22Payload(element: HTMLElement): Uint8Array {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const el = element as any;
    const humidity = Math.round((el.humidity ?? 50.0) * 10);
    const temperature = Math.round((el.temperature ?? 25.0) * 10);
    const h_H = (humidity >> 8) & 0xff;
    const h_L = humidity & 0xff;
    const rawTemp =
      temperature < 0 ? (-temperature & 0x7fff) | 0x8000 : temperature & 0x7fff;
    const t_H = (rawTemp >> 8) & 0xff;
    const t_L = rawTemp & 0xff;
    const chk = (h_H + h_L + t_H + t_L) & 0xff;
    return new Uint8Array([h_H, h_L, t_H, t_L, chk]);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function scheduleDHT22Response(simulator: any, pin: number, element: HTMLElement): void {
    if (typeof simulator.schedulePinChange !== 'function') {
      const payload = buildDHT22Payload(element);
      simulator.setPinState(pin, false);
      simulator.setPinState(pin, true);
      for (const byte of payload) {
        for (let b = 7; b >= 0; b--) {
          const bit = (byte >> b) & 1;
          simulator.setPinState(pin, false);
          simulator.setPinState(pin, !!bit);
        }
      }
      simulator.setPinState(pin, true);
      return;
    }

    const payload = buildDHT22Payload(element);
    const now = simulator.getCurrentCycles() as number;
    const clockHz: number =
      typeof simulator.getClockHz === 'function' ? simulator.getClockHz() : 16_000_000;
    const us = (microseconds: number) => Math.round((microseconds * clockHz) / 1_000_000);

    const RESPONSE_START = us(20);
    const LOW80 = us(80);
    const HIGH80 = us(80);
    const LOW50 = us(50);
    const HIGH0 = us(26);
    const HIGH1 = us(70);

    let t = now + RESPONSE_START;

    simulator.schedulePinChange(pin, false, t);
    t += LOW80;
    simulator.schedulePinChange(pin, true, t);
    t += HIGH80;

    for (const byte of payload) {
      for (let b = 7; b >= 0; b--) {
        const bit = (byte >> b) & 1;
        simulator.schedulePinChange(pin, false, t);
        t += LOW50;
        simulator.schedulePinChange(pin, true, t);
        t += bit ? HIGH1 : HIGH0;
      }
    }

    simulator.schedulePinChange(pin, false, t);
    t += LOW50;
    simulator.schedulePinChange(pin, true, t);
  }

  registry.register('dht22', {
    attachEvents: (element, simulator, getPin, componentId) => {
      const pin = getPin('SDA') ?? getPin('DATA');
      if (pin === null) return () => {};

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const el = element as any;
      const temperature = el.temperature ?? 25.0;
      const humidity = el.humidity ?? 50.0;

      const handledNatively =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        typeof (simulator as any).registerSensor === 'function' &&
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (simulator as any).registerSensor('dht22', pin, { temperature, humidity });

      if (handledNatively) {
        registerSensorUpdate(componentId, (values) => {
          if ('temperature' in values) el.temperature = values.temperature as number;
          if ('humidity' in values) el.humidity = values.humidity as number;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (simulator as any).updateSensor(pin, {
            temperature: el.temperature ?? 25.0,
            humidity: el.humidity ?? 50.0,
          });
        });

        return () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (simulator as any).unregisterSensor(pin);
          unregisterSensorUpdate(componentId);
        };
      }

      let wasLow = false;
      const clockHz: number =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        typeof (simulator as any).getClockHz === 'function'
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (simulator as any).getClockHz()
          : 16_000_000;
      const RESPONSE_GATE_CYCLES = Math.round((12_500 * clockHz) / 1_000_000);
      let responseEndCycle = 0;
      let responseEndTimeMs = 0;

      const getCycles = (): number =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        typeof (simulator as any).getCurrentCycles === 'function'
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ((simulator as any).getCurrentCycles() as number)
          : -1;

      const unsub = (simulator as { pinManager: { onPinChange: (pin: number, cb: (p: number, s: boolean) => void) => () => void } }).pinManager.onPinChange(
        pin,
        (_: number, state: boolean) => {
          const now = getCycles();
          if (now >= 0 && now < responseEndCycle) return;
          if (now < 0 && Date.now() < responseEndTimeMs) return;

          if (!state) {
            wasLow = true;
            return;
          }
          if (wasLow) {
            wasLow = false;
            const cur = getCycles();
            responseEndCycle = cur >= 0 ? cur + RESPONSE_GATE_CYCLES : 0;
            responseEndTimeMs = Date.now() + 20;
            scheduleDHT22Response(simulator, pin, element);
          }
        },
      );

      simulator.setPinState(pin, true);

      registerSensorUpdate(componentId, (values) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const e = element as any;
        if ('temperature' in values) e.temperature = values.temperature as number;
        if ('humidity' in values) e.humidity = values.humidity as number;
      });

      return () => {
        unsub();
        simulator.setPinState(pin, true);
        unregisterSensorUpdate(componentId);
      };
    },
  });

  // ── MicroSD Card ──────────────────────────────────────────────────────────

  registry.register('microsd-card', {
    attachEvents: (_element, simulator, _getPin) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spi = (simulator as any).spi;
      if (!spi) return () => {};

      const respQueue: number[] = [];
      let cmdBuf: number[] = [];
      let expectingAcmd = false;

      function enqueueR1(r1: number): void {
        respQueue.push(r1);
      }
      function enqueueR7(r1: number, v32: number): void {
        respQueue.push(
          r1,
          (v32 >> 24) & 0xff,
          (v32 >> 16) & 0xff,
          (v32 >> 8) & 0xff,
          v32 & 0xff,
        );
      }

      function processCmd(raw: number[]): void {
        if (raw.length < 6) return;
        const cmdIndex = raw[0] & 0x3f;
        const isAcmd = expectingAcmd;
        expectingAcmd = false;

        if (isAcmd && cmdIndex === 41) {
          enqueueR1(0x00);
          return;
        }

        switch (cmdIndex) {
          case 0:
            enqueueR1(0x01);
            break;
          case 8:
            enqueueR7(0x01, 0x000001aa);
            break;
          case 55:
            enqueueR1(0x01);
            expectingAcmd = true;
            break;
          case 58:
            enqueueR7(0x00, 0x40000000);
            break;
          case 17:
            respQueue.push(0x00);
            respQueue.push(0xfe);
            for (let i = 0; i < 512; i++) respQueue.push(0xff);
            respQueue.push(0xff, 0xff);
            break;
          case 24:
            respQueue.push(0x00, 0x05);
            break;
          default:
            enqueueR1(0x00);
        }
      }

      const prevOnTransmit = spi.onTransmit as ((b: number) => void) | null | undefined;

      spi.onTransmit = (byte: number) => {
        if (byte & 0x40 && cmdBuf.length === 0) {
          cmdBuf = [byte];
        } else if (cmdBuf.length > 0 && cmdBuf.length < 6) {
          cmdBuf.push(byte);
          if (cmdBuf.length === 6) {
            processCmd(cmdBuf);
            cmdBuf = [];
          }
        }

        const reply = respQueue.length > 0 ? respQueue.shift()! : 0xff;
        spi.completeTransmit(reply);
      };

      return () => {
        spi.onTransmit = prevOnTransmit ?? null;
        respQueue.length = 0;
        cmdBuf = [];
      };
    },
  });

  // ── BMP280 ────────────────────────────────────────────────────────────────

  registry.register('bmp280', {
    attachEvents: (element, simulator, _getPin, componentId) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sim = simulator as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const el = element as any;
      const addr = el.address === '0x77' || el.address === 0x77 ? 0x77 : 0x76;

      if (typeof sim.addI2CDevice === 'function') {
        const dev = new VirtualBMP280(addr);
        if (el.temperature !== undefined) dev.temperatureC = parseFloat(el.temperature);
        if (el.pressure !== undefined) dev.pressureHPa = parseFloat(el.pressure);

        sim.addI2CDevice(dev);

        registerSensorUpdate(componentId, (values) => {
          if ('temperature' in values) dev.temperatureC = values.temperature as number;
          if ('pressure' in values) dev.pressureHPa = values.pressure as number;
        });

        return () => {
          removeI2CDevice(sim, dev.address);
          unregisterSensorUpdate(componentId);
        };
      } else if (typeof sim.registerSensor === 'function') {
        const virtualPin = 200 + addr;
        const initTemp = el.temperature !== undefined ? parseFloat(el.temperature) : 25.0;
        const initPressure = el.pressure !== undefined ? parseFloat(el.pressure) : 1013.25;
        sim.registerSensor('bmp280', virtualPin, {
          addr,
          temperature: initTemp,
          pressure: initPressure,
        });

        registerSensorUpdate(componentId, (values) => {
          sim.updateSensor(virtualPin, values);
        });

        return () => {
          sim.unregisterSensor(virtualPin);
          unregisterSensorUpdate(componentId);
        };
      }

      return () => {};
    },
  });

  // ── DS3231 ────────────────────────────────────────────────────────────────

  registry.register('ds3231', {
    attachEvents: (element, simulator, _getPin, componentId) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sim = simulator as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const el = element as any;

      if (typeof sim.addI2CDevice === 'function') {
        const dev = new VirtualDS3231();
        if (el.temperature !== undefined) dev.temperatureC = parseFloat(el.temperature);
        sim.addI2CDevice(dev);
        return () => removeI2CDevice(sim, dev.address);
      } else if (typeof sim.registerSensor === 'function') {
        const virtualPin = 200 + 0x68;
        const initTemp = el.temperature !== undefined ? parseFloat(el.temperature) : 25.0;
        sim.registerSensor('ds3231', virtualPin, { addr: 0x68, temperature: initTemp });
        registerSensorUpdate(componentId, (values) => {
          sim.updateSensor(virtualPin, values);
        });
        return () => {
          sim.unregisterSensor(virtualPin);
          unregisterSensorUpdate(componentId);
        };
      }

      return () => {};
    },
  });

  // ── PCF8574 ───────────────────────────────────────────────────────────────

  registry.register('pcf8574', {
    attachEvents: (element, simulator, _getPin) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sim = simulator as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const el = element as any;

      let addr = 0x27;
      if (el.i2cAddress !== undefined) {
        const raw = String(el.i2cAddress).trim();
        const parsed =
          raw.startsWith('0x') || raw.startsWith('0X')
            ? parseInt(raw, 16)
            : parseInt(raw, 10);
        if (!isNaN(parsed)) addr = parsed;
      }

      if (typeof sim.addI2CDevice === 'function') {
        const dev = new VirtualPCF8574(addr);
        if (el.portState !== undefined) dev.portState = Number(el.portState) & 0xff;
        dev.onWrite = (value: number) => {
          el.value = value;
        };
        sim.addI2CDevice(dev);
        return () => removeI2CDevice(sim, dev.address);
      } else if (typeof sim.registerSensor === 'function') {
        const virtualPin = 200 + addr;
        const dev = new VirtualPCF8574(addr);
        if (el.portState !== undefined) dev.portState = Number(el.portState) & 0xff;
        dev.onWrite = (value: number) => {
          el.value = value;
        };
        sim.registerSensor('pcf8574', virtualPin, { addr });
        sim.addI2CTransactionListener(addr, (data: number[]) => {
          if (data.length > 0) dev.writeByte(data[0]);
        });
        return () => {
          sim.unregisterSensor(virtualPin);
          sim.removeI2CTransactionListener(addr);
        };
      }

      return () => {};
    },
  });
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerProtocolParts(registry: PartRegistry): void {
  // SDK-migrated parts (no ESP32 branch, no register-level access).
  registry.registerSdkPart('hx711', hx711Part);
  registry.registerSdkPart('ir-receiver', irReceiverPart);
  registry.registerSdkPart('ir-remote', irRemotePart);

  // Legacy parts (ESP32 QEMU + microSD non-standard SPI surface).
  registerLegacyProtocolParts(registry);
}

// Helper referenced from SensorParts for the disposable bag pattern.
// Export is deliberately absent — `Disposable` is a local alias only.
export type { Disposable as ProtocolPartDisposable };
