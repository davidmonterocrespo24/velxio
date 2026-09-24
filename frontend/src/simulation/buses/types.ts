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
  /** vx_attr values, by name. */
  attrs?: Record<string, number>;
  /** Named byte storage (the SD card image), base64 per name. */
  blobs?: Record<string, string>;
}

export interface SpiDevice {
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
}

/** Everything an engine adapter hands the fabric for one board. */
export interface EngineBinding {
  pins: BoardPins;
  spi: SpiControllerPort[];
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
  | 'uart-baud-mismatch'
  | 'uart-tx-contention'
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
}
