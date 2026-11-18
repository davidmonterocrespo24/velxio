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

// ── Tuning ────────────────────────────────────────────────────────────────
/** Sustained over-limit time before destruction (the "thermal" delay), ms. */
const BURN_DELAY_MS = 700;
/** At or above this × the limit, destruction is instant (catastrophic). */
const CATASTROPHIC_RATIO = 3;
const RESISTOR_DEFAULT_W = 0.25;
/** Burn a resistor only past 2x its rating (verifier already warns at 1x). */
const RESISTOR_BURN_SAFETY = 2;
const CAP_DEFAULT_V = 25;

interface ComponentLike {
  id: string;
  metadataId: string;
  properties?: Record<string, unknown>;
}

export function isBurnoutResistor(metadataId: string): boolean {
  return metadataId === 'resistor' || metadataId === 'resistor-us' || metadataId.startsWith('resistor-');
}
export function isBurnoutElectrolyticCap(metadataId: string): boolean {
  return metadataId === 'capacitor-electrolytic' || metadataId.startsWith('cap-elec');
}

function parseVolts(raw: unknown): number {
  const m = /^\s*([0-9]*\.?[0-9]+)/.exec(String(raw ?? ''));
  return m ? parseFloat(m[1]!) : NaN;
}

/**
 * Stress ratio for a part (>1 means over its rating), plus a fault message.
 * Pure: depends only on the component + the solved nets. Returns null when the
 * part isn't a monitored type or its terminals aren't both on solved nets.
 */
export function componentStress(
  comp: ComponentLike,
  nodeVoltages: Record<string, number>,
  pinNetMap: Map<string, string>,
): { ratio: number; message: string } | null {
  const netV = (pin: string): number | undefined => {
    const net = pinNetMap.get(`${comp.id}:${pin}`);
    if (net === undefined) return undefined;
    if (net === '0') return 0;
    const v = nodeVoltages[net];
    return Number.isFinite(v) ? v : undefined;
  };

  if (isBurnoutResistor(comp.metadataId)) {
    const v1 = netV('1');
    const v2 = netV('2');
    if (v1 === undefined || v2 === undefined) return null;
    const R = parseValueWithUnits(comp.properties?.value, 1000);
    if (!Number.isFinite(R) || R <= 0) return null;
    const power = (v1 - v2) ** 2 / R;
    const rated =
      typeof comp.properties?.power === 'number' ? (comp.properties.power as number) : RESISTOR_DEFAULT_W;
    // 2x safety factor: the pre-flight verifier already WARNS (non-blocking) at
    // 1x — teaching circuits often over-drive a resistor on purpose — so we
    // only physically burn it at genuine overload (>2x rated sustained).
    return {
      ratio: power / (RESISTOR_BURN_SAFETY * rated),
      message: `Resistor ${comp.id} overheated — dissipating ${power.toFixed(2)} W, above its ${rated} W rating. It burned out. Use a higher-wattage resistor or a larger value.`,
    };
  }

  if (isBurnoutElectrolyticCap(comp.metadataId)) {
    const vp = netV('+');
    const vn = netV('−') ?? netV('-');
    if (vp === undefined || vn === undefined) return null;
    const v = vp - vn;
    const rated = parseVolts(comp.properties?.voltage) || CAP_DEFAULT_V;
    if (v < -0.5) {
      // Reverse polarity destroys an electrolytic regardless of magnitude.
      return {
        ratio: CATASTROPHIC_RATIO,
        message: `Electrolytic capacitor ${comp.id} was connected backwards (${Math.abs(v).toFixed(1)} V reverse) and burst. Swap its + and - terminals.`,
      };
    }
    return {
      ratio: v / rated,
      message: `Electrolytic capacitor ${comp.id} burst — ${v.toFixed(1)} V across it, above its ${rated} V rating. Use a higher-voltage capacitor.`,
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
  const { nodeVoltages, pinNetMap } = useElectricalStore.getState();
  const now = Date.now();
  for (const comp of sim.components) {
    if (sim.burntComponents.has(comp.id)) continue;
    const stress = componentStress(comp as ComponentLike, nodeVoltages, pinNetMap);
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
    if (state.nodeVoltages !== prev.nodeVoltages || state.timeWaveforms !== prev.timeWaveforms) {
      check();
    }
  });
}

// Self-install on import (the parts index imports this module). Guarded so the
// Node test environment (no live stores driving it) is unaffected.
installRuntimeBurnoutMonitor();
