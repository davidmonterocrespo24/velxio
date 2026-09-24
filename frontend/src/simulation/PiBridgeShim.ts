/**
 * PiBridgeShim — the simulator-shaped object a Linux-guest board (the
 * Raspberry Pi family and any overlay-registered kind of the same family)
 * hands to the parts wired to it.
 *
 * Why it exists: every part on the canvas attaches to
 * `getBoardSimulator(boardId)` and asks it for a bus (`addI2CDevice`), a pin
 * (`setPinState`, `pinManager`) or an ADC
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
 *   SPI <bus> <cs> W | WC <hex>          X / XC with nothing waiting for MISO
 *   SPI <bus> <cs> CONFIG <hz> <mode> <bits>   the handle's settings, nothing to answer
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
 *   I2C_ERR  <bus> <addr> nack data      the address was, a data byte was not
 *   SPI_DATA <bus> <cs> <hex>            the bytes clocked in on MISO
 *   W1_LIST  <pin> [<rom>,...]           ROM ids on that pin
 *   W1_SLAVE <pin> <rom> <18hex> <crc_ok>  a slave's 9-byte scratchpad
 *   W1_DATA  <pin> <hex|0|1|ok>          the byte-level ops
 *   W1_ERR   <pin> no-master             nothing registered on that pin
 *   (null)                               lines that need no answer (PWM, GPIO_SETUP, CONFIG)
 *
 * SPI (project board-buses-2026-09): the board's two header controllers are
 * bus-fabric ports ({@link getBusBinding}), one per controller and created
 * with the shim, so a guest reboot, Stop/Run or a switch between the two
 * engines changes who clocks the bytes and never the port. The CE lines are
 * the controller's own chip selects, reported to the fabric as such. The
 * fabric is the only SPI path: a part is on this bus because its pins are on
 * the controller's nets, never because it hooked a callback here.
 *
 * I2C (F5) has the same shape: I2C0 and I2C1 are ports, a request line's
 * `<bus>` picks the port, and the fabric answers from the targets whose SDA is
 * on that controller's net. The backend relay is told which addresses exist on
 * which bus from the same placement ({@link busTopology}).
 */

import { I2CBusManager, nullI2CMaster, type I2CDevice } from './I2CBusManager';
import type { PinManager } from './PinManager';
import type { RaspberryPi3Bridge, PiBusTopology } from './RaspberryPi3Bridge';
import type { LineSupport } from './line/LineHost';
import { recordPartGap } from './line/requestLine';
import { requestElectricalResolve } from './spice/electricalResolveHook';
import { getBoardLineSupport, getPiBusOp } from '../lib/proBoardRegistry';
import type { OneWireByteMaster } from './oneWireHost';
import { busRegistry } from './buses/registry';
import { functionsOfPin, getBoardPinFunctions, type SpiSignal } from './buses/pinFunctions';
// Every OSS board's pin function table, which says where this board's pads are.
import './buses/boardPinTables';
import type {
  EngineBinding,
  I2cControllerPort,
  I2cRouting,
  I2cTransactionHandler,
  SpiControllerConfig,
  SpiControllerPort,
  SpiMode,
  SpiRouting,
} from './buses/types';
import { boardPinsFromPinManager } from './buses/boardPins';

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

/**
 * A browser-side host for the line sensors this board takes.
 *
 * The models normally run where the guest does — for a Linux guest that is
 * the backend, because a `GPIO_IN` is answered from its pin table and a level
 * computed here would arrive after the read it belongs to. The in-browser
 * lane has no backend at all, so whoever runs the script there installs one
 * of these and hosts the model itself, off the same protocol lines.
 *
 * The shim knows nothing about any particular sensor: it takes the record,
 * forwards it to the backend, and hands it here too.
 */
export interface PiLineHost {
  attach(record: Record<string, unknown>): void;
  update(pin: number, props: Record<string, unknown>): void;
  detach(pin: number): void;
  /** Pins a hosted model drives itself, so no other layer seeds them. */
  ownsPin(pin: number): boolean;
}

export interface PiBridgeShimOptions {
  boardId: string;
  boardKind: string;
  bridge: RaspberryPi3Bridge;
  pinManager: PinManager;
  /** The board's live store record (running flag, engine mode). */
  boardState: () => PiShimBoardState | undefined;
}

/** One SPI controller's header pins: BCM GPIO numbers, which are the board pins. */
interface PiSpiPins {
  sck: number;
  mosi: number;
  miso: number;
  /** Chip selects by the guest's `cs` index: CE0, CE1, CE2. */
  ce: readonly number[];
}

/**
 * Where the guest image puts each controller: SPI0 (`dtparam=spi=on`:
 * /dev/spidev0.0 and 0.1) and SPI1, the auxiliary controller
 * (`dtoverlay=spi1-3cs`), on the Raspberry Pi's 40-pin header.
 */
const GUEST_SPI_PINS: Record<number, PiSpiPins> = {
  0: { sck: 11, mosi: 10, miso: 9, ce: [8, 7] },
  1: { sck: 21, mosi: 20, miso: 19, ce: [18, 17, 16] },
};

/**
 * The guest's pads for controller `unit`, when the board's pin function table
 * says those pads carry that controller (every Raspberry Pi from the Zero to
 * the 5). Another board of the family boots the same image on another pinout
 * (the UNIHIKER), so its table, not its name, decides: null there, and while
 * the board's table is not registered yet (undefined).
 */
function guestSpiPins(boardKind: string, unit: number): PiSpiPins | null | undefined {
  if (!getBoardPinFunctions(boardKind)) return undefined;
  const pins = GUEST_SPI_PINS[unit];
  if (!pins) return null;
  const carries = (pin: number, signal: SpiSignal, csIndex?: number) =>
    functionsOfPin(boardKind, pin).some(
      (f) =>
        f.bus === 'spi' &&
        f.unit === unit &&
        f.signal === signal &&
        (csIndex === undefined || f.csIndex === csIndex),
    );
  const onBoard =
    carries(pins.sck, 'sck') &&
    carries(pins.mosi, 'mosi') &&
    carries(pins.miso, 'miso') &&
    pins.ce.every((pin, i) => carries(pin, 'cs', i));
  return onBoard ? pins : null;
}

/** The SPI controllers a line's `<bus>` can name, by unit. */
const SPI_UNITS = [0, 1] as const;

/** What a guest's spidev handle programmed (`SPI <bus> <cs> CONFIG`). */
interface PiSpiSettings {
  hz: number;
  mode: SpiMode;
}

const UNROUTED: SpiRouting = Object.freeze({});

/**
 * One SPI controller of the board as the bus fabric sees it. Created once with
 * the shim and never replaced: whichever engine runs the script (the Linux
 * guest through the relay, or the in-browser one) clocks its transactions
 * through the same port, and a guest reboot or Stop/Run only powers it off.
 *
 * SPI0 is on from boot, as the guest's device tree has it. SPI1 comes up the
 * first time the guest configures or clocks it, the moment a Pi would have
 * loaded its overlay, and goes down again with the guest: until then its pads
 * are plain GPIOs and the fabric must not route the controller to them.
 */
class PiSpiPort implements SpiControllerPort {
  readonly bus = 'spi' as const;
  readonly unit: number;
  readonly name: string;
  frameHandler: ((mosi: number, bits: number) => number) | null = null;
  blockHandler: ((mosi: Uint8Array, miso: Uint8Array | null) => void) | null = null;
  csHandler: ((index: number, active: boolean) => void) | null = null;
  /** Chip select of the transaction in progress, or of the last one. */
  activeCs = 0;
  private routingHandler: (() => void) | null = null;
  private readonly settings = new Map<number, PiSpiSettings>();
  private readonly onFromBoot: boolean;
  private on: boolean;
  private readonly boardKind: string;
  /** The board's pads for this controller, once its pin function table is known. */
  private pads: { pins: PiSpiPins | null; routed: SpiRouting } | null = null;

  constructor(unit: number, boardKind: string, onFromBoot: boolean) {
    this.unit = unit;
    this.name = `SPI${unit}`;
    this.boardKind = boardKind;
    this.onFromBoot = onFromBoot;
    this.on = onFromBoot;
  }

  /** Header pins, or null on a board whose pads for this controller are not known. */
  get pins(): PiSpiPins | null {
    return this.resolvePads()?.pins ?? null;
  }

  private resolvePads(): { pins: PiSpiPins | null; routed: SpiRouting } | null {
    if (this.pads) return this.pads;
    const pins = guestSpiPins(this.boardKind, this.unit);
    if (pins === undefined) return null;
    this.pads = {
      pins,
      routed: pins
        ? Object.freeze({ sck: pins.sck, mosi: pins.mosi, miso: pins.miso, cs: [...pins.ce] })
        : UNROUTED,
    };
    return this.pads;
  }

  setFrameHandler(handler: ((mosi: number, bits: number) => number) | null): void {
    this.frameHandler = handler;
  }

  setBlockHandler(handler: ((mosi: Uint8Array, miso: Uint8Array | null) => void) | null): void {
    this.blockHandler = handler;
  }

  setHardwareCsHandler(handler: ((index: number, active: boolean) => void) | null): void {
    this.csHandler = handler;
  }

  setRoutingChangeHandler(handler: (() => void) | null): void {
    this.routingHandler = handler;
  }

  config(): SpiControllerConfig {
    const s = this.settings.get(this.activeCs);
    // Frames are the line's bytes, 8 bits each. Neither the BCM2835 nor the
    // RP1 controller shifts LSB first (spidev answers SPI_LSB_FIRST with
    // EINVAL); the mode and clock are only known once the guest's handle says
    // them (the in-browser engine never does).
    return s
      ? { enabled: this.on, mode: s.mode, bitOrder: 'msb', bits: 8, hz: s.hz }
      : { enabled: this.on, bitOrder: 'msb', bits: 8 };
  }

  routing(): SpiRouting {
    return this.on ? (this.resolvePads()?.routed ?? UNROUTED) : UNROUTED;
  }

  /** The pad a chip-select index drives, if this board has it. */
  cePin(cs: number): number | undefined {
    return this.pins?.ce[cs];
  }

  configure(cs: number, settings: PiSpiSettings): void {
    this.settings.set(cs, settings);
    this.enable();
  }

  /** The guest uses this controller: its pads leave GPIO duty. */
  enable(): void {
    if (this.on) return;
    this.on = true;
    this.routingHandler?.();
  }

  /** The guest is gone: its settings go with it, and an overlay controller with them. */
  powerOff(): void {
    this.settings.clear();
    this.activeCs = 0;
    if (this.on && !this.onFromBoot) {
      this.on = false;
      this.routingHandler?.();
    }
  }
}

/**
 * Where the guest image puts its I2C controllers: /dev/i2c-1 (BSC1) on
 * GPIO2/3, the header bus, and /dev/i2c-0 (BSC0) on GPIO0/1, which velxio-busd
 * serves too. The bus number in a request line is the controller's unit.
 */
const GUEST_I2C_PINS: Record<number, { sda: number; scl: number }> = {
  0: { sda: 0, scl: 1 },
  1: { sda: 2, scl: 3 },
};

/** The I2C controllers a line's `<bus>` can name, by unit. */
const I2C_UNITS = [0, 1] as const;

/**
 * One I2C controller of the board as the bus fabric sees it (project
 * board-buses-2026-09, F5). Like PiSpiPort: created once with the shim, and
 * whichever engine runs the script (the Linux guest through the relay, or the
 * in-browser one) runs its transactions through it, so a target is on this
 * controller's bus because its SDA is on the controller's net, never because
 * it hooked the shim.
 *
 * Its pads come from the board's pin function table, as for SPI: a board of
 * the family whose table does not put this controller on the guest's pads
 * routes it nowhere, and every address on it NACKs.
 */
class PiI2cPort implements I2cControllerPort {
  readonly bus = 'i2c' as const;
  readonly unit: number;
  readonly name: string;
  handler: I2cTransactionHandler | null = null;
  private readonly boardKind: string;
  private routed: I2cRouting | null = null;

  constructor(unit: number, boardKind: string) {
    this.unit = unit;
    this.name = `I2C${unit}`;
    this.boardKind = boardKind;
  }

  setTransactionHandler(handler: I2cTransactionHandler | null): void {
    this.handler = handler;
  }

  routing(): I2cRouting {
    if (this.routed) return this.routed;
    const pins = GUEST_I2C_PINS[this.unit];
    if (!getBoardPinFunctions(this.boardKind)) return {};
    const carries = (pin: number, signal: 'sda' | 'scl') =>
      functionsOfPin(this.boardKind, pin).some(
        (f) => f.bus === 'i2c' && f.unit === this.unit && f.signal === signal,
      );
    this.routed =
      pins && carries(pins.sda, 'sda') && carries(pins.scl, 'scl')
        ? Object.freeze({ sda: pins.sda, scl: pins.scl })
        : Object.freeze({});
    return this.routed;
  }
}

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
  private _instantAdapter: PiInstantAdapter | null = null;
  /**
   * The in-browser engine's hooks, when one is running this board.
   *
   * Installing one replays the levels the canvas is driving, for the reason
   * `lineHost` replays its records: a part attaches when it MOUNTS and the
   * engine starts later. An e-paper panel rests its BUSY pad HIGH from the
   * moment it is wired; an engine that never heard that reads 0 and a correct
   * UltraChip driver waits forever for "not busy".
   */
  set instantAdapter(adapter: PiInstantAdapter | null) {
    this._instantAdapter = adapter;
    if (!adapter?.onPinInput) return;
    for (const [pin, state] of this.drivenLevels) adapter.onPinInput(pin, state);
  }

  get instantAdapter(): PiInstantAdapter | null {
    return this._instantAdapter;
  }
  private _lineHost: PiLineHost | null = null;
  /**
   * Where a line model runs in the in-browser lane, when one is installed.
   *
   * Installing one replays the records already taken: a part attaches when it
   * MOUNTS, and the script (with it, the engine that installs the host) starts
   * later. Without the replay a keypad dropped on the canvas before Run would
   * be known to the backend and to nobody in the browser.
   */
  set lineHost(host: PiLineHost | null) {
    this._lineHost = host;
    if (!host) return;
    for (const rec of this.lineSensors.values()) host.attach(rec);
  }

  get lineHost(): PiLineHost | null {
    return this._lineHost;
  }

  private readonly bridge: RaspberryPi3Bridge;
  private readonly boardState: () => PiShimBoardState | undefined;
  private readonly i2cBusInstance: I2CBusManager;
  /** SPI0 and SPI1, by unit. The fabric's view of this board's SPI. */
  private readonly spiPorts: PiSpiPort[];
  /** I2C0 and I2C1, by unit: the fabric's view of this board's I2C. */
  private readonly i2cPorts: PiI2cPort[];
  private readonly busBinding: EngineBinding;
  /** Set while a fabric holds this board's binding (the store binds every board). */
  private resetHandler: (() => void) | null = null;
  /** `bus:cs` of a chip-select held low by an `XC` transfer, if any. */
  private heldCs: { bus: number; cs: number } | null = null;
  private readonly oneWireMasters = new Map<number, OneWireByteMaster>();
  /** Line-contract records this board took, keyed by the record's anchor pin. */
  private readonly lineSensors = new Map<number, Record<string, unknown>>();
  private readonly adcWarned = new Set<number>();
  /** The last level a PART drove on each pin (not a pull's resting level:
   *  that belongs to the run that programmed the pull). Replayed to a fresh
   *  guest and to a fresh in-browser engine. */
  private readonly drivenLevels = new Map<number, boolean>();
  /** Bus-map sync with a relaying backend (see startBusSync). */
  private busTimer: ReturnType<typeof setInterval> | null = null;
  private busMapKey = '';
  /** Last registers pushed, by `bus:addr`. */
  private readonly lastRegs = new Map<string, string>();

  constructor(opts: PiBridgeShimOptions) {
    this.boardId = opts.boardId;
    this.boardKind = opts.boardKind;
    this.bridge = opts.bridge;
    this.pinManager = opts.pinManager;
    this.boardState = opts.boardState;
    this.i2cBusInstance = new I2CBusManager(nullI2CMaster());
    // Every board of the family gets the controllers the guest image serves;
    // each port finds its pads in the board's pin function table.
    this.spiPorts = SPI_UNITS.map((unit) => new PiSpiPort(unit, opts.boardKind, unit === 0));
    this.i2cPorts = I2C_UNITS.map((unit) => new PiI2cPort(unit, opts.boardKind));
    this.busBinding = {
      // A device answering on a GPIO (a bit-banged MISO) is a part driving
      // an input, exactly what setPinState carries to either engine.
      pins: boardPinsFromPinManager(this.pinManager, (pin, level) => this.setPinState(pin, level)),
      spi: this.spiPorts,
      i2c: this.i2cPorts,
      setResetHandler: (handler) => {
        this.resetHandler = handler;
      },
    };
  }

  /** The board as the bus fabric sees it: the same object, and the same ports, for the board's life. */
  getBusBinding(): EngineBinding {
    return this.busBinding;
  }

  // ── Lifecycle (the store drives the guest through the bridge / engine) ──
  start(): void {}
  /** Nothing to halt here: the guest is gone (the store cuts it before this),
   *  so its pads float and its SPI state goes with it, and the bus-map sync
   *  with the backend stops. */
  stop(): void {
    this.spiPowerCycle(true);
    this.stopBusSync();
  }

  /**
   * The guest that programmed the SPI controllers is gone, or a fresh one is
   * about to start: a chip select it held is released, its settings and any
   * overlay controller go away, and the fabric hears an MCU reset. That comes
   * last, so a chip select the fabric re-reads then is never a level the old
   * guest left: on Stop every pad is released first (`releasePads`), as the
   * MCU engines do on reset, and a GPIO the guest held low as a chip select
   * reads "not driven" instead of keeping its chip selected into the next run.
   * A fresh guest announced by the relay leaves the pins alone: the Stop
   * before it already released them, and the levels the parts drive are theirs.
   */
  private spiPowerCycle(releasePads: boolean): void {
    this.releaseHeldCs();
    if (releasePads) this.pinManager.hardResetPinStates();
    for (const port of this.spiPorts) port.powerOff();
    this.resetHandler?.();
  }

  // ── The bus map, for a backend that answers the guest from the canvas ──
  /**
   * What is on this board's buses, as the backend relay needs it: every I2C
   * address with a device, and for each the 256 registers when the device
   * can export them (a register file: BMP280, DS3231, ...). The backend
   * answers an absent address with a NAK and a register-file read from its
   * copy, both without asking this tab; only the rest travels here.
   */
  busTopology(): PiBusTopology {
    const i2c: PiBusTopology['i2c'] = [];
    const seen = new Set<string>();
    // The targets the fabric placed on a bus a controller of this board
    // drives, per controller (project board-buses-2026-09, F5): a sensor wired
    // to GPIO2/3 is on bus 1, one wired to GPIO0/1 on bus 0, and one wired to
    // neither is on no bus at all, so the relay NAKs it without asking.
    for (const t of this.fabricI2cTargets()) {
      const key = `${t.bus}:${t.addr}`;
      if (seen.has(key)) continue;
      seen.add(key);
      i2c.push(t);
    }
    // Parts not on the fabric yet (addI2CDevice) keep the header bus, as they
    // always had. A fabric target at the same address wins the entry: the
    // transfer asks the fabric first.
    for (const dev of this.i2cBusInstance.listDevices()) {
      const key = `${HEADER_I2C_BUS}:${dev.address & 0x7f}`;
      if (seen.has(key)) continue;
      seen.add(key);
      i2c.push({
        bus: HEADER_I2C_BUS,
        addr: dev.address & 0x7f,
        regs: typeof dev.dumpRegisters === 'function' ? toHex(Array.from(dev.dumpRegisters())) : null,
      });
    }
    return { version: 1, i2c, spi: { attached: this.spiAttached() } };
  }

  /**
   * Every address a fabric target answers on this board, by the controller
   * whose bus it is on. A target that can hand over its registers
   * (`dumpRegisters`, as every register-file part the relay mirrors does) is
   * published with them, so the relay answers its reads without a round trip,
   * exactly as for a part on the header manager.
   */
  private fabricI2cTargets(): PiBusTopology['i2c'] {
    if (!this.boundToFabric()) return [];
    const fabric = busRegistry.fabric(this.boardId);
    const out: PiBusTopology['i2c'] = [];
    for (const port of this.i2cPorts) {
      const sda = port.routing().sda;
      const bus = sda === undefined ? undefined : fabric.i2cBuses.get(sda);
      if (!bus) continue;
      for (const m of bus.members.values()) {
        if (!m.clocked) continue;
        const dump = (m.target as { dumpRegisters?: () => Uint8Array }).dumpRegisters;
        const regs =
          typeof dump === 'function' ? toHex(Array.from(dump.call(m.target))) : null;
        for (const addr of m.addresses) out.push({ bus: port.unit, addr, regs });
      }
    }
    out.sort((a, b) => a.bus - b.bus || a.addr - b.addr);
    return out;
  }

  /** Every address answered on I2C bus `bus`, for a NAK message that says
   *  what IS wired there. */
  i2cAddresses(bus: number): number[] {
    return this.busTopology()
      .i2c.filter((d) => d.bus === bus)
      .map((d) => d.addr)
      .sort((a, b) => a - b);
  }

  /**
   * The backend said it relays (`bus_relay`): publish the map, then keep it
   * true. Every 250 ms (the ESP32 proxy's cadence) a changed set of devices
   * republishes the whole map, and a register-file device whose registers
   * changed pushes just its registers — compared byte for byte, because a
   * sampled hash misses the measurement registers a slider moves.
   */
  startBusSync(): void {
    this.stopBusSync();
    // The backend announces a guest it just spawned: whatever the previous one
    // left on the SPI controllers (a guest that died mid-transfer never got a
    // Stop) is not this one's.
    this.spiPowerCycle(false);
    this.publishBusTopology();
    // The guest is fresh: the backend announces `bus_relay` right after it
    // spawns QEMU, and a part that mounted before then sent its attach into a
    // socket that had to drop it. Say them again.
    for (const rec of this.lineSensors.values()) {
      (this.bridge as Partial<RaspberryPi3Bridge>).sendSensorAttach?.(
        String(rec['sensor_type'] ?? ''),
        Number(rec['pin']),
        rec,
      );
    }
    // Same story for a level: a panel that rested its BUSY pad HIGH when it
    // was wired said so to a socket that was not open yet.
    const bridge = this.bridge as Partial<RaspberryPi3Bridge>;
    for (const [pin, state] of this.drivenLevels) {
      bridge.sendPinEvent?.(pin, state);
      bridge.setSensorState?.({ [`pin${pin}`]: state ? 1 : 0 });
    }
    this.busTimer = setInterval(() => this.busTick(), 250);
  }

  stopBusSync(): void {
    if (this.busTimer !== null) clearInterval(this.busTimer);
    this.busTimer = null;
    this.busMapKey = '';
    this.lastRegs.clear();
  }

  private publishBusTopology(): void {
    const topology = this.busTopology();
    this.busMapKey = this.mapKeyOf(topology);
    this.lastRegs.clear();
    for (const dev of topology.i2c) {
      if (dev.regs !== null) this.lastRegs.set(`${dev.bus}:${dev.addr}`, dev.regs);
    }
    // The responders with a portable model, which the backend runs beside the
    // guest by chip enable instead of asking this tab once per transfer
    // (project board-buses-2026-09, F4). Built here and not in busTopology():
    // that one runs on every 250 ms tick, and a map carries each model's
    // artifact and an SD card's whole image. Membership changes reach this
    // through pushBusMap, which the store calls when the registry says so.
    topology.spi.responders = this.boundToFabric() ? busRegistry.remoteSpiMap(this.boardId) : [];
    (this.bridge as Partial<RaspberryPi3Bridge>).sendBusTopology?.(topology);
  }

  /**
   * The registry says who is on this board's SPI changed (the store routes
   * every board's map change here, as it does for the QEMU MCU shims). Only
   * while a relaying backend is listening: before `bus_relay` there is nobody
   * to tell, and startBusSync publishes the whole map when it arrives.
   */
  pushBusMap(): void {
    if (this.busTimer === null) return;
    this.publishBusTopology();
  }

  /**
   * A hosted responder's live inputs changed (the finger, the slider, the
   * circuit solve). The backend applies them to the model it runs for that
   * owner; a map published later carries them too, so nothing is lost while
   * no relay is listening.
   */
  pushBusAttrs(owner: string, attrs: Record<string, number>): void {
    if (this.busTimer === null) return;
    (this.bridge as Partial<RaspberryPi3Bridge>).sendBusAttrs?.(owner, attrs);
  }

  private busTick(): void {
    const topology = this.busTopology();
    if (this.mapKeyOf(topology) !== this.busMapKey) {
      this.publishBusTopology();
      return;
    }
    const bridge = this.bridge as Partial<RaspberryPi3Bridge>;
    for (const dev of topology.i2c) {
      // By bus and address: the same sensor on bus 0 and bus 1 is two devices.
      const key = `${dev.bus}:${dev.addr}`;
      if (dev.regs === null || this.lastRegs.get(key) === dev.regs) continue;
      this.lastRegs.set(key, dev.regs);
      bridge.sendBusRegs?.(dev.bus, dev.addr, dev.regs);
    }
  }

  /** Which devices are where (not their register contents). */
  private mapKeyOf(topology: PiBusTopology): string {
    const i2c = topology.i2c.map((d) => `${d.bus}:${d.addr}:${d.regs === null ? 'ask' : 'regs'}`).sort();
    return `${i2c.join(',')}|spi:${topology.spi.attached ? 1 : 0}`;
  }

  /**
   * Something on the canvas listens on this board's SPI: a device the bus
   * fabric placed on a controller's SCK net. The backend answers the guest's
   * transfers with idle bytes while this is false.
   */
  private spiAttached(): boolean {
    return this.fabricHasSpiDevices();
  }

  /** Whether the page's fabric for this board holds THIS shim's binding. */
  private boundToFabric(): boolean {
    // Only a bound board has a fabric to ask (asking creates one otherwise).
    if (!this.resetHandler) return false;
    return busRegistry.fabric(this.boardId).pins === this.busBinding.pins;
  }

  private fabricHasSpiDevices(): boolean {
    // Only the page's fabric holding THIS binding speaks for it.
    if (!this.boundToFabric()) return false;
    const fabric = busRegistry.fabric(this.boardId);
    return this.spiPorts.some(
      (p) => p.pins !== null && (fabric.spiBuses.get(p.pins.sck)?.size ?? 0) > 0,
    );
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
    this.drivenLevels.set(pin, state);
    this.applyPinState(pin, state);
  }

  private applyPinState(pin: number, state: boolean): void {
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
    // Seeded, not remembered: a pull belongs to the script that programmed it,
    // and replaying it into the next run would hold a pin at a level nothing
    // on the canvas drives. A pin a part DOES drive keeps the part's level.
    if (pull !== 0 && !this.pinManager.getOutputPins().has(pin) && !this.drivenLevels.has(pin)) {
      this.applyPinState(pin, pull === 1);
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
   *  DHT22 / HC-SR04 as hosted values, or a membrane keypad); the default is
   *  a refusal with the reason, so the part hears it and the circuit check
   *  shows it. */
  lineSupport(): LineSupport {
    return getBoardLineSupport(this.boardKind) ?? { mode: 'none', why: LINE_SUPPORT_NONE_WHY };
  }

  /**
   * The hosted line-sensor channel (simulation/line/requestLine).
   *
   * This class used to have no `registerSensor` at all, on purpose, so the
   * I2C parts would take their `addI2CDevice` branch and no device was fed
   * twice. That invariant still holds and is worth restating: every one of
   * those parts calls `addI2CDevice?.()` inside the registerSensor branch
   * too, and the extras it reaches for (`addI2CTransactionListener` and its
   * remover) are optional and absent here, so the branch they now take is the
   * one they took before plus a `registerSensor` that declines. The
   * `line_request` guard below is what makes declining exact: only a record
   * the line contract built is ours.
   *
   * WHERE THE MODEL RUNS is not this class's business. Under QEMU it runs in
   * the backend, because a guest read is answered from the backend's own pin
   * table and a level computed in the browser would arrive after the read it
   * belongs to; the record is forwarded there. In the in-browser lane there
   * is no backend at all, and whoever runs the script installs a
   * {@link PiLineHost} to host the model itself. Both get the record; a board
   * runs one lane or the other, so the two never drive the same wire.
   *
   * A type this board declared that no model here covers reaches the guest by
   * another route entirely (the UNIHIKER's named values, pushed on their own
   * timer), so saying yes is what stops the circuit check warning about a
   * sensor that does work.
   */
  registerSensor(type: string, pin: number, props: Record<string, unknown>): boolean {
    if (props.line_request !== true) return false;
    const rec: Record<string, unknown> = { ...props, sensor_type: type, pin };
    this.lineSensors.set(pin, rec);
    (this.bridge as Partial<RaspberryPi3Bridge>).sendSensorAttach?.(type, pin, props);
    this._lineHost?.attach(rec);
    return true;
  }

  updateSensor(pin: number, props: Record<string, unknown>): void {
    const rec = this.lineSensors.get(pin);
    if (!rec) return;
    Object.assign(rec, props);
    (this.bridge as Partial<RaspberryPi3Bridge>).sendSensorUpdate?.(pin, props);
    this._lineHost?.update(pin, props);
  }

  unregisterSensor(pin: number): void {
    if (!this.lineSensors.delete(pin)) return;
    (this.bridge as Partial<RaspberryPi3Bridge>).sendSensorDetach?.(pin);
    this._lineHost?.detach(pin);
  }

  /** Pins a hosted line model drives, so no other layer seeds them. */
  ownsPin(pin: number): boolean {
    return this._lineHost?.ownsPin(pin) ?? false;
  }

  /**
   * A responder the relay hosts wrote into its storage (`bus_blob`): the guest
   * saved something on a card. The span lands on the tab's copy, which is
   * what the SD panel lists and what the next Run builds the card from; the
   * relay keeps its own model across republishes, so without this the guest's
   * file lives only until the guest stops.
   */
  applyBusBlob(data: Record<string, unknown>): boolean {
    const b64 = typeof data['data'] === 'string' ? data['data'] : '';
    let bytes: Uint8Array;
    try {
      const bin = atob(b64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch {
      return false;
    }
    const owner = String(data['owner'] ?? '');
    const name = String(data['name'] ?? '');
    const offset = Number(data['offset'] ?? 0);
    const blobId = typeof data['blob_id'] === 'string' ? data['blob_id'] : undefined;
    if (!busRegistry.applyRemoteBlob(this.boardId, owner, name, offset, bytes, blobId)) {
      console.warn(`[PiBridgeShim:${this.boardId}] nobody here takes the span ${owner}/${name}@${offset}`);
      return false;
    }
    return true;
  }

  /**
   * A refusal the host sent back after taking the sensor (`sensor_refused`).
   * Filed against the component that asked, so the circuit check prints it
   * exactly like a refusal made in the browser.
   */
  noteSensorRefused(data: Record<string, unknown>): void {
    recordPartGap({
      sensorType: String(data['sensor_type'] ?? ''),
      pin: Number(data['pin'] ?? -1),
      why: String(data['why'] ?? 'this board does not model it'),
      componentId: data['component_id'] ? String(data['component_id']) : undefined,
    });
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
  /** One byte, the RP2040 name: the OSS custom-chip bridge (avrUartTx)
   *  routes a browser-hosted chip's vx_uart_write through `serialWriteByte`
   *  on an rp2040-kind simulator, which this shim is. Without it the board
   *  heard the chip (onSerialData) but the chip's replies went nowhere. */
  serialWriteByte(byte: number): void {
    this.sendSerialBytes([byte & 0xff]);
  }
  /** Text counterpart, the uniform `sim.feedUart(uart, data)` seam. */
  feedUart(uart: number, data: string): boolean {
    this.sendSerialBytes(Array.from(new TextEncoder().encode(data)), uart);
    return true;
  }

  // ── I2C: the header bus of the parts not on the fabric yet ─────────────
  // A part on the bus fabric (attachI2cTarget) is on the controller its SDA
  // is wired to and is reached through the I2C ports above. The rest keep
  // this one manager on the header bus, as before F5. No
  // `addI2CTransactionListener` on purpose: the parts then take their
  // `addI2CDevice` branch (the AVR / RP2040 path), so every device lives on
  // this one I2CBusManager and nobody feeds it twice. `registerSensor` above
  // exists for the line contract only and declines everything else, which
  // keeps that true: see its comment.
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
   * what the guest turns into errno 121.
   *
   * `bus` is the guest's controller (/dev/i2c-<bus>). Its port hands the
   * transaction to the fabric, which answers from the targets whose SDA is on
   * that controller's net (project board-buses-2026-09, F5). A part not on
   * the fabric yet sits on the header manager and is asked when the fabric
   * NAKs, on the header bus only: that is the one bus those parts ever had.
   */
  i2cTransfer(addr: number, write: readonly number[], readLen: number, bus = HEADER_I2C_BUS): number[] | null {
    const r = this.i2cExchange(addr, write, readLen, bus);
    return Array.isArray(r) ? r : null;
  }

  /**
   * {@link i2cTransfer}, telling an address NAK from a NAK on a data byte.
   * Linux reports both as EREMOTEIO, so the guest cannot tell either; the
   * reply line still says which, for whoever reads it.
   */
  private i2cExchange(
    addr: number,
    write: readonly number[],
    readLen: number,
    bus: number,
  ): number[] | 'nack' | 'nack-data' {
    const port = this.i2cPorts[bus] as PiI2cPort | undefined;
    const viaFabric = port?.handler ? this.fabricI2cTransfer(port.handler, addr, write, readLen) : 'nack';
    if (viaFabric !== 'nack') return viaFabric;
    if (bus !== HEADER_I2C_BUS) return 'nack';
    return this.legacyI2cTransfer(addr, write, readLen) ?? 'nack';
  }

  /** The header manager's transaction, for the parts not on the fabric yet. */
  private legacyI2cTransfer(addr: number, write: readonly number[], readLen: number): number[] | null {
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

  /**
   * The same transaction through a controller port's fabric handler: one
   * event per START, byte and STOP, as the controller would put them on the
   * wire. A NAK at either address phase still ends in a STOP, so every
   * target addressed so far sees it.
   */
  private fabricI2cTransfer(
    h: I2cTransactionHandler,
    addr: number,
    write: readonly number[],
    readLen: number,
  ): number[] | 'nack' | 'nack-data' {
    if (write.length > 0 || readLen === 0) {
      if (!h.start(addr, false)) {
        h.stop();
        return 'nack';
      }
      for (const b of write) {
        // A NAKed byte ends the write there, as the BSC controller does:
        // nothing after it goes out, and the transfer fails.
        if (!h.write(b & 0xff)) {
          h.stop();
          return 'nack-data';
        }
      }
    }
    const out: number[] = [];
    if (readLen > 0) {
      if (!h.start(addr, true)) {
        h.stop();
        return 'nack';
      }
      for (let i = 0; i < readLen; i++) out.push(h.read() & 0xff);
    }
    h.stop();
    return out;
  }

  // ── SPI ────────────────────────────────────────────────────────────────
  // Each transaction goes to its controller's port, whole when the fabric
  // takes blocks and frame by frame otherwise. The fabric is the only path:
  // a device is on this bus because its pins are on the controller's nets.

  /**
   * Clock `mosi` out on `bus` with chip-select `cs` low, return MISO.
   * `holdCs` keeps the select asserted after the last byte (a multi-call
   * transaction); the next transfer on another select, or without the hold,
   * releases it.
   */
  spiTransfer(bus: number, cs: number, mosi: readonly number[], holdCs = false): number[] {
    return Array.from(this.clockSpi(bus, cs, mosi, holdCs, true) ?? []);
  }

  /** One transfer; `wantMiso` false is a write nothing reads back (`W`). */
  private clockSpi(
    bus: number,
    cs: number,
    mosi: readonly number[],
    holdCs: boolean,
    wantMiso: boolean,
  ): Uint8Array | null {
    const port = this.spiPorts[bus] as PiSpiPort | undefined;
    const held = this.heldCs !== null && this.heldCs.bus === bus && this.heldCs.cs === cs;
    if (!held) {
      this.releaseHeldCs();
      if (port) {
        port.enable();
        port.activeCs = cs;
      }
      this.driveCe(bus, cs, true);
    }
    const tx = new Uint8Array(mosi.length);
    for (let i = 0; i < tx.length; i++) tx[i] = mosi[i] & 0xff;
    const rx = wantMiso ? new Uint8Array(tx.length) : null;
    // A bus number with no controller behind it clocks into nothing.
    if (port) this.exchange(port, tx, rx);
    else rx?.fill(0xff);
    if (holdCs) {
      this.heldCs = { bus, cs };
    } else {
      this.heldCs = null;
      this.driveCe(bus, cs, false);
    }
    return rx;
  }

  /**
   * The controller drives its CE line: the fabric hears a hardware chip
   * select, and the pad follows it, low while selected, for whatever else is
   * wired to it and the legacy parts that watch it. Hardware first, so both
   * agree at every moment a listener can look.
   */
  private driveCe(bus: number, cs: number, active: boolean): void {
    const port = this.spiPorts[bus] as PiSpiPort | undefined;
    const pin = port?.cePin(cs);
    if (!port || pin === undefined) return;
    port.csHandler?.(cs, active);
    this.pinManager.triggerPinChange(pin, !active, 'mcu');
  }

  /**
   * One transaction on `port`: exactly one fabric answer per frame. `rx` null
   * means nobody reads MISO back.
   */
  private exchange(port: PiSpiPort, tx: Uint8Array, rx: Uint8Array | null): void {
    // The whole transaction at once: CS cannot move while the guest waits for
    // the line's answer, so the fabric can hand it to a sink in one call.
    const block = port.blockHandler;
    if (block) {
      block(tx, rx);
      return;
    }
    const frame = port.frameHandler;
    for (let i = 0; i < tx.length; i++) {
      const miso = frame ? frame(tx[i], 8) & 0xff : 0xff;
      if (rx) rx[i] = miso;
    }
  }

  private releaseHeldCs(): void {
    if (!this.heldCs) return;
    const { bus, cs } = this.heldCs;
    this.heldCs = null;
    this.driveCe(bus, cs, false);
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
      default: {
        // Not this grammar's: an overlay may answer it (registerPiBusOp). A
        // handler that throws must not take the bus down with it.
        const extra = parts[0] ? getPiBusOp(parts[0]) : undefined;
        if (!extra) return null;
        try {
          return extra(this.boardId, parts);
        } catch (e) {
          // The op's name came off the wire: it stays out of the log line (a
          // first argument is a format string to console.warn).
          console.warn('[pi] a registered bus op failed:', e);
          return null;
        }
      }
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
    const data = this.i2cExchange(addr, write, readLen, bus);
    if (data === 'nack') return `I2C_ERR ${bus} ${addrHex} nack`;
    // `nack` stays the fourth word, which is all velxio-busd and the tab's
    // fcntl shim read (both raise EREMOTEIO on it); the fifth says the address
    // was answered and a data byte was not.
    if (data === 'nack-data') return `I2C_ERR ${bus} ${addrHex} nack data`;
    return data.length ? `I2C_DATA ${bus} ${addrHex} ${toHex(data)}` : `I2C_DATA ${bus} ${addrHex}`;
  }

  private answerSPI(parts: string[]): string | null {
    const bus = parseCount(parts[1]);
    const cs = parseCount(parts[2]);
    if (bus === null || cs === null) return null;
    const op = parts[3];
    if (op === 'CONFIG') {
      // CONFIG <hz> <mode> <bits>: what the handle programmed, sent before its
      // first transfer. The fabric reads the mode off the port to check it
      // against each chip's.
      const hz = Number(parts[4]);
      const mode = Number(parts[5]);
      const port = this.spiPorts[bus] as PiSpiPort | undefined;
      if (port && Number.isInteger(hz) && hz >= 0 && Number.isInteger(mode)) {
        port.configure(cs, { hz, mode: (mode & 3) as SpiMode });
      }
      return null;
    }
    // W and WC are X and XC with no MISO buffer on the other side. A Linux
    // guest writing a display frame passes rx == NULL to SPI_IOC_MESSAGE, and
    // until this existed the daemon still waited for the bytes it was about to
    // throw away: a full round trip to this tab per chunk, seconds per frame.
    // Clocking the bytes out is identical; only the answer is dropped.
    const writeOnly = op === 'W' || op === 'WC';
    if (op !== 'X' && op !== 'XC' && !writeOnly) return null;
    const mosi = fromHex(parts[4]);
    if (mosi === null) return null;
    const miso = this.clockSpi(bus, cs, mosi, op === 'XC' || op === 'WC', !writeOnly);
    if (!miso) return null;
    return `SPI_DATA ${bus} ${cs} ${toHex(Array.from(miso))}`;
  }
}

