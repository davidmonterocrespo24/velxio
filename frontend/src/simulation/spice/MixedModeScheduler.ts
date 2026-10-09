/**
 * MixedModeScheduler — voltage event bus + solver orchestrator.
 *
 * Architecture (Phase 1c onwards):
 *
 *   ┌─────────────────────────────┐
 *   │ CircuitSimulationService    │  builds netlist, calls scheduler
 *   │  (or any caller of the      │  loadCircuit + resolveDc / onMcu
 *   │   public methods below)     │
 *   └────────────┬────────────────┘
 *                │
 *                ▼
 *   ┌─────────────────────────────┐
 *   │ MixedModeScheduler          │
 *   │  • injects a SolverPort     │  ── solver.loadCircuit / solve / alter
 *   │  • caches voltages          │
 *   │  • fans out to subscribers  │  ── SpiceResolvedPinResolver.onChange
 *   └────────────┬────────────────┘
 *                │ SolverPort
 *                ▼
 *   ┌─────────────────────────────┐
 *   │ NgSpiceWorkerAdapter (prod) │
 *   │ NgSpiceNodeAdapter (tests)  │
 *   │ FakeSolverAdapter (unit)    │
 *   └─────────────────────────────┘
 *
 * The scheduler does NOT know about ngspice, WASM, or Web Workers —
 * those are adapter concerns.  Domain code (PinResolver, components)
 * sees only the SpiceVoltageSource interface (`subscribe`,
 * `getCurrentVoltage`).
 *
 * The cache + fan-out semantics live here because they're tied to
 * the (componentId, componentPinName) pair, which is a domain
 * concept.  The solver speaks SPICE-net names; the scheduler maps
 * between the two via the pinNetMap.
 */

import type { SolverPort, SolveAnalysis } from './ports/SolverPort';
import { NgSpiceWorkerAdapter } from './adapters/NgSpiceWorkerAdapter';
import { sanitizeSpiceId } from './NetlistBuilder';
import type { PinState, SpiceVoltageSource } from '../PinResolver';

/**
 * Identity of a "pin of interest" — a place a SpiceResolvedPinResolver
 * is watching for voltage changes.
 */
export interface NodeSubscription {
  componentId: string;
  componentPinName: string;
  cb: (state: PinState, voltage: number) => void;
}

type SubscriptionToken = number;

/** Voltage cache key = `${componentId}|${componentPinName}`. */
function pinKey(componentId: string, componentPinName: string): string {
  return `${componentId}|${componentPinName}`;
}

class MixedModeSchedulerImpl implements SpiceVoltageSource {
  private solver: SolverPort | null = null;
  private solverFactory: () => SolverPort = () => new NgSpiceWorkerAdapter();
  private nextToken: SubscriptionToken = 1;
  private subscriptions = new Map<SubscriptionToken, NodeSubscription>();
  private voltages = new Map<string, number>();
  /** `${componentId}:${pinName}` → SPICE net name (from NetlistBuilder). */
  private pinNetMap = new Map<string, string>();
  private running = false;
  private initPromise: Promise<void> | null = null;

  /** True while the scheduler is actively driving the solver. */
  isRunning(): boolean {
    return this.running;
  }

  /** Lazy-boot the solver (idempotent). */
  async start(): Promise<void> {
    if (this.running) return;
    await this.ensureSolver();
    this.running = true;
  }

  private async ensureSolver(): Promise<SolverPort> {
    if (!this.solver) this.solver = this.solverFactory();
    if (!this.initPromise) this.initPromise = this.solver.init();
    await this.initPromise;
    return this.solver;
  }

  /**
   * Load a SPICE netlist plus the (component, pin) → SPICE-net map
   * produced by `NetlistBuilder.buildNetlist`.  Replaces any
   * previously loaded circuit; clears the voltage cache.
   */
  async loadCircuit(netlist: string, pinNetMap: Map<string, string>): Promise<void> {
    const solver = await this.ensureSolver();
    await solver.loadCircuit(netlist);
    this.pinNetMap = new Map(pinNetMap);
    this.voltages.clear();
  }

  /**
   * Run a `.op` solve and publish voltages for every (component, pin)
   * currently in pinNetMap.  Ground pins (net = `0`) publish 0 V
   * without a vector read.
   */
  async resolveDc(): Promise<void> {
    if (!this.solver) {
      throw new Error('MixedModeScheduler.resolveDc(): call loadCircuit first');
    }
    await this.solveAndPublish({ kind: 'op' });
  }

  /**
   * Run a `.tran` solve and publish the steady-state (last-sample)
   * voltage for every (component, pin) in pinNetMap.  The full
   * waveform is available via `getLastResult()` for callers that need
   * the time series.
   */
  async resolveTran(step: string, stop: string): Promise<void> {
    if (!this.solver) {
      throw new Error('MixedModeScheduler.resolveTran(): call loadCircuit first');
    }
    await this.solveAndPublish({ kind: 'tran', step, stop });
  }

  private lastResult: import('./ports/SolverPort').SolveResult | null = null;

  /**
   * Last full solve result, for callers that need the raw vectors
   * (e.g. CircuitSimulationService when populating useElectricalStore).
   */
  getLastResult(): import('./ports/SolverPort').SolveResult | null {
    return this.lastResult;
  }

  private extraVectors: readonly string[] = [];

  /**
   * Let an orchestrator (CircuitSimulationService) ask the solver
   * for vectors beyond the pin-net set — branch currents, internal
   * nets, etc.  Replaces any previous set; pass [] to clear.
   */
  setExtraVectorsOfInterest(vectors: readonly string[]): void {
    this.extraVectors = vectors;
  }

  private async solveAndPublish(analysis: SolveAnalysis): Promise<void> {
    const solver = this.solver;
    if (!solver) return;
    const result = await solver.solve(analysis, {
      vectorsOfInterest: this.vectorsOfInterest(),
    });
    this.adoptResult(result);
  }

  /** Every (component, pin) net voltage plus what the service asked for. */
  private vectorsOfInterest(): string[] {
    const wanted = new Set<string>();
    for (const net of this.pinNetMap.values()) {
      if (net !== '0') wanted.add(`v(${net})`);
    }
    for (const v of this.extraVectors) wanted.add(v);
    return Array.from(wanted);
  }

  /**
   * Bring the deck to a pad state and solve it: the alters, the operating
   * point and the vector reads in one round trip when the engine offers
   * it (every trip to the worker waits behind the main thread's current
   * task, tens of milliseconds while an engine runs), the three-step path
   * otherwise. Publishes like any other solve.
   */
  async solvePadState(changes: ReadonlyArray<{ source: string; volts: number }>): Promise<void> {
    const solver = this.solver;
    if (!solver) {
      throw new Error('MixedModeScheduler.solvePadState(): call loadCircuit first');
    }
    if (solver.solveAltered) {
      const result = await solver.solveAltered(changes, { kind: 'op' }, {
        vectorsOfInterest: this.vectorsOfInterest(),
      });
      this.adoptResult(result);
      return;
    }
    await this.alterSources(changes);
    await this.resolveDc();
  }

  /**
   * Make `result` the scheduler's current answer and publish every
   * (component, pin) voltage from it: the last sample per pin, the single
   * point of a .op, the steady state of a .tran. `solveAndPublish` ends
   * here; the circuit service also calls it with a result it cached for a
   * pad state the solver already answered (CircuitSimulationService's
   * state cache), so the subscribers of pin voltages (PinResolver) follow
   * the published state whether or not the engine ran for it.
   */
  adoptResult(result: import('./ports/SolverPort').SolveResult): void {
    this.lastResult = result;
    for (const [key, net] of this.pinNetMap) {
      const idx = key.indexOf(':');
      if (idx < 0) continue;
      const componentId = key.slice(0, idx);
      const pinName = key.slice(idx + 1);
      if (net === '0') {
        this.publishVoltage(componentId, pinName, 0);
        continue;
      }
      const vec = result.vectors.get(`v(${net})`);
      if (!vec) continue; // disconnected pin — leave unpublished
      const v = vec.real[vec.real.length - 1] ?? 0;
      this.publishVoltage(componentId, pinName, v);
    }
  }

  /** Stop the scheduler.  Engine stays warm so restart is cheap. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
  }

  /** Tear down the solver entirely. */
  dispose(): void {
    this.running = false;
    if (this.solver) {
      this.solver.dispose();
      this.solver = null;
    }
    this.initPromise = null;
    this.subscriptions.clear();
    this.voltages.clear();
    this.pinNetMap.clear();
    this.lastResult = null;
  }

  /**
   * Register a component pin to receive voltage events.  Implements
   * `SpiceVoltageSource` so `createSpiceResolvedPinResolver` can use
   * the scheduler directly.
   */
  subscribe(
    componentId: string,
    componentPinName: string,
    cb: (state: PinState, voltage: number) => void,
  ): () => void {
    const token = this.nextToken++;
    this.subscriptions.set(token, { componentId, componentPinName, cb });
    return () => {
      this.subscriptions.delete(token);
    };
  }

  /** Latest cached voltage for a (component, pin), or null. */
  getCurrentVoltage(componentId: string, componentPinName: string): number | null {
    const v = this.voltages.get(pinKey(componentId, componentPinName));
    return v === undefined ? null : v;
  }

  /**
   * Publish a freshly-resolved voltage and notify subscribers.
   * SpiceResolvedPinResolver does its own threshold conversion, so
   * this layer forwards the raw volts with an `'UNKNOWN'` sentinel
   * state — the resolver re-derives HIGH/LOW.
   */
  publishVoltage(componentId: string, componentPinName: string, voltage: number): void {
    this.voltages.set(pinKey(componentId, componentPinName), voltage);
    for (const sub of this.subscriptions.values()) {
      if (sub.componentId === componentId && sub.componentPinName === componentPinName) {
        sub.cb('UNKNOWN' as PinState, voltage);
      }
    }
  }

  /**
   * MCU pin transition → alter the corresponding V source + re-resolve.
   * Silent no-op when no solver has been started (lets legacy callers
   * fire without crashing).
   */
  /**
   * Set several V-sources without solving. The circuit service brings the
   * solver to a pad state in one go (every pad whose level differs from what
   * the solver holds) and then calls `resolveDc` once; `onMcuPinChange`
   * stays for callers that alter and solve one pad at a time.
   */
  async alterSources(changes: ReadonlyArray<{ source: string; volts: number }>): Promise<void> {
    if (!this.solver) return;
    if (this.solver.alterSources) {
      await this.solver.alterSources(changes);
      return;
    }
    for (const c of changes) await this.solver.alterSource(c.source, c.volts);
  }

  async onMcuPinChange(
    boardId: string,
    pinName: string,
    state: boolean,
    vcc: number,
  ): Promise<void> {
    if (!this.solver) return;
    // Must match the sanitized name NetlistBuilder emits — see comment
    // at the V-source emission site for why ngspice's `alter` command
    // can't accept hyphens.
    const sourceName = `V_${sanitizeSpiceId(boardId)}_${sanitizeSpiceId(pinName)}`;
    const voltage = state ? vcc : 0;
    await this.solver.alterSource(sourceName, voltage);
    await this.resolveDc();
  }
}

/** Singleton accessor. */
let instance: MixedModeSchedulerImpl | null = null;

export function getMixedModeScheduler(): MixedModeSchedulerImpl {
  if (!instance) instance = new MixedModeSchedulerImpl();
  return instance;
}

/** Test helper — drop the singleton so each test starts clean. */
export function __resetMixedModeScheduler(): void {
  if (instance) instance.dispose();
  instance = null;
}

/**
 * Test helper — inject a custom SolverPort factory.  Must be called
 * before any `start()` / `loadCircuit()` on the singleton.
 */
export function __setSchedulerSolverFactoryForTests(factory: () => SolverPort): void {
  const sched = getMixedModeScheduler() as unknown as {
    solverFactory: () => SolverPort;
  };
  sched.solverFactory = factory;
}

export type MixedModeScheduler = MixedModeSchedulerImpl;
