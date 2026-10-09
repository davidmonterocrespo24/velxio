import { describe, it, expect } from 'vitest';
import { PadTimeline, MAX_EDGES_PER_WINDOW, stateKey } from '../simulation/spice/PadTimeline';

const edge = (index: number, volts: number, wallMs: number, guestMs: number | null = null, board = 'uno') =>
  ({ index, volts, wallMs, guestMs, board });

describe('PadTimeline', () => {
  it('a window with no edges is one state for the whole window', () => {
    const tl = new PadTimeline([0, 5], 1000);
    const w = tl.close(1033);
    expect(w.states).toHaveLength(1);
    expect(w.states[0]).toMatchObject({ key: '0,5', ms: 33 });
    expect(w.latest.key).toBe('0,5');
  });

  it('weights each state by the time the pads held it', () => {
    // The chase step: pad 0 drops and pad 1 rises 10 ms into a 33 ms window.
    const tl = new PadTimeline([5, 0], 0);
    tl.record(edge(0, 0, 10));
    tl.record(edge(1, 5, 10));
    const w = tl.close(33);
    const byKey = Object.fromEntries(w.states.map((s) => [s.key, s.ms]));
    expect(byKey).toEqual({ '5,0': 10, '0,5': 23 });
    expect(w.latest.key).toBe('0,5');
  });

  it('a pulse that starts and ends inside the window is still a state of its own length', () => {
    const tl = new PadTimeline([0], 0);
    tl.record(edge(0, 5, 5));
    tl.record(edge(0, 0, 25));
    const w = tl.close(33);
    const byKey = Object.fromEntries(w.states.map((s) => [s.key, s.ms]));
    expect(byKey).toEqual({ '0': 13, '5': 20 });
    expect(w.latest.key).toBe('0');
  });

  it('the next window starts from the levels the last one ended on', () => {
    const tl = new PadTimeline([0], 0);
    tl.record(edge(0, 5, 30));
    tl.close(33);
    const w = tl.close(66);
    expect(w.states).toEqual([{ key: '5', levels: [5], ms: 33 }]);
  });

  it('places the edges of one burst by their guest clock, anchored on the last edge', () => {
    // An AVR frame: 16 ms of guest time run in one call. A 10 ms software
    // pulse inside it would collapse to zero on arrival time alone.
    const tl = new PadTimeline([0], 0);
    tl.record(edge(0, 5, 20, 1000));   // guest 1000 ms, arrived at wall 20
    tl.record(edge(0, 0, 21, 1010));   // guest 1010 ms, arrived at wall 21
    const w = tl.close(33);
    const byKey = Object.fromEntries(w.states.map((s) => [s.key, s.ms]));
    // last edge at 21; the first is back-dated 10 ms to 11.
    expect(byKey).toEqual({ '0': 23, '5': 10 });
  });

  it('two bursts of one board are placed separately', () => {
    const tl = new PadTimeline([0], 0);
    tl.record(edge(0, 5, 10, 500));
    tl.record(edge(0, 0, 26, 516));    // 16 ms later: a new frame
    const w = tl.close(33);
    const byKey = Object.fromEntries(w.states.map((s) => [s.key, s.ms]));
    expect(byKey).toEqual({ '0': 17, '5': 16 });
  });

  it('an edge without a guest clock is placed when it arrived', () => {
    const tl = new PadTimeline([0, 0], 0);
    tl.record(edge(0, 5, 10, null, 'qemu'));
    tl.record(edge(1, 5, 12, null, 'qemu'));
    const w = tl.close(33);
    const byKey = Object.fromEntries(w.states.map((s) => [s.key, s.ms]));
    expect(byKey).toEqual({ '0,0': 10, '5,0': 2, '5,5': 21 });
  });

  it('back-dating never reaches before the window start', () => {
    const tl = new PadTimeline([0], 100);
    tl.record(edge(0, 5, 101, 0));
    tl.record(edge(0, 0, 102, 50));   // would back-date the first to 52
    const w = tl.close(133);
    const byKey = Object.fromEntries(w.states.map((s) => [s.key, s.ms]));
    expect(byKey).toEqual({ '5': 2, '0': 31 });
  });

  it('keeps the latest level after the edge cap and says so', () => {
    const tl = new PadTimeline([0], 0);
    for (let i = 0; i < MAX_EDGES_PER_WINDOW + 10; i++) tl.record(edge(0, i % 2 ? 0 : 5, i * 0.001));
    tl.record(edge(0, 5, 20));
    expect(tl.current()).toEqual([5]);
    const w = tl.close(33);
    expect(w.overflowed).toBe(true);
    expect(w.latest.key).toBe('5');
    expect(w.states.reduce((a, s) => a + s.ms, 0)).toBeCloseTo(33, 6);
  });

  it('the latest state is listed even when it held for no time yet', () => {
    const tl = new PadTimeline([0], 0);
    tl.record(edge(0, 5, 33));
    const w = tl.close(33);
    expect(w.latest).toEqual({ key: '5', levels: [5], ms: 0 });
    expect(w.states.find((s) => s.key === '0')?.ms).toBe(33);
  });

  it('stateKey is the levels in order', () => {
    expect(stateKey([0, 3.3, 5])).toBe('0,3.3,5');
  });
});
