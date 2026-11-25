/**
 * Transistor overstress (velxio/velxio-prod#138): what a solve says a
 * transistor went through, held to its datasheet ratings (PartRatings, in
 * the part's metadata). The circuit check before Run reads it from its own
 * solves (circuitVerifier, Rule 7); the runtime monitor from what the live
 * solve publishes (runtimeBurnout). Both only warn: a real part over a rating
 * may survive, or fail later, and the circuit runs on either way.
 *
 * Each rating is read the way the part fails by it:
 *   - Voltage, V_CEO or V_DSS: the highest the part blocks, anywhere (an
 *     operating point, a pad state, any sample of a capture). A junction
 *     breaks down at once. The models break down just past the rating (#110,
 *     bjtBreakdownSubckt), so a coil switched off with no flyback diode shows
 *     up as a clamp under a volt over it (40.88 V on a 2N2222 cutting the
 *     relay's 71 mA).
 *   - Current, I_C or I_D: its RMS over what the circuit keeps doing (the
 *     operating point, the pad states by their shares of the window, a
 *     periodic capture over whole periods) against the continuous rating, and
 *     its peak, in a step or a capture too, against the pulsed rating I_CM or
 *     I_DM where the datasheet gives one, else the continuous one.
 *   - Power, P_D: V_CE x I_C + V_BE x I_B (V_DS x I_D on a MOSFET, whose gate
 *     draws nothing at DC), averaged as heat is, over the same steady view,
 *     against what the part sheds in free air at 25 °C, or its P_D at a 25 °C
 *     case when its `heatsink` property says it is mounted on one. A step's
 *     switching burst is over in microseconds and heats nothing that the
 *     steady view does not.
 *
 * Pure: the solve's node voltages and the currents of the 0 V sources the
 * part's mapper puts in its leads (transistorSenseKeys).
 */
import type { PartRatings } from '../../types/component-metadata';
import type { TimeWaveforms } from '../spice/types';
import { transistorSenseKeys } from '../spice/componentToSpice';
import { formatQuantity } from '../spice/valueParser';
import { readSpan, spanStats } from '../spice/waveformStats';

export type { PartRatings };

/** A part's ratings with the name it is sold under ("2N2222"). */
export interface RatedPart {
  ratings: PartRatings;
  /** The catalogue's name, e.g. "2N2222 (NPN BJT)": the part number is its first word. */
  name: string;
}

/** Where a part's ratings come from: its metadata, by metadataId. */
export type RatingsLookup = (metadataId: string) => RatedPart | undefined;

/** One state the pads held in a publish window (useElectricalStore's SolveWindowState). */
interface WindowState {
  weight: number;
  nodeVoltages: Record<string, number>;
  branchCurrents: Record<string, number>;
  timeWaveforms?: TimeWaveforms;
}

/** What a solve says the circuit did, as the electrical store publishes it. */
export interface TransistorSolveView {
  /** The operating point (a transient's last sample). */
  nodeVoltages: Record<string, number>;
  branchCurrents: Record<string, number>;
  /** The pad states of the publish window with their shares of it. */
  window?: { states: ReadonlyArray<WindowState> };
  /** The state's own capture, which repeats (a generator, an AC supply, a scope window). */
  timeWaveforms?: TimeWaveforms;
  /** The step since the pads last changed, which happens once (TimeWaveforms.oneShot). */
  stepWaveforms?: TimeWaveforms;
}

/** What a transistor went through over a solve, as its ratings read it. */
export interface TransistorReading {
  /** The highest voltage it blocks (V_CE on an NPN, V_EC on a PNP, V_DS / V_SD), V. */
  vPeak: number;
  /** The same over the operating points only: what the circuit holds, not a transient. */
  vSteady: number;
  /** RMS of I_C / I_D over the steady view, A; NaN when its sense source is missing. */
  iRms: number;
  /** Its largest magnitude anywhere, A; NaN when its sense source is missing. */
  iPeak: number;
  /** Mean power over the steady view, W; NaN when a current is missing. */
  pMean: number;
  /** The steady view was a capture or a window, not one instant. */
  averaged: boolean;
}

export interface TransistorFinding {
  rule: 'voltage' | 'current' | 'power';
  /** The reading that passed the rating (V, A or W). */
  value: number;
  /** The rating it passed. */
  limit: number;
  /**
   * A thermal rating (the continuous current, the power): it matters when
   * the circuit stays there. A state the live solve passes through for a few
   * milliseconds (a sketch's setup() before it writes its first value) does
   * not heat the part; the runtime monitor waits before it says so. The
   * breakdown voltage and the pulsed current are not: they are instants.
   */
  sustained: boolean;
  message: string;
}

const isBipolar = (kind: PartRatings['kind']): boolean => kind === 'npn' || kind === 'pnp';

/** The part number from the catalogue's name: "2N2222 (NPN BJT)" is a 2N2222. */
function partNumber(name: string, fallback: string): string {
  const first = name.trim().split(/\s+/)[0];
  return first && first.length > 0 ? first : fallback;
}

interface Leads {
  main: string;
  control: string | null;
  ref: string;
  mainKey: string;
  controlKey: string | null;
  /** +1 when the part blocks with its main lead above its reference (NPN, N-channel). */
  sign: number;
}

function leadsOf(id: string, kind: PartRatings['kind'], pinNetMap: ReadonlyMap<string, string>): Leads | null {
  const bipolar = isBipolar(kind);
  const net = (pin: string) => pinNetMap.get(`${id}:${pin}`);
  const main = net(bipolar ? 'C' : 'D');
  const ref = net(bipolar ? 'E' : 'S');
  if (main === undefined || ref === undefined) return null;
  const keys = transistorSenseKeys(id, bipolar);
  return {
    main,
    ref,
    control: net(bipolar ? 'B' : 'G') ?? null,
    mainKey: keys.main,
    controlKey: keys.control,
    sign: kind === 'npn' || kind === 'nmos' ? 1 : -1,
  };
}

/** One instant: the blocked voltage, the main current and the power. */
interface Instant {
  v: number;
  i: number;
  p: number;
}

function instantOf(
  leads: Leads,
  volts: (net: string) => number | undefined,
  amps: (key: string) => number | undefined,
): Instant | null {
  const vm = volts(leads.main);
  const vr = volts(leads.ref);
  if (vm === undefined || vr === undefined) return null;
  const im = amps(leads.mainKey);
  let p = im === undefined ? NaN : (vm - vr) * im;
  if (leads.controlKey !== null && Number.isFinite(p)) {
    const vc = leads.control === null ? undefined : volts(leads.control);
    const ic = amps(leads.controlKey);
    p = vc === undefined || ic === undefined ? NaN : p + (vc - vr) * ic;
  }
  return { v: leads.sign * (vm - vr), i: im === undefined ? NaN : Math.abs(im), p };
}

const finite = (x: number | undefined): number | undefined => (x !== undefined && Number.isFinite(x) ? x : undefined);

function instantAtOp(leads: Leads, nodeVoltages: Record<string, number>, branchCurrents: Record<string, number>) {
  return instantOf(
    leads,
    (net) => (net === '0' ? 0 : finite(nodeVoltages[net])),
    (key) => finite(branchCurrents[key]),
  );
}

/**
 * A capture as samples of the three, or null when a node it needs is not in
 * it. A current the capture lacks makes the current and the power NaN, as
 * instantOf does, and the voltage stands.
 */
function seriesOf(leads: Leads, tw: TimeWaveforms): Instant[] | null {
  const n = tw.time.length;
  if (n < 2) return null;
  // null: ground, 0 V; undefined: not in the capture.
  const node = (net: string | null): number[] | null | undefined =>
    net === null ? undefined : net === '0' ? null : tw.nodes.get(net);
  const main = node(leads.main);
  const ref = node(leads.ref);
  if (main === undefined || ref === undefined) return null;
  const ctrl = node(leads.control);
  const im = tw.branches.get(leads.mainKey);
  const ic = leads.controlKey === null ? null : tw.branches.get(leads.controlKey);
  const at = (s: number[] | null | undefined, k: number): number => (s === null ? 0 : s === undefined ? NaN : (s[k] ?? NaN));
  const out = new Array<Instant>(n);
  for (let k = 0; k < n; k++) {
    const vm = at(main, k);
    const vr = at(ref, k);
    if (!Number.isFinite(vm) || !Number.isFinite(vr)) return null;
    const i = im ? (im[k] ?? NaN) : NaN;
    let p = (vm - vr) * i;
    if (ic !== null) p += (at(ctrl, k) - vr) * (ic ? (ic[k] ?? NaN) : NaN);
    out[k] = { v: leads.sign * (vm - vr), i: Math.abs(i), p };
  }
  return out;
}

interface CaptureStats {
  vPeak: number;
  iPeak: number;
  pMean: number;
  iRms: number;
}

/**
 * A capture's stats per transistor, kept with the capture: the circuit
 * service caches each pad state's capture and publishes the same object
 * again every window that state comes back, and the runtime monitor reads
 * every publish.
 */
const captureMemo = new WeakMap<TimeWaveforms, Map<string, CaptureStats | null>>();

function statsOf(leads: Leads, tw: TimeWaveforms): CaptureStats | null {
  const key = `${leads.sign}|${leads.main}|${leads.ref}|${leads.control}|${leads.mainKey}|${leads.controlKey}`;
  let memo = captureMemo.get(tw);
  if (!memo) captureMemo.set(tw, (memo = new Map()));
  if (memo.has(key)) return memo.get(key)!;
  const series = seriesOf(leads, tw);
  const stats = series ? captureStats(series, tw) : null;
  memo.set(key, stats);
  return stats;
}

/** Peaks over a whole capture, and the mean power and RMS current over the span its meters read. */
function captureStats(series: Instant[], tw: TimeWaveforms): CaptureStats {
  let vPeak = -Infinity;
  let iPeak = 0;
  for (const s of series) {
    if (s.v > vPeak) vPeak = s.v;
    if (s.i > iPeak) iPeak = s.i;
  }
  const span = readSpan(tw.time, tw.period);
  const pStats = span ? spanStats(tw.time, series.map((s) => s.p), span) : null;
  const iStats = span ? spanStats(tw.time, series.map((s) => s.i), span) : null;
  return {
    vPeak,
    iPeak: series.some((s) => Number.isNaN(s.i)) ? NaN : iPeak,
    pMean: pStats ? pStats.mean : NaN,
    iRms: iStats ? iStats.rms : NaN,
  };
}

/**
 * What the transistor `id` went through over `view`, held as its `kind`
 * blocks; null when its collector and emitter (drain and source) are not
 * both on solved nets.
 */
export function readTransistor(
  id: string,
  kind: PartRatings['kind'],
  pinNetMap: ReadonlyMap<string, string>,
  view: TransistorSolveView,
): TransistorReading | null {
  const leads = leadsOf(id, kind, pinNetMap);
  if (!leads) return null;
  const op = instantAtOp(leads, view.nodeVoltages, view.branchCurrents);

  // The steady view: the window's pad states by their shares, else the
  // state's own capture, else the operating point.
  let vPeak = op ? op.v : -Infinity;
  let vSteady = op ? op.v : -Infinity;
  let iPeak = op ? op.i : NaN;
  let iRms = op ? op.i : NaN;
  let pMean = op ? op.p : NaN;
  let averaged = false;
  const states = view.window?.states;
  if (states && states.length > 1) {
    let w = 0;
    let p = 0;
    let i2 = 0;
    let any = false;
    for (const st of states) {
      if (!(st.weight > 0)) continue;
      const fromCapture = st.timeWaveforms ? statsOf(leads, st.timeWaveforms) : null;
      const at = instantAtOp(leads, st.nodeVoltages, st.branchCurrents);
      if (at) vSteady = Math.max(vSteady, at.v);
      const s = fromCapture ?? (at ? { vPeak: at.v, iPeak: at.i, pMean: at.p, iRms: at.i } : null);
      if (!s) continue;
      any = true;
      vPeak = Math.max(vPeak, s.vPeak);
      iPeak = Number.isNaN(iPeak) ? s.iPeak : Math.max(iPeak, s.iPeak);
      w += st.weight;
      p += st.weight * s.pMean;
      i2 += st.weight * s.iRms * s.iRms;
    }
    if (any && w > 0) {
      pMean = p / w;
      iRms = Math.sqrt(i2 / w);
      averaged = true;
    }
  } else if (view.timeWaveforms) {
    const s = statsOf(leads, view.timeWaveforms);
    if (s) {
      vPeak = Math.max(vPeak, s.vPeak);
      iPeak = Number.isNaN(iPeak) ? s.iPeak : Math.max(iPeak, s.iPeak);
      pMean = s.pMean;
      iRms = s.iRms;
      averaged = true;
    }
  }

  // A step happens once: its peaks count, its burst is not a steady load.
  if (view.stepWaveforms) {
    const s = statsOf(leads, view.stepWaveforms);
    if (s) {
      vPeak = Math.max(vPeak, s.vPeak);
      iPeak = Number.isNaN(iPeak) ? s.iPeak : Math.max(iPeak, s.iPeak);
    }
  }
  if (!Number.isFinite(vPeak)) return null;
  return { vPeak, vSteady, iRms, iPeak, pMean, averaged };
}

/**
 * The ratings `reading` passes, worded for the part `id` (metadata name
 * `part.name`): at most one finding per rating, the voltage first. A part
 * whose `heatsink` property is on (`onHeatsink`) is held to its P_D at a
 * 25 °C case, when its datasheet gives one, instead of free air.
 */
export function transistorFindings(
  id: string,
  part: RatedPart,
  reading: TransistorReading,
  onHeatsink = false,
): TransistorFinding[] {
  const { ratings } = part;
  const bipolar = isBipolar(ratings.kind);
  const what = `Transistor ${id} (${partNumber(part.name, ratings.kind.toUpperCase())})`;
  const out: TransistorFinding[] = [];

  if (reading.vPeak > ratings.vMax) {
    const across = bipolar ? 'its collector and emitter' : 'its drain and source';
    const symbol = bipolar ? 'V_CEO' : 'V_DSS';
    const rating = `its ${formatQuantity(ratings.vMax, 'V')} rating (${symbol})`;
    out.push({
      rule: 'voltage',
      value: reading.vPeak,
      limit: ratings.vMax,
      sustained: false,
      message:
        reading.vSteady > ratings.vMax
          ? `${what} has ${formatQuantity(reading.vSteady, 'V')} between ${across}, above ${rating}: a real one ` +
            `breaks down. Use a transistor rated for more, or a lower supply.`
          : `${what} reaches ${formatQuantity(reading.vPeak, 'V')} between ${across}, above ${rating}. ` +
            `A real one ${bipolar ? 'breaks down' : 'avalanches'} there, turning the energy into heat, and can fail. ` +
            `A coil (a relay, a motor, a solenoid) switched off with no diode across it does this: fit a ` +
            `flyback diode across the coil, its cathode on the supply side.`,
    });
  }

  const steadyAmps = reading.iRms;
  const pulsed = ratings.iPulse;
  const symbolI = bipolar ? 'I_C' : 'I_D';
  if (steadyAmps > ratings.iMax) {
    out.push({
      rule: 'current',
      value: steadyAmps,
      limit: ratings.iMax,
      sustained: true,
      message:
        `${what} carries ${formatQuantity(steadyAmps, 'A')}${reading.averaged ? ' RMS' : ''}, above its ` +
        `${formatQuantity(ratings.iMax, 'A')} rating (${symbolI}). Limit the load's current, or use a ` +
        `transistor rated for more.`,
    });
  } else if (reading.iPeak > (pulsed ?? ratings.iMax)) {
    const limit = pulsed ?? ratings.iMax;
    out.push({
      rule: 'current',
      value: reading.iPeak,
      limit,
      sustained: false,
      message:
        `${what} reaches ${formatQuantity(reading.iPeak, 'A')} at its peak, above its ` +
        (pulsed !== undefined
          ? `${formatQuantity(pulsed, 'A')} pulsed rating (${bipolar ? 'I_CM' : 'I_DM'}). `
          : `${formatQuantity(ratings.iMax, 'A')} rating (${symbolI}). `) +
        `Limit the current it switches, or use a transistor rated for more.`,
    });
  }

  const heatsink = onHeatsink && ratings.pMaxHeatsink !== undefined ? ratings.pMaxHeatsink : undefined;
  const pLimit = heatsink ?? ratings.pMax;
  if (reading.pMean > pLimit) {
    const dissipates = `${what} dissipates ${formatQuantity(reading.pMean, 'W')}${reading.averaged ? ' on average' : ''}`;
    out.push({
      rule: 'power',
      value: reading.pMean,
      limit: pLimit,
      sustained: true,
      message:
        heatsink !== undefined
          ? `${dissipates}, above the ${formatQuantity(heatsink, 'W')} it takes even on a heatsink (P_D at a ` +
            `25 °C case): a real one overheats. Drive it fully on, so it drops less voltage, or share the load ` +
            `between transistors.`
          : `${dissipates}, above the ${formatQuantity(ratings.pMax, 'W')} it can shed in free air (P_D at 25 °C): ` +
            `a real one overheats. Drive it fully on, so it drops less voltage` +
            (ratings.pMaxHeatsink !== undefined
              ? `; or, if it has to dissipate this, mount it on a heatsink (its heatsink property).`
              : `, or use a bigger transistor on a heatsink.`),
    });
  }
  return out;
}
