/**
 * Oscilloscope / Logic Analyzer store.
 *
 * Captures pin HIGH/LOW transitions with microsecond-level timestamps
 * derived from the CPU cycle counter and renders them as waveforms.
 *
 * Channels are keyed by (boardId, pin) so multiple boards with the same
 * logical pin number can be monitored independently.
 */

import { create } from 'zustand';

export const MAX_SAMPLES = 10_000;

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

export interface OscChannel {
  id: string;
  /** Board that owns this channel */
  boardId: string;
  pin: number;
  label: string;
  color: string;
}

export interface OscSample {
  /** Time in milliseconds from simulation start */
  timeMs: number;
  state: boolean;
}

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

  // ── Actions ────────────────────────────────────────────────────────────────

  toggleOscilloscope: () => void;
  setCapturing: (running: boolean) => void;
  setTimeDivMs: (ms: number) => void;
  addChannel: (boardId: string, pin: number, pinLabel: string) => void;
  removeChannel: (id: string) => void;
  /** Push one sample; drops the oldest if the buffer is full */
  pushSample: (channelId: string, timeMs: number, state: boolean) => void;
  clearSamples: () => void;
}

export const useOscilloscopeStore = create<OscilloscopeState>((set, get) => ({
  open: false,
  running: true,
  timeDivMs: 1,
  channels: [],
  samples: {},

  toggleOscilloscope: () => set((s) => ({ open: !s.open })),

  setCapturing: (running) => set({ running }),

  setTimeDivMs: (ms) => set({ timeDivMs: ms }),

  addChannel: (boardId: string, pin: number, pinLabel: string) => {
    const { channels } = get();
    // Deduplicate by (boardId, pin)
    if (channels.some((c) => c.boardId === boardId && c.pin === pin)) return;

    const id = `osc-ch-${boardId}-${pin}`;
    const color = CHANNEL_COLORS[channels.length % CHANNEL_COLORS.length];

    set((s) => ({
      channels: [...s.channels, { id, boardId, pin, label: pinLabel, color }],
      samples: { ...s.samples, [id]: [] },
    }));
  },

  removeChannel: (id) => {
    set((s) => {
      const { [id]: _removed, ...rest } = s.samples;
      return {
        channels: s.channels.filter((c) => c.id !== id),
        samples: rest,
      };
    });
  },

  pushSample: (channelId, timeMs, state) => {
    if (!get().running) return;
    set((s) => {
      const buf = s.samples[channelId];
      if (!buf) return s;

      const next = buf.slice();
      if (next.length >= MAX_SAMPLES) next.shift();
      next.push({ timeMs, state });
      return { samples: { ...s.samples, [channelId]: next } };
    });
  },

  clearSamples: () => {
    const { channels } = get();
    const fresh: Record<string, OscSample[]> = {};
    channels.forEach((c) => { fresh[c.id] = []; });
    set({ samples: fresh });
  },
}));
