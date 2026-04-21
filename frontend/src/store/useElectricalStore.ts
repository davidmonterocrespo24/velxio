/**
 * useElectricalStore — state slice for the ngspice-powered electrical
 * simulation. SPICE is **always active** in Velxio so that every circuit —
 * digital or analog — is solved with real-world fidelity (voltages,
 * currents, MOSFET I-V curves, diode drops, reverse-leakage, …).
 *
 * There is intentionally no way to disable it: no toggle, no flag, no mode
 * field. The engine is preloaded on module construction; the scheduler
 * consumes `triggerSolve()` and writes results back here.
 *
 * Integration is through `wireElectricalSolver(...)` — bootstrapped once at
 * app start to subscribe to the simulator store and re-solve on relevant
 * changes. See [`main.tsx`] or `EditorPage.tsx`.
 */
import { create } from 'zustand';
import type {
  BuildNetlistInput,
  ElectricalSolveResult,
  TimeWaveforms,
} from '../simulation/spice/types';
import { circuitScheduler } from '../simulation/spice/CircuitScheduler';

interface ElectricalState {
  nodeVoltages: Record<string, number>;
  branchCurrents: Record<string, number>;
  converged: boolean;
  error: string | null;
  lastSolveMs: number;
  submittedNetlist: string;
  /** "boardId:pinName" → SPICE net name. Populated after each solve. */
  pinNetMap: Map<string, string>;
  /** Which analysis the last solve used. */
  analysisMode: 'op' | 'tran' | 'ac';
  /**
   * Periodic waveforms from the last `.tran` solve (undefined for `.op`).
   * RAF-driven ADC replay and LED brightness averaging read from this field.
   */
  timeWaveforms?: TimeWaveforms;

  triggerSolve: (input: BuildNetlistInput) => void;
  solveNow: (input: BuildNetlistInput) => Promise<ElectricalSolveResult>;
  setDebounceMs: (ms: number) => void;
  reset: () => void;
}

export const useElectricalStore = create<ElectricalState>((set) => {
  // Eagerly preload the SPICE engine at app start so the first solve pays
  // no WASM-loading latency (~39 MB bundle).
  import('../simulation/spice/SpiceEngine.lazy').then(async (mod) => {
    try {
      await mod.preloadSpiceEngine();
    } catch {
      // Silently ignore — the engine will load on the first triggerSolve()
      // and the error (if any) will surface in the solve result instead.
    }
  });

  // Subscribe to scheduler results once at module construction.
  circuitScheduler.onResult((r) => {
    set({
      nodeVoltages: r.nodeVoltages,
      branchCurrents: r.branchCurrents,
      converged: r.converged,
      error: r.error,
      lastSolveMs: r.solveMs,
      submittedNetlist: r.submittedNetlist,
      pinNetMap: r.pinNetMap,
      analysisMode: r.analysisMode,
      timeWaveforms: r.timeWaveforms,
    });
  });

  return {
    nodeVoltages: {},
    branchCurrents: {},
    converged: true,
    error: null,
    lastSolveMs: 0,
    submittedNetlist: '',
    pinNetMap: new Map(),
    analysisMode: 'op' as const,
    timeWaveforms: undefined,

    triggerSolve(input) {
      circuitScheduler.requestSolve(input);
    },

    async solveNow(input) {
      return circuitScheduler.solveNow(input);
    },

    setDebounceMs(ms) {
      circuitScheduler.setDebounceMs(ms);
    },

    reset() {
      set({
        nodeVoltages: {},
        branchCurrents: {},
        converged: true,
        error: null,
        lastSolveMs: 0,
        submittedNetlist: '',
        pinNetMap: new Map(),
        analysisMode: 'op',
        timeWaveforms: undefined,
      });
    },
  };
});
