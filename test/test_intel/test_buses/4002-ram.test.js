/**
 * Intel 4002 RAM — basic unit test.
 *
 * The 4002's full I/O cycle requires the 4004 to actually drive the
 * SRC chip-select address during X2/X3 of the SRC instruction (which
 * the current 4004.c stubs as a no-op). This test exercises only the
 * pin contract and the chip's response to RESET — the canvas-level
 * deliverable. Full SRC + WRM/RDM round-trip is tracked as a Phase D
 * follow-up that requires modifying 4004.c.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BoardHarness } from '../src/BoardHarness.js';
import { chipWasmExists } from '../src/helpers.js';

const CHIP = '4002-ram';
const skip = !chipWasmExists(CHIP);

function pinMap() {
  const m = {
    SYNC: 'SYNC', CL: 'CL', RESET: 'RESET', CM: 'CM',
    VDD: 'VDD', VSS: 'VSS',
  };
  for (let i = 0; i < 4; i++) m[`D${i}`] = `D${i}`;
  for (let i = 0; i < 4; i++) m[`O${i}`] = `O${i}`;
  return m;
}

describe(`${CHIP} chip`, () => {
  let board;
  beforeEach(() => { board = new BoardHarness(); });
  afterEach(() => { board.dispose(); });

  it.skipIf(skip)('registers all 14 logical pins', async () => {
    await expect(board.addChip(CHIP, pinMap())).resolves.toBeDefined();
  });

  it.skipIf(skip)('after RESET output port reads zero', async () => {
    await board.addChip(CHIP, pinMap());
    board.setNet('RESET', true);
    board.advanceNanos(50);
    board.setNet('RESET', false);
    board.advanceNanos(50);
    let out = 0;
    for (let i = 0; i < 4; i++) if (board.getNet(`O${i}`)) out |= (1 << i);
    expect(out).toBe(0);
  });
});
