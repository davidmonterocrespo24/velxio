/**
 * BoardBusFabric: the buses of ONE board (DESIGN section 2).
 *
 * It lives as long as the board is on the canvas, not as long as an engine
 * instance lives. An engine adapter binds its controller ports here; when the
 * engine rebuilds the SoC the adapter keeps the same ports, and when the store
 * swaps the whole simulator object the registry binds the new one. Devices
 * never notice either.
 *
 * Buses are keyed by the SCK net they sit on (a board pin). Each controller
 * port feeds the bus its SCK is routed to right now; the software decoder
 * feeds the same bus from pin edges. A controller routed to a pin no device
 * listens on clocks into the idle line, as a real one would.
 *
 * I2C is the same shape keyed by the SDA net: a controller feeds the bus its
 * SDA is routed to, and a software decoder watches the bus's SDA and SCL. Wire
 * and Wire1 are two buses exactly when their pins are two nets.
 */

import { I2cBus } from './i2cBus';
import { controllerOf } from './pinFunctions';
import { SoftI2cDecoder } from './softI2c';
import { SoftSpiDecoder } from './softSpi';
import { SpiBus, type DiagnosticSink } from './spiBus';
import type {
  BoardPins,
  EngineBinding,
  I2cControllerPort,
  I2cRouting,
  SpiControllerPort,
  SpiRouting,
} from './types';

interface PortSlot {
  port: SpiControllerPort;
  bus: SpiBus | null;
  sck?: number;
  mosi?: number;
  miso?: number;
  cs: Array<number | undefined>;
}

interface I2cSlot {
  port: I2cControllerPort;
  bus: I2cBus | null;
  sda?: number;
  scl?: number;
}

const firstPin = (v: number | number[] | undefined): number | undefined =>
  Array.isArray(v) ? v[0] : v;

export class BoardBusFabric {
  readonly spiBuses = new Map<number, SpiBus>();
  private readonly decoders = new Map<number, SoftSpiDecoder>();
  private slots: PortSlot[] = [];
  readonly i2cBuses = new Map<number, I2cBus>();
  private readonly i2cDecoders = new Map<number, SoftI2cDecoder>();
  private i2cSlots: I2cSlot[] = [];
  private binding: EngineBinding | null = null;
  /** Pin level forced by a controller's hardware chip select (true = high). */
  private readonly hwLevel = new Map<number, boolean>();
  private readonly hwWatchers = new Map<number, Set<() => void>>();
  private readonly resetListeners = new Set<() => void>();
  private readonly bindListeners = new Set<() => void>();

  readonly boardId: string;
  private readonly kind: () => string | undefined;
  private readonly report: DiagnosticSink;

  constructor(boardId: string, kind: () => string | undefined, report: DiagnosticSink) {
    this.boardId = boardId;
    this.kind = kind;
    this.report = report;
  }

  get pins(): BoardPins | null {
    return this.binding?.pins ?? null;
  }

  get bound(): boolean {
    return this.binding !== null;
  }

  // ── Engine binding ────────────────────────────────────────────────────────

  bind(binding: EngineBinding | null): void {
    this.releaseBinding();
    this.binding = binding;
    if (binding) {
      binding.setResetHandler?.(() => this.onMcuReset());
      this.slots = binding.spi.map((port) => ({ port, bus: null, cs: [] }));
      for (const slot of this.slots) {
        const { port } = slot;
        port.setFrameHandler((mosi, bits) => (slot.bus ? slot.bus.frame(mosi, bits) : 0xff));
        port.setBlockHandler?.((mosi, miso) => {
          if (slot.bus) slot.bus.block(mosi, miso);
          else if (miso) miso.fill(0xff);
        });
        port.setHardwareCsHandler?.((index, active) => this.onHardwareCs(slot, index, active));
        port.setRoutingChangeHandler?.(() => this.route());
      }
      for (const bus of this.spiBuses.values()) this.ensureDecoder(bus);
      this.i2cSlots = (binding.i2c ?? []).map((port) => ({ port, bus: null }));
      for (const slot of this.i2cSlots) {
        // The slot's bus is looked up per event, so a controller the sketch
        // moves to other pins (or a bus that appears later) is followed
        // without re-installing anything. No bus = nothing on those pins:
        // every address NACKs and a read sees the pull-up.
        slot.port.setTransactionHandler({
          start: (address, read) => (slot.bus ? slot.bus.start(address, read) : false),
          write: (byte) => (slot.bus ? slot.bus.write(byte) : false),
          read: () => (slot.bus ? slot.bus.read() : 0xff),
          stop: () => slot.bus?.stop(),
        });
        slot.port.setRoutingChangeHandler?.(() => this.route());
      }
    }
    this.route();
    // Chip-select watches live on the board's pins, which just changed.
    for (const cb of this.bindListeners) cb();
  }

  /** Called after every bind (the registry re-watches chip selects). */
  onBind(cb: () => void): () => void {
    this.bindListeners.add(cb);
    return () => this.bindListeners.delete(cb);
  }

  private releaseBinding(): void {
    for (const slot of this.slots) {
      slot.port.setFrameHandler(null);
      slot.port.setBlockHandler?.(null);
      slot.port.setHardwareCsHandler?.(null);
      slot.port.setRoutingChangeHandler?.(null);
    }
    for (const slot of this.i2cSlots) {
      slot.port.setTransactionHandler(null);
      slot.port.setRoutingChangeHandler?.(null);
    }
    this.binding?.setResetHandler?.(null);
    this.slots = [];
    this.i2cSlots = [];
    for (const d of this.decoders.values()) d.dispose();
    this.decoders.clear();
    for (const d of this.i2cDecoders.values()) d.dispose();
    this.i2cDecoders.clear();
    this.hwLevel.clear();
    for (const bus of this.spiBuses.values()) bus.controller = null;
    for (const bus of this.i2cBuses.values()) bus.controllerName = null;
  }

  dispose(): void {
    this.releaseBinding();
    this.binding = null;
    this.spiBuses.clear();
    this.i2cBuses.clear();
    this.hwWatchers.clear();
    this.resetListeners.clear();
    this.bindListeners.clear();
  }

  // ── Buses ─────────────────────────────────────────────────────────────────

  /** The bus on this SCK net, created on first use. */
  busFor(sckPin: number): SpiBus {
    let bus = this.spiBuses.get(sckPin);
    if (!bus) {
      bus = new SpiBus(this.boardId, sckPin, this.report);
      const b = bus;
      bus.onSelectionChange = () => this.decoders.get(b.sckPin)?.restart();
      this.spiBuses.set(sckPin, bus);
      this.ensureDecoder(bus);
      this.route();
    }
    return bus;
  }

  /** Drop a bus nobody sits on any more. */
  releaseIfEmpty(bus: SpiBus): void {
    if (bus.size > 0 || this.spiBuses.get(bus.sckPin) !== bus) return;
    this.spiBuses.delete(bus.sckPin);
    this.decoders.get(bus.sckPin)?.dispose();
    this.decoders.delete(bus.sckPin);
    this.route();
  }

  private ensureDecoder(bus: SpiBus): void {
    const pins = this.pins;
    if (!pins || this.decoders.has(bus.sckPin)) return;
    this.decoders.set(bus.sckPin, new SoftSpiDecoder(pins, bus));
  }

  /** The I2C bus on this SDA net, created on first use. */
  i2cBusFor(sdaPin: number): I2cBus {
    let bus = this.i2cBuses.get(sdaPin);
    if (!bus) {
      bus = new I2cBus(this.boardId, sdaPin, this.report);
      this.i2cBuses.set(sdaPin, bus);
      this.route();
    }
    return bus;
  }

  /**
   * The registry added or removed a target on `bus`: the clock line may have
   * changed (a bus with no controller is clocked where its targets' SCL is),
   * and an empty bus goes away.
   */
  i2cMembershipChanged(bus: I2cBus): void {
    if (this.i2cBuses.get(bus.sdaPin) !== bus) return;
    if (bus.size === 0) {
      this.i2cBuses.delete(bus.sdaPin);
      this.i2cDecoders.get(bus.sdaPin)?.dispose();
      this.i2cDecoders.delete(bus.sdaPin);
      this.route();
      return;
    }
    this.clockI2c(bus);
    this.checkI2cWiring(bus);
  }

  /**
   * Decide the bus's clock line and keep its software decoder on it. A
   * routed controller defines it; otherwise the SCL most of its targets share
   * (lowest pin on a tie), so the answer never depends on attach order.
   */
  private clockI2c(bus: I2cBus): void {
    let scl: number | undefined;
    for (const slot of this.i2cSlots) {
      if (slot.bus === bus && slot.scl !== undefined) {
        scl = slot.scl;
        break;
      }
    }
    if (scl === undefined) {
      const votes = new Map<number, number>();
      for (const m of bus.members.values()) votes.set(m.sclPin, (votes.get(m.sclPin) ?? 0) + 1);
      let best = -1;
      for (const [pin, n] of votes) {
        if (scl === undefined || n > best || (n === best && pin < scl)) {
          scl = pin;
          best = n;
        }
      }
    }
    if (bus.sclPin !== scl) bus.setClock(scl);
    else bus.reindex();
    const pins = this.pins;
    const dec = this.i2cDecoders.get(bus.sdaPin);
    if (dec && (dec.sclPin !== scl || !pins)) {
      dec.dispose();
      this.i2cDecoders.delete(bus.sdaPin);
    }
    if (pins && scl !== undefined && !this.i2cDecoders.has(bus.sdaPin)) {
      this.i2cDecoders.set(bus.sdaPin, new SoftI2cDecoder(pins, bus, scl));
    }
  }

  /** SDA and SCL swapped against a controller is the classic I2C wiring mistake. */
  private checkI2cWiring(bus: I2cBus): void {
    for (const m of bus.members.values()) {
      for (const slot of this.i2cSlots) {
        if (slot.sda === m.sclPin && slot.scl === bus.sdaPin) {
          this.report({
            code: 'i2c-wiring',
            bus: 'i2c',
            boardId: this.boardId,
            owners: [m.owner],
            message:
              `${m.owner}: SDA and SCL are crossed (its SDA is on pin ${bus.sdaPin}, which ` +
              `${slot.port.name} uses as SCL). Swap the two wires.`,
          });
        }
      }
    }
  }

  // ── Controller routing ────────────────────────────────────────────────────

  private routingOf(slot: PortSlot): void {
    const r: SpiRouting | 'static' = slot.port.routing();
    if (r === 'static') {
      const kind = this.kind();
      const def = kind ? controllerOf(kind, 'spi', slot.port.unit) : undefined;
      slot.sck = firstPin(def?.defaultPins.sck);
      slot.mosi = firstPin(def?.defaultPins.mosi);
      slot.miso = firstPin(def?.defaultPins.miso);
      const cs = def?.defaultPins.cs;
      slot.cs = Array.isArray(cs) ? cs : cs === undefined ? [] : [cs];
    } else {
      slot.sck = r.sck;
      slot.mosi = r.mosi;
      slot.miso = r.miso;
      slot.cs = r.cs ?? [];
    }
  }

  /** Point every controller at the bus on the SCK net it is routed to. */
  route(): void {
    for (const bus of this.spiBuses.values()) bus.controller = null;
    for (const slot of this.slots) this.routingOf(slot);
    // A pin that no controller routes a chip select to any more is a plain
    // GPIO again: drop the level the hardware CS was forcing on it.
    const csPins = new Set<number>();
    for (const slot of this.slots) for (const p of slot.cs) if (p !== undefined) csPins.add(p);
    for (const pin of Array.from(this.hwLevel.keys())) {
      if (csPins.has(pin)) continue;
      this.hwLevel.delete(pin);
      for (const cb of this.hwWatchers.get(pin) ?? []) cb();
    }
    for (const slot of this.slots) {
      const bus = slot.sck !== undefined ? (this.spiBuses.get(slot.sck) ?? null) : null;
      slot.bus = bus;
      if (!bus) continue;
      if (bus.controller) {
        this.report({
          code: 'spi-wiring',
          bus: 'spi',
          boardId: this.boardId,
          owners: [],
          message: `${bus.controller.name} and ${slot.port.name} are both routed to SCK pin ${bus.sckPin}.`,
        });
      }
      const port = slot.port;
      bus.controller = { name: port.name, config: () => port.config(), remote: port.remote };
      this.checkWiring(slot, bus);
      // The controller is only known now, and whether it is remote decides
      // whether a selected responder here is a problem worth naming.
      bus.reportRemoteGaps();
    }
    this.routeI2c();
  }

  private i2cRoutingOf(slot: I2cSlot): void {
    const r: I2cRouting | 'static' = slot.port.routing();
    if (r === 'static') {
      const kind = this.kind();
      const def = kind ? controllerOf(kind, 'i2c', slot.port.unit) : undefined;
      slot.sda = firstPin(def?.defaultPins.sda);
      slot.scl = firstPin(def?.defaultPins.scl);
    } else {
      slot.sda = r.sda;
      slot.scl = r.scl;
    }
  }

  /** Point every I2C controller at the bus on the SDA net it is routed to. */
  private routeI2c(): void {
    for (const bus of this.i2cBuses.values()) bus.controllerName = null;
    for (const slot of this.i2cSlots) {
      this.i2cRoutingOf(slot);
      const bus = slot.sda !== undefined ? (this.i2cBuses.get(slot.sda) ?? null) : null;
      slot.bus = bus;
      if (!bus) continue;
      if (bus.controllerName) {
        this.report({
          code: 'i2c-wiring',
          bus: 'i2c',
          boardId: this.boardId,
          owners: [],
          message: `${bus.controllerName} and ${slot.port.name} are both routed to SDA pin ${bus.sdaPin}.`,
        });
      }
      bus.controllerName = slot.port.name;
    }
    for (const bus of this.i2cBuses.values()) {
      this.clockI2c(bus);
      this.checkI2cWiring(bus);
    }
  }

  /** Compare where each device's data lines land with where the controller drives them. */
  checkWiring(slot: PortSlot | null, bus: SpiBus): void {
    const s = slot ?? this.slots.find((x) => x.bus === bus);
    if (!s) return;
    for (const m of bus.members.values()) {
      const crossed =
        m.mosiPin !== undefined &&
        m.misoPin !== undefined &&
        m.mosiPin === s.miso &&
        m.misoPin === s.mosi;
      if (crossed) {
        this.report({
          code: 'spi-wiring',
          bus: 'spi',
          boardId: this.boardId,
          owners: [m.owner],
          message:
            `${m.owner}: MOSI and MISO are crossed (its MOSI is on pin ${m.mosiPin}, which ` +
            `${s.port.name} uses as MISO). Swap the two wires.`,
        });
        continue;
      }
      if (m.mosiPin !== undefined && s.mosi !== undefined && m.mosiPin !== s.mosi) {
        this.report({
          code: 'spi-wiring',
          bus: 'spi',
          boardId: this.boardId,
          owners: [m.owner],
          message:
            `${m.owner}: its MOSI is on pin ${m.mosiPin} but ${s.port.name} drives MOSI on pin ` +
            `${s.mosi}; the chip will not receive the controller's data.`,
        });
      }
      if (m.misoPin !== undefined && s.miso !== undefined && m.misoPin !== s.miso) {
        this.report({
          code: 'spi-wiring',
          bus: 'spi',
          boardId: this.boardId,
          owners: [m.owner],
          message:
            `${m.owner}: its MISO is on pin ${m.misoPin} but ${s.port.name} reads MISO on pin ` +
            `${s.miso}; the controller will not see the chip's answers.`,
        });
      }
    }
  }

  /** Called by the registry after it adds a member, so wiring is checked now. */
  memberAdded(bus: SpiBus): void {
    this.checkWiring(null, bus);
  }

  /**
   * Which controller serves the bus on `sckPin`, and whether it is remote.
   * The bus map the tab sends a worker names the controller per responder, so
   * a device on the second SPI peripheral is not answered by the first.
   */
  controllerOfBus(sckPin: number): { unit: number; remote: boolean } | null {
    for (const slot of this.slots) {
      if (slot.sck !== sckPin) continue;
      return { unit: slot.port.unit, remote: slot.port.remote === true };
    }
    return null;
  }

  /**
   * The index of the hardware chip select routed to `pin`, if a controller
   * drives that pad itself.
   *
   * It matters for the bus map: QEMU never moves a GPIO for a pad the SPI
   * peripheral owns, so a worker that looked the level up in its pin table
   * would find the chip permanently deselected. The worker takes the level
   * from its own CS events instead, and this is how it learns which device
   * those events belong to.
   */
  hardwareCsIndex(pin: number): number | null {
    for (const slot of this.slots) {
      const idx = slot.cs.indexOf(pin);
      if (idx >= 0) return idx;
    }
    return null;
  }

  // ── Levels (chip select) ──────────────────────────────────────────────────

  /**
   * Level of a board pin, as a chip select sees it:
   *  1. a controller's hardware chip select, when it drives the pad;
   *  2. the guest's pad drive state (driving low or high), when the engine
   *     reports it: a pin driven by its direction register alone never moves
   *     the level channel;
   *  3. the last level on the wire (the MCU latch or a part driving it);
   *  4. a released pad's pull; otherwise undefined (floating).
   */
  level(pin: number): boolean | undefined {
    if (this.hwLevel.has(pin)) return this.hwLevel.get(pin);
    const pins = this.pins;
    if (!pins) return undefined;
    const pad = pins.peekPad?.(pin);
    if (pad && pad.drive !== 'z') return pad.drive === 'high';
    const lvl = pins.peekPinState(pin);
    if (lvl !== undefined) return lvl;
    if (pad?.pull === 1) return true;
    if (pad?.pull === 2) return false;
    return undefined;
  }

  /** Watch a pin's level; the callback reads level() itself. */
  watchLevel(pin: number, cb: () => void): () => void {
    const pins = this.pins;
    const offLevel = pins ? pins.onPinChange(pin, () => cb()) : () => {};
    const offPad = pins?.onPadChange ? pins.onPadChange(pin, cb) : () => {};
    const off = () => {
      offLevel();
      offPad();
    };
    let set = this.hwWatchers.get(pin);
    if (!set) {
      set = new Set();
      this.hwWatchers.set(pin, set);
    }
    set.add(cb);
    return () => {
      off();
      this.hwWatchers.get(pin)?.delete(cb);
    };
  }

  private onHardwareCs(slot: PortSlot, index: number, active: boolean): void {
    this.routingOf(slot);
    const pin = slot.cs[index];
    if (pin === undefined) return;
    // Hardware chip selects are active low on every controller we model.
    this.hwLevel.set(pin, !active);
    for (const cb of this.hwWatchers.get(pin) ?? []) cb();
  }

  onReset(cb: () => void): () => void {
    this.resetListeners.add(cb);
    return () => this.resetListeners.delete(cb);
  }

  private onMcuReset(): void {
    this.hwLevel.clear();
    for (const bus of this.spiBuses.values()) bus.boardReset();
    for (const d of this.i2cDecoders.values()) d.restart();
    for (const bus of this.i2cBuses.values()) bus.boardReset();
    for (const cb of this.resetListeners) cb();
  }
}
