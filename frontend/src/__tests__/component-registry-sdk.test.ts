/**
 * Contract tests for ComponentRegistry's SDK-facing `register()` surface.
 *
 * These tests exercise the path used by plugin code via
 * `ctx.components.register()`. The built-in `processMetadata()` loader is
 * covered elsewhere — here we focus on SDK → host translation, search/
 * category integration, last-writer-wins override, and dispose semantics.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentRegistry } from '../services/ComponentRegistry';
import type { ComponentDefinition } from '@velxio/sdk';

/**
 * Grab a private-but-same-instance handle to the registry. The singleton
 * holds built-ins loaded from metadata JSON; we just layer plugin-like
 * registrations on top and verify they round-trip.
 */
function freshRegistry(): ComponentRegistry {
  // Singleton — ComponentRegistry is not resettable in production code, but
  // the SDK contract methods are pure with respect to the components we add
  // here because each test uses unique ids and disposes in teardown.
  return ComponentRegistry.getInstance();
}

const DEF: ComponentDefinition = {
  id: 'sdk-test-widget',
  name: 'Test Widget',
  category: 'basic',
  element: 'velxio-test-widget',
  description: 'a widget under test',
  pins: [
    { name: 'A', x: 0, y: 0, signal: 'gpio' },
    { name: 'B', x: 10, y: 0, signal: 'power-gnd' },
  ],
  properties: [
    {
      name: 'color',
      kind: 'enum',
      default: 'red',
      options: [
        { value: 'red', label: 'Red' },
        { value: 'green', label: 'Green' },
      ],
    },
    {
      name: 'resistance',
      kind: 'number',
      default: 1000,
      min: 1,
      max: 1_000_000,
    },
  ],
  icon: '<svg/>',
  keywords: ['widget', 'test'],
};

describe('ComponentRegistry — SDK register() contract', () => {
  let registry: ComponentRegistry;
  const cleanup: Array<{ dispose: () => void }> = [];

  beforeEach(() => {
    registry = freshRegistry();
    while (cleanup.length) cleanup.pop()!.dispose();
  });

  it('get(id) returns the registered component', () => {
    const handle = registry.register(DEF);
    cleanup.push(handle);
    const found = registry.get('sdk-test-widget');
    expect(found).toBeDefined();
    expect(found!.name).toBe('Test Widget');
  });

  it('maps SDK fields into ComponentMetadata shape', () => {
    cleanup.push(registry.register(DEF));
    const m = registry.get('sdk-test-widget')!;
    expect(m.tagName).toBe('velxio-test-widget');
    expect(m.pinCount).toBe(2);
    expect(m.category).toBe('basic');
    expect(m.thumbnail).toBe('<svg/>');
    expect(m.tags).toEqual(['widget', 'test']);
  });

  it('maps SDK enum → host select, and carries options as string values', () => {
    cleanup.push(registry.register(DEF));
    const m = registry.get('sdk-test-widget')!;
    const color = m.properties.find((p) => p.name === 'color')!;
    expect(color.type).toBe('select');
    expect(color.options).toEqual(['red', 'green']);
  });

  it('passes through number bounds on numeric properties', () => {
    cleanup.push(registry.register(DEF));
    const m = registry.get('sdk-test-widget')!;
    const r = m.properties.find((p) => p.name === 'resistance')!;
    expect(r.type).toBe('number');
    expect(r.min).toBe(1);
    expect(r.max).toBe(1_000_000);
  });

  it('extracts defaultValues from every property', () => {
    cleanup.push(registry.register(DEF));
    const m = registry.get('sdk-test-widget')!;
    expect(m.defaultValues).toEqual({ color: 'red', resistance: 1000 });
  });

  it('surfaces the registration in list() and getAllComponents()', () => {
    cleanup.push(registry.register(DEF));
    const ids = registry.list().map((c) => c.id);
    expect(ids).toContain('sdk-test-widget');
    const ids2 = registry.getAllComponents().map((c) => c.id);
    expect(ids2).toContain('sdk-test-widget');
  });

  it('makes the component discoverable through search()', () => {
    cleanup.push(registry.register(DEF));
    const hits = registry.search('widget');
    expect(hits.some((c) => c.id === 'sdk-test-widget')).toBe(true);
  });

  it('groups the component under its declared category', () => {
    cleanup.push(registry.register(DEF));
    // 'basic' is not part of the legacy host categories, so it just creates
    // an empty bucket on first use. The important invariant: the component
    // IS in that bucket.
    const bucket = registry.getByCategory('basic' as never);
    expect(bucket.some((c) => c.id === 'sdk-test-widget')).toBe(true);
  });

  it('dispose removes the plugin-added component and its search/category entries', () => {
    const handle = registry.register(DEF);
    expect(registry.get('sdk-test-widget')).toBeDefined();
    handle.dispose();
    expect(registry.get('sdk-test-widget')).toBeUndefined();
    expect(
      registry.getByCategory('basic' as never).some((c) => c.id === 'sdk-test-widget'),
    ).toBe(false);
    expect(registry.list().some((c) => c.id === 'sdk-test-widget')).toBe(false);
  });

  it('last-writer-wins when the same id is registered twice', () => {
    const first = registry.register(DEF);
    cleanup.push(first);
    const second = registry.register({
      ...DEF,
      name: 'Test Widget v2',
      keywords: ['v2'],
    });
    cleanup.push(second);
    const found = registry.get('sdk-test-widget')!;
    expect(found.name).toBe('Test Widget v2');
    expect(found.tags).toEqual(['v2']);
  });

  it('disposing an older handle does NOT clobber a newer registration', () => {
    const first = registry.register(DEF);
    registry.register({ ...DEF, name: 'Test Widget v2' });
    // Disposing the old handle should be a no-op because the slot now
    // belongs to v2.
    first.dispose();
    const found = registry.get('sdk-test-widget')!;
    expect(found.name).toBe('Test Widget v2');
    // Final cleanup
    cleanup.push({
      dispose: () => {
        // Manually remove the v2 entry — the dispose handle was discarded.
        const internal = registry as unknown as {
          metadata: Map<string, unknown>;
          allComponents: Array<{ id: string }>;
        };
        internal.metadata.delete('sdk-test-widget');
        internal.allComponents = internal.allComponents.filter(
          (c) => c.id !== 'sdk-test-widget',
        );
      },
    });
  });

  it('handles components with no properties gracefully', () => {
    const minimal: ComponentDefinition = {
      id: 'sdk-minimal-widget',
      name: 'Minimal',
      category: 'basic',
      element: 'velxio-minimal',
      description: '',
      pins: [{ name: '1', x: 0, y: 0 }],
    };
    cleanup.push(registry.register(minimal));
    const m = registry.get('sdk-minimal-widget')!;
    expect(m.properties).toEqual([]);
    expect(m.defaultValues).toEqual({});
    expect(m.tags).toEqual([]);
  });
});
