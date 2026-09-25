/**
 * One board's remote I2C lane (project board-buses-2026-09, F5).
 *
 * An ESP32 or an STM32 on QEMU runs its firmware in a backend worker, and QEMU
 * asks for the answer to every I2C event synchronously, so the models that
 * answer (the sensor twins, the write sinks behind the tab's displays, custom
 * chips) run in the worker, beside the guest. What the worker cannot know is
 * the circuit: which controller each of those targets is wired to. Before F5
 * it kept one target per address and answered on every controller, so two
 * identical sensors on Wire and Wire1 were one device and a sensor wired to
 * Wire1 answered Wire's probes (worker-i2c-slaves-ignore-bus-id).
 *
 * This lane is the tab's half. It publishes the board's controllers as ports,
 * so the fabric clocks and checks each bus as it does for a local engine, and
 * it builds the `i2c` half of the bus map the SPI lane already sends
 * (remoteLane.ts): per target the fabric placed on this board, the controller
 * its SDA is on. Same transport, same whole-list rule: a target that left is
 * gone by being absent.
 *
 * The controller is named only when the tab's pin table can say it. On a board
 * whose table routes by matrix (every ESP32: `Wire1.begin(25, 26)` is the
 * whole of Wire1's pin assignment) the map carries the SDA pad instead and the
 * worker reads the live GPIO matrix; a fixed or muxed table (STM32) names it
 * from the pad's functions.
 */

import { controllerOf, getBoardPinFunctions } from './pinFunctions';
import { busRegistry } from './registry';
import type { I2cControllerPort, I2cRouting, I2cTransactionHandler } from './types';

/**
 * One target of the map. Field names are the wire's, which is Python's
 * (app/services/i2c_bus_table.py), because this object is serialised straight
 * into the command.
 */
export interface RemoteI2cMapEntry {
  owner: string;
  /** The controller its SDA is on, or null when the tab cannot name it. */
  bus_id: number | null;
  /** Board pins; null for a target the fabric holds but that is on no bus
   *  (its SCL is not the bus's clock), which the worker then never answers. */
  sda: number | null;
  scl: number | null;
  addresses: number[];
}

/**
 * The owners the worker must keep silent: registered targets that are on no
 * bus of this board. The worker places a sensor record by its owner, and a
 * record the map says nothing about answers on every controller, which is
 * right only for a part that is not on the fabric yet. A part that IS on the
 * fabric and is wired to nothing here must not answer, so the map names it.
 */
export interface RemoteI2cUnplacedEntry {
  unplaced: string[];
}

/**
 * The controller port of a board whose CPU is in a backend worker.
 *
 * Nothing in the tab ever clocks it: the worker answers every event from its
 * own models, synchronously, and the tab only learns about a transaction when
 * a write sink echoes it. It exists so the fabric knows which SDA net each
 * controller drives (a bus with a controller is clocked on the controller's
 * SCL, and SDA/SCL crossed against it is reported), exactly as for an engine
 * in the tab. The handler it is given is kept and never called.
 */
export class RemoteI2cPort implements I2cControllerPort {
  readonly bus = 'i2c' as const;
  readonly unit: number;
  readonly name: string;
  /** The master is in the worker: a target here answers only through a model
   *  the worker holds, and the bus names the ones it does not. */
  readonly remote = true;
  private handler: I2cTransactionHandler | null = null;

  constructor(unit: number, name: string) {
    this.unit = unit;
    this.name = name;
  }

  setTransactionHandler(handler: I2cTransactionHandler | null): void {
    this.handler = handler;
  }

  /** Whether the fabric holds this port right now (tests, inspector). */
  get bound(): boolean {
    return this.handler !== null;
  }

  routing(): I2cRouting | 'static' {
    // The worker does not report routing to the tab; the board table's
    // defaults are the best static answer, and the map leaves the rest to the
    // worker's own read of the matrix.
    return 'static';
  }
}

export class RemoteI2cLane {
  /** One port per I2C controller the board's pin table lists. */
  readonly ports: RemoteI2cPort[];

  private readonly boardId: string;
  private readonly boardKind: string;
  private lastKey = '';

  constructor(boardId: string, boardKind: string) {
    this.boardId = boardId;
    this.boardKind = boardKind;
    const controllers = getBoardPinFunctions(boardKind)?.controllers ?? [];
    this.ports = controllers
      .filter((c) => c.bus === 'i2c')
      .map((c) => new RemoteI2cPort(c.unit, c.name));
  }

  /**
   * The `i2c` half of the bus map: every target the fabric placed on this
   * board, sorted by owner so the list (and the key below) never depends on
   * the order parts mounted in, then the owners that are on none of its buses.
   */
  publication(): Array<RemoteI2cMapEntry | RemoteI2cUnplacedEntry> {
    const fabric = busRegistry.fabric(this.boardId);
    const out: RemoteI2cMapEntry[] = [];
    for (const bus of fabric.i2cBuses.values()) {
      const unit = this.controllerOfSda(bus.sdaPin);
      for (const m of bus.members.values()) {
        out.push(
          m.clocked
            ? {
                owner: m.owner,
                bus_id: unit,
                sda: bus.sdaPin,
                scl: m.sclPin,
                addresses: [...m.addresses],
              }
            : { owner: m.owner, bus_id: null, sda: null, scl: null, addresses: [...m.addresses] },
        );
      }
    }
    out.sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
    const unplaced = busRegistry.unplacedI2cOwners(this.boardId);
    // Left out when empty, so a board with every target placed sends the same
    // list it did before this entry existed.
    return unplaced.length ? [...out, { unplaced }] : out;
  }

  /**
   * The publication, and whether it differs from the last one this lane
   * returned. The caller sends the map when it does; a map that went anyway
   * (the SPI half changed) should still take it, so both are returned.
   */
  poll(): { i2c: Array<RemoteI2cMapEntry | RemoteI2cUnplacedEntry>; changed: boolean } {
    const i2c = this.publication();
    const key = JSON.stringify(i2c);
    const changed = key !== this.lastKey;
    this.lastKey = key;
    return { i2c, changed };
  }

  /**
   * The controller whose SDA is `pin`, when the pin table can say it: the
   * controller whose default SDA it is, else the only one the pad can carry.
   * Null on a matrix board (the worker resolves the pad itself) and when two
   * controllers could be muxed there.
   */
  private controllerOfSda(pin: number): number | null {
    const table = getBoardPinFunctions(this.boardKind);
    if (!table || table.routing === 'matrix') return null;
    for (const port of this.ports) {
      const def = controllerOf(this.boardKind, 'i2c', port.unit)?.defaultPins.sda;
      if ((Array.isArray(def) ? def[0] : def) === pin) return port.unit;
    }
    const units = new Set<number>();
    for (const f of table.pins[pin] ?? []) {
      if (f.bus === 'i2c' && f.signal === 'sda') units.add(f.unit);
    }
    return units.size === 1 ? [...units][0] : null;
  }
}
