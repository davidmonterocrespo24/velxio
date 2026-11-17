/**
 * A level a wire hands a board is not handed back (velxio/velxio-prod#74).
 *
 * The interconnect schedules a sender's edges on the receiver's clock (#397),
 * a burst of them a frame into the receiver's future (#74's bounded anchor).
 * The receiver applies each one between two of its instructions and reports
 * the change of its pad, as it reports its guest's own writes: an AVR or an
 * RP2040 input takes the level through its PinManager. The wire's other
 * direction heard that report as the receiver's own and sent it back. Written
 * at once, as #397 wrote the first edge of a burst, the level travelled under
 * the interconnect's re-entrancy guard and went no further; scheduled, it lands
 * while the receiver runs, where no guard is. On a line both boards only listen
 * to (open-drain, pulled up at both ends) one pulse went back and forth for
 * ever: the review of the bounded anchor counted 247 changes in 2.5 s on two
 * real Unos (R4), where #397 alone made 8.
 *
 * The boards here are two or three clocks the interconnect sees as AVRs
 * (16 MHz, the clock and scheduler of a TimedSim) that run their guest in
 * steps of a few cycles, as an engine runs instructions: the levels a wire
 * scheduled land between steps and are reported as the pad's change
 * ('external'), the guest's own writes as its own ('mcu'). Each board's guest
 * pulls its pad low and lets it go (an open-drain pulse) when the case says so,
 * and listens otherwise. The same on real firmware is
 * dual-arduino-open-drain.test.ts.
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
const PIN = 2;

class Board {
  cycles = 0;
  readonly pm = new PinManager();
  /** Every change of the pad, as [cycle, level]. */
  readonly reports: Array<[number, boolean]> = [];
  private readonly queue: Array<{ at: number; level: boolean }> = [];
  private readonly writes: Array<{ at: number; level: boolean }> = [];

  /** `step`: the cycles of one instruction, between which a scheduled level lands; `phase`: where the steps end, past a multiple of it. */
  constructor(
    readonly id: string,
    readonly step = 4,
    readonly phase = 0,
  ) {
    // Pulled up, before any wire is in.
    this.pm.triggerPinChange(PIN, true, 'external');
    this.pm.onPinChange(PIN, (_p: number, level: boolean) => this.reports.push([this.cycles, level]));
  }
  getCurrentCycles(): number {
    return this.cycles;
  }
  getClockHz(): number {
    return HZ;
  }
  schedulePinChange(_pin: number, level: boolean, at: number): void {
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].at > at) i--;
    this.queue.splice(i, 0, { at, level });
  }
  setPinState(_pin: number, level: boolean): void {
    this.pm.triggerPinChange(PIN, level, 'external');
  }
  /** The guest pulls its pad low at `fromUs` (of its own time) for `forUs`, then lets it go. */
  pulse(fromUs: number, forUs: number): void {
    this.writes.push({ at: fromUs * PER_US, level: false }, { at: (fromUs + forUs) * PER_US, level: true });
    this.writes.sort((a, b) => a.at - b.at);
  }
  /** Its own reset: the clock from 0, and the levels it was handed with its old run. */
  reset(): void {
    this.cycles = 0;
    this.queue.length = 0;
  }
  /** Run the guest to `until`: its writes and the wire's levels, each in the step that crosses it. */
  runTo(until: number): void {
    for (;;) {
      const next = Math.min(this.writes[0]?.at ?? Infinity, this.queue[0]?.at ?? Infinity);
      if (next > until) break;
      this.cycles = Math.max(this.cycles, Math.ceil((next - this.phase) / this.step) * this.step + this.phase);
      while (this.writes.length > 0 && this.writes[0].at <= this.cycles) {
        this.pm.triggerPinChange(PIN, this.writes.shift()!.level, 'mcu');
      }
      while (this.queue.length > 0 && this.queue[0].at <= this.cycles) this.setPinState(PIN, this.queue.shift()!.level);
    }
    this.cycles = Math.max(this.cycles, until);
  }
}

function wire(id: string, a: string, b: string): Wire {
  return {
    id,
    start: { componentId: a, pinName: String(PIN), x: 0, y: 0 },
    end: { componentId: b, pinName: String(PIN), x: 0, y: 0 },
    color: '#000',
  } as unknown as Wire;
}

/** Bind the boards and wire their pads `PIN` in pairs. */
function wireUp(boards: Board[], pairs: Array<[string, string]>): void {
  resetInterconnect();
  const byId = new Map(boards.map((b) => [b.id, b]));
  setInterconnectRuntime({
    getBoardSimulator: (id) => byId.get(id),
    getBoardPinManager: (id) => byId.get(id)?.pm,
    getBoardBridge: () => undefined,
    getEsp32Bridge: () => undefined,
    getStm32Bridge: () => undefined,
  });
  for (const b of boards) bindBoard(b.id, 'arduino-uno');
  updateWires(pairs.map(([a, b], i) => wire(`w${i}`, a, b)));
}

/** The frame loop: every board runs a frame of its guest time, one after the other, `seconds` long. */
function run(boards: Board[], seconds: number): void {
  const frames = Math.round((seconds * 1_000_000) / FRAME_US);
  const base = boards.map((b) => b.cycles);
  for (let k = 1; k <= frames; k++) boards.forEach((b, i) => b.runTo(base[i] + k * FRAME_US * PER_US));
}

const levels = (b: Board) => b.reports.map(([, level]) => (level ? 'H' : 'L')).join('');

afterEach(() => resetInterconnect());

describe('a level a wire hands a board is not handed back (#74)', () => {
  it('two boards on an open-drain line: four pulses of one reach the other once each, and the line goes quiet', () => {
    const a = new Board('a');
    const b = new Board('b');
    wireUp([a, b], [['a', 'b']]);
    for (const ms of [100, 600, 1_100, 1_600]) a.pulse(ms * 1_000, 1_000);
    run([a, b], 2.5);
    expect(a.reports.length, `A's pad: ${levels(a)}`).toBe(8);
    expect(levels(b), 'B heard each pulse once').toBe('LHLHLHLH');
    run([a, b], 1);
    expect(a.reports.length + b.reports.length, 'changes in a second with nothing sent').toBe(16);
  });

  it('a pulse the other board answers with its own reaches the first one: a report of the guest is never taken for the wire’s', () => {
    const a = new Board('a');
    const b = new Board('b');
    wireUp([a, b], [['a', 'b']]);
    a.pulse(100_000, 1_000);
    b.pulse(300_000, 2_000);
    run([a, b], 1);
    expect(levels(a), 'A: its own pulse, then B’s').toBe('LHLH');
    expect(levels(b), 'B: A’s pulse, then its own').toBe('LHLH');
    // B's pulse reached A at the width B made it.
    const [[fall], [rise]] = a.reports.slice(2);
    expect((rise - fall) / PER_US, 'B’s pulse on A, µs').toBe(2_000);
  });

  it('a chain of three (A to B, B to C): the board in the middle passes the pulse on, and nothing comes back', () => {
    const a = new Board('a');
    const b = new Board('b');
    const c = new Board('c');
    wireUp([a, b, c], [['a', 'b'], ['b', 'c']]);
    a.pulse(100_000, 1_000);
    run([a, b, c], 1.5);
    expect([levels(a), levels(b), levels(c)]).toEqual(['LH', 'LH', 'LH']);
    const [[fall], [rise]] = c.reports;
    expect((rise - fall) / PER_US, 'the pulse on C, µs').toBe(1_000);
  });

  it('a ring of three (A to B, B to C, C to A): each board hears the pulse once, none twice, and the ring goes quiet', () => {
    const a = new Board('a');
    const b = new Board('b');
    const c = new Board('c');
    wireUp([a, b, c], [['a', 'b'], ['b', 'c'], ['c', 'a']]);
    a.pulse(100_000, 1_000);
    a.pulse(400_000, 1_000);
    run([a, b, c], 2);
    expect([levels(a), levels(b), levels(c)]).toEqual(['LHLH', 'LHLH', 'LHLH']);
  });

  it('two levels that land in one step of the receiver are both taken for the wire’s', () => {
    const a = new Board('a');
    // Instructions of 64 cycles, ending 48 past a multiple of 64: a burst lands
    // on a multiple of 64 (frames of 256,000 cycles, an anchor of 320,000), so a
    // 2 µs pulse (32 cycles) lands inside one instruction.
    const b = new Board('b', 64, 48);
    wireUp([a, b], [['a', 'b']]);
    for (const ms of [100, 200, 300]) a.pulse(ms * 1_000, 2);
    run([a, b], 1);
    expect(levels(b)).toBe('LHLHLH');
    expect(b.reports[0][0], 'the two of a pulse in one step').toBe(b.reports[1][0]);
    expect(levels(a), 'nothing came back').toBe('LHLHLH');
  });

  it('a receiver that starts over (its own reset) hears the next pulse once, and hands nothing back', () => {
    const a = new Board('a');
    const b = new Board('b');
    wireUp([a, b], [['a', 'b']]);
    a.pulse(100_000, 1_000);
    run([a, b], 1);
    b.reset();
    a.pulse(1_400_000, 1_000);
    run([a, b], 1);
    expect(levels(b)).toBe('LHLH');
    expect(levels(a)).toBe('LHLH');
  });
});
