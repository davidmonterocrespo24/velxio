/**
 * PadTimeline — the levels every MCU pad of the deck held, in order and in
 * time, between two publishes of the circuit solve.
 *
 * The solver answers one state of the pads at a time and costs milliseconds
 * per answer; the pads change state at MCU speed. What a person sees on the
 * canvas, and what a meter or a coil integrates, is not the state at the
 * instant a solve happened to land but the time-weighted mix of every state
 * the circuit went through. So the service no longer chases edges: it
 * records each one here with the time it happened, closes a window every
 * few tens of milliseconds, and publishes the states of that window with
 * the share of the window each one held. A 50 ms pulse is a state worth
 * 50 ms, whatever the solver was doing when it started; a software PWM at
 * 30 % is a state worth 30 % of every window; a multiplexed display is its
 * handful of states, each a quarter of the time.
 *
 * Time. Every engine is paced to the wall clock, and an edge's arrival time
 * is a fair proxy for when the guest made it, except inside one burst of
 * execution: the AVR runs a frame's worth of guest time in one synchronous
 * call, so a burst's edges all arrive within a few milliseconds of wall time
 * while spanning sixteen of guest time. An edge may therefore carry the
 * guest clock of its board as well (`guestMs`, from the engine's own
 * cycle counter), and `close` places the edges of one burst by their guest
 * distances, anchored on the burst's last edge. Engines without a guest
 * clock degrade to arrival time, which is exact to a frame.
 *
 * Bound. A pad toggled by a bit-banged bus can make tens of thousands of
 * edges per window; past MAX_EDGES_PER_WINDOW the timeline keeps only the
 * latest level per pad (last state wins for the rest of the window), which
 * is what the whole layer did for every edge before this file existed.
 */

export interface PadEdge {
  /** Index of the pad in the deck's pad source list. */
  index: number;
  volts: number;
  /** performance.now() when the edge reached the service. */
  wallMs: number;
  /** The board's own clock at the edge, when the engine has one. */
  guestMs: number | null;
  board: string;
}

export interface WindowState {
  key: string;
  levels: number[];
  /** How long the pads held this state inside the window. */
  ms: number;
}

export interface WindowResult {
  startMs: number;
  endMs: number;
  /** Every state that held for a positive time, plus `latest`. */
  states: WindowState[];
  /** The state the pads hold at `endMs`. Also listed in `states`. */
  latest: WindowState;
  /** True when more edges arrived than the timeline keeps; see the header. */
  overflowed: boolean;
  edges: number;
}

export const MAX_EDGES_PER_WINDOW = 4096;

/** Two edges of one board closer than this in wall time belong to one burst. */
const BURST_GAP_MS = 6;

export function stateKey(levels: readonly number[]): string {
  return levels.join(',');
}

export class PadTimeline {
  private readonly levels: number[];
  private startLevels: number[];
  private startMs: number;
  private edges: PadEdge[] = [];
  private overflow = false;

  constructor(levels: readonly number[], startMs: number) {
    this.levels = levels.slice();
    this.startLevels = levels.slice();
    this.startMs = startMs;
  }

  /** The levels the pads hold now, after every recorded edge. */
  current(): number[] {
    return this.levels.slice();
  }

  currentKey(): string {
    return stateKey(this.levels);
  }

  /** Edges recorded since the last close. */
  pending(): number {
    return this.edges.length;
  }

  record(edge: PadEdge): void {
    this.levels[edge.index] = edge.volts;
    if (this.edges.length >= MAX_EDGES_PER_WINDOW) {
      this.overflow = true;
      return;
    }
    this.edges.push(edge);
  }

  /**
   * Integrate the window that ends now and start the next one.
   */
  close(endMs: number): WindowResult {
    const startMs = this.startMs;
    const placed = placeEdges(this.edges, startMs, endMs);
    const states = new Map<string, WindowState>();
    const levels = this.startLevels.slice();
    let key = stateKey(levels);
    let cursor = startMs;
    const add = (ms: number) => {
      if (ms <= 0) return;
      const s = states.get(key);
      if (s) s.ms += ms;
      else states.set(key, { key, levels: levels.slice(), ms });
    };
    for (const { edge, t } of placed) {
      add(t - cursor);
      cursor = Math.max(cursor, t);
      if (levels[edge.index] !== edge.volts) {
        levels[edge.index] = edge.volts;
        key = stateKey(levels);
      }
    }
    if (this.overflow) {
      // What came after the kept edges is unknown; the time left in the
      // window goes to the level the pads hold now.
      for (let i = 0; i < levels.length; i++) levels[i] = this.levels[i]!;
      key = stateKey(levels);
    }
    add(endMs - cursor);
    const latestKey = stateKey(this.levels);
    let latest = states.get(latestKey);
    if (!latest) {
      latest = { key: latestKey, levels: this.levels.slice(), ms: 0 };
      states.set(latestKey, latest);
    }
    const result: WindowResult = {
      startMs,
      endMs,
      states: Array.from(states.values()),
      latest,
      overflowed: this.overflow,
      edges: this.edges.length,
    };
    this.startMs = endMs;
    this.startLevels = this.levels.slice();
    this.edges = [];
    this.overflow = false;
    return result;
  }
}

/**
 * Give every edge a time on the window's axis. Edges of one board that
 * arrived within BURST_GAP_MS of each other and all carry a guest clock are
 * one burst: they are placed by their guest distance from the burst's last
 * edge, which is taken to have happened when it arrived. Everything else
 * is placed when it arrived. Times are clamped into the window.
 */
function placeEdges(
  edges: readonly PadEdge[], startMs: number, endMs: number,
): Array<{ edge: PadEdge; t: number }> {
  const out: Array<{ edge: PadEdge; t: number }> = [];
  let i = 0;
  while (i < edges.length) {
    // Collect one burst: same board, consecutive, close in wall time.
    let j = i + 1;
    const board = edges[i]!.board;
    while (
      j < edges.length &&
      edges[j]!.board === board &&
      edges[j]!.wallMs - edges[j - 1]!.wallMs < BURST_GAP_MS
    ) j++;
    const burst = edges.slice(i, j);
    const guestKnown = burst.every((e) => e.guestMs !== null && Number.isFinite(e.guestMs));
    if (guestKnown && burst.length > 1) {
      const last = burst[burst.length - 1]!;
      for (const edge of burst) {
        const back = last.guestMs! - edge.guestMs!;
        out.push({ edge, t: last.wallMs - (back > 0 ? back : 0) });
      }
    } else {
      for (const edge of burst) out.push({ edge, t: edge.wallMs });
    }
    i = j;
  }
  for (const p of out) p.t = Math.min(endMs, Math.max(startMs, p.t));
  // Stable by time: a burst's back-dated edges keep their order.
  return out.map((p, n) => ({ ...p, n })).sort((a, b) => a.t - b.t || a.n - b.n);
}
