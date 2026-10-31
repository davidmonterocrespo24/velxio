/**
 * Oscilloscope / Logic Analyzer store.
 *
 * Captures pin HIGH/LOW transitions with microsecond-level timestamps
 * derived from the CPU cycle counter and renders them as waveforms.
 *
 * Channels are keyed by (boardId, pin) so multiple boards with the same
 * logical pin number can be monitored independently.
 *
 * Trigger model — matches a real digital storage scope:
 *
 *   - `auto`   free-running display; the window's right edge tracks the
 *              latest sample.  This is the default and the behaviour
 *              existing test suites depend on.
 *
 *   - `normal` window pins around each triggering edge: the trigger
 *              event lands at `triggerPosition * windowMs` from the
 *              left, with the rest of the window showing post-trigger
 *              samples.  The window holds steady until the next edge.
 *
 *   - `single` arms once: on the first triggering edge after arming the
 *              scope captures, then sets `running = false` so the trace
 *              freezes for inspection.  User must click "Single" again
 *              to re-arm.
 *
 * Edge detection looks at the configured trigger channel only.  The
 * trigger fires when the newly-pushed sample's state differs from the
 * previous one on that channel AND the transition matches the configured
 * `triggerEdge` (rising / falling / either).
 */

import { create } from 'zustand';

export const MAX_SAMPLES = 10_000;

/**
 * Per-analog-channel sample cap.
 *
 * Deliberately its own number, and far below MAX_SAMPLES: that cap is a
 * shift()-based ring sized for EDGES (a digital channel gets one sample per
 * transition), while a transient capture arrives as a dense block on every
 * re-solve. Sharing the digital cap would let one busy net evict every other
 * channel's history within a second.
 */
export const ANALOG_MAX_SAMPLES = 2_000;

/**
 * Reduce a capture to at most `limit` points by min/max pairs.
 *
 * Plain stride sampling would drop the peak of a spike between two strides and
 * quietly redraw the waveform as smooth. Taking BOTH extremes of each bucket
 * keeps the envelope, which is what a scope trace is for.
 */
export function decimateMinMax(
  timesMs: number[],
  volts: number[],
  limit: number,
): { timeMs: number; volts: number }[] {
  const n = Math.min(timesMs.length, volts.length);
  if (n === 0) return [];
  if (n <= limit) {
    const out: { timeMs: number; volts: number }[] = [];
    for (let i = 0; i < n; i++) out.push({ timeMs: timesMs[i]!, volts: volts[i]! });
    return out;
  }
  const buckets = Math.max(1, Math.floor(limit / 2));
  const width = n / buckets;
  const out: { timeMs: number; volts: number }[] = [];
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * width);
    const to = Math.min(n, Math.floor((b + 1) * width));
    if (to <= from) continue;
    let lo = from;
    let hi = from;
    for (let i = from; i < to; i++) {
      if (volts[i]! < volts[lo]!) lo = i;
      if (volts[i]! > volts[hi]!) hi = i;
    }
    // Emit in time order so the polyline never doubles back on itself.
    const [a, c] = lo <= hi ? [lo, hi] : [hi, lo];
    out.push({ timeMs: timesMs[a]!, volts: volts[a]! });
    if (c !== a) out.push({ timeMs: timesMs[c]!, volts: volts[c]! });
  }
  return out;
}

/** Distinct colors cycled through when adding new channels */
export const CHANNEL_COLORS = [
  '#00ff41',
  '#ff6b6b',
  '#4fc3f7',
  '#ffd54f',
  '#ce93d8',
  '#80cbc4',
  '#ffb74d',
  '#f06292',
];

/**
 * A channel is either a GPIO the board reports transitions for, or a SPICE net
 * the solver reports a voltage for. They are genuinely different sources —
 * one carries CPU-cycle timestamps at microsecond resolution, the other a
 * transient capture at solver cadence — so the channel says which it is rather
 * than leaving every reader to guess from a null field.
 *
 * `boardId` and `pin` stay REQUIRED on the digital arm and keep their meaning:
 * the id scheme, the dedupe and the ~28 test files that mock this store all
 * key on them.
 */
export interface OscChannelBase {
  id: string;
  label: string;
  color: string;
  /** Volts per vertical division. Digital channels derive a sensible default
   *  from the board's logic level so a square wave and an analog trace can
   *  share one volts axis honestly. */
  voltsPerDiv: number;
  /** Vertical offset in volts, so two traces can be separated on screen. */
  yOffsetV: number;
  /** Analog channels fit their vertical scale to each capture until the user
   *  sets V/div or the offset by hand (false from then on). */
  autoScale?: boolean;
}

export interface OscDigitalChannel extends OscChannelBase {
  kind: 'digital';
  /** Board that owns this channel */
  boardId: string;
  pin: number;
  /** Logic-high voltage of the owning board (5 V AVR, 3.3 V ESP32/RP2040). */
  amplitudeV: number;
}

export interface OscAnalogChannel extends OscChannelBase {
  kind: 'analog';
  /**
   * SPICE net name, from the map the solver PUBLISHES.
   *
   * Keyed on the NET, never on a wire id: splitting a wire with a junction
   * node deletes the original wire and mints two new ids, and a wire-keyed
   * channel would go dead the moment the user taps the wire it was watching.
   */
  netName: string;
}

export type OscChannel = OscDigitalChannel | OscAnalogChannel;

export interface OscSample {
  /** Time in milliseconds from simulation start */
  timeMs: number;
  /** Digital level. Always present so every existing reader keeps working. */
  state: boolean;
  /** Volts, on analog samples only. `state` carries the same value thresholded
   *  at half the channel's amplitude, so a digital-only reader (the trigger's
   *  edge detector, the old draw path) still sees something sane. */
  volts?: number;
}

export type TriggerMode = 'auto' | 'normal' | 'single';
export type TriggerEdge = 'rising' | 'falling' | 'either';
export type TriggerStatus = 'idle' | 'armed' | 'triggered' | 'captured';

interface OscilloscopeState {
  /** Whether the panel is visible */
  open: boolean;
  /** Whether capture is active (pause/resume independently of simulation) */
  running: boolean;
  /** Milliseconds per horizontal division (10 divisions shown) */
  timeDivMs: number;
  /** Channels currently monitored */
  channels: OscChannel[];
  /** Circular sample buffers keyed by channel id */
  samples: Record<string, OscSample[]>;

  // ── Trigger ───────────────────────────────────────────────────────────────
  triggerMode: TriggerMode;
  /** Channel that triggers the scope. `null` = first channel; reset on remove. */
  triggerChannelId: string | null;
  triggerEdge: TriggerEdge;
  /**
   * Fraction (0..1) of the visible window where the trigger event lands.
   * 0   = trigger at the left edge (all post-trigger samples)
   * 0.5 = trigger at the centre (default, equal pre and post)
   * 1   = trigger at the right edge (all pre-trigger samples)
   */
  triggerPosition: number;
  /** Level an ANALOG trigger channel must cross, in volts. Ignored for
   *  digital channels, which trigger on the bit flipping. */
  triggerLevelV: number;
  /** Simulator time of the most-recently latched trigger, or `null` when
   *  the scope is armed and waiting for an edge. */
  triggeredAtMs: number | null;
  /** Status surface for the UI badge. */
  triggerStatus: TriggerStatus;

  // ── Actions ────────────────────────────────────────────────────────────────

  toggleOscilloscope: () => void;
  /** Reveal the panel. Probing a wire must never CLOSE the scope for someone
   *  who already had it open, which a toggle would do. */
  openOscilloscope: () => void;
  setCapturing: (running: boolean) => void;
  setTimeDivMs: (ms: number) => void;
  addChannel: (boardId: string, pin: number, pinLabel: string, amplitudeV?: number) => void;
  /** Add (or reveal) a channel watching a SPICE net by name. Keyed on the NET
   *  so it survives the wire it was probed from being split by a junction. */
  addNetChannel: (netName: string, label: string) => string;
  removeChannel: (id: string) => void;
  /** Push one sample; drops the oldest if the buffer is full */
  pushSample: (channelId: string, timeMs: number, state: boolean) => void;
  /**
   * Append a whole transient capture to an analog channel in ONE update.
   *
   * Not pushSample in a loop: that copies the entire buffer and fires every
   * store subscriber per sample, and a SPICE capture arrives as hundreds of
   * points at once. Decimates to ANALOG_MAX_SAMPLES by min/max pairs so a
   * spike is never averaged away.
   */
  pushAnalogBlock: (channelId: string, timesMs: number[], volts: number[]) => void;
  setChannelVoltsPerDiv: (channelId: string, voltsPerDiv: number) => void;
  setChannelOffset: (channelId: string, yOffsetV: number) => void;
  clearSamples: () => void;

  setTriggerMode: (mode: TriggerMode) => void;
  setTriggerChannel: (channelId: string | null) => void;
  /** Volts an analog trigger channel must cross to fire. */
  setTriggerLevelV: (volts: number) => void;
  setTriggerEdge: (edge: TriggerEdge) => void;
  setTriggerPosition: (pos: number) => void;
  /** Reset the trigger (re-arm for single-shot, clear "triggered" status). */
  rearmTrigger: () => void;
}

/**
 * Test whether a new sample's state vs. the previous state constitutes a
 * triggering edge under the configured edge mode.  Exported so the
 * trigger logic can be unit-tested in isolation.
 */
export function matchesTriggerEdge(prevState: boolean, newState: boolean, edge: TriggerEdge): boolean {
  if (prevState === newState) return false;
  if (edge === 'either') return true;
  if (edge === 'rising' && !prevState && newState) return true;
  if (edge === 'falling' && prevState && !newState) return true;
  return false;
}

/**
 * Test whether an analog pair crosses `levelV` in the configured direction.
 *
 * Deliberately a SEPARATE function beside matchesTriggerEdge rather than a
 * widened signature: that one is exported and unit-tested in isolation, and
 * ~28 test files drive the boolean path. A level crossing is also a different
 * question — "did the voltage pass through this value", not "did the bit
 * flip".
 */
export function matchesLevelCrossing(
  prevV: number,
  newV: number,
  levelV: number,
  edge: TriggerEdge,
): boolean {
  const wasBelow = prevV < levelV;
  const isBelow = newV < levelV;
  if (wasBelow === isBelow) return false;
  if (edge === 'either') return true;
  if (edge === 'rising') return wasBelow && !isBelow;
  return !wasBelow && isBelow;
}

/**
 * Resolve the channel id the trigger should listen on.  If the user
 * hasn't explicitly picked one (or picked one that's since been removed),
 * fall back to the first channel — the most common single-channel case.
 */
function resolveTriggerChannelId(
  triggerChannelId: string | null,
  channels: OscChannel[],
): string | null {
  if (triggerChannelId && channels.some((c) => c.id === triggerChannelId)) {
    return triggerChannelId;
  }
  return channels[0]?.id ?? null;
}

/** Vertical divisions on the scope screen (Oscilloscope.tsx draws the same 8). */
export const OSC_V_DIVS = 8;

/**
 * V/div and centre that fit a capture, the way a scope's Auto button does.
 *
 * Analog channels used to open at a fixed 1 V/div around 0 V, so anything
 * outside +-4 V (a 5 V rail, a 9 V amplifier, a rectifier) drew off-screen,
 * and nothing in the UI could change it. The range always includes 0 V, like
 * DC coupling: a regulated rail reads as a flat line at its voltage instead of
 * its ripple blown up to full screen. V/div is the next 1-2-5 step that holds
 * the range with 20 % margin, and the centre sits on a whole division.
 */
export function fitAnalogScale(
  lo: number,
  hi: number,
): { voltsPerDiv: number; yOffsetV: number } {
  const a = Math.min(lo, 0);
  const b = Math.max(hi, 0);
  const span = Math.max(b - a, 1e-3) * 1.2;
  const raw = span / OSC_V_DIVS;
  const decade = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].find((m) => m * decade >= raw - 1e-12)! * decade;
  const yOffsetV = Math.round((a + b) / 2 / step) * step;
  return { voltsPerDiv: step, yOffsetV };
}

export const useOscilloscopeStore = create<OscilloscopeState>((set, get) => ({
  open: false,
  running: true,
  timeDivMs: 1,
  channels: [],
  samples: {},

  triggerMode: 'auto',
  triggerChannelId: null,
  triggerEdge: 'rising',
  triggerPosition: 0.5,
  triggerLevelV: 1.65,
  triggeredAtMs: null,
  triggerStatus: 'idle',

  toggleOscilloscope: () => set((s) => ({ open: !s.open })),
  openOscilloscope: () => set({ open: true }),

  setCapturing: (running) => set({ running }),

  setTimeDivMs: (ms) => set({ timeDivMs: ms }),

  addChannel: (boardId: string, pin: number, pinLabel: string, amplitudeV = 5) => {
    const { channels } = get();
    // Deduplicate by (boardId, pin)
    if (channels.some((c) => c.kind === 'digital' && c.boardId === boardId && c.pin === pin)) {
      return;
    }

    const id = `osc-ch-${boardId}-${pin}`;
    const color = CHANNEL_COLORS[channels.length % CHANNEL_COLORS.length];

    set((s) => ({
      channels: [
        ...s.channels,
        {
          kind: 'digital',
          id,
          boardId,
          pin,
          label: pinLabel,
          color,
          amplitudeV,
          // Two divisions for the full logic swing: the square wave then
          // occupies the middle of the row rather than its extremes, leaving
          // headroom for an analog trace sharing the axis.
          voltsPerDiv: amplitudeV / 2,
          yOffsetV: 0,
        },
      ],
      samples: { ...s.samples, [id]: [] },
    }));
  },

  addNetChannel: (netName: string, label: string) => {
    const { channels } = get();
    const existing = channels.find((c) => c.kind === 'analog' && c.netName === netName);
    if (existing) return existing.id;

    const id = `osc-net-${netName}`;
    const color = CHANNEL_COLORS[channels.length % CHANNEL_COLORS.length];
    set((s) => ({
      channels: [
        ...s.channels,
        {
          kind: 'analog',
          id,
          netName,
          label,
          color,
          voltsPerDiv: 1,
          yOffsetV: 0,
        },
      ],
      samples: { ...s.samples, [id]: [] },
    }));
    return id;
  },

  removeChannel: (id) => {
    set((s) => {
      const { [id]: _removed, ...rest } = s.samples;
      // If the removed channel was the trigger source, fall back to the
      // first remaining channel via the resolver — keeps the trigger
      // working without forcing the user to re-pick.
      const remainingChannels = s.channels.filter((c) => c.id !== id);
      const nextTriggerCh =
        s.triggerChannelId === id ? null : s.triggerChannelId;
      return {
        channels: remainingChannels,
        samples: rest,
        triggerChannelId: nextTriggerCh,
      };
    });
  },

  pushSample: (channelId, timeMs, state) => {
    const s = get();
    if (!s.running) return;

    const buf = s.samples[channelId];
    if (!buf) return;

    // Trigger detection happens BEFORE we mutate the buffer so we can
    // peek at the previous state on the trigger channel.  Auto mode
    // skips this entirely — the scope free-runs.
    let nextTriggeredAtMs = s.triggeredAtMs;
    // Annotated: the `if (!s.running) return` guard above narrows s.running to
    // the literal `true`, so an inferred binding rejects the `= false` that
    // single-shot capture needs.
    let nextRunning: boolean = s.running;
    let nextStatus: TriggerStatus = s.triggerStatus;

    if (s.triggerMode !== 'auto') {
      const triggerChId = resolveTriggerChannelId(s.triggerChannelId, s.channels);
      if (triggerChId === channelId) {
        const triggerBuf = s.samples[triggerChId];
        if (triggerBuf && triggerBuf.length > 0) {
          const prevState = triggerBuf[triggerBuf.length - 1].state;
          const single = s.triggerMode === 'single';
          // Single-shot: once we've captured (status === 'captured'),
          // ignore further edges until the user explicitly re-arms.
          const captureLocked = single && s.triggerStatus === 'captured';
          if (!captureLocked && matchesTriggerEdge(prevState, state, s.triggerEdge)) {
            nextTriggeredAtMs = timeMs;
            if (single) {
              nextRunning = false;
              nextStatus = 'captured';
            } else {
              nextStatus = 'triggered';
            }
          }
        }
      }
    }

    set((cur) => {
      const curBuf = cur.samples[channelId];
      if (!curBuf) return cur;
      const next = curBuf.slice();
      if (next.length >= MAX_SAMPLES) next.shift();
      next.push({ timeMs, state });
      return {
        samples: { ...cur.samples, [channelId]: next },
        ...(nextTriggeredAtMs !== cur.triggeredAtMs ? { triggeredAtMs: nextTriggeredAtMs } : {}),
        ...(nextRunning !== cur.running ? { running: nextRunning } : {}),
        ...(nextStatus !== cur.triggerStatus ? { triggerStatus: nextStatus } : {}),
      };
    });
  },

  pushAnalogBlock: (channelId, timesMs, volts) => {
    const s0 = get();
    if (!s0.running) return;
    const channel = s0.channels.find((c) => c.id === channelId);
    if (!channel || channel.kind !== 'analog') return;

    const points = decimateMinMax(timesMs, volts, ANALOG_MAX_SAMPLES);
    if (points.length === 0) return;

    // Every re-tran restarts at t=0 and is a fresh window, not a continuation:
    // the engine reloads the circuit each solve, so stitching blocks together
    // would draw a timeline that never happened. Replace, do not append.
    //
    // `state` is a boolean shadow of the trace, thresholded at the midpoint of
    // THIS capture's own range. Deliberately self-referential rather than a
    // fixed logic threshold: an analog net has no Vcc to halve, and the point
    // is only that readers written before analog existed (the trigger's edge
    // detector, the old draw path) still see something meaningful.
    let lo = points[0]!.volts;
    let hi = points[0]!.volts;
    for (const p of points) {
      if (p.volts < lo) lo = p.volts;
      if (p.volts > hi) hi = p.volts;
    }
    const mid = (lo + hi) / 2;
    let channels = s0.channels;
    if (channel.autoScale !== false) {
      const fit = fitAnalogScale(lo, hi);
      if (fit.voltsPerDiv !== channel.voltsPerDiv || fit.yOffsetV !== channel.yOffsetV) {
        channels = channels.map((c) => (c.id === channelId ? { ...c, ...fit } : c));
      }
    }
    const next = points.map((p) => ({
      timeMs: p.timeMs,
      state: p.volts >= mid,
      volts: p.volts,
    }));
    // Trigger, when this channel is the source. A capture arrives as a whole
    // window rather than one sample at a time, so the crossing is looked for
    // WITHIN the block and the trigger latches at the crossing's own time —
    // the same semantics the per-sample digital path has, just resolved in one
    // pass instead of over many calls.
    let triggeredAtMs = s0.triggeredAtMs;
    // Same narrowing as the digital path above — annotate, or single-shot
    // cannot stop the capture.
    let running: boolean = s0.running;
    let triggerStatus: TriggerStatus = s0.triggerStatus;
    if (s0.triggerMode !== 'auto') {
      const source = resolveTriggerChannelId(s0.triggerChannelId, s0.channels);
      const single = s0.triggerMode === 'single';
      const captureLocked = single && s0.triggerStatus === 'captured';
      if (source === channelId && !captureLocked) {
        for (let i = 1; i < next.length; i++) {
          if (
            matchesLevelCrossing(
              next[i - 1]!.volts!, next[i]!.volts!, s0.triggerLevelV, s0.triggerEdge,
            )
          ) {
            triggeredAtMs = next[i]!.timeMs;
            if (single) {
              running = false;
              triggerStatus = 'captured';
            } else {
              triggerStatus = 'triggered';
            }
            break;
          }
        }
      }
    }

    set((cur) => ({
      channels: channels === s0.channels ? cur.channels : channels,
      samples: { ...cur.samples, [channelId]: next },
      triggeredAtMs,
      running,
      triggerStatus,
    }));
  },

  setChannelVoltsPerDiv: (channelId, voltsPerDiv) =>
    set((s) => ({
      channels: s.channels.map((c) =>
        c.id === channelId
          ? { ...c, voltsPerDiv: Math.max(0.01, voltsPerDiv), autoScale: false }
          : c,
      ),
    })),

  setChannelOffset: (channelId, yOffsetV) =>
    set((s) => ({
      channels: s.channels.map((c) =>
        c.id === channelId ? { ...c, yOffsetV, autoScale: false } : c,
      ),
    })),

  clearSamples: () => {
    const { channels } = get();
    const fresh: Record<string, OscSample[]> = {};
    channels.forEach((c) => {
      fresh[c.id] = [];
    });
    set({
      samples: fresh,
      triggeredAtMs: null,
      // Clearing samples re-arms whatever mode we're in.
      triggerStatus: get().triggerMode === 'auto' ? 'idle' : 'armed',
    });
  },

  setTriggerMode: (mode) => {
    set((s) => ({
      triggerMode: mode,
      // Switching modes is implicitly a re-arm — drop any latched trigger
      // and set the status appropriate to the new mode.
      triggeredAtMs: null,
      triggerStatus: mode === 'auto' ? 'idle' : 'armed',
      // If switching to a capture mode while paused, resume capture so
      // the next edge can land.  The user can pause manually after if
      // they want.
      running: mode === 'auto' ? s.running : true,
    }));
  },

  setTriggerChannel: (channelId) => {
    set({
      triggerChannelId: channelId,
      triggeredAtMs: null,
      triggerStatus: get().triggerMode === 'auto' ? 'idle' : 'armed',
    });
  },

  setTriggerEdge: (edge) => {
    set({
      triggerEdge: edge,
      triggeredAtMs: null,
      triggerStatus: get().triggerMode === 'auto' ? 'idle' : 'armed',
    });
  },

  setTriggerLevelV: (volts) => set({ triggerLevelV: volts }),

  setTriggerPosition: (pos) => {
    set({ triggerPosition: Math.max(0, Math.min(1, pos)) });
  },

  rearmTrigger: () => {
    set((s) => ({
      triggeredAtMs: null,
      triggerStatus: s.triggerMode === 'auto' ? 'idle' : 'armed',
      running: true,
    }));
  },
}));
