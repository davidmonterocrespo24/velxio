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
 * manager holds no devices of its own: a device registered here by address
 * sat on this board's first bus whatever its wires reached, one part's cleanup
 * could evict another at the same address, and a peer board's devices needed
 * a bridge graph of their own. The `I2CDevice` shape below stays as the
 * register-file model the parts keep, adapted to the fabric by
 * parts/i2cPart.ts.
 */

import type { AVRTWI, TWIEventHandler } from 'avr8js';
import type {
  GuestClock,
  I2cControllerPort,
  I2cRouting,
  I2cTransactionHandler,
} from './buses/types';

// ── Virtual I2C device interface ────────────────────────────────────────────

export interface I2CDevice {
  /** 7-bit I2C address (e.g. 0x27 for PCF8574 LCD backpack, 0x3C for SSD1306) */
  address: number;
  /** Called when master sends a byte after addressing this device for write */
  writeByte(value: number): boolean; // return true for ACK
  /** Called when master requests a byte from this device (read mode) */
  readByte(): number;
  /**
   * Optional: called on every START and repeated START that addresses the
   * device, before the first byte of that phase; `read` is the direction bit.
   * A chip that answers a burst from one sampling instant (the MPU-6050's
   * sample block) latches it here. A host that cannot tell a model where a
   * read begins does not call it, so such a model also latches on the first
   * readByte that follows a writeByte or a stop.
   */
  start?(read: boolean): void;
  /** Optional: called on STOP condition */
  stop?(): void;
  /**
   * Optional: the MCU was reset (Stop/Run, the reset button, a reload). The
   * chip kept its supply, so its registers are not touched; what belonged to
   * the run that ended is, such as a note the monitor of that run was given.
   */
  boardReset?(): void;
  /**
   * Optional: the guest's clock of the board the device is wired to, or null
   * when it is on no bus (I2cTarget.setClock). A chip that samples on its own
   * measures its periods on it. clockHz() 0 means the host keeps no time.
   */
  setClock?(clock: GuestClock | null): void;
  /**
   * Optional snapshot of the device's 256-byte register state. A host that
   * answers a guest from a copy of the part (the Raspberry Pi relay) uses it
   * instead of a round trip per byte. Devices that don't have a register map
   * (write-only sinks, time-based responders) can omit this.
   */
  dumpRegisters?(): Uint8Array;
  /**
   * Optional, with dumpRegisters: the registers a copy cannot answer for,
   * because a read changes them (a status the read clears, a FIFO or memory
   * port that hands out the next byte) or time does (a count that grows
   * while nobody looks). A host answering from a copy asks the model for
   * every read that touches one of them.
   */
  readonly volatileReads?: readonly number[];
  /**
   * Optional, with dumpRegisters: the registers the device's pointer does
   * not move past, a FIFO or memory port read and written byte after byte
   * at one address. A host answering from a copy keeps its own pointer there.
   */
  readonly pointerStays?: readonly number[];
  /**
   * Optional, with dumpRegisters: the register after which the device's
   * pointer wraps to 0x00 (0x3F on a DS1307, 0x12 on a DS3231). Absent, it
   * wraps after 0xFF. A host answering from a copy wraps its own there.
   */
  readonly pointerWrapsAfter?: number;
  /**
   * Optional: the linear memory of a compiled model (parts/wasmI2cModels.ts),
   * which holds the model's whole state (buses/models/i2c_host.h: a model
   * keeps it in its static memory). A host that runs a second copy of the
   * part from the same bytes (an engine worker next to the guest) can start
   * that copy from this one. Nothing in this tree reads it.
   */
  modelMemory?(): WebAssembly.Memory | null;
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

// ── DS1307 / DS3231 real-time clocks ─────────────────────────────────────────

/**
 * What the two clock chips do with a byte written to them, as tables. The
 * models below work from them, the tests hold them against the copies in
 * test/fixtures/i2c-vectors/ds1307.json and ds3231.json, and the backend twins
 * (esp32_i2c_slaves.DS1307Slave and DS3231Slave) follow the same facts.
 * DS1307: datasheet REV 3/15. DS3231: datasheet 19-5170 rev 10.
 */
export const DS1307_RULES = {
  /**
   * CONTROL powers on with RS1 and RS0 set ("typically set to a 1", Control
   * Register). The RAM is modelled as zeros; the datasheet leaves it open.
   *
   * CH powers on at 0: the clock runs. The datasheet has CH at 1 on a chip
   * that never had power, with the time stopped at 00:00:00 of 01/01/00, and
   * a sketch that only reads the clock would show that forever (seven
   * examples of the gallery only read it). So the part comes as a module
   * somebody set: running, and on the host's time.
   */
  power_on: { 0x07: 0x03 },
  /** The bits of each register that exist; the others always read 0 (Table 2). */
  write_mask: {
    0x00: 0xff,
    0x01: 0x7f,
    0x02: 0x7f,
    0x03: 0x07,
    0x04: 0x3f,
    0x05: 0x1f,
    0x06: 0xff,
    0x07: 0x93,
  },
  /** The address pointer wraps to 0x00 after the last byte of the RAM. */
  last_register: 0x3f,
} as const;

export const DS3231_RULES = {
  /**
   * CONTROL 0x1C: oscillator on, 8.192 kHz selected, INTCN set, both alarm
   * interrupts off. STATUS 0x08: EN32kHz set, OSF clear.
   *
   * OSF powers on at 0, as the DS1307's CH does, and for the same reason:
   * the part is a module somebody set and whose battery kept it running,
   * which is why it shows the host's time. The datasheet sets OSF "the first
   * time power is applied", and a module fresh from the bag would say
   * lostPower() on every Run: in the 2026-09 corpus about 64 projects would
   * print a "lost power" line each time and 2 would blank their clock. The
   * chip also sets OSF when its oscillator stops (VCC and VBAT both too low,
   * EOSC in battery mode), and this model has no such case: it runs from
   * VCC with its oscillator on. So OSF only ever reads 0 here.
   */
  power_on: { 0x0e: 0x1c, 0x0f: 0x08 },
  /**
   * The bits of each register a write stores as written. Bit 7 of the
   * seconds does not exist. CONV is left out of CONTROL (self_clearing), and
   * of STATUS only EN32kHz is a plain read/write bit.
   */
  write_mask: {
    0x00: 0x7f,
    0x01: 0x7f,
    0x02: 0x7f,
    0x03: 0x07,
    0x04: 0x3f,
    0x05: 0x9f,
    0x06: 0xff,
    0x07: 0xff,
    0x08: 0xff,
    0x09: 0xff,
    0x0a: 0xff,
    0x0b: 0xff,
    0x0c: 0xff,
    0x0d: 0xff,
    0x0e: 0xdf,
    0x0f: 0x08,
    0x10: 0xff,
  },
  /**
   * CONV starts a temperature conversion and is never stored: the conversion
   * takes no time here, so the next read finds CONV and BSY at 0.
   */
  self_clearing: { 0x0e: 0x20 },
  /**
   * OSF, A2F and A1F: "This bit can only be written to logic 0. Attempting
   * to write to logic 1 leaves the value unchanged."
   */
  write_zero_to_clear: { 0x0f: 0x83 },
  /** The temperature registers. */
  read_only: [[0x11, 0x12]],
  /** The address pointer wraps to 0x00 after the temperature's low byte. */
  last_register: 0x12,
  /** Quarter degrees, ten bits, two's complement: -128.00 to +127.75 C. */
  temp_lsb_per_c: 4,
} as const;

/** A date and a time of day as a calendar shows them, with no time zone. */
export interface RtcDateTime {
  year: number;
  /** 1 to 12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface RtcOptions {
  /**
   * The host's clock as the calendar on its wall reads it: milliseconds since
   * 00:00 of 1 January 1970 of that calendar, which is the epoch plus the
   * offset of the time zone. Default: the browser's clock and zone. A test
   * passes its own, so nothing it asserts depends on when it runs.
   */
  clock?: () => number;
  /**
   * The `__DATE__` and `__TIME__` of the firmware that is running, every
   * pair the image holds (simulation/firmwareBuildTime.ts). Asked when the
   * sketch sets the clock, and not before. Default: none, and then every
   * time the sketch writes is kept.
   */
  buildTimes?: () => readonly RtcDateTime[];
}

const RTC_MS_DAY = 86_400_000;

/** The browser's clock and time zone as one number; see RtcOptions.clock. */
export function hostWallClock(): number {
  const now = new Date();
  return now.getTime() - now.getTimezoneOffset() * 60_000;
}

const rtcBcd = (n: number): number => (((Math.floor(n / 10) % 10) << 4) | (n % 10)) & 0xff;
const rtcBin = (bcd: number): number => ((bcd >> 4) & 0xf) * 10 + (bcd & 0xf);

/**
 * Days since 1 January 1970 of a date, and back. Written out and not left to
 * Date, so the backend twin counts the same way to the day, a month 0 or a
 * 31 June a sketch wrote included.
 */
function rtcDaysOf(year: number, month: number, day: number): number {
  const m0 = month - 1;
  const y = year + Math.floor(m0 / 12) - (((m0 % 12) + 12) % 12 < 2 ? 1 : 0);
  const m = ((m0 % 12) + 12) % 12; // 0 = January
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 1 ? -2 : 10)) + 2) / 5);
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468 + (day - 1);
}

function rtcDateOf(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const month = mp < 10 ? mp + 3 : mp - 9;
  return {
    year: yoe + era * 400 + (month <= 2 ? 1 : 0),
    month,
    day: doy - Math.floor((153 * mp + 2) / 5) + 1,
  };
}

/**
 * The day-of-week register after `days` midnights. It counts 1 to 7 and back
 * to 1, from whatever it holds: the chip gives the numbers no meaning. A 0,
 * which is what RTClib writes to a DS1307, becomes 1 at the first midnight.
 */
function rtcWeekdayAfter(weekday: number, days: number): number {
  if (days === 0) return weekday;
  if (weekday === 0) return days < 0 ? 0 : ((days - 1) % 7) + 1;
  return ((((weekday - 1 + days) % 7) + 7) % 7) + 1;
}

/** Hours as the register holds them: bit 6 selects 12-hour mode, bit 5 is PM there. */
function rtcHourOf(register: number): number {
  if (register & 0x40) return (rtcBin(register & 0x1f) % 12) + (register & 0x20 ? 12 : 0);
  return rtcBin(register & 0x3f);
}

function rtcHourRegister(hour: number, twelveHour: boolean): number {
  if (!twelveHour) return rtcBcd(hour);
  return 0x40 | (hour >= 12 ? 0x20 : 0) | rtcBcd(hour % 12 || 12);
}

/**
 * The counters of a clock chip: seconds to year as the registers hold them,
 * and when they last moved.
 *
 * Until the sketch sets a time the counters are the host's clock, read again
 * at every START. A time the sketch writes is kept and counted from, as the
 * chip does, with one exception (project i2c-model-fidelity-2026-09, decision
 * D7): a time that is the compile time of the firmware. That is what
 * `rtc.adjust(DateTime(F(__DATE__), F(__TIME__)))` writes, the line of every
 * RTClib example, and it means "now": counted from, it would show the hour of
 * the compile server, in its time zone and as old as the build. The model
 * takes it as a clock that was set when the firmware was built and has run
 * since, which is the host's clock.
 *
 * The rule, to the second. When a write phase that wrote any of the
 * registers 0x00 to 0x02 or 0x04 to 0x06 ends, the six of them are read as a
 * date and a time (year 2000 + YY; CH, the century bit and the 12-hour bits
 * taken out). If they are one of the firmware's build times, the counters
 * follow the host's clock from then on. The day of week is not compared:
 * the strings carry none, and RTClib writes 0 there to a DS1307. It is kept
 * as written and moved on by the days between the two dates, as the midnights
 * in between would have. Anything else written is kept. So is everything a
 * firmware writes whose image holds no build time.
 */
class RtcCounters {
  /** Seconds, minutes, hours, day of week, date, month, year. */
  readonly regs = new Uint8Array(7);
  /** Host time at which the second the registers show began. */
  private tickAt = 0;
  /** The counters are the host's clock. */
  private following = true;
  /** A time register was written in the write phase that is open. */
  private written = false;
  /** The seconds the clock counted through, for the alarms: (from, to], and the weekday at `from`. */
  onCount: ((from: number, to: number, weekdayAtFrom: number) => void) | null = null;

  private readonly clock: () => number;
  private readonly buildTimes: () => readonly RtcDateTime[];
  /** DS1307: bit 7 of the seconds is CH, and it stops the clock. */
  private readonly hasClockHalt: boolean;

  constructor(
    clock: () => number,
    buildTimes: () => readonly RtcDateTime[],
    hasClockHalt: boolean,
  ) {
    this.clock = clock;
    this.buildTimes = buildTimes;
    this.hasClockHalt = hasClockHalt;
    const now = this.clock();
    this.show(Math.floor(now / 1000) * 1000);
    // No sketch has said what the numbers mean yet. Monday = 1 is what
    // RTClib writes to a DS3231 and compares an alarm on a weekday with
    // (dowToDS3231), and what the Seeed DS1307 library calls MON.
    this.regs[3] = ((((Math.floor(now / RTC_MS_DAY) + 3) % 7) + 7) % 7) + 1;
    this.tickAt = Math.floor(now / 1000) * 1000;
  }

  get halted(): boolean {
    return this.hasClockHalt && (this.regs[0] & 0x80) !== 0;
  }

  /** Bring the counters to the present. */
  sync(): void {
    const now = this.clock();
    if (this.following) {
      const to = Math.floor(now / 1000) * 1000;
      this.count(this.time(), to, true);
      this.tickAt = to;
      return;
    }
    if (this.halted) return;
    const seconds = Math.floor((now - this.tickAt) / 1000);
    if (seconds <= 0) {
      // The host's clock was set back: the chip does not count backwards.
      if (now < this.tickAt) this.tickAt = now;
      return;
    }
    const from = this.time();
    this.count(from, from + seconds * 1000, true);
    this.tickAt += seconds * 1000;
  }

  /** A byte written to one of the seven registers, already cut to the bits that exist. */
  write(reg: number, value: number): void {
    this.regs[reg] = value;
    // The day of week is a counter of its own: writing it sets no time.
    if (reg === 3) return;
    this.following = false;
    this.written = true;
    // "The countdown chain is reset whenever the seconds register is written."
    if (reg === 0) this.tickAt = this.clock();
  }

  /** The write phase ended: what was written is a time now. */
  commit(): void {
    if (!this.written) return;
    this.written = false;
    if (this.halted) return;
    const set = this.time();
    const date = rtcDateOf(Math.floor(set / RTC_MS_DAY));
    const ms = set - Math.floor(set / RTC_MS_DAY) * RTC_MS_DAY;
    const hour = Math.floor(ms / 3_600_000);
    const minute = Math.floor(ms / 60_000) % 60;
    const second = Math.floor(ms / 1000) % 60;
    const built = this.buildTimes().some(
      (b) =>
        b.year === date.year &&
        b.month === date.month &&
        b.day === date.day &&
        b.hour === hour &&
        b.minute === minute &&
        b.second === second,
    );
    if (!built) return;
    this.following = true;
    const to = Math.floor(this.clock() / 1000) * 1000;
    // Set back then, running since: no alarm is owed for the time in between.
    this.count(set, to, false);
    this.tickAt = to;
  }

  /** The time the registers show, as the clock option counts it. */
  time(): number {
    const r = this.regs;
    const days = rtcDaysOf(2000 + rtcBin(r[6]), rtcBin(r[5] & 0x1f), rtcBin(r[4] & 0x3f));
    return (
      days * RTC_MS_DAY +
      rtcHourOf(r[2]) * 3_600_000 +
      rtcBin(r[1] & 0x7f) * 60_000 +
      rtcBin(r[0] & 0x7f) * 1000
    );
  }

  private count(from: number, to: number, alarms: boolean): void {
    if (to === from) return;
    const weekday = this.regs[3];
    this.regs[3] = rtcWeekdayAfter(
      weekday,
      Math.floor(to / RTC_MS_DAY) - Math.floor(from / RTC_MS_DAY),
    );
    this.show(to);
    if (alarms && to > from) this.onCount?.(from, to, weekday);
  }

  /** Put a time in the registers. CH, the 12-hour mode and the day of week stay. */
  private show(time: number): void {
    const r = this.regs;
    const days = Math.floor(time / RTC_MS_DAY);
    const ms = time - days * RTC_MS_DAY;
    const date = rtcDateOf(days);
    // The year register counts 00 to 99, and the century bit of the DS3231
    // turns over with it.
    const centuries = Math.floor((date.year - 2000) / 100);
    r[0] = (r[0] & 0x80) | rtcBcd(Math.floor(ms / 1000) % 60);
    r[1] = rtcBcd(Math.floor(ms / 60_000) % 60);
    r[2] = rtcHourRegister(Math.floor(ms / 3_600_000), (r[2] & 0x40) !== 0);
    r[4] = rtcBcd(date.day);
    r[5] = ((r[5] & 0x80) ^ (centuries & 1 ? 0x80 : 0)) | rtcBcd(date.month);
    r[6] = rtcBcd((((date.year - 2000) % 100) + 100) % 100);
  }
}

/**
 * Whether an alarm's registers matched the clock at one of the seconds it
 * counted through, (from, to]. "The match is tested on the once-per-second
 * update of the time and date registers", so a minute nobody read the chip in
 * is looked through here, from one field to the next and not second by
 * second.
 *
 * `second`, `minute` and `hour` are what the field has to be, or null where
 * the alarm's mask bit leaves it out; an hour of -1 cannot match (the alarm
 * is in 12-hour form and the clock is not, or the reverse). `dayRegister` is
 * the alarm's day/date register as written.
 */
function rtcAlarmMatched(
  from: number,
  to: number,
  weekdayAtFrom: number,
  second: number | null,
  minute: number | null,
  hour: number | null,
  dayRegister: number,
): boolean {
  const firstDay = Math.floor(from / RTC_MS_DAY);
  const dayMatches = (days: number): boolean => {
    if (dayRegister & 0x80) return true;
    if (dayRegister & 0x40)
      return rtcWeekdayAfter(weekdayAtFrom, days - firstDay) === (dayRegister & 0x0f);
    return rtcDateOf(days).day === rtcBin(dayRegister & 0x3f);
  };
  // Longer ago than a year the chip would have matched as well; nobody waits.
  let t = Math.max(from, to - 400 * RTC_MS_DAY) + 1000;
  while (t <= to) {
    const days = Math.floor(t / RTC_MS_DAY);
    const day = days * RTC_MS_DAY;
    if (!dayMatches(days)) {
      t = day + RTC_MS_DAY;
      continue;
    }
    const h = Math.floor((t - day) / 3_600_000);
    if (hour !== null && h !== hour) {
      t = h < hour ? day + hour * 3_600_000 : day + RTC_MS_DAY;
      continue;
    }
    const m = Math.floor((t - day) / 60_000) % 60;
    if (minute !== null && m !== minute) {
      const hourStart = day + h * 3_600_000;
      t = m < minute ? hourStart + minute * 60_000 : hourStart + 3_600_000;
      continue;
    }
    const s = Math.floor((t - day) / 1000) % 60;
    if (second !== null && s !== second) {
      const minuteStart = day + h * 3_600_000 + m * 60_000;
      t = s < second ? minuteStart + second * 1000 : minuteStart + 60_000;
      continue;
    }
    return true;
  }
  return false;
}

/**
 * What the DS1307 and the DS3231 have in common on the bus: a register
 * pointer that wraps, and seven time registers that are answered from a copy.
 *
 * "When reading or writing the time and date registers, secondary (user)
 * buffers are used to prevent errors when the internal registers update. [...]
 * the user buffers are synchronized to the internal registers on any START
 * and when the register pointer rolls over to zero." So a burst that starts
 * at 12:34:59 reads 12:34:59 to its last byte, however long the guest takes
 * over it, and never 12:35:59.
 */
abstract class VirtualRtc implements I2CDevice {
  public address = 0x68;
  /** Where the pointer wraps (I2CDevice.pointerWrapsAfter). */
  readonly pointerWrapsAfter: number;

  protected readonly counters: RtcCounters;
  /** The time registers as the START of this transfer found them. */
  private readonly latched = new Uint8Array(7);
  /** No START was heard for the transfer that comes next: it begins at its first byte. */
  private latchDue = true;
  private regPointer = 0;
  private firstByte = true;
  private readonly lastRegister: number;

  protected constructor(options: RtcOptions, hasClockHalt: boolean, lastRegister: number) {
    this.lastRegister = lastRegister;
    this.pointerWrapsAfter = lastRegister;
    this.counters = new RtcCounters(
      options.clock ?? hostWallClock,
      options.buildTimes ?? (() => []),
      hasClockHalt,
    );
  }

  /** A register behind the time, as the transfer in progress is answered. */
  protected abstract readRegister(reg: number): number;
  protected abstract writeRegister(reg: number, value: number): void;
  /** What else is sampled when a transfer begins. */
  protected latchInputs(): void {}
  /** A register behind the time as it is now, whatever a transfer in progress was told. */
  protected registerNow(reg: number): number {
    return this.readRegister(reg);
  }

  start(_read: boolean): void {
    this.begin();
  }

  writeByte(value: number): boolean {
    // For a host that does not say where a transfer begins: the first byte
    // after a STOP begins one, and after a write the next byte read does.
    if (this.firstByte && this.latchDue) this.begin();
    this.latchDue = true;
    if (this.firstByte) {
      // Past the last register the datasheets say nothing: the DS1307 has
      // six address bits to count with, the DS3231 is given the byte.
      this.regPointer = this.lastRegister === 0x3f ? value & 0x3f : value & 0xff;
      this.firstByte = false;
      return true;
    }
    const reg = this.regPointer;
    this.regPointer = this.after(reg);
    this.writeRegister(reg, value & 0xff);
    return true;
  }

  readByte(): number {
    if (this.latchDue) this.begin();
    const reg = this.regPointer;
    const value = reg < 7 ? this.latched[reg] : this.readRegister(reg);
    this.regPointer = this.after(reg);
    if (this.regPointer === 0) this.latch();
    return value & 0xff;
  }

  /**
   * The pointer survives the STOP: the Seeed library writes it in one
   * transaction and reads in the next, and QEMU ends every write phase this
   * way. What a write phase wrote to the time registers is a time from here.
   */
  stop(): void {
    this.counters.commit();
    this.firstByte = true;
    this.latchDue = true;
  }

  /** The registers as a read would find them now, for a host that answers from a copy. */
  dumpRegisters(): Uint8Array {
    this.counters.sync();
    const out = new Uint8Array(256);
    for (let reg = 7; reg <= this.lastRegister; reg++) out[reg] = this.registerNow(reg) & 0xff;
    out.set(this.counters.regs);
    return out;
  }

  private begin(): void {
    // A repeated START ends a write phase as a STOP does.
    this.counters.commit();
    this.latch();
    this.latchDue = false;
  }

  private latch(): void {
    this.counters.sync();
    this.latched.set(this.counters.regs);
    this.latchInputs();
  }

  private after(reg: number): number {
    return reg === this.lastRegister ? 0 : (reg + 1) & 0xff;
  }
}

/**
 * Virtual DS1307: the clock with 56 bytes of battery-backed RAM, at 0x68.
 *
 *  - The time is the host's until the sketch sets one; then it is the
 *    sketch's, counted from the moment it was written (RtcCounters has the
 *    one exception, a firmware's own build time).
 *  - CH, bit 7 of the seconds, stops the clock where it is, and RTClib's
 *    isrunning() reads it. Clearing it starts the clock from there.
 *  - CONTROL and the RAM at 0x08 to 0x3F keep what is written to them
 *    (RTClib readnvram and writenvram).
 *  - The pointer wraps from 0x3F to 0x00.
 */
export class VirtualDS1307 extends VirtualRtc {
  /** CONTROL at 0x07 and the RAM behind it, under their own addresses. */
  private readonly ram = new Uint8Array(DS1307_RULES.last_register + 1);

  constructor(options: RtcOptions = {}) {
    super(options, true, DS1307_RULES.last_register);
    for (const [reg, value] of Object.entries(DS1307_RULES.power_on)) this.ram[Number(reg)] = value;
  }

  protected readRegister(reg: number): number {
    return this.ram[reg];
  }

  protected writeRegister(reg: number, value: number): void {
    const mask = (DS1307_RULES.write_mask as Record<number, number>)[reg] ?? 0xff;
    if (reg < 7) this.counters.write(reg, value & mask);
    else this.ram[reg] = value & mask;
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
 * What the BMP280 holds at power-on and what it does with a byte written to
 * it, as one table. The model below works from it, the tests hold it against
 * the copy in test/fixtures/i2c-vectors/bmp280.json, and the worker's copy
 * (esp32_i2c_slaves.BMP280Slave) follows the same facts. Sections are those
 * of the datasheet, BST-BMP280-DS001 rev 1.26.
 */
export const BMP280_RULES = {
  /**
   * Every register powers on at 0x00 but the id and the msb of the two data
   * words, which hold 0x80000 until a measurement replaces it (4.2, table 18).
   * The calibration block 0x88-0x9F is the part's own.
   */
  power_on: { 0xd0: 0x58, 0xf7: 0x80, 0xfa: 0x80 },
  /**
   * The registers a write changes: ctrl_meas and config. The calibration, the
   * id, status and the data registers are read-only, and the rest of the map
   * is reserved (4.2, the "Type" row of table 18).
   */
  writable: [0xf4, 0xf5],
  /**
   * The reset register (4.3.2) keeps nothing and reads 0x00. This one word
   * runs the power-on reset, any other does nothing.
   */
  reset: { 0xe0: 0xb6 },
  /**
   * Bits the chip sets by itself in status (4.3.3). `measuring` is 1 while a
   * conversion runs: the first read after one starts finds it, the next does
   * not. im_update, bit 0, is up for the NVM copy that is over before a
   * master can ask.
   */
  status: { 0xf3: 0x08 },
  /** mode[1:0] of ctrl_meas (3.6, table 10): 01 and 10 are both forced mode. */
  mode: { register: 0xf4, mask: 0x03, sleep: 0, normal: 3 },
  /** press and temp, 20 bits each, msb first (4.3.6, 4.3.7). */
  sample: [0xf7, 0xfc],
} as const;

const BMP_RESET = 0xe0;
const BMP_RESET_WORD = BMP280_RULES.reset[BMP_RESET];
const BMP_STATUS = 0xf3;
const BMP_MEASURING = BMP280_RULES.status[BMP_STATUS];
const BMP_CTRL_MEAS = BMP280_RULES.mode.register;
const BMP_MODE = BMP280_RULES.mode.mask;
const BMP_SLEEP = BMP280_RULES.mode.sleep;
const BMP_NORMAL = BMP280_RULES.mode.normal;
const [BMP_SAMPLE_FIRST, BMP_SAMPLE_LAST] = BMP280_RULES.sample;
const BMP_WRITABLE = new Uint8Array(256);
for (const reg of BMP280_RULES.writable) BMP_WRITABLE[reg] = 1;

/**
 * Virtual BMP280 barometric pressure / temperature sensor, modelled where a
 * driver can tell the difference from the chip.
 *
 * Supports I2C addresses 0x76 (SDO=0) or 0x77 (SDO=1).
 *
 * Register map (subset):
 *   0x88–0x9F  Calibration data (trimming parameters)
 *   0xD0       chip_id  = 0x58  (BMP280 production; BME280 = 0x60)
 *   0xE0       reset: 0xB6 runs the power-on reset, reads 0x00
 *   0xF3       status: measuring (bit 3)
 *   0xF4       ctrl_meas (mode, osrs_t, osrs_p) — writable
 *   0xF5       config    — writable
 *   0xF7–0xF9  press_msb / press_lsb / press_xlsb  (20-bit ADC)
 *   0xFA–0xFC  temp_msb  / temp_lsb  / temp_xlsb   (20-bit ADC)
 *
 *  - It powers on in sleep mode and measures nothing there (3.6.1): until
 *    the sketch selects a mode, the data registers hold their reset value
 *    0x80000.
 *  - Forced mode is one measurement, and the chip is back in sleep mode when
 *    it is done (3.6.2). A conversion takes no time here, so the mode bits
 *    read 00 at once and the measurement is what the panel said at the write.
 *    esp-idf-lib and M5Unit-ENV wait for those bits, BMP280_DEV starts the
 *    next conversion only from sleep mode.
 *  - In normal mode the chip measures by itself (3.6.3): a read finds what
 *    the panel says when it begins, and the whole burst is answered from that
 *    one measurement (3.10), so a slider moving while it is read cannot mix
 *    two of them.
 *  - `measuring` reads 1 once after a mode write that starts a conversion.
 *    SparkFun's and pocketBME280's examples wait for it to rise with no
 *    timeout, Adafruit's takeForcedMeasurement() waits for it to fall.
 *    Without a clock the cycles of normal mode that follow are not seen in
 *    status.
 *  - A write is pairs of register address and register data, and the address
 *    does not count up (5.2.1, figure 7). A read counts up from the last
 *    address written (5.2.2).
 *  - What the panel sets is the world around the chip, not a register: it
 *    survives a soft reset.
 *
 * The calibration parameters are the BMP280 datasheet example values (Section 8.2).
 * They produce T ≈ 25°C, P ≈ 1006 hPa from the corresponding raw ADC values.
 *
 * Setting `temperature` (°C) and `pressure` (hPa) properties recomputes the
 * raw ADC values using a binary search over the Bosch compensation formulas so that
 * Arduino sketches using the Adafruit_BMP280 / Bosch driver get realistic values.
 */
export class VirtualBMP280 implements I2CDevice {
  public address: number;
  /** The data registers were read before the chip ever measured, for the first time in this run. */
  onAsleepRead: (() => void) | null = null;

  private readonly registers = new Uint8Array(256);
  /** What a measurement taken now puts in the data registers. */
  private readonly live = new Uint8Array(BMP_SAMPLE_LAST - BMP_SAMPLE_FIRST + 1);
  private regPtr = 0;
  /** The next byte written is a register address. */
  private firstByte = true;
  /** A conversion started and status has not been read since. */
  private measuring = false;
  /** The data registers hold a measurement and not their reset value. */
  private measured = false;
  /** No START was heard for the read that comes next: latch on its first byte. */
  private latchDue = true;
  private asleepReadSaid = false;

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

  // Where the sensor panel starts (sensorControlConfig, bmp280).
  private _temperatureC = 24.0;
  private _pressureHPa = 1013.25;

  constructor(address = 0x76) {
    this.address = address;
    this.initCalibration();
    this.powerOn();
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

  start(read: boolean): void {
    if (read) this.latch();
  }

  writeByte(value: number): boolean {
    // For a host that does not say where a read begins: after a write, the
    // next byte read is the first of a new read.
    this.latchDue = true;
    if (this.firstByte) {
      this.regPtr = value & 0xff;
      this.firstByte = false;
      return true;
    }
    // The byte after a register's data is the next register's address. The
    // pointer stays where the pair put it: esp-idf-lib's bmp280_is_measuring
    // sends 0xF3 0xF4 and reads status and ctrl_meas back.
    this.firstByte = true;
    this.writeRegister(this.regPtr, value & 0xff);
    return true;
  }

  readByte(): number {
    if (this.latchDue) this.latch();
    const reg = this.regPtr;
    this.regPtr = (reg + 1) & 0xff;
    if (reg === BMP_STATUS) {
      const status = this.measuring ? BMP_MEASURING : 0;
      this.measuring = false;
      return status;
    }
    if (
      reg >= BMP_SAMPLE_FIRST &&
      reg <= BMP_SAMPLE_LAST &&
      !this.measured &&
      !this.asleepReadSaid
    ) {
      this.asleepReadSaid = true;
      this.onAsleepRead?.();
    }
    return this.registers[reg];
  }

  /** The pointer survives the STOP: Seeed_BMP280 writes it in one transaction and reads in the next. */
  stop(): void {
    this.firstByte = true;
    this.latchDue = true;
  }

  /** A new run reads a chip that still has not measured: its monitor is told as well. */
  boardReset(): void {
    this.asleepReadSaid = false;
  }

  /**
   * The registers as a read would find them now: in normal mode the data
   * registers encoded from the panel's values, and no `measuring`. A host
   * that answers its guest from a copy (the Raspberry Pi relay) mirrors this.
   */
  dumpRegisters(): Uint8Array {
    const out = this.registers.slice();
    if (this.mode === BMP_NORMAL) out.set(this.live, BMP_SAMPLE_FIRST);
    return out;
  }

  private get mode(): number {
    return this.registers[BMP_CTRL_MEAS] & BMP_MODE;
  }

  /** The power-on reset, which the reset word runs too. The calibration is NVM and the panel is not the chip's. */
  private powerOn(): void {
    for (const reg of BMP280_RULES.writable) this.registers[reg] = 0;
    this.registers.fill(0, BMP_SAMPLE_FIRST, BMP_SAMPLE_LAST + 1);
    for (const [reg, value] of Object.entries(BMP280_RULES.power_on)) {
      this.registers[Number(reg)] = value;
    }
    this.measuring = false;
    this.measured = false;
  }

  private writeRegister(reg: number, value: number): void {
    if (reg === BMP_RESET) {
      if (value === BMP_RESET_WORD) this.powerOn();
      return;
    }
    if (!BMP_WRITABLE[reg]) return;
    if (reg !== BMP_CTRL_MEAS) {
      this.registers[reg] = value;
      return;
    }
    const mode = value & BMP_MODE;
    if (mode === BMP_SLEEP) {
      // The chip measured until now, so what it holds asleep is this instant.
      if (this.mode === BMP_NORMAL) this.measure();
      this.measuring = false;
      this.registers[reg] = value;
      return;
    }
    this.measuring = true;
    if (mode === BMP_NORMAL) {
      this.registers[reg] = value;
      return;
    }
    this.measure();
    this.registers[reg] = value & ~BMP_MODE;
  }

  private measure(): void {
    this.registers.set(this.live, BMP_SAMPLE_FIRST);
    this.measured = true;
  }

  private latch(): void {
    if (this.mode === BMP_NORMAL) this.measure();
    this.latchDue = false;
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

  /**
   * Recompute the raw ADC values from current temperature / pressure. They
   * reach the data registers with a measurement, not here.
   */
  private updateMeasurements(): void {
    const targetT = Math.round(this._temperatureC * 100);
    const targetP = this._pressureHPa * 100; // hPa → Pa

    const adcT = this.findAdcT(targetT);
    const adcP = this.findAdcP(targetP, adcT);

    this.live.set([...VirtualBMP280.encodeAdc20(adcP), ...VirtualBMP280.encodeAdc20(adcT)]);
  }
}

/**
 * Virtual DS3231: the temperature-compensated clock with two alarms, at 0x68.
 *
 *  - The time registers are the DS1307's, without CH: powered from VCC the
 *    oscillator runs whatever EOSC says (Control Register, bit 7).
 *  - CONTROL powers on at 0x1C. RTClib's setAlarm1() and setAlarm2() refuse
 *    to arm an alarm unless INTCN reads 1, and CONV is gone by the next read
 *    (Makuna's Rtc polls it after forcing a conversion).
 *  - STATUS powers on with OSF clear (DS3231_RULES.power_on says why), so
 *    RTClib's lostPower() is false. OSF, A1F and A2F can only be written
 *    to 0.
 *  - A1F and A2F are set when the clock counts through a second the alarm's
 *    registers match, whether or not the interrupt is enabled, and stay until
 *    the sketch writes them to 0 (RTClib alarmFired, clearAlarm). The INT/SQW
 *    pin is not driven.
 *  - The temperature is the panel's, in quarter degrees, two's complement:
 *    q = round(T x 4), 0x11 = q >> 2, 0x12 = (q & 3) << 6. It is read only.
 *  - The pointer wraps from 0x12 to 0x00.
 */
export class VirtualDS3231 extends VirtualRtc {
  public temperatureC = 25.0;

  /** Alarm 1 (0x07-0x0A), alarm 2 (0x0B-0x0D), CONTROL, STATUS and the aging offset. */
  private readonly regs = new Uint8Array(DS3231_RULES.last_register + 1);
  /** The temperature as the START of this transfer found it. */
  private readonly temperature = new Uint8Array(2);

  constructor(options: RtcOptions = {}) {
    super(options, false, DS3231_RULES.last_register);
    for (const [reg, value] of Object.entries(DS3231_RULES.power_on))
      this.regs[Number(reg)] = value;
    this.counters.onCount = (from, to, weekday) => this.checkAlarms(from, to, weekday);
  }

  protected readRegister(reg: number): number {
    if (reg === 0x11 || reg === 0x12) return this.temperature[reg - 0x11];
    return reg <= 0x10 ? this.regs[reg] : 0x00;
  }

  protected writeRegister(reg: number, value: number): void {
    const mask = (DS3231_RULES.write_mask as Record<number, number>)[reg];
    if (mask === undefined) return;
    if (reg < 7) {
      this.counters.write(reg, value & mask);
      return;
    }
    const flags = (DS3231_RULES.write_zero_to_clear as Record<number, number>)[reg] ?? 0;
    this.regs[reg] = (this.regs[reg] & flags & value) | (value & mask);
  }

  protected latchInputs(): void {
    this.temperature.set(this.temperatureRegisters());
  }

  protected registerNow(reg: number): number {
    if (reg === 0x11 || reg === 0x12) return this.temperatureRegisters()[reg - 0x11];
    return this.readRegister(reg);
  }

  private temperatureRegisters(): [number, number] {
    const limit = 128 * DS3231_RULES.temp_lsb_per_c;
    const quarters = this.temperatureC * DS3231_RULES.temp_lsb_per_c;
    // Half a step rounds away from zero, as in the other twin.
    const rounded = Math.sign(quarters) * Math.round(Math.abs(quarters));
    const q = Number.isFinite(rounded) ? Math.max(-limit, Math.min(limit - 1, rounded)) : 0;
    return [(q >> 2) & 0xff, (q & 3) << 6];
  }

  private checkAlarms(from: number, to: number, weekday: number): void {
    const r = this.regs;
    const twelveHour = (this.counters.regs[2] & 0x40) !== 0;
    const field = (reg: number): number | null => (reg & 0x80 ? null : rtcBin(reg & 0x7f));
    const hour = (reg: number): number | null => {
      if (reg & 0x80) return null;
      return ((reg & 0x40) !== 0) === twelveHour ? rtcHourOf(reg & 0x7f) : -1;
    };
    if (
      rtcAlarmMatched(from, to, weekday, field(r[0x07]), field(r[0x08]), hour(r[0x09]), r[0x0a])
    ) {
      r[0x0f] |= 0x01;
    }
    // Alarm 2 has no seconds register: it matches at second 00.
    if (rtcAlarmMatched(from, to, weekday, 0, field(r[0x0b]), hour(r[0x0c]), r[0x0d])) {
      r[0x0f] |= 0x02;
    }
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
