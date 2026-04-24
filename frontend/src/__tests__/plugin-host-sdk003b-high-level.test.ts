// @vitest-environment jsdom
/**
 * SDK-003b step 2 — host wiring of `ctx.partSimulations.registerHighLevel`.
 *
 * Exercises the full path: plugin authors write a `HighLevelPartSimulation`,
 * `createPluginContext` wraps it into a low-level `PartSimulation`, the
 * host registry installs that under the component id, and the host
 * simulator eventually calls `attachEvents(element, handle)` to bring
 * the pin/serial/i2c API live.
 *
 * Coverage:
 *   1. `pin(name).state` tracks transitions (`'low'` / `'high'` / `'floating'`).
 *   2. `pin(name).onChange` fires on transitions, `dispose()` unsubscribes.
 *   3. `pin(name).set()` is gated at call time on `simulator.pins.write`.
 *   4. `pin(name)` for a pin not in `definition.pins` throws.
 *   5. `serial.onRead` fires from `events.on('serial:tx', …)`.
 *   6. `i2c.onTransfer` fires from `events.on('i2c:transfer', …)`.
 *   7. `registerHighLevel` requires `simulator.pins.read`.
 *   8. Teardown disposes every internal subscription, even if the
 *      author's teardown throws.
 *   9. `defineHighLevelPart` is identity-preserving at runtime.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  defineHighLevelPart,
  PermissionDeniedError,
  type EventBusReader,
  type I2CTransferEvent,
  type PluginManifest,
  type PluginPermission,
  type SimulatorEventListener,
  type SimulatorEventName,
  type SimulatorEvents,
} from '@velxio/sdk';

import { createPluginContext } from '../plugin-host/createPluginContext';
import { PartSimulationRegistry as hostPartRegistry } from '../simulation/parts/PartSimulationRegistry';
import { PinManager } from '../simulation/PinManager';

function manifest(
  perms: PluginPermission[] = [],
  extras: Partial<PluginManifest> = {},
): PluginManifest {
  return {
    schemaVersion: 1,
    id: 'sdk003b.step2.test',
    name: 'SDK-003b Step 2 Test',
    version: '1.0.0',
    publisher: { name: 'Tester' },
    description: 'plugin used by registerHighLevel tests',
    icon: 'https://example.com/icon.svg',
    license: 'MIT',
    category: 'utility',
    tags: [],
    type: ['ui-extension'],
    entry: { module: 'index.js' },
    permissions: perms,
    pricing: { model: 'free' },
    refundPolicy: 'none',
    ...extras,
  } as PluginManifest;
}

function uniqueId(prefix: string): string {
  return `sdk003b.step2.${prefix}.${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Minimal hand-rolled EventBusReader for tests. Accepts `on()`
 * subscriptions and lets tests fire synthetic payloads via `emit()`.
 * Keeps listener-set semantics (remove on unsubscribe) so `dispose()`
 * contracts are verifiable without pulling in the real event bus.
 */
function buildFakeEvents() {
  const listeners = new Map<SimulatorEventName, Set<(payload: unknown) => void>>();
  const bus: EventBusReader = {
    on<K extends SimulatorEventName>(event: K, fn: SimulatorEventListener<K>) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const wrapper = fn as (payload: unknown) => void;
      set.add(wrapper);
      return () => {
        set!.delete(wrapper);
      };
    },
    hasListeners: (event) => (listeners.get(event)?.size ?? 0) > 0,
    listenerCount: (event) => listeners.get(event)?.size ?? 0,
  };
  function emit<K extends SimulatorEventName>(
    event: K,
    payload: SimulatorEvents[K],
  ): void {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) fn(payload as never);
  }
  return { bus, emit };
}

function buildFakeSim(pinManager: PinManager) {
  return {
    setPinState: (pin: number, state: boolean) => pinManager.setPinState(pin, state),
    isRunning: () => true,
    pinManager,
  } as never;
}

describe('SDK-003b step 2 — registerHighLevel', () => {
  it('defineHighLevelPart is an identity helper', () => {
    const literal = { pins: ['A'], attach: () => () => {} };
    expect(defineHighLevelPart(literal)).toBe(literal);
  });

  it('register-time gate: throws PermissionDeniedError without simulator.pins.read', () => {
    const { context } = createPluginContext(manifest([]), {
      events: buildFakeEvents().bus,
    });
    expect(() =>
      context.partSimulations.registerHighLevel('x', {
        pins: ['A'],
        attach: () => () => {},
      }),
    ).toThrow(PermissionDeniedError);
  });

  it('registerHighLevel succeeds with simulator.pins.read and produces an installed PartSimulation', () => {
    const id = uniqueId('install');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read']),
      { events: buildFakeEvents().bus },
    );
    const handle = context.partSimulations.registerHighLevel(
      id,
      defineHighLevelPart({ pins: ['A'], attach: () => () => {} }),
    );
    expect(hostPartRegistry.has(id)).toBe(true);
    handle.dispose();
    expect(hostPartRegistry.has(id)).toBe(false);
  });

  it('pin(name).state reflects transitions as low/high/floating', () => {
    const id = uniqueId('pin-state');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read']),
      { events: buildFakeEvents().bus },
    );

    const observed: Array<'low' | 'high' | 'floating'> = [];
    context.partSimulations.registerHighLevel(
      id,
      defineHighLevelPart({
        pins: ['DOUT'],
        attach: (_el, api) => {
          // Initial state: 'floating' — no transition observed yet.
          observed.push(api.pin('DOUT').state);
          api.pin('DOUT').onChange((level) => observed.push(level));
          return () => {};
        },
      }),
    );

    const pm = new PinManager();
    const adapted = hostPartRegistry.get(id)!;
    adapted.attachEvents!(
      document.createElement('div'),
      buildFakeSim(pm),
      (name) => (name === 'DOUT' ? 5 : null),
      'comp-1',
    );

    pm.triggerPinChange(5, true); // high
    pm.triggerPinChange(5, false); // low
    expect(observed).toEqual(['floating', 'high', 'low']);
  });

  it('pin(name).onChange dispose() removes the subscription', () => {
    const id = uniqueId('onchange-dispose');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read']),
      { events: buildFakeEvents().bus },
    );
    const fn = vi.fn();
    let disposeFn: (() => void) | undefined;
    context.partSimulations.registerHighLevel(
      id,
      defineHighLevelPart({
        pins: ['D0'],
        attach: (_el, api) => {
          const d = api.pin('D0').onChange(fn);
          disposeFn = () => d.dispose();
          return () => {};
        },
      }),
    );

    const pm = new PinManager();
    const adapted = hostPartRegistry.get(id)!;
    adapted.attachEvents!(
      document.createElement('div'),
      buildFakeSim(pm),
      () => 3,
      'c1',
    );
    pm.triggerPinChange(3, true);
    expect(fn).toHaveBeenCalledWith('high');
    disposeFn!();
    pm.triggerPinChange(3, false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('pin(name).set requires simulator.pins.write at call time', () => {
    const id = uniqueId('set-no-perm');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read']), // no pins.write
      { events: buildFakeEvents().bus },
    );
    let capturedError: unknown;
    context.partSimulations.registerHighLevel(
      id,
      defineHighLevelPart({
        pins: ['SIG'],
        attach: (_el, api) => {
          try {
            api.pin('SIG').set('high');
          } catch (err) {
            capturedError = err;
          }
          return () => {};
        },
      }),
    );
    const pm = new PinManager();
    const adapted = hostPartRegistry.get(id)!;
    adapted.attachEvents!(
      document.createElement('div'),
      buildFakeSim(pm),
      () => 7,
      'c1',
    );
    expect(capturedError).toBeInstanceOf(PermissionDeniedError);
  });

  it('pin(name).set forwards to simulator.setPinState when permitted', () => {
    const id = uniqueId('set-forward');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read', 'simulator.pins.write']),
      { events: buildFakeEvents().bus },
    );
    context.partSimulations.registerHighLevel(
      id,
      defineHighLevelPart({
        pins: ['SIG'],
        attach: (_el, api) => {
          api.pin('SIG').set('high');
          api.pin('SIG').set('low');
          return () => {};
        },
      }),
    );
    const setPinSpy = vi.fn();
    const fakeSim = {
      setPinState: setPinSpy,
      isRunning: () => true,
      pinManager: new PinManager(),
    } as never;
    const adapted = hostPartRegistry.get(id)!;
    adapted.attachEvents!(
      document.createElement('div'),
      fakeSim,
      (name) => (name === 'SIG' ? 9 : null),
      'c1',
    );
    expect(setPinSpy).toHaveBeenNthCalledWith(1, 9, true);
    expect(setPinSpy).toHaveBeenNthCalledWith(2, 9, false);
  });

  it('pin(name).set is a silent no-op when the pin is not wired', () => {
    const id = uniqueId('set-unwired');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read', 'simulator.pins.write']),
      { events: buildFakeEvents().bus },
    );
    context.partSimulations.registerHighLevel(
      id,
      defineHighLevelPart({
        pins: ['SIG'],
        attach: (_el, api) => {
          api.pin('SIG').set('high');
          return () => {};
        },
      }),
    );
    const setPinSpy = vi.fn();
    const fakeSim = {
      setPinState: setPinSpy,
      isRunning: () => true,
      pinManager: new PinManager(),
    } as never;
    const adapted = hostPartRegistry.get(id)!;
    expect(() =>
      adapted.attachEvents!(
        document.createElement('div'),
        fakeSim,
        () => null, // no wire
        'c1',
      ),
    ).not.toThrow();
    expect(setPinSpy).not.toHaveBeenCalled();
  });

  it('pin(name) for an undeclared pin throws with a descriptive message', () => {
    const id = uniqueId('undeclared-pin');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read']),
      { events: buildFakeEvents().bus },
    );
    let thrown: unknown;
    context.partSimulations.registerHighLevel(
      id,
      defineHighLevelPart({
        pins: ['A'],
        attach: (_el, api) => {
          try {
            api.pin('MYSTERY');
          } catch (err) {
            thrown = err;
          }
          return () => {};
        },
      }),
    );
    const adapted = hostPartRegistry.get(id)!;
    adapted.attachEvents!(
      document.createElement('div'),
      buildFakeSim(new PinManager()),
      () => 1,
      'c1',
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain('MYSTERY');
  });

  it('serial.onRead fires on serial:tx events from the bus', () => {
    const id = uniqueId('serial-read');
    const { bus, emit } = buildFakeEvents();
    const { context } = createPluginContext(
      manifest(['simulator.pins.read']),
      { events: bus },
    );
    const received: Uint8Array[] = [];
    context.partSimulations.registerHighLevel(
      id,
      defineHighLevelPart({
        pins: [],
        attach: (_el, api) => {
          api.serial!.onRead((data) => received.push(data));
          return () => {};
        },
      }),
    );
    const adapted = hostPartRegistry.get(id)!;
    adapted.attachEvents!(
      document.createElement('div'),
      buildFakeSim(new PinManager()),
      () => null,
      'c1',
    );
    emit('serial:tx', { port: 0, data: new Uint8Array([0x41, 0x42]) });
    expect(received).toHaveLength(1);
    expect(Array.from(received[0])).toEqual([0x41, 0x42]);
  });

  it('i2c.onTransfer fires on i2c:transfer events from the bus', () => {
    const id = uniqueId('i2c-transfer');
    const { bus, emit } = buildFakeEvents();
    const { context } = createPluginContext(
      manifest(['simulator.pins.read']),
      { events: bus },
    );
    const seen: I2CTransferEvent[] = [];
    context.partSimulations.registerHighLevel(
      id,
      defineHighLevelPart({
        pins: [],
        attach: (_el, api) => {
          api.i2c!.onTransfer((ev) => seen.push(ev));
          return () => {};
        },
      }),
    );
    const adapted = hostPartRegistry.get(id)!;
    adapted.attachEvents!(
      document.createElement('div'),
      buildFakeSim(new PinManager()),
      () => null,
      'c1',
    );
    emit('i2c:transfer', {
      addr: 0x68,
      direction: 'write',
      data: new Uint8Array([1, 2, 3]),
      stop: true,
    });
    expect(seen).toEqual([
      {
        addr: 0x68,
        direction: 'write',
        data: new Uint8Array([1, 2, 3]),
        stop: true,
      },
    ]);
  });

  it('teardown disposes every pin subscription + bus listener', () => {
    const id = uniqueId('teardown');
    const { bus, emit } = buildFakeEvents();
    const { context } = createPluginContext(
      manifest(['simulator.pins.read']),
      { events: bus },
    );
    const pinCalls = vi.fn();
    const serialCalls = vi.fn();
    context.partSimulations.registerHighLevel(
      id,
      defineHighLevelPart({
        pins: ['D0'],
        attach: (_el, api) => {
          api.pin('D0').onChange(pinCalls);
          api.serial!.onRead(serialCalls);
          return () => {
            /* no-op author teardown */
          };
        },
      }),
    );
    const pm = new PinManager();
    const adapted = hostPartRegistry.get(id)!;
    const cleanup = adapted.attachEvents!(
      document.createElement('div'),
      buildFakeSim(pm),
      () => 2,
      'c1',
    );
    pm.triggerPinChange(2, true);
    emit('serial:tx', { port: 0, data: new Uint8Array([1]) });
    expect(pinCalls).toHaveBeenCalledTimes(1);
    expect(serialCalls).toHaveBeenCalledTimes(1);

    cleanup!();

    pm.triggerPinChange(2, false);
    emit('serial:tx', { port: 0, data: new Uint8Array([2]) });
    expect(pinCalls).toHaveBeenCalledTimes(1);
    expect(serialCalls).toHaveBeenCalledTimes(1);
  });

  it('teardown still releases internal subscriptions when the author teardown throws', () => {
    const id = uniqueId('throw-teardown');
    const { bus, emit } = buildFakeEvents();
    const { context } = createPluginContext(
      manifest(['simulator.pins.read']),
      { events: bus },
    );
    const serialCalls = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      context.partSimulations.registerHighLevel(
        id,
        defineHighLevelPart({
          pins: [],
          attach: (_el, api) => {
            api.serial!.onRead(serialCalls);
            return () => {
              throw new Error('boom');
            };
          },
        }),
      );
      const adapted = hostPartRegistry.get(id)!;
      const cleanup = adapted.attachEvents!(
        document.createElement('div'),
        buildFakeSim(new PinManager()),
        () => null,
        'c1',
      );
      emit('serial:tx', { port: 0, data: new Uint8Array([1]) });
      expect(serialCalls).toHaveBeenCalledTimes(1);

      expect(() => cleanup!()).not.toThrow();

      // Internal subscription must be gone even though the author threw.
      emit('serial:tx', { port: 0, data: new Uint8Array([2]) });
      expect(serialCalls).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('listener throws are logged and do not break sibling onChange listeners', () => {
    const id = uniqueId('listener-throw');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read']),
      { events: buildFakeEvents().bus },
    );
    const good = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      context.partSimulations.registerHighLevel(
        id,
        defineHighLevelPart({
          pins: ['D0'],
          attach: (_el, api) => {
            api.pin('D0').onChange(() => {
              throw new Error('listener boom');
            });
            api.pin('D0').onChange(good);
            return () => {};
          },
        }),
      );
      const pm = new PinManager();
      const adapted = hostPartRegistry.get(id)!;
      adapted.attachEvents!(
        document.createElement('div'),
        buildFakeSim(pm),
        () => 4,
        'c1',
      );
      pm.triggerPinChange(4, true);
      expect(good).toHaveBeenCalledWith('high');
    } finally {
      errorSpy.mockRestore();
    }
  });
});
