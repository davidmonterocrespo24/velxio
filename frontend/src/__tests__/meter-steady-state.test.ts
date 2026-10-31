/**
 * Meters read the settled tail of a transient, not its start-up.
 *
 * Every .tran starts with the circuit at rest at t = 0. A regulated 5 V output
 * behind a reservoir capacitor spends the first part of the window climbing
 * from 0 V; averaging the whole window read "DC 3.47 V" for a supply that
 * sits at 5 V. Synthetic waveforms, so the test pins the meter rule itself.
 */
import { describe, it, expect } from 'vitest';
import { readVoltmeter, readAmmeter } from '../simulation/spice/probes';
import { steadyState } from '../simulation/spice/waveformStats';
import type { ElectricalSolveResult, TimeWaveforms } from '../simulation/spice/types';

const N = 400;
// 0 -> 5 V over the first quarter, then 5 V with 50 mV of 100 Hz ripple.
const supply = Array.from({ length: N }, (_, i) => {
  const t = i / N;
  return t < 0.25 ? 20 * t : 5 + 0.05 * Math.sin(2 * Math.PI * 8 * t);
});

function solveWith(
  node: number[],
  branch: number[],
): { solve: ElectricalSolveResult; tw: TimeWaveforms } {
  const tw: TimeWaveforms = {
    time: node.map((_, i) => i * 1e-4),
    nodes: new Map([['n1', node]]),
    branches: new Map([['v_am_sense', branch]]),
  };
  const solve = {
    nodeVoltages: { n1: node[node.length - 1] },
    branchCurrents: { v_am_sense: branch[branch.length - 1] },
    converged: true,
    error: null,
    solveMs: 0,
    submittedNetlist: '',
    analysisMode: 'tran',
    timeWaveforms: tw,
  } as unknown as ElectricalSolveResult;
  return { solve, tw };
}

describe('meters read the steady state of a transient', () => {
  it('steadyState keeps the second half, and short traces whole', () => {
    expect(steadyState([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual([6, 7, 8, 9, 10]);
    expect(steadyState([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('a regulated 5 V output reads DC 5 V, not the average of its start-up', () => {
    const { solve, tw } = solveWith(
      supply,
      supply.map((v) => v / 100),
    );
    const lookup = (_c: string, pin: string) => (pin === 'V+' ? 'n1' : '0');
    const v = readVoltmeter(
      { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
      lookup,
      solve,
      tw,
    );
    expect(v.ac).toBeDefined();
    expect(v.ac!.dc).toBeGreaterThan(4.99);
    expect(v.ac!.dc).toBeLessThan(5.01);

    const a = readAmmeter({ id: 'am', metadataId: 'instr-ammeter', properties: {} }, solve, tw);
    expect(a.ac!.dc).toBeCloseTo(0.05, 3);
  });
});
