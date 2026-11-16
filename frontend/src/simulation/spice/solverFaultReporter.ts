/**
 * solverFaultReporter — a dead SPICE solve becomes something the user can read.
 *
 * When ngspice rejects the deck (the classic case: two ideal voltage sources on
 * one node -> "singular matrix"), the worker publishes an EMPTY nodeVoltages
 * map. Every meter then read 0 V, every LED went dark, and nothing said why:
 * `useElectricalStore.error` was only ever read by the two meters and the
 * hover overlay. Reported on velxio.dev 2026-09-05 as "my 9 V battery reads
 * 0 V" — the battery was fine, a 7805 output wired into the board's 5V pin
 * had killed the whole solve.
 *
 * This subscriber watches the store's `error` and, for each NEW hard error,
 * dispatches the same `velxio-circuit-fault` event the burnout monitor uses,
 * so the message lands in the output console under "Circuit check". One event
 * per distinct message: the continuous solver re-runs on every canvas change
 * and a still-broken circuit must not spam the log. Convergence chatter on a
 * transient analysis is not reported here — only a solve that produced no
 * voltages at all, a message ngspice only prints for a rejected deck, or a
 * transient that stopped before its end (transientShortfall).
 */
import { useElectricalStore } from '../../store/useElectricalStore';
import { railVolts } from './boardPinGroups';
import { TRANSIENT_SHORTFALL_PREFIX } from './transientShortfall';

/** ngspice messages that mean "no operating point at all", not a warning. */
const HARD_ERROR_RE = /singular matrix|shorted [av]src|no such vector|circuit not parsed|error on line|fatal/i;

/** Name a V-source the way the user sees it on the canvas. */
export function describeSourceName(src: string): string {
  const s = src.toLowerCase();
  if (s === 'v_vcc_rail') return "the board's main supply rail (5V / VCC / 3V3 pins)";
  const aux = /^v_aux_rail_(.+)$/.exec(s);
  if (aux) return `the board's ${railVolts(aux[1]!)} supply pin`;
  // "b_ic_74hc02_1788636438540_69gm8vczj_1" -> the component id with the
  // card suffix dropped; "v_bat" / "v_signal_generator_..." -> the id.
  const body = s.replace(/^[vb]_/, '');
  const comp = body.replace(/_(\d+|sense|esr|out|int|vmr)$/i, '');
  return `source ${comp}`;
}

/**
 * The line worth showing out of everything ngspice wrote to stderr for one
 * analysis. A failed .op prints its fallbacks first ("Note: Starting dynamic
 * gmin stepping", "Note: Starting source stepping") and the verdict last, so
 * the FIRST line is nearly always a Note — day-one telemetry (2026-09-05)
 * logged 25 dead solves as "Note: Starting dynamic gmin stepping" for one
 * user, which hid what actually failed.
 */
export function pickSolverError(warnings: readonly string[]): string | null {
  const lines = warnings.map((w) => w.trim()).filter((w) => w.length > 0);
  if (lines.length === 0) return null;
  const rank = (l: string): number => {
    if (/^fatal|^error|singular matrix|shorted [av]src|no such vector|not parsed/i.test(l)) return 0;
    // Our own sentence for a transient that ended early: it says what the
    // "timestep too small" chatter before it means for the canvas.
    if (isTransientShortfall(l)) return 0;
    if (/failed|iteration limit|no convergence|timestep too small|gmin.*fail/i.test(l)) return 1;
    if (/^warning/i.test(l)) return 2;
    return 3;
  };
  let best = lines[0]!;
  let bestRank = rank(best);
  for (const l of lines) {
    const r = rank(l);
    if (r < bestRank) {
      best = l;
      bestRank = r;
    }
  }
  return best;
}

/** True for the message transientShortfall writes for a run that ended early. */
export function isTransientShortfall(error: string | null): boolean {
  return !!error && error.trim().startsWith(TRANSIENT_SHORTFALL_PREFIX);
}

/** Turn a raw ngspice line into a sentence with a likely fix. */
export function describeSolverError(raw: string): string {
  const text = raw.trim();
  if (isTransientShortfall(text)) return text;
  const shorted = /instance\s+(\S+)\s+is a shorted [av]src/i.exec(text);
  if (shorted) {
    return (
      `The circuit has no solution: ${describeSourceName(shorted[1]!)} has both terminals ` +
      `on the same net, so a wire shorts it out. Remove the wire that joins its output ` +
      `to its own reference (typically an output tied straight to GND). Every meter and ` +
      `LED stays dead until then. (ngspice: ${text})`
    );
  }
  const singular = /singular matrix:?\s*check node\s+(\S+?)#branch/i.exec(text);
  if (singular) {
    return (
      `The circuit has no solution: two voltage sources drive the same net ` +
      `(${describeSourceName(singular[1]!)}). Typical cause: a regulator or battery ` +
      `output wired straight into a board supply pin (5V / 3V3), or two supplies tied ` +
      `together. Remove one of them. Every meter and LED stays dead until then. (ngspice: ${text})`
    );
  }
  if (/singular matrix/i.test(text)) {
    return (
      `The circuit has no solution (ngspice: ${text}). Check for voltage sources wired ` +
      `against each other, or a source shorted by a wire.`
    );
  }
  return `Circuit solver problem: ${text}`;
}

function emitFault(message: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[circuit-sim] ${message}`);
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  try {
    window.dispatchEvent(
      new CustomEvent('velxio-circuit-fault', { detail: { kind: 'solver', message } }),
    );
  } catch {
    /* CustomEvent unavailable — the console.warn is enough */
  }
}

/** True when this snapshot is a rejected deck rather than a noisy success. */
export function isDeadSolve(state: {
  error: string | null;
  nodeVoltages: Record<string, number>;
  pinNetMap: Map<string, string>;
}): boolean {
  if (!state.error) return false;
  if (HARD_ERROR_RE.test(state.error)) return true;
  // A circuit with wired pins but not one solved voltage: nothing to read.
  return state.pinNetMap.size > 0 && Object.keys(state.nodeVoltages).length === 0;
}

/**
 * Subscribe to the electrical store; returns the unsubscribe handle.
 * Exported separately from the mount so tests can drive it without a DOM.
 */
export function startSolverFaultReporter(
  report: (message: string) => void = emitFault,
): () => void {
  let lastReported: string | null = null;
  return useElectricalStore.subscribe((state, prev) => {
    if (state.error === prev.error) return;
    // A transient that stopped early still has voltages, so it is not a dead
    // solve, but its values are frozen at the failure: report it as well.
    if (!isDeadSolve(state) && !isTransientShortfall(state.error)) {
      // A clean solve re-arms the reporter: the next failure is news again.
      if (!state.error) lastReported = null;
      return;
    }
    if (state.error === lastReported) return;
    lastReported = state.error;
    report(describeSolverError(state.error!));
  });
}
