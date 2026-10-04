/**
 * CircuitSimulationService — the orchestration layer that owns the
 * simulation loop.
 *
 * Responsibilities (single, well-defined):
 *   1. Listen to canvas state via an injected SimulatorStorePort.
 *   2. Build the SPICE netlist via NetlistBuilder.
 *   3. Drive the scheduler (loadCircuit + resolveDc / resolveTran).
 *   4. Extract every voltage / branch current / waveform from the
 *      scheduler's last SolveResult and publish to the
 *      ElectricalStorePort so the 12 downstream consumers (ADC
 *      injection, instruments, overlays) keep working.
 *   5. Coalesce concurrent solves: if one is in flight, mark a
 *      pending re-solve for after.
 *
 * Single source of truth: this service replaces the trio of
 *   - wireElectricalSolver (legacy)
 *   - connectLegacySolverToMixedMode (bridge)
 *   - connectMixedModeSchedulerToStore (Phase 1c step 1)
 *
 * Architecture:
 *   - Depends on PORTS only (SimulatorStorePort, ElectricalStorePort,
 *     MixedModeSchedulerPort).  Easy to test with fakes.
 *   - No useSimulatorStore / useElectricalStore imports in this file
 *     — those bindings live in the wiring file (start.ts).
 *   - No SPICE-engine knowledge — that's in the adapters.
 */
import { buildInputFromStore } from './storeAdapter';
import { buildNetlist, sanitizeSpiceId } from './NetlistBuilder';
import type { TimeWaveforms } from './types';
import { digitalGatesEnabled, isAllDigital } from '../digital/digitalGateEngine';

/** What the service needs from the simulator store. */
export interface SimulatorStorePort {
  getState(): {
    components: Array<{ id: string; metadataId: string; properties: Record<string, unknown> }>;
    wires: Array<{
      id: string;
      start: { componentId: string; pinName: string };
      end: { componentId: string; pinName: string };
    }>;
    boards: Array<{ id: string; boardKind: string; running?: boolean; pinStates?: Record<string, unknown> }>;
    /** Components destroyed at runtime (P4) — excluded from the netlist so a
     *  burnt part actually goes open. Optional for non-store ports. */
    burntComponents?: Set<string>;
  };
  subscribe(listener: (state: unknown, prev: unknown) => void): () => void;
}

/** What the service publishes to (the legacy electrical store, in our case). */
export interface ElectricalStorePort {
  /** Atomically write a complete solve snapshot. */
  publish(snapshot: ElectricalSnapshot): void;
}

/** Domain-level solve result, decoupled from SolverPort details. */
export interface ElectricalSnapshot {
  /** SPICE net name → scalar voltage (V).  For .tran: last sample. */
  nodeVoltages: Record<string, number>;
  /** V-source name (without leading V) → scalar branch current (A). */
  branchCurrents: Record<string, number>;
  /** "componentId:pinName" → SPICE net name (from NetlistBuilder). */
  pinNetMap: Map<string, string>;
  /** Which analysis produced this. */
  analysisMode: 'op' | 'tran' | 'ac';
  /** Per-sample waveforms — present only for .tran. */
  timeWaveforms?: TimeWaveforms;
  /** Convergence warnings from the solver. */
  warnings: string[];
  /** Nets backed by a real source/element (see NetlistBuilder). Gates which
   *  MCU input pins connectDigitalInputsToMcu may drive from the solve. */
  sourcedNets: Set<string>;
  /** Lower-case names of the deck's V-sources, so a consumer can tell a pad's
   *  own source apart from the rest of what holds its net. */
  voltageSources?: string[];
}

/** What the service needs from the scheduler. */
export interface MixedModeSchedulerPort {
  loadCircuit(netlist: string, pinNetMap: Map<string, string>): Promise<void>;
  resolveDc(): Promise<void>;
  resolveTran(step: string, stop: string): Promise<void>;
  /**
   * The last SolveResult the scheduler produced.  Used by the service
   * to extract waveforms / branch currents without going around the
   * scheduler.
   */
  getLastResult(): import('./ports/SolverPort').SolveResult | null;
  /**
   * MCU pin transition → alter the matching V source + re-resolve.
   * Domain-level event; the scheduler maps state+vcc → volts and
   * issues the alter.
   */
  onMcuPinChange(boardId: string, pinName: string, state: boolean, vcc: number): Promise<void>;
  /**
   * Allow the service to request extra vectors of interest before
   * the solve runs (branch currents, internal nets).  Optional —
   * implementations may ignore it if they don't optimise.
   */
  setExtraVectorsOfInterest?(vectors: readonly string[]): void;
}

export interface ServiceOptions {
  /** Pre-existing pin states for board pins (from PinManager). */
  collectBoardPinStates: (
    boardId: string,
    boardKind: string,
    wires: SimulatorStorePort['getState'] extends () => infer S
      ? S extends { wires: infer W }
        ? W
        : never
      : never,
  ) => Record<string, unknown>;
}

/**
 * The netlist reads three things from a board: its id, its kind, and its
 * pin states, and the last are collected from the PinManager at solve time,
 * not from the store slice. So a new `boards` array only warrants a rebuild
 * when a board was added, removed, changed kind, or started/stopped (Stop
 * resets every pin, so the V-sources must go). Everything else that rewrites
 * the slice, above all the per-frame serial batcher appending `serialOutput`
 * to the board object, must NOT: on an ESP32 printing a line per GPIO write
 * that was one full rebuild+solve per edge, measured at rebuildCount climbing
 * in step with edgeCount, and each rebuild re-stamped the sources from
 * scratch instead of the cheap in-place alter.
 */
export function boardsChangedForNetlist(
  next: ReadonlyArray<{ id: string; boardKind: string; running?: boolean }>,
  prev: ReadonlyArray<{ id: string; boardKind: string; running?: boolean }>,
): boolean {
  if (next === prev) return false;
  if (next.length !== prev.length) return true;
  for (let i = 0; i < next.length; i++) {
    const a = next[i]!;
    const b = prev[i]!;
    if (a.id !== b.id || a.boardKind !== b.boardKind || !!a.running !== !!b.running) return true;
  }
  return false;
}

export class CircuitSimulationService {
  /**
   * The last REAL transient capture published, kept so a DC re-solve on a
   * tran-loaded circuit does not wipe it.
   *
   * `onMcuPinChange` alters a source and resolves DC — no time axis comes
   * back, but `loadedContext.analysisKind` is still 'tran'. Publishing the
   * undefined straight through meant every GPIO edge blanked the waveform
   * until the next full tick, which the oscilloscope's analog channels read
   * as the trace vanishing several times a second.
   */
  private lastTimeWaveforms: TimeWaveforms | undefined;

  private inFlight = false;
  private pending = false;
  // Per-pin pending edge buffer. Keyed by `${boardId}|${pinName}`. A single
  // slot would be overwritten when several pins toggle during the same
  // in-flight tick (Traffic Light: red→yellow→green hand off within ~µs of
  // each other) — the LATEST edge would win, dropping the rest. With a Map
  // every pin's most-recent edge is preserved and replayed after the tick.
  private pendingMcuEdges = new Map<
    string,
    { boardId: string; pinName: string; state: boolean; vcc: number }
  >();

  /**
   * Last loaded circuit context — used by `handleMcuEdge` to extract
   * the right vectors from `scheduler.getLastResult()` after an
   * `alter + resolveDc` without rebuilding the netlist.
   */
  private loadedContext: {
    pinNetMap: Map<string, string>;
    nets: string[];
    voltageSources: string[];
    analysisKind: 'op' | 'tran' | 'ac';
    sourcedNets: Set<string>;
  } | null = null;

  /** Diagnostics read by `__spiceDebug()`: how many full netlist rebuilds
   *  and how many in-place source alters this service has run. A meter that
   *  flips between two supply voltages, or a pin that seems to ignore its
   *  edges, is usually one of these counters climbing when it should not. */
  rebuildCount = 0;
  edgeCount = 0;
  lastRebuildAt = 0;

  /** Set by `stop()`. Once true, `tick()` and `handleMcuEdge()`
   *  short-circuit so a service whose owner has unsubscribed can't
   *  keep re-scheduling solves against a disposed scheduler. */
  private stopped = false;

  /** Trailing timer for draining `pendingMcuEdges`. Replaying queued
   *  edges IMMEDIATELY after a solve creates a back-to-back solve loop
   *  under sustained toggling (a multiplexed display keeps 8-13 pins
   *  hot, so the queue never empties) — the solver runs at 100% duty
   *  and the UI starves. One drain per gap keeps last-state-wins per
   *  pin while bounding total solve rate. */
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly EDGE_DRAIN_GAP_MS = 33;

  /** Pins the drain has already forced one netlist rebuild for, keyed
   *  `${boardId}|${pinName}`. See `scheduleEdgeDrain` — this is what keeps
   *  the self-heal from looping forever on a pin that can never get a
   *  V-source (unwired GPIO). Cleared whenever a rebuild changes the
   *  V-source list, so a pin that becomes wired later heals again. */
  private drainHealAttempted = new Set<string>();

  /** Drain pendingMcuEdges after a short gap (coalescing: one timer). */
  private scheduleEdgeDrain(): void {
    if (this.stopped || this.drainTimer !== null) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      if (this.stopped) return;
      const edges = Array.from(this.pendingMcuEdges.values());
      this.pendingMcuEdges.clear();
      const ctx = this.loadedContext;
      let needsRebuild = false;
      for (const edge of edges) {
        const pinKey = `${edge.boardId}|${edge.pinName}`;
        const expected = `v_${sanitizeSpiceId(edge.boardId)}_${sanitizeSpiceId(edge.pinName)}`.toLowerCase();
        const hasSource = ctx?.voltageSources.some(
          (vs) => vs.toLowerCase() === expected,
        );
        if (!hasSource) {
          // Same self-heal `handleMcuEdge` does for a first edge: the pin
          // wasn't in `outputPins` when this netlist was built, so there is
          // no V-source to alter and `alterSource` would be a silent no-op.
          // Re-queue and rebuild instead of dropping the edge.
          //
          // Dropping was deliberate (it stops the self-heal → tick →
          // self-heal loop for a pin that is wired to nothing), but it also
          // silently killed pins that only LOOK unsourced because they were
          // classified as outputs after this netlist was built. That is the
          // common case for any sketch driving several pins between yields:
          // the first pin's edge triggers the rebuild, every sibling edge
          // lands mid-solve, and the drain then threw them away — so those
          // pins stayed at their build-time voltage forever. Symptom: the
          // 4-bit binary counter example blinked bit 0 and left bits 1-3
          // dark while the firmware counted correctly on serial.
          //
          // The loop guard is now per-pin instead of blanket: heal a given
          // pin at most once per netlist, then fall back to dropping.
          if (this.drainHealAttempted.has(pinKey)) continue;
          this.drainHealAttempted.add(pinKey);
          this.pendingMcuEdges.set(pinKey, edge);
          needsRebuild = true;
          continue;
        }
        this.drainHealAttempted.delete(pinKey);
        void this.handleMcuEdge(edge.boardId, edge.pinName, edge.state, edge.vcc);
      }
      // One rebuild for the whole drain, not one per edge.
      if (needsRebuild) void this.tick();
    }, CircuitSimulationService.EDGE_DRAIN_GAP_MS);
  }

  constructor(
    private readonly simStore: SimulatorStorePort,
    private readonly electricalStore: ElectricalStorePort,
    private readonly scheduler: MixedModeSchedulerPort,
    private readonly options: ServiceOptions,
  ) {}

  /**
   * Permanently stop the orchestration loop. After `stop()`, the
   * in-flight solve still completes (its Promise was already
   * scheduled), but no further `tick()` or replay of pending
   * `handleMcuEdge` will fire.
   *
   * Why this exists: the `tick()` finally-block recursively
   * re-schedules itself when `pendingMcuEdges` is non-empty, and
   * each iteration calls `scheduler.resolveDc()`. If the test
   * fixture (or a future production caller) disposes the scheduler
   * via `__resetMixedModeScheduler()` without telling the service,
   * those re-scheduled ticks throw "call loadCircuit first", get
   * caught, and the finally schedules ANOTHER tick — infinite
   * Promise loop in the event queue that survives until the worker
   * OOMs. Calling `service.stop()` in the test's afterEach (or any
   * teardown path) breaks the loop.
   */
  stop(): void {
    this.stopped = true;
    this.pending = false;
    this.pendingMcuEdges.clear();
    this.drainHealAttempted.clear();
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
  }

  /** Run one solve cycle, coalescing concurrent triggers. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    // The digital-gate engine owns all-digital board-less circuits when
    // ?digitalgates=on; skip the SPICE solve so the two motors don't fight over
    // the LEDs. Flag off (default) -> isAllDigital is never consulted.
    if (
      digitalGatesEnabled() &&
      isAllDigital((this.simStore.getState() as { components: unknown[] }).components as never[])
    ) {
      return;
    }
    if (this.inFlight) {
      this.pending = true;
      return;
    }
    this.inFlight = true;
    try {
      await this.runSolve();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[circuit-sim] solve failed:', err);
    } finally {
      this.inFlight = false;
      if (this.stopped) return;
      if (this.pending) {
        this.pending = false;
        void this.tick();
      } else if (this.pendingMcuEdges.size > 0) {
        // Deferred drain (not an immediate replay): the drain itself
        // re-checks each pin against the freshly-rebuilt V-source list,
        // dropping edges for pins that still aren't wired into any net —
        // replaying those would self-heal again → re-tick → loop forever.
        this.scheduleEdgeDrain();
      }
    }
  }

  /**
   * Handle an MCU pin transition.  Uses the WASM solver's
   * `alterSource` to update the relevant voltage source in place
   * and re-resolve — no netlist rebuild — then publishes the new
   * voltages to useElectricalStore.
   *
   * Coalesces with the canvas-change tick: if a full solve is in
   * flight, the edge is queued per-pin (Map keyed by `boardId|pinName`)
   * and replayed after the tick completes — last-state-wins PER pin,
   * so different pins toggling during the same tick don't drop each
   * other's edges.
   */
  async handleMcuEdge(boardId: string, pinName: string, state: boolean, vcc: number): Promise<void> {
    if (this.stopped) return;
    const pinKey = `${boardId}|${pinName}`;
    // Queue while a solve is in flight OR while the drain gap timer is
    // armed. Without the second condition, every edge landing in the gap
    // between solves would start an immediate solve of its own and the
    // gap would only apply to the queued leftovers — under a sustained
    // storm that's still ~1 solve per 2 edges instead of 1 per gap.
    if (this.inFlight || this.drainTimer !== null) {
      this.pendingMcuEdges.set(pinKey, { boardId, pinName, state, vcc });
      return;
    }
    if (!this.loadedContext) {
      // No circuit loaded yet — kick a full tick.  The edge will
      // appear in board.pinStates during runSolve.
      void this.tick();
      return;
    }
    // Self-heal: if this is the FIRST edge on a pin that wasn't classified
    // as MCU-output when the netlist was built, the matching V-source
    // doesn't exist — alterSource would be a silent no-op.  Trigger a
    // full rebuild instead; collectPinStates now sees the pin in
    // outputPins and emits the V-source, so the next edge alters normally.
    const expected = `v_${sanitizeSpiceId(boardId)}_${sanitizeSpiceId(pinName)}`.toLowerCase();
    const hasSource = this.loadedContext.voltageSources.some(
      (vs) => vs.toLowerCase() === expected,
    );
    if (!hasSource) {
      this.pendingMcuEdges.set(pinKey, { boardId, pinName, state, vcc });
      void this.tick();
      return;
    }
    this.inFlight = true;
    try {
      // alter + resolveDc internally; the scheduler's
      // onMcuPinChange covers both steps.
      await this.scheduler.onMcuPinChange(boardId, pinName, state, vcc);
      this.edgeCount++;
      this.publishFromLastResult();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[circuit-sim] mcu-edge solve failed:', err);
    } finally {
      this.inFlight = false;
      if (this.pending) {
        this.pending = false;
        void this.tick();
      } else if (this.pendingMcuEdges.size > 0) {
        this.scheduleEdgeDrain();
      }
    }
  }

  private async runSolve(): Promise<void> {
    this.rebuildCount++;
    this.lastRebuildAt = Date.now();
    const state = this.simStore.getState();
    // P4: a runtime-destroyed part is excluded from the netlist so it actually
    // goes open — its current stops and anything it fed loses power (cascading
    // failure), the way real hardware behaves once a component burns out.
    const burnt = state.burntComponents;
    const liveComponents =
      burnt && burnt.size > 0 ? state.components.filter((c) => !burnt.has(c.id)) : state.components;
    const snap = {
      components: liveComponents,
      wires: state.wires,
      boards: state.boards.map((b) => ({
        id: b.id,
        boardKind: b.boardKind,
        pinStates: this.options.collectBoardPinStates(
          b.id,
          b.boardKind,
          state.wires as never,
        ) as never,
      })),
    };
    const input = buildInputFromStore(snap as Parameters<typeof buildInputFromStore>[0]);
    const { netlist, pinNetMap, nets, voltageSources, sourcedNets } = buildNetlist(input);

    // Tell the scheduler exactly which vectors we want — every net
    // voltage + every branch current.
    const extraVectors: string[] = [];
    for (const net of nets) extraVectors.push(`v(${net})`);
    for (const vs of voltageSources) extraVectors.push(`i(${vs.toLowerCase()})`);
    this.scheduler.setExtraVectorsOfInterest?.(extraVectors);

    await this.scheduler.loadCircuit(netlist, pinNetMap);

    if (input.analysis.kind === 'tran') {
      await this.scheduler.resolveTran(input.analysis.step, input.analysis.stop);
    } else {
      await this.scheduler.resolveDc();
    }

    // Cache the load context so handleMcuEdge can publish without
    // re-running buildInputFromStore + buildNetlist.
    //
    // A rebuild that changed the V-source list is a new topology as far as
    // the drain's per-pin heal guard is concerned: re-arm it so a pin that
    // has just become drivable (newly wired, or newly classified as an
    // output) can heal again instead of staying permanently written off.
    const sourcesChanged =
      this.loadedContext === null ||
      this.loadedContext.voltageSources.length !== voltageSources.length ||
      this.loadedContext.voltageSources.some((vs, i) => vs !== voltageSources[i]);
    if (sourcesChanged) this.drainHealAttempted.clear();
    this.loadedContext = {
      pinNetMap,
      nets,
      voltageSources,
      analysisKind: input.analysis.kind,
      sourcedNets,
    };
    this.publishFromLastResult();
  }

  /**
   * Build an ElectricalSnapshot from the scheduler's last SolveResult
   * + the cached load context.  Publishes to useElectricalStore.
   */
  private publishFromLastResult(): void {
    const ctx = this.loadedContext;
    const result = this.scheduler.getLastResult();
    if (!ctx || !result) return;

    const nodeVoltages: Record<string, number> = {};
    const branchCurrents: Record<string, number> = {};
    let timeWaveforms: TimeWaveforms | undefined;

    for (const net of ctx.nets) {
      const vec = result.vectors.get(`v(${net})`);
      if (vec && vec.real.length > 0) {
        nodeVoltages[net] = vec.real[vec.real.length - 1]!;
      }
    }
    for (const vs of ctx.voltageSources) {
      const vec = result.vectors.get(`i(${vs.toLowerCase()})`);
      if (vec && vec.real.length > 0) {
        // Convention: useElectricalStore.branchCurrents keys use the
        // lower-case V-source name (e.g. "v_led1_sense").  LED handler
        // and Ammeter both read this shape.
        branchCurrents[vs.toLowerCase()] = vec.real[vec.real.length - 1]!;
      }
    }

    if (ctx.analysisKind === 'tran' && result.timeAxis.length > 0) {
      const nodes = new Map<string, number[]>();
      const branches = new Map<string, number[]>();
      for (const net of ctx.nets) {
        const vec = result.vectors.get(`v(${net})`);
        if (vec && vec.real.length > 0) nodes.set(net, Array.from(vec.real));
      }
      for (const vs of ctx.voltageSources) {
        const vec = result.vectors.get(`i(${vs.toLowerCase()})`);
        if (vec && vec.real.length > 0) branches.set(vs.toLowerCase(), Array.from(vec.real));
      }
      timeWaveforms = { time: Array.from(result.timeAxis), nodes, branches };
      this.lastTimeWaveforms = timeWaveforms;
    } else if (ctx.analysisKind === 'tran') {
      // A DC re-solve inside a transient circuit (an MCU edge altering a
      // source). The voltages above are fresh and correct; the waveform is
      // simply not part of this answer, so carry the last real one rather
      // than blanking it.
      timeWaveforms = this.lastTimeWaveforms;
    } else {
      // The circuit genuinely is not transient any more — drop the stale
      // capture so a later switch back to tran cannot serve someone else's.
      this.lastTimeWaveforms = undefined;
    }

    this.electricalStore.publish({
      nodeVoltages,
      branchCurrents,
      pinNetMap: ctx.pinNetMap,
      analysisMode: ctx.analysisKind,
      timeWaveforms,
      warnings: result.warnings,
      sourcedNets: ctx.sourcedNets,
      voltageSources: ctx.voltageSources.map((vs) => vs.toLowerCase()),
    });
  }

  /**
   * Mount the service: subscribe to store changes + run one initial
   * solve.  Returns an unsubscribe handle.
   */
  start(): () => void {
    const unsubscribe = this.simStore.subscribe((next, prev) => {
      const n = next as ReturnType<typeof this.simStore.getState>;
      const p = prev as ReturnType<typeof this.simStore.getState>;
      if (
        n.components !== p.components ||
        n.wires !== p.wires ||
        boardsChangedForNetlist(n.boards, p.boards) ||
        // P4: a part burning out (or a Reset un-burning it) changes which
        // components are in the netlist, so re-solve to apply the open.
        n.burntComponents !== p.burntComponents
      ) {
        void this.tick();
      }
    });
    void this.tick();
    return unsubscribe;
  }
}
