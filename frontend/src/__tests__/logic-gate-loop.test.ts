/**
 * Cause H (project/gallery-libraries-2026-09): two NAND gates wired into
 * each other are an SR latch, and with the ideal step u(x) as the gate
 * transition that loop had no operating point: ngspice returned no voltages
 * for the whole canvas and the pre-flight refused the example. The gates
 * now transition over a 50 mV tanh edge. Two things must stay true: the
 * loop solves, and every truth table is still exact at logic levels.
 */
import { describe, expect, it } from 'vitest';
import { exampleProjects as examples } from '../data/examples';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { runNetlist } from '../simulation/spice/runNetlist';
import { buildPreflightSnapshot } from '../simulation/verify/verifyFromStore';
import { stripBrandPrefix, isBoardComponentType } from '../utils/exampleToBuildNetlistInput';

async function solveExample(id: string) {
  const ex = examples.find((e) => e.id === id)!;
  const components = ex.components!
    .filter((c) => !isBoardComponentType(c.type))
    .map((c) => ({ id: c.id, metadataId: stripBrandPrefix(c.type), properties: c.properties ?? {} }));
  const wires = ex.wires!.map((w) => ({ id: w.id, start: w.start, end: w.end }));
  const boards = ex.components!
    .filter((c) => isBoardComponentType(c.type))
    .map((c) => ({ id: c.id, boardKind: stripBrandPrefix(c.type) }));
  const { snap } = buildPreflightSnapshot({ components, wires, boards });
  const { netlist } = buildNetlist({ ...buildInputFromStore(snap), analysis: { kind: 'op' } });
  const cooked = await runNetlist(netlist);
  const v: Record<string, number> = {};
  for (const n of cooked.variableNames) if (n.startsWith('v(')) v[n.slice(2, -1)] = cooked.dcValue(n);
  return { netlist, v };
}

describe('logic gates with a finite-slope edge', () => {
  it('the cross-coupled NAND latch has an operating point', async () => {
    const { netlist, v } = await solveExample('nand-sr-latch');
    expect(netlist).toContain('tanh(');
    expect(netlist).not.toMatch(/u\(V\(/);
    // Both gate outputs solve to a finite voltage. At power-up, with both
    // inputs released HIGH, the symmetric loop settles on its midpoint; a
    // real latch does the same until an input breaks the tie.
    const outs = Object.entries(v).filter(([k]) => /^n\d+$/.test(k)).map(([, x]) => x);
    expect(outs.length).toBeGreaterThan(0);
    for (const x of outs) expect(Number.isFinite(x)).toBe(true);
  }, 60_000);

  it('truth tables stay exact at logic levels, solved by ngspice from the mapper\'s own card', async () => {
    // Take the XOR gate's B-source exactly as the mapper emits it for the
    // gallery example, re-target its three nets to a, b and y, and solve the
    // four input combinations. Exact 0 V / 5 V at logic levels is the
    // property the finite edge must not cost.
    const { netlist } = await solveExample('xor-toggle-detector');
    const card = netlist.split('\n').find((l) => l.startsWith('B_u1 '))!;
    expect(card).toContain('tanh(');
    const [, yNet] = card.split(/\s+/);
    const inputs = [...new Set([...card.matchAll(/V\((\w+)\)/g)].map((m) => m[1]!))];
    expect(inputs).toHaveLength(2);
    const retarget = (l: string) =>
      l.replace(new RegExp(`\\b${yNet}\\b`, 'g'), 'y')
        .replace(new RegExp(`V\\(${inputs[0]}\\)`, 'g'), 'V(a)')
        .replace(new RegExp(`V\\(${inputs[1]}\\)`, 'g'), 'V(b)');
    const cases: Array<[number, number, number]> = [[0, 0, 0], [0, 5, 5], [5, 0, 5], [5, 5, 0]];
    for (const [a, b, y] of cases) {
      const deck = ['* xor at logic levels', `Va a 0 DC ${a}`, `Vb b 0 DC ${b}`, retarget(card), 'R_load y 0 1Meg', '.op', '.end'].join('\n');
      const cooked = await runNetlist(deck);
      expect(cooked.dcValue('v(y)'), `a=${a} b=${b}`).toBeCloseTo(y, 3);
    }
  }, 60_000);
});
