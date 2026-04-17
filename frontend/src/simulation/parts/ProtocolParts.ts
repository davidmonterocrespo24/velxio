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
 *  ir-receiver  — NEC IR receiver. Click generates active-low pulse train.
 *  ir-remote    — NEC IR remote. Button click dispatches ir-signal event.
 *  microsd-card — SPI SD card. Responds to CMD0/CMD8/ACMD41/CMD58 init.
 *
 * NOTE — timing-sensitive protocols (dht22, ir-receiver, ir-remote):
 *   Full µs-accuracy requires CPU-loop integration. These simulate protocol
 *   intent and work with polling-based Arduino code; hardware-interrupt-based
 *   libraries (e.g. IRremote) need the exact cycle counts not available here.
 */

import { PartSimulationRegistry } from './PartSimulationRegistry';
import { VirtualDS1307, VirtualBMP280, VirtualDS3231, VirtualPCF8574 } from '../I2CBusManager';
import type { I2CDevice } from '../I2CBusManager';
import { registerSensorUpdate, unregisterSensorUpdate } from '../SensorUpdateRegistry';
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
  private col      = 0;
  private page     = 0;
  private colStart = 0;
  private colEnd   = 127;
  private pageStart = 0;
  private pageEnd   = 7;
  private memMode   = 0;        // 0=horizontal, 1=vertical, 2=page

  // Multi-byte command accumulation
  private cmdBuf: number[]  = [];
  private cmdWant           = 0;

  /** How many parameter bytes does this command require? */
  static cmdParams(cmd: number): number {
    if (cmd === 0x20 || cmd === 0x81 || cmd === 0x8D ||
        cmd === 0xA8 || cmd === 0xD3 || cmd === 0xD5 ||
        cmd === 0xD8 || cmd === 0xD9 || cmd === 0xDA || cmd === 0xDB) return 1;
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
    this.cmdBuf  = [value];
    this.cmdWant = SSD1306Core.cmdParams(value);
    if (this.cmdWant === 0) this.applyCmd();
  }

  private applyCmd(): void {
    const [cmd, p1, p2] = this.cmdBuf;
    switch (cmd) {
      case 0x20: this.memMode = p1 & 0x03; break;
      case 0x21:
        this.colStart = p1 & 0x7F;
        this.colEnd   = p2 & 0x7F;
        this.col      = this.colStart;
        break;
      case 0x22:
        this.pageStart = p1 & 0x07;
        this.pageEnd   = p2 & 0x07;
        this.page      = this.pageStart;
        break;
      default:
        if (cmd >= 0x40 && cmd <= 0x7F) { /* display start line — visual, skip */ }
        break;
    }
  }

  private advanceCursor(): void {
    if (this.memMode === 0) {         // horizontal addressing
      this.col++;
      if (this.col > this.colEnd) {
        this.col = this.colStart;
        this.page++;
        if (this.page > this.pageEnd) this.page = this.pageStart;
      }
    } else if (this.memMode === 1) {  // vertical addressing
      this.page++;
      if (this.page > this.pageEnd) {
        this.page = this.pageStart;
        this.col++;
        if (this.col > this.colEnd) this.col = this.colStart;
      }
    } else {                          // page addressing
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
          px[idx]     = lit ? 200 : 0;   // R
          px[idx + 1] = lit ? 230 : 0;   // G
          px[idx + 2] = lit ? 255 : 0;   // B
          px[idx + 3] = 255;             // A
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
  private isData   = false;

  constructor(address: number, private element: HTMLElement) {
    this.address = address;
  }

  /** Expose core buffer for tests. */
  get buffer(): Uint8Array { return this.core.buffer; }

  writeByte(value: number): boolean {
    if (this.ctrlByte) {
      this.isData   = (value & 0x40) !== 0;
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

  readByte(): number { return 0xFF; }

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
      pinManager.onPinChange(pinDC, (_: number, s: boolean) => { dcState = s; }),
    );
  }

  // Throttle rendering to ~60 fps
  let dirty = false;
  let rafId: number | null = null;
  const scheduleSync = () => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (dirty) { core.syncElement(element); dirty = false; }
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
    spi.completeTransfer(0xFF);
  };

  return () => {
    spi.onByte = prevOnByte;
    if (rafId !== null) cancelAnimationFrame(rafId);
    unsubs.forEach(u => u());
  };
}

PartSimulationRegistry.register('ssd1306', {
  attachEvents: (element, simulator, getPin, componentId) => {
    // Read the protocol property from the component in the store
    const { components } = useSimulatorStore.getState();
    const comp = components.find(c => c.id === componentId);
    const protocol = (comp?.properties?.protocol as string) ?? 'i2c';

    if (protocol === 'spi') {
      return attachSSD1306SPI(element, simulator, getPin);
    }

    // I2C mode (default)
    const sim = simulator as any;
    const i2cAddr = 0x3C;

    if (typeof sim.addI2CDevice === 'function') {
      // ── AVR / RP2040 path ──────────────────────────────────────────────────
      const device = new VirtualSSD1306(i2cAddr, element);
      sim.addI2CDevice(device);
      return () => removeI2CDevice(sim, device.address);

    } else if (typeof sim.registerSensor === 'function') {
      // ── ESP32 path: relay I2C writes via backend ───────────────────────────
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

// ─── DS1307 RTC ──────────────────────────────────────────────────────────────

/**
 * DS1307 Real-Time Clock — uses the pre-built VirtualDS1307 from I2CBusManager.
 * Returns the browser's current system time in BCD format for registers 0–6.
 */
PartSimulationRegistry.register('ds1307', {
  attachEvents: (_element, simulator, _getPin) => {
    const sim = simulator as any;

    if (typeof sim.addI2CDevice === 'function') {
      // ── AVR / RP2040 path ──────────────────────────────────────────────────
      const rtc = new VirtualDS1307();
      sim.addI2CDevice(rtc);
      return () => removeI2CDevice(sim, rtc.address);

    } else if (typeof sim.registerSensor === 'function') {
      // ── ESP32 path: delegate to backend QEMU RTC slave ────────────────────
      const virtualPin = 200 + 0x68;
      sim.registerSensor('ds1307', virtualPin, { addr: 0x68 });
      return () => sim.unregisterSensor(virtualPin);
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
  private regPtr   = 0;
  private firstByte = true;

  constructor(address: number) {
    this.address = address;

    // WHO_AM_I
    this.registers[0x75] = 0x68;
    // PWR_MGMT_1: device awake by default (0 = no sleep)
    this.registers[0x6B] = 0x00;

    // ACCEL: Z = +1g = +16384 (0x4000) at ±2g full-scale
    this.registers[0x3B] = 0x00; // ACCEL_XOUT_H
    this.registers[0x3C] = 0x00; // ACCEL_XOUT_L
    this.registers[0x3D] = 0x00; // ACCEL_YOUT_H
    this.registers[0x3E] = 0x00; // ACCEL_YOUT_L
    this.registers[0x3F] = 0x40; // ACCEL_ZOUT_H (0x4000 = +16384 = +1g)
    this.registers[0x40] = 0x00; // ACCEL_ZOUT_L

    // TEMP: T(°C) = TEMP_OUT / 340.0 + 36.53
    //  → TEMP_OUT = (25 - 36.53) × 340 ≈ -3920 = 0xF190
    const tempRaw  = Math.round((25 - 36.53) * 340) & 0xFFFF;
    this.registers[0x41] = (tempRaw >> 8) & 0xFF;
    this.registers[0x42] =  tempRaw       & 0xFF;

    // GYRO: all zero (stationary)
    // 0x43–0x48 already 0 from Uint8Array initialization
  }

  writeByte(value: number): boolean {
    if (this.firstByte) {
      this.regPtr   = value;
      this.firstByte = false;
    } else {
      this.registers[this.regPtr] = value;
      this.regPtr = (this.regPtr + 1) & 0xFF;
    }
    return true;
  }

  readByte(): number {
    const val   = this.registers[this.regPtr];
    this.regPtr = (this.regPtr + 1) & 0xFF;
    return val;
  }

  stop(): void {
    this.firstByte = true;
  }
}

PartSimulationRegistry.register('mpu6050', {
  attachEvents: (element, simulator, _getPin, componentId) => {
    const sim = simulator as any;
    const el  = element as any;
    // Respect AD0 pin: `el.ad0 = true` → address 0x69, else 0x68
    const addr = (el.ad0 === true || el.ad0 === 'true') ? 0x69 : 0x68;

    if (typeof sim.addI2CDevice === 'function') {
      // ── AVR / RP2040 path: virtual I2C device in JavaScript ──────────────
      const device = new VirtualMPU6050(addr);
      sim.addI2CDevice(device);

      const writeI16 = (regH: number, raw: number) => {
        const v = Math.max(-32768, Math.min(32767, Math.round(raw))) & 0xFFFF;
        device.registers[regH]     = (v >> 8) & 0xFF;
        device.registers[regH + 1] =  v       & 0xFF;
      };

      registerSensorUpdate(componentId, (values) => {
        if ('accelX' in values) writeI16(0x3B, (values.accelX as number) * 16384);
        if ('accelY' in values) writeI16(0x3D, (values.accelY as number) * 16384);
        if ('accelZ' in values) writeI16(0x3F, (values.accelZ as number) * 16384);
        if ('gyroX'  in values) writeI16(0x43, (values.gyroX  as number) * 131);
        if ('gyroY'  in values) writeI16(0x45, (values.gyroY  as number) * 131);
        if ('gyroZ'  in values) writeI16(0x47, (values.gyroZ  as number) * 131);
        if ('temp'   in values) writeI16(0x41, ((values.temp as number) - 36.53) * 340);
      });

      return () => {
        removeI2CDevice(sim, device.address);
        unregisterSensorUpdate(componentId);
      };

    } else if (typeof sim.registerSensor === 'function') {
      // ── ESP32 path: delegate to backend QEMU I2C slave state machine ─────
      // Use (200 + addr) as a virtual pin for I2C sensors — above valid GPIO
      // range (0–48) so it won't collide with real GPIO sensors.
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

// ─── DHT22 Temperature / Humidity Sensor ─────────────────────────────────────

/**
 * DHT22 (AM2302) — single-wire bidirectional protocol.
 *
 * Protocol summary:
 *  1. MCU drives DATA LOW for ≥1 ms  (start signal)
 *  2. MCU releases DATA HIGH
 *  3. DHT22 drives: 80 µs LOW → 80 µs HIGH (response)
 *  4. DHT22 transmits 40 bits: each bit = 50 µs LOW + (26 µs=0 | 70 µs=1) HIGH
 *  5. Data layout: [humidity_H, humidity_L, temp_H, temp_L, checksum]
 *     Humidity in 0.1%, Temperature in 0.1°C (MSB = sign for temp)
 *
 * TIMING NOTE:
 *  Full µs-accuracy requires injecting pin changes inside the CPU execution
 *  loop. This implementation drives DATA via setPinState() after detecting the
 *  start sequence. It works with simple polling-based DHT22 code. The standard
 *  Arduino DHT library uses pulseIn() counts; exact cycle-accuracy is not
 *  achievable without modifying the AVR execution loop.
 *
 * Default values: 50.0% humidity, 25.0°C temperature.
 * These can be changed by setting element properties: `el.temperature`, `el.humidity`.
 */
function buildDHT22Payload(element: HTMLElement): Uint8Array {
  const el          = element as any;
  const humidity    = Math.round((el.humidity    ?? 50.0) * 10);    // tenths of %
  const temperature = Math.round((el.temperature ?? 25.0) * 10);    // tenths of °C
  const h_H = (humidity >> 8) & 0xFF;
  const h_L =  humidity       & 0xFF;
  // Temperature sign bit is bit 15 of the 16-bit value
  const rawTemp = temperature < 0
    ? ((-temperature) & 0x7FFF) | 0x8000
    : temperature & 0x7FFF;
  const t_H = (rawTemp >> 8) & 0xFF;
  const t_L =  rawTemp       & 0xFF;
  const chk = (h_H + h_L + t_H + t_L) & 0xFF;
  return new Uint8Array([h_H, h_L, t_H, t_L, chk]);
}

/**
 * Schedule the full DHT22 waveform on DATA using cycle-accurate pin changes.
 *
 * DHT22 protocol (after MCU releases DATA HIGH):
 *  - 80 µs LOW  → 80 µs HIGH  (response preamble)
 *  - 40 bits, each: 50 µs LOW + (26 µs HIGH = '0', 70 µs HIGH = '1')
 *  - Line released HIGH after last bit
 *
 * At 16 MHz: 1 µs = 16 cycles
 *  - 80 µs = 1280 cycles, 50 µs = 800 cycles, 26 µs = 416 cycles, 70 µs = 1120 cycles
 */
function scheduleDHT22Response(simulator: any, pin: number, element: HTMLElement): void {
  if (typeof simulator.schedulePinChange !== 'function') {
    // Fallback: synchronous drive (legacy / non-AVR simulators)
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

  // Scale timing by CPU clock — AVR runs at 16 MHz, RP2040 at 125 MHz.
  const clockHz: number = typeof simulator.getClockHz === 'function'
      ? simulator.getClockHz()
      : 16_000_000;
  const us = (microseconds: number) => Math.round(microseconds * clockHz / 1_000_000);

  const RESPONSE_START = us(20);  // DHT22 response start (~20 µs after MCU releases)
  const LOW80  = us(80);  // 80 µs LOW preamble
  const HIGH80 = us(80);  // 80 µs HIGH preamble
  const LOW50  = us(50);  // 50 µs LOW marker before each bit
  const HIGH0  = us(26);  // 26 µs HIGH → bit '0'
  const HIGH1  = us(70);  // 70 µs HIGH → bit '1'

  let t = now + RESPONSE_START;

  // Preamble: 80 µs LOW
  simulator.schedulePinChange(pin, false, t);
  t += LOW80;
  // Preamble: 80 µs HIGH
  simulator.schedulePinChange(pin, true, t);
  t += HIGH80;

  // 40 data bits, MSB first — schedule LOW then advance, schedule HIGH then advance
  for (const byte of payload) {
    for (let b = 7; b >= 0; b--) {
      const bit = (byte >> b) & 1;
      simulator.schedulePinChange(pin, false, t);
      t += LOW50;
      simulator.schedulePinChange(pin, true, t);
      t += bit ? HIGH1 : HIGH0;
    }
  }

  // Final release
  simulator.schedulePinChange(pin, false, t);
  t += LOW50;
  simulator.schedulePinChange(pin, true, t);
}

PartSimulationRegistry.register('dht22', {
  attachEvents: (element, simulator, getPin, componentId) => {
    // wokwi-dht22 element uses 'SDA' as the data pin name (not 'DATA')
    const pin = getPin('SDA') ?? getPin('DATA');
    if (pin === null) return () => {};

    // Ask the simulator if it handles sensor protocols natively (e.g. ESP32
    // delegates to backend QEMU).  If so, we only forward property updates.
    const el = element as any;
    const temperature = el.temperature ?? 25.0;
    const humidity = el.humidity ?? 50.0;

    const handledNatively = typeof (simulator as any).registerSensor === 'function'
      && (simulator as any).registerSensor('dht22', pin, { temperature, humidity });

    if (handledNatively) {
      registerSensorUpdate(componentId, (values) => {
        if ('temperature' in values) el.temperature = values.temperature as number;
        if ('humidity'    in values) el.humidity    = values.humidity    as number;
        (simulator as any).updateSensor(pin, {
          temperature: el.temperature ?? 25.0,
          humidity: el.humidity ?? 50.0,
        });
      });

      return () => {
        (simulator as any).unregisterSensor(pin);
        unregisterSensorUpdate(componentId);
      };
    }

    let wasLow = false;
    // Prevent DHT22's own scheduled pin changes from re-triggering the response.
    // After the MCU releases DATA HIGH and we begin responding, we ignore all
    // pin-change callbacks until the full waveform has been emitted.
    // DHT22 response is ~5 ms; gate for ~12.5 ms scaled to the CPU clock.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clockHz: number = typeof (simulator as any).getClockHz === 'function'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? (simulator as any).getClockHz()
        : 16_000_000;
    const RESPONSE_GATE_CYCLES = Math.round(12_500 * clockHz / 1_000_000);
    let responseEndCycle = 0;
    let responseEndTimeMs = 0; // time-based fallback for ESP32 (no cycle counter)

    const getCycles = (): number =>
      typeof (simulator as any).getCurrentCycles === 'function'
        ? ((simulator as any).getCurrentCycles() as number)
        : -1;

    const unsub = (simulator as any).pinManager.onPinChange(
      pin,
      (_: number, state: boolean) => {
        // While DHT22 is driving the line, ignore our own scheduled changes.
        const now = getCycles();
        if (now >= 0 && now < responseEndCycle) return;
        // Time-based fallback for ESP32 (no cycle counter available)
        if (now < 0 && Date.now() < responseEndTimeMs) return;

        if (!state) {
          // MCU drove DATA LOW — start signal detected
          wasLow = true;
          return;
        }
        if (wasLow) {
          // MCU released DATA HIGH — begin DHT22 response
          wasLow = false;
          const cur = getCycles();
          responseEndCycle = cur >= 0 ? cur + RESPONSE_GATE_CYCLES : 0;
          responseEndTimeMs = Date.now() + 20; // 20ms gate for non-cycle simulators
          scheduleDHT22Response(simulator, pin, element);
        }
      },
    );

    // Idle state: DATA HIGH (pulled up)
    simulator.setPinState(pin, true);

    // SensorControlPanel: update temperature / humidity on the element
    registerSensorUpdate(componentId, (values) => {
      const el = element as any;
      if ('temperature' in values) el.temperature = values.temperature as number;
      if ('humidity'    in values) el.humidity    = values.humidity    as number;
    });

    return () => {
      unsub();
      simulator.setPinState(pin, true);
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
    const pinSCK  = getPin('SCK');
    const pinDOUT = getPin('DOUT');
    if (pinSCK === null || pinDOUT === null) return () => {};

    let rawValue = rawFromWeight(element);
    let bitCount = 0;
    let finishing = false;

    function rawFromWeight(el: HTMLElement): number {
      const w = (el as any).weight ?? 100;           // grams
      const raw = Math.round(w * 1000);              // 24-bit fixed-point
      return Math.max(-8_388_608, Math.min(8_388_607, raw)) & 0xFF_FFFF;
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
            bitCount  = 0;
            rawValue  = rawFromWeight(element);
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

// ─── IR Receiver ─────────────────────────────────────────────────────────────

/**
 * IR receiver (e.g. VS1838B) — responds to clicks by generating an NEC
 * protocol pulse train on the DATA/OUT pin (active-low: LOW = IR burst).
 *
 * NEC frame on the demodulated output:
 *   9 ms LOW  + 4.5 ms HIGH  (preamble)
 *   8-bit address (MSB first) + 8-bit ~address
 *   8-bit command (MSB first) + 8-bit ~command
 *   Final 562 µs LOW  ("end burst")
 *
 * Default: address 0x00, command 0x45 (NEC remote "POWER" button equivalent).
 * Change by setting `element.irAddress` and `element.irCommand`.
 *
 * TIMING: Each ms-level delay is implemented via setTimeout. This chains
 * ~70 callbacks (35 bits × 2 edges each). Because the simulation runs in
 * requestAnimationFrame batches (~16 ms), the timing will be stretched but
 * the logical transitions are correct for polling-based IR decoders.
 */

function necBitSequence(address: number, command: number): number[] {
  /* Returns interleaved [duration_ms, level, ...] pairs for NEC frame.
     level: 1 = LINE HIGH (no IR / space), 0 = LINE LOW (IR burst / mark) */
  const frames: number[] = [];

  function push(duration: number, level: number) {
    frames.push(duration, level);
  }

  // Preamble
  push(9,   0);   // 9 ms mark
  push(4.5, 1);   // 4.5 ms space

  // Build 32 bits: addr, ~addr, cmd, ~cmd
  const bytes = [
    address & 0xFF,
    (~address) & 0xFF,
    command  & 0xFF,
    (~command) & 0xFF,
  ];
  for (const byte of bytes) {
    for (let b = 0; b < 8; b++) {   // LSB first for NEC
      const bit = (byte >> b) & 1;
      push(0.562, 0);               // 562 µs mark (same for 0 and 1)
      push(bit ? 1.687 : 0.562, 1); // space: 1687 µs=1, 562 µs=0
    }
  }

  // Final burst
  push(0.562, 0);

  return frames;
}

function driveNECSequence(
  simulator: any,
  pin: number,
  address: number,
  command: number,
): void {
  const frames = necBitSequence(address, command);
  let i = 0;

  function next(): void {
    if (i >= frames.length) {
      simulator.setPinState(pin, true); // idle HIGH
      return;
    }
    const duration = frames[i++];
    const level    = frames[i++];
    simulator.setPinState(pin, level === 1); // active-low: LOW=burst, HIGH=space
    setTimeout(next, duration);
  }

  next();
}

PartSimulationRegistry.register('ir-receiver', {
  attachEvents: (element, simulator, getPin) => {
    const pin = getPin('OUT') ?? getPin('DATA');
    if (pin === null) return () => {};

    // Idle: pin HIGH (no IR)
    simulator.setPinState(pin, true);

    const onClick = () => {
      const el      = element as any;
      const address = (el.irAddress ?? 0x00) & 0xFF;
      const command = (el.irCommand  ?? 0x45) & 0xFF;
      driveNECSequence(simulator, pin, address, command);
    };

    element.addEventListener('click', onClick);
    return () => {
      element.removeEventListener('click', onClick);
      simulator.setPinState(pin, true);
    };
  },
});

// ─── IR Remote ───────────────────────────────────────────────────────────────

/**
 * IR remote control — each button click:
 *  1. Fires an `ir-signal` CustomEvent on the element with {address, command}
 *  2. Drives the IR output pin (if connected) with the NEC pulse sequence
 *
 * Button → command mapping (NEC standard SHARP-style remote):
 *   0–9 → commands 0x16, 0x0C, 0x18, 0x5E, 0x08, 0x1C, 0x5A, 0x42, 0x52, 0x4A
 *   VOL+→0x40, VOL-→0x00, CH+→0x48, CH-→0x0D, POWER→0x45, MUTE→0x09
 *
 * The element should dispatch `button-press` events with `detail.key` naming
 * the button (matches typical wokwi IR remote element events). We listen for
 * both 'button-press' from the element model and 'click' as fallback.
 */
const IR_REMOTE_COMMANDS: Record<string, number> = {
  '0': 0x16, '1': 0x0C, '2': 0x18, '3': 0x5E, '4': 0x08,
  '5': 0x1C, '6': 0x5A, '7': 0x42, '8': 0x52, '9': 0x4A,
  'vol+': 0x40, 'vol-': 0x00, 'ch+': 0x48, 'ch-': 0x0D,
  'power': 0x45, 'mute': 0x09,
  'ok': 0x1B, 'up': 0x46, 'down': 0x15, 'left': 0x44, 'right': 0x43,
};

PartSimulationRegistry.register('ir-remote', {
  attachEvents: (element, simulator, getPin) => {
    const pin = getPin('IR') ?? getPin('OUT');

    // Idle HIGH if pin connected
    if (pin !== null) simulator.setPinState(pin, true);

    const el = element as any;
    const address = (el.irAddress ?? 0x00) & 0xFF;

    const onButtonPress = (e: Event) => {
      const key     = ((e as CustomEvent).detail?.key ?? '').toLowerCase();
      const command = (IR_REMOTE_COMMANDS[key] ?? 0x45) & 0xFF;
      element.dispatchEvent(new CustomEvent('ir-signal', {
        bubbles: true,
        detail: { address, command, key },
      }));
      if (pin !== null) driveNECSequence(simulator, pin, address, command);
    };

    const onClick = () => {
      // Fallback for plain click — send POWER code
      const command = 0x45;
      element.dispatchEvent(new CustomEvent('ir-signal', {
        bubbles: true,
        detail: { address, command, key: 'power' },
      }));
      if (pin !== null) driveNECSequence(simulator, pin, address, command);
    };

    element.addEventListener('button-press', onButtonPress);
    element.addEventListener('click', onClick);

    return () => {
      element.removeEventListener('button-press', onButtonPress);
      element.removeEventListener('click', onClick);
      if (pin !== null) simulator.setPinState(pin, true);
    };
  },
});

// ─── MicroSD Card ─────────────────────────────────────────────────────────────

/**
 * MicroSD card — SPI mode initialization handshake simulator.
 *
 * Hooks into the AVR's hardware SPI peripheral (simulator.spi.onTransmit).
 * Implements the SD card v2 / SDHC initialization sequence:
 *
 *   CMD0  (0x40) → R1 = 0x01  (idle)
 *   CMD8  (0x48) → R7 = 0x01, 0x00, 0x00, 0x01, 0xAA
 *   CMD55 (0x77) → R1 = 0x01  (prefix for ACMD)
 *   ACMD41 (0x69) → R1 = 0x00  (ready — skip lengthy poll loop)
 *   CMD58 (0x7A) → R3 = 0x00, 0x40, 0x00, 0x00, 0x00  (SDHC power-up OCR)
 *   CMD17 (0x51) → R1 = 0x00 + data token 0xFE + 512 bytes 0xFF + CRC
 *   CMD24 (0x58) → R1 = 0x00 + data response 0x05 (accepted)
 *
 * 0xFF bytes act as idle / clock-only bytes; the response queue is drained
 * one byte per SPI transfer.
 *
 * NOTE: This hooks into AVR SPI only (simulator.spi). RP2040 SPI integration
 * follows the same pattern but uses simulator.rp2040.spi[0].onTransmit.
 */
PartSimulationRegistry.register('microsd-card', {
  attachEvents: (_element, simulator, _getPin) => {
    const spi = (simulator as any).spi;
    if (!spi) return () => {};

    const respQueue: number[] = [];
    let   cmdBuf: number[]    = [];
    let   expectingAcmd       = false;

    /** Resolve GPIO CS if wired — not strictly required since Arduino drives CS via GPIO */
    function enqueueR1(r1: number): void { respQueue.push(r1); }
    function enqueueR7(r1: number, v32: number): void {
      respQueue.push(r1,
        (v32 >> 24) & 0xFF, (v32 >> 16) & 0xFF,
        (v32 >>  8) & 0xFF,  v32        & 0xFF,
      );
    }

    function processCmd(raw: number[]): void {
      if (raw.length < 6) return;
      const cmdIndex = raw[0] & 0x3F;
      const isAcmd   = expectingAcmd;
      expectingAcmd  = false;

      if (isAcmd) {
        // ACMD41: send init — respond ready
        if (cmdIndex === 41) { enqueueR1(0x00); return; }
      }

      switch (cmdIndex) {
        case 0:  enqueueR1(0x01); break;
        case 8:  enqueueR7(0x01, 0x000001AA); break;
        case 55: enqueueR1(0x01); expectingAcmd = true; break;
        case 58: enqueueR7(0x00, 0x40000000); break;  // SDHC OCR
        case 17: // CMD17: read single block
          respQueue.push(0x00);          // R1 ok
          respQueue.push(0xFE);          // data token
          for (let i = 0; i < 512; i++) respQueue.push(0xFF); // empty block
          respQueue.push(0xFF, 0xFF);    // CRC (ignored)
          break;
        case 24: // CMD24: write single block
          respQueue.push(0x00, 0x05);    // R1 ok, data response accepted
          break;
        default:
          enqueueR1(0x00);               // respond OK for unhandled commands
      }
    }

    const prevOnTransmit = spi.onTransmit as ((b: number) => void) | null | undefined;

    spi.onTransmit = (byte: number) => {
      if ((byte & 0x40) && cmdBuf.length === 0) {
        // New command — start accumulation
        cmdBuf = [byte];
      } else if (cmdBuf.length > 0 && cmdBuf.length < 6) {
        cmdBuf.push(byte);
        if (cmdBuf.length === 6) {
          processCmd(cmdBuf);
          cmdBuf = [];
        }
      }

      // Drain response queue; idle reply is 0xFF
      const reply = respQueue.length > 0 ? respQueue.shift()! : 0xFF;
      spi.completeTransmit(reply);
    };

    return () => {
      spi.onTransmit = prevOnTransmit ?? null;
      respQueue.length = 0;
      cmdBuf = [];
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
    const sim  = simulator as any;
    const el   = element as any;
    const addr = (el.address === '0x77' || el.address === 0x77) ? 0x77 : 0x76;

    if (typeof sim.addI2CDevice === 'function') {
      // ── AVR / RP2040 path ──────────────────────────────────────────────────
      const dev = new VirtualBMP280(addr);

      if (el.temperature !== undefined) dev.temperatureC = parseFloat(el.temperature);
      if (el.pressure    !== undefined) dev.pressureHPa  = parseFloat(el.pressure);

      sim.addI2CDevice(dev);

      registerSensorUpdate(componentId, (values) => {
        if ('temperature' in values) dev.temperatureC = values.temperature as number;
        if ('pressure'    in values) dev.pressureHPa  = values.pressure    as number;
      });

      return () => {
        removeI2CDevice(sim, dev.address);
        unregisterSensorUpdate(componentId);
      };

    } else if (typeof sim.registerSensor === 'function') {
      // ── ESP32 path: delegate to backend QEMU BMP280 slave ─────────────────
      const virtualPin = 200 + addr;
      const initTemp     = el.temperature !== undefined ? parseFloat(el.temperature) : 25.0;
      const initPressure = el.pressure    !== undefined ? parseFloat(el.pressure)    : 1013.25;
      sim.registerSensor('bmp280', virtualPin, { addr, temperature: initTemp, pressure: initPressure });

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
    const el  = element as any;

    if (typeof sim.addI2CDevice === 'function') {
      // ── AVR / RP2040 path ──────────────────────────────────────────────────
      const dev = new VirtualDS3231();
      if (el.temperature !== undefined) dev.temperatureC = parseFloat(el.temperature);
      sim.addI2CDevice(dev);
      return () => removeI2CDevice(sim, dev.address);

    } else if (typeof sim.registerSensor === 'function') {
      // ── ESP32 path: delegate to backend QEMU DS3231 slave ─────────────────
      const virtualPin = 200 + 0x68;
      const initTemp   = el.temperature !== undefined ? parseFloat(el.temperature) : 25.0;
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
    const el  = element as any;

    // Parse address from element property (accepts '0x27', '39', or numeric)
    let addr = 0x27;
    if (el.i2cAddress !== undefined) {
      const raw    = String(el.i2cAddress).trim();
      const parsed = raw.startsWith('0x') || raw.startsWith('0X')
        ? parseInt(raw, 16)
        : parseInt(raw, 10);
      if (!isNaN(parsed)) addr = parsed;
    }

    if (typeof sim.addI2CDevice === 'function') {
      // ── AVR / RP2040 path ──────────────────────────────────────────────────
      const dev = new VirtualPCF8574(addr);
      if (el.portState !== undefined) dev.portState = Number(el.portState) & 0xFF;
      dev.onWrite = (value: number) => { el.value = value; };
      sim.addI2CDevice(dev);
      return () => removeI2CDevice(sim, dev.address);

    } else if (typeof sim.registerSensor === 'function') {
      // ── ESP32 path: relay I2C writes via backend ───────────────────────────
      const virtualPin = 200 + addr;
      const dev = new VirtualPCF8574(addr);
      if (el.portState !== undefined) dev.portState = Number(el.portState) & 0xFF;
      dev.onWrite = (value: number) => { el.value = value; };
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
