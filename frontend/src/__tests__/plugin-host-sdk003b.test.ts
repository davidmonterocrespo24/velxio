// @vitest-environment jsdom
/**
 * SDK-003b contract tests — exercises `ctx.components.registerCompound`,
 * the compact authoring entry point that fans out to the same gated
 * register*() adapters as the three discrete calls.
 *
 * Coverage:
 *   1. The four shape combinations (picker-only, +sim, +spice, full).
 *   2. Single dispose tears down every acquired sub-handle (LIFO).
 *   3. Dispose is idempotent.
 *   4. Permission union — missing `simulator.spice.read` aborts the
 *      compound mid-flight and rolls back already-acquired handles so
 *      the component never appears half-registered.
 *   5. Picker-only authoring (no permissions beyond `components.register`)
 *      still works.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  defineCompoundComponent,
  definePartSimulation,
  defineSpiceMapper,
  PermissionDeniedError,
  type EventBusReader,
  type PluginManifest,
  type PluginPermission,
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
    id: 'sdk003b.test',
    name: 'SDK-003b Test',
    version: '1.0.0',
    publisher: { name: 'Tester' },
    description: 'plugin used by SDK-003b registerCompound tests',
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
  return `sdk003b.test.${prefix}.${Math.random().toString(36).slice(2, 8)}`;
}

const basePins = [
  { name: 'A', x: 0, y: 0, signal: 'gpio' as const },
  { name: 'C', x: 0, y: 10, signal: 'power-gnd' as const },
];

describe('SDK-003b — ctx.components.registerCompound', () => {
  it('picker-only shape registers the component and nothing else', () => {
    const id = uniqueId('picker');
    const { context } = createPluginContext(
      manifest(['components.register']),
      { events: fakeEvents },
    );
    const handle = context.components.registerCompound(
      defineCompoundComponent({
        id,
        name: 'Picker LED',
        category: 'basic',
        element: 'wokwi-led',
        description: '',
        pins: basePins,
      }),
    );

    expect(componentRegistry.get(id)).toBeDefined();
    expect(hostPartRegistry.has(id)).toBe(false);
    expect(getSpiceMapperRegistry().has(id)).toBe(false);

    handle.dispose();
    expect(componentRegistry.get(id)).toBeUndefined();
  });

  it('+ simulation shape registers component and part simulation', () => {
    const id = uniqueId('sim');
    const { context } = createPluginContext(
      manifest(['components.register', 'simulator.pins.read']),
      { events: fakeEvents },
    );
    const onPin = vi.fn();
    const handle = context.components.registerCompound(
      defineCompoundComponent({
        id,
        name: 'Sim LED',
        category: 'basic',
        element: 'wokwi-led',
        description: '',
        pins: basePins,
        simulation: definePartSimulation({ onPinStateChange: onPin }),
      }),
    );

    expect(componentRegistry.get(id)).toBeDefined();
    expect(hostPartRegistry.has(id)).toBe(true);
    expect(getSpiceMapperRegistry().has(id)).toBe(false);

    // The plugin's onPinStateChange flows through the host adapter.
    hostPartRegistry
      .get(id)!
      .onPinStateChange?.('A', true, document.createElement('div'));
    expect(onPin).toHaveBeenCalledWith('A', true, expect.any(HTMLElement));

    handle.dispose();
    expect(componentRegistry.get(id)).toBeUndefined();
    expect(hostPartRegistry.has(id)).toBe(false);
  });

  it('+ spice shape registers component and SPICE mapper', () => {
    const id = uniqueId('spice');
    const { context } = createPluginContext(
      manifest(['components.register', 'simulator.spice.read']),
      { events: fakeEvents },
    );
    const handle = context.components.registerCompound(
      defineCompoundComponent({
        id,
        name: 'Spiced LED',
        category: 'basic',
        element: 'wokwi-led',
        description: '',
        pins: basePins,
        spice: defineSpiceMapper((_c, netLookup) => {
          const a = netLookup('A');
          const c = netLookup('C');
          if (!a || !c) return null;
          return { cards: [`R_x ${a} ${c} 1k`], modelsUsed: new Set() };
        }),
      }),
    );

    expect(componentRegistry.get(id)).toBeDefined();
    expect(hostPartRegistry.has(id)).toBe(false);
    expect(getSpiceMapperRegistry().has(id)).toBe(true);

    handle.dispose();
    expect(componentRegistry.get(id)).toBeUndefined();
    expect(getSpiceMapperRegistry().has(id)).toBe(false);
  });

  it('full shape (sim + spice + spiceModels) wires every sub-registration', () => {
    const id = uniqueId('full');
    const { context, ui } = createPluginContext(
      manifest([
        'components.register',
        'simulator.pins.read',
        'simulator.spice.read',
      ]),
      { events: fakeEvents },
    );
    const handle = context.components.registerCompound(
      defineCompoundComponent({
        id,
        name: 'Full LED',
        category: 'basic',
        element: 'wokwi-led',
        description: '',
        pins: basePins,
        simulation: definePartSimulation({ attachEvents: () => () => {} }),
        spice: defineSpiceMapper((c, netLookup) => {
          const a = netLookup('A');
          const k = netLookup('C');
          if (!a || !k) return null;
          return {
            cards: [`D_${c.id} ${a} ${k} D_COMPOUND`],
            modelsUsed: new Set(['D_COMPOUND']),
          };
        }),
        spiceModels: [
          { name: 'D_COMPOUND', card: '.model D_COMPOUND D(Is=1e-15)' },
          { name: 'BJT_X', card: '.model BJT_X NPN(BF=100)' },
        ],
      }),
    );

    expect(componentRegistry.get(id)).toBeDefined();
    expect(hostPartRegistry.has(id)).toBe(true);
    expect(getSpiceMapperRegistry().has(id)).toBe(true);
    expect(ui.spiceModels.cards()).toContain('.model D_COMPOUND D(Is=1e-15)');
    expect(ui.spiceModels.has('BJT_X')).toBe(true);

    handle.dispose();
    expect(componentRegistry.get(id)).toBeUndefined();
    expect(hostPartRegistry.has(id)).toBe(false);
    expect(getSpiceMapperRegistry().has(id)).toBe(false);
    expect(ui.spiceModels.has('D_COMPOUND')).toBe(false);
    expect(ui.spiceModels.has('BJT_X')).toBe(false);
  });

  it('dispose is idempotent — second call is a no-op', () => {
    const id = uniqueId('idem');
    const { context } = createPluginContext(
      manifest(['components.register', 'simulator.pins.read']),
      { events: fakeEvents },
    );
    const handle = context.components.registerCompound(
      defineCompoundComponent({
        id,
        name: 'Idem',
        category: 'basic',
        element: 'wokwi-led',
        description: '',
        pins: basePins,
        simulation: definePartSimulation({ attachEvents: () => () => {} }),
      }),
    );
    handle.dispose();
    expect(() => handle.dispose()).not.toThrow();
    expect(componentRegistry.get(id)).toBeUndefined();
    expect(hostPartRegistry.has(id)).toBe(false);
  });

  it('rollback: missing simulator.spice.read disposes prior sub-handles before throwing', () => {
    const id = uniqueId('rollback');
    // Permissions cover component + sim, but NOT spice.
    const { context } = createPluginContext(
      manifest(['components.register', 'simulator.pins.read']),
      { events: fakeEvents },
    );

    expect(() =>
      context.components.registerCompound(
        defineCompoundComponent({
          id,
          name: 'Rollback',
          category: 'basic',
          element: 'wokwi-led',
          description: '',
          pins: basePins,
          simulation: definePartSimulation({ attachEvents: () => () => {} }),
          // Will trip the gate AFTER component + part are already in.
          spice: defineSpiceMapper(() => null),
        }),
      ),
    ).toThrow(PermissionDeniedError);

    // Critical: nothing leaked. Picker, part registry, spice registry all
    // back to empty for this id.
    expect(componentRegistry.get(id)).toBeUndefined();
    expect(hostPartRegistry.has(id)).toBe(false);
    expect(getSpiceMapperRegistry().has(id)).toBe(false);
  });

  it('rollback: missing components.register fails fast — nothing is acquired', () => {
    const id = uniqueId('rollback-first');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read', 'simulator.spice.read']),
      { events: fakeEvents },
    );
    expect(() =>
      context.components.registerCompound(
        defineCompoundComponent({
          id,
          name: 'NoPerm',
          category: 'basic',
          element: 'wokwi-led',
          description: '',
          pins: basePins,
          simulation: definePartSimulation({ attachEvents: () => () => {} }),
        }),
      ),
    ).toThrow(PermissionDeniedError);
    expect(componentRegistry.get(id)).toBeUndefined();
    expect(hostPartRegistry.has(id)).toBe(false);
  });

  it('plugin teardown via subscriptions.dispose() also releases compound sub-handles (idempotent)', () => {
    const id = uniqueId('teardown');
    const { context, dispose } = createPluginContext(
      manifest([
        'components.register',
        'simulator.pins.read',
        'simulator.spice.read',
      ]),
      { events: fakeEvents },
    );
    context.components.registerCompound(
      defineCompoundComponent({
        id,
        name: 'Teardown',
        category: 'basic',
        element: 'wokwi-led',
        description: '',
        pins: basePins,
        simulation: definePartSimulation({ attachEvents: () => () => {} }),
        spice: defineSpiceMapper(() => null),
        spiceModels: [{ name: 'M_TD', card: '.model M_TD D(Is=1e-15)' }],
      }),
    );

    expect(componentRegistry.get(id)).toBeDefined();
    expect(hostPartRegistry.has(id)).toBe(true);

    // Plugin lifecycle deactivation — drives the same path the loader uses.
    dispose();

    expect(componentRegistry.get(id)).toBeUndefined();
    expect(hostPartRegistry.has(id)).toBe(false);
    expect(getSpiceMapperRegistry().has(id)).toBe(false);
  });

  it('compound dispose runs sub-handles LIFO (spice models → spice → part → component)', () => {
    const id = uniqueId('lifo');
    const { context, ui } = createPluginContext(
      manifest([
        'components.register',
        'simulator.pins.read',
        'simulator.spice.read',
      ]),
      { events: fakeEvents },
    );
    const handle = context.components.registerCompound(
      defineCompoundComponent({
        id,
        name: 'LIFO',
        category: 'basic',
        element: 'wokwi-led',
        description: '',
        pins: basePins,
        simulation: definePartSimulation({ attachEvents: () => () => {} }),
        spice: defineSpiceMapper(() => null),
        spiceModels: [{ name: 'M_LIFO', card: '.model M_LIFO D(Is=1e-15)' }],
      }),
    );

    // Snapshot what's live before dispose.
    expect(componentRegistry.get(id)).toBeDefined();
    expect(hostPartRegistry.has(id)).toBe(true);
    expect(getSpiceMapperRegistry().has(id)).toBe(true);
    expect(ui.spiceModels.has('M_LIFO')).toBe(true);

    handle.dispose();

    // After LIFO unwind everything is gone.
    expect(componentRegistry.get(id)).toBeUndefined();
    expect(hostPartRegistry.has(id)).toBe(false);
    expect(getSpiceMapperRegistry().has(id)).toBe(false);
    expect(ui.spiceModels.has('M_LIFO')).toBe(false);
  });
});
