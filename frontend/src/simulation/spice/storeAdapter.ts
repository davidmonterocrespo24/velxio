/**
 * Bridge between Velxio's simulator store (components, wires, boards) and
 * the NetlistBuilder inputs. Kept separate so the SPICE engine never has
 * to import the full Zustand store or its types.
 *
 * Callers construct a `BuildNetlistInput` by calling
 *   `buildInputFromStore(storeSnapshot)`
 */
import type {
  BuildNetlistInput,
  BoardForSpice,
  ComponentForSpice,
  WireForSpice,
  PinSourceState,
  AnalysisMode,
} from './types';
import type { Wire } from '../../types/wire';
import { analogScopeWantsTransient } from './analogScopeFeed';
import type { BoardKind } from '../../types/board';
import { boardPinGroupFor } from './boardPinGroups';
import { parseValueWithUnits } from './valueParser';
import { PASSIVE_PRESETS, periodicSourceHz } from './componentToSpice';

// Shortest transient window, for a very high-frequency source.
const MIN_TRAN_STOP_S = 5e-3;
// The step-response window's cap (an MCU pin into a capacitor or an
// inductor). That transient starts from the operating point the pin already
// holds, so a longer one would show nothing more (velxio/velxio-prod#153).
const MAX_TRAN_STOP_S = 0.4;
// A periodic source's window is bounded in steps, not seconds. A single
// source's four periods are 80 steps whatever its frequency (the step is a
// twentieth of a period), so a 0.5 Hz generator gets its 8 s; what costs is a
// slow source next to a much faster one, whose step is the fast one's. 8000
// is what the old 0.4 s cap left a 1 kHz source (velxio/velxio-prod#107).
// These are plain steps, a twentieth of the fastest period: a deck that can
// resonate integrates up to five times finer over the same window
// (RESONANT_SAMPLES_PER_PERIOD), so its four periods are up to 400 steps and
// its window up to 40 000.
const MAX_WINDOW_STEPS = 8000;
const SAMPLES_PER_PERIOD = 20;
// Periods of the slowest periodic source in the stored window. The circuit's
// start-up runs before it (settleTime.ts), so these are its steady state.
const PERIODS_SHOWN = 4;

// Transient forced by an analog scope channel on an otherwise-DC circuit.
// Short and coarse on purpose: it exists to give the trace a live window, and
// every solve reloads and re-runs the whole circuit on the single-threaded
// WASM engine, so a long capture would starve the MCU-edge solves that make
// LEDs respond.
const SCOPE_TRAN_STOP_S = 20e-3;
const SCOPE_TRAN_STEP_S = 50e-6;

// When a capacitor/inductor is driven by an MCU pin (step response), use this
// step. 1e-4 s = 100 µs, fine enough to resolve 10 kΩ · 1 µF = 10 ms τ with
// ~100 samples per τ.
const STEP_RESPONSE_STEP_S = 1e-4;
// Default τ when no resistor is found in the circuit (capacitor charging
// through a 10 kΩ pull-up is a reasonable default).
const DEFAULT_R_OHMS = 10e3;

// A circuit with an inductor and a capacitor can resonate, and ngspice's
// trapezoidal rule shifts frequencies like the bilinear transform: at a
// step of T/20 a series RLC with f0 = 5033 Hz (10 Ω, 1 mH, 1 µF) resonated
// at about 4991 Hz, and a sweep of the generator peaked at 4965-4995 Hz
// (velxio/velxio-prod#121). At T/100 the shift is 0.03 % (f0 θ/tan θ with
// θ = π/100). The finer step stays at least MIN_TRAN_STOP_S /
// RESONANT_MAX_STEPS (1 µs), so a fast source's shortest window holds no more
// than that many of them, and the step is never coarser than the plain one
// (SAMPLES_PER_PERIOD): above 50 kHz the plain step is already under 1 µs and
// is kept. The finer step is the integration's only. The window's budget
// (MAX_WINDOW_STEPS) and the start-up's (settleTime.ts) count plain steps
// (`budgetStep`), so they last as long as any other deck's: counted in the
// finer step they shrank fivefold in time, and a 50 Hz generator next to a
// 5 kHz RLC was read over 16 ms, less than one of its periods.
const RESONANT_SAMPLES_PER_PERIOD = 100;
const RESONANT_MAX_STEPS = 5000;

// Build the meta-id sets dynamically by combining the canonical IDs with
// every PASSIVE_PRESETS alias that maps to the same base — so adding a new
// preset (e.g. resistor-470) doesn't require touching this file.
const presetsOf = (base: 'resistor' | 'capacitor' | 'capacitor-electrolytic' | 'inductor') =>
  Object.entries(PASSIVE_PRESETS)
    .filter(([, b]) => b === base)
    .map(([id]) => id);

const CAPACITOR_META = new Set([
  'capacitor',
  'analog-capacitor',
  'capacitor-electrolytic',
  ...presetsOf('capacitor'),
  ...presetsOf('capacitor-electrolytic'),
]);
const INDUCTOR_META = new Set(['inductor', 'analog-inductor', ...presetsOf('inductor')]);
const RESISTOR_META = new Set([
  'resistor',
  'resistor-us',
  'analog-resistor',
  ...presetsOf('resistor'),
]);

/**
 * The steps of a transient driven by periodic sources whose fastest is at
 * `maxFreq`: `plain`, SAMPLES_PER_PERIOD to its period, which the budgets of
 * steps count in, and `step`, the one the deck integrates at: the plain one,
 * or RESONANT_SAMPLES_PER_PERIOD when the circuit holds an inductor and a
 * capacitor and can resonate (see RESONANT_SAMPLES_PER_PERIOD).
 */
function periodicSteps(
  components: StoreSnapshot['components'],
  maxFreq: number,
): { step: number; plain: number } {
  const plain = 1 / (maxFreq * SAMPLES_PER_PERIOD);
  const resonant =
    components.some((c) => INDUCTOR_META.has(c.metadataId)) &&
    components.some((c) => CAPACITOR_META.has(c.metadataId));
  if (!resonant) return { step: plain, plain };
  const fine = 1 / (maxFreq * RESONANT_SAMPLES_PER_PERIOD);
  return { step: Math.min(plain, Math.max(fine, MIN_TRAN_STOP_S / RESONANT_MAX_STEPS)), plain };
}

/** True if any board has at least one actively-driven pin (digital or PWM). */
function hasDrivenPin(boards: StoreSnapshot['boards']): boolean {
  for (const b of boards) {
    for (const state of Object.values(b.pinStates)) {
      if (state.type === 'digital' || state.type === 'pwm') return true;
    }
  }
  return false;
}

/** Largest RC time constant visible in the circuit (for step-response sizing). */
function estimateLargestTau(components: StoreSnapshot['components']): number {
  let maxR = 0;
  let maxC = 0;
  let maxL = 0;
  for (const c of components) {
    if (RESISTOR_META.has(c.metadataId)) {
      const r = parseValueWithUnits(c.properties.value, 1000);
      if (Number.isFinite(r) && r > maxR) maxR = r;
    } else if (CAPACITOR_META.has(c.metadataId)) {
      const cap = parseValueWithUnits(c.properties.value, 1e-6);
      if (Number.isFinite(cap) && cap > maxC) maxC = cap;
    } else if (INDUCTOR_META.has(c.metadataId)) {
      const l = parseValueWithUnits(c.properties.value, 1e-3);
      if (Number.isFinite(l) && l > maxL) maxL = l;
    }
  }
  const r = maxR > 0 ? maxR : DEFAULT_R_OHMS;
  const tauRC = maxC > 0 ? r * maxC : 0;
  const tauRL = maxL > 0 ? maxL / r : 0;
  return Math.max(tauRC, tauRL);
}

/**
 * Scan components for time-dependent sources and pick a transient analysis
 * window that captures all frequencies with enough resolution. Returns `null`
 * if every source is DC and no MCU-driven reactive network is present (→
 * caller uses `.op`).
 *
 * Two triggers cause `.tran`:
 *   1. Any part that emits a periodic source (periodicSourceHz: a signal
 *      generator that is not on DC, a power supply in AC mode)
 *   2. Any capacitor or inductor wired to an MCU pin that's actively driving
 *      (digital HIGH or PWM) — step-response circuits like RC charging from
 *      a `digitalWrite(HIGH)` or PWM-charged caps
 */
function pickDynamicAnalysis(
  components: StoreSnapshot['components'],
  boards: StoreSnapshot['boards'],
): AnalysisMode | null {
  const frequencies: number[] = [];
  for (const c of components) {
    // The frequency the mapper emitted ("2k" is 2000 Hz; a missing one is the
    // mapper's default), for every part whose source is periodic.
    const freq = periodicSourceHz(c);
    if (freq !== null) frequencies.push(freq);
  }

  if (frequencies.length > 0) {
    const maxFreq = Math.max(...frequencies);
    const minFreq = Math.min(...frequencies);
    const { step: stepS, plain: plainStepS } = periodicSteps(components, maxFreq);
    const periodS = 1 / minFreq;
    // Four periods of the slowest source. A window the step budget cannot
    // hold keeps the whole periods that fit (the meters read whole periods),
    // or the budget when not even one does.
    let stopS = PERIODS_SHOWN * periodS;
    const maxS = MAX_WINDOW_STEPS * plainStepS;
    if (stopS > maxS) {
      const whole = Math.floor(maxS / periodS + 1e-9);
      stopS = whole >= 1 ? whole * periodS : maxS;
    }
    stopS = Math.max(MIN_TRAN_STOP_S, stopS);
    return {
      kind: 'tran',
      step: stepS.toExponential(3),
      stop: stopS.toExponential(3),
      // Meters average over whole periods of the slowest source (readSpan).
      period: 1 / minFreq,
      timeVarying: true,
      // The window above is what is stored; the netlist builder runs the
      // circuit's start-up before it, sized from its time constants
      // (settleTime.ts, velxio/velxio-prod#143).
      settle: true,
      // A resonant deck's start-up budget counts plain steps too.
      ...(stepS < plainStepS ? { budgetStep: plainStepS.toExponential(3) } : {}),
    };
  }

  // Step-response branch: capacitor or inductor + actively-driven MCU pin.
  const hasReactive = components.some(
    (c) => CAPACITOR_META.has(c.metadataId) || INDUCTOR_META.has(c.metadataId),
  );
  if (hasReactive && hasDrivenPin(boards)) {
    const tau = estimateLargestTau(components);
    const rawStop = tau > 0 ? 5 * tau : MIN_TRAN_STOP_S;
    const stopS = Math.min(MAX_TRAN_STOP_S, Math.max(MIN_TRAN_STOP_S, rawStop));
    return {
      kind: 'tran',
      step: STEP_RESPONSE_STEP_S.toExponential(3),
      stop: stopS.toExponential(3),
    };
  }

  return null;
}

export interface StoreSnapshot {
  components: Array<{
    id: string;
    metadataId: string;
    properties: Record<string, unknown>;
  }>;
  wires: Wire[];
  boards: Array<{
    id: string;
    boardKind: BoardKind;
    pinStates: Record<string, PinSourceState>; // caller pre-populates from PinManager + PWM
  }>;
}

/**
 * Convert a Velxio store snapshot into the `BuildNetlistInput` consumed
 * by the NetlistBuilder.
 */
export function buildInputFromStore(snap: StoreSnapshot): BuildNetlistInput {
  const components: ComponentForSpice[] = snap.components.map((c) => ({
    id: c.id,
    metadataId: c.metadataId,
    properties: c.properties,
  }));

  const wires: WireForSpice[] = snap.wires.map((w) => ({
    id: w.id,
    start: { componentId: w.start.componentId, pinName: w.start.pinName },
    end: { componentId: w.end.componentId, pinName: w.end.pinName },
  }));

  const boards: BoardForSpice[] = snap.boards.map((b) => {
    const group = boardPinGroupFor(b.boardKind);
    return {
      id: b.id,
      boardKind: b.boardKind,
      vcc: group.vcc,
      pins: b.pinStates,
      groundPinNames: group.gnd,
      vccPinNames: group.vcc_pins,
      auxPinNames: group.aux?.pins,
      auxVolts: group.aux?.volts,
      powerInputs: group.powerInputs,
      pinLoads: group.pinLoads,
      pinOutputOhms: group.pinDrive?.ohms,
    };
  });

  // A probed wire needs a waveform even when the circuit itself is DC: a
  // resistor divider has no signal generator and no reactive part, so
  // pickDynamicAnalysis says `.op` and there is nothing for an analog scope
  // channel to plot. While the scope is watching a net, ask for a transient
  // anyway — a short one, since the point is a live window rather than a
  // settling study.
  const analysis: AnalysisMode =
    pickDynamicAnalysis(snap.components, snap.boards) ??
    (analogScopeWantsTransient()
      ? {
          kind: 'tran',
          step: SCOPE_TRAN_STEP_S.toExponential(3),
          stop: SCOPE_TRAN_STOP_S.toExponential(3),
        }
      : { kind: 'op' });

  return {
    components,
    wires,
    boards,
    analysis,
  };
}
