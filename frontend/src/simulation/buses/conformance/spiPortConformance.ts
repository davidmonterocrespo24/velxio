/**
 * Controller-port conformance suite (project board-buses-2026-09, TESTS.md
 * layer 2).
 *
 * ONE suite that every engine adapter must pass, run against the REAL engine
 * with a guest that clocks real SPI transactions (a compiled firmware fixture,
 * or the engine's own SPI registers written the way the core's driver writes
 * them). The suite owns the expectations; each engine only supplies a rig that
 * knows how to make its guest talk.
 *
 * Not a *.test.ts: an engine's test file calls defineSpiPortConformance() with
 * its rig factory.
 */

import { describe, it, expect } from 'vitest';
import type { EngineBinding, SpiControllerPort, SpiDevice } from '../types';

/** One SPI transaction the guest performs: CS low, bytes out, CS high. */
export interface GuestTransaction {
  unit: number;
  /** GPIO the guest drives as chip select around the bytes (active low). */
  csPin: number;
  bytes: number[];
}

/** What an engine test supplies. Every method drives the REAL engine. */
export interface SpiConformanceRig {
  /** Controller units the SoC has (every one must be exercised). */
  units: number[];
  /** A GPIO the guest can use as a chip select for `unit`. */
  csPinFor(unit: number): number;
  /** The simulator's binding (getBusBinding()). Called again after rebuilds. */
  binding(): EngineBinding;
  /**
   * Make the guest run these transactions in order and return, per
   * transaction, the bytes the guest READ back (its received MISO).
   */
  run(transactions: GuestTransaction[]): Promise<number[][]>;
  /** The MCU reset path the product uses for the Reset button. */
  reset(): Promise<void>;
  /** The product's Stop then Run, WITHOUT recompiling. */
  stopRun(): Promise<void>;
  /** Load the firmware again (a recompile of the same sketch). */
  reload(): Promise<void>;
  /** Board pins the controller is expected to be routed to while the guest runs. */
  expectedRouting?(unit: number): { sck?: number; mosi?: number; miso?: number };
  /** Watch GPIO edges the engine reports on a pin (to prove no echo on routed pads). */
  onPinEdge?(pin: number, cb: () => void): () => void;
  /** Free the engine. */
  dispose?(): void;
}

export interface SpiConformanceOptions {
  /** Skip the block-path case for engines that clock byte by byte only. */
  hasBlockPath?: boolean;
  /** Engines whose routing is fixed and reported as 'static'. */
  staticRouting?: boolean;
}

/** A device that answers a known function of what it hears, and counts frames. */
export class ProbeDevice implements SpiDevice {
  heard: number[] = [];
  frames = 0;
  selects = 0;
  private k = 0;
  select(): void {
    this.selects++;
    this.k = 0;
  }
  transfer(mosi: number): number {
    this.frames++;
    this.heard.push(mosi & 0xff);
    // Depends on position within the transaction AND on the byte, so a stream
    // shifted by one (two answers per frame, or none) cannot match by accident.
    return (mosi ^ 0xa5 ^ (this.k++ * 7)) & 0xff;
  }
  static expected(bytes: number[]): number[] {
    return bytes.map((b, i) => (b ^ 0xa5 ^ (i * 7)) & 0xff);
  }
}

/**
 * Bind a probe on controller `unit` directly at the port, the way the fabric
 * does, with CS tracked on `csPin`. Returns the probe and an unbind function.
 * Deliberately independent of the registry so an engine can be certified
 * before any part moves over.
 */
export function bindProbe(
  binding: EngineBinding,
  unit: number,
  csPin: number,
): { probe: ProbeDevice; port: SpiControllerPort; release: () => void } {
  const port = binding.spi.find((p) => p.unit === unit);
  if (!port) throw new Error(`engine exposes no SPI controller with unit ${unit}`);
  const probe = new ProbeDevice();
  let selected = false;
  const sync = () => {
    const lvl = binding.pins.peekPinState(csPin);
    const now = lvl === false;
    if (now && !selected) probe.select();
    selected = now;
  };
  const off = binding.pins.onPinChange(csPin, sync);
  sync();
  port.setFrameHandler((mosi) => (selected ? probe.transfer(mosi) : 0xff));
  return {
    probe,
    port,
    release: () => {
      off();
      port.setFrameHandler(null);
    },
  };
}

const PATTERN = [0x00, 0xff, 0x5a, 0xa5, 0x01, 0x80, 0x3c, 0xc3];

export function defineSpiPortConformance(
  title: string,
  makeRig: () => Promise<SpiConformanceRig | null>,
  opts: SpiConformanceOptions = {},
): void {
  describe(`SPI controller port conformance: ${title}`, () => {
    const withRig = (name: string, body: (rig: SpiConformanceRig) => Promise<void>) =>
      it(name, async () => {
        const rig = await makeRig();
        if (!rig) return; // engine not installed here: the rig factory says so
        try {
          await body(rig);
        } finally {
          rig.dispose?.();
        }
      });

    withRig('echo: the guest reads, for THAT frame, what the selected device answered', async (rig) => {
      for (const unit of rig.units) {
        const { probe, release } = bindProbe(rig.binding(), unit, rig.csPinFor(unit));
        const [got] = await rig.run([{ unit, csPin: rig.csPinFor(unit), bytes: PATTERN }]);
        release();
        expect(probe.heard, `unit ${unit}: bytes heard`).toEqual(PATTERN);
        expect(got, `unit ${unit}: bytes the guest read`).toEqual(ProbeDevice.expected(PATTERN));
      }
    });

    withRig('exactly one answer per frame: no lost and no extra frames', async (rig) => {
      const unit = rig.units[0];
      const bytes = Array.from({ length: 40 }, (_, i) => (i * 29) & 0xff);
      const { probe, release } = bindProbe(rig.binding(), unit, rig.csPinFor(unit));
      const [got] = await rig.run([{ unit, csPin: rig.csPinFor(unit), bytes }]);
      release();
      expect(probe.frames).toBe(bytes.length);
      expect(got).toEqual(ProbeDevice.expected(bytes));
    });

    withRig('idle: with no device answering, the guest reads the idle level 0xFF', async (rig) => {
      const unit = rig.units[0];
      const port = rig.binding().spi.find((p) => p.unit === unit)!;
      port.setFrameHandler(() => 0xff);
      const [got] = await rig.run([{ unit, csPin: rig.csPinFor(unit), bytes: PATTERN }]);
      port.setFrameHandler(null);
      expect(got).toEqual(PATTERN.map(() => 0xff));
    });

    withRig('unbound: with no frame handler at all the transfer completes and reads 0xFF', async (rig) => {
      const unit = rig.units[0];
      rig.binding().spi.find((p) => p.unit === unit)!.setFrameHandler(null);
      const [got] = await rig.run([{ unit, csPin: rig.csPinFor(unit), bytes: [1, 2, 3] }]);
      expect(got).toEqual([0xff, 0xff, 0xff]);
    });

    const survives = (what: string, step: (rig: SpiConformanceRig) => Promise<void>) =>
      withRig(`identity: the same port keeps working after ${what}`, async (rig) => {
        const unit = rig.units[0];
        const portBefore = rig.binding().spi.find((p) => p.unit === unit)!;
        const first = bindProbe(rig.binding(), unit, rig.csPinFor(unit));
        await rig.run([{ unit, csPin: rig.csPinFor(unit), bytes: [0x11, 0x22] }]);
        expect(first.probe.heard).toEqual([0x11, 0x22]);
        await step(rig);
        const portAfter = rig.binding().spi.find((p) => p.unit === unit)!;
        expect(portAfter, 'the port object must survive').toBe(portBefore);
        // The handler bound BEFORE must still be the one called.
        const [got] = await rig.run([{ unit, csPin: rig.csPinFor(unit), bytes: [0x33, 0x44] }]);
        first.release();
        expect(first.probe.heard).toEqual([0x11, 0x22, 0x33, 0x44]);
        expect(got).toEqual(ProbeDevice.expected([0x33, 0x44]));
      });
    survives('an MCU reset', (rig) => rig.reset());
    survives('Stop then Run without recompiling', (rig) => rig.stopRun());
    survives('a firmware reload', (rig) => rig.reload());

    withRig('routing: the port reports where its signals really are', async (rig) => {
      for (const unit of rig.units) {
        const port = rig.binding().spi.find((p) => p.unit === unit)!;
        await rig.run([{ unit, csPin: rig.csPinFor(unit), bytes: [0x00] }]);
        const r = port.routing();
        if (opts.staticRouting) {
          expect(r).toBe('static');
          continue;
        }
        const want = rig.expectedRouting?.(unit);
        if (!want) continue;
        expect(r).not.toBe('static');
        if (r !== 'static') {
          if (want.sck !== undefined) expect(r.sck, `unit ${unit} sck`).toBe(want.sck);
          if (want.mosi !== undefined) expect(r.mosi, `unit ${unit} mosi`).toBe(want.mosi);
          if (want.miso !== undefined) expect(r.miso, `unit ${unit} miso`).toBe(want.miso);
        }
      }
    });

    withRig('no echo: a pad routed to the controller produces no GPIO edges', async (rig) => {
      if (!rig.onPinEdge) return;
      const unit = rig.units[0];
      const port = rig.binding().spi.find((p) => p.unit === unit)!;
      await rig.run([{ unit, csPin: rig.csPinFor(unit), bytes: [0x00] }]);
      const r = port.routing();
      const sck = r === 'static' ? rig.expectedRouting?.(unit)?.sck : r.sck;
      if (sck === undefined) return;
      let edges = 0;
      const off = rig.onPinEdge(sck, () => edges++);
      await rig.run([{ unit, csPin: rig.csPinFor(unit), bytes: PATTERN }]);
      off();
      expect(edges).toBe(0);
    });

    withRig('chip select written just before the bytes is visible to the first byte', async (rig) => {
      const unit = rig.units[0];
      const { probe, release } = bindProbe(rig.binding(), unit, rig.csPinFor(unit));
      await rig.run([
        { unit, csPin: rig.csPinFor(unit), bytes: [0xde] },
        { unit, csPin: rig.csPinFor(unit), bytes: [0xad] },
      ]);
      release();
      expect(probe.heard).toEqual([0xde, 0xad]);
      expect(probe.selects).toBe(2);
    });

    if (opts.hasBlockPath) {
      withRig('block path: a buffered transaction gives exactly the per-byte result', async (rig) => {
        const unit = rig.units[0];
        const bytes = Array.from({ length: 64 }, (_, i) => (i * 13 + 7) & 0xff);
        const { probe, release } = bindProbe(rig.binding(), unit, rig.csPinFor(unit));
        const [got] = await rig.run([{ unit, csPin: rig.csPinFor(unit), bytes }]);
        release();
        expect(probe.heard).toEqual(bytes);
        expect(got).toEqual(ProbeDevice.expected(bytes));
      });
    }
  });
}
