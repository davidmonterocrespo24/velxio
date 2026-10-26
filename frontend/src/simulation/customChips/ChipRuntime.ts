/**
 * ChipRuntime — TypeScript port of test/test_custom_chips/src/ChipRuntime.js.
 *
 * Loads a Velxio custom-chip WASM, wires its imports to host services
 * (PinManager, the SPI, I2C and UART bus fabric, attribute storage, timer
 * queue), and dispatches its callbacks back into the simulator. One
 * ChipInstance per chip dropped on the canvas.
 */
import type { PinManager } from '../PinManager';
import { SPIDevice } from './SPIBus';
import { attachI2cTarget, attachSpiDevice, attachUartEndpoint } from '../buses';
import type { BusHandle, GuestClock, I2cTarget, SpiMode, UartHandle } from '../buses/types';
import { WasiShim, type SimNanosFn, type WriteStdoutFn } from './WasiShim';
import { setChipPinDrive } from './chipPinDrives';
import { isSyntheticChipPin, isSyntheticNetPin } from './syntheticPins';
import { requestElectricalResolve } from '../spice/electricalResolveHook';
import { chipBusEnabled } from './chipNets';
import { setBusDrive, setBoardPinDrive, setBoardPinPull, clearBusDriversForChip } from './busNets';
import { modeToDrive, Strength, HIGHZ_DRIVE } from './busLogic';
import { logicRailVolts, onSolve, padNet, padVolts } from './padVolts';

function readCString(memory: WebAssembly.Memory, ptr: number): string {
  const u8 = new Uint8Array(memory.buffer);
  let end = ptr;
  while (end < u8.length && u8[end] !== 0) end++;
  return new TextDecoder().decode(u8.subarray(ptr, end));
}

interface I2CConfig {
  address: number;
  scl: number;
  sda: number;
  on_connect: number;
  on_read: number;
  on_write: number;
  on_stop: number;
  user_data: number;
}

interface UartConfig {
  rx: number;
  tx: number;
  baud_rate: number;
  on_rx_byte: number;
  on_tx_done: number;
  user_data: number;
}

interface SpiConfig {
  sck: number;
  mosi: number;
  miso: number;
  cs: number;
  mode: number;
  on_done: number;
  user_data: number;
  /** velxio-chip.h `on_exchange`: 0 when the chip answers from its buffer. */
  on_exchange: number;
}

function readI2CConfig(memory: WebAssembly.Memory, ptr: number): I2CConfig {
  const dv = new DataView(memory.buffer);
  return {
    address:    dv.getUint8(ptr + 0),
    scl:        dv.getInt32(ptr + 4,  true),
    sda:        dv.getInt32(ptr + 8,  true),
    on_connect: dv.getUint32(ptr + 12, true),
    on_read:    dv.getUint32(ptr + 16, true),
    on_write:   dv.getUint32(ptr + 20, true),
    on_stop:    dv.getUint32(ptr + 24, true),
    user_data:  dv.getUint32(ptr + 28, true),
  };
}

function readUartConfig(memory: WebAssembly.Memory, ptr: number): UartConfig {
  const dv = new DataView(memory.buffer);
  return {
    rx:         dv.getInt32(ptr + 0,  true),
    tx:         dv.getInt32(ptr + 4,  true),
    baud_rate:  dv.getUint32(ptr + 8, true),
    on_rx_byte: dv.getUint32(ptr + 12, true),
    on_tx_done: dv.getUint32(ptr + 16, true),
    user_data:  dv.getUint32(ptr + 20, true),
  };
}

function readSpiConfig(memory: WebAssembly.Memory, ptr: number): SpiConfig {
  const dv = new DataView(memory.buffer);
  return {
    sck:       dv.getInt32(ptr + 0,  true),
    mosi:      dv.getInt32(ptr + 4,  true),
    miso:      dv.getInt32(ptr + 8,  true),
    cs:        dv.getInt32(ptr + 12, true),
    mode:      dv.getUint32(ptr + 16, true),
    on_done:   dv.getUint32(ptr + 20, true),
    user_data: dv.getUint32(ptr + 24, true),
    // The first word of what used to be `reserved[8]`, so a chip built before
    // the field existed reads 0 here and keeps the buffer contract.
    on_exchange: dv.getUint32(ptr + 28, true),
  };
}

interface PinEntry {
  name: string;
  mode: number;
  arduinoPin: number | null;
  /** Last level written/initialized — used to compute the bus drive on a mode
   *  flip (e.g. OUTPUT -> INPUT releases the bus without forgetting the level). */
  value: 0 | 1;
  /** A bus drives this pin (the MISO of a vx_spi_attach, the TX of a
   *  vx_uart_attach, the SDA/SCL of a vx_i2c_attach): the pin's mode is not
   *  a level on the wire, the bus's protocol is. See _busOwnsPin. */
  busOwned?: boolean;
}

interface AttrEntry {
  name: string;
  default: number;
  /** Present on string attributes (vx_attr_register_string). */
  stringDefault?: string;
}

interface TimerEntry {
  cbIdx: number;
  userData: number;
  active: boolean;
  period: bigint;
  /** The deadline, in the chip's own nanoseconds (see _nowNanos). */
  nextFire: bigint;
  repeat: boolean;
  /** Cancels the guest clock event armed for the deadline, when one is. */
  cancel: (() => void) | null;
}

/** One vx_i2c_attach: an address and the callbacks that serve it. */
interface I2cDeviceEntry {
  cfg: I2CConfig;
  /** The pads its config names, on the chip's canvas component. */
  scl: string | undefined;
  sda: string | undefined;
  /** The chip's side of one addressed phase (see _i2c_attach). */
  device: ChipI2cDevice;
}

interface ChipI2cDevice {
  address: number;
  connect(addr: number, isRead: boolean): boolean;
  writeByte(value: number): boolean;
  readByte(): number;
  stop(): void;
}

/**
 * Every address a chip answers on one pair of pins: ONE target of the bus,
 * because on the bench they are one chip hanging off one SDA and one SCL.
 */
interface I2cGroup {
  owner: string;
  scl: string;
  sda: string;
  entries: I2cDeviceEntry[];
  bus: BusHandle | null;
}

interface SpiEntry {
  /** The chip's armed buffer for this handle. */
  device: SPIDevice;
  cfg: SpiConfig;
  /** Registration on the board's SPI bus, disposed with the chip. */
  bus: BusHandle | null;
}

/** One vx_uart_attach: its config and, once setup is over, its place on the wires. */
interface UartEntry {
  cfg: UartConfig;
  /** Registration on the bus fabric, disposed with the chip. */
  bus: UartHandle | null;
}

/**
 * The fabric owner of a chip's UART handle: the chip's own component id for
 * its first UART, which is the identity a QEMU worker's copy of the chip
 * carries too (uart_bus_table.owner_of), and `<id>:uart<n>` for any further
 * one. Every host that registers a chip's UART names it this way, so a map
 * built in the tab and a record hosted in a worker meet on the same word.
 */
export function chipUartOwner(componentId: string, handle: number): string {
  return handle === 0 ? componentId : `${componentId}:uart${handle}`;
}

export interface ChipInstanceOptions {
  /** Compiled chip.wasm — either bytes, ArrayBuffer, or pre-compiled Module. */
  wasm: Uint8Array | ArrayBuffer | WebAssembly.Module;
  pinManager: PinManager;
  /**
   * The canvas pad each chip pin is, when the two are named apart (a Grove
   * module whose chip calls its second address's pins SDA2/SCL2, both on the
   * socket's SDA/SCL). The fabric resolves wires by the component's pads.
   */
  busPads?: Record<string, string> | null;
  /**
   * The model a backend worker runs for this chip, when the board's guest is
   * in one (a QEMU ESP32 or STM32): 'custom-chip' when the host shipped the
   * chip itself to the worker, 'i2c-write-sink' when the worker only ACKs and
   * echoes a display's writes to this instance. The fabric reports a chip on
   * a remote bus as missing unless the worker holds one of these for it.
   */
  remoteModel?: string | null;
  /**
   * Whether this copy of the chip drives what it puts on a wire itself, read
   * per byte. False while a worker's copy of the same chip answers the guest
   * (the QEMU fallback of a delegating ESP32 engine): this copy still hears
   * the bytes, and paints from them, but a second answer on the wire would be
   * a second driver. Today that is the UART bytes of vx_uart_write; a pin
   * level reaches the board through the host's own hooks, which gate
   * themselves. Absent: always.
   */
  drivesWires?: () => boolean;
  /** Logical chip pin name → real Arduino pin number (resolved from wires). */
  wires?: Map<string, number>;
  /**
   * The resistors the MODULE carries on its lines, by chip pin name (a key of
   * `wires`): the 10k pull-ups of a Grove 4-Digit Display on CLK and DIO, a
   * DS18B20 module's 4.7k on DQ. Each is a weak driver of the board pin that
   * pin is wired to, on it from before chip_setup until dispose, whatever the
   * chip does with its own pin: it loses to any strong drive and beats the
   * MCU's internal pull the other way (busNets, setBoardPinPull). This is
   * the PCB's resistor, not the die's: a chip's own VX_INPUT_PULLUP stays
   * off board pins (see _boardDrive). A pad wired to no board pin ignores it.
   */
  pulls?: Record<string, 'up' | 'down'> | null;
  /** User-editable attributes — keyed by name. */
  attrs?: Map<string, number>;
  /** String attribute values (vx_attr_register_string), from chip.json. */
  strAttrs?: Map<string, string>;
  /**
   * Attributes the host answers at the moment the chip reads them, ahead of
   * `attrs` and `strAttrs`: a number for vx_attr_read, a string for
   * vx_attr_string_read, undefined to fall through to the maps. For a value
   * that is the host's to know and costly or pointless to push on every
   * change, such as the wall clock a real-time clock counts or the build
   * times it scans the firmware for (buses/models/ds3231.c).
   */
  liveAttrs?: ((name: string) => number | string | undefined) | null;
  /**
   * The clock of the board the chip is wired to (its EngineBinding's, the
   * one the software UART runs on): vx_sim_now_nanos reads it and the chip's
   * timers fire on its events, at their guest instant. Without one the chip
   * has no time of its own: the clock stands at whatever the host last
   * handed tickTimers, and the timers fire from there.
   */
  clock?: GuestClock | null;
  /** A test's clock for vx_sim_now_nanos, in place of `clock`. */
  simNanos?: SimNanosFn;
  /** Callback for chip log/printf output (defaults to console.log). */
  log?: WriteStdoutFn;
  /** Optional display dimensions from chip.json's `display` field. */
  display?: { width: number; height: number } | null;
  /** Optional external ROM bytes (vx_rom_size / vx_rom_read).
   *  Used by CPU-emulator chips that load their program from a project file
   *  instead of hard-coding it as a C byte array. */
  romBytes?: Uint8Array | null;
  /** Named byte storage the chip reads and writes (vx_blob_size / _read /
   *  _write): a microSD model gets its card image here as "card". Copied in,
   *  so the chip's writes never reach the caller's array behind its back; read
   *  them back with blobBytes(). */
  blobs?: Map<string, Uint8Array> | null;
  /** Canvas component id of this chip. Used to key its SPICE pin sources so
   *  the analog engine drives the nets wired to the chip's output pins. */
  componentId?: string;
}

/** Logic-high a chip output asserts when nothing says what its supply is:
 *  no supply pad wired and no rail solved yet. */
const CHIP_OUTPUT_VCC = 5;

/** The pads a chip is powered from; a CMOS output swings to this level. */
const SUPPLY_PADS = ['VCC', 'VDD'];

export class ChipInstance {
  static MODE_INPUT = 0;
  static MODE_OUTPUT = 1;
  static MODE_OUTPUT_LOW = 16;
  static MODE_OUTPUT_HIGH = 17;

  private wasm: ChipInstanceOptions['wasm'];
  private pinManager: PinManager;
  private busPads: Record<string, string>;
  private remoteModel: string | undefined;
  private drivesWires: (() => boolean) | null;
  private wires: Map<string, number>;
  private pulls: Record<string, 'up' | 'down'>;
  private attrs: Map<string, number>;
  private strAttrs: Map<string, string>;
  private liveAttrs: ((name: string) => number | string | undefined) | null;
  private display: { width: number; height: number } | null;
  private componentId: string;

  memory: WebAssembly.Memory | null = null;
  instance: WebAssembly.Instance | null = null;
  exports: any = null;
  disposed = false;

  private pins: PinEntry[] = [];
  private attrHandles: AttrEntry[] = [];
  private _pinWatches = new Map<number, Set<() => void>>();
  private timers: TimerEntry[] = [];
  // ── The chip's clock ────────────────────────────────────────────────────
  // The board's guest clock when the host handed one over (see _nowNanos),
  // else the time the host last handed tickTimers.
  private clock: GuestClock | null;
  private simNanosOverride: SimNanosFn | null;
  /** The last guest time read, to notice the guest's counter starting over. */
  private _lastGuestNanos = 0n;
  /** Guest time already counted before the counter last started over: the
   *  chip's clock never runs backwards across an MCU reset. */
  private _epochNanos = 0n;
  /** With no guest clock: the time the host last handed tickTimers. */
  private _hostNanos = 0n;
  /** Inside a timer callback: its deadline, which is what the clock answers
   *  there (the worker's runtime does the same, wasm_chip_runtime.py). */
  private _timerNow: bigint | null = null;
  private uarts: UartEntry[] = [];
  /** A host's ear on what the chip transmits (tests, a part that mirrors the
   *  bytes). The wire itself is the fabric's, see _uart_write. */
  private _uartTxListener: ((byte: number) => void) | null = null;
  private spiDevices: SpiEntry[] = [];
  /** chip_setup is running: SPI handles wait for it to finish before joining. */
  private inSetup = false;
  private _romBytes: Uint8Array;
  /** Named byte storage, per chip instance. See vx_blob_* in velxio-chip.h. */
  private _blobs = new Map<string, Uint8Array>();
  /** Byte span [lo, hi) the chip has written in each blob since the last
   *  takeBlobDirty(). The host ships those bytes back to whatever owns the
   *  storage (the SD panel), so it needs the span, not just the fact. */
  private _blobDirty = new Map<string, [number, number]>();

  /** Framebuffer state — created on first vx_framebuffer_init call. */
  private _framebuffer: { rgba: Uint8Array; width: number; height: number } | null = null;
  private _onFramebufferUpdate: ((rgba: Uint8Array, w: number, h: number) => void) | null = null;

  /** Host hook: the chip drove an analog voltage on a pin (vx_pin_dac_write).
   *  CustomChipPart forwards it into the wired board's ADC channel. */
  private _onDacWrite: ((pinName: string, voltage: number) => void) | null = null;

  /** Host hook: the chip reported a PWM duty on a pin (vx_pin_pwm_write).
   *  A driver model that chops its output speaks here; the part host forwards
   *  it to whatever load sits on the other end of the wire. */
  private _onPwmWrite: ((pinName: string, duty: number) => void) | null = null;

  /** Host hook: the chip drove a DIGITAL level on a pin wired to a real
   *  board pin. triggerPinChange only notifies canvas parts — the board's
   *  own digitalRead never saw chip outputs (live NOT-gate audit: OUT wired
   *  to D3 read 0 forever). CustomChipPart forwards this into the
   *  simulator's pin-injection API. */
  private _onDigitalWrite: ((pinName: string, value: boolean) => void) | null = null;

  /** Every vx_i2c_attach, in call order. */
  private i2cDevices: I2cDeviceEntry[] = [];
  /** The same devices by the pins they are on: one bus target each. */
  private i2cGroups: I2cGroup[] = [];

  wasi: WasiShim;
  private _velxioImports: Record<string, (...args: any[]) => any>;

  static async create(opts: ChipInstanceOptions): Promise<ChipInstance> {
    const inst = new ChipInstance(opts);
    await inst._instantiate();
    return inst;
  }

  /**
   * The same, at once, from a module compiled beforehand. For a part that
   * has to answer the bus from the moment it attaches, as a hand-written model
   * does (buses/models/ds3231.c behind its flag): the compile is the slow
   * half and happens once per page, the instance is a few kilobytes.
   */
  static createSync(opts: ChipInstanceOptions & { wasm: WebAssembly.Module }): ChipInstance {
    const inst = new ChipInstance(opts);
    const importObject = inst._importObject();
    inst._checkImports(opts.wasm, importObject);
    inst.instance = new WebAssembly.Instance(opts.wasm, importObject);
    inst.exports = inst.instance.exports;
    return inst;
  }

  constructor(opts: ChipInstanceOptions) {
    this.wasm = opts.wasm;
    this.pinManager = opts.pinManager;
    this.drivesWires = opts.drivesWires ?? null;
    this.busPads = opts.busPads ?? {};
    this.remoteModel = opts.remoteModel ?? undefined;
    this.wires = opts.wires ?? new Map();
    this.pulls = opts.pulls ?? {};
    this.attrs = opts.attrs ?? new Map();
    this.strAttrs = opts.strAttrs ?? new Map();
    this.liveAttrs = opts.liveAttrs ?? null;
    this.display = opts.display ?? null;
    this._romBytes = opts.romBytes ?? new Uint8Array(0);
    // Copy: the chip owns its blob from here on, and the same copy rule holds
    // in the Python runtime, so a model cannot behave differently by host.
    for (const [name, bytes] of opts.blobs ?? []) {
      this._blobs.set(name, Uint8Array.from(bytes));
    }
    this.componentId = opts.componentId ?? '';
    this.clock = opts.clock ?? null;
    this.simNanosOverride = opts.simNanos ?? null;

    // wasi-libc's clock_time_get is the same clock as vx_sim_now_nanos.
    this.wasi = new WasiShim(
      () => this._nowNanos(),
      opts.log ?? ((s) => console.log(`[chip] ${s.replace(/\n$/, '')}`)),
    );

    this._velxioImports = this._buildVelxioImports();
  }

  private _importObject(): WebAssembly.Imports {
    // 4 pages (256 KB) initial: CPU-emulator chips like z80-cpu keep a 32 KB
    // ROM + 32 KB RAM buffer as static data, which alone needs >2 pages once
    // the WASM stack is added. Grows up to 16 pages on demand.
    this.memory = new WebAssembly.Memory({ initial: 4, maximum: 16 });
    this.wasi.setMemory(this.memory);

    return {
      env: {
        memory: this.memory,
        ...this._velxioImports,
      },
      ...this.wasi.imports(),
    };
  }

  private async _instantiate(): Promise<void> {
    const importObject = this._importObject();

    let module: WebAssembly.Module;
    if (this.wasm instanceof WebAssembly.Module) {
      module = this.wasm;
    } else {
      module = await WebAssembly.compile(this.wasm as BufferSource);
    }

    this._checkImports(module, importObject);
    this.instance = await WebAssembly.instantiate(module, importObject);
    this.exports = this.instance.exports;
  }

  private _checkImports(module: WebAssembly.Module, importObject: WebAssembly.Imports): void {
    // Sanity-check imports so we surface a helpful error if something's missing.
    const expected = WebAssembly.Module.imports(module);
    const missing: string[] = [];
    for (const imp of expected) {
      const ns = (importObject as any)[imp.module];
      if (!ns || ns[imp.name] === undefined) {
        missing.push(`${imp.module}.${imp.name}`);
      }
    }
    if (missing.length) {
      throw new Error(
        `Chip WASM imports missing in host:\n  - ${missing.join('\n  - ')}\n` +
          `Extend WasiShim or ChipRuntime to provide them.`,
      );
    }
  }

  start(): void {
    if (!this.exports?.chip_setup) {
      throw new Error('Chip WASM does not export chip_setup');
    }
    // The module's resistors are on the board before the chip runs a line of
    // setup, as they are on a powered PCB.
    this._applyModulePulls();
    this.inSetup = true;
    try {
      this.exports.chip_setup();
    } finally {
      this.inSetup = false;
    }
    // The chip is on the bus once its setup is done, not in the middle of it:
    // see _joinSpiBus for why the order against its own pin watches matters.
    for (let i = 0; i < this.spiDevices.length; i++) {
      const e = this.spiDevices[i];
      if (!e.bus) e.bus = this._joinSpiBus(e, i);
    }
    // And its I2C with every address it attached, in one registration each
    // pair of pins, rather than one per call while setup is still adding them.
    for (const g of this.i2cGroups) if (!g.bus) g.bus = this._joinI2cBus(g);
    // And its UARTs, once the pads they name are registered pins.
    for (let i = 0; i < this.uarts.length; i++) {
      const u = this.uarts[i];
      if (!u.bus) u.bus = this._joinUartBus(u, i);
    }
    this.wasi.flush();
  }

  /**
   * Fire due timers up to sim-time `nowNanos`.
   *
   * `budgetMs` caps the wall-clock time spent in one call. A heavy multi-chip
   * bus (e.g. a Z80 fetching from external ROM/RAM through the settle kernel)
   * cannot run a real-time CPU clock in a single animation frame — without a
   * cap the loop would fire tens of thousands of times and freeze the tab. With
   * a budget the loop bails when exceeded, leaving each timer's nextFire where
   * it is so the next call resumes from there: the simulation simply advances
   * slower than real time (it boots over a few seconds) while the UI stays
   * responsive. budgetMs = 0 (the default, used by headless tests) runs every
   * due fire in one call.
   */
  tickTimers(nowNanos?: bigint | number, budgetMs = 0): void {
    let now: bigint;
    if (!this.clock && nowNanos !== undefined) {
      // The host's instant decides what is due, as it always has, whatever
      // vx_sim_now_nanos answers (a test's own clock may lag it). The host's
      // time only moves forward: a caller that hands an earlier instant (a
      // fresh run's zero) does not turn the chip's clock back.
      now = BigInt(nowNanos);
      if (now > this._hostNanos) this._hostNanos = now;
    } else {
      now = this._nowNanos();
    }
    const startWall = budgetMs > 0 ? performance.now() : 0;
    for (const t of this.timers) {
      if (!t.active) continue;
      while (t.active && now >= t.nextFire) {
        this._fireTimer(t);
        if (budgetMs > 0 && performance.now() - startWall > budgetMs) {
          this.wasi.flush();
          return;
        }
      }
      // On a guest clock every active timer holds a clock event for its
      // deadline. The event lives on the CPU it was set on, and a rebuilt CPU
      // (Stop then Run, a reload) drops it without a word, so it is re-armed
      // here every tick; the engine's own events fire at the exact cycle in
      // between, this is only the net under them.
      if (t.active) this._armTimer(t);
    }
    this.wasi.flush();
  }

  // ── The chip's clock ─────────────────────────────────────────────────────

  /**
   * The chip's own nanoseconds: what vx_sim_now_nanos (and wasi-libc's
   * clock_time_get) answer, and the base every timer deadline is in.
   *
   * On a board it is the guest's clock, the one the software UART already
   * runs on (EngineBinding.clock), so a chip measures the 20 ms period a
   * sketch drives as 20 ms whatever the tab's frame rate, and a 1 ms timer
   * fires once per ms of the RUN, not once per ms the page has been open
   * (finding browser-chip-clock-always-zero: it answered 0 here, and the
   * timers were compared against performance.now()). The guest's counter
   * starts over when its MCU is rebuilt; the chip is not reset by that (its
   * data survive a Stop/Run, decisions.md "Stop/Run = reset de la MCU"), so
   * the time counted before is carried as an epoch and this clock never
   * runs backwards. A guest that has no time yet (an engine before its SoC
   * boots reports a 0 Hz clock) stands at the epoch.
   *
   * Inside a timer callback the answer is the timer's deadline, as in the
   * worker's runtime: a periodic timer then sees exact multiples of its
   * period, whatever the granularity the deadline was reached with.
   */
  private _nowNanos(): bigint {
    if (this._timerNow !== null) return this._timerNow;
    if (this.simNanosOverride) return BigInt(this.simNanosOverride() as number | bigint);
    if (!this.clock) return this._hostNanos;
    const hz = this.clock.clockHz();
    const guest = hz > 0 ? (BigInt(Math.floor(this.clock.now())) * 1_000_000_000n) / BigInt(Math.floor(hz)) : 0n;
    if (guest < this._lastGuestNanos) this._epochNanos += this._lastGuestNanos;
    this._lastGuestNanos = guest;
    return this._epochNanos + guest;
  }

  /** The guest cycle a chip instant falls on, for the clock's event queue. */
  private _cycleOf(nanos: bigint): number {
    const hz = this.clock ? this.clock.clockHz() : 0;
    if (hz <= 0) return 0;
    const guest = nanos > this._epochNanos ? nanos - this._epochNanos : 0n;
    return Number((guest * BigInt(Math.floor(hz)) + 999_999_999n) / 1_000_000_000n);
  }

  /** Put the timer's deadline on the guest's event queue (a no-op with no
   *  clock: the host's tickTimers is the only clock there). */
  private _armTimer(t: TimerEntry): void {
    t.cancel?.();
    t.cancel = null;
    // A guest with no time yet (0 Hz: an engine before its SoC boots) has no
    // cycle to put the deadline on; the tick tries again once it runs.
    if (!this.clock || !t.active || this.clock.clockHz() <= 0) return;
    t.cancel = this.clock.at(this._cycleOf(t.nextFire), () => {
      t.cancel = null;
      if (!t.active) return;
      // The event is at the deadline's cycle, rounded up: read the clock so
      // the epoch bookkeeping sees this instant, then fire on the deadline.
      this._nowNanos();
      this._fireTimer(t);
      if (t.active) this._armTimer(t);
      this.wasi.flush();
    });
  }

  private _fireTimer(t: TimerEntry): void {
    const table = this.exports?.__indirect_function_table as WebAssembly.Table | undefined;
    const fn = table?.get(t.cbIdx) as ((ud: number) => void) | null;
    const prev = this._timerNow;
    // The deadline is the callback's "now" on a guest clock only: a host
    // that ticks the chip itself answers its own instant there, as before.
    this._timerNow = this.clock ? t.nextFire : prev;
    try {
      if (fn) fn(t.userData);
    } catch {
      /* swallow chip errors */
    } finally {
      this._timerNow = prev;
    }
    if (t.repeat) {
      t.nextFire += t.period;
    } else {
      t.active = false;
      t.cancel?.();
      t.cancel = null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    for (const set of this._pinWatches.values()) {
      for (const u of set) u();
    }
    this._pinWatches.clear();
    for (const t of this.timers) t.cancel?.();
    this.timers = [];
    for (const g of this.i2cGroups) g.bus?.dispose();
    this.i2cGroups = [];
    this.i2cDevices = [];
    for (const e of this.spiDevices) e.bus?.dispose();
    this.spiDevices = [];
    for (const u of this.uarts) u.bus?.dispose();
    this.uarts = [];
    // Stop driving any bus nets this chip contributed to, then re-resolve them
    // so a removed chip releases the bus (its drivers no longer count).
    if (this.componentId) clearBusDriversForChip(this.pinManager, this.componentId);
    this._unwatchSupply?.();
    this._unwatchSupply = null;
    this.disposed = true;
  }

  // ── Build host imports table ─────────────────────────────────────────────

  private _buildVelxioImports(): Record<string, (...args: any[]) => any> {
    return {
      vx_pin_register:    (namePtr: number, mode: number) => this._pin_register(namePtr, mode),
      vx_pin_read:        (handle: number) => this._pin_read(handle),
      vx_pin_write:       (handle: number, value: number) => this._pin_write(handle, value),
      vx_pin_read_analog: (handle: number) => this._pin_read_analog(handle),
      vx_pin_wired: (handle: number) => this._pin_wired(handle),
      vx_pin_dac_write:   (handle: number, voltage: number) => this._pin_dac_write(handle, voltage),
      vx_pin_pwm_write:   (handle: number, duty: number) => this._pin_pwm_write(handle, duty),
      vx_pin_set_mode:    (handle: number, mode: number) => this._pin_set_mode(handle, mode),
      vx_pin_watch:       (handle: number, edge: number, cbIdx: number, ud: number) =>
        this._pin_watch(handle, edge, cbIdx, ud),
      vx_pin_watch_stop:  (handle: number) => this._pin_watch_stop(handle),

      vx_attr_register: (namePtr: number, defaultVal: number) => this._attr_register(namePtr, defaultVal),
      vx_attr_read:     (handle: number) => this._attr_read(handle),
      vx_attr_register_string: (namePtr: number, defaultPtr: number) =>
        this._attr_register_string(namePtr, defaultPtr),
      vx_attr_string_len:  (handle: number) => this._attr_string_value(handle).length,
      vx_attr_string_read: (handle: number, bufPtr: number, cap: number) =>
        this._attr_string_read(handle, bufPtr, cap),

      vx_i2c_attach: (cfgPtr: number) => this._i2c_attach(cfgPtr),

      vx_uart_attach: (cfgPtr: number) => this._uart_attach(cfgPtr),
      vx_uart_write:  (handle: number, bufPtr: number, count: number) =>
        this._uart_write(handle, bufPtr, count),

      vx_spi_attach: (cfgPtr: number) => this._spi_attach(cfgPtr),
      vx_spi_start:  (handle: number, bufPtr: number, count: number) =>
        this._spi_start(handle, bufPtr, count),
      vx_spi_stop:   (handle: number) => this._spi_stop(handle),

      vx_sim_now_nanos: () => this._nowNanos(),
      vx_timer_create:  (cbIdx: number, ud: number) => this._timer_create(cbIdx, ud),
      vx_timer_start:   (handle: number, period: bigint, repeat: number) =>
        this._timer_start(handle, period, repeat),
      vx_timer_stop:    (handle: number) => this._timer_stop(handle),

      vx_framebuffer_init: (widthPtr: number, heightPtr: number) =>
        this._framebuffer_init(widthPtr, heightPtr),
      vx_buffer_write: (handle: number, offset: number, dataPtr: number, dataLen: number) =>
        this._buffer_write(handle, offset, dataPtr, dataLen),
      vx_buffer_read: (handle: number, offset: number, dataPtr: number, dataLen: number) =>
        this._buffer_read(handle, offset, dataPtr, dataLen),

      vx_rom_size: () => this._romBytes.length,
      vx_rom_read: (offset: number, dstPtr: number, len: number) =>
        this._rom_read(offset, dstPtr, len),

      vx_blob_size:  (namePtr: number) => this._blob_size(namePtr),
      vx_blob_read:  (namePtr: number, offset: number, dstPtr: number, len: number) =>
        this._blob_read(namePtr, offset, dstPtr, len),
      vx_blob_write: (namePtr: number, offset: number, srcPtr: number, len: number) =>
        this._blob_write(namePtr, offset, srcPtr, len),

      vx_log: (msgPtr: number) => {
        const msg = readCString(this.memory!, msgPtr);
        this.wasi.writeStdout(`[chip] ${msg}\n`);
      },
    };
  }

  private _rom_read(offset: number, dstPtr: number, len: number): void {
    if (!this.memory || this._romBytes.length === 0) return;
    const max = this._romBytes.length;
    if (offset >= max) return;
    const end = Math.min(offset + len, max);
    const dst = new Uint8Array(this.memory.buffer, dstPtr, end - offset);
    dst.set(this._romBytes.subarray(offset, end));
  }

  // ── Named blobs ──────────────────────────────────────────────────────────
  // The contract these three follow is written out in velxio-chip.h: storage
  // is per instance, an unknown name has nothing, a blob never grows, and both
  // directions truncate at the end and return what they moved. The Python
  // runtime answers the same for the same call, which is the only reason one
  // model can run next to the CPU on QEMU and in the tab here. It guards its
  // store with a lock and this does not, because there the chip runs on QEMU's
  // IO thread while the host drains the spans from another, and here there is
  // only the one thread.

  /** A NULL pointer is not a name. Python's _read_cstring says the same for
   *  ptr 0, so both hosts land on "unknown blob" instead of reading address 0. */
  private _blob_name(namePtr: number): string {
    if (!this.memory || namePtr === 0) return '';
    return readCString(this.memory, namePtr);
  }

  private _blob_size(namePtr: number): number {
    return this._blobs.get(this._blob_name(namePtr))?.length ?? 0;
  }

  private _blob_read(namePtr: number, offset: number, dstPtr: number, len: number): number {
    const blob = this._blobs.get(this._blob_name(namePtr));
    if (!this.memory || !blob || len <= 0 || offset < 0 || offset >= blob.length) return 0;
    const n = Math.min(len, blob.length - offset);
    new Uint8Array(this.memory.buffer, dstPtr, n).set(blob.subarray(offset, offset + n));
    return n;
  }

  private _blob_write(namePtr: number, offset: number, srcPtr: number, len: number): number {
    const name = this._blob_name(namePtr);
    const blob = this._blobs.get(name);
    if (!this.memory || !blob || len <= 0 || offset < 0 || offset >= blob.length) return 0;
    const n = Math.min(len, blob.length - offset);
    blob.set(new Uint8Array(this.memory.buffer, srcPtr, n), offset);
    const span = this._blobDirty.get(name);
    if (span) {
      span[0] = Math.min(span[0], offset);
      span[1] = Math.max(span[1], offset + n);
    } else {
      this._blobDirty.set(name, [offset, offset + n]);
    }
    return n;
  }

  /** Current bytes of a named blob, or null when the chip has no such blob.
   *  The live buffer, so a caller that means to keep it copies it. */
  blobBytes(name: string): Uint8Array | null {
    return this._blobs.get(name) ?? null;
  }

  /** The byte spans [lo, hi) the chip wrote since the last call, and clears
   *  them. The host ships those bytes to whoever owns the storage. */
  takeBlobDirty(): Map<string, [number, number]> {
    const out = this._blobDirty;
    this._blobDirty = new Map();
    return out;
  }

  // ── Pin implementations ──────────────────────────────────────────────────

  /**
   * Mirror an output pin's logic level into the SPICE chip-source registry and
   * request a re-solve when it changes — so LEDs / analog parts wired to a chip
   * output light up through ngspice, not just the digital PinManager path.
   * Only synthetic chip pins (chip wired directly to components, no board GPIO
   * on the net) are emitted as chip sources; a chip pin wired to a real board
   * pin is already driven by that board's voltage source.
   */
  /** True if this pin sits on a multi-chip BUS net (Phase 1): its key is a
   *  syntheticNetPin and the chipbus flag is on. Such pins resolve through the
   *  driver-strength registry (busNets) instead of last-writer-wins PinManager. */
  private _isBusPin(p: PinEntry): boolean {
    return p.arduinoPin != null && chipBusEnabled() && isSyntheticNetPin(p.arduinoPin);
  }

  /** Register this pin's current (mode, value) as a bus driver and re-resolve. */
  private _busDrive(p: PinEntry): void {
    if (p.arduinoPin == null) return;
    setBusDrive(
      this.pinManager,
      p.arduinoPin,
      `${this.componentId}::${p.name}`,
      modeToDrive(p.mode, p.value),
    );
  }

  /** True if this pin is wired to a pin of the board (a numbered GPIO), as
   *  opposed to a chip-only net or to nothing. */
  private _isBoardPin(p: PinEntry): boolean {
    return p.arduinoPin != null && p.arduinoPin >= 0 && !isSyntheticChipPin(p.arduinoPin);
  }

  /**
   * Put this pin's current (mode, value) on the board pin it is wired to, as
   * one driver of that pin's net (busNets.setBoardPinDrive): the resolution
   * against the MCU's pad and any other chip on the pin decides the level,
   * and the level reaches the PinManager and, through the host's
   * digital-write hook, the guest's input register. An INPUT mode is the
   * release: the chip leaves the net and the pull, or whoever else holds
   * the line, has it. The three ABI calls that move a pin's drive
   * (vx_pin_register, vx_pin_write, vx_pin_set_mode) all come through here,
   * so a pull made with vx_pin_set_mode(VX_OUTPUT_LOW) reaches the board
   * exactly as one made with vx_pin_write(0) does.
   *
   * A pin a bus took (see _busOwnsPin) is the chip's again the moment the
   * chip writes it or sets its mode: the Grove US5 turns its serial pad
   * into a plain level in its IO mode with vx_pin_write on the TX it
   * attached. What the bus withdrew was the registration's mode, never a
   * write the chip makes.
   */
  private _boardDrive(p: PinEntry): void {
    if (p.arduinoPin == null) return;
    p.busOwned = false;
    const name = p.name;
    const drive = modeToDrive(p.mode, p.value);
    setBoardPinDrive(
      this.pinManager,
      p.arduinoPin,
      `${this.componentId}::${name}`,
      // A chip input's own pull (VX_INPUT_PULLUP) is not put on a board
      // pin: chips use it loosely, for a chip select or an IRQ that should
      // idle high in their own reads, and the worker's runtime models no
      // chip pull either. The resistor a MODULE carries on a line is
      // declared by the part instead (ChipInstanceOptions.pulls), and that
      // one is on the net.
      drive.strength === Strength.PULL ? HIGHZ_DRIVE : drive,
      (level) => this._onDigitalWrite?.(name, level),
    );
  }

  /** Put the module's declared resistors (ChipInstanceOptions.pulls) on the
   *  board pins their pads are wired to. */
  private _applyModulePulls(): void {
    for (const [name, pull] of Object.entries(this.pulls)) {
      if (pull !== 'up' && pull !== 'down') continue;
      const pin = this.wires.get(name);
      if (pin == null || pin < 0 || isSyntheticChipPin(pin)) continue;
      setBoardPinPull(
        this.pinManager,
        pin,
        `${this.componentId}::${name}~pull`,
        pull,
        (level) => this._onDigitalWrite?.(name, level),
      );
    }
  }

  /**
   * A bus attach named this pin as one the bus drives: from here on the
   * bus's protocol puts the level on the wire (the fabric answers MISO per
   * frame and clocks TX bits on the guest's clock) and the pin's own mode
   * does not. A chip declares its MISO an output, as the datasheet does, and
   * never writes it; if that declaration stayed on the net as a strong low
   * it would fight every bit the bus shifts out. Whatever drive the
   * registration put on the net is withdrawn here, which leaves the line
   * where it is, as before, until the bus speaks.
   */
  private _busOwnsPin(handle: number): void {
    const p = handle >= 0 ? this.pins[handle] : undefined;
    if (!p || p.busOwned) return;
    if (this._isBoardPin(p)) {
      const name = p.name;
      setBoardPinDrive(
        this.pinManager,
        p.arduinoPin!,
        `${this.componentId}::${name}`,
        modeToDrive(ChipInstance.MODE_INPUT, p.value),
        (level) => this._onDigitalWrite?.(name, level),
      );
    }
    p.busOwned = true;
  }

  private _syncSpiceDrive(p: PinEntry): void {
    // A bus net is served by the digital driver-strength path; emitting a SPICE
    // chip source per chip on the same net would create false analog contention.
    if (this._isBusPin(p)) return;
    if (!this.componentId || !p.name) return;
    if (p.arduinoPin == null || !isSyntheticChipPin(p.arduinoPin)) return;
    const isOutput =
      p.mode === ChipInstance.MODE_OUTPUT_LOW || p.mode === ChipInstance.MODE_OUTPUT_HIGH;
    const changed = isOutput
      ? setChipPinDrive(
          this.componentId,
          p.name,
          this.pinManager.getPinState(p.arduinoPin) ? this._supplyVolts() : 0,
        )
      : setChipPinDrive(this.componentId, p.name, null);
    if (isOutput) this._watchSupply();
    if (changed) requestElectricalResolve();
  }

  /**
   * The level a HIGH output drives: the chip's own supply, as on silicon. A
   * 74HC595 on a 3.3 V board puts out 3.3 V, so a 5 V relay coil it drives
   * stays released; a fixed 5 V here pulled it in. The supply pad's solved
   * voltage when it is wired, else the board's logic rail, else 5 V.
   */
  private _supplyVolts(): number {
    // Rounded to 10 mV: a solved supply comes back as 3.3000000000000003 one
    // solve and 3.2999835 the next, and setChipPinDrive compares exactly, so
    // an unrounded level would count as a change after every solve and the
    // re-publish below would ask for solves without end.
    const q = (v: number) => Math.round(v * 100) / 100;
    if (this.componentId) {
      for (const pad of SUPPLY_PADS) {
        const v = padVolts(this.componentId, pad);
        if (v !== null && v > 0.5) return q(v);
      }
    }
    const rail = logicRailVolts();
    return rail !== null && rail > 0.5 ? q(rail) : CHIP_OUTPUT_VCC;
  }

  /**
   * Re-publish the outputs when a solve moves the supply: a chip writes its
   * outputs at setup, before the first solve has a number for its VCC pad, so
   * they started at the fallback level and stayed there. A solve that leaves
   * the supply where it was changes no drive and asks for no new solve.
   */
  private _watchSupply(): void {
    if (this._unwatchSupply || this.disposed) return;
    this._unwatchSupply = onSolve(() => {
      if (this.disposed) return;
      for (const p of this.pins) this._syncSpiceDrive(p);
    });
  }

  private _unwatchSupply: (() => void) | null = null;

  private _pin_register(namePtr: number, mode: number): number {
    const name = readCString(this.memory!, namePtr);
    const handle = this.pins.length;
    const arduinoPin = this.wires.has(name) ? this.wires.get(name)! : null;
    const value: 0 | 1 = mode === ChipInstance.MODE_OUTPUT_HIGH ? 1 : 0;
    const p: PinEntry = { name, mode, arduinoPin, value };
    this.pins.push(p);
    if (this._isBusPin(p)) {
      this._busDrive(p);
    } else if (this._isBoardPin(p)) {
      // VX_OUTPUT_LOW / VX_OUTPUT_HIGH drive their level from here on and a
      // pulled input puts its pull on the wire. A plain VX_OUTPUT drives
      // nothing until the chip writes it or sets its mode again: the same
      // rule as the worker's runtime (wasm_chip_runtime.py), and the one
      // every chip that declares a bus output (a MISO, a TX) and leaves the
      // level to its bus relies on.
      if (mode !== ChipInstance.MODE_OUTPUT) this._boardDrive(p);
    } else if (arduinoPin != null) {
      if (mode === ChipInstance.MODE_OUTPUT_LOW) this.pinManager.triggerPinChange(arduinoPin, false);
      if (mode === ChipInstance.MODE_OUTPUT_HIGH) this.pinManager.triggerPinChange(arduinoPin, true);
    }
    this._syncSpiceDrive(p);
    return handle;
  }

  private _pin_read(handle: number): number {
    const p = this.pins[handle];
    if (!p || p.arduinoPin == null) return 0;
    return this.pinManager.getPinState(p.arduinoPin) ? 1 : 0;
  }

  private _pin_write(handle: number, value: number): void {
    const p = this.pins[handle];
    if (!p || p.arduinoPin == null) return;
    p.value = value !== 0 ? 1 : 0;
    if (this._isBusPin(p)) {
      this._busDrive(p);
    } else if (this._isBoardPin(p)) {
      // The board's own digitalRead sees it through the net's resolution,
      // which the host's digital-write hook feeds into the guest.
      this._boardDrive(p);
    } else {
      this.pinManager.triggerPinChange(p.arduinoPin, value !== 0);
    }
    this._syncSpiceDrive(p);
  }

  /**
   * The voltage on the pin's pad, as the circuit solve publishes it for the
   * pad's net (padVolts): what an ADC model samples. 0 for a pad on no net,
   * or on a net the solve has no number for. It used to answer the pad's PWM
   * duty times five, which is not a voltage of anything on the canvas, while
   * the worker answered the digital level times five (finding
   * vx-pin-read-analog-answers-neither-host-the-solve); both hosts now read
   * the same published number.
   */
  private _pin_read_analog(handle: number): number {
    const p = this.pins[handle];
    if (!p) return 0;
    return padVolts(this.componentId, this._padOf(p)) ?? 0;
  }

  /**
   * 1 when a wire reaches the pin's pad: the diagram puts it on a net, or the
   * host's wiring map resolved it to a board or chip-net pin. A model whose
   * UI control stands in for a missing wire reads the control only when this
   * answers 0.
   */
  private _pin_wired(handle: number): number {
    const p = this.pins[handle];
    if (!p) return 0;
    if (p.arduinoPin != null) return 1;
    return padNet(this.componentId, this._padOf(p)) !== undefined ? 1 : 0;
  }

  /** The component pad a chip pin is (see ChipInstanceOptions.busPads). */
  private _padOf(p: PinEntry): string {
    return this.busPads[p.name] ?? p.name;
  }

  private _pin_dac_write(handle: number, voltage: number): void {
    const p = this.pins[handle];
    if (!p || p.arduinoPin == null) return;
    this.pinManager.setAnalogVoltage(p.arduinoPin, voltage);
    // Electrical mode: the DAC level drives the pin's net at its REAL voltage
    // (the digital _syncSpiceDrive path only knows rail-or-ground).
    if (this.componentId && p.name && isSyntheticChipPin(p.arduinoPin) && !this._isBusPin(p)) {
      if (setChipPinDrive(this.componentId, p.name, voltage)) requestElectricalResolve();
    }
    // Board ADC path: nothing subscribes to PinManager's analog listeners in
    // production, so the part host forwards this into setAdcVoltage.
    this._onDacWrite?.(p.name, voltage);
  }

  /** Report a PWM duty on the pin's net. Deliberately NOT a drive: the duty
   *  says how hard the output is being chopped, while the digital level (and
   *  with it the SPICE drive) stays wherever vx_pin_write left it. */
  private _pin_pwm_write(handle: number, duty: number): void {
    const p = this.pins[handle];
    if (!p || p.arduinoPin == null) return;
    const clamped = duty < 0 ? 0 : duty > 1 ? 1 : duty;
    this.pinManager.updatePwm(p.arduinoPin, clamped);
    this._onPwmWrite?.(p.name, clamped);
  }

  /** Register the host-side DAC forwarding hook. */
  onDacWrite(cb: (pinName: string, voltage: number) => void): void {
    this._onDacWrite = cb;
  }

  /** Register the host-side PWM forwarding hook. */
  onPwmWrite(cb: (pinName: string, duty: number) => void): void {
    this._onPwmWrite = cb;
  }

  /** Register the host-side digital-output forwarding hook. */
  onDigitalWrite(cb: (pinName: string, value: boolean) => void): void {
    this._onDigitalWrite = cb;
  }

  /** Live attribute update (sensor control panel). vx_attr_read re-reads the
   *  map on every call, so the running WASM sees the new value immediately. */
  setAttr(name: string, value: number): void {
    this.attrs.set(name, value);
  }

  private _pin_set_mode(handle: number, mode: number): void {
    const p = this.pins[handle];
    if (!p) return;
    p.mode = mode;
    // OUTPUT_LOW/HIGH carry an initial level; plain OUTPUT keeps the last value.
    if (mode === ChipInstance.MODE_OUTPUT_LOW) p.value = 0;
    if (mode === ChipInstance.MODE_OUTPUT_HIGH) p.value = 1;
    if (this._isBusPin(p)) {
      this._busDrive(p);
    } else if (this._isBoardPin(p)) {
      // VX_INPUT (and the pulled inputs) is the documented tri-state idiom:
      // the chip lets go of the board pin and the pull restores the level.
      // It used to change the mode and nothing else, so the board kept
      // reading the chip's last level (finding
      // chip-release-to-input-keeps-board-pin-driven).
      this._boardDrive(p);
    } else if (p.arduinoPin != null) {
      if (mode === ChipInstance.MODE_OUTPUT_LOW)  this.pinManager.triggerPinChange(p.arduinoPin, false);
      if (mode === ChipInstance.MODE_OUTPUT_HIGH) this.pinManager.triggerPinChange(p.arduinoPin, true);
    }
    this._syncSpiceDrive(p);
  }

  private _pin_watch(handle: number, edge: number, cbIdx: number, userData: number): void {
    const p = this.pins[handle];
    if (!p || p.arduinoPin == null) return;
    let lastState = this.pinManager.getPinState(p.arduinoPin) ? 1 : 0;
    // The callback, resolved from the function table on the first edge and
    // kept: WebAssembly.Table.get on every edge was the dearest step of a
    // watch that a bit-banged clock fires millions of times. The entry cannot
    // move under a running chip (C code never rewrites the table, and a
    // re-instantiated module drops its watches with the instance).
    let cached: WebAssembly.Table | undefined;
    let fn: ((ud: number, pin: number, value: number) => void) | null = null;
    const unsub = this.pinManager.onPinChange(p.arduinoPin, (_pin, state) => {
      const newState = state ? 1 : 0;
      const isRising = lastState === 0 && newState === 1;
      const isFalling = lastState === 1 && newState === 0;
      lastState = newState;
      const wantRising  = (edge & 1) !== 0;
      const wantFalling = (edge & 2) !== 0;
      if ((isRising && wantRising) || (isFalling && wantFalling)) {
        const table = this.exports?.__indirect_function_table as WebAssembly.Table | undefined;
        if (!table) return;
        if (table !== cached) {
          cached = table;
          fn = table.get(cbIdx) as ((ud: number, pin: number, value: number) => void) | null;
        }
        if (fn) {
          try { fn(userData, handle, newState); } catch { /* swallow */ }
        }
        this.wasi.flush();
      }
    });
    if (!this._pinWatches.has(handle)) this._pinWatches.set(handle, new Set());
    this._pinWatches.get(handle)!.add(unsub);
  }

  private _pin_watch_stop(handle: number): void {
    const set = this._pinWatches.get(handle);
    if (!set) return;
    for (const u of set) u();
    this._pinWatches.delete(handle);
  }

  // ── Attributes ───────────────────────────────────────────────────────────

  private _attr_register(namePtr: number, defaultVal: number): number {
    const name = readCString(this.memory!, namePtr);
    const handle = this.attrHandles.length;
    this.attrHandles.push({ name, default: defaultVal });
    if (!this.attrs.has(name)) this.attrs.set(name, defaultVal);
    return handle;
  }

  private _attr_read(handle: number): number {
    const a = this.attrHandles[handle];
    if (!a) return 0;
    const live = this.liveAttrs?.(a.name);
    if (typeof live === 'number') return live;
    return this.attrs.get(a.name) ?? a.default;
  }

  /** String attributes: values come from chip.json / the diagram editor
   *  (strAttrs option); the chip only reads them. Handles share the numeric
   *  attr handle space (they are distinct vx_attr ints on the chip side). */
  private _attr_register_string(namePtr: number, defaultPtr: number): number {
    const name = readCString(this.memory!, namePtr);
    const dflt = readCString(this.memory!, defaultPtr);
    const handle = this.attrHandles.length;
    this.attrHandles.push({ name, default: 0, stringDefault: dflt });
    return handle;
  }

  private _attr_string_value(handle: number): string {
    const a = this.attrHandles[handle];
    if (!a || a.stringDefault === undefined) return '';
    const live = this.liveAttrs?.(a.name);
    if (typeof live === 'string') return live;
    return this.strAttrs.get(a.name) ?? a.stringDefault;
  }

  private _attr_string_read(handle: number, bufPtr: number, cap: number): number {
    if (!this.memory || cap <= 0) return 0;
    const bytes = new TextEncoder().encode(this._attr_string_value(handle));
    const n = Math.min(bytes.length, cap - 1 >= 0 ? cap - 1 : 0);
    const dst = new Uint8Array(this.memory.buffer, bufPtr, cap);
    dst.set(bytes.subarray(0, n));
    if (n < cap) dst[n] = 0;
    return n;
  }

  // ── I2C ──────────────────────────────────────────────────────────────────

  /**
   * vx_i2c_attach: THIS is where a chip enters an I2C bus, with the SDA and
   * SCL its config names. The fabric puts it on the bus those pads are wired
   * to, so a chip on Wire1 answers Wire1, a chip whose SDA/SCL go nowhere
   * answers nobody (as on the bench), and a chip whose pins go to two GPIOs is
   * served by the software decoder. Every address a chip attaches on the same
   * pins is one target: they all answer, and they all leave with the chip.
   *
   * Returns 0 like the worker's runtime (wasm_chip_runtime.py), so a chip
   * reads the same handle in every host.
   */
  private _i2c_attach(cfgPtr: number): number {
    const cfg = readI2CConfig(this.memory!, cfgPtr);
    this._busOwnsPin(cfg.sda);
    this._busOwnsPin(cfg.scl);
    const callFn = (idx: number, ...args: any[]) => {
      const table = this.exports?.__indirect_function_table as WebAssembly.Table | undefined;
      if (!table) return 0;
      const fn = table.get(idx) as ((...a: any[]) => any) | null;
      if (!fn) return 0;
      try { return fn(...args); } catch { return 0; }
    };

    /* Which phase of a transaction the chip has been told about. A chip is
       addressed for writing or for reading, and it has to know WHICH — a
       display waits for its command byte, a memory stages the bytes it is
       about to hand over.
       The bus fabric announces it: every START and repeated START that names
       this address calls connect(). The byte stream carries it exactly as
       well, and the phase is read off it too, so no caller of the device can
       skip it:
       the first write after anything else IS the write phase starting, and
       the first read after a write IS a REPEATED START, the master keeping
       the bus and turning it around.
       That last one was silently missing. Only a STOP used to re-arm the
       announcement, so `Wire.endTransmission(false)` followed by requestFrom()
       — the idiom Adafruit_BusIO's write_then_read() and half the drivers out
       there use — never reached the chip's on_connect: the register pointer
       just written was never applied and the read was served from the
       PREVIOUS staged buffer. The ST25DV example asked the tag for IC_REF at
       0x0017 and got the byte at 0x0018, every time. */
    type Phase = 'idle' | 'write' | 'read';
    let phase: Phase = 'idle';
    const enter = (isRead: boolean): void => {
      if (cfg.on_connect) callFn(cfg.on_connect, cfg.user_data, cfg.address, isRead ? 1 : 0);
      phase = isRead ? 'read' : 'write';
    };
    const device: ChipI2cDevice = {
      address: cfg.address,
      /** Masters that DO announce the phase call this; the rest are covered
       *  by the inference in writeByte / readByte, and this keeps them from
       *  announcing it twice. */
      connect: (_addr: number, isRead: boolean): boolean => {
        enter(!!isRead);
        this.wasi.flush();
        return true;
      },
      writeByte: (value: number): boolean => {
        if (phase !== 'write') enter(false);
        const ack = !!callFn(cfg.on_write, cfg.user_data, value);
        this.wasi.flush();
        return ack;
      },
      readByte: (): number => {
        if (phase !== 'read') enter(true);
        const b = callFn(cfg.on_read, cfg.user_data) & 0xff;
        this.wasi.flush();
        return b;
      },
      stop: (): void => {
        if (cfg.on_stop) callFn(cfg.on_stop, cfg.user_data);
        phase = 'idle';
        this.wasi.flush();
      },
    };

    const entry: I2cDeviceEntry = {
      cfg,
      scl: this._busPad(cfg.scl),
      sda: this._busPad(cfg.sda),
      device,
    };
    this.i2cDevices.push(entry);
    if (!entry.scl || !entry.sda) {
      // No pad to resolve: nothing on a bench would ever clock it either.
      this.wasi.writeStdout(
        `vx_i2c_attach at 0x${cfg.address.toString(16)} names no SDA/SCL pin; the chip is on no bus\n`,
      );
      return 0;
    }
    let group = this.i2cGroups.find((g) => g.scl === entry.scl && g.sda === entry.sda);
    if (!group) {
      // The first pair is the chip itself, under its component id: that is
      // the identity a QEMU worker's copy of the chip carries too.
      const owner = this.i2cGroups.length === 0 ? this.componentId : `${this.componentId}:i2c${this.i2cGroups.length}`;
      group = { owner, scl: entry.scl, sda: entry.sda, entries: [], bus: null };
      this.i2cGroups.push(group);
    }
    group.entries.push(entry);
    // A later attach replaces the registration with one that has every
    // address (the registry drops the owner's previous one first).
    if (!this.inSetup) group.bus = this._joinI2cBus(group);
    return 0;
  }

  /** The canvas pad of a chip pin handle, for the fabric's wire walk. */
  private _busPad(handle: number): string | undefined {
    const p = handle >= 0 ? this.pins[handle] : undefined;
    if (!p || !p.name) return undefined;
    return this.busPads[p.name] ?? p.name;
  }

  /**
   * Put one pair of pins on the bus. Null when the chip has no canvas
   * identity to resolve its wires against.
   *
   * The target dispatches by address: the fabric only calls it for one of the
   * addresses it registered, and the device that owns that address takes the
   * phase. The STOP goes to every device addressed since the last one.
   */
  private _joinI2cBus(group: I2cGroup): BusHandle | null {
    if (!this.componentId) return null;
    const byAddress = new Map<number, ChipI2cDevice>();
    // Two attaches at one address: the later one answers, as it did before.
    for (const e of group.entries) byAddress.set(e.cfg.address & 0x7f, e.device);
    let current: ChipI2cDevice | null = null;
    const touched = new Set<ChipI2cDevice>();
    const target: I2cTarget = {
      // The chip's own code answers each byte and may refuse one, so a host
      // that ACKs writes ahead of this tab (the Pi relay) has to ask.
      mayNak: true,
      start: (address, read) => {
        current = byAddress.get(address & 0x7f) ?? null;
        if (!current) return false;
        touched.add(current);
        // on_connect's return is not the ACK, in this host or the worker's.
        return current.connect(address, read);
      },
      write: (byte) => (current ? current.writeByte(byte) : false),
      read: () => (current ? current.readByte() : 0xff),
      stop: () => {
        current = null;
        const list = Array.from(touched);
        touched.clear();
        for (const d of list) d.stop();
      },
      // The MCU reset mid-transaction: the chip sees the STOP it will never
      // get, and nothing else. Its data is its own.
      boardReset: () => {
        if (touched.size === 0) return;
        current = null;
        const list = Array.from(touched);
        touched.clear();
        for (const d of list) d.stop();
      },
    };
    return attachI2cTarget(
      {
        owner: group.owner,
        componentId: this.componentId,
        pins: { scl: group.scl, sda: group.sda },
        addresses: Array.from(byAddress.keys()),
        remoteModel: this.remoteModel,
      },
      target,
    );
  }

  // ── UART ─────────────────────────────────────────────────────────────────

  /**
   * vx_uart_attach: THIS is where a chip gets on a UART wire, with the RX and
   * TX pads its config names, as vx_spi_attach and vx_i2c_attach do for their
   * buses. The fabric walks the wires from each pad: the RX pad hears whatever
   * transmits on the board pin it reaches (a controller's TX, or a GPIO the
   * sketch bit-bangs on the guest's clock), the TX pad drives the wire it
   * reaches (a controller's RX, or edges on a plain GPIO), and a pad wired to
   * nothing is on no wire at all. There is no USART0 or Serial1 to fall back
   * to. The rate is the chip's own (`baud_rate`): what the fabric checks the
   * controller against, and the bit time a pad on a plain GPIO is clocked at.
   *
   * Until board-buses F6 the part that hosts the chip did this attach, after
   * start(), from the pads it asked the chip for, and skipped the ESP32 kind
   * so an overlay extension could do the same job there; two hosts for one
   * registration, and a third would have been needed for every new one. The
   * chip's own call is the one place that knows the pads, so it registers.
   *
   * The handle is the index, as before: chips key their writes by it.
   */
  private _uart_attach(cfgPtr: number): number {
    const cfg = readUartConfig(this.memory!, cfgPtr);
    this._busOwnsPin(cfg.tx);
    const handle = this.uarts.length;
    const entry: UartEntry = { cfg, bus: null };
    this.uarts.push(entry);
    // During chip_setup the pads may not all be registered yet, and the SPI
    // and I2C joins wait for start() to finish it too; a handle attached
    // later (from a timer) joins straight away.
    if (!this.inSetup) entry.bus = this._joinUartBus(entry, handle);
    return handle;
  }

  /**
   * Put one UART handle on the wires its pads reach. Null when the chip has
   * no canvas identity to resolve its wires against, or names no pad at all.
   */
  private _joinUartBus(entry: UartEntry, handle: number): UartHandle | null {
    if (!this.componentId) return null;
    const rx = this._busPad(entry.cfg.rx);
    const tx = this._busPad(entry.cfg.tx);
    if (!rx && !tx) {
      // No pad to resolve: nothing on a bench would ever reach it either.
      this.wasi.writeStdout('vx_uart_attach names no RX/TX pin; the chip is on no wire\n');
      return null;
    }
    return attachUartEndpoint(
      {
        owner: chipUartOwner(this.componentId, handle),
        componentId: this.componentId,
        pins: { ...(rx ? { rx } : {}), ...(tx ? { tx } : {}) },
        baud: entry.cfg.baud_rate > 0 ? entry.cfg.baud_rate : 9600,
      },
      { receive: (byte) => this.feedUart(byte, handle) },
    );
  }

  private _uart_write(handle: number, bufPtr: number, count: number): number {
    const u = this.uarts[handle];
    if (!u) return 0;
    const u8 = new Uint8Array(this.memory!.buffer);
    const bytes = u8.slice(bufPtr, bufPtr + count);
    for (const b of bytes) {
      // The wire: the fabric puts the byte on the TX pad's net (into the
      // controller whose RX is there, or as edges on a plain GPIO), unless
      // another copy of this chip is the one driving it right now.
      if (!this.drivesWires || this.drivesWires()) u.bus?.transmit(b);
      // The host's ear, if it has one.
      this._uartTxListener?.(b);
    }
    if (u.cfg.on_tx_done) {
      const table = this.exports?.__indirect_function_table as WebAssembly.Table | undefined;
      const fn = table?.get(u.cfg.on_tx_done) as ((ud: number) => void) | null;
      if (fn) {
        try { fn(u.cfg.user_data); } catch { /* swallow */ }
      }
    }
    this.wasi.flush();
    return 1;
  }

  /** A byte arriving at the chip's RX pad (the fabric's delivery; tests feed it directly). */
  feedUart(byte: number, handle = 0): void {
    const u = this.uarts[handle];
    if (!u || !u.cfg.on_rx_byte) return;
    const table = this.exports?.__indirect_function_table as WebAssembly.Table | undefined;
    const fn = table?.get(u.cfg.on_rx_byte) as ((ud: number, byte: number) => void) | null;
    if (fn) {
      try { fn(u.cfg.user_data, byte & 0xff); } catch { /* swallow */ }
    }
    this.wasi.flush();
  }

  /**
   * Hear every byte the chip transmits, on any handle, after the fabric has
   * had it. An observer: it does not stand in for the wire, and a host that
   * puts what it hears back on a bus of its own sends every byte twice.
   */
  onUartTx(cb: (byte: number) => void): void {
    this._uartTxListener = cb;
  }

  /**
   * Where a declared UART's TX physically goes: the board pin its TX chip-pin
   * is wired to (null when unwired/synthetic) and the configured baud.
   */
  getUartTxRoute(handle = 0): { txArduinoPin: number | null; baud: number } | null {
    const u = this.uarts[handle];
    if (!u) return null;
    const pin = this.pins[u.cfg.tx];
    return {
      txArduinoPin: pin?.arduinoPin ?? null,
      baud: u.cfg.baud_rate > 0 ? u.cfg.baud_rate : 9600,
    };
  }

  /**
   * The chip pad names a UART was attached with (`vx_uart_config.rx/.tx`).
   * Null pads for handles the chip never registered. The names, not the pin
   * numbers: a host that cannot run the chip beside its guest (a QEMU board)
   * reads them off an inert copy and places them on the fabric itself.
   */
  getUartPads(handle = 0): { rxPad: string | null; txPad: string | null } | null {
    const u = this.uarts[handle];
    if (!u) return null;
    return {
      rxPad: this.pins[u.cfg.rx]?.name ?? null,
      txPad: this.pins[u.cfg.tx]?.name ?? null,
    };
  }

  /**
   * Hand the chip one write phase it did not see on a bus: a QEMU worker that
   * only ACKs a display's writes echoes them, and this copy of the chip draws
   * from them. Addressed, written and stopped exactly as the bus would. False
   * when the chip attached no device at that address.
   */
  replayI2cWrite(address: number, data: readonly number[]): boolean {
    let dev: ChipI2cDevice | undefined;
    for (const e of this.i2cDevices) if ((e.cfg.address & 0x7f) === (address & 0x7f)) dev = e.device;
    if (!dev) return false;
    dev.connect(address, false);
    for (const b of data) dev.writeByte(b & 0xff);
    dev.stop();
    return true;
  }

  /**
   * The chip's side of the bus at one address, for a host that puts the chip
   * on a bus of its own making instead of the fabric (a part that hosts a
   * compiled model where it used to host a hand-written one): START, the
   * bytes and STOP go straight to the callbacks, exactly as the fabric's
   * target would deliver them. Null when the chip attached no such address.
   */
  i2cDevice(address: number): {
    connect(address: number, isRead: boolean): boolean;
    writeByte(value: number): boolean;
    readByte(): number;
    stop(): void;
  } | null {
    let dev: ChipI2cDevice | null = null;
    for (const e of this.i2cDevices) if ((e.cfg.address & 0x7f) === (address & 0x7f)) dev = e.device;
    return dev;
  }

  /** True if the chip declared at least one UART (post-chip_setup). */
  get hasUart(): boolean {
    return this.uarts.length > 0;
  }

  // ── SPI ──────────────────────────────────────────────────────────────────

  /**
   * vx_spi_attach: THIS is where a chip joins an SPI bus, not where its part
   * mounts. A model that never calls it (every UART-only and I2C-only Grove
   * module) now takes no part in SPI at all, which is what issue #355 was
   * about (findings grove-chip-takes-spi-on-rp-and-xiao-arm,
   * customchip-setspihandler-steals-bus0).
   *
   * The pins of the chip's own config decide which bus it lands on and when it
   * is selected: the fabric resolves them through the circuit's nets and only
   * clocks the chip while its chip select is active. `cs = NO_PIN` (-1) means
   * the chip has no select line, like a 74HC595 whose SER/SRCLK shift whatever
   * the bus carries. Handles are independent devices: a chip with two of them
   * is two owners on the bus, each with its own buffer and its own select.
   */
  private _spi_attach(cfgPtr: number): number {
    const cfg = readSpiConfig(this.memory!, cfgPtr);
    this._busOwnsPin(cfg.miso);
    const handle = this.spiDevices.length;
    // The completion is handed THIS handle's buffer pointer. It used to be an
    // instance-wide field, so the last vx_spi_start of any handle decided what
    // every on_done saw (finding spi-done-bufptr-shared).
    const device = new SPIDevice(
      () => new Uint8Array(this.memory!.buffer),
      (bufPtr, count) => {
        if (!cfg.on_done) return;
        const table = this.exports?.__indirect_function_table as WebAssembly.Table | undefined;
        const fn = table?.get(cfg.on_done) as ((ud: number, buf: number, c: number) => void) | null;
        if (fn) {
          try { fn(cfg.user_data, bufPtr, count); } catch { /* swallow */ }
        }
        this.wasi.flush();
      },
    );
    const entry: SpiEntry = { device, cfg, bus: null };
    this.spiDevices.push(entry);
    // During chip_setup the join waits for start() to finish it (see
    // _joinSpiBus); a handle attached later joins straight away.
    if (!this.inSetup) entry.bus = this._joinSpiBus(entry, handle);
    return handle;
  }

  /**
   * Put one SPI handle on the bus its pins are wired to. Null when the chip has
   * no clock pin, or no canvas identity to resolve its wires against.
   *
   * Called after chip_setup, never inside it, so the chip's own CS watch is
   * registered on that pin BEFORE the bus's. The order is what a real chip
   * does: it puts its first MISO bit on the wire as CS falls, so it has to have
   * armed its answer by the time the bus asks what it will shift out (a
   * bit-banged master reads that bit before the first clock edge).
   */
  private _joinSpiBus(entry: SpiEntry, handle: number): BusHandle | null {
    const { cfg } = entry;
    const pinName = (h: number): string | undefined => {
      const p = h >= 0 ? this.pins[h] : undefined;
      return p && p.name ? p.name : undefined;
    };
    const sck = pinName(cfg.sck);
    if (!this.componentId || !sck) return null;
    const drivesMiso = pinName(cfg.miso) !== undefined;
    return attachSpiDevice(
      {
        owner: `${this.componentId}:spi${handle}`,
        componentId: this.componentId,
        pins: { sck, mosi: pinName(cfg.mosi), miso: pinName(cfg.miso), cs: pinName(cfg.cs) },
        // The mode the chip was written for, and the order it shifts in: the
        // ABI has no bit-order field (velxio-chip.h: a chip exchanges bytes
        // MSB first, the way every part datasheet the gallery models does), so
        // the order is stated here rather than left to the bus's default. The
        // bus compares both with the controller's and reports a mismatch
        // (`spi-mode`, `spi-bit-order`, D-011) instead of exchanging bytes
        // that would come out shifted on hardware. The clock rate has no
        // chip-side counterpart either: a controller reports its rate in its
        // config (`SpiControllerConfig.hz`) and a chip has nothing to hold
        // against it, so nothing is dropped here.
        modes: [(cfg.mode & 3) as SpiMode],
        bitOrder: 'msb',
      },
      {
        // The bus only calls a device while it is selected; what gates the
        // bytes on this side is the chip's own arming (vx_spi_start /
        // vx_spi_stop), the documented Wokwi-compatible contract, which the
        // chip drives from its own pin watch. The bus's select edges are put
        // on that pin so the watch fires under a hardware chip select too.
        select: () => this._mirrorSelect(entry, true),
        deselect: () => this._mirrorSelect(entry, false),
        transfer: (mosi) =>
          drivesMiso
            ? this._spiExchange(entry, mosi) ?? entry.device.transfer(mosi)
            : this._spiSink(entry, mosi),
        peekMiso: () => (drivesMiso ? entry.device.peek() : null),
        // The MCU reset: the transaction in flight is over, as it is when CS
        // is released. Protocol state only: the chip's own data is its own.
        boardReset: () => entry.device.stopTransfer(),
      },
    );
  }

  /**
   * The bus's select edge, put on the chip's own CS pin when the pad does not
   * carry it.
   *
   * The ABI tells a chip about its select in one way: the pin watch it puts
   * on its CS pin (velxio-chip.h). A controller that drives its select in
   * hardware never moves that pad (the PL022 of the RP2040 and RP2350 raises
   * CSn inside the peripheral; the Pi's controller mirrors CE0 onto the pad,
   * which is why the header path never showed this), so the bus knew the
   * transaction boundary and the chip did not: a frame-oriented model was
   * right for one transaction and out of step for every one after
   * (mcp3008-portable "reads the same code on the next hardware-chip-select
   * transaction"). Silicon sees its CS leg move whichever block of the MCU
   * drives it, and so does the chip now.
   *
   * A no-op when the PinManager already carries the level: a GPIO select
   * reaches it through the engine's own level channel, and a pad it has
   * already moved must not move twice (the watch counts edges). A select that
   * was never driven idles high, the pull-up of every breakout, so the first
   * assertion of a hardware select is a falling edge for the chip, as it is
   * on the bench.
   */
  private _mirrorSelect(entry: SpiEntry, active: boolean): void {
    const p = entry.cfg.cs >= 0 ? this.pins[entry.cfg.cs] : undefined;
    if (!p || p.arduinoPin == null) return;
    // The ABI's select is active low: the bus clocks the chip while the pin is low.
    const level = !active;
    const current = this.pinManager.peekPinState(p.arduinoPin);
    if (current === level) return;
    if (current === undefined && !level) this.pinManager.triggerPinChange(p.arduinoPin, true);
    this.pinManager.triggerPinChange(p.arduinoPin, level);
  }

  /**
   * A chip that answers each byte as it arrives (velxio-chip.h `on_exchange`)
   * is asked here, with the whole byte, and its answer is the MISO for THAT
   * byte. Undefined when the chip has no such callback, so the buffer contract
   * applies. The armed buffer is left alone on purpose: it is the look-ahead
   * `peekMiso` serves a bit-banged master, and the chip refreshes it itself.
   * The Python host does the same (wasm_chip_runtime.spi_transfer_byte), so a
   * chip answers the same bytes in the tab, in a QEMU worker and beside a
   * Linux guest.
   */
  private _spiExchange(entry: SpiEntry, mosi: number): number | undefined {
    const idx = entry.cfg.on_exchange;
    if (!idx) return undefined;
    const table = this.exports?.__indirect_function_table as WebAssembly.Table | undefined;
    const fn = table?.get(idx) as ((ud: number, b: number) => number) | null;
    if (!fn) return undefined;
    let miso = 0xff;
    try {
      miso = fn(entry.cfg.user_data, mosi & 0xff) & 0xff;
    } catch {
      /* a chip that traps leaves the line at its idle level */
    }
    this.wasi.flush();
    return miso;
  }

  /** A handle with no MISO pin receives the master's bytes and drives nothing. */
  private _spiSink(entry: SpiEntry, mosi: number): null {
    // A chip that takes its bytes through `on_exchange` takes them that way
    // whether or not its MISO leg is wired; only the answer is dropped.
    if (this._spiExchange(entry, mosi) === undefined) entry.device.transfer(mosi);
    return null;
  }

  private _spi_start(handle: number, bufPtr: number, count: number): void {
    const entry = this.spiDevices[handle];
    if (!entry) return;
    entry.device.startTransfer(bufPtr, count);
  }

  private _spi_stop(handle: number): void {
    const entry = this.spiDevices[handle];
    if (!entry) return;
    entry.device.stopTransfer();
  }

  // ── Framebuffer ──────────────────────────────────────────────────────────

  private _framebuffer_init(widthPtr: number, heightPtr: number): number {
    const w = this.display?.width ?? 128;
    const h = this.display?.height ?? 64;
    if (!this._framebuffer) {
      this._framebuffer = { rgba: new Uint8Array(w * h * 4), width: w, height: h };
    }
    if (this.memory) {
      const dv = new DataView(this.memory.buffer);
      dv.setUint32(widthPtr, w, true);
      dv.setUint32(heightPtr, h, true);
    }
    return 0;
  }

  private _buffer_read(_handle: number, offset: number, dataPtr: number, dataLen: number): void {
    if (!this._framebuffer || !this.memory) return;
    const src = this._framebuffer.rgba;
    const end = Math.min(offset + dataLen, src.length);
    const copyLen = Math.max(0, end - offset);
    if (copyLen <= 0) return;
    const dst = new Uint8Array(this.memory.buffer, dataPtr, copyLen);
    dst.set(src.subarray(offset, end));
  }

  private _buffer_write(_handle: number, offset: number, dataPtr: number, dataLen: number): void {
    if (!this._framebuffer || !this.memory) return;
    const src = new Uint8Array(this.memory.buffer, dataPtr, dataLen);
    const dst = this._framebuffer.rgba;
    const end = Math.min(offset + dataLen, dst.length);
    const copyLen = Math.max(0, end - offset);
    if (copyLen > 0) dst.set(src.subarray(0, copyLen), offset);
    if (this._onFramebufferUpdate) {
      try {
        this._onFramebufferUpdate(this._framebuffer.rgba, this._framebuffer.width, this._framebuffer.height);
      } catch { /* swallow */ }
    }
  }

  /** Subscribe to framebuffer paint events. The callback fires after each
   *  vx_buffer_write, with the full RGBA buffer (consumer can blit it to a
   *  canvas). */
  onFramebufferUpdate(cb: (rgba: Uint8Array, w: number, h: number) => void): void {
    this._onFramebufferUpdate = cb;
    // Fire once with the current state so the canvas reflects what's already there.
    if (this._framebuffer) {
      try { cb(this._framebuffer.rgba, this._framebuffer.width, this._framebuffer.height); } catch { /* swallow */ }
    }
  }

  /** True if the chip declared a framebuffer (post-chip_setup). */
  get hasFramebuffer(): boolean {
    return this._framebuffer !== null;
  }

  // ── Keyboard (chips that export set_key, e.g. galaksija-keyboard) ─────────

  /** True if the chip exposes a host-driven keyboard via an exported
   *  `set_key(offset, down)`. The host (CustomChipPart) bridges browser key
   *  events into it. */
  get hasKeyboard(): boolean {
    return typeof this.exports?.set_key === 'function';
  }

  /** Push a key state into the chip's key table. `offset` is the chip-specific
   *  matrix offset; `down` is press/release. No-op if the chip has no keyboard. */
  setKey(offset: number, down: boolean): void {
    try {
      this.exports?.set_key?.(offset, down ? 1 : 0);
    } catch {
      /* swallow chip errors */
    }
  }

  // ── Timers ───────────────────────────────────────────────────────────────

  private _timer_create(cbIdx: number, userData: number): number {
    const handle = this.timers.length;
    this.timers.push({
      cbIdx,
      userData,
      active: false,
      period: 0n,
      nextFire: 0n,
      repeat: false,
      cancel: null,
    });
    return handle;
  }

  /**
   * The deadline is one period from the chip's clock now (a timer started
   * from a timer callback counts from that callback's deadline, so a chain
   * of one-shots keeps an exact cadence), and it is armed on the guest's
   * event queue so the callback runs at that cycle, between the guest's
   * instructions, not at the next animation frame.
   */
  private _timer_start(handle: number, periodNanos: bigint, repeat: number): void {
    const t = this.timers[handle];
    if (!t) return;
    t.period = BigInt(periodNanos);
    t.repeat = !!repeat;
    t.nextFire = this._nowNanos() + t.period;
    t.active = true;
    this._armTimer(t);
  }

  private _timer_stop(handle: number): void {
    const t = this.timers[handle];
    if (!t) return;
    t.active = false;
    t.cancel?.();
    t.cancel = null;
  }
}
