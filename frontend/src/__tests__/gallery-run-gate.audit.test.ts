import { describe, expect, it } from 'vitest';
import { exampleProjects as examples } from '../data/examples';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { verifyCircuit } from '../simulation/verify/circuitVerifier';
import { buildPreflightSnapshot } from '../simulation/verify/verifyFromStore';
import { stripBrandPrefix, isBoardComponentType } from '../utils/exampleToBuildNetlistInput';
import type { BoardKind } from '../types/board';

/**
 * Gallery audit: which examples would the Run button REFUSE to start?
 *
 * EditorToolbar's `checkOrBlock` runs `verifyCircuitFromStore()` before every
 * Run and returns false when the verifier reports errors: the compile never
 * fires and the user gets a "run anyway?" modal. So a circuit error is not
 * cosmetic; it is the difference between an example that runs and one that
 * appears dead.
 *
 * This test once re-implemented the Run button's snapshot by hand (its own
 * worst-case loop, its own board-group lookup) and stayed green for weeks
 * while 38 examples were being refused live: every Grove analog module on
 * the XIAO, dfr-soil-esp32 and nand-sr-latch. Two things had let that
 * through. The snapshot here was not the app's (0ef65684 had already fixed
 * the board-group trap in the app, not here), and the board was inferred
 * from `boardType` only, so every `boards[]` example was audited with no
 * board at all and could not conflict with anything.
 *
 * Now it calls the SAME `buildPreflightSnapshot` the Run button calls, and
 * infers the board the way the loader creates it: `boards[].boardKind`
 * first (ids by addBoard's rule: the first of a kind is the kind, the Nth is
 * `<kind>-N`, exactly loadExample.ts), then `boardType`, then a board
 * component on the canvas (the legacy circuits' `arduino-uno`). Real
 * ngspice, no browser. The pro overlay runs the same gate over its own
 * examples in gallery-circuit.test.ts, with the mappers installed.
 */

type Example = (typeof examples)[number];
type BoardRef = { id: string; boardKind: BoardKind };

/** Every board the example's wires can refer to, with the id the loader would give it. */
function boardsOf(example: Example): BoardRef[] {
  const multi = (example as { boards?: Array<{ boardKind: string }> }).boards;
  if (multi && multi.length) {
    const count = new Map<string, number>();
    return multi.map((b) => {
      const n = (count.get(b.boardKind) ?? 0) + 1;
      count.set(b.boardKind, n);
      return { id: n === 1 ? b.boardKind : `${b.boardKind}-${n}`, boardKind: b.boardKind as BoardKind };
    });
  }
  const bt = (example as { boardType?: string }).boardType;
  if (bt) {
    // Wires name the board by an id that is not a declared component.
    const declared = new Set(example.components?.map((c) => c.id) ?? []);
    const refs = new Set<string>();
    for (const w of example.wires ?? []) {
      for (const ep of [w.start, w.end]) if (!declared.has(ep.componentId)) refs.add(ep.componentId);
    }
    return [...refs].map((id) => ({ id, boardKind: bt as BoardKind }));
  }
  // Legacy circuits carry the board as a component (type 'wokwi-arduino-uno').
  return (example.components ?? [])
    .filter((c) => isBoardComponentType(c.type))
    .map((c) => ({ id: c.id, boardKind: stripBrandPrefix(c.type) as BoardKind }));
}

async function runGate(example: Example) {
  const components = (example.components ?? [])
    .filter((c) => !isBoardComponentType(c.type))
    .map((c) => ({ id: c.id, metadataId: stripBrandPrefix(c.type), properties: c.properties ?? {} }));
  const wires = (example.wires ?? []).map((w) => ({
    id: w.id,
    start: { componentId: w.start.componentId, pinName: w.start.pinName },
    end: { componentId: w.end.componentId, pinName: w.end.pinName },
    color: '#666',
    waypoints: [],
  }));
  const { snap, synthesizedPins } = buildPreflightSnapshot({ components, wires, boards: boardsOf(example) });
  return verifyCircuit(buildInputFromStore(snap), { synthesizedPins });
}

/**
 * Examples the gate knows are refused, with the defect that refuses them and
 * the phase that owns the fix. This is NOT a place to park a red example: an
 * entry needs a cause the pre-flight cannot be blamed for, and the staleness
 * check below deletes it the day the defect is gone. Empty since the logic
 * gates got a finite-slope edge (cause H): the one entry it ever held,
 * nand-sr-latch, a bistable loop of ideal steps, now solves.
 */
const KNOWN_REFUSED: Record<string, string> = {};

describe('gallery: no example is blocked by its own circuit', () => {
  const candidates = examples.filter(
    (e) => (e.components?.length ?? 0) > 0 && (e.wires?.length ?? 0) > 0,
  );

  it('audits every wired example with the Run button\'s own snapshot and reports the blockers', async () => {
    const blocked: Array<{ id: string; board: string; codes: string[]; detail: string }> = [];
    for (const ex of candidates) {
      let res;
      try {
        res = await runGate(ex);
      } catch {
        continue; // unbuildable snapshot: the real app treats that as "don't block"
      }
      if (res.errors.length) {
        blocked.push({
          id: ex.id,
          board: boardsOf(ex).map((b) => b.boardKind).join('+') || '(no board)',
          codes: [...new Set(res.errors.map((e) => e.code))],
          detail: res.errors[0].message.slice(0, 110),
        });
      }
    }

    if (blocked.length) {
      console.log(`\n=== ${blocked.length} of ${candidates.length} wired examples would be REFUSED by Run ===`);
      for (const b of blocked)
        console.log(`  ${b.board.padEnd(20)} ${b.id.padEnd(36)} ${b.codes.join(',')}  ${b.detail}`);
    }
    const unexpected = blocked.filter((b) => !(b.id in KNOWN_REFUSED));
    expect(unexpected.map((b) => `${b.id} [${b.codes.join(',')}]`)).toEqual([]);
    // A known entry that stopped being refused is stale: delete it, do not
    // let the list outlive the defect it documents.
    const stale = Object.keys(KNOWN_REFUSED).filter((id) => !blocked.some((b) => b.id === id));
    expect(stale, 'KNOWN_REFUSED entries that no longer fail').toEqual([]);
  }, 600_000);
});
