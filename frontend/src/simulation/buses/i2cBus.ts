/**
 * One I2C bus = one SDA net on one board (DESIGN sections 3.2 and 6.2).
 *
 * The same idea as SpiBus with the SCK net: a hardware controller whose SDA is
 * routed to that net drives its transactions here, and a software (bit-banged)
 * master on the same net drives them through the soft decoder. Arbitration is
 * the wire's, and the wire is open-drain:
 *
 *   - every target that has the address sees the START and may ACK; the
 *     controller reads an ACK if ANY of them pulls SDA low;
 *   - a read with several answering targets is the wired-AND of their bytes,
 *     plus an `i2c-address-conflict` diagnostic, because that is the garbage a
 *     real board reads back;
 *   - an address nobody has is a NACK, and a read from nobody is 0xFF (the
 *     pull-up), never an answer invented by the bus.
 *
 * Addresses are indexed when membership changes, never searched per byte.
 */

import type { DiagnosticSink } from './spiBus';
import type { I2cTarget, I2cTargetDescriptor, I2cTransactionHandler } from './types';
import { WORKER_I2C_MODELS } from './workerI2cModels';

/** Bus-side view of one registered target. */
export interface I2cMember {
  readonly owner: string;
  readonly desc: I2cTargetDescriptor;
  readonly target: I2cTarget;
  /** 7-bit addresses, deduplicated. */
  readonly addresses: readonly number[];
  /** Board pin its SCL landed on. */
  sclPin: number;
  /**
   * Its SCL is the bus's clock. A chip whose SCL sits on another pin shares
   * the data line but never sees a clock edge from this controller, so on the
   * bench it never answers either.
   */
  clocked: boolean;
}

const hex = (a: number): string => `0x${a.toString(16).padStart(2, '0')}`;

export class I2cBus implements I2cTransactionHandler {
  readonly members = new Map<string, I2cMember>();
  /** The bus's clock line (a board pin), when anything defines one. */
  sclPin: number | undefined;
  /** Name of the controller routed to this SDA net, for diagnostics. */
  controllerName: string | null = null;
  /** That controller's master runs outside this tab: see reportRemoteGaps. */
  controllerRemote = false;

  /** Clocked members by address, owner-sorted so no call order depends on attach order. */
  private byAddress = new Map<number, I2cMember[]>();
  /** Targets that ACKed the current address phase. */
  private active: I2cMember[] = [];
  /** Every target addressed since the last STOP: all of them see that STOP. */
  private readonly touched = new Set<I2cMember>();
  private reading = false;

  readonly boardId: string;
  readonly sdaPin: number;
  private readonly report: DiagnosticSink;

  constructor(boardId: string, sdaPin: number, report: DiagnosticSink) {
    this.boardId = boardId;
    this.sdaPin = sdaPin;
    this.report = report;
  }

  get size(): number {
    return this.members.size;
  }

  /**
   * Membership changes do not reindex here: the clock line may depend on the
   * members (a bus with no controller is clocked where its targets' SCL is),
   * so the fabric decides it and then reindexes once (setClock / reindex).
   * Indexing in between would judge the new member against the old clock.
   */
  add(member: I2cMember): void {
    this.members.set(member.owner, member);
  }

  remove(owner: string): void {
    const m = this.members.get(owner);
    if (!m) return;
    this.members.delete(owner);
    // A chip deleted mid-transaction is simply gone: it neither answers the
    // rest of it nor sees its STOP.
    this.active = this.active.filter((x) => x !== m);
    this.touched.delete(m);
    const index = new Map<number, I2cMember[]>();
    for (const [a, list] of this.byAddress) {
      const kept = list.filter((x) => x !== m);
      if (kept.length) index.set(a, kept);
    }
    // Gone from the index at once, whatever the fabric does next.
    this.byAddress = index;
  }

  /** Set the bus's clock line and mark who is on it. */
  setClock(sclPin: number | undefined): void {
    this.sclPin = sclPin;
    this.reindex();
  }

  /** Rebuild the address index from the members that see the clock. */
  reindex(): void {
    const index = new Map<number, I2cMember[]>();
    const owners = Array.from(this.members.keys()).sort();
    for (const owner of owners) {
      const m = this.members.get(owner)!;
      m.clocked = this.sclPin !== undefined && m.sclPin === this.sclPin;
      if (!m.clocked) {
        // No clock at all only happens on a bus with no members left to vote.
        if (this.sclPin === undefined) continue;
        this.report({
          code: 'i2c-wiring',
          bus: 'i2c',
          boardId: this.boardId,
          owners: [m.owner],
          message:
            `${m.owner}: its SDA is on pin ${this.sdaPin} but its SCL is on pin ${m.sclPin}, ` +
            `while this bus is clocked on pin ${this.sclPin}; the chip never sees the clock and ` +
            `never answers.`,
        });
        continue;
      }
      for (const a of m.addresses) {
        let list = index.get(a);
        if (!list) index.set(a, (list = []));
        list.push(m);
      }
    }
    this.byAddress = index;
    for (const [a, list] of index) if (list.length > 1) this.conflict(a, list);
    // Whatever is mid-transaction keeps only targets that are still addressable.
    this.active = this.active.filter((m) => m.clocked && this.members.get(m.owner) === m);
  }

  /**
   * On a bus whose controller is in a backend worker, name every target the
   * worker has no model of.
   *
   * QEMU asks for the ACK of an address and for every byte synchronously, and
   * the worker answers from its own models; this tab only hears a
   * transaction afterwards, if at all. A chip whose model lives only here is
   * therefore not on the guest's bus: its address NAKs, and a sketch that
   * reads it prints "sensor not found" with nothing to say why. Unlike SPI,
   * a write sink is no exception: nothing ACKs a display's address unless the
   * worker holds a sink for it. Only clocked targets are named; one that
   * never sees the clock already has its own diagnostic.
   */
  reportRemoteGaps(): void {
    if (!this.controllerRemote) return;
    for (const m of this.members.values()) {
      if (!m.clocked) continue;
      const model = m.desc.remoteModel;
      if (model !== undefined && WORKER_I2C_MODELS.has(model)) continue;
      this.report({
        code: 'bus-remote-responder-missing',
        bus: 'i2c',
        boardId: this.boardId,
        owners: [m.owner],
        message:
          `${m.owner} is on the I2C bus whose SDA is pin ${this.sdaPin}, but this board's ` +
          `processor runs in the backend and has no model of the part to answer with, so the ` +
          `board finds nothing at ${m.addresses.map(hex).join(', ')}. Run this board on an ` +
          `in-browser engine, or use a part the backend models.`,
      });
    }
  }

  private conflict(address: number, list: readonly I2cMember[]): void {
    const owners = list.map((m) => m.owner).sort();
    this.report({
      code: 'i2c-address-conflict',
      bus: 'i2c',
      boardId: this.boardId,
      owners,
      message:
        `${owners.join(' and ')} all answer at address ${hex(address)} on the bus whose SDA is ` +
        `pin ${this.sdaPin}: every one of them ACKs, and a read returns the wired-AND of their ` +
        `bytes. Give one of them another address, or move it to another bus.`,
    });
  }

  // ── Transactions (the controller port and the soft decoder both call these) ──

  start(address: number, read: boolean): boolean {
    const a = address & 0x7f;
    // A repeated START ends the previous address phase without a STOP: those
    // targets stay in `touched` and see the STOP when it comes.
    this.active = [];
    this.reading = read;
    const list = this.byAddress.get(a);
    if (!list) return false;
    let acked: I2cMember[] | null = null;
    for (const m of list) {
      this.touched.add(m);
      if (m.target.start(a, read)) (acked ??= []).push(m);
    }
    if (!acked) return false;
    this.active = acked;
    if (acked.length > 1) this.conflict(a, acked);
    return true;
  }

  write(byte: number): boolean {
    const act = this.active;
    if (act.length === 0 || this.reading) return false;
    if (act.length === 1) return act[0].target.write(byte & 0xff);
    // Every addressed chip takes the byte; any one of them pulling SDA low is an ACK.
    let ack = false;
    for (const m of act) if (m.target.write(byte & 0xff)) ack = true;
    return ack;
  }

  read(): number {
    const act = this.active;
    if (act.length === 0 || !this.reading) return 0xff;
    if (act.length === 1) return act[0].target.read() & 0xff;
    let v = 0xff;
    // Reported at the address phase that made more than one of them active.
    for (const m of act) v &= m.target.read();
    return v & 0xff;
  }

  stop(): void {
    this.active = [];
    if (this.touched.size === 0) return;
    const list = Array.from(this.touched).sort((x, y) => (x.owner < y.owner ? -1 : x.owner > y.owner ? 1 : 0));
    this.touched.clear();
    for (const m of list) m.target.stop();
  }

  /** The MCU was reset: whatever transaction was open is gone with it. */
  boardReset(): void {
    this.active = [];
    this.touched.clear();
    for (const m of this.members.values()) m.target.boardReset?.();
  }

  /** Clocked targets at an address (tests, inspector). */
  targetsAt(address: number): readonly I2cMember[] {
    return this.byAddress.get(address & 0x7f) ?? [];
  }
}
