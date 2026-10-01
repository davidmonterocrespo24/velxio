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
 *
 * UART has no bus, only wires: one net per board pin, with whoever transmits
 * onto it and whoever listens. A controller's TX feeds the net its TX pin is
 * routed to and its RX takes bytes from the net its RX pin is on; an endpoint
 * leg lands on the net of its own pin. A net with listeners and no controller
 * TX is a wire the MCU bit-bangs, decoded on the guest's clock; a net with
 * drivers and no controller RX is a wire the MCU reads as a GPIO, and bytes go
 * out on it as timed edges.
 */

import { I2cBus } from './i2cBus';
import { controllerOf } from './pinFunctions';
import { SoftI2cDecoder } from './softI2c';
import { SoftSpiDecoder } from './softSpi';
import { SoftUartDecoder, SoftUartEmitter } from './softUart';
import { SpiBus, type DiagnosticSink } from './spiBus';
import type {
  BoardPins,
  EngineBinding,
  GuestClock,
  I2cControllerPort,
  I2cRouting,
  SpiControllerPort,
  SpiRouting,
  UartControllerPort,
  UartEndpoint,
  UartRouting,
} from './types';
import { listenerKey, UartNet, type UartControllerRef, type UartMember } from './uartBus';

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

interface UartSlot {
  port: UartControllerPort;
  ref: UartControllerRef;
  tx?: number;
  rx?: number;
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
  readonly uartNets = new Map<number, UartNet>();
  /** Software decoders per pin, one per (baud, frame) its listeners use. */
  private readonly uartDecoders = new Map<number, Map<string, SoftUartDecoder>>();
  private readonly uartEmitters = new Map<number, SoftUartEmitter>();
  private uartSlots: UartSlot[] = [];
  private binding: EngineBinding | null = null;
  /** Pin level forced by a controller's hardware chip select (true = high). */
  private readonly hwLevel = new Map<number, boolean>();
  private readonly hwWatchers = new Map<number, Set<() => void>>();
  private readonly resetListeners = new Set<() => void>();
  private readonly bindListeners = new Set<() => void>();

  readonly boardId: string;
  private readonly kind: () => string | undefined;
  private readonly report: DiagnosticSink;
  private readonly i2cChanged: () => void;
  private readonly uartChanged: () => void;

  /**
   * `onI2cChange` hears every change that can move what a remote worker must
   * be told about this board's I2C: a target on or off a bus, a clock line
   * decided again, a controller bound or rerouted. It may fire more often than
   * the published map really changes; the listener compares. `onUartChange`
   * is the same for the UART map (an endpoint on or off a net, a controller
   * bound or rerouted).
   */
  constructor(
    boardId: string,
    kind: () => string | undefined,
    report: DiagnosticSink,
    onI2cChange?: () => void,
    onUartChange?: () => void,
  ) {
    this.boardId = boardId;
    this.kind = kind;
    this.report = report;
    this.i2cChanged = onI2cChange ?? (() => {});
    this.uartChanged = onUartChange ?? (() => {});
  }

  get pins(): BoardPins | null {
    return this.binding?.pins ?? null;
  }

  get bound(): boolean {
    return this.binding !== null;
  }

  /** The guest's clock, when the engine offers one (the software UART needs it). */
  get clock(): GuestClock | null {
    return this.binding?.clock ?? null;
  }

  /**
   * The guest's clock as a chip on one of this board's buses is handed it
   * (I2cTarget.setClock): one object for the life of the fabric, which reads
   * the engine bound at the moment of each call. A part is placed when the
   * circuit says so, which is often before the engine binds, and an engine
   * binds again on every Run; a chip that kept the binding's own clock would
   * keep the one of a run that is over. With no engine, or one that offers
   * no clock, there is no time: now() stands at 0 and clockHz() is 0, the
   * way the chip runtime and the ESP32 ports already say it.
   */
  readonly targetClock: GuestClock = {
    now: () => this.clock?.now() ?? 0,
    clockHz: () => this.clock?.clockHz() ?? 0,
    scheduleEdge: (pin, level, atCycle) => this.clock?.scheduleEdge(pin, level, atCycle),
    at: (atCycle, cb) => this.clock?.at(atCycle, cb) ?? (() => {}),
  };

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
        port.setIdleMisoQuery?.(() => (slot.bus ? slot.bus.idleMisoIfUndriven() : 0xff));
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
      this.uartSlots = (binding.uart ?? []).map((port) => {
        const slot: UartSlot = {
          port,
          ref: {
            unit: port.unit,
            name: port.name,
            remote: port.remote === true,
            config: () => port.config(),
            receive: (byte) => port.receive(byte),
          },
        };
        // Looked up per byte, like the I2C slot's bus: a controller the
        // sketch moves to other pins is followed without re-installing.
        port.setTxHandler((byte) => {
          const net = slot.tx !== undefined ? this.uartNets.get(slot.tx) : undefined;
          net?.fromController(slot.ref, byte);
        });
        port.setRoutingChangeHandler?.(() => this.route());
        return slot;
      });
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
      slot.port.setIdleMisoQuery?.(null);
    }
    for (const slot of this.i2cSlots) {
      slot.port.setTransactionHandler(null);
      slot.port.setRoutingChangeHandler?.(null);
    }
    for (const slot of this.uartSlots) {
      slot.port.setTxHandler(null);
      slot.port.setRoutingChangeHandler?.(null);
    }
    this.binding?.setResetHandler?.(null);
    this.slots = [];
    this.i2cSlots = [];
    this.uartSlots = [];
    for (const d of this.decoders.values()) d.dispose();
    this.decoders.clear();
    for (const d of this.i2cDecoders.values()) d.dispose();
    this.i2cDecoders.clear();
    for (const pin of Array.from(this.uartDecoders.keys())) this.dropUartDecoders(pin);
    for (const pin of Array.from(this.uartEmitters.keys())) this.dropUartEmitter(pin);
    this.hwLevel.clear();
    for (const bus of this.spiBuses.values()) bus.controller = null;
    for (const bus of this.i2cBuses.values()) {
      bus.controllerName = null;
      bus.controllerRemote = false;
    }
    for (const net of this.uartNets.values()) {
      net.controllerTx = null;
      net.controllerRx = null;
      net.emit = null;
    }
  }

  dispose(): void {
    this.releaseBinding();
    this.binding = null;
    this.spiBuses.clear();
    this.i2cBuses.clear();
    this.uartNets.clear();
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
    this.i2cChanged();
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
    // Who is clocked is decided just now, and a target the worker cannot
    // host only matters once it is.
    bus.reportRemoteGaps();
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

  // ── UART nets ─────────────────────────────────────────────────────────────

  /** The UART net on this board pin, created on first use. */
  uartNetFor(pin: number): UartNet {
    let net = this.uartNets.get(pin);
    if (!net) {
      net = new UartNet(this.boardId, pin, this.report);
      this.uartNets.set(pin, net);
      // The controllers routed to this pin take the new net; the other nets
      // are untouched by its birth, so nothing else is re-routed.
      this.pointControllersAt(net);
    }
    return net;
  }

  /**
   * Where every UART controller is routed, read again now. A port with
   * static routing takes its pins from the board's table, and the board's
   * kind is not always known when the engine binds (the store binds the
   * simulator before it adds the board), so the pins are re-derived every
   * time a net is created, a leg lands or the links are recomputed, which is
   * when they are needed.
   */
  private refreshUartSlots(): void {
    for (const slot of this.uartSlots) this.uartRoutingOf(slot);
  }

  /**
   * The registry put a leg on `net` or took one off, or linked it to (or
   * cut it from) a peer board's net: the wire may now need a decoder or an
   * emitter, or neither, and a net with nothing of this board's and no peer
   * goes away.
   */
  uartMembershipChanged(net: UartNet): void {
    if (this.uartNets.get(net.pin) !== net) return;
    if (net.idle) {
      this.uartNets.delete(net.pin);
      this.dropUartDecoders(net.pin);
      this.dropUartEmitter(net.pin);
      this.uartChanged();
      return;
    }
    // A controller whose pins were unknown when the net was born (see
    // refreshUartSlots) is pointed at it now.
    net.controllerTx = null;
    net.controllerRx = null;
    this.pointControllersAt(net);
    // The registry hears first: a leg that just landed may be on a wire
    // another board's controller drives, and the wiring checks in refreshUart
    // must see that peer, or a module on a peer-driven wire would be reported
    // as hearing nothing.
    this.uartChanged();
    this.refreshUart(net);
  }

  /**
   * Every board pin a UART controller is routed to right now (TX and RX),
   * for the registry's board-to-board links. Empty while no engine is bound.
   */
  uartControllerPins(): number[] {
    this.refreshUartSlots();
    const pins: number[] = [];
    for (const slot of this.uartSlots) {
      if (slot.tx !== undefined) pins.push(slot.tx);
      if (slot.rx !== undefined) pins.push(slot.rx);
    }
    return pins;
  }

  /**
   * Give the net what its members need from the board itself. A wire with
   * listeners and no controller transmitting on it is one the MCU bit-bangs:
   * a decoder per rate its listeners use. A wire with drivers and no
   * controller listening is one the MCU reads as a GPIO: an emitter. Both
   * need the guest's clock; a board without one says so per endpoint rather
   * than staying silent.
   */
  private refreshUart(net: UartNet): void {
    const pins = this.pins;
    const clock = this.clock;
    const pin = net.pin;
    const soft = (m: UartMember): boolean => {
      // No engine bound (the board is between simulators): nothing can serve
      // the wire and there is nothing to say, as for SPI and I2C; the next
      // bind decides. The diagnostic below is for an engine that IS here and
      // cannot time its pads.
      if (!pins) return false;
      if (!clock) {
        this.report({
          code: 'uart-no-clock',
          bus: 'uart',
          boardId: this.boardId,
          owners: [m.owner],
          message:
            `${m.owner} is on pin ${pin}, a plain GPIO of this board, and this board's emulator ` +
            `does not time edges on its pads, so a UART on plain GPIOs (SoftwareSerial) cannot ` +
            `be followed here. Wire the module to a hardware UART pin.`,
        });
        return false;
      }
      if (m.baud === undefined) {
        this.report({
          code: 'uart-no-baud',
          bus: 'uart',
          boardId: this.boardId,
          owners: [m.owner],
          message:
            `${m.owner} is on pin ${pin}, a plain GPIO, but declares no baud rate, and a bit time ` +
            `needs one; on a plain GPIO it neither hears nor is heard. Wire it to a hardware UART ` +
            `pin, or give the part a rate.`,
        });
        return false;
      }
      return true;
    };
    // Decoders: the MCU may bit-bang this wire only if no controller drives
    // it, this board's or a peer board's: a wire another board transmits on
    // is an input to this one, not a pin it wiggles.
    let peerDrives = false;
    for (const p of net.peers) if (p.controllerTx || p.drivers.size > 0) peerDrives = true;
    const wanted = new Map<string, UartMember>();
    if (net.controllerTx === null && !peerDrives) {
      for (const m of net.listeners.values()) if (soft(m)) wanted.set(listenerKey(m), m);
    }
    let decoders = this.uartDecoders.get(pin);
    if (decoders) {
      for (const [key, d] of Array.from(decoders)) {
        if (wanted.has(key)) continue;
        d.dispose();
        decoders.delete(key);
      }
    }
    if (wanted.size > 0 && pins && clock) {
      if (!decoders) this.uartDecoders.set(pin, (decoders = new Map()));
      for (const [key, m] of wanted) {
        if (decoders.has(key)) continue;
        decoders.set(
          key,
          new SoftUartDecoder(pins, clock, pin, m.baud!, m.spec, (byte, errors) =>
            net.fromWire(key, byte, errors),
          ),
        );
      }
    }
    if (decoders && decoders.size === 0) this.uartDecoders.delete(pin);
    // Emitter: an endpoint's bytes go out as edges only if no controller reads them.
    let peerListens = false;
    for (const p of net.peers) if (p.controllerRx) peerListens = true;
    let wantEmitter = false;
    if (net.controllerRx === null) {
      for (const m of net.drivers.values()) {
        // A wire a peer board's controller reads already carries the module's
        // bytes to it; this board may still sample the pin, if it can time
        // it, but a board that cannot is not told to rewire a module that is
        // heard.
        if (peerListens) {
          if (pins && clock && m.baud !== undefined) wantEmitter = true;
        } else if (soft(m)) {
          wantEmitter = true;
        }
      }
      // A peer board transmits on this wire (its controller, or a module on
      // its canvas) and this board reads the pin as a plain GPIO: the bytes
      // go out here as edges at the sender's rate. A board that cannot time
      // its pads keeps them on the sender's board, with no report: the
      // uart-no-clock diagnostic names a module, and this is another board.
      if (pins && clock && peerDrives) wantEmitter = true;
    }
    if (wantEmitter && pins && clock) {
      let emitter = this.uartEmitters.get(pin);
      if (!emitter) {
        emitter = new SoftUartEmitter(pins, clock, pin);
        this.uartEmitters.set(pin, emitter);
        emitter.rest();
      }
      const e = emitter;
      net.emit = (byte, baud, spec) => e.emit(byte, baud, spec);
    } else {
      this.dropUartEmitter(pin);
      net.emit = null;
    }
    // The emitter's own edges come back as pin changes on engines that echo
    // an injected input; a decoder on the same wire must not read them.
    const emitter = this.uartEmitters.get(pin);
    for (const d of this.uartDecoders.get(pin)?.values() ?? []) {
      d.mutedUntil = emitter ? () => emitter.busyUntil : () => 0;
    }
    net.checkDrivers();
    net.checkListeners();
  }

  private dropUartDecoders(pin: number): void {
    for (const d of this.uartDecoders.get(pin)?.values() ?? []) d.dispose();
    this.uartDecoders.delete(pin);
  }

  private dropUartEmitter(pin: number): void {
    this.uartEmitters.delete(pin);
  }

  private uartRoutingOf(slot: UartSlot): void {
    const r: UartRouting | 'static' = slot.port.routing();
    if (r === 'static') {
      const kind = this.kind();
      const def = kind ? controllerOf(kind, 'uart', slot.port.unit) : undefined;
      slot.tx = firstPin(def?.defaultPins.tx);
      slot.rx = firstPin(def?.defaultPins.rx);
    } else {
      slot.tx = r.tx;
      slot.rx = r.rx;
    }
  }

  /** Point every UART controller at the nets its TX and RX pins are on. */
  private routeUart(): void {
    for (const net of this.uartNets.values()) {
      net.controllerTx = null;
      net.controllerRx = null;
    }
    for (const net of this.uartNets.values()) this.pointControllersAt(net);
    // The registry hears before the checks run, for the same reason as in
    // uartMembershipChanged: a controller that just moved onto a pin wired
    // to another board is linked to that board's net first.
    this.uartChanged();
    for (const net of this.uartNets.values()) this.refreshUart(net);
  }

  /** Give `net` the controllers whose routed TX or RX pin is its pin. */
  private pointControllersAt(net: UartNet): void {
    this.refreshUartSlots();
    for (const slot of this.uartSlots) {
      if (slot.tx === net.pin) {
        if (net.controllerTx && net.controllerTx !== slot.ref) {
          this.report({
            code: 'uart-wiring',
            bus: 'uart',
            boardId: this.boardId,
            owners: [],
            message: `${net.controllerTx.name} and ${slot.port.name} are both routed to TX pin ${net.pin}.`,
          });
        }
        net.controllerTx = slot.ref;
      }
      // Two controllers listening on one pin is one TX to two RX: legal.
      if (slot.rx === net.pin) net.controllerRx = slot.ref;
    }
  }

  /**
   * The controller whose TX feeds `pin` and the one whose RX reads it, for
   * the bus map a remote worker is sent and for the inspector.
   */
  uartControllersOf(pin: number): { tx: UartControllerRef | null; rx: UartControllerRef | null } {
    const net = this.uartNets.get(pin);
    if (net) return { tx: net.controllerTx, rx: net.controllerRx };
    let tx: UartControllerRef | null = null;
    let rx: UartControllerRef | null = null;
    for (const slot of this.uartSlots) {
      if (slot.tx === pin && !tx) tx = slot.ref;
      if (slot.rx === pin) rx = slot.ref;
    }
    return { tx, rx };
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
    this.routeUart();
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
    for (const bus of this.i2cBuses.values()) {
      bus.controllerName = null;
      bus.controllerRemote = false;
    }
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
      bus.controllerRemote = slot.port.remote === true;
    }
    for (const bus of this.i2cBuses.values()) {
      this.clockI2c(bus);
      this.checkI2cWiring(bus);
    }
    this.i2cChanged();
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
    for (const decoders of this.uartDecoders.values()) for (const d of decoders.values()) d.restart();
    for (const e of this.uartEmitters.values()) e.reset();
    // Once per endpoint, not per leg: a modem with both legs here is one chip.
    const told = new Set<UartEndpoint>();
    for (const net of this.uartNets.values()) {
      for (const list of [net.listeners, net.drivers]) {
        for (const m of list.values()) {
          if (told.has(m.endpoint)) continue;
          told.add(m.endpoint);
          m.endpoint.boardReset?.();
        }
      }
    }
    for (const cb of this.resetListeners) cb();
  }
}
