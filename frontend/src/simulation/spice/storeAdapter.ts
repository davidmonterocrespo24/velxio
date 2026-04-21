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
import type { BoardKind } from '../../types/board';
import { BOARD_PIN_GROUPS } from './boardPinGroups';
import { parseValueWithUnits } from './valueParser';
import { PASSIVE_PRESETS } from './componentToSpice';

// Minimum transient stop time so RC/decoupling networks reach steady-state
// even if the source is very high frequency.
const MIN_TRAN_STOP_S = 5e-3;
// Cap transient stop time to keep solve cost bounded for very low-frequency
// sources (e.g. 0.1 Hz → 40 s would be absurd). 400 ms covers 20 cycles at
// 50 Hz and gives plenty of time to reach steady state for filter networks.
const MAX_TRAN_STOP_S = 0.4;
const SAMPLES_PER_PERIOD = 20;
const PERIODS_TO_SETTLE = 4;

// When a capacitor/inductor is driven by an MCU pin (step response), use this
// step. 1e-4 s = 100 µs, fine enough to resolve 10 kΩ · 1 µF = 10 ms τ with
// ~100 samples per τ.
const STEP_RESPONSE_STEP_S = 1e-4;
// Default τ when no resistor is found in the circuit (capacitor charging
// through a 10 kΩ pull-up is a reasonable default).
const DEFAULT_R_OHMS = 10e3;

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
 *   1. Any `signal-generator` with non-DC waveform (AC source)
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
    if (c.metadataId !== 'signal-generator') continue;
    const waveform = String(c.properties.waveform ?? 'sine').toLowerCase();
    if (waveform === 'dc') continue;
    const freq = Number(c.properties.frequency ?? 0);
    if (freq > 0) frequencies.push(freq);
  }

  if (frequencies.length > 0) {
    const maxFreq = Math.max(...frequencies);
    const minFreq = Math.min(...frequencies);
    const stepS = 1 / (maxFreq * SAMPLES_PER_PERIOD);
    const rawStop = PERIODS_TO_SETTLE / minFreq;
    const stopS = Math.min(MAX_TRAN_STOP_S, Math.max(MIN_TRAN_STOP_S, rawStop));
    return {
      kind: 'tran',
      step: stepS.toExponential(3),
      stop: stopS.toExponential(3),
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
    const group = BOARD_PIN_GROUPS[b.boardKind] ?? BOARD_PIN_GROUPS.default;
    return {
      id: b.id,
      vcc: group.vcc,
      pins: b.pinStates,
      groundPinNames: group.gnd,
      vccPinNames: group.vcc_pins,
    };
  });

  const analysis: AnalysisMode = pickDynamicAnalysis(snap.components, snap.boards) ?? {
    kind: 'op',
  };

  return {
    components,
    wires,
    boards,
    analysis,
  };
}
