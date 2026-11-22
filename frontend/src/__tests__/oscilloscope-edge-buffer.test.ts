/**
 * What a digital channel's buffer costs per edge, and edges pushed many at a
 * time (velxio/velxio-prod#160).
 *
 * A synthesized Wire or SPI step is a few dozen edges at once, at bus speed:
 * 27 for one I2C byte, 16 per SPI byte. pushSample copied the channel's whole
 * buffer and shifted it on every edge, about 47 us with 10 000 edges held, so
 * a probed SDA at 400 kHz would have cost the tab 1.3 ms per byte for a byte
 * that lasts 22.5 us. The buffer now grows in place and drops its oldest
 * edges in bulk, and pushSampleBatch hands a whole step over in one store
 * update, with exactly the trigger behaviour of pushing the edges one by one.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  useOscilloscopeStore,
  MAX_SAMPLES,
  type OscEdge,
  type OscRun,
} from '../store/useOscilloscopeStore';

beforeEach(() => {
  useOscilloscopeStore.setState({
    open: true,
    running: true,
    timeDivMs: 1,
    channels: [],
    samples: {},
    triggerMode: 'auto',
    triggerChannelId: null,
    triggerEdge: 'rising',
    triggeredAtMs: null,
    triggerStatus: 'idle',
  });
});

const A = 'osc-ch-uno-18';
const B = 'osc-ch-uno-19';

function twoChannels(): void {
  const s = useOscilloscopeStore.getState();
  s.addChannel('uno', 18, 'A4', 5);
  s.addChannel('uno', 19, 'A5', 5);
}

/** A run of edges on A and B, toggling, 10 us apart. */
function edges(n: number, from = 0): OscEdge[] {
  return Array.from({ length: n }, (_, k) => ({
    channelId: k % 3 === 0 ? B : A,
    timeMs: (from + k) * 0.01,
    state: (from + k) % 2 === 0,
  }));
}

describe('a push does not copy the buffer', () => {
  it('appends in place until the buffer is past MAX_SAMPLES, then keeps the last MAX_SAMPLES', () => {
    twoChannels();
    const s = useOscilloscopeStore.getState();
    s.pushSample(A, 0, true);
    const buf = useOscilloscopeStore.getState().samples[A];
    for (let k = 1; k < MAX_SAMPLES; k++) s.pushSample(A, k * 0.01, k % 2 === 0);
    // The same array, grown: no copy per edge.
    expect(useOscilloscopeStore.getState().samples[A]).toBe(buf);
    expect(buf).toHaveLength(MAX_SAMPLES);
    // Past MAX_SAMPLES + MAX_SAMPLES / 4 the oldest go, in one cut.
    const total = MAX_SAMPLES + MAX_SAMPLES / 4 + 1;
    for (let k = MAX_SAMPLES; k < total; k++) s.pushSample(A, k * 0.01, k % 2 === 0);
    const kept = useOscilloscopeStore.getState().samples[A]!;
    expect(kept).not.toBe(buf);
    expect(kept).toHaveLength(MAX_SAMPLES);
    expect(kept[0]).toMatchObject({ timeMs: (total - MAX_SAMPLES) * 0.01, unknownBefore: true });
    expect(kept.at(-1)!.timeMs).toBeCloseTo((total - 1) * 0.01, 9);
  });

  it('an edge into a full channel copies nothing: 1000 of them, not one copy of the buffer', () => {
    twoChannels();
    const s = useOscilloscopeStore.getState();
    for (let k = 0; k < MAX_SAMPLES; k++) s.pushSample(A, k * 0.01, k % 2 === 0);
    // Copying the buffer was buf.slice() on every edge (about 47 us with
    // 10 000 edges held). Count the copies 1000 more edges make.
    const slice = vi.spyOn(Array.prototype, 'slice');
    for (let k = MAX_SAMPLES; k < MAX_SAMPLES + 1000; k++) s.pushSample(A, k * 0.01, k % 2 === 0);
    const copies = slice.mock.calls.length;
    slice.mockRestore();
    expect(copies).toBe(0);
  });
});

describe('pushSampleBatch', () => {
  it('appends every edge, in order, in one store update', () => {
    twoChannels();
    let updates = 0;
    const off = useOscilloscopeStore.subscribe(() => updates++);
    useOscilloscopeStore.getState().pushSampleBatch(edges(27));
    off();
    expect(updates).toBe(1);
    const { samples } = useOscilloscopeStore.getState();
    expect(samples[A]).toHaveLength(18);
    expect(samples[B]).toHaveLength(9);
    expect(samples[B]![1]).toEqual({ timeMs: 0.03, state: false });
  });

  for (const mode of ['normal', 'single'] as const) {
    it(`leaves the scope as pushing the same edges one by one does (${mode} trigger)`, () => {
      const run = (batched: boolean) => {
        useOscilloscopeStore.setState({
          channels: [],
          samples: {},
          running: true,
          triggerMode: mode,
          triggerChannelId: null,
          triggeredAtMs: null,
          triggerStatus: 'armed',
          triggerEdge: 'rising',
        });
        twoChannels();
        const list = edges(40);
        const s = useOscilloscopeStore.getState();
        if (batched) s.pushSampleBatch(list);
        else for (const e of list) s.pushSample(e.channelId, e.timeMs, e.state);
        const st = useOscilloscopeStore.getState();
        return {
          a: st.samples[A]!.map((x) => ({ ...x })),
          b: st.samples[B]!.map((x) => ({ ...x })),
          triggeredAtMs: st.triggeredAtMs,
          triggerStatus: st.triggerStatus,
          running: st.running,
        };
      };
      const one = run(false);
      const many = run(true);
      expect(many).toEqual(one);
      if (mode === 'single') {
        // A Single capture stops at its first rising edge on the trigger
        // channel (A): what came after it in the batch is not kept.
        expect(many.running).toBe(false);
        expect(many.a.length + many.b.length).toBeLessThan(40);
      }
    });
  }

  it('takes nothing while the capture is paused', () => {
    twoChannels();
    useOscilloscopeStore.getState().setCapturing(false);
    useOscilloscopeStore.getState().pushSampleBatch(edges(10));
    const { samples } = useOscilloscopeStore.getState();
    expect(samples[A]).toEqual([]);
    expect(samples[B]).toEqual([]);
  });
});

describe('pushSampleRuns', () => {
  /** The same edges as runs, one per channel, each in time order. */
  const runsOf = (list: OscEdge[]): OscRun[] => {
    const by = new Map<string, OscRun>();
    for (const e of list) {
      let r = by.get(e.channelId);
      if (!r) by.set(e.channelId, (r = { channelId: e.channelId, samples: [] }));
      (r.samples as Array<{ timeMs: number; state: boolean }>).push({ timeMs: e.timeMs, state: e.state });
    }
    return [...by.values()];
  };

  it('appends each run as it comes, the sample objects themselves, in one store update', () => {
    twoChannels();
    const runs = runsOf(edges(27));
    let updates = 0;
    const off = useOscilloscopeStore.subscribe(() => updates++);
    useOscilloscopeStore.getState().pushSampleRuns(runs);
    off();
    expect(updates).toBe(1);
    const { samples } = useOscilloscopeStore.getState();
    expect(samples[A]).toHaveLength(18);
    expect(samples[B]).toHaveLength(9);
    expect(samples[A]![0]).toBe(runs.find((r) => r.channelId === A)!.samples[0]);
  });

  for (const mode of ['normal', 'single'] as const) {
    it(`leaves the scope as pushing the same edges one by one, in time order, does (${mode} trigger)`, () => {
      const run = (asRuns: boolean) => {
        useOscilloscopeStore.setState({
          channels: [],
          samples: {},
          running: true,
          triggerMode: mode,
          triggerChannelId: null,
          triggeredAtMs: null,
          triggerStatus: 'armed',
          triggerEdge: 'rising',
        });
        twoChannels();
        const list = edges(40);
        const s = useOscilloscopeStore.getState();
        // Runs with the trigger channel's last: the store looks at it first anyway.
        if (asRuns) s.pushSampleRuns(runsOf(list).reverse());
        else for (const e of list) s.pushSample(e.channelId, e.timeMs, e.state);
        const st = useOscilloscopeStore.getState();
        return {
          a: st.samples[A]!.map((x) => ({ ...x })),
          b: st.samples[B]!.map((x) => ({ ...x })),
          triggeredAtMs: st.triggeredAtMs,
          triggerStatus: st.triggerStatus,
          running: st.running,
        };
      };
      expect(run(true)).toEqual(run(false));
    });
  }

  it('past MAX_SAMPLES keeps the last MAX_SAMPLES, the first saying what came before is unknown', () => {
    twoChannels();
    const s = useOscilloscopeStore.getState();
    const big: OscRun = {
      channelId: A,
      samples: Array.from({ length: MAX_SAMPLES * 1.3 }, (_, k) => ({ timeMs: k * 0.01, state: k % 2 === 0 })),
    };
    s.pushSampleRuns([big]);
    const kept = useOscilloscopeStore.getState().samples[A]!;
    expect(kept).toHaveLength(MAX_SAMPLES);
    expect(kept[0]).toMatchObject({ unknownBefore: true });
    expect(kept.at(-1)).toBe(big.samples.at(-1));
  });
});
