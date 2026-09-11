/**
 * PiBridgeShim — the simulator-shaped object a Linux-guest board (the
 * Raspberry Pi family and any overlay-registered kind of the same family)
 * hands to the parts wired to it.
 *
 * Why it exists: every part on the canvas attaches to
 * `getBoardSimulator(boardId)` and asks it for a bus (`addI2CDevice`, `.spi`,
 * `setSPIHandler`), a pin (`setPinState`, `pinManager`) or an ADC
 * (`setAdcVoltage`). A Pi had no entry in that map: a hand-rolled stub in
 * DynamicComponent answered `setPinState` and nothing else, so an I2C sensor
 * wired to GPIO2/3 attached nowhere and the guest read 0x00 from an address
 * that had a model sitting right there on the canvas. This class gives the
 * Pi the same surface the STM32 and ESP32 shims give their boards, over the
 * same `I2CBusManager` and `PinManager` every other board uses.
 *
 * Two engines run a Pi script, and both come here for their peripherals:
 *
 *   - the Linux guest in QEMU (via `RaspberryPi3Bridge`): the guest's shim
 *     libraries send one request line per bus operation and the backend
 *     relays it to the browser as `pi_bus_request {rid, line}`; the store
 *     wires `bridge.onBusRequest` to {@link answerBusLine} and the bridge
 *     sends the answer back as `pi_bus_reply`;
 *   - an in-browser engine, which calls {@link answerBusLine} directly with
 *     the same lines.
 *
 * One grammar, one answerer, the same device models: whatever a sensor
 * answers in one engine it answers in the other, by construction.
 *
 * Request lines (one per operation; `<addr>`, `<reg>` and byte strings in hex):
 *
 *   I2C <bus> <addr> R  <n>              raw read of n bytes
 *   I2C <bus> <addr> W  <hex>            raw write
 *   I2C <bus> <addr> RR <reg> <n>        write reg, repeated start, read n
 *   I2C <bus> <addr> WR <reg> <hex>      write reg + bytes
 *   I2C <bus> <addr> T  <hex|-> <n>      write bytes, repeated start, read n
 *   SPI <bus> <cs> X  <hex>              full-duplex transfer, CS released after
 *   SPI <bus> <cs> XC <hex>              same, CS held low for the next transfer
 *   SPI <bus> <cs> CONFIG ...            accepted, nothing to answer
 *   W1 <pin> LIST | SP <rom> | RES <rom> <bits>
 *   W1 <pin> RESET | RB | WB <hex> | RBLK <n> | WBLK <hex> | TRIPLET <d>
 *   PWM <ch> <period_ns> <duty_ns> <en>  hardware PWM channel (0 = GPIO18, 1 = GPIO19)
 *   PWM_START | PWM_CHANGE <pin> <hz> <duty_pct>, PWM_STOP <pin>
 *   GPIO_SETUP <pin> <in|out> [<pud_up|pud_down|pud_off>]
 *
 * Replies:
 *
 *   I2C_DATA <bus> <addr> [<hex>]        ack; the bytes read, if any
 *   I2C_ERR  <bus> <addr> nack           nobody acknowledged the address
 *   SPI_DATA <bus> <cs> <hex>            the bytes clocked in on MISO
 *   W1_LIST  <pin> [<rom>,...]           ROM ids on that pin
 *   W1_SLAVE <pin> <rom> <18hex> <crc_ok>  a slave's 9-byte scratchpad
 *   W1_DATA  <pin> <hex|0|1|ok>          the byte-level ops
 *   W1_ERR   <pin> no-master             nothing registered on that pin
 *   (null)                               lines that need no answer (PWM, GPIO_SETUP, CONFIG)
 */

import { I2CBusManager, nullI2CMaster, type I2CDevice } from './I2CBusManager';
import type { PinManager } from './PinManager';
import type { RaspberryPi3Bridge } from './RaspberryPi3Bridge';
import type { LineSupport } from './line/LineHost';
import { recordPartGap } from './line/requestLine';
import { requestElectricalResolve } from './spice/electricalResolveHook';
import { getBoardLineSupport } from '../lib/proBoardRegistry';
import type { OneWireByteMaster } from './oneWireHost';

/** What the store tells the shim about its board, read fresh on every call. */
export interface PiShimBoardState {
  running?: boolean;
  engineMode?: 'instant' | 'linux';
}

/**
 * The in-browser engine's side of the shim: set by whoever runs the script in
 * the browser, so a part's input reaches the engine's pin table and a wired
 * peer's UART bytes reach its serial shim. Every member optional — a board
 * with no such engine simply has nothing here.
 */
export interface PiInstantAdapter {
  onPinInput?(pin: number, state: boolean): void;
  onUartRx?(bytes: number[]): void;
}

export interface PiBridgeShimOptions {
  boardId: string;
  boardKind: string;
  bridge: RaspberryPi3Bridge;
  pinManager: PinManager;
  /** The board's live store record (running flag, engine mode). */
  boardState: () => PiShimBoardState | undefined;
}

/** The SPI adapter in the AVR shape parts already hook (`spi.onByte`). */
export interface PiSpiAdapter {
  onByte: ((mosi: number) => void) | null;
  completeTransfer: (miso: number) => void;
}

/** BCM pins of the chip-selects per SPI bus, indexed by the guest's `cs`. */
const SPI_CE_PINS: Record<number, number[]> = {
  0: [8, 7],
  1: [18, 17, 16],
};

/** Hardware PWM channels of `pwmchip0` on the 40-pin header. */
const PWM_CHANNEL_PINS: Record<number, number> = { 0: 18, 1: 19 };

/** The header I2C bus (GPIO2 SDA / GPIO3 SCL). Bus 0 is the ID EEPROM pair. */
const HEADER_I2C_BUS = 1;

const LINE_SUPPORT_NONE_WHY =
  'this board runs a Linux guest that reads its pins over a serial link; timed single-wire sensors are not modelled here';
const PIXEL_SUPPORT_NONE_WHY =
  'this board drives its pins over a level protocol with no bit timing, so a WS2812 data stream cannot be produced or decoded here';

/** Hex helpers: byte strings on the wire are lowercase, two chars per byte, no separators. */
function toHex(bytes: readonly number[]): string {
  return bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
}
function fromHex(s: string | undefined): number[] | null {
  if (s === undefined || s === '-' || s === '') return [];
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) return null;
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
}
function parseCount(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n <= 4096 ? n : null;
}

/** Dallas/Maxim CRC-8 (poly 0x31 reflected), as the w1 kernel driver checks it. */
function crc8(bytes: readonly number[]): number {
  let crc = 0;
  for (const b of bytes) {
    let x = (crc ^ b) & 0xff;
    for (let i = 0; i < 8; i++) x = x & 1 ? (x >> 1) ^ 0x8c : x >> 1;
    crc = x;
  }
  return crc;
}

export class PiBridgeShim {
  readonly simulatorKind = 'pi' as const;
  /**
   * Inputs are NOT driven from the SPICE solve: a Pi's guest reads levels
   * over a link and the parts seed them directly (the way the old stub did).
   * A later phase raises this per pin once the guest's pull is known.
   */
  readonly spiceDrivenInputs = false;
  readonly boardId: string;
  readonly boardKind: string;
  pinManager: PinManager;
  onSerialData: ((ch: string) => void) | null = null;
  onPinChangeWithTime: ((pin: number, state: boolean, timeMs: number) => void) | null = null;
  /** The in-browser engine's hooks, when one is running this board. */
  instantAdapter: PiInstantAdapter | null = null;

  private readonly bridge: RaspberryPi3Bridge;
  private readonly boardState: () => PiShimBoardState | undefined;
  private readonly i2cBusInstance: I2CBusManager;
  private readonly spiHandlers = new Map<number, (mosi: number) => number>();
  private _spiAdapter: PiSpiAdapter | null = null;
  /** `bus:cs` of a chip-select held low by an `XC` transfer, if any. */
  private heldCs: { bus: number; cs: number } | null = null;
  private readonly oneWireMasters = new Map<number, OneWireByteMaster>();
  private readonly adcWarned = new Set<number>();

  constructor(opts: PiBridgeShimOptions) {
    this.boardId = opts.boardId;
    this.boardKind = opts.boardKind;
    this.bridge = opts.bridge;
    this.pinManager = opts.pinManager;
    this.boardState = opts.boardState;
    this.i2cBusInstance = new I2CBusManager(nullI2CMaster());
  }

  // ── Lifecycle (the store drives the guest through the bridge / engine) ──
  start(): void {}
  /** Nothing to halt here; a chip-select held by an unfinished transfer is released. */
  stop(): void {
    this.releaseHeldCs();
  }
  reset(): void {}
  setSpeed(_s: number): void {}
  getSpeed(): number {
    return 1;
  }
  loadHex(_hex: string): void {}
  loadBinary(_b64: string): void {}
  /** The board's own flag, not the socket: a mocked bridge reports connected
   *  forever, and the in-browser engine has no socket at all. */
  isRunning(): boolean {
    return !!this.boardState()?.running;
  }
  getBridge(): RaspberryPi3Bridge {
    return this.bridge;
  }

  // ── Pins ───────────────────────────────────────────────────────────────
  /**
   * A part reports the level on one of its pins (a button, a PIR trip). The
   * PinManager sees it (wires, SPICE), the guest sees it (`gpio_in` and the
   * named `pin<N>` value its shims poll), and the in-browser engine sees it.
   * Bridge members are called optionally on purpose: the test suites that
   * mock RaspberryPi3Bridge build it with a handful of methods.
   */
  setPinState(pin: number, state: boolean): void {
    this.pinManager.triggerPinChange(pin, state, 'external');
    const bridge = this.bridge as Partial<RaspberryPi3Bridge>;
    bridge.sendPinEvent?.(pin, state);
    bridge.setSensorState?.({ [`pin${pin}`]: state ? 1 : 0 });
    this.instantAdapter?.onPinInput?.(pin, state);
  }

  /**
   * The guest programmed a pull on a pin (`GPIO_SETUP ... pud_up`). Same rule
   * as the store's pull handler for the MCU boards: record it so the netlist
   * stamps the weak resistor, seed the input to the pull's resting level when
   * nothing drives the pin, and ask for a re-solve.
   */
  setPinPull(pin: number, pull: 0 | 1 | 2): void {
    this.pinManager.setPinPull(pin, pull);
    if (pull !== 0 && !this.pinManager.getOutputPins().has(pin)) {
      this.setPinState(pin, pull === 1);
    }
    requestElectricalResolve();
  }

  /**
   * PWM activity from either engine. `dutyPct` is 0-100 as the guest says it;
   * the PinManager carries 0-1 (servo, dimmed LED and buzzer listeners read
   * that). A stop is a zero duty.
   */
  applyPwm(pin: number, freqHz: number, dutyPct: number): void {
    if (freqHz > 0) this.pinManager.setPwmFreq(pin, freqHz);
    const duty = Math.min(1, Math.max(0, dutyPct / 100));
    this.pinManager.updatePwm(pin, Number.isFinite(duty) ? duty : 0);
  }

  /**
   * The Pi has no ADC. Said once per pin in the console and recorded as a
   * gap for the circuit check, instead of the silent AVR fallback a shim
   * without this method used to get. Returns false: nothing was set.
   */
  setAdcVoltage(pin: number, _voltage: number): boolean {
    const why = `${this.boardKind.startsWith('raspberry-pi') ? 'the Raspberry Pi' : 'this board'} has no analog input; use an MCP3008 (SPI) or an ADS1115 (I2C)`;
    recordPartGap({ sensorType: 'analog input', pin, why, code: 'no-adc' });
    if (!this.adcWarned.has(pin)) {
      this.adcWarned.add(pin);
      console.warn(`[pi] analog input on GPIO ${pin}: ${why}`);
    }
    return false;
  }

  // ── Line-owning sensors / addressable pixels: declared refusals ────────
  /** The overlay may register a declaration per kind (a board that serves
   *  DHT22 / HC-SR04 as hosted values); the default is a refusal with the
   *  reason, so the part hears it and the circuit check shows it. */
  lineSupport(): LineSupport {
    return getBoardLineSupport(this.boardKind) ?? { mode: 'none', why: LINE_SUPPORT_NONE_WHY };
  }
  pixelSupport(): { mode: 'none'; why: string } {
    return { mode: 'none', why: PIXEL_SUPPORT_NONE_WHY };
  }

  // ── Header UART (a wired peer board's TX) ──────────────────────────────
  /** Raw bytes into the guest's header UART RX, by engine. */
  sendSerialBytes(bytes: number[], _uart = 0): void {
    if (!bytes.length) return;
    if (this.boardState()?.engineMode === 'instant') {
      this.instantAdapter?.onUartRx?.(bytes);
      return;
    }
    (this.bridge as Partial<RaspberryPi3Bridge>).sendUartBytes?.(bytes);
  }
  /** Text counterpart, the uniform `sim.feedUart(uart, data)` seam. */
  feedUart(uart: number, data: string): boolean {
    this.sendSerialBytes(Array.from(new TextEncoder().encode(data)), uart);
    return true;
  }

  // ── I2C: the header bus, shared by the parts and both engines ──────────
  // No `registerSensor` and no `addI2CTransactionListener` on purpose: the
  // parts then take their `addI2CDevice` branch (the AVR / RP2040 path), so
  // every device lives on this one I2CBusManager and nobody feeds it twice.
  getI2CBus(_bus: 0 | 1 = 0): I2CBusManager {
    return this.i2cBusInstance;
  }
  addI2CDevice(device: I2CDevice, _bus: 0 | 1 = 0): void {
    this.i2cBusInstance.addDevice(device);
  }
  removeI2CDevice(addr: number, _bus: 0 | 1 = 0): void {
    this.i2cBusInstance.removeDevice(addr);
  }

  /**
   * One I2C transaction as a master would run it: address for write, send
   * `write`, and when `readLen` > 0 re-address for read WITHOUT a stop in
   * between (a repeated start: the device keeps its register pointer), read,
   * then stop. Null when nobody acknowledges the address (a NAK), which is
   * what the guest turns into errno 121. Only the header bus has devices;
   * any other bus number is empty.
   */
  i2cTransfer(addr: number, write: readonly number[], readLen: number, bus = HEADER_I2C_BUS): number[] | null {
    if (bus !== HEADER_I2C_BUS) return null;
    const i2c = this.i2cBusInstance;
    if (write.length > 0 || readLen === 0) {
      if (!i2c.handleExternalConnect(addr, true)) return null;
      for (const b of write) i2c.handleExternalWrite(b);
    }
    const out: number[] = [];
    if (readLen > 0) {
      if (!i2c.handleExternalConnect(addr, false)) {
        i2c.handleExternalStop();
        return null;
      }
      for (let i = 0; i < readLen; i++) out.push(i2c.handleExternalRead() & 0xff);
    }
    i2c.handleExternalStop();
    return out;
  }

  // ── SPI: the AVR adapter shape AND the RP2040 handler shape ────────────
  // Parts hook whichever they know; a transfer feeds both and ANDs the MISO
  // bytes (an idle line reads high, so a silent side contributes 0xff).
  get spi(): PiSpiAdapter {
    if (!this._spiAdapter) {
      this._spiAdapter = { onByte: null, completeTransfer: (_miso: number) => {} };
    }
    return this._spiAdapter;
  }
  setSPIHandler(bus: 0 | 1, handler: (value: number) => number): void {
    this.spiHandlers.set(bus, handler);
  }

  /**
   * Clock `mosi` out on `bus` with chip-select `cs` low, return MISO.
   * `holdCs` keeps the select asserted after the last byte (a multi-call
   * transaction); the next transfer on another select, or without the hold,
   * releases it.
   */
  spiTransfer(bus: number, cs: number, mosi: readonly number[], holdCs = false): number[] {
    const cePin = SPI_CE_PINS[bus]?.[cs];
    const held = this.heldCs && this.heldCs.bus === bus && this.heldCs.cs === cs;
    if (!held) {
      this.releaseHeldCs();
      if (cePin !== undefined) this.pinManager.triggerPinChange(cePin, false, 'mcu');
    }
    const adapter = this.spi;
    const handler = this.spiHandlers.get(bus);
    const out: number[] = [];
    for (const byte of mosi) {
      let fromAdapter = 0xff;
      adapter.completeTransfer = (miso: number) => {
        fromAdapter = miso & 0xff;
      };
      adapter.onByte?.(byte & 0xff);
      const fromHandler = handler ? handler(byte & 0xff) & 0xff : 0xff;
      out.push(fromAdapter & fromHandler);
    }
    adapter.completeTransfer = (_miso: number) => {};
    if (holdCs) {
      this.heldCs = { bus, cs };
    } else {
      this.heldCs = null;
      if (cePin !== undefined) this.pinManager.triggerPinChange(cePin, true, 'mcu');
    }
    return out;
  }

  private releaseHeldCs(): void {
    if (!this.heldCs) return;
    const cePin = SPI_CE_PINS[this.heldCs.bus]?.[this.heldCs.cs];
    this.heldCs = null;
    if (cePin !== undefined) this.pinManager.triggerPinChange(cePin, true, 'mcu');
  }

  // ── 1-Wire: one byte master per pin, registered by the part that models it ─
  attachOneWireMaster(pin: number, master: OneWireByteMaster): void {
    this.oneWireMasters.set(pin, master);
  }
  detachOneWireMaster(pin: number): void {
    this.oneWireMasters.delete(pin);
  }

  /**
   * One 1-Wire operation on `pin`; `op` is the request's tokens after the
   * pin. The composites (LIST, SP, RES) are what a w1 kernel driver does for
   * `w1_slave`: match the ROM, read or write the scratchpad, check the CRC.
   * Returns the reply line, or null when the op is unknown.
   */
  w1Op(pin: number, op: readonly string[]): string | null {
    const master = this.oneWireMasters.get(pin);
    if (!master) return `W1_ERR ${pin} no-master`;
    const [kind, a, b] = op;
    switch (kind) {
      case 'LIST':
        return `W1_LIST ${pin} ${master.roms().join(',')}`;
      case 'SP': {
        const rom = fromHex(a);
        if (!rom || rom.length !== 8) return null;
        if (!master.reset()) return `W1_ERR ${pin} no-presence`;
        master.writeByte(0x55); // MATCH ROM
        master.writeBlock(rom);
        master.writeByte(0xbe); // READ SCRATCHPAD
        const sp = master.readBlock(9);
        const ok = crc8(sp.slice(0, 8)) === (sp[8] & 0xff) ? 1 : 0;
        return `W1_SLAVE ${pin} ${a} ${toHex(sp)} ${ok}`;
      }
      case 'RES': {
        const rom = fromHex(a);
        const bits = parseCount(b);
        if (!rom || rom.length !== 8 || bits === null || bits < 9 || bits > 12) return null;
        if (!master.reset()) return `W1_ERR ${pin} no-presence`;
        master.writeByte(0x55);
        master.writeBlock(rom);
        master.writeByte(0xbe);
        const sp = master.readBlock(9);
        if (!master.reset()) return `W1_ERR ${pin} no-presence`;
        master.writeByte(0x55);
        master.writeBlock(rom);
        master.writeByte(0x4e); // WRITE SCRATCHPAD: TH, TL, config
        master.writeBlock([sp[2], sp[3], (((bits - 9) & 3) << 5) | 0x1f]);
        return `W1_DATA ${pin} ok`;
      }
      case 'RESET':
        return `W1_DATA ${pin} ${master.reset() ? 1 : 0}`;
      case 'RB':
        return `W1_DATA ${pin} ${toHex([master.readByte()])}`;
      case 'WB': {
        const bytes = fromHex(a);
        if (!bytes || bytes.length !== 1) return null;
        master.writeByte(bytes[0]);
        return `W1_DATA ${pin} ok`;
      }
      case 'RBLK': {
        const n = parseCount(a);
        if (n === null) return null;
        return `W1_DATA ${pin} ${toHex(master.readBlock(n))}`;
      }
      case 'WBLK': {
        const bytes = fromHex(a);
        if (!bytes) return null;
        master.writeBlock(bytes);
        return `W1_DATA ${pin} ok`;
      }
      case 'TRIPLET': {
        const d = a === '1' ? 1 : a === '0' ? 0 : null;
        if (d === null) return null;
        const [id, cmp, dir] = master.triplet(d);
        return `W1_DATA ${pin} ${id}${cmp}${dir}`;
      }
      default:
        return null;
    }
  }

  // ── The request grammar, answered over the objects above ───────────────
  /**
   * Answer one guest request line. Returns the reply line, null for lines
   * that carry no answer (PWM, GPIO_SETUP, SPI CONFIG) and for lines the
   * grammar does not know. The Linux relay and the in-browser engine both
   * call this, so a sensor answers the same in either mode.
   */
  answerBusLine(line: string): string | null {
    const parts = line.trim().split(/\s+/);
    switch (parts[0]) {
      case 'I2C':
        return this.answerI2C(parts);
      case 'SPI':
        return this.answerSPI(parts);
      case 'W1': {
        const pin = parseCount(parts[1]);
        if (pin === null) return null;
        return this.w1Op(pin, parts.slice(2));
      }
      case 'PWM': {
        // PWM <ch> <period_ns> <duty_ns> <en>: the sysfs pwmchip contract.
        const ch = parseCount(parts[1]);
        const period = Number(parts[2]);
        const duty = Number(parts[3]);
        const pin = ch === null ? undefined : PWM_CHANNEL_PINS[ch];
        if (pin === undefined || !(period > 0) || !(duty >= 0)) return null;
        const enabled = parts[4] === '1';
        this.applyPwm(pin, 1e9 / period, enabled ? (100 * duty) / period : 0);
        return null;
      }
      case 'PWM_START':
      case 'PWM_CHANGE': {
        const pin = parseCount(parts[1]);
        const hz = Number(parts[2]);
        const duty = Number(parts[3]);
        if (pin === null || !Number.isFinite(hz) || !Number.isFinite(duty)) return null;
        this.applyPwm(pin, hz, duty);
        return null;
      }
      case 'PWM_STOP': {
        const pin = parseCount(parts[1]);
        if (pin !== null) this.applyPwm(pin, 0, 0);
        return null;
      }
      case 'GPIO_SETUP': {
        const pin = parseCount(parts[1]);
        if (pin === null) return null;
        const pull = parts[3] === 'pud_up' ? 1 : parts[3] === 'pud_down' ? 2 : 0;
        this.setPinPull(pin, pull);
        return null;
      }
      default:
        return null;
    }
  }

  private answerI2C(parts: string[]): string | null {
    const bus = parseCount(parts[1]);
    const addr = parts[2] !== undefined && /^[0-9a-fA-F]{1,2}$/.test(parts[2]) ? parseInt(parts[2], 16) : null;
    if (bus === null || addr === null) return null;
    const op = parts[3];
    let write: number[] | null = [];
    let readLen: number | null = 0;
    switch (op) {
      case 'R':
        readLen = parseCount(parts[4]);
        break;
      case 'W':
        write = fromHex(parts[4]);
        break;
      case 'RR': {
        const reg = fromHex(parts[4]);
        write = reg && reg.length === 1 ? reg : null;
        readLen = parseCount(parts[5]);
        break;
      }
      case 'WR': {
        const reg = fromHex(parts[4]);
        const data = fromHex(parts[5]);
        write = reg && reg.length === 1 && data ? [...reg, ...data] : null;
        break;
      }
      case 'T':
        write = fromHex(parts[4]);
        readLen = parseCount(parts[5]);
        break;
      default:
        return null;
    }
    if (write === null || readLen === null) return null;
    const addrHex = addr.toString(16).padStart(2, '0');
    const data = this.i2cTransfer(addr, write, readLen, bus);
    if (data === null) return `I2C_ERR ${bus} ${addrHex} nack`;
    return data.length ? `I2C_DATA ${bus} ${addrHex} ${toHex(data)}` : `I2C_DATA ${bus} ${addrHex}`;
  }

  private answerSPI(parts: string[]): string | null {
    const bus = parseCount(parts[1]);
    const cs = parseCount(parts[2]);
    if (bus === null || cs === null) return null;
    const op = parts[3];
    if (op === 'CONFIG') return null;
    if (op !== 'X' && op !== 'XC') return null;
    const mosi = fromHex(parts[4]);
    if (mosi === null) return null;
    const miso = this.spiTransfer(bus, cs, mosi, op === 'XC');
    return `SPI_DATA ${bus} ${cs} ${toHex(miso)}`;
  }
}
