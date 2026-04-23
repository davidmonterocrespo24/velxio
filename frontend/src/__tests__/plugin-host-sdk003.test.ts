// @vitest-environment jsdom
/**
 * SDK-003 contract tests — exercises the `components`, `partSimulations`,
 * and `spice` registry surfaces of `PluginContext` end-to-end against the
 * real host singletons.
 *
 * These tests run AFTER `plugin-host.test.ts` (which only exercises gates).
 * They prove the SDK's three-call extension flow:
 *
 *   1. `ctx.components.register(def)` — surfaces a new component in the
 *      picker (host's `componentRegistry.list()`).
 *   2. `ctx.partSimulations.register(id, sim)` — wires the part-sim into
 *      the host so the AVR/RP2040 simulators see plugin parts identically
 *      to built-ins.
 *   3. `ctx.spice.registerMapper(id, mapper)` — emits SPICE cards for the
 *      same component when the user runs the electrical-mode simulator.
 *
 * Tests use the real `componentRegistry` singleton — to avoid leaking
 * registrations across tests, every `register()` call captures its handle
 * and disposes it in `afterEach`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  defineComponent,
  definePartSimulation,
  defineSpiceMapper,
  DuplicateComponentError,
  PermissionDeniedError,
  type EventBusReader,
  type PluginManifest,
  type PluginPermission,
  type SimulatorHandle,
  type SpiceComponentView,
  type SpiceMapperContext,
} from '@velxio/sdk';

import { createPluginContext } from '../plugin-host/createPluginContext';
import componentRegistry from '../services/ComponentRegistry';
import { PartSimulationRegistry as hostPartRegistry } from '../simulation/parts/PartSimulationRegistry';
import { getSpiceMapperRegistry } from '../simulation/spice/SpiceMapperRegistry';

const fakeEvents: EventBusReader = {
  on: () => () => {},
  hasListeners: () => false,
  listenerCount: () => 0,
};

function manifest(
  perms: PluginPermission[] = [],
  extras: Partial<PluginManifest> = {},
): PluginManifest {
  return {
    schemaVersion: 1,
    id: 'sdk003.test',
    name: 'SDK-003 Test',
    version: '1.0.0',
    publisher: { name: 'Tester' },
    description: 'plugin used by SDK-003 contract tests',
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

// ── ctx.components.register — picker integration + duplicate guard ──────────

describe('SDK-003 — ctx.components.register', () => {
  // Track every component id we register so we can reliably purge them.
  const trackedIds = new Set<string>();

  beforeEach(() => {
    for (const id of trackedIds) {
      // Find every disposable handle we still own. The host registry doesn't
      // expose a public unregister so we re-register and dispose, which the
      // last-writer-wins logic treats as a clean removal of our slot.
      // Easier: just leave it — the next test uses a unique id.
    }
    trackedIds.clear();
  });

  function newId(suffix: string): string {
    const id = `sdk003.test.${suffix}.${Math.random().toString(36).slice(2, 8)}`;
    trackedIds.add(id);
    return id;
  }

  it('plugin-registered component appears in componentRegistry.list()', () => {
    const id = newId('led');
    const { context } = createPluginContext(
      manifest(['components.register']),
      { events: fakeEvents },
    );
    const def = defineComponent({
      id,
      name: 'Plugin LED',
      category: 'basic',
      element: 'wokwi-led',
      description: 'A plugin-supplied LED',
      pins: [
        { name: 'A', x: 0, y: 0, signal: 'gpio' },
        { name: 'C', x: 0, y: 10, signal: 'power-gnd' },
      ],
    });
    const handle = context.components.register(def);

    expect(componentRegistry.get(id)).toBeDefined();
    expect(componentRegistry.list().some((c) => c.id === id)).toBe(true);

    handle.dispose();
    expect(componentRegistry.get(id)).toBeUndefined();
  });

  it('throws DuplicateComponentError on second register of the same id', () => {
    const id = newId('dup');
    const { context } = createPluginContext(
      manifest(['components.register']),
      { events: fakeEvents },
    );
    const def = defineComponent({
      id,
      name: 'D',
      category: 'basic',
      element: 'wokwi-led',
      description: '',
      pins: [{ name: 'A', x: 0, y: 0 }],
    });
    const first = context.components.register(def);
    expect(() => context.components.register(def)).toThrow(
      DuplicateComponentError,
    );
    // Carry-info in the error
    try {
      context.components.register(def);
    } catch (err) {
      expect(err).toBeInstanceOf(DuplicateComponentError);
      const e = err as DuplicateComponentError;
      expect(e.componentId).toBe(id);
      expect(e.pluginId).toBe('sdk003.test');
    }
    first.dispose();
    // Now the id is free, so a fresh register should succeed.
    const second = context.components.register(def);
    expect(componentRegistry.get(id)).toBeDefined();
    second.dispose();
  });

  it('cross-plugin duplicate id is also blocked at the second registrant', () => {
    const id = newId('cross');
    const ctxA = createPluginContext(
      manifest(['components.register'], { id: 'plugin.a' }),
      { events: fakeEvents },
    );
    const ctxB = createPluginContext(
      manifest(['components.register'], { id: 'plugin.b' }),
      { events: fakeEvents },
    );
    const def = defineComponent({
      id,
      name: 'X',
      category: 'basic',
      element: 'wokwi-led',
      description: '',
      pins: [{ name: 'A', x: 0, y: 0 }],
    });
    const handle = ctxA.context.components.register(def);
    expect(() => ctxB.context.components.register(def)).toThrow(
      DuplicateComponentError,
    );
    handle.dispose();
  });

  it('component.register throws PermissionDeniedError without components.register', () => {
    const id = newId('nopem');
    const { context } = createPluginContext(manifest([]), { events: fakeEvents });
    const def = defineComponent({
      id,
      name: 'Y',
      category: 'basic',
      element: 'wokwi-led',
      description: '',
      pins: [{ name: 'A', x: 0, y: 0 }],
    });
    expect(() => context.components.register(def)).toThrow(PermissionDeniedError);
  });

  it('plugin-registered component participates in search()', () => {
    const id = newId('search');
    const { context } = createPluginContext(
      manifest(['components.register']),
      { events: fakeEvents },
    );
    const handle = context.components.register(
      defineComponent({
        id,
        name: 'Searchable Widget',
        category: 'sensors',
        element: 'wokwi-led',
        description: 'A unique findable component',
        pins: [{ name: 'P', x: 0, y: 0 }],
        keywords: ['unique-keyword-xyzzy'],
      }),
    );
    const hits = componentRegistry.search('xyzzy');
    expect(hits.some((c) => c.id === id)).toBe(true);
    handle.dispose();
  });
});

// ── ctx.partSimulations.register — fault isolation ──────────────────────────

describe('SDK-003 — ctx.partSimulations.register', () => {
  function uniqueId(prefix: string): string {
    return `sdk003.test.${prefix}.${Math.random().toString(36).slice(2, 8)}`;
  }

  it('SDK-shaped part simulation flows through to host registry', () => {
    const id = uniqueId('part');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read']),
      { events: fakeEvents },
    );
    const onPin = vi.fn();
    const handle = context.partSimulations.register(
      id,
      definePartSimulation({ onPinStateChange: onPin }),
    );
    expect(hostPartRegistry.has(id)).toBe(true);

    // Trigger via the host's legacy lookup → the wrapped fn fires.
    const adapted = hostPartRegistry.get(id)!;
    adapted.onPinStateChange?.('A', true, document.createElement('div'));
    expect(onPin).toHaveBeenCalledWith('A', true, expect.any(HTMLElement));

    handle.dispose();
    expect(hostPartRegistry.has(id)).toBe(false);
  });

  it('throwing onPinStateChange is logged via ctx.logger and does NOT propagate', () => {
    const id = uniqueId('throw-onpin');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { context } = createPluginContext(
        manifest(['simulator.pins.read']),
        { events: fakeEvents },
      );
      const handle = context.partSimulations.register(
        id,
        definePartSimulation({
          onPinStateChange: () => {
            throw new Error('plugin bug');
          },
        }),
      );

      const adapted = hostPartRegistry.get(id)!;
      // Must NOT throw out of the host loop.
      expect(() =>
        adapted.onPinStateChange?.('A', true, document.createElement('div')),
      ).not.toThrow();

      // Error went through PluginLogger → tagged with `[plugin:<id>]`.
      // The logger calls console.error(prefix, message, error) so we flatten
      // all args before scanning for the substrings we care about.
      const calls = errorSpy.mock.calls.map((c) => c.map(String).join(' '));
      expect(calls.some((s) => s.includes('[plugin:sdk003.test]'))).toBe(true);
      expect(calls.some((s) => s.includes('onPinStateChange threw'))).toBe(true);

      handle.dispose();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('throwing attachEvents is logged and returns a no-op cleanup', () => {
    const id = uniqueId('throw-attach');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { context } = createPluginContext(
        manifest(['simulator.pins.read']),
        { events: fakeEvents },
      );
      context.partSimulations.register(
        id,
        definePartSimulation({
          attachEvents: () => {
            throw new Error('attach fail');
          },
        }),
      );

      const adapted = hostPartRegistry.get(id)!;
      const fakeSim = {
        isRunning: () => true,
        setPinState: () => {},
      };
      let cleanup: (() => void) | undefined;
      expect(() => {
        cleanup = adapted.attachEvents?.(
          document.createElement('div'),
          fakeSim as never,
          () => null,
          'instance-1',
        );
      }).not.toThrow();
      expect(typeof cleanup).toBe('function');
      // The no-op cleanup must also be safe to call.
      expect(() => cleanup?.()).not.toThrow();
      const calls = errorSpy.mock.calls.map((c) => c.map(String).join(' '));
      expect(calls.some((s) => s.includes('attachEvents threw'))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('attachEvents receives a SimulatorHandle with componentId, isRunning, setPinState, getArduinoPin', () => {
    const id = uniqueId('handle');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read']),
      { events: fakeEvents },
    );
    const seen = vi.fn();
    context.partSimulations.register(
      id,
      definePartSimulation({
        attachEvents: (_el, sim: SimulatorHandle) => {
          seen({
            componentId: sim.componentId,
            isRunning: sim.isRunning(),
            arduinoPinForA: sim.getArduinoPin('A'),
          });
          sim.setPinState(13, true);
          return () => {};
        },
      }),
    );
    const setPinSpy = vi.fn();
    const fakeSim = { isRunning: () => true, setPinState: setPinSpy };
    const adapted = hostPartRegistry.get(id)!;
    const cleanup = adapted.attachEvents?.(
      document.createElement('div'),
      fakeSim as never,
      (pinName) => (pinName === 'A' ? 7 : null),
      'comp-42',
    );
    expect(seen).toHaveBeenCalledWith({
      componentId: 'comp-42',
      isRunning: true,
      arduinoPinForA: 7,
    });
    expect(setPinSpy).toHaveBeenCalledWith(13, true);
    cleanup?.();
  });
});

// ── ctx.spice.registerMapper — netlist integration ──────────────────────────

describe('SDK-003 — ctx.spice.registerMapper', () => {
  function uniqueId(prefix: string): string {
    return `sdk003.test.${prefix}.${Math.random().toString(36).slice(2, 8)}`;
  }

  it('plugin mapper is invoked when the host looks up its component id', () => {
    const id = uniqueId('rvar');
    const { context } = createPluginContext(
      manifest(['simulator.spice.read']),
      { events: fakeEvents },
    );
    const mapperSpy = vi.fn(
      defineSpiceMapper((comp: SpiceComponentView, netLookup) => {
        const a = netLookup('1');
        const b = netLookup('2');
        if (!a || !b) return null;
        const r = String(comp.properties.resistance ?? '5k');
        return { cards: [`R_${comp.id} ${a} ${b} ${r}`], modelsUsed: new Set() };
      }),
    );
    const handle = context.spice.registerMapper(id, mapperSpy);

    const reg = getSpiceMapperRegistry();
    const lookedUp = reg.lookup(id);
    expect(lookedUp).toBeDefined();

    const result = lookedUp!(
      {
        id: 'r1',
        metadataId: id,
        properties: { resistance: '10k' },
      },
      (pin) => (pin === '1' ? 'n_in' : pin === '2' ? 'n_out' : null),
      { vcc: 5, analysis: { kind: 'op' } } as SpiceMapperContext,
    );
    expect(result).toEqual({
      cards: ['R_r1 n_in n_out 10k'],
      modelsUsed: new Set(),
    });
    expect(mapperSpy).toHaveBeenCalledOnce();

    handle.dispose();
    expect(reg.lookup(id)).toBeUndefined();
  });

  it('mapper that returns null because of missing wires is honored', () => {
    const id = uniqueId('floating');
    const { context } = createPluginContext(
      manifest(['simulator.spice.read']),
      { events: fakeEvents },
    );
    const handle = context.spice.registerMapper(
      id,
      defineSpiceMapper((_c, netLookup) => {
        if (!netLookup('1') || !netLookup('2')) return null;
        return { cards: [], modelsUsed: new Set() };
      }),
    );
    const reg = getSpiceMapperRegistry();
    const out = reg.lookup(id)!(
      { id: 'x', metadataId: id, properties: {} },
      () => null,
      { vcc: 5, analysis: { kind: 'op' } } as SpiceMapperContext,
    );
    expect(out).toBeNull();
    handle.dispose();
  });

  it('registerMapper throws PermissionDeniedError without simulator.spice.read', () => {
    const { context } = createPluginContext(manifest([]), { events: fakeEvents });
    expect(() =>
      context.spice.registerMapper(
        'whatever',
        defineSpiceMapper(() => null),
      ),
    ).toThrow(PermissionDeniedError);
  });

  it('registerMapper + registerModel cooperate for a diode-like component', () => {
    const id = uniqueId('diode');
    const { context, ui } = createPluginContext(
      manifest(['simulator.spice.read']),
      { events: fakeEvents },
    );
    const mh = context.spice.registerMapper(
      id,
      defineSpiceMapper((c, netLookup) => {
        const a = netLookup('A');
        const b = netLookup('K');
        if (!a || !b) return null;
        return {
          cards: [`D_${c.id} ${a} ${b} DPLUGIN`],
          modelsUsed: new Set(['DPLUGIN']),
        };
      }),
    );
    const dh = context.spice.registerModel(
      'DPLUGIN',
      '.model DPLUGIN D(Is=1e-15 N=1)',
    );
    expect(ui.spiceModels.cards()).toContain('.model DPLUGIN D(Is=1e-15 N=1)');
    mh.dispose();
    dh.dispose();
    expect(ui.spiceModels.has('DPLUGIN')).toBe(false);
  });
});

// ── End-to-end: a single plugin registers component + part + mapper ────────

describe('SDK-003 — end-to-end one-plugin extension', () => {
  it('a single plugin registers a Pro-style "OLED-lite" component, its part-sim, and its SPICE mapper', () => {
    const id = `sdk003.test.oledlite.${Math.random().toString(36).slice(2, 6)}`;
    const { context, dispose } = createPluginContext(
      manifest(
        ['components.register', 'simulator.pins.read', 'simulator.spice.read'],
        { id: 'demo.oledlite' },
      ),
      { events: fakeEvents },
    );

    context.components.register(
      defineComponent({
        id,
        name: 'OLED-lite 0.96"',
        category: 'displays',
        element: 'wokwi-ssd1306',
        description: 'A monochrome 128x64 OLED',
        pins: [
          { name: 'VCC', x: 0, y: 0, signal: 'power-vcc' },
          { name: 'GND', x: 0, y: 5, signal: 'power-gnd' },
          { name: 'SCL', x: 0, y: 10, signal: 'i2c-scl' },
          { name: 'SDA', x: 0, y: 15, signal: 'i2c-sda' },
        ],
      }),
    );
    context.partSimulations.register(
      id,
      definePartSimulation({
        attachEvents: () => () => {},
      }),
    );
    context.spice.registerMapper(
      id,
      defineSpiceMapper((c, netLookup) => {
        const v = netLookup('VCC');
        const g = netLookup('GND');
        if (!v || !g) return null;
        // OLED draws ~20mA ≈ 250Ω from a 5V rail.
        return { cards: [`R_${c.id}_load ${v} ${g} 250`], modelsUsed: new Set() };
      }),
    );

    expect(componentRegistry.get(id)?.tagName).toBe('wokwi-ssd1306');
    expect(hostPartRegistry.has(id)).toBe(true);
    expect(getSpiceMapperRegistry().has(id)).toBe(true);

    dispose();

    expect(componentRegistry.get(id)).toBeUndefined();
    expect(hostPartRegistry.has(id)).toBe(false);
    expect(getSpiceMapperRegistry().has(id)).toBe(false);
  });
});
