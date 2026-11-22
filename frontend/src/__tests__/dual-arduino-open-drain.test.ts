/**
 * An open-drain line between REAL AVR boards (velxio/velxio-prod#74).
 *
 * Two Unos share D2, each an INPUT_PULLUP, and one pulls it low for 1 ms now
 * and then (fixtures/open-drain: od-pulse.ino and od-pair.ino pull it, the
 * open-drain way, from DDR and PORT; od-listen.ino only listens). The boards
 * run in 16 ms bursts in turn, the shape of the frame loop, and the
 * interconnect schedules each edge on the receiver's clock a burst ahead
 * (#397, bounded for #74). The receiver takes the level through its
 * PinManager, as it reports its own: before, the wire carried it back, the
 * sender took it as an input, sent it again, and every pulse went back and
 * forth for ever (444 changes of the pulsing board's D2 in 2.5 s here, where
 * #397's anchor alone made 8). The fake-clock cases of the same rule are
 * interconnect-link-echo.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';
import {
  bindBoard,
  resetInterconnect,
  setInterconnectRuntime,
  updateWires,
} from '../simulation/Interconnect';
import type { Wire } from '../types/wire';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/open-drain/${name}`, import.meta.url)), 'utf8');

const FRAME_CYCLES = 16_000_000 * 0.016;
const MS = 16_000;

function wire(id: string, a: [string, string], b: [string, string]): Wire {
  return {
    id,
    start: { componentId: a[0], pinName: a[1], x: 0, y: 0 },
    end: { componentId: b[0], pinName: b[1], x: 0, y: 0 },
    color: '#000',
  } as unknown as Wire;
}

interface Uno {
  sim: AVRSimulator;
  /** The changes of D2, from 50 ms on (after setup turned the pull-up on, before the first pulse at 100 ms). */
  changes: number;
}

/** Unos running `hexes`, D2 wired in `pairs` (indexes into the boards), run for `seconds` in 16 ms bursts in turn. */
function run(hexes: string[], pairs: Array<[number, number]>, seconds: number): { unos: Uno[]; quiet: number[] } {
  resetInterconnect();
  const pms = hexes.map(() => new PinManager());
  const unos: Uno[] = pms.map((pm) => ({ sim: new AVRSimulator(pm, 'uno'), changes: 0 }));
  const ids = hexes.map((_, i) => `uno${i}`);
  setInterconnectRuntime({
    getBoardSimulator: (id) => unos[ids.indexOf(id)]?.sim,
    getBoardPinManager: (id) => pms[ids.indexOf(id)],
    getBoardBridge: () => undefined,
    getEsp32Bridge: () => undefined,
    getStm32Bridge: () => undefined,
  });
  ids.forEach((id) => bindBoard(id, 'arduino-uno'));
  unos.forEach((u, i) => u.sim.loadHex(fixture(hexes[i])));
  updateWires(pairs.map(([a, b], k) => wire(`w${k}`, [ids[a], '2'], [ids[b], '2'])));
  unos.forEach((u, i) =>
    pms[i].onPinChange(2, () => {
      if (u.sim.getCurrentCycles() >= 50 * MS) u.changes++;
    }),
  );
  const frames = Math.round((seconds * 1_000) / 16);
  for (let frame = 1; frame <= frames; frame++) {
    for (const u of unos) while (u.sim.getCurrentCycles() < frame * FRAME_CYCLES) u.sim.step();
  }
  // A second more, with nothing sent: the line has to be quiet.
  const before = unos.map((u) => u.changes);
  for (let frame = frames + 1; frame <= frames + 62; frame++) {
    for (const u of unos) while (u.sim.getCurrentCycles() < frame * FRAME_CYCLES) u.sim.step();
  }
  return { unos, quiet: unos.map((u, i) => u.changes - before[i]) };
}

describe('an open-drain line between two real Unos, each with its pull-up (#74)', () => {
  it('four pulses of one board: each pad changes twice a pulse, and the line goes quiet', () => {
    const { unos, quiet } = run(['od-pulse.hex', 'od-listen.hex'], [[0, 1]], 2.5);
    expect(unos.map((u) => u.changes), 'changes of D2 on the pulsing board and on the other').toEqual([8, 8]);
    expect(quiet, 'changes in a second with nothing sent').toEqual([0, 0]);
  });

  it('four pairs of pulses 10 ms apart: the same, sixteen changes on each pad', () => {
    const { unos, quiet } = run(['od-pair.hex', 'od-listen.hex'], [[0, 1]], 2.5);
    expect(unos.map((u) => u.changes)).toEqual([16, 16]);
    expect(quiet).toEqual([0, 0]);
  });

  it('a third board wired to the second (a chain) hears the pulses through it, and nothing comes back', () => {
    const { unos, quiet } = run(['od-pulse.hex', 'od-listen.hex', 'od-listen.hex'], [[0, 1], [1, 2]], 2.5);
    expect(unos.map((u) => u.changes)).toEqual([8, 8, 8]);
    expect(quiet).toEqual([0, 0, 0]);
  });

  it('three boards wired each to each (a ring): every pad changes twice a pulse, none more', () => {
    const { unos, quiet } = run(['od-pulse.hex', 'od-listen.hex', 'od-listen.hex'], [[0, 1], [1, 2], [2, 0]], 2.5);
    expect(unos.map((u) => u.changes)).toEqual([8, 8, 8]);
    expect(quiet).toEqual([0, 0, 0]);
  });
});
