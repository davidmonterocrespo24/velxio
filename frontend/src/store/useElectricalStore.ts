/**
 * useElectricalStore — Zustand slice for the WASM-ngspice mixed-mode
 * simulator's published results.
 *
 * SPICE runs through `CircuitSimulationService` (see
 * `simulation/spice/CircuitSimulationService.ts`).  The service calls
 * `setSolveResult()` after each solve to publish an atomic snapshot
 * into this store, which the 12 downstream consumers (LED handler,
 * Voltmeter, Ammeter, AnalogOverlay, ADC bridge, etc.) read.
 *
 * The store no longer owns the solver — it's a pure state container.
 * Pause is a UI control that stops re-solves on switch / property
 * changes (the engine still holds the last result so LEDs stay lit).
 */
import { create } from 'zustand';
import type { TimeWaveforms } from '../simulation/spice/types';

export interface ElectricalSnapshot {
  nodeVoltages: Record<string, number>;
  branchCurrents: Record<string, number>;
  pinNetMap: Map<string, string>;
  analysisMode: 'op' | 'tran' | 'ac';
  timeWaveforms?: TimeWaveforms;
  converged: boolean;
  error: string | null;
  lastSolveMs: number;
  submittedNetlist: string;
  /** Nets backed by a real source/element (rail, GPIO V-source, pull, or any
   *  component card). connectDigitalInputsToMcu only drives MCU input pins
   *  whose net is here, so floating event-part pins aren't forced LOW. */
  sourcedNets: Set<string>;
  /** The V-source names of the deck this snapshot was solved with, lower
   *  case (`v_<board>_<pin>` for a board pad). connectDigitalInputsToMcu
   *  uses it to recognise a pad reading its own stale source. */
  voltageSources?: string[];
}

interface ElectricalState extends ElectricalSnapshot {
  /**
   * When true, the service skips re-solves on canvas changes — the
   * last snapshot stays live so LEDs hold their value, but switch
   * toggles don't propagate.  Used by the editor's Run / Stop UI.
   */
  paused: boolean;
  setPaused: (paused: boolean) => void;
  /** Atomic publish of a fresh solve snapshot (called by the service). */
  setSolveResult: (snapshot: ElectricalSnapshot) => void;
  /** Wipe everything — used when loading a new project. */
  reset: () => void;
}

const EMPTY: ElectricalSnapshot = {
  nodeVoltages: {},
  branchCurrents: {},
  pinNetMap: new Map(),
  analysisMode: 'op',
  timeWaveforms: undefined,
  converged: true,
  error: null,
  lastSolveMs: 0,
  submittedNetlist: '',
  sourcedNets: new Set(),
  voltageSources: [],
};

export const useElectricalStore = create<ElectricalState>((set) => ({
  ...EMPTY,
  paused: false,
  setPaused(paused) {
    set({ paused });
  },
  setSolveResult(snapshot) {
    set({ ...snapshot });
  },
  reset() {
    set({ ...EMPTY });
  },
}));
