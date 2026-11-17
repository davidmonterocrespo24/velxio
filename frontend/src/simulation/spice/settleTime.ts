/**
 * How long a circuit driven by a periodic source takes to reach its periodic
 * steady state, and the transient that skips that start-up.
 *
 * Every transient starts at t = 0 from the operating point of that instant.
 * A meter, the LED, the ADC and the scope all want the circuit as it runs,
 * not as it powers up, and the window used to be four periods of the slowest
 * source whatever the circuit's own time constant: a 490 Hz square wave into
 * 10 kΩ / 10 µF ran 8.16 ms of a 100 ms time constant and read 0.195 V for a
 * filter that sits at 2.5 V (velxio/velxio-prod#143). ngspice's TSTART runs
 * the circuit for that long without storing it, and stores only the window
 * after it (manual 11.3.10).
 *
 * When there is a start-up to skip (startUpSeconds):
 *  - A square wave (PULSE) starts at its low level, so the operating point at
 *    t = 0 charges every capacitor for that level, while the circuit runs
 *    about the wave's mean: a filter starts at 0 V and climbs to 2.5 V.
 *  - A diode rectifies, and the capacitors it charges start empty. A
 *    reservoir or a clamp's capacitor fills through the diode in the first
 *    cycles and tops up every cycle after, so it is settled almost at once;
 *    a voltage doubler's output fills through its pump capacitor a little
 *    each cycle, over many. The estimate below takes a capacitor's discharge
 *    time constant through its load, which overstates what a rectifier needs:
 *    that costs time, not accuracy. (The smoothed rectifier's first settled
 *    reading, 9.146 V for 8.766 V, was the step's error, not the start-up's:
 *    DIODE_STEP_DIVISOR.)
 *  - A sine starts at its offset, which is its mean: a linear circuit's
 *    operating point at t = 0 is already its steady-state DC. What it lacks
 *    is each capacitor's share of the AC (each inductor's), and that
 *    difference decays with the circuit's time constant. The meters read the
 *    second half of the window, so a filter slower than that was read in its
 *    start-up: 1 kHz into 10 kΩ / 1 µF (τ = 10 ms) read pk 26.88 mV, DC
 *    10.59 mV and RMS 15.40 mV across C, for 15.91 mV peak, no DC and
 *    11.25 mV RMS (velxio/velxio-prod#120). Such a deck runs SETTLE_TAUS of
 *    its time constant when they reach past the first half of the window and
 *    fit MAX_SETTLE_STEPS. A longer one is left alone: for a coupling
 *    capacitor (an amplifier's, seconds through a megohm bias network) the
 *    difference is a ripple-sized part of the signal it passes, and a
 *    first-order filter that slow (ωτ above 449 at a twentieth of a period)
 *    passes less than 1/449 of its source.
 *
 * The time constant is estimated from the deck's own cards, which know the
 * real nets (breadboard strips, rails, ground) and the sources, the way the
 * open- and short-circuit time constant methods do:
 *  - Nets joined by a voltage-defined element (a V source, an E source, a
 *    B source with V=) move together; the groups that contain ground are
 *    held by ideal sources (board rails and pads, a generator's output).
 *  - A capacitor whose two ends are held adds nothing to wait for (one
 *    across a rail or across the generator). Otherwise its time constant is
 *    C times the resistance each free end sees: the resistors that leave its
 *    group, in parallel, with the inductors as shorts.
 *  - An inductor's is L over that resistance, with the capacitors as shorts:
 *    a series RLC decays with 2L/R, and L/R is within that factor of 2.
 *  - A resistance of PROBE_OHMS or more is a meter's input or a model's leak
 *    (the voltmeter's 10 MΩ, a floating net's pull-down, an open switch), not
 *    a path a real circuit settles through: on an op-amp's output, which the
 *    deck cannot see is driven, a voltmeter made a 100 nF feedback capacitor
 *    look like a 1 s time constant.
 * It is an estimate: the true slowest mode of a circuit with transistors or
 * op-amps differs. What a wrong one costs is bounded by MAX_SETTLE_STEPS.
 */
import { parseValueWithUnits } from './valueParser';

/** Time constants the start-up runs: e^-7 is 0.09 %, so a meter's mean is
 *  within 0.1 % of the steady state (5 τ would leave 0.7 %). */
export const SETTLE_TAUS = 7;

/**
 * The start-up's budget, in plain steps: a twentieth of the fastest source's
 * period, the step a deck that cannot resonate integrates at (ngspice holds
 * every step of a transient to its TSTEP, stored or not). About 0.2-0.3 s of
 * engine time for a small circuit; a time constant that would need more is
 * cut there, and the window then holds what remains of its approach.
 * The budget is that length of time whatever the run integrates at. A deck
 * that holds a diode runs at a DIODE_STEP_DIVISOR-th of the plain step
 * (settledStepS), so it takes up to that many times as many steps; a deck
 * that can resonate runs at a fifth of it (velxio/velxio-prod#121; the
 * analysis' `budgetStep` is the plain step), so it takes up to five times as
 * many, 50 000. Counted in that finer step, its start-up was a fifth as long,
 * and a 1 kHz square wave into 100 Ω, 10 mH and 470 µF read 2.229 V for 2.5 V.
 */
export const MAX_SETTLE_STEPS = 10_000;

/**
 * How much finer than the window's step a deck that settles and holds a diode
 * runs.
 *
 * A diode conducts in short pulses around the source's peaks: a 50 Hz
 * rectifier's reservoir recharges for about 2 ms of each 20 ms period. The
 * window's step, a twentieth of a period, is also ngspice's largest step
 * (TMAX defaults to TSTEP), and ngspice did not shorten it through those
 * pulses (801 time points for the rectifier's 0.78 s): each pulse was two or
 * three points, every cycle left the capacitor a little off, and the
 * start-up's tens of cycles settled it there. The gallery's
 * smoothed rectifier read 9.146 V for 8.766 V (+4.3 %), its clamper +2.5 %,
 * a doubler on a 1 kΩ load +2.9 %. At half the step the gallery's three
 * settled diode decks and twelve variants (other loads, capacitors, diodes,
 * 50 Hz to 1 kHz, a square wave) read within 0.5 % of a run at a fiftieth of
 * it, for twice the steps; a quarter of the step buys 0.03 % for four times.
 */
export const DIODE_STEP_DIVISOR = 2;

/** See the module comment: a resistance this large is not a settling path. */
export const PROBE_OHMS = 10e6;

/** One element card: its letter, its two first nodes and its value. */
interface Card {
  kind: string;
  a: string;
  b: string;
  value: number;
  line: string;
}

function parseCards(cards: readonly string[]): Card[] {
  const out: Card[] = [];
  for (const line of cards) {
    const t = line.trim().split(/\s+/);
    if (t.length < 3 || !t[0]) continue;
    let kind = t[0][0]!.toUpperCase();
    // A behavioural source holds its nodes only as a voltage (V=...).
    if (kind === 'B' && !/\bv\s*=/i.test(line)) continue;
    if (kind === 'B') kind = 'E';
    if (!'RCLVED'.includes(kind)) continue;
    const value = kind === 'R' || kind === 'C' || kind === 'L' ? parseValueWithUnits(t[3]) : NaN;
    out.push({ kind, a: t[1]!.toLowerCase(), b: t[2]!.toLowerCase(), value, line });
  }
  return out;
}

/**
 * True when the deck's operating point at t = 0 is not its periodic steady
 * state: a square wave starts at its low level, a diode rectifies. See the
 * module comment.
 */
export function startsAwayFromSteadyState(cards: readonly string[]): boolean {
  return parseCards(cards).some(
    (c) => (c.kind === 'V' && /\bpulse\s*\(/i.test(c.line)) || c.kind === 'D',
  );
}

/**
 * The start-up a transient runs before the window it stores, in seconds (0
 * for none), for a deck whose cards are `cards`, whose window is `windowS`
 * long at a step of `stepS`, and whose slowest source has the period
 * `periodS`. See the module comment.
 */
export function startUpSeconds(
  cards: readonly string[],
  stepS: number,
  windowS: number,
  periodS: number | undefined,
): number {
  const tau = largestTimeConstant(cards);
  if (startsAwayFromSteadyState(cards)) return settleSeconds(tau, stepS, periodS);
  // Driven by sines alone: over before the meters read, or too slow to matter.
  if (!(tau > 0) || SETTLE_TAUS * tau <= windowS / 2) return 0;
  if (SETTLE_TAUS * tau > MAX_SETTLE_STEPS * stepS) return 0;
  return settleSeconds(tau, stepS, periodS);
}

/**
 * The step a deck that settles runs at: the window's, or a
 * DIODE_STEP_DIVISOR-th of the plain step (`plainStepS`, which a resonant
 * deck's window step is finer than: storeAdapter's budgetStep) when the deck
 * holds a diode (a D card: a rectifier, an LED, a board pin's clamp) and the
 * window's is coarser than that. A resonant deck at a hundredth of its period
 * already resolves the conduction pulses better than half the plain step
 * does, so it is not halved again. The start-up is sized in plain steps all
 * the same (settleSeconds).
 */
export function settledStepS(
  cards: readonly string[],
  windowStepS: number,
  plainStepS: number = windowStepS,
): number {
  return parseCards(cards).some((c) => c.kind === 'D')
    ? Math.min(windowStepS, plainStepS / DIODE_STEP_DIVISOR)
    : windowStepS;
}

/** Nets joined by voltage-defined elements and by the element kinds that act
 *  as shorts for the estimate at hand. */
function netGroups(parsed: readonly Card[], shorts: string) {
  const parent = new Map<string, string>();
  const find = (n: string): string => {
    if (!parent.has(n)) {
      parent.set(n, n);
      return n;
    }
    let r = n;
    while (parent.get(r) !== r) r = parent.get(r)!;
    for (let c = n; c !== r; ) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  for (const c of parsed) {
    if (c.kind === 'V' || c.kind === 'E' || shorts.includes(c.kind)) {
      const ra = find(c.a);
      const rb = find(c.b);
      if (ra !== rb) parent.set(ra, rb);
    }
  }
  const ground = find('0');
  const conductance = new Map<string, number>();
  for (const c of parsed) {
    if (c.kind !== 'R' || !(c.value > 0) || c.value >= PROBE_OHMS) continue;
    const ga = find(c.a);
    const gb = find(c.b);
    if (ga === gb) continue; // shorted: no path through it
    conductance.set(ga, (conductance.get(ga) ?? 0) + 1 / c.value);
    conductance.set(gb, (conductance.get(gb) ?? 0) + 1 / c.value);
  }
  return {
    same: (x: string, y: string) => find(x) === find(y),
    held: (n: string) => find(n) === ground,
    /** The resistance an end sees: 0 when held, Infinity with no path. */
    seen: (n: string): number => {
      if (find(n) === ground) return 0;
      const g = conductance.get(find(n)) ?? 0;
      return g > 0 ? 1 / g : Infinity;
    },
  };
}

/**
 * The largest time constant of the deck's capacitors and inductors, in
 * seconds, or 0 when none has a resistive path to settle through.
 */
export function largestTimeConstant(cards: readonly string[]): number {
  const parsed = parseCards(cards);
  const forC = netGroups(parsed, 'L');
  const forL = netGroups(parsed, 'C');
  let tau = 0;
  for (const c of parsed) {
    if (!(c.value > 0)) continue;
    if (c.kind === 'C') {
      if (forC.same(c.a, c.b) || (forC.held(c.a) && forC.held(c.b))) continue;
      // An end with no path (a peak detector with no load, an op-amp's
      // output) leaves it to whatever drives that end.
      const r = forC.seen(c.a) + forC.seen(c.b);
      if (Number.isFinite(r) && r > 0) tau = Math.max(tau, c.value * r);
    } else if (c.kind === 'L') {
      if (forL.same(c.a, c.b)) continue;
      const ra = forL.seen(c.a);
      const rb = forL.seen(c.b);
      const r = (Number.isFinite(ra) ? ra : 0) + (Number.isFinite(rb) ? rb : 0);
      if (r > 0) tau = Math.max(tau, c.value / r);
    }
  }
  return tau;
}

/**
 * The start of the stored window: SETTLE_TAUS time constants, at most
 * MAX_SETTLE_STEPS steps of `stepS` (the plain step the budget counts in, not
 * a resonant deck's finer one), in whole periods of the slowest source
 * where the budget allows (so every capture starts at the same phase, and a
 * window replayed in a loop joins up): rounded up when that stays within the
 * budget, down when a whole period still fits, as it is otherwise. A slow
 * source with a fast one (1 Hz and 1 kHz) has periods of 20 000 steps, so
 * rounding up alone could double the budget. 0 when there is nothing to wait
 * for.
 */
export function settleSeconds(tau: number, stepS: number, periodS: number | undefined): number {
  if (!(tau > 0) || !(stepS > 0)) return 0;
  const budget = MAX_SETTLE_STEPS * stepS;
  const wanted = Math.min(SETTLE_TAUS * tau, budget);
  if (!(periodS && periodS > 0)) return wanted;
  const up = Math.ceil(wanted / periodS - 1e-9) * periodS;
  if (up <= budget * (1 + 1e-9)) return up;
  const down = Math.floor(wanted / periodS + 1e-9) * periodS;
  return down > 0 ? down : wanted;
}
