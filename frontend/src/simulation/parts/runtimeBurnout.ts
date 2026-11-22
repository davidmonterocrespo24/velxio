/**
 * Runtime burnout monitor (P4) — generalizes the LED's burnout to other parts.
 *
 * While the simulation runs, this watches the live electrical solve and, when a
 * part is stressed past its rating for a sustained moment, marks it "destroyed"
 * (a charred visual on the canvas + a fault in the output console). It is the
 * runtime counterpart to the pre-flight verifier: the verifier warns BEFORE you
 * run; this catches faults that only appear mid-run.
 *
 * Algorithm (see project/circuit-safety-2026-06/PLAN.md "P4 prior-art
 * research"): the Fritzing simulator (the open-source precedent) compares the
 * operating point to each part's rating and draws smoke on it. We do the same,
 * but wrap the threshold in a first-order "thermal" delay so a brief inrush
 * spike doesn't destroy a part — only a sustained overload (or a catastrophic
 * >=3x overload, which is instant) does.
 *
 * The LED keeps its own burnout in BasicParts (it has a per-frame render loop);
 * this monitor covers passive parts that don't: resistors (power) and
 * electrolytic capacitors (over-voltage / reverse polarity).
 */
import { useElectricalStore } from '../../store/useElectricalStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { parseValueWithUnits } from '../spice/valueParser';
import { pinCurrentFindings } from '../verify/pinCurrent';
import { readSpan, spanStats } from '../spice/waveformStats';
import type { TimeWaveforms } from '../spice/types';
import { formatRating, isRatedResistor, resistorPowerRating } from './resistorRating';

// ── Tuning ────────────────────────────────────────────────────────────────
/** Sustained over-limit time before destruction (the "thermal" delay), ms. */
const BURN_DELAY_MS = 700;
/** At or above this × the limit, destruction is instant (catastrophic). */
const CATASTROPHIC_RATIO = 3;
/** Burn a resistor only past 2x its rating (verifier already warns at 1x). */
const RESISTOR_BURN_SAFETY = 2;
const CAP_DEFAULT_V = 25;

interface ComponentLike {
  id: string;
  metadataId: string;
  properties?: Record<string, unknown>;
}

/** The resistors the circuit check rates too (resistorRating). */
export function isBurnoutResistor(metadataId: string): boolean {
  return isRatedResistor(metadataId);
}
export function isBurnoutElectrolyticCap(metadataId: string): boolean {
  return metadataId === 'capacitor-electrolytic' || metadataId.startsWith('cap-elec');
}

function parseVolts(raw: unknown): number {
  const m = /^\s*([0-9]*\.?[0-9]+)/.exec(String(raw ?? ''));
  return m ? parseFloat(m[1]!) : NaN;
}

/**
 * What the published solve says the circuit did, beyond its last instant, as
 * the electrical store holds it: the transient capture of the state (a
 * generator's sine, a supply in AC mode) and the pad states of the publish
 * window with their shares of it (a PWM pad on a static load).
 */
export interface StressHistory {
  timeWaveforms?: TimeWaveforms;
  window?: { states: ReadonlyArray<{ weight: number; nodeVoltages: Record<string, number> }> };
}

/** A voltage between two nets over what the solve published. */
interface Drop {
  /** Time-weighted mean of its square: what heats a resistor. */
  meanSquare: number;
  min: number;
  max: number;
  /** Taken over a capture or a window, not one instant. */
  averaged: boolean;
}

/**
 * V(a) - V(b) as heat and insulation see it. A resistor heats with the mean
 * of V^2 / R, and a capacitor's dielectric fails at the highest voltage it
 * sees. Both read the last sample of a transient, which for a generator's
 * whole number of periods is a zero crossing: 12 V peak across 100 ohm,
 * 0.72 W on average, read 1.4e-30 W (velxio/velxio-prod#117). So: over the
 * capture, on the span the meters read (readSpan, whole periods after the
 * start-up), time-weighted; else over the window's pad states, by their
 * shares; else the instant.
 */
function dropOf(
  a: string,
  b: string,
  nodeVoltages: Record<string, number>,
  history: StressHistory | undefined,
): Drop | null {
  const tw = history?.timeWaveforms;
  if (tw && tw.time.length > 1) {
    const samples = (net: string) => (net === '0' ? undefined : tw.nodes.get(net));
    const sa = samples(a);
    const sb = samples(b);
    if ((sa || a === '0') && (sb || b === '0')) {
      const n = tw.time.length;
      const diff = new Array<number>(n);
      for (let i = 0; i < n; i++) diff[i] = (sa ? sa[i] ?? NaN : 0) - (sb ? sb[i] ?? NaN : 0);
      const span = readSpan(tw.time, tw.period);
      const stats = span ? spanStats(tw.time, diff, span) : null;
      if (stats) return { meanSquare: stats.rms * stats.rms, min: stats.min, max: stats.max, averaged: true };
    }
  }
  const at = (volts: Record<string, number>, net: string): number | undefined => {
    if (net === '0') return 0;
    const v = volts[net];
    return Number.isFinite(v) ? v : undefined;
  };
  const states = history?.window?.states;
  if (states && states.length > 1) {
    let total = 0;
    let sumSq = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const st of states) {
      const va = at(st.nodeVoltages, a);
      const vb = at(st.nodeVoltages, b);
      if (va === undefined || vb === undefined || !(st.weight > 0)) continue;
      const v = va - vb;
      total += st.weight;
      sumSq += st.weight * v * v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (total > 0) return { meanSquare: sumSq / total, min, max, averaged: true };
  }
  const va = at(nodeVoltages, a);
  const vb = at(nodeVoltages, b);
  if (va === undefined || vb === undefined) return null;
  const v = va - vb;
  return { meanSquare: v * v, min: v, max: v, averaged: false };
}

/**
 * Stress ratio for a part (>1 means over its rating), plus a fault message.
 * Pure: depends only on the component + the solved nets (and, when given,
 * what the solve published over time: StressHistory). Returns null when the
 * part isn't a monitored type or its terminals aren't both on solved nets.
 */
export function componentStress(
  comp: ComponentLike,
  nodeVoltages: Record<string, number>,
  pinNetMap: Map<string, string>,
  history?: StressHistory,
): { ratio: number; message: string } | null {
  const net = (pin: string): string | undefined => pinNetMap.get(`${comp.id}:${pin}`);

  if (isBurnoutResistor(comp.metadataId)) {
    const n1 = net('1');
    const n2 = net('2');
    if (n1 === undefined || n2 === undefined) return null;
    const drop = dropOf(n1, n2, nodeVoltages, history);
    if (!drop) return null;
    const R = parseValueWithUnits(comp.properties?.value, 1000);
    if (!Number.isFinite(R) || R <= 0) return null;
    const power = drop.meanSquare / R;
    // The part's power property, as the inspector stores it ("0.5") or a
    // project holds it (0.5); 1/4 W when it says nothing (#104).
    const rated = resistorPowerRating(comp.properties);
    // 2x safety factor: the pre-flight verifier already WARNS (non-blocking) at
    // 1x — teaching circuits often over-drive a resistor on purpose — so we
    // only physically burn it at genuine overload (>2x rated sustained).
    return {
      ratio: power / (RESISTOR_BURN_SAFETY * rated),
      message:
        `Resistor ${comp.id} overheated — dissipating ${power.toFixed(2)} W${drop.averaged ? ' on average' : ''}, ` +
        `above its ${formatRating(rated)} rating. It burned out. Pick a higher power rating for it in its ` +
        `properties, or a larger value.`,
    };
  }

  if (isBurnoutElectrolyticCap(comp.metadataId)) {
    const np = net('+');
    const nn = net('−') ?? net('-');
    if (np === undefined || nn === undefined) return null;
    const drop = dropOf(np, nn, nodeVoltages, history);
    if (!drop) return null;
    const rated = parseVolts(comp.properties?.voltage) || CAP_DEFAULT_V;
    if (drop.min < -0.5) {
      // Reverse polarity destroys an electrolytic regardless of magnitude.
      return {
        ratio: CATASTROPHIC_RATIO,
        message: `Electrolytic capacitor ${comp.id} was connected backwards (${Math.abs(drop.min).toFixed(1)} V reverse) and burst. Swap its + and - terminals.`,
      };
    }
    return {
      ratio: drop.max / rated,
      message: `Electrolytic capacitor ${comp.id} burst — ${drop.max.toFixed(1)} V across it${drop.averaged ? ' at its peak' : ''}, above its ${rated} V rating. Use a higher-voltage capacitor.`,
    };
  }
  return null;
}

/**
 * Pure burn decision with a first-order thermal delay. Given the current stress
 * ratio and the timestamp the part first went over-limit (0 = not over), return
 * whether it's destroyed now and the updated over-since timestamp.
 */
export function decideBurn(
  ratio: number,
  overSince: number,
  now: number,
): { burn: boolean; overSince: number } {
  if (ratio >= CATASTROPHIC_RATIO) return { burn: true, overSince };
  if (ratio > 1) {
    const since = overSince === 0 ? now : overSince;
    return { burn: now - since > BURN_DELAY_MS, overSince: since };
  }
  return { burn: false, overSince: 0 }; // cooled below the limit
}

// ── Live monitor ────────────────────────────────────────────────────────────

const overSinceByComponent = new Map<string, number>();

function emitFault(id: string, message: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[burnout] ${message}`);
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(
        new CustomEvent('velxio-circuit-fault', { detail: { componentId: id, kind: 'burnout', message } }),
      );
    } catch {
      /* CustomEvent unavailable — the console.warn is enough */
    }
  }
}

/**
 * Board pins over their current (velxio/velxio-prod#140): each pin and each
 * board total is reported once per run, again only if it gets worse
 * (warning, then error). A pin is not destroyed: a real one may survive, or
 * fail later, and the sketch keeps running either way.
 */
const reportedPinCurrent = new Map<string, 'warning' | 'error'>();

function checkPinCurrents(): void {
  const { boards } = useSimulatorStore.getState();
  const { branchCurrents, pinNetMap } = useElectricalStore.getState();
  if (!boards?.length || !branchCurrents) return;
  for (const f of pinCurrentFindings(boards, branchCurrents, pinNetMap)) {
    const key = `${f.boardId}:${f.pinName ?? '*'}`;
    const before = reportedPinCurrent.get(key);
    if (before === f.severity || before === 'error') continue;
    reportedPinCurrent.set(key, f.severity);
    // eslint-disable-next-line no-console
    console.warn(`[pin-current] ${f.message}`);
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try {
        window.dispatchEvent(
          new CustomEvent('velxio-circuit-fault', {
            detail: { componentId: f.boardId, kind: 'pin-current', message: f.message, severity: f.severity },
          }),
        );
      } catch {
        /* CustomEvent unavailable — the console.warn is enough */
      }
    }
  }
}

function check(): void {
  checkPinCurrents();
  const sim = useSimulatorStore.getState();
  const { nodeVoltages, pinNetMap, timeWaveforms, window } = useElectricalStore.getState();
  const now = Date.now();
  for (const comp of sim.components) {
    if (sim.burntComponents.has(comp.id)) continue;
    const stress = componentStress(comp as ComponentLike, nodeVoltages, pinNetMap, { timeWaveforms, window });
    if (!stress) {
      overSinceByComponent.delete(comp.id);
      continue;
    }
    const { burn, overSince } = decideBurn(stress.ratio, overSinceByComponent.get(comp.id) ?? 0, now);
    if (burn) {
      overSinceByComponent.delete(comp.id);
      sim.markComponentBurnt(comp.id);
      emitFault(comp.id, stress.message);
    } else if (overSince === 0) {
      overSinceByComponent.delete(comp.id);
    } else {
      overSinceByComponent.set(comp.id, overSince);
    }
  }
}

let installed = false;
let lastHexEpoch = -1;

/** Subscribe the monitor to the live solver. Idempotent. */
export function installRuntimeBurnoutMonitor(): void {
  if (installed) return;
  installed = true;
  // Reset accumulators whenever the sim re-arms (Run / Reset bump hexEpoch).
  useSimulatorStore.subscribe((s) => {
    if (s.hexEpoch !== lastHexEpoch) {
      lastHexEpoch = s.hexEpoch;
      overSinceByComponent.clear();
      reportedPinCurrent.clear();
    }
  });
  // Re-check on every fresh solve (the store publishes a new object each solve).
  useElectricalStore.subscribe((state, prev) => {
    if (
      state.nodeVoltages !== prev.nodeVoltages ||
      state.timeWaveforms !== prev.timeWaveforms ||
      state.window !== prev.window
    ) {
      check();
    }
  });
}

// Self-install on import (the parts index imports this module). Guarded so the
// Node test environment (no live stores driving it) is unaffected.
installRuntimeBurnoutMonitor();
