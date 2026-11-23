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
import type { NodeMemoryCell, SwitchMemoryCell, TimeWaveforms } from './types';
import { digitalGatesEnabled, isAllDigital } from '../digital/digitalGateEngine';
import { PadTimeline, stateKey, type WindowResult, type WindowState } from './PadTimeline';
import { transientShortfall } from './transientShortfall';
import { mixCaptures } from './waveformStats';
import type { SolveAnalysis, SolveResult } from './ports/SolverPort';

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
    /** Bumped by every bulk replacement of the canvas (useSimulatorStore's
     *  hydrationSeq): another circuit loaded. Optional for non-store ports. */
    hydrationSeq?: number;
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
  /** The state's own transient capture, when it was solved as one (a deck
   *  whose sources move by themselves); its scalars are the last sample. */
  timeWaveforms?: TimeWaveforms;
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
   * A state whose static PWM pads sit at their mean is never the circuit's:
   * its capture is the mix of the captures of the HIGH and LOW states the
   * pads go through, weighted by their shares of the period (mixCaptures).
   */
  timeWaveforms?: TimeWaveforms;
  /**
   * The step the circuit is taking since its pads last changed, when a
   * capacitor or an inductor was away from where the new pad state settles
   * it (velxio/velxio-prod#153): a one-shot capture (TimeWaveforms.oneShot)
   * from the state the circuit was in at the edge to where it has settled.
   * The scalar fields and the window are that settled state, the operating
   * point, which is also the circuit past the capture's end. The ADC hooks
   * read the curve at the time since the edge and the oscilloscope draws it
   * (scopeWaveforms); `timeWaveforms` stays a steady capture, so the meters,
   * the wire labels and the LEDs never read a step's tail as AC.
   *
   * A step a pushbutton or a slide switch started (and one that starts while
   * such a step is under way) is followed instead: the service publishes the
   * scalar fields along the curve, at the time since the step began, until
   * it ends, and then the operating point (velxio/velxio-prod#107). The
   * meters, the wire labels, the LEDs and the parts read it as they read any
   * publish: an RC timer started by a button lights its LED seconds later.
   */
  stepWaveforms?: TimeWaveforms;
  /**
   * When the scalar fields are a step being followed (see stepWaveforms), the
   * seconds since it began that they were read at: a moment of a transient,
   * not a state the circuit stays in. What judges a part by a state it holds
   * (a resistor's heat, an LED's overcurrent, a pin's load) does not destroy
   * or warn on such a moment alone. Absent when the scalars are an operating
   * point or a capture's last sample.
   */
  stepAtS?: number;
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
  /** `start`: ngspice's TSTART, the start of the stored window. */
  resolveTran(step: string, stop: string, start?: string): Promise<void>;
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
  /**
   * Publish every (component, pin) voltage from a net -> volts map, without
   * making anything the current result: the service follows a step with it
   * (see `follow`), so the parts that read their pins' voltages follow it
   * too. Optional for ports with no pin subscribers.
   */
  publishNetVoltages?(volts: Readonly<Record<string, number>>): void;
  /**
   * While true, a solve becomes the current result without publishing its
   * pin voltages (the parts that read them hear nothing of it);
   * publishNetVoltages publishes all the same. The service holds them while
   * it solves a step it will follow (see `holdPins`). Optional for ports
   * with no pin subscribers.
   */
  holdPinVoltages?(hold: boolean): void;
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
  /**
   * The toolbar's Stop of a board-less circuit (useElectricalStore.paused),
   * which freezes every LED and meter at what it shows. While no board is on
   * the canvas and it is true, a step being followed holds where it is, and
   * its clock with it: Run carries it on from there (velxio/velxio-prod#107).
   * With a board on the canvas the service does not read it: the flag
   * outlives the canvas it was set on.
   */
  paused?: () => boolean;
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

/**
 * A deck shape (deckShapeOf) with the state the parts with memory start in
 * blanked too: a relay's armature (the ON of its switch cards) and a latch's
 * seeds (.nodeset). Those follow what the circuit did, not what it is made of
 * (velxio/velxio-prod#109, #147).
 */
function memoryBlanked(shape: string, cells: ReadonlyArray<{ id: string }>): string {
  const switches = cells.map((c) => `s_${c.id.toLowerCase()}_`);
  return shape
    .split('\n')
    .map((line) => {
      const lower = line.toLowerCase();
      if (lower.startsWith('.nodeset')) return line.replace(/=\s*\S+/g, '=*');
      return switches.some((p) => lower.startsWith(p)) ? line.replace(/\s+ON\s*$/i, '') : line;
    })
    .join('\n');
}

/**
 * A deck shape with its memory blanked (memoryBlanked) and the values of the
 * hand-worked contacts' cards too (BuildNetlistResult.handContacts): two
 * decks of one circuit that differ only in where its pushbuttons and slide
 * switches stand. The pull-downs a floating net gets go as well: an open
 * contact is no path to ground (velxio/velxio-prod#192), so the net behind a
 * button that is not pressed gets one, and loses it when the button closes.
 */
function contactsBlanked(shape: string, contacts: ReadonlySet<string>): string {
  if (contacts.size === 0) return shape;
  return shape
    .split('\n')
    .filter((line) => !line.toLowerCase().startsWith('r_autopull_'))
    .map((line) => {
      const t = line.trim().split(/\s+/);
      return t.length === 4 && contacts.has(t[0]!.toLowerCase()) ? `${t[0]} ${t[1]} ${t[2]} *` : line;
    })
    .join('\n');
}

/**
 * A capacitor or an inductor of the loaded deck (top level, not inside a
 * subcircuit): what carries a circuit's state from one pad state to the next.
 */
interface ReactiveDevice {
  /** Card name as the deck writes it (`C_c1`, `L_l1`). */
  name: string;
  kind: 'C' | 'L';
  /** A capacitor's two nodes ('0' is ground). */
  a?: string;
  b?: string;
}

/** The top-level C and L cards of a netlist. */
export function reactiveDevicesOf(netlist: string): ReactiveDevice[] {
  const out: ReactiveDevice[] = [];
  let depth = 0;
  for (const raw of netlist.split('\n')) {
    const line = raw.trim();
    const lower = line.toLowerCase();
    if (lower.startsWith('.subckt')) depth++;
    else if (lower.startsWith('.ends')) depth = Math.max(0, depth - 1);
    if (depth > 0 || line.length === 0) continue;
    const kind = line[0]!.toUpperCase();
    if (kind !== 'C' && kind !== 'L') continue;
    const t = line.split(/\s+/);
    if (t.length < 4) continue;
    out.push(kind === 'C' ? { name: t[0]!, kind, a: t[1]!, b: t[2]! } : { name: t[0]!, kind });
  }
  return out;
}

/** The vectors that give a reactive device's state: a capacitor's node
 *  voltages, an inductor's current. */
function reactiveVectors(devices: readonly ReactiveDevice[]): string[] {
  const out = new Set<string>();
  for (const d of devices) {
    if (d.kind === 'C') {
      if (d.a && d.a !== '0') out.add(`v(${d.a})`);
      if (d.b && d.b !== '0') out.add(`v(${d.b})`);
    } else {
      out.add(`i(${d.name.toLowerCase()})`);
    }
  }
  return [...out];
}

/** Linear interpolation of `vs` on `ts` at `t`, held at both ends. */
function sampleAt(ts: ArrayLike<number>, vs: ArrayLike<number>, t: number): number {
  const n = Math.min(ts.length, vs.length);
  if (n === 0) return NaN;
  if (t <= ts[0]!) return vs[0]!;
  if (t >= ts[n - 1]!) return vs[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid]! <= t) lo = mid;
    else hi = mid;
  }
  const t0 = ts[lo]!;
  const t1 = ts[hi]!;
  return t1 > t0 ? vs[lo]! + ((vs[hi]! - vs[lo]!) * (t - t0)) / (t1 - t0) : vs[hi]!;
}

/**
 * The state of every reactive device in a result: its last sample, or the
 * sample at `t` seconds when it is a capture and `t` is given.
 */
function reactiveStateOf(
  result: SolveResult, devices: readonly ReactiveDevice[], t: number | null,
): Map<string, number> {
  const out = new Map<string, number>();
  const valueOf = (name: string): number | undefined => {
    const v = result.vectors.get(name);
    if (!v || v.real.length === 0) return undefined;
    if (t === null || result.timeAxis.length !== v.real.length) return v.real[v.real.length - 1];
    return sampleAt(result.timeAxis, v.real, t);
  };
  for (const d of devices) {
    if (d.kind === 'C') {
      const va = d.a === '0' ? 0 : valueOf(`v(${d.a})`);
      const vb = d.b === '0' ? 0 : valueOf(`v(${d.b})`);
      if (va !== undefined && vb !== undefined && Number.isFinite(va - vb)) out.set(d.name, va - vb);
    } else {
      const i = valueOf(`i(${d.name.toLowerCase()})`);
      if (i !== undefined && Number.isFinite(i)) out.set(d.name, i);
    }
  }
  return out;
}

/**
 * The state of every reactive device over the HIGH and LOW states a PWM pad
 * goes through: each one's value in each state's operating point, weighted
 * by the state's share of the period. That is where the circuit sits on
 * average while the pad is chopped: a motor's shaft at the duty-weighted
 * mean of its speeds, which is what the published window shows. The mean's
 * own operating point is a state the circuit is never in: an IRF540 gate
 * held at 2.5 V passes nothing, and a fan running at half speed stepped from
 * a standstill when the sketch then wrote it HIGH (velxio/velxio-prod#164).
 */
function mixedReactiveState(
  mix: ReadonlyArray<{ result: SolveResult; weight: number }>, devices: readonly ReactiveDevice[],
): Map<string, number> {
  const sums = new Map<string, { sum: number; weight: number }>();
  for (const { result, weight } of mix) {
    if (!(weight > 0)) continue;
    for (const [name, value] of reactiveStateOf(result, devices, null)) {
      const acc = sums.get(name) ?? { sum: 0, weight: 0 };
      acc.sum += weight * value;
      acc.weight += weight;
      sums.set(name, acc);
    }
  }
  const out = new Map<string, number>();
  for (const [name, { sum, weight }] of sums) if (weight > 0) out.set(name, sum / weight);
  return out;
}

/** The solves of a PWM split's states with their shares of the period, or
 *  undefined when one of them was not solved. */
function splitMix(
  split: ReadonlyArray<{ levels: number[]; weight: number }>,
  solved: ReadonlyArray<{ state: { key: string }; vec: { result: SolveResult } }>,
): Array<{ result: SolveResult; weight: number }> | undefined {
  const out: Array<{ result: SolveResult; weight: number }> = [];
  for (const sub of split) {
    const key = stateKey(sub.levels);
    const hit = solved.find((s) => s.state.key === key);
    if (!hit) return undefined;
    out.push({ result: hit.vec.result, weight: sub.weight });
  }
  return out;
}

/** How far a device's state may sit from another and still look the same to
 *  the eye and an ADC: 1 mV or 1 uA, plus 0.1 %. */
function reactiveTolerance(kind: 'C' | 'L', x: number, y: number): number {
  return (kind === 'C' ? 1e-3 : 1e-6) + 1e-3 * Math.max(Math.abs(x), Math.abs(y));
}

/** Two states of a device the eye and an ADC cannot tell apart. */
function sameReactiveState(kind: 'C' | 'L', x: number, y: number): boolean {
  return Math.abs(x - y) <= reactiveTolerance(kind, x, y);
}

/**
 * True when a value of `next` is more than `floor` plus 0.01 % away from the
 * one `sent` holds: what a meter's last digit or an LED's brightness shows
 * of a step being followed.
 */
function followedMoved(
  sent: Readonly<Record<string, number>>, next: Readonly<Record<string, number>>, floor: number,
): boolean {
  for (const key of Object.keys(next)) {
    const a = sent[key];
    const b = next[key]!;
    if (a === undefined) return true;
    if (Math.abs(a - b) > floor + 1e-4 * Math.max(Math.abs(a), Math.abs(b))) return true;
  }
  return false;
}

/** A device's state at every sample of a result: a capacitor's voltage, an
 *  inductor's current; null when a vector it needs is missing. */
function deviceSeries(result: SolveResult, d: ReactiveDevice): number[] | null {
  const vec = (name: string) => result.vectors.get(name)?.real;
  if (d.kind === 'L') {
    const i = vec(`i(${d.name.toLowerCase()})`);
    return i ? Array.from(i) : null;
  }
  const a = d.a === '0' ? undefined : vec(`v(${d.a})`);
  const b = d.b === '0' ? undefined : vec(`v(${d.b})`);
  if ((d.a !== '0' && !a) || (d.b !== '0' && !b)) return null;
  const n = Math.min(a?.length ?? Infinity, b?.length ?? Infinity);
  if (!Number.isFinite(n)) return null;
  const out = new Array<number>(n);
  for (let k = 0; k < n; k++) out[k] = (a ? a[k]! : 0) - (b ? b[k]! : 0);
  return out;
}

/**
 * How long a step that ran for `stopS` seconds needs to settle, judged from
 * its capture `result` against the state of the operating point it settles
 * to (`goal`): 0 when every capacitor and inductor already ends where the
 * goal has it, or when one of them went past its goal (it rings: an LC, an
 * oscillator), whose distance from the goal says nothing of when it settles
 * and whose longer run would cost as many more of its periods. Otherwise the
 * slowest one's distance from the goal is taken to shrink as it did over the
 * second half of the run, e^(-t / tau), and the answer is when that reaches
 * what sameReactiveState tolerates; a distance that did not shrink asks for
 * four times the run. The time constant the deck's parts give
 * (AnalysisMode.settleS) is the largest R times the largest C, or an L over
 * the largest R, which misses a coil's own series resistor and resistors in
 * series (velxio/velxio-prod#153).
 */
function stepNeedsS(
  result: SolveResult, devices: readonly ReactiveDevice[], goal: ReadonlyMap<string, number>, stopS: number,
): number {
  const end = reactiveStateOf(result, devices, null);
  const half = reactiveStateOf(result, devices, stopS / 2);
  let need = 0;
  for (const d of devices) {
    const target = goal.get(d.name);
    const x = end.get(d.name);
    if (target === undefined || x === undefined) continue;
    const tol = reactiveTolerance(d.kind, x, target);
    const dEnd = Math.abs(x - target);
    if (dEnd <= tol) continue;
    const series = deviceSeries(result, d);
    const side = series && series.length > 0 ? Math.sign(series[0]! - target) : 0;
    if (side !== 0 && series!.some((v) => (v - target) * side < -tol)) return 0;
    const h = half.get(d.name);
    const dHalf = h === undefined ? Infinity : Math.abs(h - target);
    const tau = dHalf > dEnd && Number.isFinite(dHalf) ? stopS / 2 / Math.log(dHalf / dEnd) : NaN;
    need = Math.max(need, Number.isFinite(tau) ? stopS + tau * Math.log(dEnd / tol) : 4 * stopS);
  }
  return need;
}

/** When a published state began: the wall clock, and the clock of the board
 *  whose pad edge began it when that board keeps one. */
interface Onset {
  wallMs: number;
  board?: string;
  guestMs?: number | null;
}

/** A step the circuit takes from where it was at a pad edge (see `step`). */
interface StepRun {
  /** The pad state it was run into (stateKey). */
  key: string;
  /** Its capture, one-shot: t = 0 is the edge (TimeWaveforms.oneShot). */
  capture: TimeWaveforms;
  /** The solver's result, for each capacitor's and inductor's state on it. */
  result: SolveResult;
  /**
   * The scalar fields follow this step in time (see `follow`): a pushbutton
   * or a slide switch started it, or it started while such a step was under
   * way (velxio/velxio-prod#107).
   */
  follow?: boolean;
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
    /** Period of the slowest periodic source of a .tran window (TimeWaveforms.period). */
    period?: number;
    /** Where the stored window starts (TSTART, seconds): taken off the time
     *  axis, so the readers get a window that starts at 0. */
    start?: number;
    sourcedNets: Set<string>;
    /** The deck's capacitors and inductors (reactiveDevicesOf). */
    reactive: ReactiveDevice[];
    /** How long a step of this deck takes to settle, when the deck is a
     *  step response (AnalysisMode.settleS); undefined otherwise. */
    settleS?: number;
    /** How long it takes to settle after a pushbutton or a slide switch
     *  changes it, when its pads drive no step (AnalysisMode.switchSettleS). */
    switchSettleS?: number;
  } | null = null;

  // ── Steps: a reactive circuit carries its state across pad edges ─────
  //
  // A deck with a capacitor or an inductor and a driven pad, and no source
  // that moves by itself, is solved as an operating point at each pad state:
  // the right answer once the circuit has settled, and the wrong one while a
  // capacitor is still charging. Through an RC of a second that was the
  // whole story: capacitor-charge-curve printed 5.000 V from its first line
  // (velxio/velxio-prod#153). So a new pad state is checked against the state
  // the circuit is in when the pads change: the capacitor voltages and the
  // inductor currents of what was published, read at that moment. When they
  // already sit where the new operating point has them (a Blink with a
  // decoupling capacitor), the operating point is the answer. When not, the
  // service runs the step: a transient from those values (`uic`, each one an
  // initial condition), run until the circuit has settled (stepNeedsS),
  // published as a one-shot capture whose t = 0 is the edge
  // (TimeWaveforms.oneShot, in ElectricalSnapshot.stepWaveforms) beside the
  // operating point, and read by the ADC hooks at the time since. Past its
  // end the circuit is at the operating point: a capture that stopped short
  // of it is not held at its last sample. The next edge starts from wherever
  // the curve has got to. Edges faster than a publish window keep the
  // operating points of the window.

  // ── Following: a step started by hand is published along its curve ───
  //
  // A step after a pad edge is read by the ADC hooks and the oscilloscope;
  // the meters, the wire labels, the LEDs and the parts read the operating
  // point it settles to (velxio/velxio-prod#153). A step that a pushbutton or
  // a slide switch starts is what a person watches instead: an RC timer that
  // lights an LED through a transistor seconds after a press lit it at once,
  // and with no board on the canvas the press was solved as an operating
  // point, with no step at all (velxio/velxio-prod#107). Such a step is run
  // (runSolve, `handStep`) and followed: every FOLLOW_MS the snapshot it was
  // published with goes out again with its scalar fields read on the curve
  // at the time since the step began, on the wall clock, until the curve
  // ends; then the operating point. A step that starts while a followed one
  // is under way (a pad edge, a relay's memory, another press) is followed
  // too: it carries the same transient on.

  /** The step being followed: the snapshot published with it (its scalars
   *  are the operating point) and the scalars sent last. */
  private following: {
    base: ElectricalSnapshot;
    /** The operating point the step settles to: the memory past its end. */
    op: SolveResult;
    step: StepRun;
    /** When it was last looked at (nowMs): a stop holds its clock from then. */
    lastAt: number;
    sent: { nodeVoltages: Record<string, number>; branchCurrents: Record<string, number> };
  } | null = null;
  private followTimer: ReturnType<typeof setTimeout> | null = null;
  /** How often a followed step is published again: the publish window's
   *  pace, about the eye's. Scalars that moved by less than
   *  sameReactiveState tolerates are not sent. */
  static readonly FOLLOW_MS = 33;
  /** When the canvas last changed (a part, a wire, a board): a press or a
   *  flip begins its step then, not when the solver gets to it. */
  private circuitChangedAt: number | null = null;
  /** The deck shape with the memory blanked (memoryBlanked), and with the
   *  hand-worked contacts blanked too (contactsBlanked): a rebuild whose
   *  first differs and whose second is the same changed only those. */
  private memoryShape: string | null = null;
  private contactShape: string | null = null;

  /** The last pad edge seen: what began the state the pads hold. */
  private lastEdge: Onset | null = null;
  /** The edge that asked for the rebuild under way, if one did. */
  private healEdge: Onset | null = null;
  /** The step published last, by pad state: a window that publishes that
   *  state again publishes the step beside its operating point. */
  private step: StepRun | null = null;
  /** What the last publish described: its operating point, and the step it
   *  published with it, for the state a later pad state starts from. A state
   *  whose static PWM pads sit at their mean also keeps the solves of the
   *  HIGH and LOW states it goes through, with their shares of the period
   *  (`mix`): the circuit is there on average, not at the mean's operating
   *  point (see stateAt). */
  private current: {
    op: SolveResult;
    step: StepRun | null;
    mix?: ReadonlyArray<{ result: SolveResult; weight: number }>;
  } | null = null;
  /** Bounds of a step's capture, in seconds: the first run within STEP_MIN_S
   *  and STEP_FIRST_MAX_S (2000 points over 30 s still draw a curve of a
   *  second), longer ones up to STEP_MAX_S. Past the end the circuit sits at
   *  its operating point; a capture that long has not settled only when a
   *  time constant is longer than about a minute and a half. */
  private static readonly STEP_MIN_S = 5e-3;
  private static readonly STEP_FIRST_MAX_S = 30;
  private static readonly STEP_MAX_S = 600;
  /** Runs of a step at most: one, and longer ones while it has not settled
   *  (stepNeedsS). */
  private static readonly STEP_RUNS = 3;
  /** Output points of a step's capture: ngspice steps finer where the
   *  circuit moves fast, so this only sets how coarse the settled tail is. */
  private static readonly STEP_POINTS = 2000;
  /**
   * The TSTEP of a step whose deck holds an inductor, with the run's coarse
   * step as its TMAX instead: ngspice's first step is a hundredth of TSTEP.
   * A coil cut off at the edge kicks for a microsecond or so (a DC motor's
   * winding into its own losses or a MOSFET's avalanche). With the coarse
   * step as TSTEP, a run sized for a motor's shaft (24.6 s) started with a
   * 123 us step that stepped over the kick: no spike on the drain, and the
   * coil's energy gone (velxio/velxio-prod#164).
   */
  private static readonly STEP_KICK_S = 1e-6;

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

  // ── Memory: the parts that keep a state between solves ────────────────
  //
  // A relay's armature stays where it is while its coil sits between its
  // drop-out and pull-in levels, so a relay fed through its own NO contact
  // (a seal-in, a motor starter's hold contact) stays in after START is
  // released. ngspice has that hysteresis inside one analysis only: every
  // deck started its switches released, every operating point found the
  // open solution, and a sealed-in relay dropped out (velxio/velxio-prod
  // #109). The service carries each armature's state from the solve it
  // published to the next deck it builds (BuildNetlistInput.memory).

  /** Component id -> whether its armature ended the last published solve
   *  operated. */
  private switchMemory = new Map<string, boolean>();
  /** The loaded deck's switches with memory and the state it starts them in. */
  private memoryCells: SwitchMemoryCell[] = [];
  /**
   * A latch of logic gates is the same story: two stable states and an
   * unstable midpoint an operating point with no history lands on. Each
   * latch output's volts at the last published solve, by the gate's output
   * pin, seed the next deck (.nodeset), so an SR latch keeps its state when
   * SET or RESET is released (velxio/velxio-prod#147).
   */
  private nodeMemory = new Map<string, number>();
  private nodeMemoryCells: NodeMemoryCell[] = [];
  /**
   * The store's hydrationSeq the memory belongs to. A new one means the
   * canvas was replaced wholesale (a project, an example, an import, a new
   * project from the starter picker): that circuit powers up anew, every
   * relay released and every latch in its power-up state, even where its
   * parts carry the ids of the one before, as a reopened gallery example
   * does. Read with the components the deck is built from, so a solve of
   * the old circuit that ends after the load cannot teach it back.
   */
  private memoryHydrationSeq: number | undefined = undefined;
  /**
   * A pad-state solve starts the switches where the loaded deck does, so one
   * that ends elsewhere (a pin pulled a relay in) asks for a rebuild that
   * starts them there. Those rebuilds run at once while there is credit for
   * them: MEMORY_REBUILD_BURST of it, one more every MEMORY_REBUILD_MS. A
   * circuit whose memory moves on every solve (a relay whose own contact
   * cuts its coil can) is held to one rebuild per MEMORY_REBUILD_MS once the
   * burst is spent. A latch set and then reset by two pin pulses rebuilds
   * for each: with one rebuild per 250 ms and no burst, the solves after
   * RESET came from the deck seeded with SET and showed Q high again until
   * the next rebuild was due. Faster than the credit comes back (more than
   * about four changes a second, sustained), solves still run on a deck
   * seeded with an older state, and what they show is not learnt (see
   * memoryStale): a pulse that ends before the rebuild is lost.
   */
  private memoryRebuildAt = -Infinity;
  /** The rebuild credit left at memoryRebuildAt (see memoryRebuildCredit). */
  private memoryRebuildTokens = 0;
  private memoryRebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly MEMORY_REBUILD_MS = 250;
  private static readonly MEMORY_REBUILD_BURST = 4;
  /**
   * Set from a pad-state solve that moved the memory until the rebuild it
   * asked for runs. Pad-state solves in between come from a deck that starts
   * the memory in its old state (a window that closes first, a cached state),
   * so they do not get to overwrite what was learnt.
   */
  private memoryStale = false;

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
  /** Steps run from a carried state (see `step`), and how long the last took. */
  stepSolveCount = 0;
  lastStepMs = 0;
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
    this.mixMemo = null;
    this.deckShape = null;
    this.pwmPads = [];
    this.healRequests.clear();
    this.recentLevels.clear();
    if (this.memoryRebuildTimer !== null) {
      clearTimeout(this.memoryRebuildTimer);
      this.memoryRebuildTimer = null;
    }
    this.step = null;
    this.current = null;
    this.lastEdge = null;
    this.healEdge = null;
    this.stopFollowing();
    this.memoryShape = null;
    this.contactShape = null;
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
      step: this.step
        ? {
            key: this.step.key,
            oneShot: this.step.capture.oneShot,
            endS: this.step.capture.time.at(-1),
            follow: this.step.follow === true,
          }
        : null,
      following: this.following !== null,
      stepSolveCount: this.stepSolveCount,
      lastStepMs: Math.round(this.lastStepMs),
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

  /** Queue `fn` behind whatever the solver is doing. Never rejects. A step
   *  being followed holds still while it runs: the work may replace it
   *  (another press, a pad edge), and until it publishes, the curve it is
   *  leaving is not the circuit's. Pins it held and did not publish to go
   *  as they were (holdPins). */
  private run(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(async () => {
      this.busy = true;
      this.pauseFollowing();
      try {
        await fn();
      } finally {
        this.busy = false;
        this.releasePins();
        this.resumeFollowing();
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
    this.lastEdge = { wallMs: at, board: boardId, guestMs };
    const index = this.padIndex.get(key);
    if (index === undefined || !this.timeline) {
      if (!this.loadedContext) {
        // The rebuild this asks for starts the new state at this edge.
        this.healEdge ??= this.lastEdge;
        void this.tick();
        return;
      }
      const asked = this.healRequests.get(key);
      if (asked !== undefined && at - asked < CircuitSimulationService.HEAL_RETRY_MS) return;
      this.healRequests.set(key, at);
      this.healEdge ??= this.lastEdge;
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

  /**
   * A pad changed in a way that rebuilds the deck rather than moving along
   * the timeline (a new PWM duty): the state the rebuild solves began here,
   * at `guestMs` of `boardId`'s own clock when it keeps one. A step the
   * rebuild runs starts its curve at this moment (see `step`).
   */
  notePadChange(boardId: string, guestMs: number | null): void {
    this.healEdge = { wallMs: nowMs(), board: boardId, guestMs };
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
    // A new state of the pads starts where the circuit is (see `step`), and
    // carries a step being followed on (see `following`): its operating
    // point is where that step ends (holdPins).
    const onset = this.step?.key !== key ? (this.lastEdge ?? { wallMs: nowMs() }) : null;
    const follow = onset ? this.followingAt(onset) : this.step?.follow === true;
    if (follow) this.holdPins();
    const vec = await this.vectorsFor(levels, key);
    if (!vec) return;
    // The memory follows what is published: a followed step's curve
    // (publish), not where it settles.
    if (!follow) this.adopt(vec);
    if (onset) {
      const step = await this.stepFrom(levels, key, vec, onset, this.stateAt(onset), follow);
      if (step) this.step = step;
    }
    if (follow) this.adopt(vec, !(this.step?.key === key && this.step.follow));
    this.publish(vec, undefined, false, undefined, key);
  }

  /**
   * True when the step published last is one the scalar fields follow (see
   * `following`) and it had not ended at `when`: a step that starts then
   * carries that transient on, and is followed too.
   */
  private followingAt(when: Onset): boolean {
    const step = this.current?.step;
    const shot = step?.capture.oneShot;
    if (!step?.follow || !shot) return false;
    return CircuitSimulationService.stepElapsedS(shot, when) < (step.capture.time.at(-1) ?? 0);
  }

  /**
   * Seconds since a step's capture began, as `when` sees it: on the clock of
   * the board whose edge began the step when `when` is an edge of that board,
   * else on the wall clock.
   */
  private static stepElapsedS(shot: NonNullable<TimeWaveforms['oneShot']>, when: Onset): number {
    const began = when.board !== undefined ? shot.guestMs?.[when.board] : undefined;
    const ms =
      began !== undefined && when.guestMs !== null && when.guestMs !== undefined
        ? when.guestMs - began
        : when.wallMs - shot.wallMs;
    return Math.max(0, ms / 1000);
  }

  /**
   * The state the circuit is in at `when`, by what was published last: each
   * capacitor's voltage and each inductor's current, read on a step's curve
   * at the time since it began (stepElapsedS), or, past the curve's end or
   * with no step, the operating point's values. Null before anything was
   * published.
   */
  private stateAt(when: Onset): Map<string, number> | null {
    const cur = this.current;
    const ctx = this.loadedContext;
    if (!cur || !ctx) return null;
    const shot = cur.step?.capture.oneShot;
    if (cur.step && shot) {
      const t = CircuitSimulationService.stepElapsedS(shot, when);
      if (t < (cur.step.capture.time.at(-1) ?? 0)) return reactiveStateOf(cur.step.result, ctx.reactive, t);
    }
    if (cur.mix) return mixedReactiveState(cur.mix, ctx.reactive);
    return reactiveStateOf(cur.op, ctx.reactive, null);
  }

  /**
   * The step the circuit takes into the pad state `levels` from `from`
   * (stateAt at its onset), when it has one: null when the deck is not a
   * step response, when nothing was published before (the state is taken as
   * settled, as it always was), or when every capacitor and inductor already
   * sits where the state's operating point `op` has it. Otherwise a transient
   * from `from` to where `op` has the circuit (runStep), as a one-shot
   * capture whose t = 0 is `onset`. Not cached: it depends on where the
   * circuit was.
   */
  private async stepFrom(
    levels: number[], key: string, op: StateVectors, onset: Onset, from: Map<string, number> | null,
    follow = false,
  ): Promise<StepRun | null> {
    const ic = this.stepStart(op, from);
    return ic ? this.runStep(levels, key, ic, onset, op, this.loadedContext?.settleS, follow) : null;
  }

  /**
   * The initial conditions of the step into a state whose operating point is
   * `op`, from `from`: null when there is no step to run (see stepFrom).
   * `settleS` is how long the deck settles: a step response's
   * (AnalysisMode.settleS) unless the caller says otherwise (a press or a
   * flip on a deck whose pads drive no step: switchSettleS).
   */
  private stepStart(
    op: StateVectors, from: Map<string, number> | null, settleS = this.loadedContext?.settleS,
  ): Array<{ device: string; value: number }> | null {
    const ctx = this.loadedContext;
    if (!ctx || settleS === undefined || ctx.reactive.length === 0 || !from) return null;
    if (!this.scheduler.solvePadState) return null;
    const goal = reactiveStateOf(op.result, ctx.reactive, null);
    const ic: Array<{ device: string; value: number }> = [];
    let moves = false;
    for (const d of ctx.reactive) {
      const target = goal.get(d.name);
      const start = from.get(d.name) ?? target;
      if (start === undefined) continue;
      ic.push({ device: d.name, value: start });
      if (target === undefined || !sameReactiveState(d.kind, start, target)) moves = true;
    }
    return moves ? ic : null;
  }

  /**
   * Run the step into `levels` (pad state `key`) from `ic`, toward the
   * operating point `op`, as a one-shot capture from `onset`. The first run
   * lasts twice the deck's settle time (ten of its time constants, at most
   * STEP_FIRST_MAX_S), and a run that ends before the circuit has settled is
   * run again for as long as its curve says it needs (stepNeedsS), within
   * STEP_MAX_S and STEP_RUNS runs:
   * the deck's time constant is an estimate, and three 10 kOhm in series
   * into 100 uF, or a coil behind its own 10 Ohm, are slower than it says.
   * What a capture that still stops short leaves is the readers' to close:
   * past its end the circuit is at `op`, never at its last sample.
   * `settleS` is the deck's settle time (see stepStart); `follow` marks a
   * step the scalar fields follow (StepRun.follow).
   */
  private async runStep(
    levels: number[], key: string, ic: Array<{ device: string; value: number }>, onset: Onset, op: StateVectors,
    settleS: number | undefined, follow = false,
  ): Promise<StepRun | null> {
    const ctx = this.loadedContext;
    if (!ctx || settleS === undefined || !this.scheduler.solvePadState) return null;
    const goal = reactiveStateOf(op.result, ctx.reactive, null);
    let stop = Math.min(
      CircuitSimulationService.STEP_FIRST_MAX_S,
      Math.max(CircuitSimulationService.STEP_MIN_S, 2 * settleS),
    );
    const started = nowMs();
    // A coil's kick at the edge wants a fine first step (STEP_KICK_S).
    const coil = ctx.reactive.some((d) => d.kind === 'L');
    let result: SolveResult | null = null;
    try {
      for (let run = 1; ; run++) {
        const coarse = stop / CircuitSimulationService.STEP_POINTS;
        const analysis: SolveAnalysis = {
          kind: 'tran',
          ...(coil
            ? {
                step: Math.min(CircuitSimulationService.STEP_KICK_S, coarse).toExponential(3),
                maxStep: coarse.toExponential(3),
              }
            : { step: coarse.toExponential(3) }),
          stop: stop.toExponential(3),
          uic: true,
          ic,
        };
        // A cached operating point left the engine at other levels.
        const changes = this.changesTo(levels);
        this.solverLevels = levels.slice();
        await this.scheduler.solvePadState(changes, analysis);
        result = this.scheduler.getLastResult();
        if (!result || result.timeAxis.length < 2) return null;
        if (run >= CircuitSimulationService.STEP_RUNS || stop >= CircuitSimulationService.STEP_MAX_S) break;
        // A run the solver gave up on part-way gets no longer one.
        if (transientShortfall(analysis, result.timeAxis)) break;
        const need = stepNeedsS(result, ctx.reactive, goal, stop);
        if (!(need > stop)) break;
        stop = Math.min(CircuitSimulationService.STEP_MAX_S, Math.max(1.5 * stop, 1.25 * need));
      }
    } catch (err) {
      this.solverLevels = null;
      // eslint-disable-next-line no-console
      console.warn('[circuit-sim] step solve failed:', err);
      return null;
    } finally {
      // The pin voltages follow what is published: the operating point.
      if (this.scheduler.getLastResult() !== op.result) this.scheduler.adoptResult?.(op.result);
    }
    if (!result) return null;
    // An operating-point deck's step is a capture all the same.
    const capture = this.extract(result, ctx, true).timeWaveforms;
    if (!capture) return null;
    capture.oneShot = {
      wallMs: onset.wallMs,
      ...(onset.board !== undefined && onset.guestMs !== null && onset.guestMs !== undefined
        ? { guestMs: { [onset.board]: onset.guestMs } }
        : {}),
    };
    this.stepSolveCount++;
    this.lastStepMs = nowMs() - started;
    this.note({ step: ic.length, stopS: capture.time.at(-1), ms: Math.round(this.lastStepMs), follow });
    return { key, capture, result, ...(follow ? { follow } : {}) };
  }

  /** The pad sources to alter to bring the engine to `levels`. */
  private changesTo(levels: readonly number[]): Array<{ source: string; volts: number }> {
    const changes: Array<{ source: string; volts: number }> = [];
    for (let i = 0; i < this.padSources.length; i++) {
      if (this.solverLevels === null || this.solverLevels[i] !== levels[i]) {
        changes.push({ source: this.padSources[i]!, volts: levels[i]! });
      }
    }
    return changes;
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
   * on solver duty; the latest is always solved, and so is every state its
   * PWM pads split it into. False when the latest could not be (nothing was
   * published).
   */
  private async publishStates(
    states: ReadonlyArray<WindowState>,
    latestState: WindowState,
    windowMs: number,
  ): Promise<boolean> {
    const ranked = this.splitStates(states.filter((s) => s.ms > 0)).sort((a, b) => b.ms - a.ms);
    const split = this.pwmSplit(latestState.levels);
    // The split of the state the pads hold is one picture: k static PWM pads
    // at distinct duties make k + 1 states, and a window that left one out
    // renormalised the rest, so four LEDs at 20/40/60/80 % glowed at
    // 25/50/75/100 %, and an LED HIGH only in a dropped state stayed dark,
    // for as long as nothing else published (velxio/velxio-prod#233).
    const always = new Set(split ? split.map((s) => stateKey(s.levels)) : []);
    const chosen: WindowState[] = [];
    let solves = CircuitSimulationService.MAX_STATE_SOLVES_PER_WINDOW;
    for (const s of ranked) {
      if (this.cache.has(s.key) || always.has(s.key)) chosen.push(s);
      else if (solves > 0) {
        chosen.push(s);
        solves--;
      }
    }
    const latestSplit = split !== null;
    if (!chosen.some((s) => s.key === latestState.key)) {
      // A split latest state's time is its split states' (counted above).
      chosen.push(latestSplit ? { ...latestState, ms: 0 } : latestState);
    }
    // The capture of a split latest state is made of its split states', so
    // each is solved even when this window did not reach it (it then has no
    // time in the window).
    for (const sub of split ?? []) {
      const key = stateKey(sub.levels);
      if (!chosen.some((s) => s.key === key)) chosen.push({ key, levels: sub.levels, ms: 0 });
    }
    // The latest state publishes a step that is followed: its solves are
    // where that step ends, not where the circuit is (holdPins).
    if (!split && this.step?.key === latestState.key && this.step.follow) this.holdPins();
    const solved: Array<{ state: WindowState; vec: StateVectors }> = [];
    for (const state of chosen) {
      const vec = await this.vectorsFor(state.levels, state.key);
      if (vec) solved.push({ state, vec });
    }
    const latest = solved.find((s) => s.state.key === latestState.key);
    if (!latest) return false;
    // A followed step notes the memory from its curve (publish).
    this.adopt(latest.vec, !(!split && this.step?.key === latestState.key && this.step.follow));
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
          ...(s.vec.timeWaveforms ? { timeWaveforms: s.vec.timeWaveforms } : {}),
        })),
    };
    // A latest state whose PWM pads sit at their mean is the snapshot the
    // level readers expect, not a state the circuit is ever in: its own
    // capture is not the circuit's. What the circuit does over a capture
    // window is its split states' captures, weighted by their shares of the
    // PWM period: with a generator on the canvas, that is the generator's
    // wave on its net, which the ADC replay, the meters and an LED on it read
    // from the capture. Publishing none left them the last sample of the
    // wave, a DC level (velxio/velxio-prod#232).
    const capture = split ? this.splitCapture(split, solved) : undefined;
    this.publish(latest.vec, window, latestSplit, capture, latestState.key, split ? splitMix(split, solved) : undefined);
    return true;
  }

  /** The last capture mixed for a split state, with what it was mixed from,
   *  so publishing the same split again publishes the same object. */
  private mixMemo: { parts: Array<{ capture: TimeWaveforms; weight: number }>; mixed: TimeWaveforms } | null = null;

  /**
   * The capture of a state whose static PWM pads sit at their mean: the
   * captures of its split states mixed by their shares of the period
   * (mixCaptures), or undefined when one of them has none (an operating
   * point: the deck's sources do not move by themselves).
   */
  private splitCapture(
    split: ReadonlyArray<{ levels: number[]; weight: number }>,
    solved: ReadonlyArray<{ state: WindowState; vec: StateVectors }>,
  ): TimeWaveforms | undefined {
    const parts: Array<{ capture: TimeWaveforms; weight: number }> = [];
    for (const sub of split) {
      const key = stateKey(sub.levels);
      const capture = solved.find((s) => s.state.key === key)?.vec.timeWaveforms;
      if (!capture) return undefined;
      parts.push({ capture, weight: sub.weight });
    }
    const memo = this.mixMemo;
    if (
      memo &&
      memo.parts.length === parts.length &&
      memo.parts.every((p, i) => p.capture === parts[i]!.capture && p.weight === parts[i]!.weight)
    ) {
      return memo.mixed;
    }
    const mixed = mixCaptures(parts);
    this.mixMemo = mixed ? { parts, mixed } : null;
    return mixed;
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
    const changes = this.changesTo(levels);
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
        if (analysis.kind === 'tran') {
          await this.scheduler.resolveTran(analysis.step, analysis.stop, analysis.start);
        }
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

  /** The scheduler's per-pin voltages follow what is published, and so does
   *  the circuit's memory, unless `noteMemory` is false: a step being
   *  followed notes it from its curve (publish). */
  private adopt(vec: StateVectors, noteMemory = true): void {
    if (this.scheduler.getLastResult() !== vec.result) this.scheduler.adoptResult?.(vec.result);
    if (noteMemory && !this.memoryStale) this.noteMemory(vec.result);
  }

  /**
   * Where the switches with memory ended the solve being published: operated
   * above their pull-in, released below their drop-out, and between the two
   * in the state the deck started them in. A pad-state solve that leaves one
   * elsewhere asks for a rebuild (see memoryRebuildAt). `t`: where they are
   * `t` seconds into a capture (a step being followed) instead of at its end.
   */
  private noteMemory(result: import('./ports/SolverPort').SolveResult, t: number | null = null): void {
    if (this.memoryCells.length === 0 && this.nodeMemoryCells.length === 0) return;
    const last = (name: string): number | undefined => {
      const vec = result.vectors.get(`v(${name.toLowerCase()})`);
      if (!vec || vec.real.length === 0) return undefined;
      if (t !== null && result.timeAxis.length === vec.real.length) return sampleAt(result.timeAxis, vec.real, t);
      return vec.real[vec.real.length - 1];
    };
    let moved = false;
    for (const cell of this.memoryCells) {
      const v = last(cell.control);
      if (v === undefined) continue;
      const operated = v > cell.on ? true : v < cell.off ? false : cell.seed;
      this.switchMemory.set(cell.id, operated);
      if (operated !== cell.seed) moved = true;
    }
    for (const cell of this.nodeMemoryCells) {
      const v = last(cell.net);
      if (v === undefined || !Number.isFinite(v)) continue;
      this.nodeMemory.set(cell.key, v);
      if (v > cell.threshold !== cell.seed > cell.threshold) moved = true;
    }
    if (moved && this.padSources.length > 0) this.requestMemoryRebuild();
  }

  private requestMemoryRebuild(): void {
    if (this.stopped) return;
    this.memoryStale = true;
    if (this.memoryRebuildTimer !== null) return;
    const go = () => {
      this.memoryRebuildTimer = null;
      const now = nowMs();
      this.memoryRebuildTokens = this.memoryRebuildCredit(now) - 1;
      this.memoryRebuildAt = now;
      this.note({ memoryRebuild: [...this.switchMemory, ...this.nodeMemory] });
      // Queued now, it runs before any window that closes after this solve.
      void this.tick();
    };
    const credit = this.memoryRebuildCredit(nowMs());
    if (credit >= 1) go();
    else this.memoryRebuildTimer = setTimeout(go, (1 - credit) * CircuitSimulationService.MEMORY_REBUILD_MS);
  }

  /** Memory rebuilds that may run at once at `now`: the credit left at the
   *  last one plus one per MEMORY_REBUILD_MS since, up to the burst. */
  private memoryRebuildCredit(now: number): number {
    return Math.min(
      CircuitSimulationService.MEMORY_REBUILD_BURST,
      this.memoryRebuildTokens + (now - this.memoryRebuildAt) / CircuitSimulationService.MEMORY_REBUILD_MS,
    );
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
    if (!samePads) {
      this.cache.clear();
      this.mixMemo = null;
    }
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
    // This rebuild starts the memory where the last solves left it.
    this.memoryStale = false;
    this.lastRebuildAt = Date.now();
    const previousRebuildAt = this.rebuildStartedAt;
    this.rebuildStartedAt = nowMs();
    const state = this.simStore.getState();
    // Another circuit was loaded: it powers up anew, and no step of the one
    // before carries on into it.
    const rehydrated = state.hydrationSeq !== this.memoryHydrationSeq;
    if (rehydrated) {
      this.memoryHydrationSeq = state.hydrationSeq;
      this.switchMemory = new Map();
      this.nodeMemory = new Map();
    }
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
    // The analysis the deck's card runs, with the start-up a periodic source
    // settles through before the stored window (velxio/velxio-prod#143).
    input.memory = { switches: this.switchMemory, nodes: this.nodeMemory };
    const built = buildNetlist(input);
    const { netlist, pinNetMap, nets, voltageSources, sourcedNets, staticPads, memoryCells, nodeMemoryCells } = built;
    let analysis = built.analysis;
    const padNames = new Set<string>();
    for (const b of input.boards) {
      for (const [pin, st] of Object.entries(b.pins)) {
        if (st.type !== 'input') padNames.add(`v_${sanitizeSpiceId(b.id)}_${sanitizeSpiceId(pin)}`.toLowerCase());
      }
    }
    const shape = deckShapeOf(netlist, padNames);
    // A press or a flip: the deck changed in its pushbuttons' and slide
    // switches' contacts and in nothing else but the memory, which a step
    // the last press started may have moved (velxio/velxio-prod#107).
    const memoryShape = memoryBlanked(shape, memoryCells);
    const contactShape = contactsBlanked(memoryShape, built.handContacts);
    const handOnly =
      !rehydrated &&
      this.memoryShape !== null &&
      memoryShape !== this.memoryShape &&
      contactShape === this.contactShape;
    this.note({
      rebuild: this.rebuildCount,
      collected: Object.fromEntries(snap.boards.map((b) => [b.id, Object.keys(b.pinStates as object).length])),
      sources: voltageSources.length,
      ...(handOnly ? { hand: true } : {}),
    });
    // Where the circuit is when the new deck takes over: the pad edge that
    // asked for the rebuild began the new state, or now. Read off the old
    // deck, by device name, so an edit to a charging RC carries its charge.
    // A press or a flip began it when the canvas changed, if that was after
    // the last rebuild read the canvas: a solver busy with the step before
    // must not move the release of a button to when it gets to it.
    const edge = this.healEdge;
    const changedAt = this.circuitChangedAt;
    const handAt =
      handOnly && changedAt !== null && changedAt > previousRebuildAt && changedAt <= this.rebuildStartedAt
        ? changedAt
        : this.rebuildStartedAt;
    const onset: Onset = edge ?? { wallMs: handAt };
    this.healEdge = null;
    const carried = this.stateAt(onset);
    const reactive = reactiveDevicesOf(netlist);

    // Ask the scheduler for every net voltage + every V-source branch
    // current so instruments (ammeters, LED brightness) have data, and the
    // state of every capacitor and inductor (see `step`).
    const extraVectors: string[] = [];
    for (const net of nets) extraVectors.push(`v(${net})`);
    for (const vs of voltageSources) extraVectors.push(`i(${vs.toLowerCase()})`);
    for (const cell of memoryCells) extraVectors.push(`v(${cell.control.toLowerCase()})`);
    const asked = new Set(extraVectors);
    for (const v of reactiveVectors(reactive)) if (!asked.has(v)) extraVectors.push(v);
    this.scheduler.setExtraVectorsOfInterest?.(extraVectors);

    const loadStart = nowMs();
    await this.scheduler.loadCircuit(netlist, pinNetMap);
    const loadMs = nowMs() - loadStart;
    // A step-response deck the circuit enters from a known state is solved
    // as an operating point first: when the circuit already sits there, the
    // deck's own transient follows below as it always did; when it does not,
    // the step replaces it (see `step`).
    const padSettleS = analysis.kind === 'tran' && !analysis.timeVarying ? analysis.settleS : undefined;
    // So is any deck a press or a flip changed, when it stores energy, and
    // any rebuild while a step it started is under way (a relay's memory,
    // an edit, a Stop): that step is followed (see `following`).
    const switchSettleS =
      analysis.kind === 'ac' || (analysis.kind === 'tran' && analysis.timeVarying) ? undefined : analysis.switchSettleS;
    const settleS = padSettleS ?? switchSettleS;
    const canStep = settleS !== undefined && reactive.length > 0 && carried !== null;
    const follow = canStep && (handOnly || (!rehydrated && this.followingAt(onset)));
    const stepDeck = (padSettleS !== undefined && reactive.length > 0 && carried !== null) || follow;
    // The operating point solved first is where that step ends (holdPins).
    if (follow) this.holdPins();
    if (analysis.kind === 'tran' && !stepDeck) {
      await this.scheduler.resolveTran(analysis.step, analysis.stop, analysis.start);
      if (analysis.start && !this.scheduler.getLastResult()?.timeAxis.length) {
        // The solver gave up during the start-up, and a run that settles first
        // stores nothing before its window. Run the window from t = 0, as
        // before the start-up was skipped: an unsettled picture with the
        // shortfall said, rather than none at all.
        analysis = {
          ...analysis,
          start: undefined,
          stop: (Number(analysis.stop) - Number(analysis.start)).toExponential(6),
        };
        await this.scheduler.resolveTran(analysis.step, analysis.stop);
      }
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
      analysisKind: analysis.kind,
      period: analysis.kind === 'tran' ? analysis.period : undefined,
      start: analysis.kind === 'tran' && analysis.start ? Number(analysis.start) : undefined,
      sourcedNets,
      reactive,
      settleS: padSettleS,
      switchSettleS,
    };
    const stepUnderWay = this.step;
    this.step = null;
    this.padStateAnalysis =
      analysis.kind === 'tran' && analysis.timeVarying
        ? analysis.start
          ? { kind: 'tran', step: analysis.step, stop: analysis.stop, start: analysis.start }
          : { kind: 'tran', step: analysis.step, stop: analysis.stop }
        : { kind: 'op' };
    // The memory the new deck starts from, and only for parts still in it.
    this.memoryCells = memoryCells;
    this.switchMemory = new Map(memoryCells.map((c) => [c.id, c.seed] as const));
    this.nodeMemoryCells = nodeMemoryCells;
    this.nodeMemory = new Map(nodeMemoryCells.map((c) => [c.key, c.seed] as const));
    const sameShape = shape === this.deckShape;
    this.deckShape = shape;
    this.memoryShape = memoryShape;
    this.contactShape = contactShape;
    this.loadPads(
      input.boards as unknown as Parameters<CircuitSimulationService['loadPads']>[0],
      voltageSources,
      staticPads,
      sameShape,
    );
    let result = this.scheduler.getLastResult();
    if (!result) return;
    let vec = this.extract(result, this.loadedContext);
    // A step that is followed notes the memory from its curve (publish).
    const opResult = result;
    if (!follow) this.noteMemory(result);
    const levels = (this.solverLevels ?? []).slice();
    const key = stateKey(levels);
    if (stepDeck) {
      // The deck's own transient starts from its operating point; a circuit
      // that was elsewhere when it took this state steps from there. A
      // rebuild that changes nothing the circuit is made of (the same deck,
      // the same pad state, no pad edge behind it: a part moved on the
      // canvas, the scope asking for a fresh sweep) leaves a step under way
      // as it is: run again from the state read on the wall clock, it would
      // cost a transient and leave the board's clock.
      const shot = stepUnderWay?.capture.oneShot;
      const kept =
        sameShape && edge === null && stepUnderWay?.key === key && shot &&
        CircuitSimulationService.stepElapsedS(shot, onset) < (stepUnderWay.capture.time.at(-1) ?? 0)
          ? stepUnderWay
          : null;
      const ic = kept || this.pwmSplit(levels) ? null : this.stepStart(vec, carried, settleS);
      const step = kept ?? (ic ? await this.runStep(levels, key, ic, onset, vec, settleS, follow) : null);
      if (step) {
        this.step = step;
      } else if (analysis.kind === 'tran') {
        await this.scheduler.resolveTran(analysis.step, analysis.stop, analysis.start);
        result = this.scheduler.getLastResult();
        if (!result) return;
        vec = this.extract(result, this.loadedContext);
      }
    }
    // Nothing to follow after all (the circuit already sat where the press
    // left it): the memory is where it settles, as for any rebuild.
    if (follow && !this.step?.follow) this.noteMemory(opResult);
    this.remember(key, vec);
    if (this.pwmSplit(levels)) {
      // The deck holds its static PWM pads at their mean; publish what the
      // circuit goes through with them (see pwmPads).
      const ms = CircuitSimulationService.PUBLISH_WINDOW_MS;
      await this.publishStates([{ key, levels, ms }], { key, levels, ms: 0 }, ms);
      return;
    }
    this.publish(vec, undefined, false, undefined, key);
  }

  /** Every net voltage and V-source branch current of a result, and its
   *  capture on a transient deck, or on any deck when `capture` (a step). */
  private extract(
    result: import('./ports/SolverPort').SolveResult,
    ctx: NonNullable<CircuitSimulationService['loadedContext']>,
    capture = false,
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
    if ((ctx.analysisKind === 'tran' || capture) && result.timeAxis.length > 0) {
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
      // A run that settled first (TSTART) is stored from its start: the
      // readers get the window from 0, as they always did (the ADC replays it
      // in a loop of its own length, the scope draws it from its left edge).
      const t0 = ctx.start ?? 0;
      const time = t0 > 0 ? Array.from(result.timeAxis, (t) => Math.max(0, t - t0)) : Array.from(result.timeAxis);
      timeWaveforms = { time, nodes, branches, period: ctx.period };
    }
    // A transient the solver gave up on part-way still has samples: say so,
    // or the canvas shows the circuit frozen at that instant without a word.
    const shortfall = transientShortfall(result.analysis, result.timeAxis);
    const warnings = shortfall ? [...result.warnings, shortfall] : result.warnings;
    return { nodeVoltages, branchCurrents, timeWaveforms, warnings, result };
  }

  /** Publish one state as the instantaneous snapshot, with the window it
   *  closes when there is one. `synthetic`: the state is a PWM pad's mean,
   *  which the circuit is never in (see pwmPads), so its own capture is not
   *  the circuit's: `splitCapture`, the mix of its split states' captures,
   *  is published in its place when there is one. `key` is the state's pad
   *  levels: the state a step was run into publishes the step (see `step`). */
  private publish(
    vec: StateVectors,
    window: SolveWindow | undefined,
    synthetic = false,
    splitCapture?: TimeWaveforms,
    key?: string,
    mix?: ReadonlyArray<{ result: SolveResult; weight: number }>,
  ): void {
    const ctx = this.loadedContext;
    if (!ctx) return;
    // The pad state a step was run into publishes the step beside its
    // operating point: the curve is what the circuit does from the edge on,
    // the operating point where it ends up (ElectricalSnapshot.stepWaveforms).
    // Any other state ends it.
    const step = key !== undefined && !synthetic && this.step?.key === key ? this.step : null;
    if (!step) this.step = null;
    this.current = { op: vec.result, step, ...(synthetic && mix ? { mix } : {}) };
    // The capture published is this state's own or none (see
    // ElectricalSnapshot.timeWaveforms); the scope keeps the latest one, a
    // step's curve included.
    const own = synthetic ? splitCapture : vec.timeWaveforms;
    const timeWaveforms = ctx.analysisKind === 'tran' ? own : undefined;
    if (ctx.analysisKind !== 'tran') this.lastTimeWaveforms = undefined;
    else if (step) this.lastTimeWaveforms = step.capture;
    else if (own) this.lastTimeWaveforms = own;
    else if (vec.timeWaveforms) this.lastTimeWaveforms = vec.timeWaveforms;
    const snapshot: ElectricalSnapshot = {
      nodeVoltages: vec.nodeVoltages,
      branchCurrents: vec.branchCurrents,
      window,
      pinNetMap: ctx.pinNetMap,
      analysisMode: ctx.analysisKind,
      timeWaveforms,
      stepWaveforms: step?.capture,
      scopeWaveforms: this.lastTimeWaveforms,
      warnings: vec.warnings,
      sourcedNets: ctx.sourcedNets,
      voltageSources: ctx.voltageSources.map((vs) => vs.toLowerCase()),
    };
    // A step started by hand goes out along its curve (see `following`),
    // to the pins too: what the work solved on the way was held from them.
    this.stopFollowing();
    const held = this.releasePins();
    if (step?.follow) {
      this.following = {
        base: snapshot,
        op: vec.result,
        step,
        lastAt: nowMs(),
        sent: { nodeVoltages: snapshot.nodeVoltages, branchCurrents: snapshot.branchCurrents },
      };
      this.sendFollowed(true);
      return;
    }
    // Held for a step that did not come (the circuit already sat where the
    // press leaves it): the pins get what is published.
    if (held) this.scheduler.publishNetVoltages?.(vec.nodeVoltages);
    this.electricalStore.publish(snapshot);
  }

  /**
   * Publish the step being followed as it stands now: the snapshot it was
   * published with, its scalar fields read on its curve at the time since it
   * began (wall clock), when they moved by more than the eye or a meter's
   * last digit tells (always when `force`), with the memory where the curve
   * has it; then again in FOLLOW_MS. Past the curve's end the snapshot as it
   * was, the operating point, and the following stops. Another circuit
   * loaded meanwhile stops it without a word. While a board-less circuit is
   * stopped (ServiceOptions.paused) nothing goes out and the step's clock
   * holds: its start moves on with the time that passes.
   */
  private sendFollowed(force: boolean): void {
    const f = this.following;
    const shot = f?.step.capture.oneShot;
    if (!f || !shot || this.stopped || this.simStore.getState().hydrationSeq !== this.memoryHydrationSeq) {
      this.stopFollowing();
      return;
    }
    const now = nowMs();
    // The Stop holds a board-less circuit only, as every other reader of the
    // flag has it: with a board on the canvas the flag is one an earlier
    // board-less canvas left set (a saved project, an import or an added
    // board keep it), and the board's own Run and Stop govern. Honoured
    // there, it withheld every publish after a press, and the pad edges'
    // after it, until a reload.
    if (this.simStore.getState().boards.length === 0 && this.options.paused?.()) {
      shot.wallMs += now - f.lastAt;
      f.lastAt = now;
      this.followTimer = setTimeout(() => {
        this.followTimer = null;
        this.sendFollowed(force);
      }, CircuitSimulationService.FOLLOW_MS);
      return;
    }
    f.lastAt = now;
    const capture = f.step.capture;
    const t = CircuitSimulationService.stepElapsedS(shot, { wallMs: now });
    if (!(t < (capture.time.at(-1) ?? 0))) {
      // Past its end the circuit is at its operating point.
      this.stopFollowing();
      if (!this.memoryStale) this.noteMemory(f.op);
      this.scheduler.publishNetVoltages?.(f.base.nodeVoltages);
      this.electricalStore.publish(f.base);
      return;
    }
    const nodeVoltages = { ...f.base.nodeVoltages };
    for (const [net, series] of capture.nodes) {
      const v = sampleAt(capture.time, series, t);
      if (Number.isFinite(v)) nodeVoltages[net] = v;
    }
    const branchCurrents = { ...f.base.branchCurrents };
    for (const [source, series] of capture.branches) {
      const i = sampleAt(capture.time, series, t);
      if (Number.isFinite(i)) branchCurrents[source] = i;
    }
    if (
      force ||
      followedMoved(f.sent.nodeVoltages, nodeVoltages, 1e-4) ||
      followedMoved(f.sent.branchCurrents, branchCurrents, 1e-9)
    ) {
      f.sent = { nodeVoltages, branchCurrents };
      if (!this.memoryStale) this.noteMemory(f.step.result, t);
      this.scheduler.publishNetVoltages?.(nodeVoltages);
      this.electricalStore.publish({ ...f.base, nodeVoltages, branchCurrents, stepAtS: t });
    }
    if (this.following === f) {
      this.followTimer = setTimeout(() => {
        this.followTimer = null;
        this.sendFollowed(false);
      }, CircuitSimulationService.FOLLOW_MS);
    }
  }

  /** Hold the step being followed where it is (solver work under way). */
  private pauseFollowing(): void {
    if (this.followTimer !== null) {
      clearTimeout(this.followTimer);
      this.followTimer = null;
    }
  }

  /** Carry on following, from now, unless the work just done replaced it. */
  private resumeFollowing(): void {
    if (this.following && this.followTimer === null && !this.stopped) this.sendFollowed(false);
  }

  private stopFollowing(): void {
    this.pauseFollowing();
    this.following = null;
  }

  /** True while the scheduler holds the pins' voltages (holdPins). */
  private pinsHeld = false;

  /**
   * Keep the solves of the work under way from the parts that read their
   * pins (MixedModeSchedulerPort.holdPinVoltages): it ends on a step that
   * is followed, and those solves are where the step settles (the operating
   * point it is run toward, the capture's last sample), not where the
   * circuit is. The first thing the parts get is the curve at its moment
   * (sendFollowed); work that publishes no step after all gives them what
   * it publishes (publish), and work that publishes nothing lets them go as
   * they were (run).
   */
  private holdPins(): void {
    if (this.pinsHeld || !this.scheduler.holdPinVoltages) return;
    this.pinsHeld = true;
    this.scheduler.holdPinVoltages(true);
  }

  /** Let the pins go (holdPins): true when they were held. */
  private releasePins(): boolean {
    if (!this.pinsHeld) return false;
    this.pinsHeld = false;
    this.scheduler.holdPinVoltages?.(false);
    return true;
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
        this.circuitChangedAt = nowMs();
        void this.tick();
      }
    });
    void this.tick();
    return unsubscribe;
  }
}
