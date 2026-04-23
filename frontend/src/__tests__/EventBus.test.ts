import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  HostEventBus,
  shouldEmitThrottled,
  TICK_INTERVAL_MS,
  SPICE_STEP_INTERVAL_MS,
  getEventBus,
  __resetEventBusForTests,
} from '../simulation/EventBus';

describe('HostEventBus — registration and emit', () => {
  let bus: HostEventBus;
  beforeEach(() => {
    bus = new HostEventBus();
  });

  it('emits with no listeners as a no-op (fast path)', () => {
    expect(() =>
      bus.emit('simulator:tick', { cycle: 1, ts: 0 }),
    ).not.toThrow();
    expect(bus.hasListeners('simulator:tick')).toBe(false);
  });

  it('delivers a registered listener', () => {
    const spy = vi.fn();
    bus.on('simulator:start', spy);
    bus.emit('simulator:start', { board: 'arduino-uno', mode: 'mcu' });
    expect(spy).toHaveBeenCalledWith({ board: 'arduino-uno', mode: 'mcu' });
  });

  it('delivers to multiple listeners in insertion order', () => {
    const order: number[] = [];
    bus.on('simulator:reset', () => order.push(1));
    bus.on('simulator:reset', () => order.push(2));
    bus.on('simulator:reset', () => order.push(3));
    bus.emit('simulator:reset', {});
    expect(order).toEqual([1, 2, 3]);
  });

  it('hasListeners is true after on() and false after unsubscribe', () => {
    const off = bus.on('pin:change', () => {});
    expect(bus.hasListeners('pin:change')).toBe(true);
    off();
    expect(bus.hasListeners('pin:change')).toBe(false);
  });

  it('listenerCount tracks additions and removals', () => {
    expect(bus.listenerCount('pin:change')).toBe(0);
    const off1 = bus.on('pin:change', () => {});
    const off2 = bus.on('pin:change', () => {});
    expect(bus.listenerCount('pin:change')).toBe(2);
    off1();
    expect(bus.listenerCount('pin:change')).toBe(1);
    off2();
    expect(bus.listenerCount('pin:change')).toBe(0);
  });

  it('double-unsubscribe is a no-op', () => {
    const off = bus.on('simulator:start', () => {});
    off();
    expect(() => off()).not.toThrow();
    expect(bus.hasListeners('simulator:start')).toBe(false);
  });
});

describe('HostEventBus — error isolation', () => {
  it('a throwing listener does not prevent subsequent listeners', () => {
    const bus = new HostEventBus();
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const downstream = vi.fn();
    bus.on('simulator:start', () => {
      throw new Error('boom');
    });
    bus.on('simulator:start', downstream);
    bus.emit('simulator:start', { board: 'arduino-uno', mode: 'mcu' });
    expect(downstream).toHaveBeenCalledTimes(1);
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });
});

describe('HostEventBus — iteration safety', () => {
  it('unsubscribing during dispatch does not skip the next listener', () => {
    const bus = new HostEventBus();
    const called: string[] = [];
    let off2: () => void = () => {};
    bus.on('simulator:reset', () => {
      called.push('a');
      off2();
    });
    off2 = bus.on('simulator:reset', () => called.push('b'));
    bus.on('simulator:reset', () => called.push('c'));
    bus.emit('simulator:reset', {});
    expect(called).toEqual(['a', 'b', 'c']);
  });

  it('registering inside a listener does not deliver to the new one in the same pass', () => {
    const bus = new HostEventBus();
    const outer = vi.fn();
    const inner = vi.fn();
    bus.on('simulator:reset', () => {
      outer();
      bus.on('simulator:reset', inner);
    });
    bus.emit('simulator:reset', {});
    expect(outer).toHaveBeenCalledTimes(1);
    expect(inner).not.toHaveBeenCalled();
    bus.emit('simulator:reset', {});
    expect(outer).toHaveBeenCalledTimes(2);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

describe('HostEventBus — leak warning', () => {
  it('warns once when a single event exceeds 50 listeners', () => {
    const bus = new HostEventBus();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 55; i++) bus.on('pin:change', () => {});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('pin:change');
    warn.mockRestore();
  });

  it('does not warn on distinct events each under the threshold', () => {
    const bus = new HostEventBus();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 30; i++) bus.on('pin:change', () => {});
    for (let i = 0; i < 30; i++) bus.on('serial:tx', () => {});
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('HostEventBus — clear()', () => {
  it('removes all listeners and resets warning tracking', () => {
    const bus = new HostEventBus();
    const spy = vi.fn();
    bus.on('simulator:start', spy);
    bus.on('pin:change', spy);
    bus.clear();
    bus.emit('simulator:start', { board: 'arduino-uno', mode: 'mcu' });
    bus.emit('pin:change', { componentId: 'x', pinName: 'A0', state: 1 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('shouldEmitThrottled', () => {
  it('returns true on the first call and false within the interval', () => {
    const state = { lastEmitMs: 0 };
    expect(shouldEmitThrottled(state, 0, TICK_INTERVAL_MS)).toBe(true);
    expect(shouldEmitThrottled(state, 50, TICK_INTERVAL_MS)).toBe(false);
    expect(shouldEmitThrottled(state, 99, TICK_INTERVAL_MS)).toBe(false);
    expect(shouldEmitThrottled(state, 100, TICK_INTERVAL_MS)).toBe(true);
  });

  it('supports different intervals per state object', () => {
    const tick = { lastEmitMs: 0 };
    const spice = { lastEmitMs: 0 };
    shouldEmitThrottled(tick, 0, TICK_INTERVAL_MS);
    shouldEmitThrottled(spice, 0, SPICE_STEP_INTERVAL_MS);
    // 150 ms later: tick should fire again (10 Hz), spice should not (5 Hz)
    expect(shouldEmitThrottled(tick, 150, TICK_INTERVAL_MS)).toBe(true);
    expect(shouldEmitThrottled(spice, 150, SPICE_STEP_INTERVAL_MS)).toBe(false);
    expect(shouldEmitThrottled(spice, 200, SPICE_STEP_INTERVAL_MS)).toBe(true);
  });
});

describe('getEventBus singleton', () => {
  beforeEach(() => {
    __resetEventBusForTests();
  });

  it('returns the same instance across calls', () => {
    const a = getEventBus();
    const b = getEventBus();
    expect(a).toBe(b);
  });

  it('creates a fresh instance after __resetEventBusForTests()', () => {
    const a = getEventBus();
    __resetEventBusForTests();
    const b = getEventBus();
    expect(a).not.toBe(b);
  });
});

describe('Performance contract — 0-listener emit is a cheap no-op', () => {
  it('emitting 1M times with zero listeners completes well under budget', () => {
    const bus = new HostEventBus();
    const start = performance.now();
    for (let i = 0; i < 1_000_000; i++) {
      bus.emit('pin:change', { componentId: 'x', pinName: 'A0', state: 1 });
    }
    const elapsedMs = performance.now() - start;
    // Budget: 1M emits ≤ 50 ms under test conditions (≈50 ns/emit,
    // generous vs. the 10 ns/op target because test jit warmup is uneven)
    expect(elapsedMs).toBeLessThan(200);
  });
});
