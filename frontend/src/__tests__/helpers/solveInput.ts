/**
 * Test helper — replaces the legacy
 * `circuitScheduler.solveNow(input)` API with a SolverPort-driven
 * equivalent.  Used by tests that take a `BuildNetlistInput` and
 * want the shaped `ElectricalSolveResult` back synchronously.
 *
 * Phase 1c G3 of the mixed-mode migration: lets the six remaining
 * legacy-store consumers migrate to the new path so the
 * CircuitScheduler can be retired.
 */
import { buildNetlist } from '../../simulation/spice/NetlistBuilder';
import { NgSpiceNodeAdapter } from '../../simulation/spice/adapters/NgSpiceNodeAdapter';
import type {
  BuildNetlistInput,
  ElectricalSolveResult,
  TimeWaveforms,
} from '../../simulation/spice/types';

let singleton: NgSpiceNodeAdapter | null = null;
function getAdapter(): NgSpiceNodeAdapter {
  if (!singleton) singleton = new NgSpiceNodeAdapter();
  return singleton;
}

/** Drop-in replacement for `circuitScheduler.solveNow(input)`. */
export async function solveInput(input: BuildNetlistInput): Promise<ElectricalSolveResult> {
  const t0 = performance.now();
  const adapter = getAdapter();
  await adapter.init();
  const { netlist, pinNetMap, nets, voltageSources } = buildNetlist(input);
  await adapter.loadCircuit(netlist);

  const analysis = input.analysis.kind === 'tran'
    ? { kind: 'tran' as const, step: input.analysis.step, stop: input.analysis.stop }
    : input.analysis.kind === 'ac'
      ? {
          kind: 'ac' as const,
          sweep: (input.analysis.type ?? 'dec') as 'dec' | 'oct' | 'lin',
          points: input.analysis.points ?? 20,
          fstart: input.analysis.fstart ?? 1,
          fstop: input.analysis.fstop ?? 1e6,
        }
      : { kind: 'op' as const };

  await adapter.solve(analysis, { vectorsOfInterest: [] });
  const allRead = adapter.readAllCurrentVectors();

  // Enumerate EVERY vector ngspice returned (including extra-card
  // nets and source currents not produced by NetlistBuilder).  Legacy
  // `circuitScheduler.solveNow` returned them too — preserve parity.
  const nodeVoltages: Record<string, number> = {};
  const branchCurrents: Record<string, number> = {};
  for (const [key, vec] of allRead.vectors) {
    if (vec.real.length === 0) continue;
    if (key === 'time' || key === 'frequency') continue;
    const lastSample = vec.real[vec.real.length - 1]!;
    const branchMatch = key.match(/^(.+)#branch$/);
    if (branchMatch) {
      branchCurrents[branchMatch[1]!] = lastSample;
    } else {
      nodeVoltages[key] = lastSample;
    }
  }

  let timeWaveforms: TimeWaveforms | undefined;
  if (analysis.kind === 'tran') {
    const tVec = allRead.vectors.get('time');
    if (tVec && tVec.real.length > 0) {
      const nodes = new Map<string, number[]>();
      const branches = new Map<string, number[]>();
      for (const [key, vec] of allRead.vectors) {
        if (key === 'time' || key === 'frequency') continue;
        if (vec.real.length === 0) continue;
        const branchMatch = key.match(/^(.+)#branch$/);
        if (branchMatch) {
          branches.set(branchMatch[1]!, Array.from(vec.real));
        } else {
          nodes.set(key, Array.from(vec.real));
        }
      }
      timeWaveforms = {
        time: Array.from(tVec.real),
        nodes,
        branches,
        // The app's window carries the period it was sized from (storeAdapter).
        period: input.analysis.kind === 'tran' ? input.analysis.period : undefined,
      };
    }
  }
  void nets;
  void voltageSources;

  return {
    nodeVoltages,
    branchCurrents,
    converged: true,
    error: null,
    solveMs: performance.now() - t0,
    submittedNetlist: netlist,
    pinNetMap,
    analysisMode: analysis.kind,
    timeWaveforms,
  };
}
