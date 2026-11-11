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
  /**
   * Wire length in centimetres.  When set, the NetlistBuilder treats
   * the wire as a resistor (~0.01 Ω per cm copper) instead of an
   * ideal short.  Endpoints land in separate SPICE nets joined by a
   * `R_wire_<id>` card so voltage drop on long buses is modelled.
   *
   * Phase 4 of the mixed-mode simulator project.  Wires without
   * `length_cm` keep the legacy perfect-conductor union-find
   * behaviour — backwards compatible until UI starts emitting it.
   */
  length_cm?: number;
}

/** One board instance contributes GPIO pin sources. */
export interface BoardForSpice {
  /** Stable unique board id (used as prefix in net names). */
  id: string;
  /** Board kind (e.g. 'arduino-uno', 'esp32') — used to look up over-voltage
   *  ratings in the verifier. Optional: older callers may omit it. */
  boardKind?: string;
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
  /**
   * Supply pins at a DIFFERENT voltage than `vcc` (the VIN / 5V pins of a
   * 3.3 V board, the 3.3 V pin of a 5 V Arduino). Canonicalized to a
   * per-voltage `aux_rail_*` net driven at `auxVolts` instead of `vcc_rail`.
   */
  auxPinNames?: string[];
  /** Voltage of the aux rail (V). Required for `auxPinNames` to take effect. */
  auxVolts?: number;
}

export type PinSourceState =
  | { type: 'digital'; v: 0 | 5 | 3.3 | number }
  | { type: 'pwm'; duty: number }
  // An input pin. `pull` carries the MCU's internal pull config (from
  // INPUT_PULLUP / INPUT_PULLDOWN): 0/undefined = none, 1 = pull-up,
  // 2 = pull-down. The NetlistBuilder stamps a weak resistor to the rail so
  // the idle level is correct; without it a button-to-GND input reads LOW.
  | { type: 'input'; pull?: 0 | 1 | 2 };

/** Electrical analyses the solver can perform. */
export type AnalysisMode =
  | { kind: 'op' }
  | {
      kind: 'tran';
      step: string;
      stop: string;
      /** Period (s) of the slowest periodic source, when the window was sized
       *  from one: meters average over whole periods of it (waveformStats). */
      period?: number;
    }
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
  /**
   * Period (s) of the slowest periodic source the window was sized from
   * (a generator, a supply in AC mode), absent for a step response or a
   * scope's window on a DC circuit. Readers average over whole periods of it
   * (readSpan).
   */
  period?: number;
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
