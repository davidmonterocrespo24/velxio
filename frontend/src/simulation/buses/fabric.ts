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
 */

import { controllerOf } from './pinFunctions';
import { SoftSpiDecoder } from './softSpi';
import { SpiBus, type DiagnosticSink } from './spiBus';
import type { BoardPins, EngineBinding, SpiControllerPort, SpiRouting } from './types';

interface PortSlot {
  port: SpiControllerPort;
  bus: SpiBus | null;
  sck?: number;
  mosi?: number;
  miso?: number;
  cs: Array<number | undefined>;
}

const firstPin = (v: number | number[] | undefined): number | undefined =>
  Array.isArray(v) ? v[0] : v;

export class BoardBusFabric {
  readonly spiBuses = new Map<number, SpiBus>();
  private readonly decoders = new Map<number, SoftSpiDecoder>();
  private slots: PortSlot[] = [];
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
    this.binding?.setResetHandler?.(null);
    this.slots = [];
    for (const d of this.decoders.values()) d.dispose();
    this.decoders.clear();
    this.hwLevel.clear();
    for (const bus of this.spiBuses.values()) bus.controller = null;
  }

  dispose(): void {
    this.releaseBinding();
    this.binding = null;
    this.spiBuses.clear();
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
      bus.controller = { name: port.name, config: () => port.config() };
      this.checkWiring(slot, bus);
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
    for (const cb of this.resetListeners) cb();
  }
}
