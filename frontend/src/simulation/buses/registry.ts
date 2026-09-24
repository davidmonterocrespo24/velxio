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
 *
 * I2C targets live in the same registry with the same rules: registered once
 * by their own pin names, placed on the bus of their SDA net, moved when the
 * circuit changes, removed by the identity of their handle.
 */

import { BoardBusFabric } from './fabric';
import type { I2cBus, I2cMember } from './i2cBus';
import type { SpiBus, SpiMember } from './spiBus';
import type {
  BusDiagnostic,
  BusHandle,
  DevicePin,
  EngineBinding,
  I2cTarget,
  I2cTargetDescriptor,
  NetResolver,
  PinRef,
  RemoteSpiModel,
  ResolvedPin,
  SpiDevice,
  SpiDeviceDescriptor,
} from './types';
import { isBusCapable } from './types';

/** Where a device's chip select comes from, once resolved. */
type CsSource =
  | { kind: 'none' }
  /** `viaChip`: the line is driven by a chip on the canvas, not by the board,
   *  so a remote worker has no level for it (see remoteSinks). */
  | { kind: 'pin'; pin: number; viaChip?: boolean }
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

interface I2cEntry {
  desc: I2cTargetDescriptor;
  target: I2cTarget;
  /** Addresses as the bus indexes them: 7-bit, deduplicated. */
  addresses: number[];
  member: I2cMember | null;
  fabric: BoardBusFabric | null;
  bus: I2cBus | null;
  key: string;
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
    blob_ids: Record<string, string>;
  };
}

/**
 * The last entry of a published map: the chip selects of every device the tab
 * KEEPS on that board (displays, e-paper, a responder with no portable model),
 * so the worker relays a byte only while one of them could be selected
 * (F4-SPEC, "Worker, por byte", step 3). `all` says some device's select is
 * one the worker cannot follow, and then every byte goes.
 *
 * Carried inside the `spi` list rather than beside it so that nothing between
 * the tab and the worker has to learn a new field: a worker that does not know
 * it skips an entry with no model, and one that does not receive it relays
 * everything, which is what it did before.
 */
export interface RemoteSpiSinksEntry {
  sinks: { all: boolean; cs: Array<RemoteSpiMapEntry['cs']> };
}

export type SpiMapListener = (boardId: string) => void;

/** A placed device's live inputs changed: `attrs` is the whole set, now. */
export type SpiAttrsListener = (boardId: string, owner: string, attrs: Record<string, number>) => void;

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
  private readonly i2c = new Map<string, I2cEntry>();
  private readonly diagListeners = new Set<DiagnosticListener>();
  private readonly seenDiag = new Set<string>();
  private readonly mapListeners = new Set<SpiMapListener>();
  private readonly attrListeners = new Set<SpiAttrsListener>();
  /**
   * What each remote host was last told a device's live inputs are, by owner,
   * as a key. A pointer move that lands on the same values, or a circuit solve
   * that did not move this chip's nets, sends nothing. A map carries the
   * inputs too, so publishing one resets this to what it carried: otherwise a
   * value that went A (sent), B (only in a map), A again would be skipped as
   * "already sent" while the host holds B.
   */
  private readonly sentAttrs = new Map<string, string>();

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
    for (const e of this.i2c.values()) this.placeI2c(e);
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
    for (const e of this.i2c.values()) if (e.fabric === f) this.unplaceI2c(e);
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
      attrsChanged: () => {
        if (!disposed && this.spi.get(desc.owner) === entry) this.spiAttrsChanged(entry);
      },
    };
  }

  private detachSpi(owner: string): void {
    const e = this.spi.get(owner);
    if (!e) return;
    this.unplace(e);
    this.spi.delete(owner);
    this.sentAttrs.delete(owner);
  }

  /**
   * Tell the host of this device's portable model its inputs now. Only a
   * device that is on a bus and HAS a model is anywhere a host could run it;
   * the listener (the store) decides whether that bus's board is remote at
   * all, since only it knows which simulator holds the board.
   */
  private spiAttrsChanged(e: SpiEntry): void {
    if (!e.bus || !e.desc.remoteAttrs) return;
    if (!e.desc.remoteModel?.()) return;
    const attrs = e.desc.remoteAttrs();
    const key = attrsKey(attrs);
    if (this.sentAttrs.get(e.desc.owner) === key) return;
    this.sentAttrs.set(e.desc.owner, key);
    for (const l of this.attrListeners) {
      try {
        l(e.bus.boardId, e.desc.owner, attrs);
      } catch {
        /* a broken listener must not break the bus */
      }
    }
  }

  /** Called with a device's new live inputs (see `BusHandle.attrsChanged`). */
  onSpiAttrsChange(listener: SpiAttrsListener): () => void {
    this.attrListeners.add(listener);
    return () => this.attrListeners.delete(listener);
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
    if (desc.pins.miso !== undefined && miso === undefined && !e.device.writeOnly) {
      // The chip has a data-out leg and it reaches nothing on this board, so it
      // cannot answer. Silence here reads as a dead chip, which is exactly the
      // wiring mistake worth naming. Not for a write-only model: leaving its
      // SDO open is how most panels are wired, and "wire it or the chip never
      // answers" would be advice about an answer that does not exist.
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
        return { kind: 'pin', pin: cs.pin, viaChip: true };
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

  // ── I2C targets ───────────────────────────────────────────────────────────

  /**
   * Put an I2C target on the bus its SDA net is. As with SPI, registering an
   * owner that already exists replaces it. A chip with several addresses
   * registers them all in ONE descriptor: they are one identity, and they
   * leave together when its handle is disposed.
   */
  attachI2c(desc: I2cTargetDescriptor, target: I2cTarget): BusHandle {
    this.i2c.get(desc.owner) && this.detachI2c(desc.owner);
    const addresses: number[] = [];
    for (const a of desc.addresses) {
      if (Number.isInteger(a) && a >= 0 && a <= 0x7f && !addresses.includes(a)) addresses.push(a);
    }
    const entry: I2cEntry = { desc, target, addresses, member: null, fabric: null, bus: null, key: '' };
    this.i2c.set(desc.owner, entry);
    this.placeI2c(entry);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        // By identity: a stale handle never removes the owner's newer registration.
        if (this.i2c.get(desc.owner) === entry) this.detachI2c(desc.owner);
      },
      // I2C targets carry no portable model yet (F5-SPEC, out of scope).
      attrsChanged: () => {},
    };
  }

  private detachI2c(owner: string): void {
    const e = this.i2c.get(owner);
    if (!e) return;
    this.unplaceI2c(e);
    this.i2c.delete(owner);
  }

  private placeI2c(e: I2cEntry): void {
    const { desc } = e;
    const ref = (pin: DevicePin): PinRef =>
      typeof pin === 'string'
        ? { kind: 'component', componentId: desc.componentId ?? desc.owner, pinName: pin }
        : pin;
    const sda = this.resolver.resolve(ref(desc.pins.sda));
    const scl = this.resolver.resolve(ref(desc.pins.scl));
    if (sda.kind !== 'board' || scl.kind !== 'board' || sda.boardId !== scl.boardId) {
      if (e.key !== '') this.unplaceI2c(e);
      // Today's engines ACK a chip whether or not it is wired; on the bench it
      // is silent, and silence with no reason reads as a dead chip.
      const board = sda.kind === 'board' ? sda.boardId : scl.kind === 'board' ? scl.boardId : null;
      this.emit({
        code: 'i2c-wiring',
        bus: 'i2c',
        boardId: board,
        owners: [desc.owner],
        message:
          sda.kind === 'board' && scl.kind === 'board'
            ? `${desc.owner}: its SDA goes to ${sda.boardId} and its SCL to ${scl.boardId}; ` +
              `a chip can only be on one board's bus, so it does not answer.`
            : `${desc.owner}: its SDA ${describePin(sda)} and its SCL ${describePin(scl)}, so the ` +
              `chip does not answer. Wire both to the board's I2C pins (or to any two GPIOs for ` +
              `software I2C).`,
      });
      return;
    }
    const board = sda.boardId;
    const key = `${board}|${sda.pin}|${scl.pin}`;
    if (key === e.key && e.bus) return;
    this.unplaceI2c(e);
    const fabric = this.fabric(board);
    const bus = fabric.i2cBusFor(sda.pin);
    const member: I2cMember = {
      owner: desc.owner,
      desc,
      target: e.target,
      addresses: e.addresses,
      sclPin: scl.pin,
      clocked: false,
    };
    e.member = member;
    e.fabric = fabric;
    e.bus = bus;
    e.key = key;
    bus.add(member);
    fabric.i2cMembershipChanged(bus);
  }

  private unplaceI2c(e: I2cEntry): void {
    const { bus, fabric } = e;
    if (bus) {
      bus.remove(e.desc.owner);
      fabric?.i2cMembershipChanged(bus);
    }
    e.member = null;
    e.bus = null;
    e.fabric = null;
    e.key = '';
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
      // The live inputs as they are NOW, so a host that builds the model from
      // this map starts from what the user sees, not from the defaults.
      const live = e.desc.remoteAttrs?.();
      const attrs = { ...(model.attrs ?? {}), ...(live ?? {}) };
      if (live) this.sentAttrs.set(e.desc.owner, attrsKey(live));
      out.push({
        owner: e.desc.owner,
        bus_id: ctl ? ctl.unit : null,
        cs: this.remoteCs(e),
        model: {
          wasm_b64: model.wasmB64,
          pin_map: { ...this.remotePinMap(e, model.chipPads), ...(model.pinMap ?? {}) },
          attrs,
          blobs: model.blobs ?? {},
          blob_ids: model.blobIds ?? {},
        },
      });
    }
    return out;
  }

  /**
   * What a remote worker is sent: the responders it hosts, then the sinks the
   * tab keeps (see RemoteSpiSinksEntry).
   */
  remoteSpiPublication(boardId: string): Array<RemoteSpiMapEntry | RemoteSpiSinksEntry> {
    const map = this.remoteSpiMap(boardId);
    return [...map, this.remoteSinks(boardId, map)];
  }

  /**
   * Every device on `boardId` the worker does NOT host, by the select it
   * would be clocked under.
   *
   * The rule is one-sided on purpose. A sink that misses a byte decodes the
   * wrong picture, while a byte relayed for nobody only costs time, so
   * anything the worker cannot read a level for turns the saving off rather
   * than guess: no select line, a select tied active, a select a chip on the
   * canvas drives. A select tied inactive is left out, because the fabric
   * never selects that device either. A hosted responder whose model carries
   * blobs but cannot take the written spans back (`remoteBlobWrite`) stays a
   * sink, since the relayed bytes are the only way its copy follows the guest,
   * and so does one whose descriptor says the tab decodes its writes
   * (`remoteKeepsTabCopy`).
   */
  private remoteSinks(boardId: string, hosted: RemoteSpiMapEntry[]): RemoteSpiSinksEntry {
    const hostedOwners = new Set<string>();
    for (const h of hosted) {
      const desc = this.spi.get(h.owner)?.desc;
      // A model that answers for a device the tab still decodes (a panel's id
      // beside its pixels) leaves that device a sink as well.
      if (desc?.remoteKeepsTabCopy) continue;
      const hasBlobs = Object.keys(h.model.blobs ?? {}).length > 0;
      if (!hasBlobs || desc?.remoteBlobWrite) hostedOwners.add(h.owner);
    }
    const cs: Array<RemoteSpiMapEntry['cs']> = [];
    const seen = new Set<string>();
    let all = false;
    for (const e of this.spi.values()) {
      if (!e.bus || e.bus.boardId !== boardId || !e.fabric) continue;
      if (hostedOwners.has(e.desc.owner)) continue;
      if (e.cs.kind === 'none' || (e.cs.kind === 'const' && e.cs.active)) all = true;
      else if (e.cs.kind === 'pin') {
        if (e.cs.viaChip) {
          all = true;
          continue;
        }
        const c = this.remoteCs(e);
        const key = JSON.stringify(c);
        if (!seen.has(key)) {
          seen.add(key);
          cs.push(c);
        }
      }
    }
    return { sinks: { all, cs: all ? [] : cs } };
  }

  /**
   * A hosted model wrote into a blob (`bus_blob` from the worker): hand the
   * span to the device the map was built from. False when nobody here takes
   * it, which the caller can only log: the owner left the board, or it is not
   * a device that ships blobs.
   */
  applyRemoteBlob(
    boardId: string,
    owner: string,
    name: string,
    offset: number,
    data: Uint8Array,
    blobId?: string,
  ): boolean {
    const e = this.spi.get(owner);
    if (!e || !e.bus || e.bus.boardId !== boardId || !e.desc.remoteBlobWrite) return false;
    try {
      e.desc.remoteBlobWrite(name, offset, data, blobId);
    } catch (err) {
      console.warn(`[busRegistry] ${owner}: a written span could not be applied`, err);
      return false;
    }
    return true;
  }

  /**
   * The bus pins the circuit gave this device, under the pad names the model
   * declares (the part registers with the chip's own pad names, so the two are
   * the same string). The worker needs them for the model's own pin watches:
   * the card ends its command frame on CS rising, and without a pin map that
   * watch is registered against a pad the host cannot move. A model's explicit
   * `pinMap` wins, so a leg the circuit does not name (an interrupt output)
   * still travels. A part whose pads are not the chip's (a card inside a
   * shield) names the chip's pads in `chipPads`, and those are used instead.
   */
  private remotePinMap(e: SpiEntry, chipPads?: RemoteSpiModel['chipPads']): Record<string, number> {
    const out: Record<string, number> = {};
    const put = (pin: DevicePin | undefined, gpio: number | undefined): void => {
      if (typeof pin !== 'string' || gpio === undefined) return;
      out[pin] = gpio;
    };
    put(chipPads?.sck ?? e.desc.pins.sck, e.bus?.sckPin);
    put(chipPads?.mosi ?? e.desc.pins.mosi, e.member.mosiPin);
    put(chipPads?.miso ?? e.desc.pins.miso, e.member.misoPin);
    put(chipPads?.cs ?? e.desc.pins.cs, e.cs.kind === 'pin' ? e.cs.pin : undefined);
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

  /** Where each I2C target sits right now. */
  i2cPlacement(owner: string): { boardId: string; sdaPin: number; sclPin: number; clocked: boolean } | null {
    const e = this.i2c.get(owner);
    if (!e || !e.bus || !e.member) return null;
    return { boardId: e.bus.boardId, sdaPin: e.bus.sdaPin, sclPin: e.member.sclPin, clocked: e.member.clocked };
  }

  /** Drop everything. Tests only. */
  clear(): void {
    for (const owner of Array.from(this.spi.keys())) this.detachSpi(owner);
    for (const owner of Array.from(this.i2c.keys())) this.detachI2c(owner);
    for (const id of Array.from(this.fabrics.keys())) this.dropFabric(id);
    this.seenDiag.clear();
    this.mapListeners.clear();
    this.attrListeners.clear();
    this.sentAttrs.clear();
    this.resolver = NO_RESOLVER;
  }
}

/** Where a pin went, in words, for a wiring diagnostic. */
function describePin(p: ResolvedPin): string {
  switch (p.kind) {
    case 'board':
      return `is on pin ${p.pin} of ${p.boardId}`;
    case 'rail':
      return p.rail === 'gnd' ? 'is tied to GND' : 'is tied to a supply rail';
    case 'chip':
      return 'goes to another chip, not to a board';
    default:
      return 'is not connected';
  }
}

/** A stable identity for a set of attribute values, whatever order the part
 *  built them in. */
function attrsKey(attrs: Record<string, number>): string {
  return Object.keys(attrs)
    .sort()
    .map((k) => `${k}=${attrs[k]}`)
    .join('|');
}

/** The registry of the page. */
export const busRegistry = new BusRegistry();
