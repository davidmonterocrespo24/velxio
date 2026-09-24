/**
 * BusRegistry: every bus device of the project, and the fabric of every board.
 *
 * A device registers ONCE with its pins named on its own component. The
 * registry walks the nets to find the board and pins each device lands on,
 * puts it on the bus of its SCK net, and keeps its chip select up to date. It
 * recomputes membership when the circuit changes, so editing a wire moves the
 * device between buses without anyone re-attaching, and it re-watches chip
 * selects when a board's engine is bound again. Nothing depends on the order
 * devices registered in.
 */

import { BoardBusFabric } from './fabric';
import type { SpiBus, SpiMember } from './spiBus';
import type {
  BusDiagnostic,
  BusHandle,
  DevicePin,
  EngineBinding,
  NetResolver,
  PinRef,
  ResolvedPin,
  SpiDevice,
  SpiDeviceDescriptor,
} from './types';
import { isBusCapable } from './types';

/** Where a device's chip select comes from, once resolved. */
type CsSource =
  | { kind: 'none' }
  | { kind: 'pin'; pin: number }
  | { kind: 'const'; active: boolean };

interface SpiEntry {
  desc: SpiDeviceDescriptor;
  device: SpiDevice;
  member: SpiMember;
  /** Current placement, or null when the device is not on any bus. */
  fabric: BoardBusFabric | null;
  bus: SpiBus | null;
  cs: CsSource;
  /** Identity of the placement, to skip no-op recomputes. */
  key: string;
  unwatch: (() => void) | null;
}

export type DiagnosticListener = (d: BusDiagnostic) => void;

/**
 * One responder of the bus map the tab sends a remote worker (project
 * board-buses-2026-09, F4-SPEC "Protocolo"). Field names are the wire's, which
 * is Python's, because this object is serialised straight into the command.
 */
export interface RemoteSpiMapEntry {
  owner: string;
  /** The controller this device is on, or null when the tab cannot tell. */
  bus_id: number | null;
  cs:
    | { kind: 'pin'; gpio: number; active_low: boolean }
    | { kind: 'hw'; index: number; gpio: number; active_low: boolean }
    | { kind: 'const'; active: boolean }
    | { kind: 'none' };
  model: {
    wasm_b64: string;
    pin_map: Record<string, number>;
    attrs: Record<string, number>;
    blobs: Record<string, string>;
  };
}

export type SpiMapListener = (boardId: string) => void;

const NO_RESOLVER: NetResolver = {
  resolve: () => ({ kind: 'floating' }),
  boardKind: () => undefined,
  boards: () => [],
};

export class BusRegistry {
  private resolver: NetResolver = NO_RESOLVER;
  private readonly fabrics = new Map<string, BoardBusFabric>();
  private readonly fabricHooks = new Map<string, Array<() => void>>();
  private readonly spi = new Map<string, SpiEntry>();
  private readonly diagListeners = new Set<DiagnosticListener>();
  private readonly seenDiag = new Set<string>();
  private readonly mapListeners = new Set<SpiMapListener>();

  // ── Circuit ───────────────────────────────────────────────────────────────

  setResolver(resolver: NetResolver | null): void {
    this.resolver = resolver ?? NO_RESOLVER;
    this.netlistChanged();
  }

  /** The circuit changed (wires, components, boards): recompute membership. */
  netlistChanged(): void {
    const present = new Set(this.resolver.boards());
    for (const [id, f] of this.fabrics) {
      if (!present.has(id) && !f.bound) this.dropFabric(id);
    }
    for (const e of this.spi.values()) this.place(e);
  }

  // ── Boards ────────────────────────────────────────────────────────────────

  fabric(boardId: string): BoardBusFabric {
    let f = this.fabrics.get(boardId);
    if (!f) {
      f = new BoardBusFabric(
        boardId,
        () => this.resolver.boardKind(boardId),
        (d) => this.emit(d),
      );
      const fab = f;
      const hooks = [
        f.onBind(() => this.rewatch(fab)),
        f.onReset(() => this.rewatch(fab)),
      ];
      this.fabricHooks.set(boardId, hooks);
      this.fabrics.set(boardId, f);
    }
    return f;
  }

  /** Bind (or re-bind) a board's engine. `sim` may be any simulator object. */
  bindBoard(boardId: string, sim: unknown): void {
    const binding: EngineBinding | null = isBusCapable(sim) ? sim.getBusBinding() : null;
    this.fabric(boardId).bind(binding);
  }

  bindEngine(boardId: string, binding: EngineBinding | null): void {
    this.fabric(boardId).bind(binding);
  }

  /** The board is gone: its devices fall off their buses. */
  unbindBoard(boardId: string): void {
    const f = this.fabrics.get(boardId);
    if (!f) return;
    f.bind(null);
    if (!this.resolver.boards().includes(boardId)) this.dropFabric(boardId);
  }

  private dropFabric(boardId: string): void {
    const f = this.fabrics.get(boardId);
    if (!f) return;
    for (const e of this.spi.values()) if (e.fabric === f) this.unplace(e);
    for (const off of this.fabricHooks.get(boardId) ?? []) off();
    this.fabricHooks.delete(boardId);
    f.dispose();
    this.fabrics.delete(boardId);
  }

  // ── SPI devices ───────────────────────────────────────────────────────────

  /**
   * Put a device on the bus its wiring says it is on. Registering an owner
   * that already exists replaces it: a remount that skipped its cleanup can
   * never leave a stale twin listening.
   */
  attachSpi(desc: SpiDeviceDescriptor, device: SpiDevice): BusHandle {
    this.spi.get(desc.owner) && this.detachSpi(desc.owner);
    const entry: SpiEntry = {
      desc,
      device,
      member: {
        owner: desc.owner,
        desc,
        device,
        selected: false,
        reverse: false,
        checked: false,
      },
      fabric: null,
      bus: null,
      cs: { kind: 'const', active: false },
      key: '',
      unwatch: null,
    };
    this.spi.set(desc.owner, entry);
    this.place(entry);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.spi.get(desc.owner) === entry) this.detachSpi(desc.owner);
      },
    };
  }

  private detachSpi(owner: string): void {
    const e = this.spi.get(owner);
    if (!e) return;
    this.unplace(e);
    this.spi.delete(owner);
  }

  private ref(desc: SpiDeviceDescriptor, pin: DevicePin): PinRef {
    return typeof pin === 'string'
      ? { kind: 'component', componentId: desc.componentId ?? desc.owner, pinName: pin }
      : pin;
  }

  private resolve(desc: SpiDeviceDescriptor, pin: DevicePin | undefined): ResolvedPin {
    if (pin === undefined) return { kind: 'floating' };
    return this.resolver.resolve(this.ref(desc, pin));
  }

  /** Compute where a device belongs and move it there if that changed. */
  private place(e: SpiEntry): void {
    const { desc } = e;
    const sck = this.resolve(desc, desc.pins.sck);
    if (sck.kind !== 'board') {
      if (e.key !== '') this.unplace(e);
      return;
    }
    const board = sck.boardId;
    const onBoard = (p: ResolvedPin): number | undefined =>
      p.kind === 'board' && p.boardId === board ? p.pin : undefined;
    const mosi = onBoard(this.resolve(desc, desc.pins.mosi));
    const miso = onBoard(this.resolve(desc, desc.pins.miso));
    if (desc.pins.miso !== undefined && miso === undefined) {
      // The chip has a data-out leg and it reaches nothing on this board, so it
      // cannot answer. Silence here reads as a dead chip, which is exactly the
      // wiring mistake worth naming.
      this.emit({
        code: 'spi-wiring',
        bus: 'spi',
        boardId: board,
        owners: [desc.owner],
        message:
          `${desc.owner}: its MISO is not wired to the board, so the chip can clock bytes in ` +
          `but never answers. Wire it to the controller's MISO pin.`,
      });
    }
    const cs = this.csSource(desc, board);
    const key = `${board}|${sck.pin}|${mosi ?? ''}|${miso ?? ''}|${JSON.stringify(cs)}`;
    if (key === e.key && e.bus) return;
    this.unplace(e);
    const fabric = this.fabric(board);
    const bus = fabric.busFor(sck.pin);
    e.member.mosiPin = mosi;
    e.member.misoPin = miso;
    e.fabric = fabric;
    e.bus = bus;
    e.cs = cs;
    e.key = key;
    bus.add(e.member);
    fabric.memberAdded(bus);
    this.watch(e);
    this.spiMapChanged(board);
  }

  private unplace(e: SpiEntry): void {
    e.unwatch?.();
    e.unwatch = null;
    if (e.bus) {
      e.bus.setSelected(e.member, false);
      e.bus.remove(e.member.owner);
      e.fabric?.releaseIfEmpty(e.bus);
    }
    const board = e.bus?.boardId ?? null;
    e.bus = null;
    e.fabric = null;
    e.key = '';
    if (board !== null) this.spiMapChanged(board);
  }

  private csSource(desc: SpiDeviceDescriptor, board: string): CsSource {
    if (desc.pins.cs === undefined) return { kind: 'none' };
    const activeLow = (desc.csActive ?? 'low') === 'low';
    const cs = this.resolve(desc, desc.pins.cs);
    switch (cs.kind) {
      case 'board':
        if (cs.boardId === board) return { kind: 'pin', pin: cs.pin };
        this.emit({
          code: 'spi-cross-board',
          bus: 'spi',
          boardId: board,
          owners: [desc.owner],
          message:
            `${desc.owner}: its clock comes from one board and its chip select from another; ` +
            `the chip select is treated as unconnected.`,
        });
        return this.floating(desc, board);
      case 'chip':
        return { kind: 'pin', pin: cs.pin };
      case 'rail':
        return { kind: 'const', active: (cs.rail === 'gnd') === activeLow };
      default:
        return this.floating(desc, board);
    }
  }

  private floating(desc: SpiDeviceDescriptor, board: string): CsSource {
    if (desc.csWhenFloating === 'selected') return { kind: 'const', active: true };
    this.emit({
      code: 'spi-cs-floating',
      bus: 'spi',
      boardId: board,
      owners: [desc.owner],
      message:
        `${desc.owner}: its chip select is not connected, so the chip never answers. Wire CS to ` +
        `a GPIO, or to GND if it is the only device on the bus.`,
    });
    return { kind: 'const', active: false };
  }

  /** Start tracking the chip select of a placed device. */
  private watch(e: SpiEntry): void {
    e.unwatch?.();
    e.unwatch = null;
    const { fabric, bus } = e;
    if (!fabric || !bus) return;
    const cs = e.cs;
    if (cs.kind === 'none') {
      bus.setSelected(e.member, true);
      return;
    }
    if (cs.kind === 'const') {
      bus.setSelected(e.member, cs.active);
      return;
    }
    const activeHigh = (e.desc.csActive ?? 'low') === 'high';
    const update = () => {
      const lvl = fabric.level(cs.pin);
      // Never driven (or just reset): the line floats and the chip is not selected.
      bus.setSelected(e.member, lvl === undefined ? false : lvl === activeHigh);
    };
    e.unwatch = fabric.watchLevel(cs.pin, update);
    update();
  }

  /** A board was re-bound or reset: chip selects read from new pins. */
  private rewatch(f: BoardBusFabric): void {
    for (const e of this.spi.values()) if (e.fabric === f) this.watch(e);
  }

  // ── The bus map a remote worker needs ─────────────────────────────────────

  /**
   * Every responder on `boardId` that carries a portable model, with the chip
   * select the circuit gives it.
   *
   * Only responders travel. A sink (a display, an e-paper panel) stays in the
   * tab: it never drives MISO, so nothing waits for it, and the worker
   * forwards it the bytes instead. A responder with no portable model is left
   * out here and reported by its bus (`bus-remote-responder-missing`) the
   * moment it is selected, rather than shipped as an entry the worker would
   * have to guess at.
   */
  remoteSpiMap(boardId: string): RemoteSpiMapEntry[] {
    const out: RemoteSpiMapEntry[] = [];
    for (const e of this.spi.values()) {
      if (!e.bus || e.bus.boardId !== boardId || !e.fabric) continue;
      const model = e.desc.remoteModel?.();
      if (!model) continue;
      const ctl = e.fabric.controllerOfBus(e.bus.sckPin);
      out.push({
        owner: e.desc.owner,
        bus_id: ctl ? ctl.unit : null,
        cs: this.remoteCs(e),
        model: {
          wasm_b64: model.wasmB64,
          pin_map: { ...this.remotePinMap(e), ...(model.pinMap ?? {}) },
          attrs: model.attrs ?? {},
          blobs: model.blobs ?? {},
        },
      });
    }
    return out;
  }

  /**
   * The bus pins the circuit gave this device, under the pad names the model
   * declares (the part registers with the chip's own pad names, so the two are
   * the same string). The worker needs them for the model's own pin watches:
   * the card ends its command frame on CS rising, and without a pin map that
   * watch is registered against a pad the host cannot move. A model's explicit
   * `pinMap` wins, so a leg the circuit does not name (an interrupt output)
   * still travels.
   */
  private remotePinMap(e: SpiEntry): Record<string, number> {
    const out: Record<string, number> = {};
    const put = (pin: DevicePin | undefined, gpio: number | undefined): void => {
      if (typeof pin !== 'string' || gpio === undefined) return;
      out[pin] = gpio;
    };
    put(e.desc.pins.sck, e.bus?.sckPin);
    put(e.desc.pins.mosi, e.member.mosiPin);
    put(e.desc.pins.miso, e.member.misoPin);
    put(e.desc.pins.cs, e.cs.kind === 'pin' ? e.cs.pin : undefined);
    return out;
  }

  private remoteCs(e: SpiEntry): RemoteSpiMapEntry['cs'] {
    const activeLow = (e.desc.csActive ?? 'low') === 'low';
    if (e.cs.kind === 'none') return { kind: 'none' };
    if (e.cs.kind === 'const') return { kind: 'const', active: e.cs.active };
    // A pad the SPI peripheral drives itself never moves in the worker's GPIO
    // table, so it travels as the peripheral's own CS index instead.
    const hw = e.fabric?.hardwareCsIndex(e.cs.pin) ?? null;
    // The pad number travels with the index: the worker never sees a GPIO
    // edge for it, so it is the only way a model that watches its own select
    // line can be told the line moved.
    if (hw !== null) return { kind: 'hw', index: hw, gpio: e.cs.pin, active_low: activeLow };
    return { kind: 'pin', gpio: e.cs.pin, active_low: activeLow };
  }

  /**
   * A portable model that was not there when the maps were built has arrived
   * (the artifact is fetched, so the first map of a page is usually built
   * without it). Publish every board's map again: a device carries its model
   * only from `remoteModel()`, so this is the moment the worker can stop
   * reading an idle bus.
   */
  spiModelsChanged(): void {
    const boards = new Set<string>();
    for (const e of this.spi.values()) if (e.bus) boards.add(e.bus.boardId);
    for (const id of boards) this.spiMapChanged(id);
  }

  /** Called after the map of `boardId` could have changed. */
  onSpiMapChange(listener: SpiMapListener): () => void {
    this.mapListeners.add(listener);
    return () => this.mapListeners.delete(listener);
  }

  private spiMapChanged(boardId: string): void {
    for (const l of this.mapListeners) {
      try {
        l(boardId);
      } catch {
        /* a broken listener must not break the bus */
      }
    }
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────

  onDiagnostic(listener: DiagnosticListener): () => void {
    this.diagListeners.add(listener);
    return () => this.diagListeners.delete(listener);
  }

  /** Forget reported diagnostics (a new Run reports them again, once). */
  resetDiagnostics(): void {
    this.seenDiag.clear();
  }

  private emit(d: BusDiagnostic): void {
    const key = `${d.code}|${d.boardId ?? ''}|${d.owners.join(',')}|${d.owners.length ? '' : d.message}`;
    if (this.seenDiag.has(key)) return;
    this.seenDiag.add(key);
    for (const l of this.diagListeners) {
      try {
        l(d);
      } catch {
        /* a broken listener must not break the bus */
      }
    }
  }

  // ── Introspection (tests, inspector) ──────────────────────────────────────

  /** Where each SPI device sits right now. */
  placement(owner: string): { boardId: string; sckPin: number; selected: boolean } | null {
    const e = this.spi.get(owner);
    if (!e || !e.bus) return null;
    return { boardId: e.bus.boardId, sckPin: e.bus.sckPin, selected: e.member.selected };
  }

  /** Drop everything. Tests only. */
  clear(): void {
    for (const owner of Array.from(this.spi.keys())) this.detachSpi(owner);
    for (const id of Array.from(this.fabrics.keys())) this.dropFabric(id);
    this.seenDiag.clear();
    this.mapListeners.clear();
    this.resolver = NO_RESOLVER;
  }
}

/** The registry of the page. */
export const busRegistry = new BusRegistry();
