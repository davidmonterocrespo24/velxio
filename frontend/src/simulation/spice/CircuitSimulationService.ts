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
 *   5. Integrate MCU pad edges in time (PadTimeline): every window the
 *      states the pads held are solved once each (cached by state) and
 *      published with the share of the window each one took, next to the
 *      instantaneous latest state. One solver use at a time.
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
import { PadTimeline, stateKey, type WindowResult, type WindowState } from './PadTimeline';

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

/** One pad state of a publish window with its solve and its share of the
 *  window. Mirrors `SolveWindowState` in useElectricalStore. */
export interface SolveWindowState {
  weight: number;
  ms: number;
  levels: Record<string, number>;
  nodeVoltages: Record<string, number>;
  branchCurrents: Record<string, number>;
}

/** The circuit over the last publish window, time-weighted. Mirrors
 *  `SolveWindow` in useElectricalStore; see there for who reads what. */
export interface SolveWindow {
  ms: number;
  states: SolveWindowState[];
}

/** Domain-level solve result, decoupled from SolverPort details. */
export interface ElectricalSnapshot {
  /** SPICE net name → scalar voltage (V).  For .tran: last sample. */
  nodeVoltages: Record<string, number>;
  /** V-source name (without leading V) → scalar branch current (A). */
  branchCurrents: Record<string, number>;
  /** The states of the last publish window and their weights; absent on a
   *  publish made for a single state (a rebuild, the first edge after idle)
   *  unless a static PWM pad splits it into its HIGH and LOW states. */
  window?: SolveWindow;
  /** "componentId:pinName" → SPICE net name (from NetlistBuilder). */
  pinNetMap: Map<string, string>;
  /** Which analysis produced this. */
  analysisMode: 'op' | 'tran' | 'ac';
  /**
   * The transient capture OF THIS STATE, when it has one: what the circuit
   * did over the capture window with the pads at the levels published. Absent
   * when the state was solved as an operating point (a pad edge on a circuit
   * whose transient is only a step response or a scope window); the scalar
   * fields are then the whole truth. Every reader that prefers a capture over
   * the scalar values (the LED part, the ADC hooks, the meters) reads this.
   */
  timeWaveforms?: TimeWaveforms;
  /**
   * The last capture the deck produced, kept across the operating points
   * solved after it, for the oscilloscope alone: its analog channels redraw
   * the latest sweep until the next one rather than going blank on every pin
   * edge. Not a description of the present state; nothing else reads it.
   */
  scopeWaveforms?: TimeWaveforms;
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
   * issues the alter. Not used by the service since the pad timeline
   * (2026-10); kept for callers that alter one pad at a time.
   */
  onMcuPinChange(boardId: string, pinName: string, state: boolean, vcc: number): Promise<void>;
  /**
   * Set several V-sources to the volts given, without solving. The
   * service brings the solver to a pad state this way and then calls
   * `resolveDc` once.
   */
  alterSources(changes: ReadonlyArray<{ source: string; volts: number }>): Promise<void>;
  /**
   * Alter + solve + read in one round trip when the engine offers it;
   * falls back to alterSources + the analysis inside. The analysis is an
   * operating point unless given. Optional for ports that only know the
   * two steps.
   */
  solvePadState?(
    changes: ReadonlyArray<{ source: string; volts: number }>,
    analysis?: import('./ports/SolverPort').SolveAnalysis,
  ): Promise<void>;
  /**
   * Make a result the scheduler already produced its current one again
   * (and republish per-pin voltages from it). Used when the service
   * publishes a pad state it has cached instead of solving it anew.
   */
  adoptResult?(result: import('./ports/SolverPort').SolveResult): void;
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

/** One pad state the circuit was solved for: what the state cache holds. */
interface StateVectors {
  nodeVoltages: Record<string, number>;
  branchCurrents: Record<string, number>;
  timeWaveforms?: TimeWaveforms;
  warnings: string[];
  result: import('./ports/SolverPort').SolveResult;
}

const nowMs = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

/**
 * A deck with the levels its pads were stamped at blanked out (and its
 * timestamp line dropped): two decks of one shape differ only in where their
 * pads stand, which every pad-state solve sets anyway.
 */
function deckShapeOf(netlist: string, padNames: ReadonlySet<string>): string {
  return netlist
    .split('\n')
    .filter((line) => !line.startsWith('* Velxio circuit'))
    .map((line) => {
      const space = line.indexOf(' ');
      const name = (space > 0 ? line.slice(0, space) : line).toLowerCase();
      return padNames.has(name) ? line.replace(/\sDC\s+\S+\s*$/, ' DC *') : line;
    })
    .join('\n');
}

export class CircuitSimulationService {
  /**
   * The last REAL transient capture published, kept for the oscilloscope
   * (`scopeWaveforms`) across the operating points solved after it.
   *
   * A pad-state solve of a step-response or scope deck is an operating point:
   * no time axis comes back, but `loadedContext.analysisKind` is still 'tran'.
   * Publishing nothing meant every GPIO edge blanked the scope's analog trace
   * until the next full tick. Publishing this capture AS the state's
   * (`timeWaveforms`, which it was until velxio/velxio-prod#153) was worse:
   * every reader that prefers a capture read the circuit as it was when the
   * deck was built, so with any capacitor on the canvas an LED froze at its
   * brightness of that moment and analogRead at its value.
   */
  private lastTimeWaveforms: TimeWaveforms | undefined;

  /**
   * How a pad state is solved on the loaded deck: the deck's own transient
   * when its sources move by themselves (AnalysisMode.timeVarying), an
   * operating point otherwise.
   */
  private padStateAnalysis: import('./ports/SolverPort').SolveAnalysis = { kind: 'op' };

  /**
   * Every use of the solver goes through here, one at a time: a rebuild,
   * the solve of a pad state, the publish of a window. The engine is one
   * instance with one loaded deck; two of these interleaving would alter
   * sources under each other.
   */
  private chain: Promise<void> = Promise.resolve();
  /** A tick is already queued behind the running work; more fold into it. */
  private tickQueued = false;

  /**
   * Last loaded circuit context — what a solve's vectors are read with.
   */
  private loadedContext: {
    pinNetMap: Map<string, string>;
    nets: string[];
    voltageSources: string[];
    analysisKind: 'op' | 'tran' | 'ac';
    sourcedNets: Set<string>;
  } | null = null;

  // ── The pads: the MCU-driven V-sources of the loaded deck ────────────
  //
  // The netlist stamps one V-source per board pin that is an output and
  // wired to something (`V_<board>_<pin>`, NetlistBuilder). An MCU edge is
  // a new level on one of them. The service does not solve on the edge: it
  // records the level and the time on the timeline, and every
  // PUBLISH_WINDOW_MS it solves the states the window went through (each
  // distinct state once, cached) and publishes their time-weighted set.
  // What this buys over "solve the edge": a 50 ms pulse is a state worth
  // 50 ms whatever the solver was doing when it started; a software PWM is
  // a state worth its duty; a scan over sixteen LEDs is sixteen states that
  // are solved once and then only looked up. Before this, the edge that
  // landed while a solve ran was queued last-state-wins per pin and its own
  // falling edge overwrote it, so on the Mega 16-LED bar only the LEDs at
  // the turnarounds ever lit.

  /** V-source name of each pad as the deck emits it. */
  private padSources: string[] = [];
  /** `${boardId}|${pinName}` → index into padSources. */
  private padIndex = new Map<string, number>();
  /**
   * The hardware-PWM pads of the deck that drive a static load
   * (BuildNetlistResult.staticPads), with the duty and HIGH level the deck was
   * built with. The deck holds such a pad at its mean, duty * HIGH, which is
   * what the instantaneous snapshot keeps showing (a logic input, an ADC or a
   * pin resolver on that net reads what it always read). What the circuit
   * really goes through is the pad at HIGH for the duty and at 0 V for the
   * rest, and that is the window published with it (see pwmSplit): an LED
   * under PWM carries its full current for the duty and none otherwise, while
   * at the mean voltage its current collapses (velxio/velxio-prod#152).
   */
  private pwmPads: Array<{ index: number; duty: number; high: number }> = [];
  /** The loaded deck with its pad levels blanked (deckShapeOf): a rebuild
   *  of the same shape keeps the state cache (see loadPads). */
  private deckShape: string | null = null;
  /** What the solver's pad sources hold right now; null = unknown, alter all. */
  private solverLevels: number[] | null = null;
  /** The levels the pads held over time since the last publish. */
  private timeline: PadTimeline | null = null;
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  /** True between windows of a run of edges: the next edge must not
   *  publish on its own, the window will. */
  private streaming = false;
  /**
   * The last window closed on one state of the pads (or a rebuild just
   * published the state they hold), and no edge came since. The time since
   * then is that state, which the canvas shows on its own, so it belongs to
   * no window: the next edge opens its window at itself (PadTimeline.
   * restartAt). Set when a window closes, not when its publish lands, which
   * on a slow solver comes after the next edge.
   */
  private settled = true;
  /** Solves by pad state, insertion-ordered so eviction drops the oldest. */
  private cache = new Map<string, StateVectors>();
  /**
   * When each pad without a source in the deck last asked for a rebuild.
   * A rebuild may run at a moment the pad is not an output (the board is
   * being reset for Run, the engine has not started) and learn nothing, so
   * "once per deck" left a pad unhealed for good: on the Mega 16-LED bar
   * the first burst of edges landed during the Run reset, the deck that
   * followed had no pads, and no edge was ever let through again. A pad
   * asks again after HEAL_RETRY_MS; an unwired pin can only cost a
   * rebuild that often, and in steady state the connector does not even
   * subscribe to unwired pins (pinsInCircuit), so the storm this bounds is
   * the window before the first solve.
   */
  private healRequests = new Map<string, number>();
  private static readonly HEAL_RETRY_MS = 250;
  /**
   * The last level every pad reported, keyed like padIndex, with the time.
   * A rebuild collects pin states before it solves; an edge that lands while
   * it solves is in neither the deck nor the new timeline, and this is what
   * puts it back.
   */
  private recentLevels = new Map<string, { volts: number; at: number }>();
  private rebuildStartedAt = 0;

  /** How often the window closes and publishes while pads keep changing. */
  static readonly PUBLISH_WINDOW_MS = 33;
  /**
   * Distinct pad states solved per window, longest-held first (the latest
   * state is always solved). A window with more distinct states than this
   * is published from the ones solved, weights renormalised, which is the
   * bound on solver duty under a storm of edges; the cache makes a
   * periodic pattern free after its first period.
   */
  static readonly MAX_STATE_SOLVES_PER_WINDOW = 4;
  private static readonly CACHE_LIMIT = 512;
  /**
   * Samples (time points times vectors) the cached captures may hold
   * together, about 16 MB of numbers. A deck whose pad states are solved as
   * transients caches a capture per state; past this the oldest go, and the
   * state is solved again the next time it is published.
   */
  private static readonly CACHE_CAPTURE_SAMPLES = 2_000_000;

  /** Diagnostics read by `__spiceDebug()`: a meter that flips between two
   *  supply voltages, or a pin that seems to ignore its edges, is usually
   *  one of these climbing when it should not. */
  rebuildCount = 0;
  edgeCount = 0;
  stateSolveCount = 0;
  cacheHitCount = 0;
  windowCount = 0;
  lastRebuildAt = 0;

  /** Set by `stop()`. Once true, nothing schedules solver work again. */
  private stopped = false;

  constructor(
    private readonly simStore: SimulatorStorePort,
    private readonly electricalStore: ElectricalStorePort,
    private readonly scheduler: MixedModeSchedulerPort,
    private readonly options: ServiceOptions,
  ) {}

  /**
   * Permanently stop the orchestration loop. Work already on the chain
   * still completes (its Promise was already scheduled), but no further
   * tick, window or edge schedules any. A test fixture that disposes the
   * scheduler without this would have the next window throw "call
   * loadCircuit first" from a timer, forever.
   */
  stop(): void {
    this.stopped = true;
    this.tickQueued = false;
    this.streaming = false;
    if (this.windowTimer !== null) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
    this.timeline = null;
    this.cache.clear();
    this.deckShape = null;
    this.pwmPads = [];
    this.healRequests.clear();
    this.recentLevels.clear();
  }

  /** What `__spiceDebug()` shows of the edge path: where the edges stand
   *  between the pads and the solver when something looks stuck. */
  debugState(): Record<string, unknown> {
    return {
      pads: this.padSources.length,
      padSources: this.padSources,
      deckSources: this.loadedContext?.voltageSources.length ?? null,
      analysis: this.loadedContext?.analysisKind ?? null,
      tickQueued: this.tickQueued,
      busy: this.busy,
      windowOpen: this.windowTimer !== null,
      streaming: this.streaming,
      pendingEdges: this.timeline?.pending() ?? null,
      currentLevels: this.timeline?.current() ?? null,
      cacheSize: this.cache.size,
      lastSolve: (() => {
        const r = this.scheduler.getLastResult();
        return r ? { solveMs: Math.round(r.solveMs), vectors: r.vectors.size, timing: r.timing } : null;
      })(),
      lastRebuildMs: Math.round(this.lastRebuildMs),
      maxRebuildMs: Math.round(this.maxRebuildMs),
      lastStateSolveMs: Math.round(this.lastStateSolveMs),
      lastStateSolveBreakdown: this.lastStateSolveBreakdown,
      maxStateSolveMs: Math.round(this.maxStateSolveMs),
      healRequests: [...this.healRequests.keys()],
      stopped: this.stopped,
      trace: this.trace,
    };
  }

  /** True while a chained piece of solver work runs. */
  private busy = false;
  /** The last rebuilds and heals, for `debugState()`. */
  private trace: Array<Record<string, unknown>> = [];
  private note(entry: Record<string, unknown>): void {
    this.trace.push({ at: Math.round(nowMs()), ...entry });
    if (this.trace.length > 40) this.trace.shift();
  }

  /** Queue `fn` behind whatever the solver is doing. Never rejects. */
  private run(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(async () => {
      this.busy = true;
      try {
        await fn();
      } finally {
        this.busy = false;
      }
    });
    this.chain = next.catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[circuit-sim] solver work failed:', err);
    });
    return this.chain;
  }

  /** Full rebuild + solve of the deck, coalesced: ticks asked for while one
   *  runs fold into a single one after it. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (
      digitalGatesEnabled() &&
      isAllDigital((this.simStore.getState() as { components: unknown[] }).components as never[])
    ) {
      return;
    }
    if (this.tickQueued) return;
    this.tickQueued = true;
    await this.run(async () => {
      this.tickQueued = false;
      if (this.stopped) return;
      try {
        await this.runSolve();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[circuit-sim] solve failed:', err);
      }
    });
  }

  /**
   * An MCU pad took a new level.
   *
   * `guestMs` is the board's own clock at the edge when the engine has one
   * (PadTimeline places the edges of one execution burst by it); null means
   * arrival time, exact to a frame. The level goes on the timeline; the
   * window that is open, or the one this edge opens, publishes it. The
   * first edge after idle is also answered right away so a single click
   * shows at solver latency, not a window later. An edge that comes after
   * the last window closed on one state opens its window at itself (see
   * `settled`).
   *
   * A pad with no source in the deck (the netlist was built before the
   * sketch wrote it, or it is wired to nothing) asks for a rebuild, at
   * most once per HEAL_RETRY_MS: the rebuild reads the live pin states,
   * so it carries the level. See `healRequests` for why not once per deck.
   */
  async handleMcuEdge(
    boardId: string, pinName: string, state: boolean, vcc: number,
    guestMs: number | null = null,
  ): Promise<void> {
    if (this.stopped) return;
    const key = `${boardId}|${pinName}`;
    const volts = state ? vcc : 0;
    const at = nowMs();
    this.recentLevels.set(key, { volts, at });
    const index = this.padIndex.get(key);
    if (index === undefined || !this.timeline) {
      if (!this.loadedContext) {
        void this.tick();
        return;
      }
      const asked = this.healRequests.get(key);
      if (asked !== undefined && at - asked < CircuitSimulationService.HEAL_RETRY_MS) return;
      this.healRequests.set(key, at);
      this.note({ heal: key, tickQueued: this.tickQueued, busy: this.busy });
      void this.tick();
      return;
    }
    this.edgeCount++;
    const opens = this.windowTimer === null;
    // The first edge after a settled spell starts the window it opens: from
    // the last close it was mostly the state before the edge, and the LED of
    // every Blink fell back to its old brightness for one window after each
    // toggle (see `settled`).
    if (opens && this.settled) this.timeline.restartAt(at);
    this.settled = false;
    this.timeline.record({ index, volts, wallMs: at, guestMs, board: boardId });
    if (opens) {
      this.windowTimer = setTimeout(() => this.closeWindow(), CircuitSimulationService.PUBLISH_WINDOW_MS);
      if (!this.streaming) await this.run(() => this.publishInstant());
    }
  }

  /** Answer the pads' current state now, outside any window. */
  private async publishInstant(): Promise<void> {
    if (this.stopped || !this.timeline || !this.loadedContext) return;
    const levels = this.timeline.current();
    const key = stateKey(levels);
    if (this.pwmSplit(levels)) {
      const ms = CircuitSimulationService.PUBLISH_WINDOW_MS;
      await this.publishStates([{ key, levels, ms }], { key, levels, ms: 0 }, ms);
      return;
    }
    const vec = await this.vectorsFor(levels, key);
    if (!vec) return;
    this.adopt(vec);
    this.publish(vec, undefined);
  }

  private closeWindow(): void {
    this.windowTimer = null;
    if (this.stopped || !this.timeline) return;
    const timeline = this.timeline;
    const w = timeline.close(nowMs());
    this.windowCount++;
    this.settled = w.states.length === 1;
    // The publish waits behind whatever the solver queue already holds, and
    // that can be a rebuild. A rebuild replaces the pads (loadPads), and the
    // window's levels are indexed by the OLD ones: solved against the new
    // deck they pair the wrong source with each level, and a pad the new deck
    // added gets `undefined` ("no such vector undefined"). The rebuild already
    // published the state the pads hold, and anything recorded during it went
    // onto the new timeline, so a stale window has nothing left to say.
    void this.run(() => (this.timeline === timeline ? this.publishWindow(w) : Promise.resolve()));
  }

  private async publishWindow(w: WindowResult): Promise<void> {
    if (this.stopped || !this.loadedContext) return;
    if (!(await this.publishStates(w.states, w.latest, w.endMs - w.startMs))) return;
    // Another window follows when this one mixed states or edges already
    // arrived for the next: the publish after a pulse must land on the
    // level the pads hold, not stay on the mix that included the pulse.
    const more = w.states.length > 1 || (this.timeline?.pending() ?? 0) > 0;
    this.streaming = more;
    if (more && !this.stopped && this.windowTimer === null) {
      this.windowTimer = setTimeout(() => this.closeWindow(), CircuitSimulationService.PUBLISH_WINDOW_MS);
    }
  }

  /**
   * Publish the states the pads held over `windowMs`, time-weighted, with
   * `latest` as the instantaneous snapshot. Each state is first split into
   * the HIGH and LOW states its static PWM pads went through (pwmSplit). The
   * longest-held states are solved: every one the cache already holds, and
   * at most MAX_STATE_SOLVES_PER_WINDOW that it does not, which is the bound
   * on solver duty; the latest is always solved. False when the latest could
   * not be (nothing was published).
   */
  private async publishStates(
    states: ReadonlyArray<WindowState>,
    latestState: WindowState,
    windowMs: number,
  ): Promise<boolean> {
    const ranked = this.splitStates(states.filter((s) => s.ms > 0)).sort((a, b) => b.ms - a.ms);
    const chosen: WindowState[] = [];
    let solves = CircuitSimulationService.MAX_STATE_SOLVES_PER_WINDOW;
    for (const s of ranked) {
      if (this.cache.has(s.key)) chosen.push(s);
      else if (solves > 0) {
        chosen.push(s);
        solves--;
      }
    }
    const latestSplit = this.pwmSplit(latestState.levels) !== null;
    if (!chosen.some((s) => s.key === latestState.key)) {
      // A split latest state's time is its split states' (counted above).
      chosen.push(latestSplit ? { ...latestState, ms: 0 } : latestState);
    }
    const solved: Array<{ state: WindowState; vec: StateVectors }> = [];
    for (const state of chosen) {
      const vec = await this.vectorsFor(state.levels, state.key);
      if (vec) solved.push({ state, vec });
    }
    const latest = solved.find((s) => s.state.key === latestState.key);
    if (!latest) return false;
    this.adopt(latest.vec);
    const total = solved.reduce((acc, s) => acc + s.state.ms, 0);
    const window: SolveWindow = {
      ms: windowMs,
      states: solved
        .filter((s) => s.state.ms > 0 || s === latest)
        .map((s) => ({
          weight: total > 0 ? s.state.ms / total : s === latest ? 1 : 0,
          ms: s.state.ms,
          levels: this.levelsRecord(s.state.levels),
          nodeVoltages: s.vec.nodeVoltages,
          branchCurrents: s.vec.branchCurrents,
        })),
    };
    // A latest state whose PWM pads sit at their mean is the snapshot the
    // level readers expect, not a state the circuit is ever in: its capture
    // is not published as the circuit's (the window is the circuit).
    this.publish(latest.vec, window, latestSplit);
    return true;
  }

  /**
   * The states the circuit really goes through while the pads hold `levels`,
   * with their shares of the time, or null when no static PWM pad holds its
   * mean in them (see pwmPads). The timer channels of a PWM peripheral start
   * their periods together, so over one period every such pad is HIGH from
   * the start until its duty: the shares are the steps between the sorted
   * duties, and each pad is HIGH for exactly its duty, alone or not.
   */
  private pwmSplit(levels: readonly number[]): Array<{ levels: number[]; weight: number }> | null {
    const held = this.pwmPads.filter(
      (p) => p.duty > 0 && p.duty < 1 && levels[p.index] === p.duty * p.high,
    );
    if (held.length === 0) return null;
    const lv = levels.slice();
    for (const p of held) lv[p.index] = p.high;
    const out: Array<{ levels: number[]; weight: number }> = [];
    let cursor = 0;
    for (const p of [...held].sort((a, b) => a.duty - b.duty)) {
      if (p.duty > cursor) out.push({ levels: lv.slice(), weight: p.duty - cursor });
      lv[p.index] = 0;
      cursor = Math.max(cursor, p.duty);
    }
    if (cursor < 1) out.push({ levels: lv.slice(), weight: 1 - cursor });
    return out;
  }

  /** Every state with its static PWM pads split (pwmSplit), merged by key. */
  private splitStates(states: ReadonlyArray<WindowState>): WindowState[] {
    const out = new Map<string, WindowState>();
    const add = (levels: number[], ms: number) => {
      const key = stateKey(levels);
      const seen = out.get(key);
      if (seen) seen.ms += ms;
      else out.set(key, { key, levels, ms });
    };
    for (const s of states) {
      const split = this.pwmSplit(s.levels);
      if (!split) add(s.levels.slice(), s.ms);
      else for (const sub of split) add(sub.levels, s.ms * sub.weight);
    }
    return [...out.values()];
  }

  /** The solve for a pad state: from the cache, or the engine brought to
   *  that state (every pad whose level differs from what it holds) and
   *  resolved once. */
  private async vectorsFor(levels: number[], key: string): Promise<StateVectors | null> {
    const hit = this.cache.get(key);
    if (hit) {
      this.cacheHitCount++;
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const changes: Array<{ source: string; volts: number }> = [];
    for (let i = 0; i < this.padSources.length; i++) {
      if (this.solverLevels === null || this.solverLevels[i] !== levels[i]) {
        changes.push({ source: this.padSources[i]!, volts: levels[i]! });
      }
    }
    const started = nowMs();
    let alterMs = 0;
    let resolveMs = 0;
    const analysis = this.padStateAnalysis;
    try {
      this.solverLevels = levels.slice();
      if (this.scheduler.solvePadState) {
        await this.scheduler.solvePadState(changes, analysis);
      } else {
        if (changes.length > 0) await this.scheduler.alterSources(changes);
        alterMs = nowMs() - started;
        if (analysis.kind === 'tran') await this.scheduler.resolveTran(analysis.step, analysis.stop);
        else await this.scheduler.resolveDc();
      }
      resolveMs = nowMs() - started - alterMs;
      this.stateSolveCount++;
      this.lastStateSolveMs = nowMs() - started;
      if (this.lastStateSolveMs > this.maxStateSolveMs) this.maxStateSolveMs = this.lastStateSolveMs;
    } catch (err) {
      this.solverLevels = null;
      // eslint-disable-next-line no-console
      console.warn('[circuit-sim] pad-state solve failed:', err);
      return null;
    }
    const result = this.scheduler.getLastResult();
    if (!result || !this.loadedContext) return null;
    const tExtract = nowMs();
    const vec = this.extract(result, this.loadedContext);
    this.lastStateSolveBreakdown = {
      alterMs: Math.round(alterMs), resolveMs: Math.round(resolveMs), extractMs: Math.round(nowMs() - tExtract),
      alters: changes.length,
    };
    this.remember(key, vec);
    return vec;
  }

  /** Cache a pad state's solve, within the entry and capture budgets
   *  (oldest out first). */
  private remember(key: string, vec: StateVectors): void {
    this.cache.delete(key);
    this.cache.set(key, vec);
    if (this.cache.size > CircuitSimulationService.CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    const samplesOf = (v: StateVectors): number =>
      v.timeWaveforms
        ? v.timeWaveforms.time.length * (1 + v.timeWaveforms.nodes.size + v.timeWaveforms.branches.size)
        : 0;
    let held = 0;
    for (const v of this.cache.values()) held += samplesOf(v);
    for (const [k, v] of this.cache) {
      if (held <= CircuitSimulationService.CACHE_CAPTURE_SAMPLES) break;
      if (k === key) continue; // the state being published stays
      const s = samplesOf(v);
      if (s === 0) continue;
      this.cache.delete(k);
      held -= s;
    }
  }

  /** The scheduler's per-pin voltages follow what is published. */
  private adopt(vec: StateVectors): void {
    if (this.scheduler.getLastResult() !== vec.result) this.scheduler.adoptResult?.(vec.result);
  }

  private levelsRecord(levels: readonly number[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (let i = 0; i < this.padSources.length; i++) out[this.padSources[i]!.toLowerCase()] = levels[i]!;
    return out;
  }

  /**
   * Read the pads of a freshly built deck: which sources are MCU pins, in
   * what order, at what level. Resets the timeline, and the cache unless
   * `sameShape` says the deck differs from the last one only in the levels
   * its pads were built at (a new PWM duty): a state of the pads is solved
   * the same on both, so every cached solve still holds. A level reported
   * while the rebuild ran goes back on the new timeline.
   */
  private loadPads(
    boards: ReadonlyArray<{ id: string; vcc: number; pins: Record<string, { type: string; v?: number; duty?: number }> }>,
    voltageSources: readonly string[],
    staticPads: ReadonlySet<string>,
    sameShape: boolean,
  ): void {
    const emitted = new Map(voltageSources.map((vs) => [vs.toLowerCase(), vs] as const));
    const sources: string[] = [];
    const index = new Map<string, number>();
    const levels: number[] = [];
    const pwm: Array<{ index: number; duty: number; high: number }> = [];
    for (const board of boards) {
      for (const [pinName, state] of Object.entries(board.pins)) {
        const lower = `v_${sanitizeSpiceId(board.id)}_${sanitizeSpiceId(pinName)}`.toLowerCase();
        const name = emitted.get(lower);
        if (!name) continue;
        if (state.type === 'pwm' && staticPads.has(lower)) {
          pwm.push({ index: sources.length, duty: state.duty ?? 0, high: board.vcc });
        }
        index.set(`${board.id}|${pinName}`, sources.length);
        sources.push(name);
        levels.push(state.type === 'digital' ? (state.v ?? 0) : (state.duty ?? 0) * board.vcc);
      }
    }
    const samePads = sameShape && sources.length === this.padSources.length && sources.every((s, i) => s === this.padSources[i]);
    this.padSources = sources;
    this.padIndex = index;
    this.pwmPads = pwm;
    this.solverLevels = levels.slice();
    if (!samePads) this.cache.clear();
    const now = nowMs();
    this.timeline = new PadTimeline(levels, now);
    for (const [key, i] of index) {
      const recent = this.recentLevels.get(key);
      if (recent && recent.at >= this.rebuildStartedAt && recent.volts !== levels[i]) {
        this.timeline.record({ index: i, volts: recent.volts, wallMs: now, guestMs: null, board: key.slice(0, key.indexOf('|')) });
      }
    }
    // The rebuild publishes the state the pads hold, unless an edge it put
    // back opens a window of its own.
    this.settled = this.timeline.pending() === 0;
    if (this.timeline.pending() > 0 && this.windowTimer === null && !this.stopped) {
      this.windowTimer = setTimeout(() => this.closeWindow(), CircuitSimulationService.PUBLISH_WINDOW_MS);
    }
  }

  /** Milliseconds of the last rebuild (load + solve) and state solve, and
   *  the slowest of each, for `debugState()`. */
  lastRebuildMs = 0;
  maxRebuildMs = 0;
  lastStateSolveMs = 0;
  maxStateSolveMs = 0;
  lastStateSolveBreakdown: Record<string, number> | null = null;

  private async runSolve(): Promise<void> {
    this.rebuildCount++;
    this.lastRebuildAt = Date.now();
    this.rebuildStartedAt = nowMs();
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
    const { netlist, pinNetMap, nets, voltageSources, sourcedNets, staticPads } = buildNetlist(input);
    const padNames = new Set<string>();
    for (const b of input.boards) {
      for (const [pin, st] of Object.entries(b.pins)) {
        if (st.type !== 'input') padNames.add(`v_${sanitizeSpiceId(b.id)}_${sanitizeSpiceId(pin)}`.toLowerCase());
      }
    }
    const shape = deckShapeOf(netlist, padNames);
    this.note({
      rebuild: this.rebuildCount,
      collected: Object.fromEntries(snap.boards.map((b) => [b.id, Object.keys(b.pinStates as object).length])),
      sources: voltageSources.length,
    });

    // Ask the scheduler for every net voltage + every V-source branch
    // current so instruments (ammeters, LED brightness) have data.
    const extraVectors: string[] = [];
    for (const net of nets) extraVectors.push(`v(${net})`);
    for (const vs of voltageSources) extraVectors.push(`i(${vs.toLowerCase()})`);
    this.scheduler.setExtraVectorsOfInterest?.(extraVectors);

    const loadStart = nowMs();
    await this.scheduler.loadCircuit(netlist, pinNetMap);
    const loadMs = nowMs() - loadStart;
    if (input.analysis.kind === 'tran') {
      await this.scheduler.resolveTran(input.analysis.step, input.analysis.stop);
    } else {
      await this.scheduler.resolveDc();
    }
    this.lastRebuildMs = nowMs() - this.rebuildStartedAt;
    if (this.lastRebuildMs > this.maxRebuildMs) this.maxRebuildMs = this.lastRebuildMs;
    this.note({ rebuilt: this.rebuildCount, ms: Math.round(this.lastRebuildMs), loadMs: Math.round(loadMs) });

    // A pad that could not be healed on the old deck gets another chance
    // right away when the deck's sources change.
    const sourcesChanged =
      this.loadedContext === null ||
      this.loadedContext.voltageSources.length !== voltageSources.length ||
      this.loadedContext.voltageSources.some((vs, i) => vs !== voltageSources[i]);
    if (sourcesChanged) this.healRequests.clear();

    this.loadedContext = {
      pinNetMap,
      nets,
      voltageSources,
      analysisKind: input.analysis.kind,
      sourcedNets,
    };
    this.padStateAnalysis =
      input.analysis.kind === 'tran' && input.analysis.timeVarying
        ? { kind: 'tran', step: input.analysis.step, stop: input.analysis.stop }
        : { kind: 'op' };
    const sameShape = shape === this.deckShape;
    this.deckShape = shape;
    this.loadPads(
      input.boards as unknown as Parameters<CircuitSimulationService['loadPads']>[0],
      voltageSources,
      staticPads,
      sameShape,
    );
    const result = this.scheduler.getLastResult();
    if (!result) return;
    const vec = this.extract(result, this.loadedContext);
    const levels = (this.solverLevels ?? []).slice();
    const key = stateKey(levels);
    this.remember(key, vec);
    if (this.pwmSplit(levels)) {
      // The deck holds its static PWM pads at their mean; publish what the
      // circuit goes through with them (see pwmPads).
      const ms = CircuitSimulationService.PUBLISH_WINDOW_MS;
      await this.publishStates([{ key, levels, ms }], { key, levels, ms: 0 }, ms);
      return;
    }
    this.publish(vec, undefined);
  }

  /** Every net voltage and V-source branch current of a result. */
  private extract(
    result: import('./ports/SolverPort').SolveResult,
    ctx: NonNullable<CircuitSimulationService['loadedContext']>,
  ): StateVectors {
    const nodeVoltages: Record<string, number> = {};
    const branchCurrents: Record<string, number> = {};
    for (const net of ctx.nets) {
      const vec = result.vectors.get(`v(${net})`);
      if (vec && vec.real.length > 0) nodeVoltages[net] = vec.real[vec.real.length - 1]!;
    }
    for (const vs of ctx.voltageSources) {
      const vec = result.vectors.get(`i(${vs.toLowerCase()})`);
      if (vec && vec.real.length > 0) branchCurrents[vs.toLowerCase()] = vec.real[vec.real.length - 1]!;
    }
    let timeWaveforms: TimeWaveforms | undefined;
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
    }
    return { nodeVoltages, branchCurrents, timeWaveforms, warnings: result.warnings, result };
  }

  /** Publish one state as the instantaneous snapshot, with the window it
   *  closes when there is one. `synthetic`: the state is a PWM pad's mean,
   *  which the circuit is never in (see pwmPads), so its capture is not the
   *  circuit's. */
  private publish(vec: StateVectors, window: SolveWindow | undefined, synthetic = false): void {
    const ctx = this.loadedContext;
    if (!ctx) return;
    // The capture published is this state's own or none (see
    // ElectricalSnapshot.timeWaveforms); the scope keeps the latest one.
    const timeWaveforms = ctx.analysisKind === 'tran' && !synthetic ? vec.timeWaveforms : undefined;
    if (ctx.analysisKind !== 'tran') this.lastTimeWaveforms = undefined;
    else if (vec.timeWaveforms) this.lastTimeWaveforms = vec.timeWaveforms;
    this.electricalStore.publish({
      nodeVoltages: vec.nodeVoltages,
      branchCurrents: vec.branchCurrents,
      window,
      pinNetMap: ctx.pinNetMap,
      analysisMode: ctx.analysisKind,
      timeWaveforms,
      scopeWaveforms: this.lastTimeWaveforms,
      warnings: vec.warnings,
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
