/**
 * transientShortfall — say so when a transient analysis stops early.
 *
 * ngspice gives up on a transient when it cannot find a solution for the
 * next time step ("timestep too small"), and it still hands back every sample
 * it computed. The time axis just ends early. Nothing compared it with the
 * stop time, so the meters, the scope and the LEDs showed the circuit frozen
 * at the instant the solver failed, and no message said why: an RC into a
 * 74HC14 whose hysteresis had no solution stopped at 5.1 ms of 40 ms
 * (velxio/velxio-prod#144). Pure, so the service can call it on every result.
 */
import { parseValueWithUnits } from './valueParser';
import type { SolveAnalysis } from './ports/SolverPort';

/** The start of every shortfall message (solverFaultReporter keys on it). */
export const TRANSIENT_SHORTFALL_PREFIX = 'Transient analysis stopped at';

function formatSeconds(s: number): string {
  if (s >= 1) return `${s.toPrecision(4)} s`;
  if (s >= 1e-3) return `${(s * 1e3).toPrecision(4)} ms`;
  if (s >= 1e-6) return `${(s * 1e6).toPrecision(4)} µs`;
  return `${(s * 1e9).toPrecision(4)} ns`;
}

/**
 * The sentence for a transient whose time axis ends before its stop time, or
 * null when the run is complete (or is not a transient at all).
 */
export function transientShortfall(
  analysis: SolveAnalysis,
  timeAxis: ArrayLike<number>,
): string | null {
  if (analysis.kind !== 'tran') return null;
  const stop = parseValueWithUnits(analysis.stop);
  if (!(stop > 0)) return null;
  const end = timeAxis.length > 0 ? Number(timeAxis[timeAxis.length - 1]) : 0;
  // ngspice ends a complete run on a breakpoint at the stop time itself.
  if (end >= stop * (1 - 1e-6)) return null;
  return (
    `${TRANSIENT_SHORTFALL_PREFIX} ${formatSeconds(end)} of ${formatSeconds(stop)}: the circuit ` +
    `solver found no solution past that point, so the meters, the scope and the LEDs show the ` +
    `circuit as it was at ${formatSeconds(end)}, not at the end of the run.`
  );
}
