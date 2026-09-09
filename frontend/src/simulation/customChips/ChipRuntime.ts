/**
 * ChipRuntime — TypeScript port of test/test_custom_chips/src/ChipRuntime.js.
 *
 * Loads a Velxio custom-chip WASM, wires its imports to host services
 * (PinManager, I2CBusManager, SPIBus, attribute storage, timer queue), and
 * dispatches its callbacks back into the simulator. One ChipInstance per
 * chip dropped on the canvas.
 */
import type { PinManager } from '../PinManager';
import type { I2CBusManager } from '../I2CBusManager';
import { SPIBus, SPIDevice } from './SPIBus';
import { WasiShim, type SimNanosFn, type WriteStdoutFn } from './WasiShim';
import { setChipPinDrive } from './chipPinDrives';
import { isSyntheticChipPin, isSyntheticNetPin } from './syntheticPins';
import { requestElectricalResolve } from '../spice/electricalResolveHook';
import { chipBusEnabled } from './chipNets';
import { setBusDrive, clearBusDriversForChip } from './busNets';
import { modeToDrive } from './busLogic';

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
  };
}

interface PinEntry {
  name: string;
  mode: number;
  arduinoPin: number | null;
  /** Last level written/initialized — used to compute the bus drive on a mode
   *  flip (e.g. OUTPUT -> INPUT releases the bus without forgetting the level). */
  value: 0 | 1;
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
  nextFire: bigint;
  repeat: boolean;
}

interface SpiEntry {
  device: SPIDevice;
  cfg: SpiConfig;
  onDoneCallback: (buffer: Uint8Array, count: number) => void;
}

export interface ChipInstanceOptions {
  /** Compiled chip.wasm — either bytes, ArrayBuffer, or pre-compiled Module. */
  wasm: Uint8Array | ArrayBuffer | WebAssembly.Module;
  pinManager: PinManager;
  i2cBus?: I2CBusManager | null;
  spiBus?: SPIBus | null;
  /** Logical chip pin name → real Arduino pin number (resolved from wires). */
  wires?: Map<string, number>;
  /** User-editable attributes — keyed by name. */
  attrs?: Map<string, number>;
  /** String attribute values (vx_attr_register_string), from chip.json. */
  strAttrs?: Map<string, string>;
  /** Returns simulation time in nanos (used by vx_sim_now_nanos). */
  simNanos?: SimNanosFn;
  /** Callback for chip log/printf output (defaults to console.log). */
  log?: WriteStdoutFn;
  /** Optional display dimensions from chip.json's `display` field. */
  display?: { width: number; height: number } | null;
  /** Optional external ROM bytes (vx_rom_size / vx_rom_read).
   *  Used by CPU-emulator chips that load their program from a project file
   *  instead of hard-coding it as a C byte array. */
  romBytes?: Uint8Array | null;
  /** Canvas component id of this chip. Used to key its SPICE pin sources so
   *  the analog engine drives the nets wired to the chip's output pins. */
  componentId?: string;
}

/** Logic-high voltage a chip output pin asserts on its SPICE net. */
const CHIP_OUTPUT_VCC = 5;

export class ChipInstance {
  static MODE_OUTPUT_LOW = 16;
  static MODE_OUTPUT_HIGH = 17;

  private wasm: ChipInstanceOptions['wasm'];
  private pinManager: PinManager;
  private i2cBus: I2CBusManager | null;
  private spiBus: SPIBus | null;
  private wires: Map<string, number>;
  private attrs: Map<string, number>;
  private strAttrs: Map<string, string>;
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
  private uarts: UartConfig[] = [];
  private _uartTxListener: ((byte: number) => void) | null = null;
  private spiDevices: SpiEntry[] = [];
  private _currentSpiBufPtr: number = 0;
  private _romBytes: Uint8Array;

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

  /** I2C device wrapper currently registered on the bus (for disposal). */
  private _i2cDevice: { address: number } | null = null;

  wasi: WasiShim;
  private _velxioImports: Record<string, (...args: any[]) => any>;

  static async create(opts: ChipInstanceOptions): Promise<ChipInstance> {
    const inst = new ChipInstance(opts);
    await inst._instantiate();
    return inst;
  }

  constructor(opts: ChipInstanceOptions) {
    this.wasm = opts.wasm;
    this.pinManager = opts.pinManager;
    this.i2cBus = opts.i2cBus ?? null;
    this.spiBus = opts.spiBus ?? null;
    this.wires = opts.wires ?? new Map();
    this.attrs = opts.attrs ?? new Map();
    this.strAttrs = opts.strAttrs ?? new Map();
    this.display = opts.display ?? null;
    this._romBytes = opts.romBytes ?? new Uint8Array(0);
    this.componentId = opts.componentId ?? '';

    this.wasi = new WasiShim(
      opts.simNanos ?? (() => 0n),
      opts.log ?? ((s) => console.log(`[chip] ${s.replace(/\n$/, '')}`)),
    );

    this._velxioImports = this._buildVelxioImports();
  }

  private async _instantiate(): Promise<void> {
    // 4 pages (256 KB) initial: CPU-emulator chips like z80-cpu keep a 32 KB
    // ROM + 32 KB RAM buffer as static data, which alone needs >2 pages once
    // the WASM stack is added. Grows up to 16 pages on demand.
    this.memory = new WebAssembly.Memory({ initial: 4, maximum: 16 });
    this.wasi.setMemory(this.memory);

    const importObject: WebAssembly.Imports = {
      env: {
        memory: this.memory,
        ...this._velxioImports,
      },
      ...this.wasi.imports(),
    };

    let module: WebAssembly.Module;
    if (this.wasm instanceof WebAssembly.Module) {
      module = this.wasm;
    } else {
      module = await WebAssembly.compile(this.wasm as BufferSource);
    }

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

    this.instance = await WebAssembly.instantiate(module, importObject);
    this.exports = this.instance.exports;
  }

  start(): void {
    if (!this.exports?.chip_setup) {
      throw new Error('Chip WASM does not export chip_setup');
    }
    this.exports.chip_setup();
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
  tickTimers(nowNanos: bigint | number, budgetMs = 0): void {
    const now = BigInt(nowNanos);
    const table = this.exports?.__indirect_function_table as WebAssembly.Table | undefined;
    if (!table) return;
    const startWall = budgetMs > 0 ? performance.now() : 0;
    for (const t of this.timers) {
      if (!t.active) continue;
      while (t.active && now >= t.nextFire) {
        const fn = table.get(t.cbIdx) as ((ud: number) => void) | null;
        if (fn) {
          try { fn(t.userData); } catch { /* swallow chip errors */ }
        }
        if (t.repeat) {
          t.nextFire += t.period;
        } else {
          t.active = false;
        }
        if (budgetMs > 0 && performance.now() - startWall > budgetMs) {
          this.wasi.flush();
          return;
        }
      }
    }
    this.wasi.flush();
  }

  dispose(): void {
    if (this.disposed) return;
    for (const set of this._pinWatches.values()) {
      for (const u of set) u();
    }
    this._pinWatches.clear();
    this.timers = [];
    if (this.i2cBus && this._i2cDevice) {
      this.i2cBus.removeDevice(this._i2cDevice.address);
    }
    if (this.spiBus) {
      for (const d of this.spiDevices) this.spiBus.removeDevice(d.device);
    }
    this.spiDevices = [];
    // Stop driving any bus nets this chip contributed to, then re-resolve them
    // so a removed chip releases the bus (its drivers no longer count).
    if (this.componentId) clearBusDriversForChip(this.pinManager, this.componentId);
    this.disposed = true;
  }

  // ── Build host imports table ─────────────────────────────────────────────

  private _buildVelxioImports(): Record<string, (...args: any[]) => any> {
    return {
      vx_pin_register:    (namePtr: number, mode: number) => this._pin_register(namePtr, mode),
      vx_pin_read:        (handle: number) => this._pin_read(handle),
      vx_pin_write:       (handle: number, value: number) => this._pin_write(handle, value),
      vx_pin_read_analog: (handle: number) => this._pin_read_analog(handle),
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

      vx_sim_now_nanos: () => BigInt(this.wasi.simNanos() as number | bigint),
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
          this.pinManager.getPinState(p.arduinoPin) ? CHIP_OUTPUT_VCC : 0,
        )
      : setChipPinDrive(this.componentId, p.name, null);
    if (changed) requestElectricalResolve();
  }

  private _pin_register(namePtr: number, mode: number): number {
    const name = readCString(this.memory!, namePtr);
    const handle = this.pins.length;
    const arduinoPin = this.wires.has(name) ? this.wires.get(name)! : null;
    const value: 0 | 1 = mode === ChipInstance.MODE_OUTPUT_HIGH ? 1 : 0;
    const p: PinEntry = { name, mode, arduinoPin, value };
    this.pins.push(p);
    if (this._isBusPin(p)) {
      this._busDrive(p);
    } else if (arduinoPin != null) {
      if (mode === ChipInstance.MODE_OUTPUT_LOW) {
        this.pinManager.triggerPinChange(arduinoPin, false);
        if (!isSyntheticChipPin(arduinoPin)) this._onDigitalWrite?.(name, false);
      }
      if (mode === ChipInstance.MODE_OUTPUT_HIGH) {
        this.pinManager.triggerPinChange(arduinoPin, true);
        if (!isSyntheticChipPin(arduinoPin)) this._onDigitalWrite?.(name, true);
      }
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
    } else {
      this.pinManager.triggerPinChange(p.arduinoPin, value !== 0);
      // A chip output wired to a REAL board pin must reach the board's own
      // digitalRead too — the host forwards into the simulator.
      if (!isSyntheticChipPin(p.arduinoPin)) this._onDigitalWrite?.(p.name, value !== 0);
    }
    this._syncSpiceDrive(p);
  }

  private _pin_read_analog(handle: number): number {
    const p = this.pins[handle];
    if (!p || p.arduinoPin == null) return 0;
    return this.pinManager.getPwmValue(p.arduinoPin) * 5.0;
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
        const fn = table.get(cbIdx) as ((ud: number, pin: number, value: number) => void) | null;
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

  private _i2c_attach(cfgPtr: number): number {
    if (!this.i2cBus) {
      throw new Error('Chip called vx_i2c_attach but no I2CBusManager is wired to the host');
    }
    const cfg = readI2CConfig(this.memory!, cfgPtr);
    const callFn = (idx: number, ...args: any[]) => {
      const table = this.exports?.__indirect_function_table as WebAssembly.Table | undefined;
      if (!table) return 0;
      const fn = table.get(idx) as ((...a: any[]) => any) | null;
      if (!fn) return 0;
      try { return fn(...args); } catch { return 0; }
    };

    let connectPending = true;
    const device = {
      address: cfg.address,
      writeByte: (value: number): boolean => {
        if (cfg.on_connect && connectPending) {
          callFn(cfg.on_connect, cfg.user_data, cfg.address, 0);
          connectPending = false;
        }
        const ack = !!callFn(cfg.on_write, cfg.user_data, value);
        this.wasi.flush();
        return ack;
      },
      readByte: (): number => {
        if (cfg.on_connect && connectPending) {
          callFn(cfg.on_connect, cfg.user_data, cfg.address, 1);
          connectPending = false;
        }
        const b = callFn(cfg.on_read, cfg.user_data) & 0xff;
        this.wasi.flush();
        return b;
      },
      stop: (): void => {
        if (cfg.on_stop) callFn(cfg.on_stop, cfg.user_data);
        connectPending = true;
        this.wasi.flush();
      },
    };

    this.i2cBus.addDevice(device);
    this._i2cDevice = device;
    return 0;
  }

  // ── UART ─────────────────────────────────────────────────────────────────

  private _uart_attach(cfgPtr: number): number {
    const cfg = readUartConfig(this.memory!, cfgPtr);
    const handle = this.uarts.length;
    this.uarts.push(cfg);
    return handle;
  }

  private _uart_write(handle: number, bufPtr: number, count: number): number {
    const u = this.uarts[handle];
    if (!u) return 0;
    const u8 = new Uint8Array(this.memory!.buffer);
    const bytes = u8.slice(bufPtr, bufPtr + count);
    if (this._uartTxListener) {
      for (const b of bytes) this._uartTxListener(b);
    }
    if (u.on_tx_done) {
      const table = this.exports?.__indirect_function_table as WebAssembly.Table | undefined;
      const fn = table?.get(u.on_tx_done) as ((ud: number) => void) | null;
      if (fn) {
        try { fn(u.user_data); } catch { /* swallow */ }
      }
    }
    this.wasi.flush();
    return 1;
  }

  feedUart(byte: number, handle = 0): void {
    const u = this.uarts[handle];
    if (!u || !u.on_rx_byte) return;
    const table = this.exports?.__indirect_function_table as WebAssembly.Table | undefined;
    const fn = table?.get(u.on_rx_byte) as ((ud: number, byte: number) => void) | null;
    if (fn) {
      try { fn(u.user_data, byte & 0xff); } catch { /* swallow */ }
    }
    this.wasi.flush();
  }

  onUartTx(cb: (byte: number) => void): void {
    this._uartTxListener = cb;
  }

  /**
   * Where a declared UART's TX physically goes: the board pin its TX chip-pin
   * is wired to (null when unwired/synthetic) and the configured baud. Lets
   * the part route TX to the hardware USART vs a bit-banged GPIO.
   */
  getUartTxRoute(handle = 0): { txArduinoPin: number | null; baud: number } | null {
    const u = this.uarts[handle];
    if (!u) return null;
    const pin = this.pins[u.tx];
    return {
      txArduinoPin: pin?.arduinoPin ?? null,
      baud: u.baud_rate > 0 ? u.baud_rate : 9600,
    };
  }

  /** True if the chip declared at least one UART (post-chip_setup). */
  get hasUart(): boolean {
    return this.uarts.length > 0;
  }

  // ── SPI ──────────────────────────────────────────────────────────────────

  private _spi_attach(cfgPtr: number): number {
    if (!this.spiBus) {
      throw new Error('Chip called vx_spi_attach but no SPIBus is wired to the host');
    }
    const cfg = readSpiConfig(this.memory!, cfgPtr);
    const handle = this.spiDevices.length;
    const device = new SPIDevice();

    const onDoneCallback = (_buffer: Uint8Array, count: number) => {
      if (cfg.on_done) {
        const table = this.exports?.__indirect_function_table as WebAssembly.Table | undefined;
        const fn = table?.get(cfg.on_done) as ((ud: number, buf: number, c: number) => void) | null;
        if (fn) {
          try { fn(cfg.user_data, this._currentSpiBufPtr, count); } catch { /* swallow */ }
        }
        this.wasi.flush();
      }
    };

    this.spiDevices.push({ device, cfg, onDoneCallback });
    this.spiBus.addDevice(device);
    return handle;
  }

  private _spi_start(handle: number, bufPtr: number, count: number): void {
    const entry = this.spiDevices[handle];
    if (!entry) return;
    const buf = new Uint8Array(this.memory!.buffer, bufPtr, count);
    this._currentSpiBufPtr = bufPtr;
    entry.device.startTransfer(buf, count, (b, c) => entry.onDoneCallback(b, c));
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
    this.timers.push({ cbIdx, userData, active: false, period: 0n, nextFire: 0n, repeat: false });
    return handle;
  }

  private _timer_start(handle: number, periodNanos: bigint, repeat: number): void {
    const t = this.timers[handle];
    if (!t) return;
    t.period = BigInt(periodNanos);
    t.repeat = !!repeat;
    t.nextFire = BigInt(this.wasi.simNanos() as number | bigint) + t.period;
    t.active = true;
  }

  private _timer_stop(handle: number): void {
    const t = this.timers[handle];
    if (t) t.active = false;
  }
}
