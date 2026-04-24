// @vitest-environment jsdom
/**
 * CORE-006b-step5 — worker-safe event delegation for
 * `PartSimulation.events` + `onEvent`.
 *
 * When the host adapter sees a part simulation with `events: [...]` and
 * `onEvent: (...)` set, it must:
 *   1. Install one DOM listener per kind on the part's root element.
 *   2. On each event, forward a `DelegatedPartEvent` payload to `onEvent`.
 *   3. Coordinates are element-local (subtract bounding rect).
 *   4. Fault-isolate a throwing `onEvent` (log + swallow).
 *   5. Tear down every listener on stop.
 *
 * We exercise this end-to-end by registering a part via
 * `ctx.partSimulations.register(id, sim)` and then firing DOM events
 * on an element after the host invokes `attachEvents`.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  definePartSimulation,
  type DelegatedPartEvent,
  type EventBusReader,
  type PluginManifest,
  type PluginPermission,
  type SimulatorHandle,
} from '@velxio/sdk';

import { createPluginContext } from '../plugin-host/createPluginContext';
import { PartSimulationRegistry as hostPartRegistry } from '../simulation/parts/PartSimulationRegistry';

const fakeEvents: EventBusReader = {
  on: () => () => {},
  hasListeners: () => false,
  listenerCount: () => 0,
};

function manifest(perms: PluginPermission[] = []): PluginManifest {
  return {
    schemaVersion: 1,
    id: 'delegation.test',
    name: 'Delegation Test',
    version: '1.0.0',
    publisher: { name: 'Tester' },
    description: 'plugin used by event-delegation tests',
    icon: 'https://example.com/icon.svg',
    license: 'MIT',
    category: 'utility',
    tags: [],
    type: ['ui-extension'],
    entry: { module: 'index.js' },
    permissions: perms,
    pricing: { model: 'free' },
    refundPolicy: 'none',
  } as PluginManifest;
}

function uniqueId(prefix: string): string {
  return `delegation.test.${prefix}.${Math.random().toString(36).slice(2, 8)}`;
}

function fakeSimHandle(componentId: string): SimulatorHandle {
  const noopDisp = { dispose: () => {} };
  return {
    componentId,
    boardPlatform: 'avr',
    isRunning: () => true,
    setPinState: () => {},
    getArduinoPin: () => null,
    onPinChange: () => noopDisp,
    onPwmChange: () => noopDisp,
    onSpiTransmit: () => noopDisp,
    schedulePinChange: () => {},
    registerI2cSlave: () => noopDisp,
    registerSpiSlave: () => noopDisp,
    cyclesNow: () => 0,
    clockHz: () => 16_000_000,
    setAnalogValue: () => {},
    onSensorControlUpdate: () => noopDisp,
  };
}

function makeHostElement(): HTMLElement {
  const el = document.createElement('div');
  el.style.width = '100px';
  el.style.height = '50px';
  // jsdom doesn't run layout, so we stub getBoundingClientRect. This makes
  // the coordinate math deterministic.
  el.getBoundingClientRect = () =>
    ({ left: 20, top: 30, right: 120, bottom: 80, width: 100, height: 50, x: 20, y: 30, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

describe('CORE-006b-step5 — delegated part events', () => {
  it('forwards click events as DelegatedPartEvent to onEvent', () => {
    const id = uniqueId('click');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read']),
      { events: fakeEvents },
    );
    const received: DelegatedPartEvent[] = [];
    context.partSimulations.register(
      id,
      definePartSimulation({
        events: ['click'],
        onEvent: (ev) => received.push(ev),
      }),
    );
    const entry = hostPartRegistry.get(id);
    expect(entry).toBeDefined();
    expect(entry?.attachEvents).toBeTypeOf('function');

    const el = makeHostElement();
    const handle = fakeSimHandle(id);
    const teardown = entry!.attachEvents!(el, handle, () => null, id);

    const ev = new MouseEvent('click', {
      bubbles: true,
      clientX: 50,  // relative to viewport
      clientY: 55,
      button: 0,
    });
    el.dispatchEvent(ev);

    expect(received.length).toBe(1);
    expect(received[0].type).toBe('click');
    // rect is (left:20, top:30), so element-local is (30, 25).
    expect(received[0].x).toBe(30);
    expect(received[0].y).toBe(25);
    expect(received[0].button).toBe(0);
    expect(received[0].pluginId).toBe('delegation.test');

    teardown();
    document.body.removeChild(el);
  });

  it('installs one listener per declared kind', () => {
    const id = uniqueId('multi');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read']),
      { events: fakeEvents },
    );
    const kinds: string[] = [];
    context.partSimulations.register(
      id,
      definePartSimulation({
        events: ['click', 'mousedown', 'mouseup'],
        onEvent: (ev) => kinds.push(ev.type),
      }),
    );
    const entry = hostPartRegistry.get(id);
    const el = makeHostElement();
    const teardown = entry!.attachEvents!(el, fakeSimHandle(id), () => null, id);

    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    // Not declared — must not fire.
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));

    expect(kinds).toEqual(['click', 'mousedown', 'mouseup']);
    teardown();
    document.body.removeChild(el);
  });

  it('fault-isolates a throwing onEvent (subsequent events still fire)', () => {
    const id = uniqueId('faulty');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read']),
      { events: fakeEvents },
    );
    let count = 0;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    context.partSimulations.register(
      id,
      definePartSimulation({
        events: ['click'],
        onEvent: () => {
          count += 1;
          throw new Error('boom');
        },
      }),
    );
    const entry = hostPartRegistry.get(id);
    const el = makeHostElement();
    const teardown = entry!.attachEvents!(el, fakeSimHandle(id), () => null, id);

    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(count).toBe(3);
    expect(err).toHaveBeenCalled();
    err.mockRestore();

    teardown();
    document.body.removeChild(el);
  });

  it('teardown removes all installed listeners', () => {
    const id = uniqueId('teardown');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read']),
      { events: fakeEvents },
    );
    let count = 0;
    context.partSimulations.register(
      id,
      definePartSimulation({
        events: ['click'],
        onEvent: () => {
          count += 1;
        },
      }),
    );
    const entry = hostPartRegistry.get(id);
    const el = makeHostElement();
    const teardown = entry!.attachEvents!(el, fakeSimHandle(id), () => null, id);

    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(count).toBe(1);

    teardown();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(count).toBe(1);
    document.body.removeChild(el);
  });

  it('events + attachEvents coexist — both run, both tear down', () => {
    const id = uniqueId('coexist');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read']),
      { events: fakeEvents },
    );
    const eventLog: string[] = [];
    const attachLog: string[] = [];
    context.partSimulations.register(
      id,
      definePartSimulation({
        events: ['click'],
        onEvent: () => eventLog.push('delegated'),
        attachEvents: (element) => {
          const fn = () => attachLog.push('attach');
          element.addEventListener('dblclick', fn);
          return () => element.removeEventListener('dblclick', fn);
        },
      }),
    );
    const entry = hostPartRegistry.get(id);
    const el = makeHostElement();
    const teardown = entry!.attachEvents!(el, fakeSimHandle(id), () => null, id);

    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(eventLog).toEqual(['delegated']);
    expect(attachLog).toEqual(['attach']);

    teardown();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(eventLog.length).toBe(1);
    expect(attachLog.length).toBe(1);
    document.body.removeChild(el);
  });
});
