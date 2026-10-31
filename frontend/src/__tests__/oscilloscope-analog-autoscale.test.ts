/**
 * Analog scope channels fit their vertical scale to the signal.
 *
 * They used to open at a fixed 1 V/div around 0 V (+-4 V on screen) with no
 * control to change it, so a 5 V rail or a rectifier's 11 V drew off-screen.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useOscilloscopeStore, fitAnalogScale, OSC_V_DIVS } from '../store/useOscilloscopeStore';

function inView(lo: number, hi: number) {
  const { voltsPerDiv, yOffsetV } = fitAnalogScale(lo, hi);
  const half = (voltsPerDiv * OSC_V_DIVS) / 2;
  return Math.min(lo, 0) >= yOffsetV - half && Math.max(hi, 0) <= yOffsetV + half;
}

describe('fitAnalogScale', () => {
  it('picks a 1-2-5 V/div that holds the range, 0 V included', () => {
    expect(fitAnalogScale(10.4, 11.6)).toEqual({ voltsPerDiv: 2, yOffsetV: 6 });
    expect(fitAnalogScale(4.99, 5.01)).toEqual({ voltsPerDiv: 1, yOffsetV: 3 });
    expect(fitAnalogScale(-0.2, 0.2)).toEqual({ voltsPerDiv: 0.1, yOffsetV: 0 });
    for (const [lo, hi] of [
      [10.4, 11.6],
      [4.99, 5.01],
      [-0.2, 0.2],
      [3.9, 5.8],
      [-12, 12],
      [0, 0.003],
    ]) {
      expect(inView(lo, hi)).toBe(true);
    }
  });
});

describe('pushAnalogBlock auto-scales until the user sets the scale', () => {
  beforeEach(() => {
    useOscilloscopeStore.setState({ channels: [], samples: {}, running: true });
  });

  it('a 0..11.6 V capture is rescaled to stay on screen', () => {
    const s = useOscilloscopeStore.getState();
    const id = s.addNetChannel('n0', 'Rectified');
    const t = Array.from({ length: 50 }, (_, i) => i);
    useOscilloscopeStore.getState().pushAnalogBlock(
      id,
      t,
      t.map((i) => 10.4 + (i % 10) * 0.12),
    );
    const ch = useOscilloscopeStore.getState().channels.find((c) => c.id === id)!;
    expect(ch.voltsPerDiv).toBe(2);
    expect(ch.yOffsetV).toBe(6);
  });

  it('keeps a hand-set V/div', () => {
    const id = useOscilloscopeStore.getState().addNetChannel('n1', 'Out');
    useOscilloscopeStore.getState().setChannelVoltsPerDiv(id, 0.5);
    const t = [0, 1, 2];
    useOscilloscopeStore.getState().pushAnalogBlock(id, t, [9, 10, 11]);
    expect(useOscilloscopeStore.getState().channels.find((c) => c.id === id)!.voltsPerDiv).toBe(
      0.5,
    );
  });
});
