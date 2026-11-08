/**
 * Where the interconnect puts a sender's edges on the receiver's clock: #397's
 * timed delivery, bounded (velxio/velxio-prod#74).
 *
 * Every board in the tab runs its guest in bursts, about one frame of guest
 * time each, one board after the other. #397 places each edge on the
 * receiver's cycle clock at the sender's spacing, a burst starting at the
 * receiver's present. The review of #74's first half found three ways that
 * anchor goes wrong, for every pair of boards with a clock:
 *
 *  (C) A line that crosses the end of the sender's burst. Before the sender's
 *      next burst the receiver runs a whole frame, so the edges after the
 *      boundary, spaced from an anchor at the receiver's old present, fall
 *      where it has already run; they were moved up to its present and the
 *      line broke there (about a third of the serial lines, AVR to AVR too).
 *  (A) A link that never goes quiet for 50 ms into a receiver slower than
 *      real time. Every edge keeps the sender's spacing, the receiver uses
 *      less guest time per frame than the sender makes, and the delay grew
 *      without bound: 0.5 s, 5 s and 30 s at 1, 10 and 60 s.
 *  (B) A receiver whose clock starts over (its own reset) while the link
 *      keeps going. The edges kept the old run's anchor and were scheduled as
 *      far ahead of the new clock as the old run had lasted.
 *
 * The boards here are two clocks the interconnect sees as AVRs (16 MHz, the
 * clock and scheduler of a TimedSim), run in bursts in turn; the receiver
 * records every edge it is given with its own cycle at that moment. The real
 * firmware of both ends is in dual-arduino-software-serial-timing.test.ts
 * (AVR to AVR) and, for the in-browser ESP32 engines, in the overlay.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PinManager } from '../simulation/PinManager';
import {
  bindBoard,
  resetInterconnect,
  setInterconnectRuntime,
  updateWires,
} from '../simulation/Interconnect';
import type { Wire } from '../types/wire';

const HZ = 16_000_000;
const PER_US = HZ / 1_000_000;
const FRAME_US = 16_000;
const TX_PIN = 11;
const RX_PIN = 10;

interface Given {
  level: boolean;
  /** The receiver cycle the edge lands at. */
  at: number;
  /** The receiver's cycle when it was handed the edge. */
  now: number;
  /** The sender cycle the edge left at. */
  sent: number;
}

/** A board in the tab with a cycle clock (an AVR's, 16 MHz) and its pads. */
class Board {
  cycles = 0;
  readonly pm = new PinManager();
  /** Every edge this board was handed, scheduled or written at once (then `at` is its present). */
  readonly given: Given[] = [];
  /** The sender's cycle of the edge being delivered (set by the sender around its pin change). */
  static sending = 0;
  getCurrentCycles(): number {
    return this.cycles;
  }
  getClockHz(): number {
    return HZ;
  }
  schedulePinChange(_pin: number, level: boolean, at: number): void {
    this.given.push({ level, at, now: this.cycles, sent: Board.sending });
  }
  setPinState(_pin: number, level: boolean): void {
    this.given.push({ level, at: this.cycles, now: this.cycles, sent: Board.sending });
  }
}

function wire(id: string, a: [string, string], b: [string, string]): Wire {
  return {
    id,
    start: { componentId: a[0], pinName: a[1], x: 0, y: 0 },
    end: { componentId: b[0], pinName: b[1], x: 0, y: 0 },
    color: '#000',
  } as unknown as Wire;
}

function link(): { tx: Board; rx: Board } {
  resetInterconnect();
  const tx = new Board();
  const rx = new Board();
  const boards: Record<string, Board> = { tx, rx };
  setInterconnectRuntime({
    getBoardSimulator: (id) => boards[id],
    getBoardPinManager: (id) => boards[id]?.pm,
    getBoardBridge: () => undefined,
    getEsp32Bridge: () => undefined,
    getStm32Bridge: () => undefined,
  });
  bindBoard('tx', 'arduino-uno');
  bindBoard('rx', 'arduino-uno');
  updateWires([wire('w', ['tx', String(TX_PIN)], ['rx', String(RX_PIN)])]);
  return { tx, rx };
}

/** The edges a wave puts on the sender's pad, as [sender cycle, level], in order. */
type Wave = Array<[number, boolean]>;

/** A square wave of `hz`, from `fromUs` for `forUs` (both in the sender's microseconds). */
function square(hz: number, fromUs: number, forUs: number): Wave {
  const half = HZ / hz / 2;
  const out: Wave = [];
  let level = true;
  for (let t = fromUs * PER_US + half; t < (fromUs + forUs) * PER_US; t += half) {
    level = !level;
    out.push([Math.round(t), level]);
  }
  return out;
}

/** "PING\r\n" at 9600 baud 8N1, its start bit at `startUs`: an edge where the level changes. */
function line(startUs: number): Wave {
  const bitCycles = HZ / 9600;
  const levels: boolean[] = [];
  for (const ch of 'PING\r\n') {
    const b = ch.charCodeAt(0);
    levels.push(false);
    for (let k = 0; k < 8; k++) levels.push(((b >> k) & 1) === 1);
    levels.push(true);
  }
  const out: Wave = [];
  let last = true;
  levels.forEach((v, slot) => {
    if (v !== last) out.push([Math.round(startUs * PER_US + slot * bitCycles), v]);
    last = v;
  });
  return out;
}

/**
 * The frame loop: per frame the sender runs `senderUs` of its guest time and
 * puts the wave's edges of that burst on its pad, and the receiver runs
 * `receiverUs` of its own, in the order `order` says.
 */
function run(
  tx: Board,
  rx: Board,
  wave: Wave,
  frames: number,
  opts: { senderUs?: number; receiverUs?: number; order?: 'sender-first' | 'receiver-first' } = {},
): void {
  const senderUs = opts.senderUs ?? FRAME_US;
  const receiverUs = opts.receiverUs ?? FRAME_US;
  // The edges after where the sender stands: a burst puts out the ones up to its end, that one included.
  let next = wave.findIndex(([t]) => t > tx.cycles);
  if (next < 0) next = wave.length;
  const senderBurst = () => {
    const end = tx.cycles + senderUs * PER_US;
    while (next < wave.length && wave[next][0] <= end) {
      const [t, level] = wave[next++];
      tx.cycles = t;
      Board.sending = t;
      tx.pm.triggerPinChange(TX_PIN, level, 'mcu');
    }
    tx.cycles = end;
  };
  const receiverBurst = () => {
    rx.cycles += receiverUs * PER_US;
  };
  for (let k = 0; k < frames; k++) {
    if (opts.order === 'receiver-first') {
      receiverBurst();
      senderBurst();
    } else {
      senderBurst();
      receiverBurst();
    }
  }
}

afterEach(() => resetInterconnect());

describe('the anchor of a burst of edges on the receiver’s clock (#397, bounded for #74)', () => {
  for (const order of ['sender-first', 'receiver-first'] as const) {
    it(`(C) a line that crosses the end of the sender’s burst arrives at the spacing it was sent with (${order})`, () => {
      const { tx, rx } = link();
      // Two frames in, the line starts 2 ms before the sender's burst ends: 6.25 ms long, it crosses into the next one.
      const wave = line(3 * FRAME_US - 2_000);
      run(tx, rx, wave, 6, { order });
      expect(rx.given.map((g) => g.level)).toEqual(wave.map(([, level]) => level));
      // Each edge in the receiver's future when it was handed over, none moved up to its present.
      for (const g of rx.given) expect(g.at, 'an edge placed where the receiver had already run').toBeGreaterThan(g.now);
      // And every one of them at the sender's spacing from the first, across the boundary too.
      const at0 = rx.given[0].at;
      const sent0 = wave[0][0];
      expect(rx.given.map((g) => g.at - at0)).toEqual(wave.map(([t]) => t - sent0));
    });
  }

  it('(C) lines in every phase of the sender’s bursts arrive whole, a burst’s first edge about a frame ahead', () => {
    const { tx, rx } = link();
    // A line every 107 ms: its start walks through every phase of the 16 ms bursts.
    const wave: Wave = [];
    for (let k = 0; k < 16; k++) wave.push(...line(5_000 + k * 107_000));
    run(tx, rx, wave, 120);
    expect(rx.given).toHaveLength(wave.length);
    const perLine = wave.length / 16;
    for (let k = 0; k < 16; k++) {
      const got = rx.given.slice(k * perLine, (k + 1) * perLine);
      const sent = wave.slice(k * perLine, (k + 1) * perLine);
      expect(got.map((g) => g.at - got[0].at), `line ${k}`).toEqual(sent.map(([t]) => t - sent[0][0]));
      // A line starts within about a frame and a half of the receiver's present.
      expect((got[0].at - got[0].now) / PER_US, `line ${k}'s first edge, µs ahead`).toBeLessThanOrEqual(1.5 * FRAME_US);
    }
  });

  it('(A) a 50 Hz source that never goes quiet, into a receiver at half speed: the delay stays bounded over a minute', () => {
    const { tx, rx } = link();
    const wave = square(50, 0, 60_000_000);
    // 60 s of the sender's time; the receiver runs half the guest time per frame.
    run(tx, rx, wave, 3_750, { receiverUs: FRAME_US / 2 });
    expect(rx.given.length).toBe(wave.length);
    const aheadMs = rx.given.map((g) => (g.at - g.now) / PER_US / 1_000);
    const worst = (from: number, to: number) => Math.max(...aheadMs.slice(from, to));
    const n = aheadMs.length;
    // Never more than four frames ahead of the receiver: not 0.5 s at 1 s, 5 s at 10 s or 30 s at 60 s.
    expect(worst(0, n), 'the furthest an edge lands ahead of the receiver, ms').toBeLessThanOrEqual(64);
    expect(worst(n - 100, n), 'in the last two seconds, ms').toBeLessThanOrEqual(64);
    // The edges keep their order on the receiver, each after the one before it.
    for (let i = 1; i < n; i++) expect(rx.given[i].at, `edge ${i}`).toBeGreaterThan(rx.given[i - 1].at);
    // And the last level the receiver is given is the sender's last.
    expect(rx.given[n - 1].level).toBe(wave[wave.length - 1][1]);
  });

  it('(A) at full speed on both ends the same source keeps its exact spacing, every edge about a frame ahead', () => {
    const { tx, rx } = link();
    const wave = square(50, 0, 10_000_000);
    run(tx, rx, wave, 625);
    expect(rx.given.length).toBe(wave.length);
    const at0 = rx.given[0].at;
    expect(rx.given.map((g) => g.at - at0)).toEqual(wave.map(([t]) => t - wave[0][0]));
    for (const g of rx.given) expect((g.at - g.now) / PER_US).toBeLessThanOrEqual(3 * FRAME_US);
  });

  it('(B) a receiver whose clock starts over mid-stream (its own reset) hears the next edges within about a frame', () => {
    const { tx, rx } = link();
    const wave = square(50, 0, 12_000_000);
    run(tx, rx, wave, 625); // 10 s
    const before = rx.given.length;
    rx.cycles = 0; // the receiver's reset: a fresh CPU, its counter from 0
    run(tx, rx, wave, 60);
    const after = rx.given.slice(before);
    expect(after.length).toBeGreaterThan(50);
    for (const g of after) {
      expect((g.at - g.now) / PER_US, 'µs ahead of the restarted clock, not the old run’s 10 s').toBeLessThanOrEqual(3 * FRAME_US);
      expect(g.at).toBeGreaterThan(g.now);
    }
    // The run after the reset keeps the sender's spacing from its first edge.
    expect(after.map((g) => g.at - after[0].at)).toEqual(
      wave.slice(before, before + after.length).map(([t]) => t - wave[before][0]),
    );
  });

  it('a burst that starts while the receiver still holds the last one (it has not run since) comes after it, never before', () => {
    const { tx, rx } = link();
    // Two lines 60 ms apart (the link goes quiet in between) while the receiver does not run at all.
    const first = line(1_000);
    const second = line(61_000);
    run(tx, rx, [...first, ...second], 8, { receiverUs: 0 });
    expect(rx.given).toHaveLength(first.length + second.length);
    for (let i = 1; i < rx.given.length; i++) expect(rx.given[i].at, `edge ${i}`).toBeGreaterThan(rx.given[i - 1].at);
    // Both lines whole, and the first one's last stop bit lasts a bit time at least before the second starts.
    const one = rx.given.slice(0, first.length);
    const two = rx.given.slice(first.length);
    expect(one.map((g) => g.at - one[0].at)).toEqual(first.map(([t]) => t - first[0][0]));
    expect(two.map((g) => g.at - two[0].at)).toEqual(second.map(([t]) => t - second[0][0]));
    expect(two[0].at - one[one.length - 1].at).toBeGreaterThanOrEqual(HZ / 9600);
  });
});
