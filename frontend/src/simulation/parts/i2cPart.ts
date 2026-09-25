/**
 * An I2C part on the bus fabric (project board-buses-2026-09, F5).
 *
 * A part is on an I2C bus because its SDA and SCL are wired to one, not
 * because it was handed a simulator: it registers once with its own pin names,
 * and the fabric puts it on the bus of its SDA net, keeps it there across every
 * reset of the SoC, moves it when a wire moves, and takes it off by identity.
 * That is what ends the three ways the old registration went wrong:
 *
 *   - `addI2CDevice(dev)` put every part on the board's bus 0, so a part on
 *     Wire1 (or on the XIAO RP2040, whose Wire is I2C1) never answered, and a
 *     part wired to nothing answered anyway;
 *   - `removeDevice(address)` took off whichever device held that address,
 *     the part's replacement included;
 *   - the worker record of a QEMU board was keyed by 200 + address, so two
 *     parts at one address were one record, and deleting one deleted both.
 *
 * The part keeps its register model in the `I2CDevice` shape it always had;
 * this module adapts it to the fabric's target contract.
 */

import { attachI2cTarget, type I2cTarget } from '../buses';
import type { I2CDevice } from '../I2CBusManager';
import { chipVirtualPin } from '../customChips/chipVirtualPin';
import { hostsChipsInWorker } from '../customChips/simulatorBridges';

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
 */
export function i2cTargetOf(device: I2CDevice): I2cTarget & { dumpRegisters?: () => Uint8Array } {
  let open = false;
  const target: I2cTarget & { dumpRegisters?: () => Uint8Array } = {
    start: (_address, read) => {
      if (open && !read) device.stop?.();
      open = true;
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
      if (!open) return;
      open = false;
      device.stop?.();
    },
  };
  // A board whose guest reads the bus from somewhere else (the Pi relay)
  // answers a register file from a copy instead of a round trip per byte.
  if (typeof device.dumpRegisters === 'function') {
    target.dumpRegisters = () => device.dumpRegisters!();
  }
  return target;
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
   * every write phase the worker echoes for this address.
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
  /** Forward live values to the worker's copy (a no-op in the tab). */
  updateWorker(values: Record<string, unknown>): void;
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
    addI2CTransactionListener?: (addr: number, fn: (data: number[]) => void) => void;
    removeI2CTransactionListener?: (addr: number) => void;
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
  if (worker && owner && workerHosted(sim)) {
    workerPin = i2cPartWorkerPin(owner);
    // `owner` is how the worker finds this record in the bus map the tab
    // sends, which says which controller the part's SDA is on.
    sim!.registerSensor!(worker.type, workerPin, { ...(worker.props ?? {}), addr: address, owner });
    if (worker.echo) sim!.addI2CTransactionListener?.(address, worker.echo);
  }

  return {
    updateWorker: (values) => {
      if (workerPin !== null) sim!.updateSensor?.(workerPin, values);
    },
    dispose: () => {
      bus?.dispose();
      if (workerPin === null) return;
      try {
        sim!.unregisterSensor?.(workerPin);
        if (worker?.echo) sim!.removeI2CTransactionListener?.(address);
      } catch {
        /* the bridge is gone with its board */
      }
      workerPin = null;
    },
  };
}
