/**
 * What an LED die shows for the current the solve gives it, and the faults it
 * reports. Shared by the LED and the RGB LED (one die per colour,
 * velxio/velxio-prod#174), so a colour of an RGB LED glows, dims under PWM and
 * burns out exactly as a single LED does.
 */
import { useElectricalStore } from '../../store/useElectricalStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { LED_UNLIMITED_AMPS } from '../ledLimits';
import { readSpan, spanStats } from '../spice/waveformStats';

// A real 5mm indicator LED survives ~20 mA (datasheet absolute max ~30 mA).
// A sustained forward current well above that destroys it within moments —
// the classic "LED straight across a 9V battery with no series resistor"
// mistake. A professional simulator must model that, not glow happily. Once
// the solved forward current crosses LED_BURNOUT_A the LED burns out (goes
// dark and stays dark for the rest of the run) and a fault message is shown.
//
// The burnout threshold (100 mA) sits well above both the 20 mA rating AND the
// ~100-150 mA a high-power / RGB channel may legitimately draw, so a merely
// bright LED is never falsely destroyed — only a missing or grossly-undersized
// series resistor trips it. The pre-flight circuitVerifier already warns at the
// 20 mA datasheet limit BEFORE the run starts (the primary, professional
// check); this runtime burnout is the last-resort net for users who click
// "Run Anyway" past that warning, or for faults that only appear mid-run.
export const LED_RATED_MAX_A = 0.02;
export const LED_BURNOUT_A = 0.1;

/** Surface a circuit fault for an LED — console + a UI event the toolbar shows. */
export function reportLedFault(componentId: string, kind: string, message: string): void {
  console.warn(`[led] ${componentId}: ${message}`);
  // Mark it destroyed in the shared burnt set (P4): the canvas renders it
  // charred + a smoke badge, and the solver opens it — same treatment as a
  // burnt resistor/capacitor. (The LED also goes dark via its own update.)
  try {
    useSimulatorStore.getState().markComponentBurnt?.(componentId);
  } catch {
    /* store unavailable (test env) — ignore */
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(
        new CustomEvent('velxio-circuit-fault', {
          detail: { componentId, kind, message },
        }),
      );
    } catch {
      /* CustomEvent unavailable (test env) — the console.warn is enough */
    }
  }
}

/**
 * Report a burnt-out LED. `what` names the die in the message: "LED" for a
 * single LED, "RGB LED's red" for one colour of an RGB LED.
 */
export function reportLedBurnout(componentId: string, current: number, what = 'LED'): void {
  // Past LED_UNLIMITED_AMPS the solved current says only that nothing limits
  // it (an ideal source across a bare LED solves at trillions of amperes), so
  // the figure is left out, as the pre-run check does (velxio/velxio-prod#21).
  if (current > LED_UNLIMITED_AMPS) {
    reportLedFault(
      componentId,
      'led-burnout',
      `${what} burnt out — nothing limits its current (no series resistor), so a real LED ` +
        `burns out at once. Add a series resistor between the supply and the LED.`,
    );
    return;
  }
  const mA = current * 1000;
  const amount = mA >= 1000 ? `${(mA / 1000).toFixed(1)} A` : `${mA.toFixed(0)} mA`;
  reportLedFault(
    componentId,
    'led-burnout',
    `${what} burnt out — it drew ${amount}, far above its ~20 mA limit. ` +
      `Add a series resistor between the supply and the LED.`,
  );
}

/**
 * What the latest solve says about one LED die, read from its 0 V sense source.
 *
 *  - 'none': no solve has a current for it yet (engine warming up, between
 *    solves): the caller holds its last value or falls back to the pin level.
 *  - 'unstable': ngspice returned a non-finite current, which in practice is a
 *    forward-biased die with no series resistor (no stable operating point).
 *  - 'over': a destructive current, above LED_BURNOUT_A (the peak of a window).
 *  - 'lit': `brightness` 0..1 and whether it shows at all.
 *
 * For `.tran` circuits the scalar current is the last sample (≈ steady state).
 * If a full waveform is available we instead compute the period-averaged |I|,
 * which is what a real observer sees — a 50 Hz rectified LED does not flicker
 * to the eye, it glows at ~Ipeak/π of its peak brightness. Averaged over TIME,
 * on the span a meter reads (whole periods, after settling): a plain average of
 * ngspice's points, crowded after every edge, lit an RC-coupled LED at 20 % for
 * a 1 % mean current (velxio/velxio-prod#106).
 *
 * A publish window is the circuit over the last few tens of milliseconds as the
 * pad states it went through, each with its share. The eye integrates light
 * over about that long, so the die shows the time-weighted brightness of those
 * states: a 50 ms pulse is on for 50 ms, a PWM pad glows at its duty, a scanned
 * LED bar lights every LED for exactly as long as its pin was high. The burnout
 * check uses the highest current of the window: a short overcurrent is still an
 * overcurrent.
 */
export type LedBranchReading =
  | { kind: 'none' }
  | { kind: 'unstable' }
  | { kind: 'over'; current: number }
  | { kind: 'lit'; brightness: number; on: boolean };

export function solvedLedBranch(iKey: string): LedBranchReading {
  const { branchCurrents, timeWaveforms, window } = useElectricalStore.getState();
  let raw = branchCurrents[iKey];
  if (timeWaveforms) {
    const samples = timeWaveforms.branches.get(iKey);
    if (samples && samples.length > 0) {
      const span = readSpan(timeWaveforms.time, timeWaveforms.period);
      const stats = span ? spanStats(timeWaveforms.time, samples, span) : null;
      raw = stats ? stats.meanAbs : Math.abs(samples[samples.length - 1]!);
    }
  }
  let windowBrightness: number | undefined;
  if (!timeWaveforms && window && window.states.length > 1) {
    let seen = false;
    let mean = 0;
    let peak = 0;
    for (const st of window.states) {
      const i = st.branchCurrents[iKey];
      if (i === undefined) continue;
      if (!Number.isFinite(i)) {
        peak = i;
        seen = true;
        break;
      }
      seen = true;
      const a = Math.abs(i);
      if (a > peak) peak = a;
      mean += st.weight * Math.min(1, a / LED_RATED_MAX_A);
    }
    if (seen) {
      windowBrightness = mean;
      raw = peak;
    }
  }
  // A non-finite branch current that ngspice actually returned is NOT "no
  // data": the solver found no stable operating point for this die, the
  // textbook missing series resistor. `raw === undefined` is the engine
  // warming up instead.
  if (raw === undefined) return { kind: 'none' };
  if (!Number.isFinite(raw)) return { kind: 'unstable' };
  const current = Math.abs(raw);
  if (current > LED_BURNOUT_A) return { kind: 'over', current };
  if (windowBrightness !== undefined) {
    return { kind: 'lit', brightness: windowBrightness, on: windowBrightness > 1e-3 };
  }
  return { kind: 'lit', brightness: Math.min(1, current / LED_RATED_MAX_A), on: current > 1e-6 };
}
