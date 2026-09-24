/**
 * One SPI bus = one SCK net on one board (DESIGN section 6.1).
 *
 * A hardware controller whose SCK is routed to that net delivers its frames
 * here; a software (bit-banged) master on the same net delivers them through
 * the soft decoder. Either way the arbitration is the wire's:
 *
 *   - a device only ever sees frames clocked while its chip select is active;
 *   - MISO is the answer of the one selected device that drives it, or the
 *     line's idle level when none does;
 *   - two drivers at once is contention (AND, plus a diagnostic), exactly the
 *     garbage a real board reads back.
 *
 * The selected set is maintained on chip-select EDGES, never looked up per
 * frame, so the per-frame cost is one call to the selected device.
 */

import type {
  BitOrder,
  BusDiagnostic,
  SpiControllerConfig,
  SpiDevice,
  SpiDeviceDescriptor,
  SpiMode,
} from './types';

export type DiagnosticSink = (d: BusDiagnostic) => void;

/** A device drives MISO only if its MISO pin reaches this board's net: a chip
 *  whose data-out leg is not wired (a 74HC595's QH) leaves the line alone, as
 *  it does on the bench. A device that declares no MISO pin at all answers
 *  null anyway. */
function drives(m: SpiMember): boolean {
  return m.desc.pins.miso === undefined ? false : m.misoPin !== undefined;
}

/** Bus-side view of one registered device. */
export interface SpiMember {
  readonly owner: string;
  readonly desc: SpiDeviceDescriptor;
  readonly device: SpiDevice;
  /** Board pins its MOSI / MISO landed on (for wiring diagnostics). */
  mosiPin?: number;
  misoPin?: number;
  /** Chip select currently active. Maintained by the fabric. */
  selected: boolean;
  /** Bits reversed on the way in and out: controller and chip disagree on order. */
  reverse: boolean;
  /** Mode/order checked against the controller for the current selection. */
  checked: boolean;
}

/** What the bus needs from the controller serving it, if any. */
export interface BusController {
  readonly name: string;
  config(): SpiControllerConfig;
  /** The master runs outside this tab (a QEMU worker): see reportRemoteGaps. */
  readonly remote?: boolean;
}

export function reverseBits(v: number, bits: number): number {
  let out = 0;
  for (let i = 0; i < bits; i++) {
    out = (out << 1) | ((v >> i) & 1);
  }
  return out >>> 0;
}

const MODE_NAMES: Record<SpiMode, string> = { 0: 'mode 0', 1: 'mode 1', 2: 'mode 2', 3: 'mode 3' };

export class SpiBus {
  readonly members = new Map<string, SpiMember>();
  /** Controller that delivers hardware frames to this bus, if one is routed here. */
  controller: BusController | null = null;
  /** MISO level with nothing driving it (the line's pull; 0xFF = pull-up). */
  idleMiso = 0xff;
  /** Called after the selected set changes (the soft decoder restarts its frame). */
  onSelectionChange: (() => void) | null = null;

  private selectedList: SpiMember[] = [];

  readonly boardId: string;
  readonly sckPin: number;
  private readonly report: DiagnosticSink;

  constructor(boardId: string, sckPin: number, report: DiagnosticSink) {
    this.boardId = boardId;
    this.sckPin = sckPin;
    this.report = report;
  }

  add(member: SpiMember): void {
    this.members.set(member.owner, member);
    if (member.selected) this.rebuildSelection();
  }

  remove(owner: string): void {
    const m = this.members.get(owner);
    if (!m) return;
    this.members.delete(owner);
    if (m.selected) this.rebuildSelection();
  }

  get size(): number {
    return this.members.size;
  }

  /** The fabric calls this on every chip-select edge of a member. */
  setSelected(member: SpiMember, active: boolean): void {
    if (member.selected === active) return;
    member.selected = active;
    member.checked = false;
    this.rebuildSelection();
    if (active) member.device.select?.();
    else member.device.deselect?.();
  }

  private rebuildSelection(): void {
    const list: SpiMember[] = [];
    for (const m of this.members.values()) if (m.selected) list.push(m);
    this.selectedList = list;
    this.onSelectionChange?.();
    this.reportRemoteGaps();
    if (list.length > 1) {
      this.report({
        code: 'spi-multiple-selected',
        bus: 'spi',
        boardId: this.boardId,
        owners: list.map((m) => m.owner).sort(),
        message:
          `${list.length} SPI devices are selected at the same time on the bus whose SCK is pin ` +
          `${this.sckPin}; each one receives the other's bytes, as on a real board.`,
      });
    }
  }

  /**
   * On a remote lane, name every selected device that would have to ANSWER
   * and has no portable model to answer with.
   *
   * The master is in a QEMU worker: it reads MISO for a byte before this tab
   * has seen the byte at all, so a responder that lives only here cannot be
   * right, only late. Half working is the worst outcome (the guest reads the
   * answer to an earlier byte and the sketch misbehaves somewhere else
   * entirely), so the device is told about instead. Reported once per device
   * and Run, by the registry's own deduplication.
   */
  reportRemoteGaps(): void {
    if (!this.controller?.remote) return;
    for (const m of this.selectedList) {
      if (!drives(m)) continue;
      if (m.desc.remoteModel?.() != null) continue;
      this.report({
        code: 'bus-remote-responder-missing',
        bus: 'spi',
        boardId: this.boardId,
        owners: [m.owner],
        message:
          `${m.owner} answers on MISO, but this board's processor runs in the backend and the ` +
          `part has no portable model to run there with it, so the board reads an idle bus ` +
          `instead of the chip. Run this board on an in-browser engine, or use a part that ` +
          `carries a model.`,
      });
    }
  }

  /** Check a newly selected member against the controller clocking it. */
  private check(m: SpiMember): void {
    m.checked = true;
    m.reverse = false;
    const ctl = this.controller;
    if (!ctl) return;
    const cfg = ctl.config();
    const wantOrder: BitOrder = m.desc.bitOrder ?? 'msb';
    if (cfg.bitOrder && cfg.bitOrder !== wantOrder) {
      m.reverse = true;
      this.report({
        code: 'spi-bit-order',
        bus: 'spi',
        boardId: this.boardId,
        owners: [m.owner],
        message:
          `${ctl.name} shifts ${cfg.bitOrder.toUpperCase()} first but ${m.owner} expects ` +
          `${wantOrder.toUpperCase()} first; the chip receives every byte bit-reversed.`,
      });
    }
    if (cfg.mode !== undefined && m.desc.modes && !m.desc.modes.includes(cfg.mode)) {
      this.report({
        code: 'spi-mode',
        bus: 'spi',
        boardId: this.boardId,
        owners: [m.owner],
        message:
          `${ctl.name} runs in SPI ${MODE_NAMES[cfg.mode]} but ${m.owner} only accepts ` +
          `${m.desc.modes.map((x) => MODE_NAMES[x]).join(', ')}; on hardware the data would be shifted.`,
      });
    }
  }

  /** One hardware frame. Returns the MISO the master reads for it. */
  frame(mosi: number, bits: number): number {
    const sel = this.selectedList;
    const n = sel.length;
    if (n === 0) return this.idleMiso;
    if (n === 1) {
      const m = sel[0];
      if (!m.checked) this.check(m);
      const wired = drives(m);
      if (!m.reverse) {
        const r = m.device.transfer(mosi, bits);
        return r === null || !wired ? this.idleMiso : r;
      }
      const r = m.device.transfer(reverseBits(mosi, bits), bits);
      return r === null || !wired ? this.idleMiso : reverseBits(r, bits);
    }
    let drivers = 0;
    let miso = this.idleMiso;
    const driving: string[] = [];
    for (let i = 0; i < n; i++) {
      const m = sel[i];
      if (!m.checked) this.check(m);
      const r = m.reverse
        ? (() => {
            const x = m.device.transfer(reverseBits(mosi, bits), bits);
            return x === null ? null : reverseBits(x, bits);
          })()
        : m.device.transfer(mosi, bits);
      if (r === null || !drives(m)) continue;
      drivers++;
      driving.push(m.owner);
      miso = drivers === 1 ? r : miso & r;
    }
    if (drivers > 1) {
      this.report({
        code: 'spi-contention',
        bus: 'spi',
        boardId: this.boardId,
        owners: driving.sort(),
        message:
          `${driving.join(' and ')} drive MISO at the same time; the master reads the ` +
          `wired-AND of both, which is what two push-pull outputs fighting look like.`,
      });
    }
    return miso;
  }

  /**
   * A whole block clocked while the selection cannot change. A single selected
   * write-only sink takes it in one call; anything else goes frame by frame so
   * the result is identical to the per-byte path.
   */
  block(mosi: Uint8Array, miso: Uint8Array | null): void {
    const sel = this.selectedList;
    if (sel.length === 1) {
      const m = sel[0];
      if (!m.checked) this.check(m);
      if (m.device.transferBlock && !m.reverse && miso === null) {
        m.device.transferBlock(mosi);
        return;
      }
    }
    for (let i = 0; i < mosi.length; i++) {
      const r = this.frame(mosi[i], 8);
      if (miso) miso[i] = r & 0xff;
    }
  }

  /** What a software master will read on its next frame (see SpiDevice.peekMiso). */
  peekMiso(): number {
    const sel = this.selectedList;
    if (sel.length !== 1) {
      if (sel.length === 0) return this.idleMiso;
      let miso = this.idleMiso;
      let drivers = 0;
      for (const m of sel) {
        const r = drives(m) ? (m.device.peekMiso?.() ?? null) : null;
        if (r === null) continue;
        drivers++;
        miso = drivers === 1 ? r : miso & r;
      }
      return miso;
    }
    const r = drives(sel[0]) ? (sel[0].device.peekMiso?.() ?? null) : null;
    return r === null ? this.idleMiso : r;
  }

  /** The members currently selected, for the soft decoder and diagnostics. */
  selected(): readonly SpiMember[] {
    return this.selectedList;
  }

  boardReset(): void {
    for (const m of this.members.values()) m.device.boardReset?.();
  }
}
