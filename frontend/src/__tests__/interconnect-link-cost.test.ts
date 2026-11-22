/**
 * What the interconnect's edge bookkeeping costs an edge (velxio/velxio-prod#74).
 *
 * A wire between two boards with a clock carries each edge as a level
 * scheduled on the receiver, and tells the levels it hands a pad from the ones
 * the pad makes, so an open-drain line does not echo
 * (interconnect-link-echo.test.ts): the sender's report is matched against
 * the levels its pad was handed, the receiver's pad is asked whether it has
 * the edge, and the level is queued on it. #74's review measured the first
 * version of that at 46 % of the CPU of a fast signal between two real Unos:
 * it took levels off a pad's queue with shift(), which moves every level
 * behind, and walked a Map of the pad's last second of edges from the oldest
 * on every edge. A fast signal cost more the more edges it had in flight:
 * 120 k edges a second took twice the time they took before the bookkeeping.
 *
 * Counted in the interconnect's own steps (getLinkEdgeSteps: a level queued,
 * read or moved along its queue, a pad looked for on an edge), not in time, so
 * the bound holds on a loaded machine. The boards are two clocks the
 * interconnect sees as AVRs (16 MHz), run a frame of 16 ms each in turn: A's
 * guest drives a square wave onto its pad, B only listens, and B's pad holds
 * thousands of A's levels at once (a burst lands a frame and an anchor ahead).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PinManager } from '../simulation/PinManager';
import {
  bindBoard,
  getLinkEdgeSteps,
  resetInterconnect,
  setInterconnectRuntime,
  updateWires,
} from '../simulation/Interconnect';
import type { Wire } from '../types/wire';

const HZ = 16_000_000;
const PER_US = HZ / 1_000_000;
const FRAME = 16_000 * PER_US;
const PIN = 2;

class Board {
  cycles = 0;
  /** Changes of the pad. */
  changes = 0;
  readonly id: string;
  readonly pm = new PinManager();
  private readonly queue: Array<{ at: number; level: boolean }> = [];
  private queueHead = 0;
  private readonly writes: Array<{ at: number; level: boolean }> = [];
  private writesHead = 0;

  constructor(id: string) {
    this.id = id;
    this.pm.triggerPinChange(PIN, true, 'external');
    this.pm.onPinChange(PIN, () => this.changes++);
  }
  getCurrentCycles(): number {
    return this.cycles;
  }
  getClockHz(): number {
    return HZ;
  }
  schedulePinChange(_pin: number, level: boolean, at: number): void {
    let i = this.queue.length;
    while (i > this.queueHead && this.queue[i - 1].at > at) i--;
    this.queue.splice(i, 0, { at, level });
  }
  /** Levels handed to the pad that it has not run to. */
  pending(): number {
    return this.queue.length - this.queueHead;
  }
  /** The guest drives `edges` levels onto its pad, low first, `everyUs` apart from `fromUs` (of its own time). */
  square(fromUs: number, everyUs: number, edges: number): void {
    for (let k = 0; k < edges; k++) this.writes.push({ at: (fromUs + k * everyUs) * PER_US, level: k % 2 === 1 });
  }
  /** Run the guest to `until`, in steps of four cycles: its writes and the wire's levels, each in the step that crosses it. */
  runTo(until: number): void {
    for (;;) {
      const next = Math.min(this.writes[this.writesHead]?.at ?? Infinity, this.queue[this.queueHead]?.at ?? Infinity);
      if (next > until) break;
      this.cycles = Math.max(this.cycles, Math.ceil(next / 4) * 4);
      while (this.writesHead < this.writes.length && this.writes[this.writesHead].at <= this.cycles) {
        this.pm.triggerPinChange(PIN, this.writes[this.writesHead++].level, 'mcu');
      }
      while (this.queueHead < this.queue.length && this.queue[this.queueHead].at <= this.cycles) {
        this.pm.triggerPinChange(PIN, this.queue[this.queueHead++].level, 'external');
      }
    }
    this.cycles = Math.max(this.cycles, until);
  }
}

function wireUp(a: Board, b: Board): void {
  resetInterconnect();
  const byId = new Map([a, b].map((x) => [x.id, x]));
  setInterconnectRuntime({
    getBoardSimulator: (id) => byId.get(id),
    getBoardPinManager: (id) => byId.get(id)?.pm,
    getBoardBridge: () => undefined,
    getEsp32Bridge: () => undefined,
    getStm32Bridge: () => undefined,
  });
  bindBoard(a.id, 'arduino-uno');
  bindBoard(b.id, 'arduino-uno');
  updateWires([
    {
      id: 'w',
      start: { componentId: a.id, pinName: String(PIN), x: 0, y: 0 },
      end: { componentId: b.id, pinName: String(PIN), x: 0, y: 0 },
      color: '#000',
    } as unknown as Wire,
  ]);
}

afterEach(() => resetInterconnect());

describe('the edge bookkeeping takes a few steps an edge, however many are in flight (#74)', () => {
  for (const [khz, everyUs] of [
    [5, 100],
    [50, 10],
  ] as const) {
    it(`a ${khz} kHz square wave into a board that listens`, () => {
      const a = new Board('a');
      const b = new Board('b');
      wireUp(a, b);
      const edges = 20_000;
      a.square(2_000, everyUs, edges);
      const frames = Math.ceil((2_000 + edges * everyUs) / 16_000) + 8;
      let inFlight = 0;
      for (let k = 1; k <= frames; k++) {
        a.runTo(k * FRAME);
        inFlight = Math.max(inFlight, b.pending());
        b.runTo(k * FRAME);
      }
      expect(b.changes, 'B heard every edge').toBe(edges);
      expect(a.changes, 'and none came back to A').toBe(edges);
      // About a frame and the anchor ahead: 340 and 3400 levels.
      expect(inFlight, 'levels on B’s pad at once').toBeGreaterThanOrEqual(30_000 / everyUs);
      expect(getLinkEdgeSteps() / edges, 'steps an edge').toBeLessThanOrEqual(12);
    });
  }
});
