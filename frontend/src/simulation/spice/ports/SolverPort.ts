/**
 * SolverPort — the abstract contract for a SPICE solver as Velxio
 * consumes it.  This is a Hexagonal-style port: domain code depends on
 * the interface, and adapters in ./adapters/ implement it against
 * concrete WASM builds or test fakes.
 *
 * Design rationale:
 *   - The domain (MixedModeScheduler, CircuitSimulationService) must
 *     not depend on Web Worker semantics, the vendored WASM, or any
 *     particular ngspice version.  Swapping engines (or going node-
 *     native in tests) only touches an adapter.
 *   - The port surface is intentionally narrow: load a netlist, solve
 *     an analysis, read named vectors, alter a source for incremental
 *     re-solves.  Anything more specific to ngspice is below this line.
 */

/**
 * The analysis kinds a Velxio canvas can request.  Mirrors
 * `AnalysisMode` in ../types.ts but lives here so the port doesn't
 * import from outside the SPICE subsystem.
 */
export type SolveAnalysis =
  | { kind: 'op' }
  | { kind: 'tran'; step: string; stop: string }
  | { kind: 'ac'; sweep: 'dec' | 'oct' | 'lin'; points: number; fstart: number; fstop: number };

/**
 * One vector — a named time / frequency series.  For `.op` the array
 * has length 1.  For `.tran` / `.ac` it's the full waveform.
 */
export interface SolveVector {
  /** Lower-case vector name as ngspice would emit it (e.g. `v(n0)`, `i(v1)`). */
  name: string;
  /** Real samples, monotonically time-ordered for `.tran`. */
  real: Float64Array;
  /** Imag samples — present only for `.ac` (complex frequency response). */
  imag: Float64Array | null;
}

/**
 * Result of a complete solve.  Includes every requested vector.
 * Consumers index by lower-case name (e.g. `v(n2)` for the voltage
 * at net `n2`).
 *
 * Vectors not in the request (or that don't exist in the engine
 * state) are simply absent from the map.  Callers must tolerate
 * missing vectors — a disconnected pin won't produce one.
 */
export interface SolveResult {
  analysis: SolveAnalysis;
  /** Map keyed by vector name → vector. Always lower-case keys. */
  vectors: Map<string, SolveVector>;
  /**
   * For `.tran`: the time axis in seconds, monotonically increasing.
   * For `.op` / `.ac`: empty (length 0).
   */
  timeAxis: Float64Array;
  /** Wall-clock duration of the solve, in milliseconds. */
  solveMs: number;
  /** Anything ngspice wrote to stderr during the solve. Empty when clean. */
  warnings: string[];
  /** Where the time of this solve went, when the engine can tell:
   *  the analysis command itself and the vector reads after it. */
  timing?: { commandMs: number; readMs: number };
}

/**
 * What to ask the engine for after a solve.  Listing vectors up
 * front lets the adapter parallelise reads (a Worker round-trip per
 * vector is O(100µs); doing them concurrently is a real win for
 * netlists with 50+ nets).
 */
export interface SolveOptions {
  /**
   * Vector names to read.  Lower-case, ngspice-formatted
   * (`v(node_name)` for voltages, `i(v_source_name)` for branch
   * currents).  Empty array = no vectors read (only timing).
   */
  vectorsOfInterest: readonly string[];
}

/**
 * The port itself.  An adapter (real WASM, fake, etc.) implements
 * this; domain code accepts an instance via constructor injection.
 *
 * Lifecycle:
 *   1. `init()` — boot the underlying engine (WASM, native, etc.).
 *      Idempotent; safe to await multiple times.
 *   2. `loadCircuit(netlist)` — submit the SPICE netlist string.
 *      Replaces any previously loaded circuit.
 *   3. `solve(analysis)` — run the requested analysis.  Pure: doesn't
 *      mutate the circuit, only reads from the engine state.
 *   4. `alterSource(name, dcValue)` — update a voltage source between
 *      solves.  Used for MCU-edge re-resolves.
 *   5. `dispose()` — release the engine (terminate worker, free heap).
 *
 * Concurrency: implementations are responsible for serialising
 * concurrent calls.  Callers may issue overlapping `solve()` calls;
 * the adapter is free to queue them.
 */
export interface SolverPort {
  init(): Promise<void>;
  loadCircuit(netlist: string): Promise<void>;
  solve(analysis: SolveAnalysis, options: SolveOptions): Promise<SolveResult>;
  alterSource(name: string, dcValue: number): Promise<void>;
  /**
   * Alter several sources in one round trip, when the engine offers it;
   * callers fall back to `alterSource` per entry otherwise.
   */
  alterSources?(changes: ReadonlyArray<{ source: string; volts: number }>): Promise<void>;
  dispose(): void;
}
