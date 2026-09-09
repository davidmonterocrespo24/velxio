/**
 * ProtocolParts.ts — Simulation for I2C, SPI, and custom-protocol components.
 *
 * Implements eight components that require specific communication stacks:
 *
 *  ssd1306      — I2C OLED display (0x3C). Full command/data decoder.
 *  ds1307       — I2C Real-Time Clock (0x68). Returns browser system time.
 *  mpu6050      — I2C 6-axis IMU (0x68/0x69). Full register map simulation.
 *  dht22        — Single-wire temp/humidity. Drives DATA pin after start signal.
 *  hx711        — 2-wire load cell amplifier. Clocks out 24-bit ADC value.
 *  ir-receiver  — IR demodulator. Owns its pin through the line contract and
 *                 puts what crosses simulation/ir/irAir on it, at real timing.
 *  ir-remote    — IR handset. No pins: it transmits into the air.
 *  microsd-card — SPI SD card. Responds to CMD0/CMD8/ACMD41/CMD58 init.
 *
 * NOTE — the timing-sensitive parts (dht22, ir-receiver) do NOT live here any
 *   more. They are line-owning models under simulation/line/models, which place
 *   edges on the guest's own cycle counter, so a µs-accurate protocol is exact
 *   and an interrupt-driven library (IRremote, Adafruit DHT) decodes it. What
 *   is left in this file drives pins from host time and is fine with that.
 */

import { PartSimulationRegistry } from './PartSimulationRegistry';
import { requestLine, releaseLineGap } from '../line/requestLine';
import { VirtualDS1307, VirtualBMP280, VirtualDS3231, VirtualPCF8574 } from '../I2CBusManager';
import type { I2CDevice } from '../I2CBusManager';
import { HD44780Decoder } from '../HD44780Decoder';
import { registerSensorUpdate, unregisterSensorUpdate } from '../SensorUpdateRegistry';
import {
  emitIr,
  listenIr,
  necEncode,
  necEncodeRepeat,
  NEC_REPEAT_PERIOD_MS,
  type IrAirFrame,
  type IrPulse,
} from '../ir';
import { useSimulatorStore } from '../../store/useSimulatorStore';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Remove a virtual I2C device from both AVR (i2cBus) and RP2040 simulators.
 */
function removeI2CDevice(simulator: any, address: number): void {
  simulator.i2cBus?.removeDevice(address);
  simulator.removeI2CDevice?.(address, 0);
  simulator.removeI2CDevice?.(address, 1);
}

// ─── SSD1306 OLED ────────────────────────────────────────────────────────────

/**
 * SSD1306Core — shared GDDRAM buffer, command decoder, and rendering logic.
 *
 * The SSD1306 command set is identical for I2C and SPI; only the transport
 * differs.  This core is used by both VirtualSSD1306 (I2C) and
 * attachSSD1306SPI (SPI).
 *
 * Supported commands:
 *  - 0x20 Set Memory Addressing Mode (horizontal / vertical / page)
 *  - 0x21 Set Column Address
 *  - 0x22 Set Page Address
 *  - 0x40–0x7F Set Display Start Line
 *  - 0xAF Display ON / 0xAE Display OFF
 *  - All other parameterized commands are parsed but ignored.
 */
class SSD1306Core {
  /** 1024-byte GDDRAM: 8 pages × 128 columns. Each byte = 8 vertical pixels. */
  readonly buffer = new Uint8Array(128 * 8);

  // GDDRAM cursor
  private col = 0;
  private page = 0;
  private colStart = 0;
  private colEnd = 127;
  private pageStart = 0;
  private pageEnd = 7;
  // 0=horizontal, 1=vertical, 2=page. SSD1306 power-on default is PAGE
  // addressing (datasheet 10b). Adafruit_SSD1306 overrides it to horizontal
  // via 0x20,0x00; page-mode drivers (Tiny4kOLED, U8g2 page buffer) rely on
  // this default and never send 0x20 — so the default MUST be 2 or their
  // setCursor (0xB0-0xB7 + 0x00-0x1F) renders garbled.
  private memMode = 2;

  // Multi-byte command accumulation
  private cmdBuf: number[] = [];
  private cmdWant = 0;

  /** How many parameter bytes does this command require? */
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

  /** Write a data byte to GDDRAM and advance cursor. */
  writeData(value: number): void {
    this.buffer[this.page * 128 + this.col] = value;
    this.advanceCursor();
  }

  /** Feed a command or parameter byte. Multi-byte commands are accumulated. */
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
        // Page-addressing-mode cursor commands (single-byte). Used by
        // Tiny4kOLED / U8g2 page buffer / classic SSD1306 drivers whose
        // setCursor() does NOT use the 0x21/0x22 column/page-range commands.
        if (cmd >= 0xb0 && cmd <= 0xb7) {
          // set page start address (B0..B7 → page 0..7)
          this.page = cmd & 0x07;
        } else if (cmd <= 0x0f) {
          // set lower column nibble (0x00..0x0F)
          this.col = (this.col & 0xf0) | (cmd & 0x0f);
        } else if (cmd >= 0x10 && cmd <= 0x1f) {
          // set higher column nibble (0x10..0x1F)
          this.col = (this.col & 0x0f) | ((cmd & 0x0f) << 4);
        } else if (cmd >= 0x40 && cmd <= 0x7f) {
          /* display start line — visual, skip */
        }
        break;
    }
  }

  private advanceCursor(): void {
    if (this.memMode === 0) {
      // horizontal addressing
      this.col++;
      if (this.col > this.colEnd) {
        this.col = this.colStart;
        this.page++;
        if (this.page > this.pageEnd) this.page = this.pageStart;
      }
    } else if (this.memMode === 1) {
      // vertical addressing
      this.page++;
      if (this.page > this.pageEnd) {
        this.page = this.pageStart;
        this.col++;
        if (this.col > this.colEnd) this.col = this.colStart;
      }
    } else {
      // page addressing
      this.col++;
      if (this.col > this.colEnd) this.col = this.colStart;
    }
  }

  /**
   * Push the 1-bit GDDRAM buffer to the wokwi-ssd1306 web component.
   *
   * wokwi-ssd1306 API:
   *   - `element.imageData` — a 128×64 ImageData (RGBA, 4 bytes/pixel)
   *   - `element.redraw()` — flushes imageData to the internal canvas
   */
  syncElement(element: HTMLElement): void {
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
          px[idx] = lit ? 200 : 0; // R
          px[idx + 1] = lit ? 230 : 0; // G
          px[idx + 2] = lit ? 255 : 0; // B
          px[idx + 3] = 255; // A
        }
      }
    }

    el.imageData = imgData;
    if (typeof el.redraw === 'function') el.redraw();
  }
}

/**
 * VirtualSSD1306 — I2C wrapper around SSD1306Core.
 *
 * Handles the I2C control byte (0x00 = command stream, 0x40 = data stream)
 * and delegates command/data writes to the shared core.
 */
class VirtualSSD1306 implements I2CDevice {
  address: number;
  private readonly core = new SSD1306Core();

  private ctrlByte = true;
  private isData = false;

  constructor(
    address: number,
    private element: HTMLElement,
  ) {
    this.address = address;
  }

  /** Expose core buffer for tests. */
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
 * Attach SSD1306 in SPI mode — intercepts the AVR SPI bus.
 *
 * Follows the same pattern as ILI9341 (ComplexParts.ts): hook spi.onByte,
 * track DC pin state via PinManager, and render GDDRAM to the element.
 */
function attachSSD1306SPI(
  element: HTMLElement,
  simulator: any,
  getPin: (name: string) => number | null,
): () => void {
  const pinManager = simulator.pinManager;
  const spi = simulator.spi;
  if (!pinManager || !spi) return () => {};

  const core = new SSD1306Core();
  let dcState = false;
  const unsubs: (() => void)[] = [];

  // Track DC pin (LOW = command, HIGH = data)
  const pinDC = getPin('DC');
  if (pinDC !== null) {
    unsubs.push(
      pinManager.onPinChange(pinDC, (_: number, s: boolean) => {
        dcState = s;
      }),
    );
  }

  // Throttle rendering to ~60 fps
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

  // Hook AVR SPI bus (onByte + completeTransfer)
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

/**
 * Internal: SSD1306 attach logic, parameterised over the wire protocol.
 * Called by the single `ssd1306` entry once the protocol has been resolved
 * (auto-detected from the wiring, or read from an explicit `protocol` property).
 */
function attachSSD1306(
  element: HTMLElement,
  simulator: unknown,
  getPin: (n: string) => number | null,
  protocol: 'i2c' | 'spi',
  i2cAddr = 0x3c,
): () => void {
  if (protocol === 'spi') {
    return attachSSD1306SPI(element, simulator, getPin);
  }
  const sim = simulator as any;
  const device = new VirtualSSD1306(i2cAddr, element);

  // The ESP32/STM32 bridge shims expose registerSensor (backend QEMU slave) +
  // addI2CTransactionListener (framebuffer bytes streamed back) AND addI2CDevice
  // (frontend bus for the cross-board Interconnect). AVR / RP2040 also carry a
  // registerSensor() stub that returns false, so they enter this branch too —
  // harmlessly: registerSensor no-ops, the absent addI2CTransactionListener is
  // skipped, and the real attach happens via the addI2CDevice mirror below.
  if (typeof sim.registerSensor === 'function') {
    // ── ESP32 / STM32 (and AVR/RP2040 via the addI2CDevice mirror) ──────────
    const virtualPin = 200 + i2cAddr;
    sim.registerSensor('ssd1306', virtualPin, { addr: i2cAddr });
    sim.addI2CTransactionListener?.(i2cAddr, (data: number[]) => {
      data.forEach((b: number) => device.writeByte(b));
      device.stop();
    });
    // Mirror on the frontend bus so peer boards reading across an
    // I2C bridge can also reach the device.
    sim.addI2CDevice?.(device);
    return () => {
      sim.unregisterSensor(virtualPin);
      sim.removeI2CTransactionListener?.(i2cAddr);
      sim.removeI2CDevice?.(i2cAddr, 0);
    };
  } else if (typeof sim.addI2CDevice === 'function') {
    // ── AVR / RP2040 path ──────────────────────────────────────────────────
    sim.addI2CDevice(device);
    return () => removeI2CDevice(sim, device.address);
  }
  return () => {};
}

/**
 * Which wire protocol did the user build?  A real SSD1306 breakout is ONE board
 * that talks either I2C or SPI depending on how it is wired.  The definitive
 * SPI-only signal is chip-select (CS): I2C never uses it.  (DC deliberately does
 * NOT count — on the 8-pin module DC doubles as the I2C address-select/SA0 line,
 * so many I2C circuits wire it too.)  So CS wired to a GPIO => SPI, otherwise
 * I2C.  This mirrors the physical part — one component, no protocol switch to
 * set, just wire it up.
 *
 * Pure wiring check: it deliberately does NOT read `simulator.spi`, whose getter
 * on some boards (RP2040, and the ESP32/STM32 bridge shims) lazily re-routes the
 * board SPI bus as a side effect and must not fire in I2C mode.
 */
function detectSSD1306Protocol(getPin: (n: string) => number | null): 'i2c' | 'spi' {
  return getPin('CS') !== null ? 'spi' : 'i2c';
}

/**
 * SSD1306 OLED — a single component that works on every board with an I2C or
 * SPI bus (AVR, RP2040, ESP32, STM32).  New projects just wire it up and the
 * protocol is auto-detected from the wiring like the physical module; a
 * `protocol` property, when present, pins it explicitly (projects migrated from
 * the old ssd1306-i2c / ssd1306-spi entries carry it so their behaviour is
 * preserved exactly).  Consolidates the old three picker entries into one
 * (issues #101 / #215).
 */
PartSimulationRegistry.register('ssd1306', {
  attachEvents: (element, simulator, getPin, componentId) => {
    const { components } = useSimulatorStore.getState();
    const comp = components.find((c) => c.id === componentId);
    const i2cAddr = parseI2cAddress(comp?.properties?.i2cAddress, 0x3c);
    const explicit = comp?.properties?.protocol;
    const protocol: 'i2c' | 'spi' =
      explicit === 'i2c' || explicit === 'spi' ? explicit : detectSSD1306Protocol(getPin);
    return attachSSD1306(element, simulator, getPin, protocol, i2cAddr);
  },
});

/**
 * SSD1306 OLED (I2C, 4-pin) — the cheap `velxio-ssd1306-i2c` module (GND/VCC/
 * SCL/SDA). Same display core as the 8-pin part but I2C-only by construction,
 * so there's no protocol to detect. Issue #215.
 */
PartSimulationRegistry.register('ssd1306-i2c-4pin', {
  attachEvents: (element, simulator, getPin, componentId) => {
    const { components } = useSimulatorStore.getState();
    const comp = components.find((c) => c.id === componentId);
    const i2cAddr = parseI2cAddress(comp?.properties?.i2cAddress, 0x3c);
    return attachSSD1306(element, simulator, getPin, 'i2c', i2cAddr);
  },
});

// ─── DS1307 RTC ──────────────────────────────────────────────────────────────

/**
 * DS1307 Real-Time Clock — uses the pre-built VirtualDS1307 from I2CBusManager.
 * Returns the browser's current system time in BCD format for registers 0–6.
 */
PartSimulationRegistry.register('ds1307', {
  attachEvents: (_element, simulator, _getPin) => {
    const sim = simulator as any;
    const rtc = new VirtualDS1307();

    if (typeof sim.registerSensor === 'function') {
      // ── ESP32 path: backend QEMU RTC slave + frontend bus mirror ────────
      const virtualPin = 200 + 0x68;
      sim.registerSensor('ds1307', virtualPin, { addr: 0x68 });
      sim.addI2CDevice?.(rtc);
      return () => {
        sim.unregisterSensor(virtualPin);
        sim.removeI2CDevice?.(rtc.address, 0);
      };
    } else if (typeof sim.addI2CDevice === 'function') {
      // ── AVR / RP2040 path ──────────────────────────────────────────────────
      sim.addI2CDevice(rtc);
      return () => removeI2CDevice(sim, rtc.address);
    }

    return () => {};
  },
});

// ─── MPU-6050 IMU ────────────────────────────────────────────────────────────

/**
 * Virtual MPU-6050 — 6-axis IMU register simulation at I2C address 0x68.
 *
 * Pre-loaded registers:
 *  0x75 WHO_AM_I = 0x68
 *  0x6B PWR_MGMT_1 = 0x00  (already awake — no need to write 0 to wake)
 *  0x3B–0x40 ACCEL XYZ = (0, 0, +1g = 0x4000) — device sitting flat
 *  0x41–0x42 TEMP_OUT   = ~25°C
 *  0x43–0x48 GYRO XYZ  = 0 (stationary)
 *
 * The sketch can write to set register pointer, then read sequentially.
 */
class VirtualMPU6050 implements I2CDevice {
  address: number;
  registers = new Uint8Array(256);
  private regPtr = 0;
  private firstByte = true;

  constructor(address: number) {
    this.address = address;

    // WHO_AM_I
    this.registers[0x75] = 0x68;
    // PWR_MGMT_1: device awake by default (0 = no sleep)
    this.registers[0x6b] = 0x00;

    // ACCEL: Z = +1g = +16384 (0x4000) at ±2g full-scale
    this.registers[0x3b] = 0x00; // ACCEL_XOUT_H
    this.registers[0x3c] = 0x00; // ACCEL_XOUT_L
    this.registers[0x3d] = 0x00; // ACCEL_YOUT_H
    this.registers[0x3e] = 0x00; // ACCEL_YOUT_L
    this.registers[0x3f] = 0x40; // ACCEL_ZOUT_H (0x4000 = +16384 = +1g)
    this.registers[0x40] = 0x00; // ACCEL_ZOUT_L

    // TEMP: T(°C) = TEMP_OUT / 340.0 + 36.53
    //  → TEMP_OUT = (25 - 36.53) × 340 ≈ -3920 = 0xF190
    const tempRaw = Math.round((25 - 36.53) * 340) & 0xffff;
    this.registers[0x41] = (tempRaw >> 8) & 0xff;
    this.registers[0x42] = tempRaw & 0xff;

    // GYRO: all zero (stationary)
    // 0x43–0x48 already 0 from Uint8Array initialization
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

PartSimulationRegistry.register('mpu6050', {
  attachEvents: (element, simulator, _getPin, componentId) => {
    const sim = simulator as any;
    const el = element as any;
    // Respect AD0 pin: `el.ad0 = true` → address 0x69, else 0x68
    const addr = el.ad0 === true || el.ad0 === 'true' ? 0x69 : 0x68;

    if (typeof sim.registerSensor === 'function') {
      // ── ESP32 path: backend QEMU I2C slave + frontend bus mirror ────────
      const virtualPin = 200 + addr;
      const device = new VirtualMPU6050(addr);
      sim.registerSensor('mpu6050', virtualPin, { addr });
      sim.addI2CDevice?.(device);

      const writeI16 = (regH: number, raw: number) => {
        const v = Math.max(-32768, Math.min(32767, Math.round(raw))) & 0xffff;
        device.registers[regH] = (v >> 8) & 0xff;
        device.registers[regH + 1] = v & 0xff;
      };

      registerSensorUpdate(componentId, (values) => {
        sim.updateSensor(virtualPin, values);
        // Keep the frontend-side mirror in sync so peer-master bridge reads
        // see fresh values too.
        if ('accelX' in values) writeI16(0x3b, (values.accelX as number) * 16384);
        if ('accelY' in values) writeI16(0x3d, (values.accelY as number) * 16384);
        if ('accelZ' in values) writeI16(0x3f, (values.accelZ as number) * 16384);
        if ('gyroX' in values) writeI16(0x43, (values.gyroX as number) * 131);
        if ('gyroY' in values) writeI16(0x45, (values.gyroY as number) * 131);
        if ('gyroZ' in values) writeI16(0x47, (values.gyroZ as number) * 131);
        if ('temp' in values) writeI16(0x41, ((values.temp as number) - 36.53) * 340);
      });

      return () => {
        sim.unregisterSensor(virtualPin);
        sim.removeI2CDevice?.(addr, 0);
        unregisterSensorUpdate(componentId);
      };
    } else if (typeof sim.addI2CDevice === 'function') {
      // ── AVR / RP2040 path: virtual I2C device in JavaScript ──────────────
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
    }

    return () => {};
  },
});

// ─── DHT22 Temperature / Humidity Sensor ─────────────────────────────────────

/**
 * DHT22 (AM2302) — a line-owning sensor. The protocol (start signal, 40-bit
 * self-timed reply on the same wire) is the MODEL in simulation/line/models/
 * dht22.ts, hosted by whichever board the part is wired to under the line
 * contract. This part only binds the canvas element to that contract: it says
 * what it is and where it sits, forwards slider changes, and shows the
 * board's answer when the board cannot host it.
 *
 * Default values: 50.0% humidity, 25.0 C. Change via `el.temperature` /
 * `el.humidity`.
 */
PartSimulationRegistry.register('dht22', {
  attachEvents: (element, simulator, getPin, componentId) => {
    // wokwi-dht22 element uses 'SDA' as the data pin name (not 'DATA')
    const pin = getPin('SDA') ?? getPin('DATA');
    if (pin === null) return () => {};

    const el = element as { temperature?: number; humidity?: number };
    const answer = requestLine(
      simulator,
      {
        sensor_type: 'dht22',
        pin,
        temperature: el.temperature ?? 25.0,
        humidity: el.humidity ?? 50.0,
      },
      { componentId },
    );

    // SensorControlPanel: update temperature / humidity on the element, and
    // tell the host when there is one.
    registerSensorUpdate(componentId, (values) => {
      if ('temperature' in values) el.temperature = values.temperature as number;
      if ('humidity' in values) el.humidity = values.humidity as number;
      if (answer.mode !== 'none') {
        answer.update({ temperature: el.temperature ?? 25.0, humidity: el.humidity ?? 50.0 });
      }
    });

    return () => {
      if (answer.mode !== 'none') answer.release();
      // A refusal left a gap recorded; drop it so a rewire cannot keep
      // reporting a sensor the user has already moved.
      else releaseLineGap(componentId);
      unregisterSensorUpdate(componentId);
    };
  },
});

// ─── HX711 Load Cell Amplifier ────────────────────────────────────────────────

/**
 * HX711 — 24-bit ADC for load cells.
 *
 * Protocol:
 *  - DOUT LOW  = conversion ready
 *  - MCU reads 24 rising CLK edges → DOUT sends 24 bits MSB-first
 *  - 1 extra CLK pulse → gain 128 (channel A, default)
 *  - After 25th pulse falling edge: new conversion starts (DOUT → LOW after ~delay)
 *
 * Default weight: 100 g. Change via element.weight (grams).
 * Raw ADC = weight × 1000 (signed 24-bit two's complement).
 *
 * Taring: Arduino sketches typically call tare() first, which reads the
 * zero offset. This simulation always returns weight × 1000 as the raw value;
 * after taring with 0 g the sketch will correctly read any non-zero value.
 */
PartSimulationRegistry.register('hx711', {
  attachEvents: (element, simulator, getPin) => {
    const pinSCK = getPin('SCK');
    const pinDOUT = getPin('DOUT');
    if (pinSCK === null || pinDOUT === null) return () => {};

    let rawValue = rawFromWeight(element);
    let bitCount = 0;
    let finishing = false;

    function rawFromWeight(el: HTMLElement): number {
      const w = (el as any).weight ?? 100; // grams
      const raw = Math.round(w * 1000); // 24-bit fixed-point
      return Math.max(-8_388_608, Math.min(8_388_607, raw)) & 0xff_ffff;
    }

    // DOUT LOW = next conversion ready
    simulator.setPinState(pinDOUT, false);

    const unsub = (simulator as any).pinManager.onPinChange(
      pinSCK,
      (_: number, rising: boolean) => {
        if (rising) {
          // Rising edge: output the current bit (MSB first), then advance
          if (bitCount < 24) {
            const bit = (rawValue >> (23 - bitCount)) & 1;
            simulator.setPinState(pinDOUT, bit === 1);
            bitCount++;
          } else {
            // 25th pulse → gain select. DOUT driven HIGH (end of word)
            simulator.setPinState(pinDOUT, true);
            finishing = true;
          }
        } else {
          // Falling edge after the 25th pulse → conversion complete
          if (finishing) {
            finishing = false;
            bitCount = 0;
            rawValue = rawFromWeight(element);
            // DOUT LOW = new conversion ready (simulate ~10 ms conversion time)
            setTimeout(() => simulator.setPinState(pinDOUT, false), 10);
          }
        }
      },
    );

    return () => {
      unsub();
      simulator.setPinState(pinDOUT, true); // DOUT HIGH = device idle / power down
    };
  },
});

// ─── Infrared ────────────────────────────────────────────────────────────────

/**
 * The two IR parts, and the air between them.
 *
 * WHAT WAS WRONG. Both were dead, each in its own way, and neither failure
 * looked like a failure on the canvas:
 *
 *  - the receiver asked for a pin named `OUT` or `DATA`. `wokwi-ir-receiver`
 *    calls it `DAT`, so the lookup returned null and `attachEvents` returned
 *    an empty cleanup on its second line. Wired or not, the part did nothing.
 *  - the remote asked for a pin too. It is a remote control: it has no pins
 *    and never had. All it did was dispatch an `ir-signal` DOM event that
 *    nothing in the codebase listened for, with a command from a hand-written
 *    key table whose names the element never emits — while the element itself
 *    was already carrying the correct NEC code in `detail.irCode`.
 *  - and the pulse train was built out of `setTimeout(next, 0.562)`. A NEC
 *    mark is 560 us; setTimeout's floor is a millisecond and its nested clamp
 *    is four. No IR library could ever have decoded it.
 *
 * WHAT THEY ARE NOW. The remote transmits into `simulation/ir/irAir` — the
 * medium, with no wire and no geometry — and the receiver is a line-owning
 * model (`simulation/line/models/ir-nec`) that puts the envelope of whatever
 * it hears on its pin, on the guest's own cycle counter, at real NEC timing.
 * Several remotes and several receivers work at once, on any mix of boards,
 * because the air carries microseconds and each receiver converts them to its
 * own board's clock.
 */

/** A component property that may arrive as a number or as a typed string. */
function numProp(el: Record<string, unknown>, keys: string[], dflt: number): number {
  for (const k of keys) {
    const v = el[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = v.trim().toLowerCase().startsWith('0x') ? parseInt(v, 16) : parseFloat(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return dflt;
}

function textProp(el: Record<string, unknown>, key: string): string {
  const v = el[key];
  return typeof v === 'string' ? v : '';
}

/**
 * IR receiver — the demodulator can (a VS1838B, a TSOP38238) behind the lens.
 *
 * It owns its output pin through the line contract, so the board that hosts it
 * answers honestly: the model runs in the browser (AVR, RP2040, RP2350, the
 * esp32*js engines), it runs in the backend worker, or this board cannot host
 * it and the circuit check says why. A click on the part still transmits, as a
 * convenience for a canvas with no remote on it — the part IS the remote then,
 * sending its configured address and command.
 */
PartSimulationRegistry.register('ir-receiver', {
  attachEvents: (element, simulator, getPin, componentId) => {
    // `DAT` is what the element declares. The other two are accepted because
    // modules in the wild silk-screen them, and a saved project may carry
    // either spelling.
    const pin = getPin('DAT') ?? getPin('OUT') ?? getPin('DATA');
    if (pin === null) return () => {};

    const el = element as unknown as Record<string, unknown>;
    const channel = () => textProp(el, 'channel');
    /** Bumped on every transmission: the model fires on the CHANGE, so two
     *  identical presses in a row are still two frames. */
    let seq = 0;

    const answer = requestLine(
      simulator,
      {
        sensor_type: 'ir-nec',
        pin,
        address: numProp(el, ['irAddress', 'address'], 0x00),
        command: numProp(el, ['irCommand', 'command'], 0x45),
        channel: channel(),
      },
      { componentId },
    );

    /** Put a train on the pin. The air already decoded it; this only has to
     *  reproduce the envelope, so the raw pulses go over untouched — a remote
     *  speaking a protocol nothing here parses still reaches the sketch. */
    const deliver = (pulses: readonly IrPulse[]): boolean => {
      if (answer.mode === 'none') return false;
      answer.update({ pulses, seq: ++seq });
      return true;
    };

    const unlisten = listenIr(componentId, channel, (f: IrAirFrame) => deliver(f.pulses));

    // Clicking the receiver transmits its own configured code, so a canvas
    // with no remote on it is still testable. It goes through the air like
    // anything else, which is also what makes a second receiver hear it.
    const onClick = () => {
      emitIr({
        pulses: necEncode(
          numProp(el, ['irAddress', 'address'], 0x00),
          numProp(el, ['irCommand', 'command'], 0x45),
        ),
        sourceId: componentId,
        channel: channel(),
      });
    };
    element.addEventListener('click', onClick);

    // The sensor panel edits the SAME two values the element carries, so a
    // slider and the hex property in the inspector cannot drift apart and the
    // click path below reads whatever was set last.
    registerSensorUpdate(componentId, (values) => {
      if ('address' in values) el.irAddress = values.address;
      if ('command' in values) el.irCommand = values.command;
      // The panel's Send button transmits into the room rather than straight
      // onto the pin, so every OTHER receiver on this channel hears it too.
      if ('send' in values) onClick();
    });

    return () => {
      unlisten();
      element.removeEventListener('click', onClick);
      if (answer.mode !== 'none') answer.release();
      else releaseLineGap(componentId);
      unregisterSensorUpdate(componentId);
    };
  },
});

/**
 * IR remote control — a handset. It has no pins and connects to nothing; it
 * transmits into the room and whatever is listening hears it.
 *
 * The element already computes the NEC code for the button that was pressed
 * (`detail.irCode`) and it is the authority: the codes belong to the artwork
 * printed on its keys. The old hand-written table here disagreed with it on
 * every single key and was keyed on button names the element never emits.
 *
 * Holding a button repeats, exactly as a real remote does — a NEC repeat frame
 * every 108 ms, which is what makes a volume key ramp instead of stepping once.
 */
PartSimulationRegistry.register('ir-remote', {
  attachEvents: (element, _simulator, _getPin, componentId) => {
    const el = element as unknown as Record<string, unknown>;
    const channel = () => textProp(el, 'channel');
    /** The address the handset sends. NEC remotes each have their own; the
     *  element models one physical remote, so the property is on the part. */
    const address = () => numProp(el, ['irAddress', 'address'], 0x00);

    let repeatTimer: ReturnType<typeof setInterval> | null = null;
    const stopRepeat = () => {
      if (repeatTimer !== null) {
        clearInterval(repeatTimer);
        repeatTimer = null;
      }
    };

    const send = (pulses: readonly IrPulse[]) => {
      const taken = emitIr({ pulses, sourceId: componentId, channel: channel() });
      if (taken === 0) {
        // "The button does nothing" and "nothing was listening" look the same
        // on a canvas, and only one of them is the user's mistake.
        console.warn(
          `[ir] ${componentId} transmitted and no receiver took it` +
            (channel() ? ` on channel '${channel()}'` : ''),
        );
      }
    };

    const onButtonPress = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? {};
      const irCode = Number(detail.irCode);
      if (!Number.isFinite(irCode)) return;
      stopRepeat();
      send(necEncode(address(), irCode & 0xff));
      // A held key sends repeat frames, carrying no data, every 108 ms.
      repeatTimer = setInterval(() => send(necEncodeRepeat()), NEC_REPEAT_PERIOD_MS);
    };
    const onButtonRelease = () => stopRepeat();

    element.addEventListener('button-press', onButtonPress);
    element.addEventListener('button-release', onButtonRelease);
    // A button-press with no release (the element focuses and blurs, a pointer
    // leaves the SVG) must not repeat forever.
    element.addEventListener('mouseleave', onButtonRelease);

    return () => {
      stopRepeat();
      element.removeEventListener('button-press', onButtonPress);
      element.removeEventListener('button-release', onButtonRelease);
      element.removeEventListener('mouseleave', onButtonRelease);
    };
  },
});

// ─── MicroSD Card ─────────────────────────────────────────────────────────────

/**
 * MicroSD card — generic SD-over-SPI device with a real backing store.
 *
 * Hooks the hardware SPI peripheral (simulator.spi) — works for AVR and RP2040
 * (both expose the `.spi` adapter). ESP32 runs in QEMU and is a separate path.
 *
 * Implements the SD v2 / SDHC command set the SD.h / SdFat libraries use, so it
 * works generically with any card configuration (not a one-card hack):
 *   - Init/info: CMD0, CMD8 (R7), CMD55+ACMD41, CMD58 (OCR, CCS=1 SDHC),
 *     CMD9 (CSD v2 reflecting SD_CARD_BYTES), CMD10 (CID), CMD13, CMD16.
 *   - Read:  CMD17 (single), CMD18 (multiple, until CMD12) — served from store.
 *   - Write: CMD24 (single), CMD25 (multiple, until stop token 0xFD) — the data
 *     block that follows the command is captured and stored.
 *
 * Addressing: the card advertises SDHC (CCS=1), so CMD17/24 args are BLOCK
 * indices (not byte offsets). Backing store is a sparse Map of 512-byte sectors.
 *
 * An optional pre-built FAT image can be injected via element.sdImageData (the
 * file-upload / auto-copy feature lands files there). The response queue drains
 * one byte per SPI transfer; idle line reads 0xFF.
 */
const SD_BLOCK_SIZE = 512;
// Fixed card capacity (mirrors Wokwi's "no size attribute" model). The backing
// store is SPARSE — only written/loaded blocks allocate — so the advertised
// capacity is free in RAM. Adjustable here; not exposed to the user.
const SD_CARD_BYTES = 64 * 1024 * 1024; // 64 MB
const SD_C_SIZE = Math.floor(SD_CARD_BYTES / (512 * 1024)) - 1; // CSD v2 C_SIZE

PartSimulationRegistry.register('microsd-card', {
  attachEvents: (element, simulator, _getPin) => {
    const spi = (simulator as any).spi;
    if (!spi) return () => {};
    const el = element as any;

    // ── Backing store: sparse map of blockIndex -> 512-byte sector ──────────
    const store = new Map<number, Uint8Array>();
    const readBlock = (idx: number): Uint8Array => store.get(idx) ?? new Uint8Array(SD_BLOCK_SIZE); // unwritten = zeros
    const writeBlock = (idx: number, data: ArrayLike<number>): void => {
      const blk = new Uint8Array(SD_BLOCK_SIZE);
      blk.set(Array.from(data).slice(0, SD_BLOCK_SIZE));
      store.set(idx, blk);
    };

    // Optional pre-built FAT image (Phase 2 sets element.sdImageData). Loaded
    // into the store block-by-block so the firmware can mount + read it.
    (() => {
      const raw = el.sdImageData;
      if (!raw) return;
      const bytes: Uint8Array | null =
        raw instanceof Uint8Array
          ? raw
          : raw instanceof ArrayBuffer
            ? new Uint8Array(raw)
            : Array.isArray(raw)
              ? Uint8Array.from(raw)
              : null;
      if (!bytes) return;
      for (let i = 0; i * SD_BLOCK_SIZE < bytes.length; i++) {
        const slice = bytes.subarray(i * SD_BLOCK_SIZE, (i + 1) * SD_BLOCK_SIZE);
        // Skip all-zero blocks so the store stays sparse (they read back as
        // zeros anyway) — a multi-MB FAT image only allocates its used blocks.
        if (slice.some((b) => b !== 0)) writeBlock(i, slice);
      }
    })();

    // ── 16-byte CSD (v2.0, high-capacity) reflecting SD_CARD_BYTES ──────────
    const buildCSD = (): number[] => [
      0x40,
      0x0e,
      0x00,
      0x32,
      0x5b,
      0x59,
      0x00,
      (SD_C_SIZE >> 16) & 0x3f,
      (SD_C_SIZE >> 8) & 0xff,
      SD_C_SIZE & 0xff,
      0x7f,
      0x80,
      0x0a,
      0x40,
      0x00,
      0x01,
    ];
    // ── 16-byte CID (manufacturer info; values are cosmetic) ────────────────
    const buildCID = (): number[] => [
      0x01,
      0x56,
      0x58,
      0x56,
      0x45,
      0x4c,
      0x58,
      0x53, // mfr, "VX", "VELXS"
      0x10,
      0x00,
      0x00,
      0x00,
      0x01,
      0x01,
      0x60,
      0x01,
    ];

    // ── SD SPI protocol state machine ───────────────────────────────────────
    const respQueue: number[] = [];
    let cmdBuf: number[] = [];
    let expectingAcmd = false;
    // Phases: 'cmd' (idle/command), and the write data path after CMD24/25.
    let phase: 'cmd' | 'wait-token' | 'recv-data' | 'recv-crc' = 'cmd';
    let dataBuf: number[] = [];
    let crcLeft = 0;
    let writeAddr = 0;
    let multiWrite = false;
    // CMD18 continuous read: keep streaming blocks until CMD12.
    let multiRead = false;
    let readAddr = 0;

    /** Queue a data block as the firmware reads it: token + 512 bytes + CRC. */
    const pushDataBlock = (bytes: ArrayLike<number>): void => {
      respQueue.push(0xfe); // start-block token
      for (let i = 0; i < SD_BLOCK_SIZE; i++) respQueue.push((bytes as any)[i] ?? 0);
      respQueue.push(0xff, 0xff); // CRC (ignored by SPI mode)
    };
    /** Queue R1 + a short (<=16 byte) data block (CSD/CID). */
    const pushShortData = (bytes: number[]): void => {
      respQueue.push(0x00, 0xfe, ...bytes, 0xff, 0xff);
    };

    const processCmd = (raw: number[]): void => {
      const cmd = raw[0] & 0x3f;
      const arg = ((raw[1] << 24) | (raw[2] << 16) | (raw[3] << 8) | raw[4]) >>> 0;
      const isAcmd = expectingAcmd;
      expectingAcmd = false;

      if (isAcmd) {
        if (cmd === 41) {
          respQueue.push(0x00);
          return;
        } // ACMD41 — ready
        if (cmd === 13) {
          respQueue.push(0x00, 0x00);
          return;
        } // ACMD13 SD status (R2)
        // fall through for other ACMDs
      }

      switch (cmd) {
        case 0:
          respQueue.push(0x01);
          break; // GO_IDLE -> idle
        case 8:
          respQueue.push(0x01, 0x00, 0x00, 0x01, 0xaa);
          break; // SEND_IF_COND (R7)
        case 9:
          pushShortData(buildCSD());
          break; // SEND_CSD
        case 10:
          pushShortData(buildCID());
          break; // SEND_CID
        case 12:
          multiRead = false;
          respQueue.push(0x00, 0x00, 0xff);
          break; // STOP_TRANSMISSION
        case 13:
          respQueue.push(0x00, 0x00);
          break; // SEND_STATUS (R2)
        case 16:
          respQueue.push(0x00);
          break; // SET_BLOCKLEN (fixed 512)
        // Standard-capacity (SDSC) byte addressing: CMD17/18/24/25 args are BYTE
        // offsets (block*512), not block indices. The Arduino SD library uses
        // this even when the card advertises SDHC, so we present SDSC (CMD58
        // CCS=0) and translate `arg >> 9` -> block. SDSC covers up to 2 GB,
        // plenty for our small card; every SD library supports it.
        case 17:
          respQueue.push(0x00);
          pushDataBlock(readBlock(arg >> 9));
          break; // READ_SINGLE
        case 18: // READ_MULTIPLE — stream until CMD12
          respQueue.push(0x00);
          readAddr = arg >> 9;
          multiRead = true;
          pushDataBlock(readBlock(readAddr));
          readAddr++;
          break;
        case 24: // WRITE_SINGLE — data block follows
          respQueue.push(0x00);
          writeAddr = arg >> 9;
          multiWrite = false;
          phase = 'wait-token';
          break;
        case 25: // WRITE_MULTIPLE — data blocks follow until stop token
          respQueue.push(0x00);
          writeAddr = arg >> 9;
          multiWrite = true;
          phase = 'wait-token';
          break;
        case 55:
          respQueue.push(0x01);
          expectingAcmd = true;
          break; // APP_CMD prefix
        case 58:
          respQueue.push(0x00, 0x80, 0xff, 0x80, 0x00);
          break; // READ_OCR (powered, CCS=0 SDSC)
        default:
          respQueue.push(0x00); // accept unhandled commands
      }
    };

    const prevOnByte = spi.onByte as ((b: number) => void) | null | undefined;

    spi.onByte = (byte: number) => {
      // Full-duplex: the MISO shifted out for THIS transfer was prepared by
      // earlier bytes, so reply FIRST (from the queue as it stood before this
      // byte), THEN consume this MOSI byte to prepare future MISO. This gives
      // the 1-byte (Ncr) command->response latency real SD cards have — the
      // host reads R1 on the 0xFF clocks it sends AFTER the 6 command bytes,
      // not on the last command byte. Replying after processing broke SD.begin.
      spi.completeTransfer?.(respQueue.length > 0 ? respQueue.shift()! : 0xff);

      switch (phase) {
        case 'cmd':
          if (cmdBuf.length === 0 && (byte & 0xc0) === 0x40) {
            cmdBuf = [byte]; // command start (bit7=0, bit6=1)
          } else if (cmdBuf.length > 0) {
            cmdBuf.push(byte);
            if (cmdBuf.length === 6) {
              processCmd(cmdBuf);
              cmdBuf = [];
            }
          } else if (multiRead && respQueue.length === 0) {
            // Continuous read: refill the next block while the host clocks 0xFF.
            pushDataBlock(readBlock(readAddr));
            readAddr++;
          }
          break;
        case 'wait-token':
          if (byte === 0xfe || byte === 0xfc) {
            phase = 'recv-data';
            dataBuf = [];
          } else if (byte === 0xfd) {
            multiWrite = false;
            phase = 'cmd';
            respQueue.push(0x00);
          }
          // else 0xFF gap — keep waiting
          break;
        case 'recv-data':
          dataBuf.push(byte);
          if (dataBuf.length === SD_BLOCK_SIZE) {
            phase = 'recv-crc';
            crcLeft = 2;
          }
          break;
        case 'recv-crc':
          if (--crcLeft === 0) {
            writeBlock(writeAddr, dataBuf);
            writeAddr++;
            respQueue.push(0x05); // data-response: accepted
            phase = multiWrite ? 'wait-token' : 'cmd';
          }
          break;
      }
    };

    return () => {
      spi.onByte = prevOnByte ?? null;
      respQueue.length = 0;
      cmdBuf = [];
      store.clear();
    };
  },
});

// ─── BMP280 Barometric Pressure / Temperature Sensor ─────────────────────────

/**
 * BMP280 — I2C barometric pressure + temperature sensor.
 *
 * Addresses:
 *   0x76 (SDO pin pulled LOW, default)
 *   0x77 (SDO pin pulled HIGH — set element.address = '0x77')
 *
 * The element may expose `temperature` (°C) and `pressure` (hPa) properties
 * that are read on attach and forwarded to the virtual device.
 *
 * The virtual device uses the BMP280 datasheet calibration example to compute
 * raw ADC values for any desired temperature/pressure combination, so Arduino
 * sketches using Adafruit_BMP280 or Bosch's reference driver receive correct
 * compensated readings.
 */
PartSimulationRegistry.register('bmp280', {
  attachEvents: (element, simulator, _getPin, componentId) => {
    const sim = simulator as any;
    const el = element as any;
    const addr = el.address === '0x77' || el.address === 0x77 ? 0x77 : 0x76;
    const initTemp = el.temperature !== undefined ? parseFloat(el.temperature) : 25.0;
    const initPressure = el.pressure !== undefined ? parseFloat(el.pressure) : 1013.25;

    if (typeof sim.registerSensor === 'function') {
      // ── ESP32 path: backend BMP280 slave + frontend bus mirror ──────────
      const virtualPin = 200 + addr;
      const dev = new VirtualBMP280(addr);
      dev.temperatureC = initTemp;
      dev.pressureHPa = initPressure;
      sim.registerSensor('bmp280', virtualPin, {
        addr,
        temperature: initTemp,
        pressure: initPressure,
      });
      sim.addI2CDevice?.(dev);

      registerSensorUpdate(componentId, (values) => {
        sim.updateSensor(virtualPin, values);
        if ('temperature' in values) dev.temperatureC = values.temperature as number;
        if ('pressure' in values) dev.pressureHPa = values.pressure as number;
      });

      return () => {
        sim.unregisterSensor(virtualPin);
        sim.removeI2CDevice?.(addr, 0);
        unregisterSensorUpdate(componentId);
      };
    } else if (typeof sim.addI2CDevice === 'function') {
      // ── AVR / RP2040 path ──────────────────────────────────────────────────
      const dev = new VirtualBMP280(addr);
      dev.temperatureC = initTemp;
      dev.pressureHPa = initPressure;
      sim.addI2CDevice(dev);

      registerSensorUpdate(componentId, (values) => {
        if ('temperature' in values) dev.temperatureC = values.temperature as number;
        if ('pressure' in values) dev.pressureHPa = values.pressure as number;
      });

      return () => {
        removeI2CDevice(sim, dev.address);
        unregisterSensorUpdate(componentId);
      };
    }

    return () => {};
  },
});

// ─── DS3231 Real-Time Clock ───────────────────────────────────────────────────

/**
 * DS3231 — I2C RTC with on-chip temperature sensor (address 0x68).
 *
 * Returns the browser's current system time as BCD in registers 0x00–0x06,
 * identical to DS1307 for the time registers. Additionally exposes:
 *   0x0E  Control register
 *   0x0F  Status register (OSF cleared)
 *   0x11  Temperature MSB (integer °C, signed)
 *   0x12  Temperature LSB (fractional, 0.25°C per bit in bits 7:6)
 *
 * Ambient temperature defaults to 25°C; override via `element.temperature`.
 */
PartSimulationRegistry.register('ds3231', {
  attachEvents: (element, simulator, _getPin, componentId) => {
    const sim = simulator as any;
    const el = element as any;
    const initTemp = el.temperature !== undefined ? parseFloat(el.temperature) : 25.0;

    if (typeof sim.registerSensor === 'function') {
      // ── ESP32 path: backend DS3231 slave + frontend bus mirror ──────────
      const virtualPin = 200 + 0x68;
      const dev = new VirtualDS3231();
      dev.temperatureC = initTemp;
      sim.registerSensor('ds3231', virtualPin, { addr: 0x68, temperature: initTemp });
      sim.addI2CDevice?.(dev);
      registerSensorUpdate(componentId, (values) => {
        sim.updateSensor(virtualPin, values);
        if ('temperature' in values) dev.temperatureC = values.temperature as number;
      });
      return () => {
        sim.unregisterSensor(virtualPin);
        sim.removeI2CDevice?.(dev.address, 0);
        unregisterSensorUpdate(componentId);
      };
    } else if (typeof sim.addI2CDevice === 'function') {
      // ── AVR / RP2040 path ──────────────────────────────────────────────────
      const dev = new VirtualDS3231();
      dev.temperatureC = initTemp;
      sim.addI2CDevice(dev);
      registerSensorUpdate(componentId, (values) => {
        if ('temperature' in values) dev.temperatureC = values.temperature as number;
      });
      return () => {
        removeI2CDevice(sim, dev.address);
        unregisterSensorUpdate(componentId);
      };
    }

    return () => {};
  },
});

// ─── PCF8574 I/O Expander ────────────────────────────────────────────────────

/**
 * PCF8574 — I2C 8-bit quasi-bidirectional I/O expander.
 *
 * Default address: 0x27 (all three address pins HIGH — typical LCD backpack).
 * Override with `element.i2cAddress` (e.g. '0x20', '0x3F').
 *
 * `element.portState` (0–255) sets the external input state visible to the
 * Arduino on a read. Defaults to 0xFF (all pins pulled high / floating input).
 *
 * Writes from the Arduino update `dev.outputLatch` and fire `dev.onWrite`
 * which sets `element.value` so wokwi-LCD-I2C or similar elements can render.
 */
PartSimulationRegistry.register('pcf8574', {
  attachEvents: (element, simulator, _getPin) => {
    const sim = simulator as any;
    const el = element as any;

    // Parse address from element property (accepts '0x27', '39', or numeric)
    let addr = 0x27;
    if (el.i2cAddress !== undefined) {
      const raw = String(el.i2cAddress).trim();
      const parsed =
        raw.startsWith('0x') || raw.startsWith('0X') ? parseInt(raw, 16) : parseInt(raw, 10);
      if (!isNaN(parsed)) addr = parsed;
    }

    const dev = new VirtualPCF8574(addr);
    if (el.portState !== undefined) dev.portState = Number(el.portState) & 0xff;
    dev.onWrite = (value: number) => {
      el.value = value;
    };

    if (typeof sim.registerSensor === 'function') {
      // ── ESP32 path: backend slave + frontend bus mirror ─────────────────
      const virtualPin = 200 + addr;
      sim.registerSensor('pcf8574', virtualPin, { addr });
      sim.addI2CTransactionListener?.(addr, (data: number[]) => {
        if (data.length > 0) dev.writeByte(data[0]);
      });
      sim.addI2CDevice?.(dev);
      return () => {
        sim.unregisterSensor(virtualPin);
        sim.removeI2CTransactionListener?.(addr);
        sim.removeI2CDevice?.(addr, 0);
      };
    } else if (typeof sim.addI2CDevice === 'function') {
      // ── AVR / RP2040 path ──────────────────────────────────────────────────
      sim.addI2CDevice(dev);
      return () => removeI2CDevice(sim, dev.address);
    }

    return () => {};
  },
});

// ─── LCD1602 / LCD2004 with I2C backpack (PCF8574 + HD44780) ────────────────

/**
 * Common parser for an I2C address property coming from a wokwi-element
 * (the metadata exposes `i2cAddress` as a text control; users type
 * "0x27", "39", or just the raw number).
 */
function parseI2cAddress(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'number' && !isNaN(raw)) return raw & 0x7f;
  const s = String(raw).trim();
  if (!s) return fallback;
  const parsed = s.toLowerCase().startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10);
  return isNaN(parsed) ? fallback : parsed & 0x7f;
}

/**
 * Build a part attach function for an LCD with an I2C backpack.  The
 * same logic applies to LCD1602 (16×2) and LCD2004 (20×4); only the
 * geometry differs.
 *
 * On attach:
 *  1. Force the underlying `wokwi-lcd1602` / `wokwi-lcd2004` element
 *     into I2C-pinout mode (`pins='i2c'`) so the user sees the
 *     correct 4-pin backpack header.
 *  2. Pre-fill `characters` with spaces so the screen is clean before
 *     the sketch issues its first Clear command.
 *  3. Create a `VirtualPCF8574` at the configured address.
 *  4. Pipe `pcf.onWrite` → `HD44780Decoder.feedPCF8574Byte`.
 *  5. Reflect the decoder's `characters` + `backlight` snapshots back
 *     onto the element's reactive properties.
 *
 * Works on AVR, RP2040, and the ESP32 backend (same trifurcation
 * pattern as other I2C parts above).
 */
function makeI2cLcdAttach(cols: number, rows: number) {
  return (
    element: HTMLElement,
    simulator: unknown,
    _getPin: (name: string) => number | null,
  ): (() => void) => {
    const sim = simulator as any;
    const el = element as any;

    const addr = parseI2cAddress(el.i2cAddress ?? el.address, 0x27);

    // Switch the underlying LCD element to I2C pin mode + a clean
    // characters buffer.  The host wokwi element re-renders on
    // attribute change.
    try {
      el.pins = 'i2c';
    } catch {
      /* read-only on some implementations — ignore */
    }
    const blankGrid = new Uint8Array(cols * rows).fill(0x20);
    el.characters = blankGrid;
    if (el.backlight === undefined) el.backlight = true;

    const decoder = new HD44780Decoder({ cols, rows });
    decoder.onCharsChange = (chars) => {
      // wokwi-lcd1602 accepts both number[] and Uint8Array.  Use Uint8Array
      // so Lit's change detection sees a new reference.
      el.characters = Uint8Array.from(chars);
    };
    decoder.onBacklightChange = (on) => {
      el.backlight = on;
    };
    decoder.onCursorChange = (snap) => {
      el.cursorX = snap.cursorCol;
      el.cursorY = snap.cursorRow;
      el.cursor = snap.cursorOn;
      el.blink = snap.cursorBlink;
    };

    const pcf = new VirtualPCF8574(addr);
    pcf.onWrite = (v: number) => decoder.feedPCF8574Byte(v);

    if (typeof sim.registerSensor === 'function') {
      // ── ESP32 path: backend QEMU PCF8574 slave forwards transactions
      //    back to us, and the same VirtualPCF8574 is also on the frontend
      //    bus so peer boards can reach it via the I2C bridge. ─────────
      const virtualPin = 200 + addr;
      sim.registerSensor('pcf8574', virtualPin, { addr });
      sim.addI2CTransactionListener?.(addr, (data: number[]) => {
        for (const b of data) decoder.feedPCF8574Byte(b);
      });
      sim.addI2CDevice?.(pcf);
      return () => {
        sim.unregisterSensor(virtualPin);
        sim.removeI2CTransactionListener?.(addr);
        sim.removeI2CDevice?.(addr, 0);
        decoder.reset();
      };
    } else if (typeof sim.addI2CDevice === 'function') {
      // ── AVR / RP2040 path ────────────────────────────────────────────
      sim.addI2CDevice(pcf);
      return () => {
        removeI2CDevice(sim, pcf.address);
        decoder.reset();
      };
    }

    return () => decoder.reset();
  };
}

/**
 * LCD 16×2 with PCF8574 I2C backpack — the classic "I2C LCD" you buy
 * in a single piece on AliExpress.  Default address 0x27.
 */
PartSimulationRegistry.register('lcd1602-i2c', {
  attachEvents: makeI2cLcdAttach(16, 2),
});

/**
 * LCD 20×4 with PCF8574 I2C backpack.  Same protocol; uses the 2004
 * DDRAM row offsets (0x00, 0x40, 0x14, 0x54).
 */
PartSimulationRegistry.register('lcd2004-i2c', {
  attachEvents: makeI2cLcdAttach(20, 4),
});
