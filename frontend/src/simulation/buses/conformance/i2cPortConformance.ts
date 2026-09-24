/**
 * I2C controller-port conformance suite (project board-buses-2026-09, F5;
 * TESTS.md layer 2). The I2C twin of spiPortConformance.ts.
 *
 * ONE suite that every engine adapter's I2C ports must pass, run against the
 * REAL engine with a guest that performs real I2C transactions (a compiled
 * firmware fixture, or the engine's own I2C registers written the way the
 * core's Wire driver writes them). The suite owns the expectations; each
 * engine only supplies a rig that knows how to make its guest talk and how to
 * report what the guest saw.
 *
 * Not a *.test.ts: an engine's test file calls defineI2cPortConformance() with
 * its rig factory.
 */

import { describe, it, expect } from 'vitest';
import type { EngineBinding, I2cControllerPort, I2cTransactionHandler } from '../types';

/**
 * One Wire-style exchange the guest performs:
 *   beginTransmission(address); write(...write); endTransmission(read === 0);
 *   then, when read > 0, requestFrom(address, read) (a repeated START when
 *   `write` is not empty, since endTransmission(false) kept the bus).
 * A write-only exchange (read 0) ends with STOP.
 */
export interface I2cGuestTransaction {
  unit: number;
  address: number;
  write: number[];
  read: number;
}

/**
 * What the guest observed, the way Wire reports it:
 *  - status: endTransmission()'s result: 0 success, 2 NACK on the address,
 *    3 NACK on a data byte (4 other). For a read-only exchange (write empty),
 *    0 when requestFrom got its bytes and 2 when the address was NACKed.
 *  - read: the bytes the guest received (empty after an address NACK).
 */
export interface I2cGuestResult {
  status: number;
  read: number[];
}

/** What an engine test supplies. Every method drives the REAL engine. */
export interface I2cConformanceRig {
  /** Controller units the SoC has (every one must be exercised). */
  units: number[];
  /** The simulator's binding (getBusBinding()). Called again after rebuilds. */
  binding(): EngineBinding;
  /** Make the guest run these exchanges in order and report what it saw. */
  run(transactions: I2cGuestTransaction[]): Promise<I2cGuestResult[]>;
  /** The MCU reset path the product uses for the Reset button. */
  reset(): Promise<void>;
  /** The product's Stop then Run, WITHOUT recompiling. */
  stopRun(): Promise<void>;
  /** Load the firmware again (a recompile of the same sketch). */
  reload(): Promise<void>;
  /** Board pins the controller is expected to be routed to while the guest runs. */
  expectedRouting?(unit: number): { sda?: number; scl?: number };
  /** Watch GPIO edges the engine reports on a pin (to prove no echo on routed pads). */
  onPinEdge?(pin: number, cb: () => void): () => void;
  /** Free the engine. */
  dispose?(): void;
}

export interface I2cConformanceOptions {
  /** Engines whose routing is fixed and reported as 'static'. */
  staticRouting?: boolean;
}

/**
 * A target that answers a known function of where it is in the transaction,
 * and logs every call. Reads depend on the address, the position since the
 * last START and a seed, so a read served by the wrong target, a byte shifted
 * by one, or a read taken twice cannot match by accident.
 */
export class ProbeTarget {
  log: string[] = [];
  heard: number[] = [];
  reads = 0;
  starts = 0;
  stops = 0;
  /** A data byte equal to this is NACKed (to test data-NACK propagation). */
  nackByte: number | null = null;
  private k = 0;
  private addr = -1;
  readonly addresses: number[];
  readonly seed: number;
  constructor(addresses: number[], seed = 0x3c) {
    this.addresses = addresses;
    this.seed = seed;
  }
  start(address: number, read: boolean): boolean {
    this.starts++;
    this.k = 0;
    this.addr = address;
    this.log.push(`S${read ? 'r' : 'w'}${address.toString(16)}`);
    return this.addresses.includes(address);
  }
  write(byte: number): boolean {
    this.heard.push(byte & 0xff);
    this.log.push(`W${byte.toString(16)}`);
    return byte !== this.nackByte;
  }
  read(): number {
    this.reads++;
    this.log.push('R');
    return ProbeTarget.value(this.seed, this.addr, this.k++);
  }
  stop(): void {
    this.stops++;
    this.log.push('P');
  }
  static value(seed: number, address: number, k: number): number {
    return (seed ^ (address * 5) ^ (k * 29 + 7)) & 0xff;
  }
  static expected(seed: number, address: number, n: number): number[] {
    return Array.from({ length: n }, (_, k) => ProbeTarget.value(seed, address, k));
  }
}

/**
 * Bind probes on controller `unit` directly at the port, addressed the way the
 * fabric addresses them. Deliberately independent of the registry, so an
 * engine can be certified before any part moves over.
 */
export function bindProbes(
  binding: EngineBinding,
  unit: number,
  probes: ProbeTarget[],
): { port: I2cControllerPort; release: () => void } {
  const port = (binding.i2c ?? []).find((p) => p.unit === unit);
  if (!port) throw new Error(`engine exposes no I2C controller with unit ${unit}`);
  let active: ProbeTarget | null = null;
  let reading = false;
  const handler: I2cTransactionHandler = {
    start(address, read) {
      active = null;
      reading = read;
      const t = probes.find((p) => p.addresses.includes(address));
      if (t && t.start(address, read)) active = t;
      return active !== null;
    },
    write(byte) {
      return active !== null && !reading ? active.write(byte) : false;
    },
    read() {
      return active !== null && reading ? active.read() : 0xff;
    },
    stop() {
      active?.stop();
      active = null;
    },
  };
  port.setTransactionHandler(handler);
  return { port, release: () => port.setTransactionHandler(null) };
}

const PATTERN = [0x00, 0xff, 0x5a, 0xa5, 0x01, 0x80];
const ADDR = 0x42;
const OTHER = 0x29;

export function defineI2cPortConformance(
  title: string,
  makeRig: () => Promise<I2cConformanceRig | null>,
  opts: I2cConformanceOptions = {},
): void {
  describe(`I2C controller port conformance: ${title}`, () => {
    const withRig = (name: string, body: (rig: I2cConformanceRig) => Promise<void>) =>
      it(name, async () => {
        const rig = await makeRig();
        if (!rig) return; // engine not installed here: the rig factory says so
        try {
          await body(rig);
        } finally {
          rig.dispose?.();
        }
      });

    withRig('write then read: the target hears the bytes, the guest reads what it answered', async (rig) => {
      for (const unit of rig.units) {
        const probe = new ProbeTarget([ADDR]);
        const { release } = bindProbes(rig.binding(), unit, [probe]);
        const [w, r] = await rig.run([
          { unit, address: ADDR, write: PATTERN, read: 0 },
          { unit, address: ADDR, write: [0x10], read: 4 },
        ]);
        release();
        expect(w.status, `unit ${unit}: write status`).toBe(0);
        expect(probe.heard, `unit ${unit}: bytes heard`).toEqual([...PATTERN, 0x10]);
        expect(r.status, `unit ${unit}: read status`).toBe(0);
        expect(r.read, `unit ${unit}: bytes the guest read`).toEqual(ProbeTarget.expected(probe.seed, ADDR, 4));
      }
    });

    withRig('an address nobody has is NACKed and reaches no target', async (rig) => {
      const unit = rig.units[0];
      const probe = new ProbeTarget([ADDR]);
      const { release } = bindProbes(rig.binding(), unit, [probe]);
      const [w, r] = await rig.run([
        { unit, address: OTHER, write: [1, 2], read: 0 },
        { unit, address: OTHER, write: [], read: 2 },
      ]);
      release();
      expect(w.status).toBe(2);
      expect(r.status).toBe(2);
      expect(r.read).toEqual([]);
      expect(probe.heard).toEqual([]);
      expect(probe.reads).toBe(0);
    });

    withRig('a NACKed data byte reaches the guest and ends the write there', async (rig) => {
      const unit = rig.units[0];
      const probe = new ProbeTarget([ADDR]);
      probe.nackByte = 0x5a;
      const { release } = bindProbes(rig.binding(), unit, [probe]);
      const [w] = await rig.run([{ unit, address: ADDR, write: PATTERN, read: 0 }]);
      release();
      expect(w.status).toBe(3);
      // The byte that was NACKed was heard; nothing after it was sent.
      expect(probe.heard).toEqual(PATTERN.slice(0, PATTERN.indexOf(0x5a) + 1));
    });

    withRig('exactly one handler call per event: starts, bytes and stops are not lost or doubled', async (rig) => {
      const unit = rig.units[0];
      const probe = new ProbeTarget([ADDR]);
      const { release } = bindProbes(rig.binding(), unit, [probe]);
      const bytes = Array.from({ length: 24 }, (_, i) => (i * 37 + 1) & 0xff);
      const [w, r] = await rig.run([
        { unit, address: ADDR, write: bytes, read: 0 },
        { unit, address: ADDR, write: [], read: 16 },
      ]);
      release();
      expect(w.status).toBe(0);
      expect(probe.heard).toEqual(bytes);
      expect(probe.reads, 'one read() per byte the guest received').toBe(16);
      expect(r.read).toEqual(ProbeTarget.expected(probe.seed, ADDR, 16));
      expect(probe.starts).toBe(2);
      expect(probe.stops).toBe(2);
    });

    withRig('reads come from the addressed target, not from whichever answered last', async (rig) => {
      const unit = rig.units[0];
      const a = new ProbeTarget([ADDR], 0x11);
      const b = new ProbeTarget([OTHER], 0x77);
      const { release } = bindProbes(rig.binding(), unit, [a, b]);
      const [ra, rb, ra2] = await rig.run([
        { unit, address: ADDR, write: [], read: 3 },
        { unit, address: OTHER, write: [], read: 3 },
        { unit, address: ADDR, write: [0x00], read: 2 },
      ]);
      release();
      expect(ra.read).toEqual(ProbeTarget.expected(0x11, ADDR, 3));
      expect(rb.read).toEqual(ProbeTarget.expected(0x77, OTHER, 3));
      expect(ra2.read).toEqual(ProbeTarget.expected(0x11, ADDR, 2));
      expect(b.heard).toEqual([]);
    });

    withRig('one transaction handler: installing another replaces the first', async (rig) => {
      const unit = rig.units[0];
      const first = new ProbeTarget([ADDR]);
      const second = new ProbeTarget([ADDR]);
      bindProbes(rig.binding(), unit, [first]);
      const { release } = bindProbes(rig.binding(), unit, [second]);
      await rig.run([{ unit, address: ADDR, write: [0x99], read: 0 }]);
      release();
      expect(first.heard).toEqual([]);
      expect(second.heard).toEqual([0x99]);
    });

    withRig('unbound: with no handler at all the guest completes and reads an address NACK', async (rig) => {
      const unit = rig.units[0];
      (rig.binding().i2c ?? []).find((p) => p.unit === unit)!.setTransactionHandler(null);
      const [w, r] = await rig.run([
        { unit, address: ADDR, write: [1], read: 0 },
        { unit, address: ADDR, write: [], read: 1 },
      ]);
      expect(w.status).toBe(2);
      expect(r.read).toEqual([]);
    });

    const survives = (what: string, step: (rig: I2cConformanceRig) => Promise<void>) =>
      withRig(`identity: the same port keeps working after ${what}`, async (rig) => {
        const unit = rig.units[0];
        const portBefore = (rig.binding().i2c ?? []).find((p) => p.unit === unit)!;
        const probe = new ProbeTarget([ADDR]);
        const { release } = bindProbes(rig.binding(), unit, [probe]);
        await rig.run([{ unit, address: ADDR, write: [0x11, 0x22], read: 0 }]);
        expect(probe.heard).toEqual([0x11, 0x22]);
        await step(rig);
        const portAfter = (rig.binding().i2c ?? []).find((p) => p.unit === unit)!;
        expect(portAfter, 'the port object must survive').toBe(portBefore);
        // The handler bound BEFORE must still be the one called.
        const [w, r] = await rig.run([
          { unit, address: ADDR, write: [0x33], read: 0 },
          { unit, address: ADDR, write: [], read: 2 },
        ]);
        release();
        expect(w.status).toBe(0);
        expect(probe.heard).toEqual([0x11, 0x22, 0x33]);
        expect(r.read).toEqual(ProbeTarget.expected(probe.seed, ADDR, 2));
      });
    survives('an MCU reset', (rig) => rig.reset());
    survives('Stop then Run without recompiling', (rig) => rig.stopRun());
    survives('a firmware reload', (rig) => rig.reload());

    withRig('routing: the port reports where its signals really are', async (rig) => {
      for (const unit of rig.units) {
        const port = (rig.binding().i2c ?? []).find((p) => p.unit === unit)!;
        await rig.run([{ unit, address: ADDR, write: [0x00], read: 0 }]);
        const r = port.routing();
        if (opts.staticRouting) {
          expect(r).toBe('static');
          continue;
        }
        const want = rig.expectedRouting?.(unit);
        if (!want) continue;
        expect(r).not.toBe('static');
        if (r !== 'static') {
          if (want.sda !== undefined) expect(r.sda, `unit ${unit} sda`).toBe(want.sda);
          if (want.scl !== undefined) expect(r.scl, `unit ${unit} scl`).toBe(want.scl);
        }
      }
    });

    withRig('no echo: pads routed to the controller produce no GPIO edges', async (rig) => {
      if (!rig.onPinEdge) return;
      const unit = rig.units[0];
      const port = (rig.binding().i2c ?? []).find((p) => p.unit === unit)!;
      const probe = new ProbeTarget([ADDR]);
      const { release } = bindProbes(rig.binding(), unit, [probe]);
      await rig.run([{ unit, address: ADDR, write: [0x00], read: 0 }]);
      const r = port.routing();
      const pins = r === 'static' ? rig.expectedRouting?.(unit) : r;
      const watched = [pins?.sda, pins?.scl].filter((p): p is number => p !== undefined);
      let edges = 0;
      const offs = watched.map((p) => rig.onPinEdge!(p, () => edges++));
      await rig.run([{ unit, address: ADDR, write: PATTERN, read: 2 }]);
      for (const off of offs) off();
      release();
      // The decoder would otherwise see the same transaction a second time.
      expect(edges).toBe(0);
    });
  });
}
