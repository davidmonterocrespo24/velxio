/**
 * The hardware-bus synthesizers of the oscilloscope (simulation/busScope.ts,
 * velxio/velxio-prod#160), driven by hand: the cases the firmware specs
 * (scope-hardware-i2c-spi.test.ts) do not reach.
 *
 *  - SPI modes 1 and 2 and LSB-first frames;
 *  - an engine whose bus completes at once (rp2040js): the steps are laid out
 *    one after the other from a bus-busy cursor, and once it is more than
 *    MAX_LEAD_MS ahead of the clock a transfer is left out whole;
 *  - nobody looking: nothing is built or handed over, and the levels are
 *    drawn in full when someone looks again.
 */
import { describe, it, expect } from 'vitest';
import {
  I2cScopeSynth,
  SpiScopeSynth,
  MAX_LEAD_MS,
  FLUSH_EDGES,
  type ScopeRun,
  type ScopeSink,
} from '../simulation/busScope';
import type { SpiControllerConfig, SpiMode } from '../simulation/buses/types';

interface ScopeEdge {
  pin: number;
  state: boolean;
  timeMs: number;
}

/** A batch's runs as one edge list in time order (samples at one instant keep their order). */
function merged(runs: readonly ScopeRun[]): ScopeEdge[] {
  const out = runs.flatMap((r) => r.samples.map((x) => ({ pin: r.pin, state: x.state, timeMs: x.timeMs })));
  return out.sort((a, b) => a.timeMs - b.timeMs);
}

function sinkFor(pins: number[]) {
  const edges: ScopeEdge[] = [];
  const watched = new Set(pins);
  let batches = 0;
  const sink: ScopeSink = Object.assign(
    (pin: number, state: boolean, timeMs: number) => {
      edges.push({ pin, state, timeMs });
    },
    {
      wants: (pin: number) => watched.has(pin),
      runs: (runs: readonly ScopeRun[]) => {
        batches++;
        edges.push(...merged(runs));
      },
    },
  );
  return { sink, edges, watched, batches: () => batches };
}

const SCK = 1;
const MOSI = 2;
const MISO = 3;

function spi(cfg: SpiControllerConfig, clock: { now: number }, sink: ScopeSink) {
  return new SpiScopeSynth({
    sink: () => sink,
    sck: () => SCK,
    mosi: () => MOSI,
    miso: () => MISO,
    nowMs: () => clock.now,
    config: () => cfg,
  });
}

/** MOSI and MISO read on the sampling edge of `mode`, `bits` per frame. */
function readSpi(edges: ScopeEdge[], mode: SpiMode, bits: number, lsb = false) {
  const cpol = (mode & 2) !== 0;
  const cpha = (mode & 1) !== 0;
  let sck: boolean | null = null;
  let mosi = false;
  let miso = false;
  const got: Array<{ mosi: number; miso: number }> = [];
  let k = 0;
  let o = 0;
  let i = 0;
  for (const e of edges) {
    if (e.pin === MOSI) mosi = e.state;
    else if (e.pin === MISO) miso = e.state;
    else if (e.pin === SCK) {
      const was: boolean | null = sck;
      sck = e.state;
      if (was === null || was === sck) continue;
      const leading = sck !== cpol;
      if (leading !== !cpha) continue;
      const shift = lsb ? k : bits - 1 - k;
      o |= (mosi ? 1 : 0) << shift;
      i |= (miso ? 1 : 0) << shift;
      if (++k === bits) {
        got.push({ mosi: o, miso: i });
        k = 0;
        o = 0;
        i = 0;
      }
    }
  }
  return got;
}

describe('SPI frames in every mode', () => {
  for (const mode of [0, 1, 2, 3] as const) {
    it(`mode ${mode}: SCK idles at CPOL and the data is read on the right edge`, () => {
      const { sink, edges } = sinkFor([SCK, MOSI, MISO]);
      const clock = { now: 0 };
      const synth = spi({ enabled: true, mode, bitOrder: 'msb', bits: 8, hz: 1_000_000 }, clock, sink);
      synth.frame(0xa5, 0x3c, 8);
      clock.now = 1;
      synth.frame(0x0f, 0xf0, 8);
      // Held until the engine's frame ends (or a batch's worth is drawn).
      expect(edges).toEqual([]);
      synth.flush();
      expect(readSpi(edges, mode, 8)).toEqual([
        { mosi: 0xa5, miso: 0x3c },
        { mosi: 0x0f, miso: 0xf0 },
      ]);
      // Between frames SCK is at its idle level.
      const sck = edges.filter((e) => e.pin === SCK);
      expect(sck.at(-1)!.state).toBe((mode & 2) !== 0);
      // One leading edge every 1 us within a frame.
      const cpol = (mode & 2) !== 0;
      const leading = sck.filter((e, i) => i > 0 && e.timeMs < 1 && e.state !== cpol);
      expect(leading).toHaveLength(8);
      for (let i = 1; i < 8; i++) {
        expect(leading[i]!.timeMs - leading[i - 1]!.timeMs).toBeCloseTo(0.001, 9);
      }
    });
  }

  it('an LSB-first frame and a 12-bit one', () => {
    const { sink, edges } = sinkFor([SCK, MOSI, MISO]);
    const cfg: SpiControllerConfig = { enabled: true, mode: 0, bitOrder: 'lsb', bits: 8, hz: 2_000_000 };
    const synth = spi(cfg, { now: 0 }, sink);
    synth.frame(0x01, 0x80, 8);
    synth.flush();
    expect(readSpi(edges, 0, 8, true)).toEqual([{ mosi: 0x01, miso: 0x80 }]);
    const twelve = sinkFor([SCK, MOSI, MISO]);
    const s12 = spi({ ...cfg, bitOrder: 'msb', bits: 12 }, { now: 0 }, twelve.sink);
    s12.frame(0xabc, 0x123, 12);
    s12.flush();
    expect(readSpi(twelve.edges, 0, 12)).toEqual([{ mosi: 0xabc, miso: 0x123 }]);
  });

  it('a frame the engine completes at once waits for the one before it on the wire', () => {
    const { sink, edges } = sinkFor([SCK, MOSI, MISO]);
    const clock = { now: 5 };
    const synth = spi({ enabled: true, mode: 0, bitOrder: 'msb', bits: 8, hz: 1_000_000 }, clock, sink);
    synth.frame(0xff, 0xff, 8);
    synth.frame(0x00, 0x00, 8); // same clock: queued behind the first
    synth.flush();
    const sck = edges.filter((e) => e.pin === SCK);
    for (let i = 1; i < sck.length; i++) expect(sck[i]!.timeMs).toBeGreaterThanOrEqual(sck[i - 1]!.timeMs);
    // Idle settle, two frames of 8 us: the last edge 16.5 us after the first.
    expect(sck.at(-1)!.timeMs - 5).toBeCloseTo(0.0165, 9);
  });
});

// ── I2C ─────────────────────────────────────────────────────────────────────

const SDA = 4;
const SCL = 5;

function i2c(clock: { now: number }, sink: ScopeSink, lowMs = 0.005, highMs = 0.005) {
  return new I2cScopeSynth({
    sink: () => sink,
    sda: () => SDA,
    scl: () => SCL,
    nowMs: () => clock.now,
    timing: () => ({ lowMs, highMs }),
  });
}

/** One write transaction of `n` data bytes: START, address, bytes, STOP. */
function writeTransaction(synth: I2cScopeSynth, n: number): void {
  synth.start();
  synth.address(0x3c, false, true);
  for (let k = 0; k < n; k++) synth.write(k & 0xff, true);
  synth.stop();
}

describe('I2C on an engine whose bus completes at once', () => {
  it('lays the steps out at the bus rate from the clock, one after the other', () => {
    const { sink, edges } = sinkFor([SDA, SCL]);
    const clock = { now: 10 };
    const synth = i2c(clock, sink);
    writeTransaction(synth, 2);
    synth.flush();
    // START (1 period) + 3 packets of 9 + STOP (1), 10 us each: 290 us.
    const sdaLast = edges.filter((e) => e.pin === SDA).at(-1)!;
    expect(sdaLast.state).toBe(true); // the STOP leaves the bus idle
    expect(sdaLast.timeMs - 10).toBeCloseTo(0.29 - 0.005 + 0.0025, 9);
    for (let i = 1; i < edges.length; i++) expect(edges[i]!.timeMs).toBeGreaterThanOrEqual(edges[i - 1]!.timeMs);
  });

  it(`leaves out, whole, a transaction that starts more than ${MAX_LEAD_MS} ms ahead of the clock`, () => {
    const { sink, edges } = sinkFor([SDA, SCL]);
    const clock = { now: 0 };
    const synth = i2c(clock, sink);
    // A 100-byte transaction at 100 kHz is 911 SCL periods, 9.11 ms on the
    // wire; the clock does not move, as on an engine that completes it at once.
    for (let k = 0; k < 10; k++) writeTransaction(synth, 100);
    synth.flush();
    // The sixth starts 45.55 ms ahead and is drawn; the seventh would start
    // 54.66 ms ahead, and it and the three after it are left out.
    expect(synth.skippedTransactions).toBe(4);
    const starts = (list: ScopeEdge[]) => {
      let scl = true;
      let sda = true;
      let n = 0;
      for (const e of list) {
        if (e.pin === SCL) scl = e.state;
        else {
          if (sda && !e.state && scl) n++;
          sda = e.state;
        }
      }
      return n;
    };
    expect(starts(edges)).toBe(6);
    // The bus is idle at the end of what was drawn: nothing half-drawn.
    expect(edges.filter((e) => e.pin === SDA).at(-1)!.state).toBe(true);
    expect(edges.filter((e) => e.pin === SCL).at(-1)!.state).toBe(true);
    // Once the clock catches up, the next one is drawn again.
    clock.now = 60;
    const before = edges.length;
    writeTransaction(synth, 1);
    synth.flush();
    expect(edges.length).toBeGreaterThan(before);
    expect(edges[before]!.timeMs).toBeGreaterThanOrEqual(60);
  });
});

describe('nobody looking', () => {
  it('builds and hands over nothing, and draws every level when someone looks again', () => {
    const { sink, edges, watched, batches } = sinkFor([]);
    const clock = { now: 0 };
    const synth = i2c(clock, sink);
    writeTransaction(synth, 3);
    expect(edges).toEqual([]);
    expect(batches()).toBe(0);
    // A channel on SCL appears mid-transaction: its first step draws SCL's
    // level outright, not only the changes from a level the scope never got.
    synth.start();
    synth.address(0x3c, false, true);
    watched.add(SCL);
    synth.write(0x55, true);
    synth.flush();
    const scl = edges.filter((e) => e.pin === SCL);
    expect(scl[0]).toMatchObject({ state: false });
    expect(scl.filter((e) => e.state)).toHaveLength(9);
    expect(edges.every((e) => e.pin === SCL)).toBe(true);
  });

  it('reads neither the SCL timing nor the SPI configuration for a step nobody watches', () => {
    // That lookup is all a Wire or SPI step costs a sketch whose bus is not
    // on the scope: every byte of a streaming display goes through here.
    const { sink } = sinkFor([]);
    let timingReads = 0;
    let configReads = 0;
    const synth = new I2cScopeSynth({
      sink: () => sink,
      sda: () => SDA,
      scl: () => SCL,
      nowMs: () => 0,
      timing: () => {
        timingReads++;
        return { lowMs: 0.005, highMs: 0.005 };
      },
    });
    writeTransaction(synth, 10);
    const spiSynth = new SpiScopeSynth({
      sink: () => sink,
      sck: () => SCK,
      mosi: () => MOSI,
      miso: () => MISO,
      nowMs: () => 0,
      config: () => {
        configReads++;
        return { enabled: true, mode: 0, bitOrder: 'msb', bits: 8, hz: 1_000_000 };
      },
    });
    for (let k = 0; k < 10; k++) spiSynth.frame(k, 0xff, 8);
    expect([timingReads, configReads]).toEqual([0, 0]);
  });

  it('a callback without wants watches nothing: a part in the scope slot costs no drawing', () => {
    // The RP2040 servo part puts a plain callback in its board's scope slot
    // (ComplexParts.ts) to time its own pulses. It never says which pins it
    // wants, so drawing for it drew every Wire and SPI transfer for nobody:
    // pico-oled-4pin-i2c with a servo cost 30 % more CPU, scope closed.
    const got: ScopeEdge[] = [];
    let reads = 0;
    const plain = ((pin: number, state: boolean, timeMs: number) => {
      got.push({ pin, state, timeMs });
    }) as ScopeSink;
    const synth = new I2cScopeSynth({
      sink: () => plain,
      sda: () => SDA,
      scl: () => SCL,
      nowMs: () => 0,
      timing: () => {
        reads++;
        return { lowMs: 0.005, highMs: 0.005 };
      },
    });
    writeTransaction(synth, 3);
    synth.flush();
    const spiSynth = new SpiScopeSynth({
      sink: () => plain,
      sck: () => SCK,
      mosi: () => MOSI,
      miso: () => MISO,
      nowMs: () => 0,
      config: () => {
        reads++;
        return { enabled: true, mode: 0, bitOrder: 'msb', bits: 8, hz: 1_000_000 };
      },
    });
    for (let k = 0; k < 3; k++) spiSynth.frame(k, 0xff, 8);
    spiSynth.flush();
    expect(got).toEqual([]);
    expect(reads).toBe(0);
  });

  it('a callback with wants and no runs gets every edge one by one, in time order', () => {
    const got: ScopeEdge[] = [];
    const sink: ScopeSink = Object.assign(
      (pin: number, state: boolean, timeMs: number) => {
        got.push({ pin, state, timeMs });
      },
      { wants: (pin: number) => pin === SDA || pin === SCL },
    );
    const synth = i2c({ now: 0 }, sink);
    writeTransaction(synth, 1);
    synth.flush();
    expect(got.filter((e) => e.pin === SCL && e.state)).toHaveLength(1 + 18 + 1);
    for (let i = 1; i < got.length; i++) expect(got[i]!.timeMs).toBeGreaterThanOrEqual(got[i - 1]!.timeMs);
  });
});

describe('handing the edges over', () => {
  it('I2C transactions reach the scope together when the engine\'s frame ends', () => {
    const { sink, edges, batches } = sinkFor([SDA, SCL]);
    const synth = i2c({ now: 0 }, sink);
    for (let k = 0; k < 3; k++) writeTransaction(synth, 1);
    expect(batches()).toBe(0);
    synth.flush();
    expect(batches()).toBe(1);
    expect(edges.length).toBeGreaterThan(3 * 40);
  });

  it(`a long burst goes over every ${FLUSH_EDGES} edges or so, not byte by byte`, () => {
    const { sink, edges, batches } = sinkFor([SDA, SCL]);
    const synth = i2c({ now: 0 }, sink);
    synth.start();
    synth.address(0x3c, false, true);
    for (let k = 0; k < 200; k++) synth.write(k & 0xff, true);
    synth.stop();
    synth.flush();
    expect(edges.length).toBeGreaterThan(200 * 18);
    expect(batches()).toBeLessThanOrEqual(Math.ceil(edges.length / FLUSH_EDGES) + 1);
    expect(batches()).toBeLessThan(20);
  });
});
