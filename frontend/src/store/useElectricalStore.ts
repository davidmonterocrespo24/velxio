/**
 * useElectricalStore — state slice for the ngspice-powered electrical
 * simulation. Decoupled from `useSimulatorStore` so that bundles that
 * never activate electrical mode don't pay any cost for it.
 *
 * Responsibilities:
 *   - Track the electrical mode (`off` / `spice` / `mna-fallback`)
 *   - Hold the latest solve result (node voltages, branch currents, error)
 *   - Expose `triggerSolve()` which the scheduler consumes
 *   - Expose `preloadEngine()` for UI splash when user activates mode
 *
 * Integration is through `wireElectricalSolver(...)` — the function the app
 * bootstraps (once) to subscribe to the simulator store and re-solve on
 * relevant changes. See [`main.tsx`] or `EditorPage.tsx`.
 */
import { create } from 'zustand';
import type { BuildNetlistInput, ElectricalSolveResult } from '../simulation/spice/types';
import { circuitScheduler } from '../simulation/spice/CircuitScheduler';

// ── Feature flag ──────────────────────────────────────────────────────────
// Build-time gate for the whole electrical simulation feature. When false,
// the ⚡ toggle is hidden and the store stays in 'off' mode regardless.
// Set via `VITE_ELECTRICAL_SIM=false` in the environment to disable.
export const ELECTRICAL_SIM_ENABLED =
  (import.meta.env.VITE_ELECTRICAL_SIM ?? 'true') !== 'false';

export type ElectricalMode = 'off' | 'spice' | 'mna-fallback';

interface ElectricalState {
  mode: ElectricalMode;
  nodeVoltages: Record<string, number>;
  branchCurrents: Record<string, number>;
  converged: boolean;
  error: string | null;
  lastSolveMs: number;
  engineLoading: boolean;
  engineReady: boolean;
  submittedNetlist: string;

  setMode: (m: ElectricalMode) => Promise<void>;
  triggerSolve: (input: BuildNetlistInput) => void;
  solveNow: (input: BuildNetlistInput) => Promise<ElectricalSolveResult>;
  setDebounceMs: (ms: number) => void;
  reset: () => void;
}

export const useElectricalStore = create<ElectricalState>((set, get) => {
  // Subscribe to scheduler results once at module construction.
  circuitScheduler.onResult((r) => {
    set({
      nodeVoltages: r.nodeVoltages,
      branchCurrents: r.branchCurrents,
      converged: r.converged,
      error: r.error,
      lastSolveMs: r.solveMs,
      submittedNetlist: r.submittedNetlist,
    });
  });

  return {
    mode: 'off',
    nodeVoltages: {},
    branchCurrents: {},
    converged: true,
    error: null,
    lastSolveMs: 0,
    engineLoading: false,
    engineReady: false,
    submittedNetlist: '',

    async setMode(m) {
      if (!ELECTRICAL_SIM_ENABLED && m !== 'off') {
        set({ error: 'Electrical simulation disabled at build time', mode: 'off' });
        return;
      }
      const prev = get().mode;
      if (prev === m) return;
      set({ mode: m });
      if (m === 'spice' && !get().engineReady) {
        set({ engineLoading: true });
        try {
          const { preloadSpiceEngine } = await import('../simulation/spice/SpiceEngine.lazy');
          await preloadSpiceEngine();
          set({ engineReady: true });
        } catch (err) {
          set({ error: String(err instanceof Error ? err.message : err), mode: 'off' });
        } finally {
          set({ engineLoading: false });
        }
      }
    },

    triggerSolve(input) {
      if (get().mode === 'off') return;
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
      });
    },
  };
});
