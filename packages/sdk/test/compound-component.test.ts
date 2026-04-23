/**
 * Tests for `defineCompoundComponent` (SDK-003b step 1).
 *
 * The helper is identity-only at runtime — it returns the literal
 * unchanged. The real value is type inference, which Vitest cannot
 * assert directly. We pin the runtime contract (identity, structural
 * shape) here and rely on `expectTypeOf` for the type surface.
 */
import { describe, expect, it, expectTypeOf } from 'vitest';
import {
  defineCompoundComponent,
  defineComponent,
  definePartSimulation,
  defineSpiceMapper,
} from '../src/index';
import type {
  CompoundComponentDefinition,
  ComponentDefinition,
  PartSimulation,
  SpiceMapper,
} from '../src/index';

const baseFields = {
  id: 'test.led',
  name: 'Test LED',
  category: 'basic' as const,
  description: 'A test LED',
  element: 'wokwi-led',
  pins: [
    { name: 'A', x: 0, y: 0, signal: 'gpio' as const },
    { name: 'C', x: 0, y: 10, signal: 'power-gnd' as const },
  ],
};

describe('defineCompoundComponent', () => {
  it('returns the same object reference (identity helper)', () => {
    const literal = { ...baseFields };
    const result = defineCompoundComponent(literal);
    expect(result).toBe(literal);
  });

  it('accepts a picker-only shape (no simulation, no spice)', () => {
    const def = defineCompoundComponent({ ...baseFields });
    expect(def.simulation).toBeUndefined();
    expect(def.spice).toBeUndefined();
    expect(def.spiceModels).toBeUndefined();
    // Structurally still a ComponentDefinition.
    expectTypeOf(def).toMatchTypeOf<ComponentDefinition>();
  });

  it('accepts a + simulation shape', () => {
    const sim = definePartSimulation({
      onPinStateChange() {
        /* no-op */
      },
    });
    const def = defineCompoundComponent({ ...baseFields, simulation: sim });
    expect(def.simulation).toBe(sim);
    expect(def.spice).toBeUndefined();
  });

  it('accepts a + spice mapper shape', () => {
    const mapper = defineSpiceMapper(() => null);
    const def = defineCompoundComponent({ ...baseFields, spice: mapper });
    expect(def.spice).toBe(mapper);
  });

  it('accepts the full shape: + simulation + spice + spiceModels', () => {
    const sim = definePartSimulation({
      attachEvents: () => () => {},
    });
    const mapper = defineSpiceMapper((comp, netLookup) => {
      const a = netLookup('A');
      if (!a) return null;
      return { cards: [`R_${comp.id} ${a} 0 1k`], modelsUsed: new Set() };
    });
    const def = defineCompoundComponent({
      ...baseFields,
      simulation: sim,
      spice: mapper,
      spiceModels: [
        { name: 'D_TEST', card: '.model D_TEST D (IS=1e-14)' },
        { name: 'BJT_TEST', card: '.model BJT_TEST NPN (BF=100)' },
      ],
    });
    expect(def.simulation).toBe(sim);
    expect(def.spice).toBe(mapper);
    expect(def.spiceModels).toHaveLength(2);
    expect(def.spiceModels![0].name).toBe('D_TEST');
  });

  it('preserves narrow literal types via the generic parameter', () => {
    const def = defineCompoundComponent({
      ...baseFields,
      id: 'narrow.id' as const,
    });
    // The id should be the narrowed literal, not widened to `string`.
    expectTypeOf(def.id).toEqualTypeOf<'narrow.id'>();
  });

  it('a CompoundComponentDefinition is assignable to ComponentDefinition', () => {
    // The host treats any compound as a regular ComponentDefinition for
    // the picker — this assignability protects that contract.
    const def: CompoundComponentDefinition = defineCompoundComponent({
      ...baseFields,
    });
    const asBase: ComponentDefinition = def;
    expect(asBase.id).toBe(baseFields.id);
  });

  it('propagates simulation and spice types through CompoundComponentDefinition', () => {
    expectTypeOf<CompoundComponentDefinition['simulation']>().toEqualTypeOf<
      PartSimulation | undefined
    >();
    expectTypeOf<CompoundComponentDefinition['spice']>().toEqualTypeOf<
      SpiceMapper | undefined
    >();
  });

  it('round-trips through defineComponent for picker-only authoring (back-compat)', () => {
    // Authors who already use `defineComponent` should be able to wrap the
    // result with `defineCompoundComponent` without re-typing fields.
    const base = defineComponent(baseFields);
    const compound = defineCompoundComponent(base);
    expect(compound.id).toBe(base.id);
    expect(compound.pins).toBe(base.pins);
  });
});
