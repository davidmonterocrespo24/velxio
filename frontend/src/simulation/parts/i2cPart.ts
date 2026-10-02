/**
 * An I2C part on the bus fabric (project board-buses-2026-09, F5).
 *
 * A part is on an I2C bus because its SDA and SCL are wired to one, not
 * because it was handed a simulator: it registers once with its own pin names,
 * and the fabric puts it on the bus of its SDA net, keeps it there across every
 * reset of the SoC, moves it when a wire moves, and takes it off by identity.
 * That is what ends the three ways registration by address went wrong:
 *
 *   - a device handed to the simulator went on the board's bus 0, so a part on
 *     Wire1 (or on the XIAO RP2040, whose Wire is I2C1) never answered, and a
 *     part wired to nothing answered anyway;
 *   - removal by address took off whichever device held that address,
 *     the part's replacement included;
 *   - the worker record of a QEMU board was keyed by 200 + address, so two
 *     parts at one address were one record, and deleting one deleted both.
 *
 * The part keeps its register model in the `I2CDevice` shape it always had;
 * this module adapts it to the fabric's target contract.
 */

import { attachI2cTarget, busRegistry, type BusDiagnosticCode, type I2cTarget } from '../buses';
import type { I2CDevice } from '../I2CBusManager';
import { chipVirtualPin } from '../customChips/chipVirtualPin';
import { hostsChipsInWorker, hostsI2cModel } from '../customChips/simulatorBridges';

// The bridges stamp the clock too, and import it from where nothing else comes
// with it.
export { hostClockRecord, withHostClock } from './hostClock';

/**
 * A register-file part as a bus target.
 *
 * The bus only calls a target for traffic addressed to it, so the ACK of the
 * address phase is "present". What a register-file model needs to hear is the
 * START that turns a transaction around: its first written byte is a register
 * pointer, and it tracks that with a flag it clears in stop(). A repeated START
 * for writing, with no STOP before it, starts a new pointer write on the bench
 * (M5Unified reads the BMI270's id twice that way), so the flag is cleared
 * there too. Only then: a stop() per transaction is also what repaints a
 * display, and doing it on every START would paint each frame twice.
 *
 * A model that has to know where a read begins hears every START itself
 * (`start`): the MPU-6050 answers a burst from the sample it latched there.
 * One that does something between two transactions is handed the clock of
 * the board it was placed on (`setClock`).
 */
export function i2cTargetOf(device: I2CDevice): I2cTarget & { dumpRegisters?: () => Uint8Array } {
  let open = false;
  const target: I2cTarget & {
    dumpRegisters?: () => Uint8Array;
    volatileReads?: readonly number[];
    pointerStays?: readonly number[];
    pointerWrapsAfter?: number;
  } = {
    start: (_address, read) => {
      if (open && !read) device.stop?.();
      open = true;
      device.start?.(read);
      return true;
    },
    write: (byte) => device.writeByte(byte),
    read: () => device.readByte() & 0xff,
    stop: () => {
      open = false;
      device.stop?.();
    },
    // The MCU reset in the middle of a transaction: the part is back to
    // waiting for a pointer. Its registers are its own and stay.
    boardReset: () => {
      if (open) {
        open = false;
        device.stop?.();
      }
      device.boardReset?.();
    },
  };
  // Only a model that keeps time asks for the clock.
  if (typeof device.setClock === 'function') {
    target.setClock = (clock) => device.setClock!(clock);
  }
  // A board whose guest reads the bus from somewhere else (the Pi relay)
  // answers a register file from a copy instead of a round trip per byte.
  if (typeof device.dumpRegisters === 'function') {
    target.dumpRegisters = () => device.dumpRegisters!();
    // And the registers of it the copy cannot answer for.
    if (device.volatileReads?.length) target.volatileReads = device.volatileReads;
    if (device.pointerStays?.length) target.pointerStays = device.pointerStays;
    if (typeof device.pointerWrapsAfter === 'number') target.pointerWrapsAfter = device.pointerWrapsAfter;
  }
  return target;
}

/**
 * An I2C address as a component property holds it: the property dialog stores
 * what was typed ("0x27", "39"), a project file may carry the number. The
 * part reads it to place its model, and the store to file the worker record
 * of the same part before the board starts: one parser, so the two agree.
 */
export function parseI2cAddress(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'number' && !isNaN(raw)) return raw & 0x7f;
  const s = String(raw).trim();
  if (!s) return fallback;
  const parsed = s.toLowerCase().startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10);
  return isNaN(parsed) ? fallback : parsed & 0x7f;
}

/** What a QEMU worker needs to build its own copy of the part. */
export interface I2cPartWorkerRecord {
  /** Worker model name ('bmp280', 'ssd1306', ...). */
  type: string;
  /** Record fields besides the address and the identity. */
  props?: Record<string, unknown>;
  /**
   * The worker's copy only ACKs and echoes what the guest wrote, and the part
   * in the tab draws from those bytes (a display, an expander). Called with
   * every write phase the worker echoes for this part.
   */
  echo?: (data: number[]) => void;
}

export interface I2cPartOptions {
  simulator: unknown;
  /** Canvas component id: the part's identity on the bus and in the worker. */
  componentId: string | undefined;
  device: I2CDevice;
  /** The part's own names for its bus pins. */
  pins?: { scl: string; sda: string };
  worker?: I2cPartWorkerRecord;
}

export interface I2cPartHandle {
  /**
   * True when the guest is answered by the worker's copy of the part. What
   * the chip does to the board besides answering the bus (an interrupt pin)
   * is then the worker's to do, next to the guest, and not this tab's.
   */
  readonly remote: boolean;
  /** Forward live values to the worker's copy (a no-op in the tab). */
  updateWorker(values: Record<string, unknown>): void;
  /**
   * Say something about the part's own state in the monitor of the board
   * whose bus it is on, down the channel the bus diagnostics take. The part
   * decides when: nothing here remembers what was already said.
   */
  report(code: BusDiagnosticCode, message: string): void;
  dispose(): void;
}

/**
 * The worker's key for a part's record. One per component and stable for the
 * page, so two parts at one address are two records, and a part that attaches
 * again (every Run) lands on its own record. Same slot range as the custom
 * chips, which is above every GPIO and every 200 + address the old records used.
 */
export function i2cPartWorkerPin(componentId: string): number {
  return chipVirtualPin(componentId);
}

/**
 * Whether the board runs its firmware in a backend worker, which answers every
 * I2C event from its own copy of each part. An in-browser engine answers from
 * the fabric, and a record there would only put a second responder on the
 * address: the ESP32 engines file one as a stub that ACKs whatever the wiring
 * says. AVR, RP2040 and the rest carry a registerSensor that declines.
 */
function workerHosted(sim: { registerSensor?: unknown } | null): boolean {
  return !!sim && typeof sim.registerSensor === 'function' && hostsChipsInWorker(sim);
}

export function attachI2cPart(opts: I2cPartOptions): I2cPartHandle {
  const { device, worker } = opts;
  const sim = opts.simulator as {
    registerSensor?: (type: string, pin: number, props: Record<string, unknown>) => unknown;
    updateSensor?: (pin: number, props: Record<string, unknown>) => void;
    unregisterSensor?: (pin: number) => void;
    addI2CTransactionListener?: (addr: number, fn: (data: number[]) => void, owner?: string) => void;
    removeI2CTransactionListener?: (addr: number, owner?: string) => void;
  } | null;
  const owner = opts.componentId ?? '';
  const address = device.address & 0x7f;

  const bus = owner
    ? attachI2cTarget(
        {
          owner,
          componentId: owner,
          pins: opts.pins ?? { scl: 'SCL', sda: 'SDA' },
          addresses: [address],
          // On a board whose guest runs in a QEMU worker, the worker's copy of
          // the part answers the guest; the fabric reports a part only when the
          // worker has no model of it.
          remoteModel: worker?.type,
        },
        i2cTargetOf(device),
      )
    : null;

  let workerPin: number | null = null;
  // Whether a worker took the record: AVR, RP2040 and the rest answer
  // registerSensor with false, and the Pi shim does for anything but a line
  // sensor, so the part is answered here and its INT pad is this tab's.
  let accepted = false;
  // The engine runs a copy of its own next to the guest (an overlay's engine
  // worker), and this one stays on the fabric: the record is filed, the part
  // is still answered here (`remote` stays false).
  const mirrored = !!worker && !!owner && !workerHosted(sim) && hostsI2cModel(sim, worker.type);
  if (worker && owner && (workerHosted(sim) || mirrored)) {
    workerPin = i2cPartWorkerPin(owner);
    // `owner` is how the worker finds this record in the bus map the tab
    // sends, which says which controller the part's SDA is on.
    accepted =
      sim!.registerSensor!(worker.type, workerPin, {
        ...(worker.props ?? {}),
        addr: address,
        owner,
      }) !== false;
    // Under its own id: the echo names the record it came from, so two parts
    // at one address each draw their own stream.
    if (worker.echo) sim!.addI2CTransactionListener?.(address, worker.echo, owner);
  }

  return {
    remote: workerPin !== null && accepted && !mirrored,
    updateWorker: (values) => {
      if (workerPin !== null) sim!.updateSensor?.(workerPin, values);
    },
    report: (code, message) => {
      if (owner) busRegistry.reportI2cTarget(owner, code, message);
    },
    dispose: () => {
      bus?.dispose();
      if (workerPin === null) return;
      try {
        sim!.unregisterSensor?.(workerPin);
        if (worker?.echo) sim!.removeI2CTransactionListener?.(address, owner);
      } catch {
        /* the bridge is gone with its board */
      }
      workerPin = null;
    },
  };
}
