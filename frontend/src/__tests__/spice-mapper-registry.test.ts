/**
 * Contract tests for SpiceMapperRegistry.
 *
 * Covers the SDK-contract surface:
 *   - register/dispose (last-writer-wins semantics)
 *   - alias
 *   - unregister
 *   - lookup (O(1) hot path)
 *   - has/list/size
 *   - asSdkMapper adapter
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SpiceMapperRegistry,
  type HostSpiceMapper,
  asSdkMapper,
} from '../simulation/spice/SpiceMapperRegistry';
import type { SpiceEmission, SpiceNetLookup } from '@velxio/sdk';
import type { ComponentForSpice } from '../simulation/spice/types';
import type { MapperContext } from '../simulation/spice/componentToSpice';

function makeComp(id = 'c1', metadataId = 'resistor'): ComponentForSpice {
  return {
    id,
    metadataId,
    properties: {},
  };
}

function makeNetLookup(): SpiceNetLookup {
  return () => '0';
}

const CTX: MapperContext = { vcc: 5 };

const emissionA: SpiceEmission = {
  cards: ['R_A 1 2 1k'],
  modelsUsed: new Set(),
};
const emissionB: SpiceEmission = {
  cards: ['R_B 1 2 2k'],
  modelsUsed: new Set(),
};

const mapperA: HostSpiceMapper = () => emissionA;
const mapperB: HostSpiceMapper = () => emissionB;

describe('SpiceMapperRegistry', () => {
  let registry: SpiceMapperRegistry;

  beforeEach(() => {
    registry = new SpiceMapperRegistry();
  });

  describe('register / lookup', () => {
    it('stores a mapper and returns it via lookup', () => {
      registry.register('resistor', mapperA);
      expect(registry.lookup('resistor')).toBe(mapperA);
    });

    it('invokes the stored mapper with the right arguments', () => {
      let received: [ComponentForSpice, SpiceNetLookup, MapperContext] | null = null;
      const spy: HostSpiceMapper = (comp, lookup, ctx) => {
        received = [comp, lookup, ctx];
        return emissionA;
      };
      registry.register('led', spy);
      const comp = makeComp('led1', 'led');
      const lookup = makeNetLookup();
      const result = registry.lookup('led')!(comp, lookup, CTX);
      expect(result).toBe(emissionA);
      expect(received![0]).toBe(comp);
      expect(received![1]).toBe(lookup);
      expect(received![2]).toBe(CTX);
    });

    it('returns undefined for unknown ids', () => {
      expect(registry.lookup('nope')).toBeUndefined();
    });

    it('last-writer-wins when the same id is registered twice', () => {
      registry.register('resistor', mapperA);
      registry.register('resistor', mapperB);
      expect(registry.lookup('resistor')).toBe(mapperB);
    });
  });

  describe('dispose handle', () => {
    it('restores the previous mapper when disposed after an override', () => {
      registry.register('resistor', mapperA);
      const handle = registry.register('resistor', mapperB);
      expect(registry.lookup('resistor')).toBe(mapperB);
      handle.dispose();
      expect(registry.lookup('resistor')).toBe(mapperA);
    });

    it('removes the mapper when disposed without a previous entry', () => {
      const handle = registry.register('resistor', mapperA);
      handle.dispose();
      expect(registry.lookup('resistor')).toBeUndefined();
      expect(registry.has('resistor')).toBe(false);
    });

    it('is idempotent — disposing twice is a no-op after the first call', () => {
      const handle = registry.register('resistor', mapperA);
      handle.dispose();
      expect(() => handle.dispose()).not.toThrow();
      expect(registry.has('resistor')).toBe(false);
    });

    it('does not clobber a newer registration (slot ownership check)', () => {
      // A → register → handleA
      const handleA = registry.register('resistor', mapperA);
      // B → register → handleB (wins the slot)
      registry.register('resistor', mapperB);
      // Disposing the older handleA must NOT touch mapperB.
      handleA.dispose();
      expect(registry.lookup('resistor')).toBe(mapperB);
    });
  });

  describe('alias', () => {
    it('creates a new id pointing at the same mapper', () => {
      registry.register('resistor', mapperA);
      const aliasHandle = registry.alias('resistor-us', 'resistor');
      expect(aliasHandle).not.toBeNull();
      expect(registry.lookup('resistor-us')).toBe(mapperA);
    });

    it('returns null when the base id is missing', () => {
      expect(registry.alias('resistor-us', 'resistor')).toBeNull();
    });

    it('alias handle disposes independently from the base', () => {
      registry.register('resistor', mapperA);
      const aliasHandle = registry.alias('resistor-us', 'resistor')!;
      aliasHandle.dispose();
      expect(registry.has('resistor-us')).toBe(false);
      expect(registry.has('resistor')).toBe(true);
    });
  });

  describe('unregister', () => {
    it('returns true when an id is removed', () => {
      registry.register('resistor', mapperA);
      expect(registry.unregister('resistor')).toBe(true);
      expect(registry.has('resistor')).toBe(false);
    });

    it('returns false when the id is not registered', () => {
      expect(registry.unregister('nope')).toBe(false);
    });
  });

  describe('has / list / size', () => {
    it('has() reflects registration state', () => {
      expect(registry.has('resistor')).toBe(false);
      registry.register('resistor', mapperA);
      expect(registry.has('resistor')).toBe(true);
    });

    it('list() returns a sorted copy of every id', () => {
      registry.register('zener', mapperA);
      registry.register('diode', mapperA);
      registry.register('led', mapperA);
      expect(registry.list()).toEqual(['diode', 'led', 'zener']);
    });

    it('size() matches the number of registered mappers', () => {
      expect(registry.size()).toBe(0);
      registry.register('a', mapperA);
      registry.register('b', mapperB);
      expect(registry.size()).toBe(2);
    });

    it('__clearForTests() drops every mapping', () => {
      registry.register('a', mapperA);
      registry.register('b', mapperB);
      registry.__clearForTests();
      expect(registry.size()).toBe(0);
    });
  });
});

describe('asSdkMapper', () => {
  it('lets host mappers satisfy the SDK SpiceMapper shape', () => {
    const host: HostSpiceMapper = (comp, lookup, ctx) => ({
      cards: [`R_${comp.id} a b ${ctx.vcc}k`],
      modelsUsed: new Set(),
    });
    const sdk = asSdkMapper(host);
    const result = sdk(
      { id: 'r1', metadataId: 'resistor', properties: {} },
      () => '0',
      { vcc: 9, analysis: { kind: 'op' } },
    );
    expect(result).not.toBeNull();
    expect(result!.cards).toEqual(['R_r1 a b 9k']);
  });
});
