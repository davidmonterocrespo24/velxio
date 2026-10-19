/**
 * Bus fabric contracts (project board-buses-2026-09, DESIGN sections 3 and 4).
 *
 * Three roles, one contract each:
 *  - a CONTROLLER PORT is the engine's face: one per serial peripheral of the
 *    SoC, created once per board and re-bound by its adapter whenever the
 *    engine rebuilds the SoC (reset, Stop/Run, firmware reload, engine swap);
 *  - a DEVICE is anything that talks on a bus: canvas parts, the board's own
 *    peripherals, custom chips, the software-bus decoders;
 *  - the FABRIC sits between them, decides membership from the circuit's nets
 *    and arbitrates like the wire does (chip select, address, line).
 *
 * Nothing here knows a simulator object. A device never touches an engine
 * hook, and an engine never sees a device, so neither can depend on the order
 * the other one attached in.
 */

import type { BusKind } from './pinFunctions';
import type { SpiBus } from './spiBus';
import type { BoardPinHost } from '../customChips/busNets';

// ── Pins ────────────────────────────────────────────────────────────────────

/** A pin of a canvas component, resolved through the circuit's nets. */
export interface ComponentPinRef {
  kind: 'component';
  componentId: string;
  pinName: string;
}

/** A pin of a board directly: a board's own peripheral (the M5Stack LCD). */
export interface BoardPinRef {
  kind: 'board';
  boardId: string;
  pin: number;
}

export type PinRef = ComponentPinRef | BoardPinRef;

/**
 * Where a device pin lands once the nets are walked.
 *  - board: a GPIO of `boardId` (a PinManager key, >= 0);
 *  - chip: a synthetic chip-net key (a custom chip drives it, not a board);
 *  - rail: tied to ground or to a supply;
 *  - floating: wired to nothing that drives it (or not wired at all).
 */
export type ResolvedPin =
  | { kind: 'board'; boardId: string; pin: number }
  | { kind: 'chip'; boardId: string | null; pin: number }
  | { kind: 'rail'; rail: 'gnd' | 'vcc' }
  | { kind: 'floating' };

/** What the fabric needs to know about the circuit. Backed by the store in the
 *  app; a plain object in tests. */
export interface NetResolver {
  resolve(ref: PinRef): ResolvedPin;
  /**
   * Every board pin on the pin's net, one per board it reaches. A net that
   * runs from one board's SDA to another's carries a chip on it to BOTH
   * masters, and an I2C target is placed on each of them (F5, the
   * cross-board case). Optional: a resolver without it reaches one board,
   * the one `resolve` names.
   */
  resolveAll?(ref: PinRef): ResolvedPin[];
  /** Board kind of a board id, or undefined for a board that is gone. */
  boardKind(boardId: string): string | undefined;
  /** Board ids present in the project, in canvas order. */
  boards(): string[];
}

// ── SPI ─────────────────────────────────────────────────────────────────────

export type SpiMode = 0 | 1 | 2 | 3;
export type BitOrder = 'msb' | 'lsb';

/** A device pin: a pin name of the owning component, or an explicit ref. */
export type DevicePin = string | PinRef;

export interface SpiDeviceDescriptor {
  /** Identity: the component id, or 'builtin:<boardId>:<name>'. Unique. A
   *  module with two chips on one board (a display and its touch controller)
   *  registers two owners, e.g. '<id>:display' and '<id>:touch'. */
  owner: string;
  /** Component whose pin names `pins` refers to. Defaults to `owner`. */
  componentId?: string;
  pins: {
    sck: DevicePin;
    mosi?: DevicePin;
    miso?: DevicePin;
    /** Omitted = the chip has no select line (a 74HC595 latch). */
    cs?: DevicePin;
  };
  /**
   * Which leg the chip answers on. Default 'miso'. A three-wire SPI chip (an
   * ST7789 wired SDA-only, the M5 Cardputer's panel) has one data line: it
   * listens on it and answers on it, and the master reads it half-duplex
   * (ESP32 SPI_USR_SIO). The engines clock bytes, not wires, so such a chip
   * answers whenever the master reads, provided its MOSI leg is wired.
   */
  dataOut?: 'miso' | 'mosi';
  /** Level that selects the chip. Default 'low'. */
  csActive?: 'low' | 'high';
  /** What an undriven CS means for this chip (its internal pull). Default:
   *  deselected, with a diagnostic, because most breakouts have no pull. */
  csWhenFloating?: 'deselected' | 'selected';
  /** SPI modes the chip accepts. Default: any. */
  modes?: SpiMode[];
  /** Bit order the chip shifts in. Default 'msb'. */
  bitOrder?: BitOrder;
  /**
   * The chip as a portable model, for a board whose master is not in this tab
   * (project board-buses-2026-09, F4). A QEMU worker asks for MISO
   * synchronously, so a responder that only exists here answers a byte the
   * guest clocked long ago. The fabric ships this model to the worker instead
   * and the model answers beside the guest; the device object above stays the
   * tab's copy (it paints, it collects the user's input).
   *
   * Returns null while the part has nothing to send - the bytes are not
   * loaded yet, or the chip has no portable model at all. On a remote lane a
   * selected responder in that state is reported
   * (`bus-remote-responder-missing`) rather than left half working, so this is
   * deliberately synchronous: a model that arrives after the guest has started
   * clocking is the same late answer this whole design exists to avoid.
   */
  remoteModel?(): RemoteSpiModel | null;
  /**
   * Whether `remoteModel()` would return a model, answered WITHOUT building
   * one. The bus asks on every chip-select edge of a remote lane, to name a
   * selected responder that has no model (`bus-remote-responder-missing`),
   * and building the microSD's model is a dump and a base64 of its whole
   * image: 8 MB per edge. A part whose model is that expensive answers here;
   * one that leaves it out is asked through `remoteModel()` itself.
   */
  hasRemoteModel?(): boolean;
  /**
   * The tab still needs the bytes clocked under this device's select when a
   * worker hosts its model: the model only answers MISO, and what the master
   * WRITES is decoded here. A panel that answers its id (M5GFX's board probe)
   * and is otherwise a display is the case: hosted for the id, a sink for the
   * pixels. Without this a hosted responder counts as fully served by the
   * worker, which then keeps its bytes to itself (RemoteSpiSinksEntry) and the
   * screen stays dark while the id reads right.
   */
  remoteKeepsTabCopy?: boolean;
  /**
   * The model's LIVE inputs, read now: the finger on the glass, the voltage
   * the circuit solve put on a channel, a temperature slider. They are the
   * model's attributes (vx_attr_read), so the same names a map entry carries in
   * `model.attrs`, and they win over those when both are present.
   *
   * Separate from `remoteModel()` because they travel separately: the map goes
   * once per membership change and carries the whole artifact, while these go
   * every time the part calls `BusHandle.attrsChanged()`, as a message a few
   * dozen bytes long. A drag of a finger re-sending the map would push the
   * artifact (and an SD card's whole image) at the pointer's rate.
   */
  remoteAttrs?(): Record<string, number>;
  /**
   * The hosted model wrote into one of its named blobs (the guest saved a
   * file on the card): `data` now sits at `offset` of blob `name`. The tab's
   * copy is what the SD panel lists and what the next map ships back, so it
   * has to follow. It used to follow by decoding the relayed bytes; the worker
   * now keeps a transaction no sink can see to itself (F4-SPEC, "Worker, por
   * byte", step 3) and sends the written span instead (`bus_blob`).
   *
   * A device whose model carries blobs and does NOT implement this is treated
   * as a sink, so its bytes keep being relayed: without either path its copy
   * would silently fall behind what the guest wrote.
   */
  remoteBlobWrite?(name: string, offset: number, data: Uint8Array, blobId?: string): void;
}

/**
 * What the worker needs to run a responder next to the guest: the same shape
 * a custom chip is shipped with, because it is the same runtime
 * (`wasm_chip_runtime.py`, `ChipRuntime.ts`).
 */
export interface RemoteSpiModel {
  /** The compiled chip, base64. */
  wasmB64: string;
  /** Chip pin name -> board GPIO. The fabric fills the bus pins it resolved;
   *  a model with extra legs (an interrupt output) adds them here. */
  pinMap?: Record<string, number>;
  /**
   * The chip's own pad name for each bus signal, when the part registers
   * under different names. A card inside a shield registers the shield's pads
   * (D8, D10, D9, D2) because that is what the circuit resolves, while the
   * model watches its select under the chip's name (CS). Without this the
   * watch is registered against a pad the host never moves and the card
   * never ends a command frame.
   */
  chipPads?: Partial<Record<'sck' | 'mosi' | 'miso' | 'cs', string>>;
  /** vx_attr values, by name. */
  attrs?: Record<string, number>;
  /** Named byte storage (the SD card image), base64 per name. */
  blobs?: Record<string, string>;
  /**
   * Which image each blob is, by name: changes when the part loads a
   * different one, never when the guest writes to it. A host keeps a running
   * model across maps while its identity (artifact, select, pins, these ids)
   * holds, because its copy of the blob is newer than the map's; see
   * `hosted_model_identity` in wasm_chip_runtime.py. A blob with no id is
   * compared by content, which cannot tell a card that is behind from a card
   * that was swapped.
   */
  blobIds?: Record<string, string>;
}

export interface SpiDevice {
  /**
   * True when this model never drives MISO, in any state: a display that is
   * only ever written to. Whether a device ANSWERS is a fact about the model,
   * not about the silkscreen. A real ILI9341 has an SDO leg, and a user who
   * wires it is wiring something real, but a model that implements no read
   * command leaves that leg in high impedance for the whole run.
   *
   * The bus asks this, not "does the descriptor name a MISO pin", whenever it
   * needs to know if the device is a responder: it then never counts the
   * device as a MISO driver, never reports it as a responder a remote lane
   * cannot host (`bus-remote-responder-missing`), and never tells the user to
   * wire a MISO the model would not use. The wiring checks that compare where
   * the leg lands with the controller's pins still apply: a crossed wire is a
   * crossed wire. Leave it out for anything that can answer; the default is
   * the safe one, since a responder mistaken for a sink reads idle silently.
   */
  readonly writeOnly?: boolean;
  /** Chip select went active: a transaction starts. */
  select?(): void;
  /** Chip select went inactive: the real chip resets its frame state here. */
  deselect?(): void;
  /**
   * One frame clocked while this device is selected. Return the MISO the chip
   * drives for it, or null when it leaves MISO in high impedance (a write-only
   * display). `bits` is the frame width (8 for almost everything).
   */
  transfer(mosi: number, bits: number): number | null;
  /**
   * What the chip will shift out on its NEXT frame, without consuming
   * anything. A real chip puts its MISO bits on the wire before it has seen the
   * byte the master is clocking in, so a software (bit-banged) master reads
   * them bit by bit ahead of time. Responders implement it; write-only sinks
   * leave it out (their MISO is high impedance). Hardware controllers never
   * need it: the engine exchanges the whole frame in one call.
   */
  peekMiso?(): number | null;
  /**
   * Optional fast path for write-only sinks: a whole block clocked in one go
   * while the selection could not change (DMA, a W-buffer transaction). A
   * device that implements it must behave exactly as if every byte had gone
   * through transfer() with a null answer.
   */
  transferBlock?(mosi: Uint8Array): void;
  /** The MCU was reset (Stop/Run, reset, reload). Protocol state, not data. */
  boardReset?(): void;
}

export interface SpiControllerConfig {
  enabled: boolean;
  mode?: SpiMode;
  bitOrder?: BitOrder;
  bits?: number;
  hz?: number;
}

/** Pins a controller is routed to right now, when the engine knows it. */
export interface SpiRouting {
  sck?: number;
  mosi?: number;
  miso?: number;
  /** Hardware chip-select outputs, by index. */
  cs?: Array<number | undefined>;
}

/**
 * The engine's side of one SPI controller. Created ONCE per board by the
 * engine adapter and kept across every rebuild of the SoC.
 */
export interface SpiControllerPort {
  readonly bus: 'spi';
  /** The SoC's index for this controller (matches the pin function table). */
  readonly unit: number;
  /** Datasheet name, for diagnostics. */
  readonly name: string;
  /**
   * True when the master runs outside this tab (a QEMU worker). The bus reads
   * it to know that a responder here cannot answer in time, and says so once
   * instead of letting the guest read a byte meant for an earlier one.
   */
  readonly remote?: boolean;
  /**
   * The fabric installs the frame handler here. The adapter calls it exactly
   * once per frame the controller clocks and hands the returned MISO to the
   * engine exactly once, synchronously, for THAT frame.
   */
  setFrameHandler(handler: ((mosi: number, bits: number) => number) | null): void;
  /**
   * Optional: a whole transaction the engine clocks in one call. The fabric
   * fills `miso` (when the engine keeps MISO) and returns. Adapters that do
   * not implement it deliver every byte through the frame handler.
   */
  setBlockHandler?(handler: ((mosi: Uint8Array, miso: Uint8Array | null) => void) | null): void;
  config(): SpiControllerConfig;
  /** Live routing, or 'static' when the pins are fixed by the board table. */
  routing(): SpiRouting | 'static';
  /** Hardware chip-select events, for controllers that drive CS themselves. */
  setHardwareCsHandler?(handler: ((index: number, active: boolean) => void) | null): void;
  /** Routing changed (the sketch moved the pins): the fabric recomputes. */
  setRoutingChangeHandler?(handler: (() => void) | null): void;
  /**
   * Optional: the fabric installs a query for the MISO the controller would
   * read on every frame because nothing on its bus can drive the line (the
   * line's idle level), or null when something can. An engine that cannot
   * ask the bus inline (it runs on another thread) answers such reads itself.
   */
  setIdleMisoQuery?(query: (() => number | null) | null): void;
  /** Optional: the fabric installs a query for the bus the controller is routed to (null: none). */
  setBusQuery?(query: (() => SpiBus | null) | null): void;
}

// ── I2C ─────────────────────────────────────────────────────────────────────

export interface I2cTargetDescriptor {
  /** Identity, as for SPI: the component id, or 'builtin:<boardId>:<name>'. */
  owner: string;
  /** Component whose pin names `pins` refers to. Defaults to `owner`. */
  componentId?: string;
  pins: { scl: DevicePin; sda: DevicePin };
  /**
   * Every 7-bit address the chip answers (an LCD with a separate backlight
   * controller answers two). They all belong to this one registration and all
   * leave with its handle.
   */
  addresses: number[];
  /**
   * The model a remote worker runs for this chip, named by the record type the
   * part sends that worker (`registerSensor('mpu6050', ...)`, 'ssd1306',
   * 'custom-chip', ...). A QEMU guest asks for every ACK and every byte
   * synchronously, so on a board whose master is in a backend worker the
   * target in this tab cannot answer at all: the chip exists there only if
   * the worker has a model of it (`WORKER_I2C_MODELS`). Leave it out for a
   * chip that has none; on a remote bus it is then reported
   * (`bus-remote-responder-missing`) instead of being silently absent.
   */
  remoteModel?: string;
}

/**
 * A chip on an I2C bus. The fabric only calls it for traffic addressed to it:
 * start() for every START or repeated START that names one of its addresses,
 * write()/read() while it is the addressed target, and stop() once per STOP
 * after it took part in the transaction.
 */
export interface I2cTarget {
  /** Address phase for one of this chip's addresses. Return the ACK. */
  start(address: number, read: boolean): boolean;
  /** A data byte from the controller. Return the ACK. */
  write(byte: number): boolean;
  /** The next byte the controller clocks out of the chip. */
  read(): number;
  /** STOP on the bus. */
  stop(): void;
  /** The MCU was reset (Stop/Run, reset, reload). Protocol state, not data. */
  boardReset?(): void;
  /**
   * The clock of the board whose bus the chip was put on, handed over when
   * it is placed there and taken back (null) when it leaves. For a chip that
   * does something on its own between two transactions: the MPU-6050 takes a
   * sample every period and raises DATA_RDY, fills its FIFO and pulses INT
   * whether the sketch talks to it or not. It is the guest's time (see
   * GuestClock), so a sketch that waits 40 ms finds 40 ms of samples however
   * slowly the emulator ran them; no model reads the browser's clock.
   *
   * The object is the fabric's and outlives every rebuild of the SoC: read
   * it when the time is needed, never keep a value of it across a
   * boardReset(), where the guest's counter starts again. A board with no
   * engine bound, or an engine that keeps no time the tab can read (a guest
   * in a backend worker), answers clockHz() 0: there is no time there, and
   * the chip has to make do with the events it is sent.
   */
  setClock?(clock: GuestClock | null): void;
  /**
   * True when this model can NAK while present: its start() or write() may
   * return false, as a user's custom chip can (a chip that refuses a byte, or
   * its own address while busy). A host that has to answer an ACK before
   * this tab has seen the byte (the Raspberry Pi relay, which would otherwise
   * pay a network round trip per write) asks the tab only for the chips that
   * say so, and ACKs the rest itself. Leave it out for a model that ACKs its
   * address and every byte it is sent, which is every display and sensor
   * here.
   */
  readonly mayNak?: boolean;
  /**
   * The registers a copy of the chip's register file cannot answer for
   * (I2CDevice.volatileReads): a host that answers reads from a copy (the
   * Raspberry Pi relay) asks this tab for every read that touches one.
   */
  readonly volatileReads?: readonly number[];
  /**
   * The registers the chip's pointer does not move past
   * (I2CDevice.pointerStays), for a host that keeps a pointer of its own.
   */
  readonly pointerStays?: readonly number[];
  /**
   * The register after which the chip's pointer wraps to 0x00
   * (I2CDevice.pointerWrapsAfter), for a host that keeps a pointer of its
   * own. Absent: after 0xFF.
   */
  readonly pointerWrapsAfter?: number;
}

/**
 * What an I2C controller port calls, once per bus event the SoC produces.
 * Implemented by the fabric; a port never talks to a target itself.
 */
export interface I2cTransactionHandler {
  /** START (or repeated START) plus the address byte. Returns the address ACK. */
  start(address: number, read: boolean): boolean;
  /** One data byte written by the controller. Returns the data ACK. */
  write(byte: number): boolean;
  /** One data byte read by the controller. 0xFF when nobody drives SDA. */
  read(): number;
  stop(): void;
}

/** Pins an I2C controller is routed to right now, when the engine knows it. */
export interface I2cRouting {
  sda?: number;
  scl?: number;
}

/**
 * The engine's side of one I2C controller. Like the SPI port: created ONCE per
 * board by the engine adapter, kept across every rebuild of the SoC.
 */
export interface I2cControllerPort {
  readonly bus: 'i2c';
  /** The SoC's index for this controller (matches the pin function table). */
  readonly unit: number;
  /** Datasheet name, for diagnostics ('TWI', 'I2C1', 'TWIM0'). */
  readonly name: string;
  /**
   * True when the master runs outside this tab (a QEMU worker). Nothing here
   * can answer its events in time, so a target on its bus exists for the
   * guest only through the worker's own model of it; the bus reads this flag
   * to name the targets that have none.
   */
  readonly remote?: boolean;
  /**
   * The fabric installs the handler here. The adapter calls it for every
   * START, byte and STOP the controller puts on the wire and hands the result
   * to the engine exactly once, synchronously, for THAT event.
   */
  setTransactionHandler(handler: I2cTransactionHandler | null): void;
  /** Live routing, or 'static' when the pins are fixed by the board table. */
  routing(): I2cRouting | 'static';
  /** Routing changed (the sketch moved the pins): the fabric recomputes. */
  setRoutingChangeHandler?(handler: (() => void) | null): void;
}

// ── UART ────────────────────────────────────────────────────────────────────

export interface UartEndpointDescriptor {
  /** Identity, as for SPI and I2C: the component id, or 'builtin:<boardId>:<name>'. */
  owner: string;
  /** Component whose pin names `pins` refers to. Defaults to `owner`. */
  componentId?: string;
  /**
   * The device's own RX and TX legs. Each one is placed on its own net: a
   * GPS has only a TX, a display that takes commands only an RX, and a
   * modem both. A leg that reaches no board pin is simply not on any wire.
   */
  pins: { rx?: DevicePin; tx?: DevicePin };
  /**
   * The rate the device talks at (a GPS: 9600). It is what the fabric checks
   * a controller's rate against, what a byte it transmits is clocked at on a
   * plain GPIO, and the bit time a bit-banged byte to it is decoded with.
   * Leave it out for a device that takes whatever rate it is sent (a
   * terminal): no mismatch is ever reported for it, and it cannot sit on a
   * software UART, since a bit time needs a rate.
   */
  baud?: number;
  /** Data bits, parity and stop bits, Arduino style: '8N1' (the default), '7E1', '8N2'. */
  frame?: string;
}

/** A device on a UART line. The fabric hands it every byte that reaches its RX. */
export interface UartEndpoint {
  receive(byte: number): void;
  /** The MCU was reset (Stop/Run, reset, reload). Protocol state, not data. */
  boardReset?(): void;
}

/** The registration handle of a UART endpoint: transmit() puts a byte on its TX net. */
export interface UartHandle extends BusHandle {
  /** A byte the device sends out of its TX leg. Dropped when that leg reaches no board pin. */
  transmit(byte: number): void;
}

/** What a UART controller is configured to, when the engine can say. */
export interface UartConfig {
  /** Baud rate the guest configured; undefined until it has (no invented default). */
  baud?: number;
  /** Frame the guest configured, Arduino style ('8N1'); undefined when the engine cannot say. */
  frame?: string;
}

/** Pins a UART controller is routed to right now, when the engine knows it. */
export interface UartRouting {
  tx?: number;
  rx?: number;
}

/**
 * The engine's side of one UART controller. Like the SPI and I2C ports:
 * created ONCE per board by the engine adapter and kept across every rebuild
 * of the SoC. A byte the guest transmits reaches the fabric through the TX
 * handler exactly once; a byte the fabric hands receive() lands in the
 * guest's RX (its FIFO, its data register, its ring buffer) exactly once.
 */
export interface UartControllerPort {
  readonly bus: 'uart';
  /** The SoC's index for this controller (matches the pin function table). */
  readonly unit: number;
  /** Datasheet name, for diagnostics ('USART0', 'UART1', 'PL011'). */
  readonly name: string;
  /**
   * True when the guest runs outside this tab (a QEMU worker). Bytes still
   * flow both ways through this port, later than the guest clocked them; the
   * bus map a worker is sent names the controller each endpoint sits on so a
   * chip the worker hosts is answered there.
   */
  readonly remote?: boolean;
  /**
   * The fabric installs the TX handler here. The adapter calls it once per
   * byte the controller shifts out, synchronously with the guest, and never
   * for a byte it did not transmit (its own RX injections included).
   */
  setTxHandler(handler: ((byte: number) => void) | null): void;
  /** A byte arriving at the controller's RX. */
  receive(byte: number): void;
  config(): UartConfig;
  /** Live routing, or 'static' when the pins are fixed by the board table. */
  routing(): UartRouting | 'static';
  /** Routing changed (the sketch moved the pins): the fabric recomputes. */
  setRoutingChangeHandler?(handler: (() => void) | null): void;
}

/**
 * The guest's clock, for the lines the fabric has to time itself: a UART on
 * plain GPIOs (SoftwareSerial, a bit-banged TX). Everything is in cycles of
 * clockHz(), the same base the line contract (simulation/line) already uses,
 * so an engine's LineHostPort serves as the first three members.
 *
 * It is the GUEST's time, never the browser's: an emulated board runs slower
 * than real time under load, and a bit time measured on the wall clock is
 * garbage to a sketch that samples on millis() (memory: parts run on the
 * guest clock, not the wall clock).
 */
export interface GuestClock {
  /**
   * Guest cycles now. When a pin callback runs, this is the cycle the edge
   * happened at: the decoder timestamps every edge with it.
   */
  now(): number;
  /** Cycles per second of the guest's configured clock. */
  clockHz(): number;
  /**
   * Put a level on a board pin, as an input to the MCU, at a guest instant.
   * Edges must be applied in order, at their cycle, and the engine's idle
   * skip must not jump over one (the same rule the line models rely on).
   */
  scheduleEdge(pin: number, level: boolean, atCycle: number): void;
  /**
   * Run `cb` when the guest reaches `atCycle`; returns a cancel. A decoder
   * needs it because a byte whose last bits are ones ends with no edge at
   * all: the only way to know the frame is over is the clock reaching its
   * stop bit, and waiting for the next start bit instead would hold the last
   * byte of every message until the next message.
   */
  at(atCycle: number, cb: () => void): () => void;
}

// ── Engine binding ──────────────────────────────────────────────────────────

/** The minimal pin surface the fabric needs from a board. */
export interface BoardPins {
  onPinChange(pin: number, cb: (pin: number, level: boolean) => void): () => void;
  /** Last level the MCU (or a part) put on the pin, undefined if never set. */
  peekPinState(pin: number): boolean | undefined;
  /**
   * What the guest is doing to the pad (driving low/high, or released with a
   * pull), for engines that report it; undefined when never reported. The
   * level channel alone misses a pin driven low by its direction register
   * only (pinMode(OUTPUT) with the latch already 0), which on a chip select
   * means "selected".
   */
  peekPad?(pin: number): { drive: 'low' | 'high' | 'z'; pull: 0 | 1 | 2 } | undefined;
  onPadChange?(pin: number, cb: () => void): () => void;
  /** Drive a pin as an INPUT to the MCU (a device answering on MISO/SDA/RX). */
  driveInput?(pin: number, level: boolean): void;
  /**
   * The board's PinManager as a board-pin net sees it (customChips/busNets),
   * for a bus that is a line with drivers and pull resistors on it rather
   * than a stream of bytes: the software I2C bus puts its members' pull-ups
   * and the target's open-drain low there, so a line the master releases with
   * pinMode(INPUT) reads HIGH in the guest. Absent on a test double; the bus
   * then drives the input directly, as before.
   */
  pinHost?: BoardPinHost;
}

/** Everything an engine adapter hands the fabric for one board. */
export interface EngineBinding {
  pins: BoardPins;
  spi: SpiControllerPort[];
  /**
   * Every I2C controller of the SoC. Optional only while the engines move
   * over (F5): an engine that leaves it out has no hardware I2C on the fabric,
   * and its I2C pins are served by the software decoder alone.
   */
  i2c?: I2cControllerPort[];
  /**
   * Every UART controller of the SoC. Optional only while the engines move
   * over (F6): an engine that leaves it out has no hardware UART on the
   * fabric, and its UART pins are served by the software decoder alone.
   */
  uart?: UartControllerPort[];
  /**
   * The guest's clock and edge scheduler, for the software UART. An engine
   * that leaves it out cannot host one: an endpoint on plain GPIOs of that
   * board is reported (`uart-no-clock`) instead of silently hearing nothing.
   */
  clock?: GuestClock;
  /** MCU reset notifications (Stop/Run, reset, reload). */
  setResetHandler?(handler: (() => void) | null): void;
}

/** Implemented by any simulator that exposes its buses to the fabric. */
export interface BusCapableSimulator {
  getBusBinding(): EngineBinding | null;
}

export function isBusCapable(sim: unknown): sim is BusCapableSimulator {
  return (
    typeof sim === 'object' &&
    sim !== null &&
    typeof (sim as { getBusBinding?: unknown }).getBusBinding === 'function'
  );
}

// ── Diagnostics ─────────────────────────────────────────────────────────────

export type BusDiagnosticCode =
  | 'spi-contention'
  | 'spi-multiple-selected'
  | 'spi-cs-floating'
  | 'spi-wiring'
  | 'spi-mode'
  | 'spi-bit-order'
  | 'spi-no-controller'
  | 'spi-cross-board'
  | 'i2c-address-conflict'
  | 'i2c-wiring'
  | 'i2c-target-asleep'
  | 'i2c-target-unmodelled'
  | 'uart-baud-mismatch'
  | 'uart-tx-contention'
  | 'uart-wiring'
  | 'uart-no-clock'
  | 'uart-no-baud'
  | 'bus-remote-responder-missing';

export interface BusDiagnostic {
  code: BusDiagnosticCode;
  bus: BusKind;
  boardId: string | null;
  /** Devices involved, by owner. */
  owners: string[];
  message: string;
}

/** A registration handle: dispose() takes the device off its bus, by identity. */
export interface BusHandle {
  dispose(): void;
  /**
   * The device's live inputs (`remoteAttrs()`) may have changed. On a board
   * whose master runs outside the tab the new values go to the host that runs
   * the device's portable model; anywhere else, and when nothing changed since
   * the last send, this does nothing. Cheap enough to call on every pointer
   * move and every circuit solve.
   */
  attrsChanged(): void;
}
