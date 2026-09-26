/**
 * I2C Bus Manager: the I2C controller port of the engines whose master is an
 * avr8js AVRTWI or an rp2040js RPI2C (project board-buses-2026-09, F5).
 *
 * One manager per hardware controller, created with the simulator and kept
 * across every rebuild of the SoC (`attachMaster` re-points it at the new
 * peripheral), so the fabric's transaction handler installed once keeps
 * hearing the controller after a reset, a Stop/Run or a firmware reload.
 * Every START, byte and STOP the controller puts on the wire reaches that
 * handler exactly once, and what the handler answers (the ACK of an address
 * or a byte, the byte a target drives) is what the peripheral completes with.
 *
 * Everything that answers lives on the bus fabric (simulation/buses): a chip
 * is on this controller's bus because its SDA and SCL are on the nets the
 * controller is routed to, on this board or wired over from another one. The
 * manager holds no devices of its own any more: the device map that parts
 * used to register in by address (`addI2CDevice`), and the bridge graph that
 * forwarded an unknown address to a peer board's map, went with the last part
 * that used them (F5 third part). The `I2CDevice` shape below stays as the
 * register-file model the parts keep, adapted to the fabric by
 * parts/i2cPart.ts.
 */

import type { AVRTWI, TWIEventHandler } from 'avr8js';
import type { I2cControllerPort, I2cRouting, I2cTransactionHandler } from './buses/types';

// ── Virtual I2C device interface ────────────────────────────────────────────

export interface I2CDevice {
  /** 7-bit I2C address (e.g. 0x27 for PCF8574 LCD backpack, 0x3C for SSD1306) */
  address: number;
  /** Called when master sends a byte after addressing this device for write */
  writeByte(value: number): boolean; // return true for ACK
  /** Called when master requests a byte from this device (read mode) */
  readByte(): number;
  /** Optional: called on STOP condition */
  stop?(): void;
  /**
   * Optional snapshot of the device's 256-byte register state. A host that
   * answers a guest from a copy of the part (the Raspberry Pi relay) uses it
   * instead of a round trip per byte. Devices that don't have a register map
   * (write-only sinks, time-based responders) can omit this.
   */
  dumpRegisters?(): Uint8Array;
}

/**
 * Minimal contract the I2C bus needs from the MCU peripheral that is
 * driving it as master.  Both avr8js AVRTWI and rp2040js RPI2C
 * implement this shape verbatim.
 */
export interface I2CMaster {
  completeStart(): void;
  completeStop(): void;
  completeConnect(ack: boolean): void;
  completeWrite(ack: boolean): void;
  completeRead(value: number): void;
}

/** Who this manager is as a controller port of the fabric. */
export interface I2CControllerOptions {
  /** The SoC's index for the controller (the pin function table's unit). Default 0. */
  unit?: number;
  /** Datasheet name, for diagnostics. Default `I2C<unit>`. */
  name?: string;
  /**
   * Where the controller's SDA and SCL are right now (funcsel on the RP2040
   * family), or 'static' when the board table fixes them (the ATmega TWI).
   * Default 'static'.
   */
  routing?: () => I2cRouting | 'static';
}

// ── I2C Bus Manager (implements TWIEventHandler for avr8js) ────────────────

export class I2CBusManager implements TWIEventHandler, I2cControllerPort {
  readonly bus = 'i2c' as const;
  readonly unit: number;
  readonly name: string;

  private master: I2CMaster;
  private readonly route: () => I2cRouting | 'static';
  /** The fabric's side of the wire, installed by the board's fabric. */
  private handler: I2cTransactionHandler | null = null;
  private routingChangeHandler: (() => void) | null = null;
  /** The fabric ACKed the current address phase: its bytes go through it. */
  private fabricActive = false;
  /** The fabric heard a START since the last STOP, so it is owed that STOP. */
  private fabricOpen = false;

  /**
   * Construct a bus bound to an `I2CMaster`.  For backward
   * compatibility, if the master has a settable `eventHandler`
   * property (the AVRTWI shape), it is wired to `this` automatically
   * so existing AVRSimulator code continues to work unchanged.  For
   * peripherals with per-callback wiring (RPI2C), the caller is
   * responsible for routing each master event into the bus's methods.
   */
  constructor(master: I2CMaster, controller: I2CControllerOptions = {}) {
    this.master = master;
    this.unit = controller.unit ?? 0;
    this.name = controller.name ?? `I2C${this.unit}`;
    this.route = controller.routing ?? (() => 'static');
    this.bindEventHandler(master);
  }

  private bindEventHandler(master: I2CMaster): void {
    if (
      master !== null &&
      typeof master === 'object' &&
      'eventHandler' in (master as object)
    ) {
      try {
        (master as { eventHandler: TWIEventHandler }).eventHandler = this;
      } catch {
        /* setter rejected — caller will wire events manually */
      }
    }
  }

  /**
   * Swap the master peripheral this bus drives.  Used when the
   * I2CBusManager is constructed early (so the fabric can bind the port
   * before firmware loads) and the real MCU peripheral becomes available
   * later (e.g. after loadHex).
   *
   * A new master is a new SoC: whatever transaction the old one had open
   * went with it, so nothing of it is carried into the next START.
   */
  attachMaster(master: I2CMaster): void {
    this.master = master;
    this.fabricActive = false;
    this.fabricOpen = false;
    this.bindEventHandler(master);
  }

  /** Backward-compat accessor for the underlying AVRTWI, when constructed from one. */
  get twi(): AVRTWI {
    return this.master as AVRTWI;
  }

  // ── Controller port (bus fabric) ────────────────────────────────────────

  setTransactionHandler(handler: I2cTransactionHandler | null): void {
    // A handler installed mid-transaction never saw its START: it owes
    // nothing to the next STOP and gets no bytes until the next address phase.
    this.handler = handler;
    this.fabricActive = false;
    this.fabricOpen = false;
  }

  routing(): I2cRouting | 'static' {
    return this.route();
  }

  setRoutingChangeHandler(handler: (() => void) | null): void {
    this.routingChangeHandler = handler;
  }

  /** The simulator saw the controller move to other pads (a funcsel write). */
  routingChanged(): void {
    this.routingChangeHandler?.();
  }

  // ── TWIEventHandler implementation (master-side events from the local MCU) ──

  start(_repeated: boolean): void {
    this.master.completeStart();
  }

  stop(): void {
    // Everything is settled before completeStop: an RP2040 starts its next
    // queued transaction from inside that call.
    const owed = this.fabricOpen ? this.handler : null;
    this.fabricOpen = false;
    this.fabricActive = false;
    owed?.stop();
    this.master.completeStop();
  }

  connectToSlave(addr: number, write: boolean): void {
    // The address phase reaches the fabric's targets; its ACK is the whole
    // answer, a NACK when no target on this controller's bus has the address.
    const h = this.handler;
    this.fabricActive = false;
    if (h) {
      this.fabricOpen = true;
      this.fabricActive = h.start(addr, !write);
    }
    this.master.completeConnect(this.fabricActive);
  }

  writeByte(value: number): void {
    const ack = this.fabricActive && this.handler ? this.handler.write(value) : false;
    this.master.completeWrite(ack);
  }

  readByte(_ack: boolean): void {
    // Open-drain: with nobody addressed the line reads the pull-up.
    const value = this.fabricActive && this.handler ? this.handler.read() : 0xff;
    this.master.completeRead(value & 0xff);
  }
}

/**
 * A no-op `I2CMaster` used as a placeholder before the real MCU
 * peripheral has been constructed.  Lets `I2CBusManager` be created
 * up-front so the fabric can bind the port before firmware loads, then
 * swapped to the real peripheral via `attachMaster()`.
 */
export function nullI2CMaster(): I2CMaster {
  return {
    completeStart() {},
    completeStop() {},
    completeConnect(_ack: boolean) {},
    completeWrite(_ack: boolean) {},
    completeRead(_value: number) {},
  };
}

/**
 * Wire a non-AVR I2C master (e.g. rp2040js RPI2C) into an
 * `I2CBusManager`.  Returns the bus, with the master peripheral's
 * `onStart` / `onConnect` / `onWriteByte` / `onReadByte` / `onStop`
 * callbacks routed to `bus.start` etc.  Matches the per-callback
 * pattern RPI2C uses (it does not have a single `eventHandler`).
 */
export function wireRpI2cToBus(
  master: I2CMaster & {
    onStart?: () => void;
    onConnect?: (address: number, mode?: number) => void;
    onWriteByte?: (value: number) => void;
    onReadByte?: (ack?: boolean) => void;
    onStop?: () => void;
  },
  bus: I2CBusManager,
): void {
  master.onStart = () => bus.start(false);
  master.onConnect = (addr: number, mode?: number) =>
    bus.connectToSlave(addr, mode === undefined ? true : mode === 0);
  master.onWriteByte = (v: number) => bus.writeByte(v);
  master.onReadByte = (ack?: boolean) => bus.readByte(ack ?? true);
  master.onStop = () => bus.stop();
}

// ── Built-in virtual I2C devices ───────────────────────────────────────────

/**
 * Generic I2C memory / register device.
 * Emulates a device with 256 byte registers.
 * First write byte = register address, subsequent bytes = data.
 * Reads return register contents sequentially.
 *
 * Used to test I2C communication without a specific device implementation.
 */
export class I2CMemoryDevice implements I2CDevice {
  public registers = new Uint8Array(256);
  private regPointer = 0;
  private firstByte = true;

  /** Callback fired whenever a register is written */
  public onRegisterWrite: ((reg: number, value: number) => void) | null = null;

  constructor(public address: number) {}

  writeByte(value: number): boolean {
    if (this.firstByte) {
      this.regPointer = value;
      this.firstByte = false;
    } else {
      this.registers[this.regPointer] = value;
      if (this.onRegisterWrite) {
        this.onRegisterWrite(this.regPointer, value);
      }
      this.regPointer = (this.regPointer + 1) & 0xff;
    }
    return true; // ACK
  }

  readByte(): number {
    const value = this.registers[this.regPointer];
    this.regPointer = (this.regPointer + 1) & 0xff;
    return value;
  }

  stop(): void {
    this.firstByte = true;
  }

  /** Return the full 256-byte register snapshot for a host that answers from a copy. */
  dumpRegisters(): Uint8Array {
    return new Uint8Array(this.registers);
  }
}

/**
 * Virtual DS1307 RTC — returns system time via I2C (address 0x68).
 * Supports Wire.requestFrom(0x68, 7) to read seconds..year in BCD.
 */
export class VirtualDS1307 implements I2CDevice {
  public address = 0x68;
  private regPointer = 0;
  private firstByte = true;

  private toBCD(n: number): number {
    return ((Math.floor(n / 10) & 0xf) << 4) | ((n % 10) & 0xf);
  }

  /** Snapshot of the 7-byte time + 1-byte control register set. */
  dumpRegisters(): Uint8Array {
    const buf = new Uint8Array(256);
    const now = new Date();
    buf[0] = this.toBCD(now.getSeconds());
    buf[1] = this.toBCD(now.getMinutes());
    buf[2] = this.toBCD(now.getHours());
    buf[3] = this.toBCD(now.getDay() + 1);
    buf[4] = this.toBCD(now.getDate());
    buf[5] = this.toBCD(now.getMonth() + 1);
    buf[6] = this.toBCD(now.getFullYear() % 100);
    return buf;
  }

  writeByte(value: number): boolean {
    if (this.firstByte) {
      this.regPointer = value;
      this.firstByte = false;
    }
    return true;
  }

  readByte(): number {
    const now = new Date();
    let val = 0;
    switch (this.regPointer) {
      case 0:
        val = this.toBCD(now.getSeconds());
        break; // seconds
      case 1:
        val = this.toBCD(now.getMinutes());
        break; // minutes
      case 2:
        val = this.toBCD(now.getHours());
        break; // hours (24h)
      case 3:
        val = this.toBCD(now.getDay() + 1);
        break; // day of week (1=Sun)
      case 4:
        val = this.toBCD(now.getDate());
        break; // date
      case 5:
        val = this.toBCD(now.getMonth() + 1);
        break; // month
      case 6:
        val = this.toBCD(now.getFullYear() % 100);
        break; // year
      default:
        val = 0;
    }
    this.regPointer = (this.regPointer + 1) & 0x3f;
    return val;
  }

  stop(): void {
    this.firstByte = true;
  }
}

/**
 * Virtual temperature / humidity sensor (address 0x48).
 * Returns fixed temperature (configurable) and humidity.
 */
export class VirtualTempSensor implements I2CDevice {
  public address = 0x48;
  private regPointer = 0;
  private firstByte = true;

  /** Temperature in degrees C * 100 (e.g. 2350 = 23.50 C) */
  public temperature = 2350;
  /** Humidity in % * 100 */
  public humidity = 5500;

  writeByte(value: number): boolean {
    if (this.firstByte) {
      this.regPointer = value;
      this.firstByte = false;
    }
    return true;
  }

  readByte(): number {
    let val = 0;
    // Register 0: temp high byte, 1: temp low byte, 2: humidity high, 3: humidity low
    switch (this.regPointer) {
      case 0:
        val = (this.temperature >> 8) & 0xff;
        break;
      case 1:
        val = this.temperature & 0xff;
        break;
      case 2:
        val = (this.humidity >> 8) & 0xff;
        break;
      case 3:
        val = this.humidity & 0xff;
        break;
      default:
        val = 0xff;
    }
    this.regPointer = (this.regPointer + 1) & 0xff;
    return val;
  }

  stop(): void {
    this.firstByte = true;
  }
}

/**
 * Virtual BMP280 barometric pressure / temperature sensor.
 *
 * Supports I2C addresses 0x76 (SDO=0) or 0x77 (SDO=1).
 *
 * Register map (subset):
 *   0x88–0x9F  Calibration data (trimming parameters)
 *   0xD0       chip_id  = 0x58  (BMP280 production; BME280 = 0x60)
 *   0xF3       status   = 0x00 (measurement complete, no NVM copy)
 *   0xF4       ctrl_meas (mode, osrs_t, osrs_p) — writable
 *   0xF5       config    — writable
 *   0xF7–0xF9  press_msb / press_lsb / press_xlsb  (20-bit ADC)
 *   0xFA–0xFC  temp_msb  / temp_lsb  / temp_xlsb   (20-bit ADC)
 *
 * The calibration parameters are the BMP280 datasheet example values (Section 8.2).
 * They produce T ≈ 25°C, P ≈ 1006 hPa from the corresponding raw ADC values.
 *
 * Setting `temperature` (°C) and `pressure` (hPa) properties recomputes raw ADC
 * registers using a binary search over the Bosch compensation formulas so that
 * Arduino sketches using the Adafruit_BMP280 / Bosch driver get realistic values.
 */
export class VirtualBMP280 implements I2CDevice {
  public address: number;

  private readonly registers = new Uint8Array(256);
  private regPtr = 0;
  private firstByte = true;

  // ── BMP280 datasheet Section 8.2 example calibration ───────────────────
  private readonly DIG_T1 = 27504;
  private readonly DIG_T2 = 26435;
  private readonly DIG_T3 = -1000;
  private readonly DIG_P1 = 36477;
  private readonly DIG_P2 = -10685;
  private readonly DIG_P3 = 3024;
  private readonly DIG_P4 = 2855;
  private readonly DIG_P5 = 140;
  private readonly DIG_P6 = -7;
  private readonly DIG_P7 = 15500;
  private readonly DIG_P8 = -14600;
  private readonly DIG_P9 = 6000;

  private _temperatureC = 25.0;
  private _pressureHPa = 1013.25;

  constructor(address = 0x76) {
    this.address = address;
    this.initCalibration();
    this.updateMeasurements();
  }

  // ── Public configurable properties ──────────────────────────────────────

  get temperatureC(): number {
    return this._temperatureC;
  }
  set temperatureC(v: number) {
    this._temperatureC = v;
    this.updateMeasurements();
  }

  get pressureHPa(): number {
    return this._pressureHPa;
  }
  set pressureHPa(v: number) {
    this._pressureHPa = v;
    this.updateMeasurements();
  }

  // ── I2CDevice interface ─────────────────────────────────────────────────

  writeByte(value: number): boolean {
    if (this.firstByte) {
      this.regPtr = value;
      this.firstByte = false;
    } else {
      // Writable registers (ctrl_meas, config) — store them
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

  /** Snapshot the full 256-byte register file (calibration + ADC results). */
  dumpRegisters(): Uint8Array {
    return new Uint8Array(this.registers);
  }

  // ── Compensation formulas (Bosch 32-bit integer + double precision) ────

  /** Compute t_fine from a 20-bit raw temperature ADC value. */
  private tFine(adcT: number): number {
    const var1 = (((adcT >> 3) - (this.DIG_T1 << 1)) * this.DIG_T2) >> 11;
    const sub = (adcT >> 4) - this.DIG_T1;
    const var2 = (((sub * sub) >> 12) * this.DIG_T3) >> 14;
    return var1 + var2;
  }

  /** Compute temperature in 0.01 °C from a 20-bit raw ADC value. */
  private compensateT(adcT: number): number {
    return (this.tFine(adcT) * 5 + 128) >> 8;
  }

  /**
   * Compute pressure in Pa (double precision) from raw ADC values.
   * Uses the Bosch floating-point compensation formula.
   */
  private compensateP(adcP: number, adcT: number): number {
    const tf = this.tFine(adcT);
    let var1 = tf / 2.0 - 64000.0;
    let var2 = (var1 * var1 * this.DIG_P6) / 32768.0;
    var2 = var2 + var1 * this.DIG_P5 * 2.0;
    var2 = var2 / 4.0 + this.DIG_P4 * 65536.0;
    var1 = ((this.DIG_P3 * var1 * var1) / 524288.0 + this.DIG_P2 * var1) / 524288.0;
    var1 = (1.0 + var1 / 32768.0) * this.DIG_P1;
    if (var1 === 0) return 0;
    let p = 1048576.0 - adcP;
    p = ((p - var2 / 4096.0) * 6250.0) / var1;
    const v1b = (this.DIG_P9 * p * p) / 2147483648.0;
    const v2b = (p * this.DIG_P8) / 32768.0;
    return p + (v1b + v2b + this.DIG_P7) / 16.0;
  }

  /**
   * Binary-search for the 20-bit raw ADC value that produces the target
   * temperature (in 0.01 °C units after integer compensation).
   */
  private findAdcT(targetCentidegrees: number): number {
    let lo = 0,
      hi = (1 << 20) - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.compensateT(mid) < targetCentidegrees) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Binary-search for the 20-bit raw ADC value that produces the target
   * pressure (in Pa). Pressure is monotonically decreasing in adcP.
   */
  private findAdcP(targetPa: number, adcT: number): number {
    let lo = 0,
      hi = (1 << 20) - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.compensateP(mid, adcT) > targetPa) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Encode a 20-bit ADC value into three register bytes (msb, lsb, xlsb). */
  private static encodeAdc20(val: number): [number, number, number] {
    return [(val >> 12) & 0xff, (val >> 4) & 0xff, (val & 0xf) << 4];
  }

  // ── Register initialisation ─────────────────────────────────────────────

  private initCalibration(): void {
    const r = this.registers;
    const wu16 = (a: number, v: number) => {
      r[a] = v & 0xff;
      r[a + 1] = (v >> 8) & 0xff;
    };
    const ws16 = (a: number, v: number) => wu16(a, v & 0xffff);

    r[0xd0] = 0x58; // chip_id BMP280 (production silicon; BME280 uses 0x60)
    r[0xf3] = 0x00; // status  (measurement done)
    r[0xf4] = 0x00; // ctrl_meas default
    r[0xf5] = 0x00; // config default

    wu16(0x88, this.DIG_T1);
    ws16(0x8a, this.DIG_T2);
    ws16(0x8c, this.DIG_T3);
    wu16(0x8e, this.DIG_P1);
    ws16(0x90, this.DIG_P2);
    ws16(0x92, this.DIG_P3);
    ws16(0x94, this.DIG_P4);
    ws16(0x96, this.DIG_P5);
    ws16(0x98, this.DIG_P6);
    ws16(0x9a, this.DIG_P7);
    ws16(0x9c, this.DIG_P8);
    ws16(0x9e, this.DIG_P9);
  }

  /** Recompute raw ADC registers from current temperature / pressure. */
  private updateMeasurements(): void {
    const targetT = Math.round(this._temperatureC * 100);
    const targetP = this._pressureHPa * 100; // hPa → Pa

    const adcT = this.findAdcT(targetT);
    const adcP = this.findAdcP(targetP, adcT);

    const [pMsb, pLsb, pXlsb] = VirtualBMP280.encodeAdc20(adcP);
    const [tMsb, tLsb, tXlsb] = VirtualBMP280.encodeAdc20(adcT);

    this.registers[0xf7] = pMsb;
    this.registers[0xf8] = pLsb;
    this.registers[0xf9] = pXlsb;
    this.registers[0xfa] = tMsb;
    this.registers[0xfb] = tLsb;
    this.registers[0xfc] = tXlsb;
  }
}

/**
 * Virtual DS3231 real-time clock with on-chip temperature sensor.
 *
 * Address: 0x68 (fixed — same package as DS1307, one or the other per bus).
 *
 * Register map (subset):
 *   0x00  Seconds  (BCD, 0–59)
 *   0x01  Minutes  (BCD, 0–59)
 *   0x02  Hours    (BCD, 0–23, 24-hour mode)
 *   0x03  Day      (BCD, 1–7, 1=Sunday)
 *   0x04  Date     (BCD, 1–31)
 *   0x05  Month    (BCD, 1–12)
 *   0x06  Year     (BCD, 0–99)
 *   0x0E  Control  (writable)
 *   0x0F  Status   = 0x00 (OSF cleared, no alarms)
 *   0x11  Temp MSB = integer degrees C (signed)
 *   0x12  Temp LSB = fractional in bits 7:6 (0.25°C steps)
 *
 * Time is taken from the host browser clock.
 * Temperature defaults to 25°C and is configurable via `temperatureC`.
 */
export class VirtualDS3231 implements I2CDevice {
  public readonly address = 0x68;

  public temperatureC = 25.0;

  private regPtr = 0;
  private firstByte = true;

  private toBCD(n: number): number {
    return ((Math.floor(n / 10) & 0xf) << 4) | ((n % 10) & 0xf);
  }

  private readRegister(reg: number): number {
    const now = new Date();
    switch (reg) {
      case 0x00:
        return this.toBCD(now.getSeconds());
      case 0x01:
        return this.toBCD(now.getMinutes());
      case 0x02:
        return this.toBCD(now.getHours());
      case 0x03:
        return this.toBCD(now.getDay() + 1); // 1=Sunday
      case 0x04:
        return this.toBCD(now.getDate());
      case 0x05:
        return this.toBCD(now.getMonth() + 1);
      case 0x06:
        return this.toBCD(now.getFullYear() % 100);
      case 0x0e:
        return 0x00; // Control: oscillator enabled, no alarm outputs
      case 0x0f:
        return 0x00; // Status:  OSF=0 (no oscillator stop), alarms cleared
      case 0x11: {
        // Temperature MSB: signed integer degrees C
        const intTemp = Math.trunc(this.temperatureC);
        return intTemp & 0xff;
      }
      case 0x12: {
        // Temperature LSB: fractional in bits 7:6, 0.25°C resolution
        const frac = this.temperatureC - Math.trunc(this.temperatureC);
        const q = Math.round(frac / 0.25) & 0x03;
        return (q << 6) & 0xff;
      }
      default:
        return 0x00;
    }
  }

  writeByte(value: number): boolean {
    if (this.firstByte) {
      this.regPtr = value;
      this.firstByte = false;
    } else {
      // Accept writes to control registers (0x0E, 0x0F, alarm registers, etc.)
      // We simply ignore the written value since this is a read-only time source.
      this.regPtr = (this.regPtr + 1) & 0x1f;
    }
    return true;
  }

  readByte(): number {
    const val = this.readRegister(this.regPtr);
    this.regPtr = (this.regPtr + 1) & 0x1f;
    return val;
  }

  stop(): void {
    this.firstByte = true;
  }

  /** Snapshot the current register state (time + temperature). */
  dumpRegisters(): Uint8Array {
    const buf = new Uint8Array(256);
    for (let r = 0; r < 0x20; r++) buf[r] = this.readRegister(r);
    return buf;
  }
}

/**
 * Virtual PCF8574 8-bit I/O expander.
 *
 * The PCF8574 exposes a single 8-bit quasi-bidirectional I/O port over I2C.
 *  - Writing one byte sets the output latch (pins driven LOW for 0, HIGH/HiZ for 1).
 *  - Reading one byte returns the current pin state (output latch AND-ed with external input).
 *
 * This is the most common I2C interface for 4-bit LCD backpacks.
 *
 * Configurable address: 0x20–0x27 (PCF8574) or 0x38–0x3F (PCF8574A).
 * Default: 0x27 (all address pins HIGH, typical for LCD backpacks).
 *
 * `portState` holds the current 8-bit port value read back by the Arduino.
 * Sketch writes update `outputLatch`; reads return `portState & outputLatch` (open-drain).
 */
export class VirtualPCF8574 implements I2CDevice {
  public address: number;

  /** Current state of the 8 I/O pins as seen from the outside (external input). */
  public portState = 0xff;

  /** Output latch: bits the Arduino last wrote.  1 = released (input/Hi-Z), 0 = driven LOW. */
  public outputLatch = 0xff;

  /** Optional callback when the Arduino writes to the port (e.g. to update an LCD visual). */
  public onWrite: ((value: number) => void) | null = null;

  constructor(address = 0x27) {
    this.address = address;
  }

  writeByte(value: number): boolean {
    this.outputLatch = value;
    if (this.onWrite) this.onWrite(value);
    return true;
  }

  readByte(): number {
    // Open-drain: pin reads HIGH only when both outputLatch and portState are HIGH
    return this.portState & this.outputLatch & 0xff;
  }

  stop(): void {
    // PCF8574 is stateless (no register pointer) — explicit no-op for interface clarity
  }
}
