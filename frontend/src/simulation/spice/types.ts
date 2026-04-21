/**
 * Types shared between NetlistBuilder, componentToSpice, and store integration.
 *
 * These are deliberately **narrow** re-shapes of the Velxio store types so
 * that the SPICE subsystem does not couple to the full simulator state shape.
 */

export interface ComponentForSpice {
  id: string;
  metadataId: string;
  properties: Record<string, unknown>;
}

export interface WireForSpice {
  id: string;
  start: { componentId: string; pinName: string };
  end: { componentId: string; pinName: string };
}

/** One board instance contributes GPIO pin sources. */
export interface BoardForSpice {
  /** Stable unique board id (used as prefix in net names). */
  id: string;
  /** Supply voltage of this board, V. */
  vcc: number;
  /**
   * Pin states snapshot.
   *   type === 'digital' → 0 / 5 V applied
   *   type === 'pwm'     → quasi-static DC equivalent: duty · vcc
   *   type === 'input'   → no source stamped (pin is high-impedance)
   */
  pins: Record<string, PinSourceState>;
  /** Names of pins that should be treated as ground (e.g., "GND", "GND.1"). */
  groundPinNames?: string[];
  /** Names of pins that should be treated as VCC rail. */
  vccPinNames?: string[];
}

export type PinSourceState =
  | { type: 'digital'; v: 0 | 5 | 3.3 | number }
  | { type: 'pwm'; duty: number }
  | { type: 'input' };

/** Electrical analyses the solver can perform. */
export type AnalysisMode =
  | { kind: 'op' }
  | { kind: 'tran'; step: string; stop: string }
  | { kind: 'ac'; type?: 'dec' | 'oct' | 'lin'; points?: number; fstart?: number; fstop?: number };

/** Everything the NetlistBuilder needs to emit a netlist. */
export interface BuildNetlistInput {
  components: ComponentForSpice[];
  wires: WireForSpice[];
  boards: BoardForSpice[];
  analysis: AnalysisMode;
  /** Extra cards to append verbatim (e.g., `.options abstol=1n`). */
  extraCards?: string[];
}

/**
 * Per-sample voltage/current vectors from a `.tran` analysis.
 *
 * Present only when `analysisMode === 'tran'`. All vectors share the same
 * `time` axis (seconds, monotonic, starts at 0). Downstream consumers (ADC
 * injection, LED brightness) interpolate `samples[t]` to the current AVR sim
 * time modulo the period to replay the waveform continuously.
 */
export interface TimeWaveforms {
  /** Monotonic time axis in seconds. */
  time: number[];
  /** Net name → voltage samples aligned with `time`. */
  nodes: Map<string, number[]>;
  /** Voltage-source name → current samples aligned with `time`. */
  branches: Map<string, number[]>;
}

/** Cooked solve results exposed to UI layers. */
export interface ElectricalSolveResult {
  /**
   * Net name → scalar voltage (V). Ground net is always 0.
   *
   * For `.op`: the operating-point value. For `.tran`: the **last** sample
   * (≈ steady state) so legacy consumers that read a single number still
   * see a plausible value. The instantaneous/periodic replay is available
   * through `timeWaveforms`.
   */
  nodeVoltages: Record<string, number>;
  /** Voltage source name → scalar current (A). Same semantics as `nodeVoltages`. */
  branchCurrents: Record<string, number>;
  /** Convergence flag. `false` means the result is suspect. */
  converged: boolean;
  /** Human-readable error or warning, if any. */
  error: string | null;
  /** ms spent on the ngspice call (excluding UI overhead). */
  solveMs: number;
  /** The netlist we submitted — useful for debugging in the UI. */
  submittedNetlist: string;
  /**
   * Maps "boardId:pinName" → SPICE net name, built from the same Union-Find
   * used to generate the netlist. Used by ADC injection to locate voltages.
   */
  pinNetMap: Map<string, string>;
  /** Which analysis produced this result. */
  analysisMode: 'op' | 'tran' | 'ac';
  /**
   * Periodic waveforms from a `.tran` analysis. Present only when
   * `analysisMode === 'tran'`; `undefined` for `.op` / `.ac`.
   */
  timeWaveforms?: TimeWaveforms;
}
