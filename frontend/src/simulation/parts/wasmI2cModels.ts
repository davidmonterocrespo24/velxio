/**
 * I2C parts answered by their compiled model (project
 * i2c-model-fidelity-2026-09, P5, decision O4).
 *
 * The microSD card already runs as ONE model in C (buses/models/microsd.c)
 * that the tab, the QEMU workers and the Linux-board host all run. The two
 * real-time clocks, the BMP280 and the MPU-6050 now do too:
 * buses/models/ds1307.c and ds3231.c (on the shared buses/models/rtc.h),
 * bmp280.c and mpu6050.c, hosted here by ChipRuntime in place of
 * VirtualDS1307, VirtualDS3231, VirtualBMP280 and VirtualMPU6050, and in the
 * worker from the same bytes (backend/app/services/wasm_i2c_models.py), which
 * the part puts in the worker's record (`wasmB64`).
 *
 * On by default. `?i2cwasm=off` or localStorage `velxio.i2cwasm = 'off'` goes
 * back to the hand-written models in both hosts; a comma list
 * (`?i2cwasm=ds3231`) runs only the models it names. A model that cannot be
 * built keeps the hand-written one for that part, and a record without the
 * bytes keeps the worker's Python twin, so neither the flag nor a broken
 * build can cost a user the part.
 *
 * The bytes are compiled into the bundle (buses/models/i2cModelBytes
 * .generated.ts, written by build.sh): a part attaches synchronously and has
 * to answer the guest's first START, so its model cannot wait for a fetch.
 */
import { ChipInstance } from '../customChips/ChipRuntime';
import { PinManager } from '../PinManager';
import { I2C_MODEL_WASM_B64 } from '../buses/models/i2cModelBytes.generated';
import type { GuestClock } from '../buses/types';
import {
  DS1307_RULES,
  DS3231_RULES,
  hostWallClock,
  type I2CDevice,
  type RtcDateTime,
  type RtcOptions,
} from '../I2CBusManager';

export type WasmI2cModelName = keyof typeof I2C_MODEL_WASM_B64;

/** The models that run compiled unless the flag says otherwise. */
const DEFAULT_ON: readonly WasmI2cModelName[] = ['ds1307', 'ds3231', 'bmp280', 'mpu6050'];
/** Flag values that name no model at all. */
const OFF = new Set(['off', 'none', '0', 'false']);

let testOverride: ReadonlySet<string> | null = null;

/** Test seam: the models the flag names, or null for the real flag. */
export function setWasmI2cModelsForTest(names: readonly string[] | null): void {
  testOverride = names === null ? null : new Set(names);
}

/** Whether `name` runs from its compiled model. */
export function wasmI2cModelEnabled(name: string): boolean {
  if (testOverride !== null) return testOverride.has(name);
  let v: string | null = null;
  try {
    if (typeof window !== 'undefined' && window.location) {
      v = new URLSearchParams(window.location.search).get('i2cwasm');
    }
    if (v === null && typeof localStorage !== 'undefined')
      v = localStorage.getItem('velxio.i2cwasm');
  } catch {
    /* SecurityError on localStorage, missing globals in tests */
  }
  if (v === null || v.trim() === '') return (DEFAULT_ON as readonly string[]).includes(name);
  const names = v
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (names.some((n) => OFF.has(n))) return false;
  return names.includes(name);
}

const modules = new Map<string, WebAssembly.Module | null>();

function decodeB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The compiled model, built once per page on first use: a few kilobytes,
 * which every current browser compiles synchronously on the main thread.
 * Null when it cannot be built, and then the part keeps its hand-written
 * model (said once).
 */
export function wasmI2cModule(name: string): WebAssembly.Module | null {
  if (modules.has(name)) return modules.get(name)!;
  const b64 = (I2C_MODEL_WASM_B64 as Record<string, string>)[name];
  let m: WebAssembly.Module | null = null;
  if (b64) {
    try {
      m = new WebAssembly.Module(decodeB64(b64) as BufferSource);
    } catch (e) {
      console.warn(`[i2c-models] ${name}.wasm could not be compiled; the part keeps its own model`, e);
    }
  }
  modules.set(name, m);
  return m;
}

/** The model's bytes for the worker's record. */
export function wasmI2cModelB64(name: string): string | null {
  return (I2C_MODEL_WASM_B64 as Record<string, string>)[name] ?? null;
}

/** Test seam: hand a compiled model over directly (null: it cannot be built). */
export function primeWasmI2cModel(name: string, module: WebAssembly.Module | null): void {
  modules.set(name, module);
}

/** Test seam: forget the compiled models. */
export function resetWasmI2cModelsForTest(): void {
  modules.clear();
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Build times as the model reads them: "YYYYMMDDhhmmss" each. */
function buildTimesText(times: readonly RtcDateTime[]): string {
  return times
    .map(
      (b) =>
        `${String(b.year).padStart(4, '0')}${pad2(b.month)}${pad2(b.day)}` +
        `${pad2(b.hour)}${pad2(b.minute)}${pad2(b.second)}`,
    )
    .join(' ');
}

/**
 * A clock chip from buses/models/rtc.h, with the API of VirtualRtc: the same
 * options (the host's clock, the build times), the bus, and the register dump
 * the Pi relay mirrors. Every call on the bus goes through ChipRuntime's own
 * I2C device, the one the fabric reaches a custom chip through, so the model
 * hears what a custom chip would.
 *
 * The host's clock and the panel's temperature are pushed into the model's
 * `rtc_inputs` (the export chip_inputs), the clock before every event: the
 * model never calls out for them. Only the build times are asked for, when a
 * sketch has written a time, because finding them scans the firmware image.
 */
abstract class WasmRtc implements I2CDevice {
  public address = 0x68;
  /** The register the pointer wraps after (I2cTarget.pointerWrapsAfter). */
  readonly pointerWrapsAfter: number;

  protected readonly chip: ChipInstance;
  private readonly dev: NonNullable<ReturnType<ChipInstance['i2cDevice']>>;
  private readonly clock: () => number;
  private readonly inputsAt: number;
  private view: DataView | null = null;

  protected constructor(
    module: WebAssembly.Module,
    options: RtcOptions,
    temperature: number,
    rules: { readonly power_on: Readonly<Record<number, number>>; readonly last_register: number },
  ) {
    this.pointerWrapsAfter = rules.last_register;
    this.clock = options.clock ?? hostWallClock;
    const buildTimes = options.buildTimes ?? (() => []);
    this.chip = ChipInstance.createSync({
      wasm: module,
      // The chip is on no board's pins: the part's own attach puts it on the
      // bus, as it put the hand-written model there.
      pinManager: new PinManager(),
      liveAttrs: (name) =>
        name === 'build_times' ? buildTimesText(buildTimes()) : undefined,
    });
    this.inputsAt = (this.chip.exports.chip_inputs as () => number)();
    // The registers behind the time power on as the rules table of the chip
    // says, the table the vectors hold the model to (rtc.h, chip_power_on).
    const table = (this.chip.exports.chip_power_on as () => number)();
    const bytes = new Uint8Array(this.chip.memory!.buffer, table, this.pointerWrapsAfter + 1);
    for (const [reg, value] of Object.entries(rules.power_on)) {
      const r = Number(reg);
      if (r >= 7 && r < bytes.length) bytes[r] = value;
    }
    this.pushTemperature(temperature);
    // Power-on reads the clock.
    this.pushClock();
    this.chip.start();
    const dev = this.chip.i2cDevice(this.address);
    if (!dev) throw new Error('the RTC model attached no I2C device at 0x68');
    this.dev = dev;
  }

  /** rtc_inputs, re-read if the memory ever grew under it. */
  private inputs(): DataView {
    const buffer = this.chip.memory!.buffer;
    if (this.view === null || this.view.buffer !== buffer) {
      this.view = new DataView(buffer, this.inputsAt, 16);
    }
    return this.view;
  }

  private pushClock(): void {
    this.inputs().setFloat64(0, this.clock(), true);
  }

  protected pushTemperature(celsius: number): void {
    this.inputs().setFloat64(8, celsius, true);
  }

  start(read: boolean): void {
    this.pushClock();
    this.dev.connect(this.address, read);
  }

  writeByte(value: number): boolean {
    this.pushClock();
    return this.dev.writeByte(value);
  }

  readByte(): number {
    this.pushClock();
    return this.dev.readByte();
  }

  stop(): void {
    this.pushClock();
    this.dev.stop();
  }

  /** The registers as a read would find them now, for a host that answers from a copy. */
  dumpRegisters(): Uint8Array {
    this.pushClock();
    const ptr = (this.chip.exports.chip_dump_registers as () => number)();
    return new Uint8Array(this.chip.memory!.buffer, ptr, 256).slice();
  }

  /** The model's memory, its whole state (I2CDevice.modelMemory). */
  modelMemory(): WebAssembly.Memory | null {
    return this.chip.memory;
  }

  dispose(): void {
    this.chip.dispose();
  }
}

/** The DS1307 from buses/models/ds1307.c, in place of VirtualDS1307. */
export class WasmDS1307 extends WasmRtc {
  constructor(module: WebAssembly.Module, options: RtcOptions = {}) {
    super(module, options, 25, DS1307_RULES);
  }
}

/** The DS3231 from buses/models/ds3231.c, in place of VirtualDS3231. */
export class WasmDS3231 extends WasmRtc {
  private celsius = 25.0;

  constructor(module: WebAssembly.Module, options: RtcOptions = {}) {
    super(module, options, 25, DS3231_RULES);
  }

  /** The panel's temperature, pushed into the model as it moves. */
  get temperatureC(): number {
    return this.celsius;
  }

  set temperatureC(celsius: number) {
    this.celsius = celsius;
    this.pushTemperature(celsius);
  }
}

/**
 * The BMP280 from buses/models/bmp280.c, in place of VirtualBMP280: the same
 * address choice, the panel's two values, the note to the board's monitor
 * when the data registers are read before the chip ever measured, and the
 * register dump the Pi relay mirrors.
 *
 * The panel's values and the address are pushed into the model's `bmp280_io`
 * (the export chip_inputs); the model counts the reads of a chip that never
 * measured there (asleep_reads), and the part says it once a run.
 */
export class WasmBMP280 implements I2CDevice {
  public address: number;
  /** The data registers were read before the chip ever measured, for the first time in this run. */
  onAsleepRead: (() => void) | null = null;

  private readonly chip: ChipInstance;
  private readonly dev: NonNullable<ReturnType<ChipInstance['i2cDevice']>>;
  private readonly ioAt: number;
  private view: DataView | null = null;
  private asleepReads = 0;
  private asleepReadSaid = false;
  // Where the sensor panel starts (sensorControlConfig, bmp280), as bmp280.c.
  private temperature = 24.0;
  private pressure = 1013.25;

  constructor(module: WebAssembly.Module, address = 0x76) {
    this.address = address === 0x77 ? 0x77 : 0x76;
    this.chip = ChipInstance.createSync({ wasm: module, pinManager: new PinManager() });
    this.ioAt = (this.chip.exports.chip_inputs as () => number)();
    this.io().setUint32(16, this.address, true);
    this.io().setFloat64(0, this.temperature, true);
    this.io().setFloat64(8, this.pressure, true);
    this.chip.start();
    const dev = this.chip.i2cDevice(this.address);
    if (!dev) throw new Error(`the BMP280 model attached no I2C device at 0x${this.address.toString(16)}`);
    this.dev = dev;
  }

  /** bmp280_io, re-read if the memory ever grew under it. */
  private io(): DataView {
    const buffer = this.chip.memory!.buffer;
    if (this.view === null || this.view.buffer !== buffer) {
      this.view = new DataView(buffer, this.ioAt, 24);
    }
    return this.view;
  }

  get temperatureC(): number {
    return this.temperature;
  }
  set temperatureC(v: number) {
    this.temperature = v;
    this.io().setFloat64(0, v, true);
  }

  get pressureHPa(): number {
    return this.pressure;
  }
  set pressureHPa(v: number) {
    this.pressure = v;
    this.io().setFloat64(8, v, true);
  }

  start(read: boolean): void {
    this.dev.connect(this.address, read);
  }

  writeByte(value: number): boolean {
    return this.dev.writeByte(value);
  }

  readByte(): number {
    const value = this.dev.readByte();
    const reads = this.io().getUint32(20, true);
    if (reads !== this.asleepReads) {
      this.asleepReads = reads;
      if (!this.asleepReadSaid) {
        this.asleepReadSaid = true;
        this.onAsleepRead?.();
      }
    }
    return value;
  }

  stop(): void {
    this.dev.stop();
  }

  /** A new run reads a chip that still has not measured: its monitor is told as well. */
  boardReset(): void {
    this.asleepReadSaid = false;
  }

  /** The registers as a read would find them now, for a host that answers from a copy. */
  dumpRegisters(): Uint8Array {
    const ptr = (this.chip.exports.chip_dump_registers as () => number)();
    return new Uint8Array(this.chip.memory!.buffer, ptr, 256).slice();
  }

  /** The model's memory, its whole state (I2CDevice.modelMemory). */
  modelMemory(): WebAssembly.Memory | null {
    return this.chip.memory;
  }

  dispose(): void {
    this.chip.dispose();
  }
}

/** What the MPU-6050's INT pad does to its line: it drives it, or lets go (open drain). */
type MpuIntPad = 'high' | 'low' | 'z';
const MPU_PADS: readonly MpuIntPad[] = ['low', 'high', 'z'];
/** The panel's names, in the order of mpu_io.inputs (mpu6050.c). */
const MPU_INPUT_KEYS = ['accelX', 'accelY', 'accelZ', 'gyroX', 'gyroY', 'gyroZ', 'temp'] as const;
type MpuInputKey = (typeof MPU_INPUT_KEYS)[number];
/** mpu_io in mpu6050.c. */
const MPU_IO = {
  now: 0,
  inputs: 8,
  notBefore: 64,
  wake: 72,
  address: 80,
  variant: 84,
  asleepReads: 88,
  dmpUnknown: 92,
  intHint: 96,
  size: 112,
} as const;

/** The entries of mpu6050.c the tab calls besides the bus. */
interface MpuExports {
  chip_sync: () => void;
  chip_restart_sampling: () => void;
  chip_int_pad: () => number;
  chip_int_wake: () => number;
  chip_dump_registers: () => number;
}

export interface WasmMpu6050Options {
  address: number;
  /** The die: 'mpu6050', or 'mpu9250' (MPU6050_RULES.variants). */
  variant: string;
  /** What a copy of dumpRegisters() cannot answer (MPU6050_RULES.volatile_reads). */
  volatileReads: readonly number[];
  /** The ports the pointer stays on (MPU6050_RULES.pointer_stays). */
  pointerStays: readonly number[];
}

/**
 * The MPU-6050 from buses/models/mpu6050.c, in place of VirtualMPU6050, with
 * its API: the panel's values, the guest's clock the chip samples on, the
 * INT pad the part puts on the board pin (intPad, intWakeNs, onIntChange),
 * the notes to the board's monitor (read asleep, a DMP image it does not
 * run), and the register dump and the lists the Pi relay mirrors by.
 *
 * The guest's time is pushed into the model's `mpu_io` (the export
 * chip_inputs) before every call, and the panel's values when they move; the
 * model counts in it what the part tells the monitor and when the pad may
 * have moved, which this reads back after every call.
 */
export class WasmMPU6050 implements I2CDevice {
  public address: number;
  /** The sample block was read while the chip sleeps, for the first time in this run. */
  onAsleepRead: (() => void) | null = null;
  /** The sketch started the DMP on an image the model does not know, for the first time in this run. */
  onDmpUnknown: (() => void) | null = null;
  /** What the INT pad does, or when it moves next, may have changed. */
  onIntChange: (() => void) | null = null;
  readonly volatileReads: readonly number[];
  readonly pointerStays: readonly number[];

  private readonly chip: ChipInstance;
  private readonly dev: NonNullable<ReturnType<ChipInstance['i2cDevice']>>;
  private readonly ioAt: number;
  private view: DataView | null = null;
  private clock: GuestClock | null = null;
  private readonly inputs: Record<MpuInputKey, number> = {
    accelX: 0,
    accelY: 0,
    accelZ: 1,
    gyroX: 0,
    gyroY: 0,
    gyroZ: 0,
    temp: 24,
  };
  private asleepReads = 0;
  private dmpUnknown = 0;
  private intHint = 0;
  private asleepReadSaid = false;
  private dmpUnknownSaid = false;
  private readonly exports: MpuExports;

  constructor(module: WebAssembly.Module, options: WasmMpu6050Options) {
    this.address = options.address;
    this.volatileReads = options.volatileReads;
    this.pointerStays = options.pointerStays;
    this.chip = ChipInstance.createSync({ wasm: module, pinManager: new PinManager() });
    this.exports = this.chip.exports as unknown as MpuExports;
    this.ioAt = (this.chip.exports.chip_inputs as () => number)();
    const io = this.io();
    io.setUint32(MPU_IO.address, this.address, true);
    io.setUint32(MPU_IO.variant, options.variant === 'mpu9250' ? 1 : 0, true);
    this.writeInputs();
    // No clock until the part is placed on a board's bus (setClock).
    io.setFloat64(MPU_IO.now, NaN, true);
    this.chip.start();
    const dev = this.chip.i2cDevice(this.address);
    if (!dev) throw new Error(`the MPU-6050 model attached no I2C device at 0x${this.address.toString(16)}`);
    this.dev = dev;
  }

  /** mpu_io, re-read if the memory ever grew under it. */
  private io(): DataView {
    const buffer = this.chip.memory!.buffer;
    if (this.view === null || this.view.buffer !== buffer) {
      this.view = new DataView(buffer, this.ioAt, MPU_IO.size);
    }
    return this.view;
  }

  private writeInputs(): void {
    const io = this.io();
    MPU_INPUT_KEYS.forEach((key, i) => io.setFloat64(MPU_IO.inputs + 8 * i, this.inputs[key], true));
  }

  /** The guest's time in ns (VirtualMPU6050.nowNs), NaN on a board that keeps none. */
  private pushClock(): void {
    const clock = this.clock;
    const hz = clock ? clock.clockHz() : 0;
    // Multiplied first: a whole number of ns comes out whole.
    const now = clock && hz > 0 ? (clock.now() * 1e9) / hz : NaN;
    this.io().setFloat64(MPU_IO.now, now, true);
  }

  /** What the model counted during the call, told to the part as VirtualMPU6050 tells it. */
  private heard(): void {
    const io = this.io();
    const asleep = io.getUint32(MPU_IO.asleepReads, true);
    if (asleep !== this.asleepReads) {
      this.asleepReads = asleep;
      if (!this.asleepReadSaid) {
        this.asleepReadSaid = true;
        this.onAsleepRead?.();
      }
    }
    const unknown = io.getUint32(MPU_IO.dmpUnknown, true);
    if (unknown !== this.dmpUnknown) {
      this.dmpUnknown = unknown;
      if (!this.dmpUnknownSaid) {
        this.dmpUnknownSaid = true;
        this.onDmpUnknown?.();
      }
    }
    const hint = io.getUint32(MPU_IO.intHint, true);
    if (hint !== this.intHint) {
      this.intHint = hint;
      this.onIntChange?.();
    }
  }

  /** The clock of the board the chip is on, or null when it is on no bus. */
  setClock(clock: GuestClock | null): void {
    this.clock = clock;
    this.pushClock();
    this.exports.chip_restart_sampling();
    this.heard();
  }

  get guestClock(): GuestClock | null {
    return this.clock;
  }

  /** The panel moved. Only the values it names change. */
  setInputs(values: Record<string, unknown>): void {
    // The samples due until now were taken of the world as it was.
    this.pushClock();
    this.exports.chip_sync();
    for (const key of MPU_INPUT_KEYS) {
      const v = values[key];
      if (typeof v === 'number' && Number.isFinite(v)) this.inputs[key] = v;
    }
    this.writeInputs();
    this.heard();
  }

  getInputs(): Record<MpuInputKey, number> {
    return { ...this.inputs };
  }

  start(read: boolean): void {
    this.pushClock();
    this.dev.connect(this.address, read);
    this.heard();
  }

  writeByte(value: number): boolean {
    this.pushClock();
    const ack = this.dev.writeByte(value);
    this.heard();
    return ack;
  }

  readByte(): number {
    this.pushClock();
    const value = this.dev.readByte();
    this.heard();
    return value;
  }

  stop(): void {
    this.dev.stop();
  }

  /**
   * A new run reads a chip that is still asleep: its monitor is told again.
   * The periods are counted from where the guest's counter stands now.
   */
  boardReset(): void {
    this.asleepReadSaid = false;
    this.dmpUnknownSaid = false;
    this.pushClock();
    this.exports.chip_restart_sampling();
    this.heard();
  }

  /** The registers as a read would find them now, for a host that answers from a copy. */
  dumpRegisters(): Uint8Array {
    this.pushClock();
    const ptr = this.exports.chip_dump_registers();
    const out = new Uint8Array(this.chip.memory!.buffer, ptr, 256).slice();
    this.heard();
    return out;
  }

  /** What the INT pad does at this instant. */
  intPad(): MpuIntPad {
    this.pushClock();
    const pad = MPU_PADS[this.exports.chip_int_pad()];
    this.heard();
    return pad;
  }

  /** The guest time, in ns, at which the pad moves next with nobody touching the chip. */
  intWakeNs(): number | null {
    this.pushClock();
    const io = this.io();
    io.setFloat64(MPU_IO.notBefore, NaN, true);
    const some = this.exports.chip_int_wake();
    this.heard();
    return some ? io.getFloat64(MPU_IO.wake, true) : null;
  }

  /** The model's memory, its whole state (I2CDevice.modelMemory). */
  modelMemory(): WebAssembly.Memory | null {
    return this.chip.memory;
  }

  dispose(): void {
    this.chip.dispose();
  }
}
