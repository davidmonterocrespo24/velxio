/**
 * Probing any wire with the oscilloscope.
 *
 * The scope was a logic analyzer: channels keyed (boardId, pin), fed by GPIO
 * transitions. "Scope any wire" means a wire now has to be classified before
 * it can be watched, and getting that classification wrong is silent — the
 * user sees a trace, just of the wrong thing.
 *
 * The three properties that make it safe:
 *
 *   1. A wire on a GPIO resolves DIGITAL, so it keeps the CPU-cycle timestamps
 *      and microsecond resolution the logic analyzer always had. Falling back
 *      to the solver here would be a regression to solve-cadence sampling.
 *   2. A wire the solver knows about resolves ANALOG by NET NAME, taken from
 *      the map the solver publishes. Net names are positional, so a locally
 *      re-derived name reports a neighbouring node (the bug fixed upstream in
 *      340e207c for the voltmeter and the overlay).
 *   3. Analog channels are keyed on the NET, never the wire. Splitting a wire
 *      with a junction node deletes its id and mints two new ones, and a
 *      wire-keyed channel would silently go dead.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { resolveProbe, probeChannelId, GROUND_NET } from '../simulation/probeResolve';
import {
  useOscilloscopeStore,
  decimateMinMax,
  matchesLevelCrossing,
  ANALOG_MAX_SAMPLES,
} from '../store/useOscilloscopeStore';
import type { Wire } from '../types/wire';

const uno = {
  id: 'uno-1',
  boardKind: 'arduino-uno' as const,
  x: 0,
  y: 0,
};

/** Minimal store-shaped context. resolveProbe only reads boards/wires/
 *  components off it (PinTrace types its input as the whole store). */
const ctx = (over: Partial<Record<string, unknown>> = {}, netMap = new Map<string, string>()) =>
  ({
    state: {
      wires: [],
      components: [],
      boards: [uno],
      ...over,
    },
    pinNetMap: netMap,
  }) as never;

const wire = (over: Partial<Wire> = {}): Wire => ({
  id: 'w1',
  start: { componentId: 'uno-1', pinName: '9', x: 0, y: 0 },
  end: { componentId: 'led-1', pinName: 'A', x: 50, y: 0 },
  waypoints: [],
  color: '#0f0',
  ...over,
});

describe('resolveProbe', () => {
  it('resolves a wire on a board pin as DIGITAL, keeping the fast path', () => {
    const target = resolveProbe(wire(), ctx());
    expect(target?.kind).toBe('digital');
    if (target?.kind !== 'digital') return;
    expect(target.boardId).toBe('uno-1');
    expect(target.pin).toBe(9);
    // The board's logic level, so a square wave sits honestly on a volts axis
    // shared with an analog trace.
    expect(target.amplitudeV).toBe(5);
  });

  it('resolves a wire the solver knows as ANALOG, by published net name', () => {
    const w = wire({
      start: { componentId: 'r1', pinName: '2', x: 0, y: 0 },
      end: { componentId: 'r2', pinName: '1', x: 10, y: 0 },
    });
    const netMap = new Map([['r1:2', 'n3']]);
    const target = resolveProbe(w, ctx({}, netMap));
    // With the pin the net was found at, which the channel follows when an
    // edit renumbers the nets (velxio/velxio-prod#119).
    expect(target).toEqual({
      kind: 'analog', netName: 'n3', label: 'n3', probe: { componentId: 'r1', pinName: '2' },
    });
  });

  it('labels the ground net rather than showing its raw name', () => {
    const w = wire({
      start: { componentId: 'r1', pinName: '2', x: 0, y: 0 },
      end: { componentId: 'r2', pinName: '1', x: 10, y: 0 },
    });
    const target = resolveProbe(w, ctx({}, new Map([['r1:2', GROUND_NET]])));
    expect(target).toEqual({
      kind: 'analog', netName: '0', label: 'GND', probe: { componentId: 'r1', pinName: '2' },
    });
  });

  it('treats an ADC input as ANALOG, not as its Arduino pin number', () => {
    // A0 is pin 14 on an Uno, so a naive board-pin lookup resolves the
    // divider tap DIGITAL and the scope draws a square wave for a voltage —
    // misleading, and empty in practice because the ADC path emits no digital
    // transitions to sample.
    const w = wire({
      start: { componentId: 'uno-1', pinName: 'A0', x: 0, y: 0 },
      end: { componentId: 'r2', pinName: '1', x: 10, y: 0 },
    });
    const target = resolveProbe(w, ctx({}, new Map([['uno-1:A0', 'n1']])));
    expect(target).toEqual({
      kind: 'analog', netName: 'n1', label: 'n1', probe: { componentId: 'uno-1', pinName: 'A0' },
    });
  });

  it('treats an ADC input reached THROUGH a resistor as analog too', () => {
    // The guard on the direct endpoint is not enough: PinTrace reports where
    // it arrived as a pin NUMBER, and A0 is number 14, so a divider tap one
    // resistor away from A0 still resolved digital. Observed live as a "D14"
    // channel that drew nothing at all.
    const r = { id: 'r1', metadataId: 'resistor', properties: {} };
    const wires = [
      // tap -- r1 -- A0
      {
        id: 'w-tap', color: '#fff', waypoints: [],
        start: { componentId: 'r1', pinName: '1', x: 0, y: 0 },
        end: { componentId: 'uno-1', pinName: 'A0', x: 10, y: 0 },
      },
    ];
    const w = wire({
      start: { componentId: 'r1', pinName: '2', x: 0, y: 0 },
      end: { componentId: 'r2', pinName: '1', x: 10, y: 0 },
    });
    const target = resolveProbe(
      w,
      ctx({ wires: [...wires, w], components: [r] }, new Map([['r1:2', 'n5']])),
    );
    expect(target).toEqual({
      kind: 'analog', netName: 'n5', label: 'n5', probe: { componentId: 'r1', pinName: '2' },
    });
  });

  it('still resolves an ordinary digital pin next to the ADC ones', () => {
    const w = wire({ start: { componentId: 'uno-1', pinName: '13', x: 0, y: 0 } });
    const target = resolveProbe(w, ctx());
    expect(target?.kind).toBe('digital');
  });

  it('returns null when nothing observable resolves', () => {
    const w = wire({
      start: { componentId: 'r1', pinName: '2', x: 0, y: 0 },
      end: { componentId: 'r2', pinName: '1', x: 10, y: 0 },
    });
    // No board pin, and the solver has published nothing for either end.
    expect(resolveProbe(w, ctx())).toBeNull();
  });

  it('gives a digital probe the SAME channel id the pin picker mints', () => {
    // Otherwise probing a wire and picking its pin stack two channels showing
    // one signal.
    const target = resolveProbe(wire(), ctx());
    expect(probeChannelId(target!)).toBe('osc-ch-uno-1-9');
  });

  it('keys an analog channel on the net, so a wire split cannot orphan it', () => {
    const id = probeChannelId({ kind: 'analog', netName: 'n7', label: 'n7' });
    expect(id).toBe('osc-net-n7');
    expect(id).not.toContain('w1');
  });
});

describe('decimateMinMax', () => {
  it('keeps every point when the capture already fits', () => {
    const out = decimateMinMax([0, 1, 2], [1, 2, 3], 10);
    expect(out).toEqual([
      { timeMs: 0, volts: 1 },
      { timeMs: 1, volts: 2 },
      { timeMs: 2, volts: 3 },
    ]);
  });

  it('preserves a spike that stride sampling would drop', () => {
    // 400 flat points with one 9 V spike buried at index 137. Plain "every
    // Nth sample" loses it and redraws the waveform as a flat line.
    const times = Array.from({ length: 400 }, (_, i) => i);
    const volts = Array.from({ length: 400 }, () => 1);
    volts[137] = 9;
    const out = decimateMinMax(times, volts, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(Math.max(...out.map((p) => p.volts))).toBe(9);
  });

  it('emits points in time order so the trace never doubles back', () => {
    const times = Array.from({ length: 200 }, (_, i) => i);
    const volts = times.map((t) => Math.sin(t / 5));
    const out = decimateMinMax(times, volts, 40);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].timeMs).toBeGreaterThanOrEqual(out[i - 1].timeMs);
    }
  });

  it('respects the analog cap, which is separate from the digital one', () => {
    const times = Array.from({ length: 50_000 }, (_, i) => i);
    const volts = times.map(() => 1);
    expect(decimateMinMax(times, volts, ANALOG_MAX_SAMPLES).length)
      .toBeLessThanOrEqual(ANALOG_MAX_SAMPLES);
  });
});

describe('matchesLevelCrossing', () => {
  it('fires only when the level is actually crossed', () => {
    expect(matchesLevelCrossing(1, 3, 2, 'either')).toBe(true);
    expect(matchesLevelCrossing(3, 1, 2, 'either')).toBe(true);
    expect(matchesLevelCrossing(1, 1.9, 2, 'either')).toBe(false);
    expect(matchesLevelCrossing(3, 2.5, 2, 'either')).toBe(false);
  });

  it('respects the edge direction', () => {
    expect(matchesLevelCrossing(1, 3, 2, 'rising')).toBe(true);
    expect(matchesLevelCrossing(3, 1, 2, 'rising')).toBe(false);
    expect(matchesLevelCrossing(3, 1, 2, 'falling')).toBe(true);
    expect(matchesLevelCrossing(1, 3, 2, 'falling')).toBe(false);
  });
});

describe('analog channels in the store', () => {
  beforeEach(() => {
    const s = useOscilloscopeStore.getState();
    for (const c of [...s.channels]) s.removeChannel(c.id);
    useOscilloscopeStore.setState({ running: true, triggerMode: 'auto' });
  });

  it('adds a net channel once, however often the wire is probed', () => {
    const a = useOscilloscopeStore.getState().addNetChannel('n2', 'n2');
    const b = useOscilloscopeStore.getState().addNetChannel('n2', 'n2');
    expect(a).toBe(b);
    expect(useOscilloscopeStore.getState().channels).toHaveLength(1);
  });

  it('stores volts AND a boolean shadow, so older readers still work', () => {
    const id = useOscilloscopeStore.getState().addNetChannel('n2', 'n2');
    useOscilloscopeStore.getState().pushAnalogBlock(id, [0, 1, 2], [0, 5, 0]);
    const buf = useOscilloscopeStore.getState().samples[id];
    expect(buf.map((s) => s.volts)).toEqual([0, 5, 0]);
    // Thresholded at the midpoint of this capture's own range (2.5 V here).
    expect(buf.map((s) => s.state)).toEqual([false, true, false]);
  });

  it('replaces the window per capture instead of stitching a fake timeline', () => {
    // Every re-tran restarts at t=0 because the engine reloads the circuit,
    // so appending would draw a timeline that never happened.
    const id = useOscilloscopeStore.getState().addNetChannel('n2', 'n2');
    useOscilloscopeStore.getState().pushAnalogBlock(id, [0, 1], [0, 1]);
    useOscilloscopeStore.getState().pushAnalogBlock(id, [0, 1], [2, 3]);
    const buf = useOscilloscopeStore.getState().samples[id];
    expect(buf).toHaveLength(2);
    expect(buf.map((s) => s.volts)).toEqual([2, 3]);
  });

  it('ignores a block aimed at a digital channel', () => {
    useOscilloscopeStore.getState().addChannel('uno-1', 9, 'D9');
    useOscilloscopeStore.getState().pushAnalogBlock('osc-ch-uno-1-9', [0, 1], [0, 5]);
    expect(useOscilloscopeStore.getState().samples['osc-ch-uno-1-9']).toEqual([]);
  });

  it('latches a single-shot trigger at the crossing inside the capture', () => {
    const id = useOscilloscopeStore.getState().addNetChannel('n2', 'n2');
    useOscilloscopeStore.setState({
      triggerMode: 'single',
      triggerChannelId: id,
      triggerEdge: 'rising',
      triggerLevelV: 2.5,
      triggerStatus: 'armed',
    });
    useOscilloscopeStore.getState().pushAnalogBlock(id, [0, 10, 20], [0, 1, 5]);
    const s = useOscilloscopeStore.getState();
    // The crossing happens on the 1 V -> 5 V step, at t = 20 ms.
    expect(s.triggeredAtMs).toBe(20);
    expect(s.triggerStatus).toBe('captured');
    expect(s.running).toBe(false);
  });

  it('a digital channel carries its board amplitude onto the volts axis', () => {
    useOscilloscopeStore.getState().addChannel('uno-1', 9, 'D9', 3.3);
    const ch = useOscilloscopeStore.getState().channels[0];
    expect(ch.kind).toBe('digital');
    if (ch.kind !== 'digital') return;
    expect(ch.amplitudeV).toBe(3.3);
    expect(ch.voltsPerDiv).toBeCloseTo(1.65);
  });
});
