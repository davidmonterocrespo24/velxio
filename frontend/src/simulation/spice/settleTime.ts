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
 * When there is a start-up to skip (startsAwayFromSteadyState):
 *  - A square wave (PULSE) starts at its low level, so the operating point at
 *    t = 0 charges every capacitor for that level, while the circuit runs
 *    about the wave's mean: a filter starts at 0 V and climbs to 2.5 V.
 *  - A diode rectifies: a reservoir capacitor, a clamp or a voltage doubler
 *    builds its DC level up over many cycles.
 *  - A sine starts at its offset, which is its mean: a linear circuit's
 *    operating point at t = 0 is already its steady-state DC, and what is
 *    left to settle is a ripple-sized transient. Such decks are not run any
 *    longer than before, so an amplifier's coupling capacitors (seconds
 *    through a megohm bias network) cost nothing.
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
 * The most time steps the start-up may take, at the window's own step (ngspice
 * holds every step of a transient to its TSTEP, stored or not). About 0.2-0.3 s
 * of engine time for a small circuit; a time constant that would need more
 * is cut there, and the window then holds what remains of its approach.
 */
export const MAX_SETTLE_STEPS = 10_000;

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
 * The start of the stored window: SETTLE_TAUS time constants, rounded up to
 * whole periods of the slowest source (so every capture starts at the same
 * phase, and a window replayed in a loop joins up), and at most
 * MAX_SETTLE_STEPS steps of `stepS`. 0 when there is nothing to wait for.
 */
export function settleSeconds(tau: number, stepS: number, periodS: number | undefined): number {
  if (!(tau > 0) || !(stepS > 0)) return 0;
  const wanted = Math.min(SETTLE_TAUS * tau, MAX_SETTLE_STEPS * stepS);
  if (!(periodS && periodS > 0)) return wanted;
  return Math.ceil(wanted / periodS - 1e-9) * periodS;
}
