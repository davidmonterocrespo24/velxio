/**
 * SDK-side contract tests for `SpiceMapperContext.internalNode`.
 *
 * Runtime behaviour is provided by the host (NetlistBuilder mints the
 * closure per component). What the SDK promises is the *type shape* and
 * the fact that `defineSpiceMapper` accepts a mapper that consumes
 * `ctx.internalNode`. The integration test that proves uniqueness,
 * idempotency, sanitization and floating-pulldown lives in the host
 * (`frontend/src/__tests__/netlist-builder-internal-node.test.ts`).
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import { defineSpiceMapper } from '../src/index';
import type { SpiceMapper, SpiceMapperContext, SpiceEmission } from '../src/index';

describe('SpiceMapperContext.internalNode — SDK contract', () => {
  it('SpiceMapperContext exposes internalNode(suffix) → string', () => {
    expectTypeOf<SpiceMapperContext['internalNode']>().toBeFunction();
    expectTypeOf<SpiceMapperContext['internalNode']>()
      .parameter(0)
      .toEqualTypeOf<string>();
    expectTypeOf<SpiceMapperContext['internalNode']>().returns.toEqualTypeOf<string>();
  });

  it('a mapper that uses internalNode satisfies SpiceMapper', () => {
    // BJT-with-internal-tap example from the SDK doc comment.
    const bjt: SpiceMapper = (comp, netLookup, ctx) => {
      const c = netLookup('C');
      const e = netLookup('E');
      if (!c || !e) return null;
      const internal = ctx.internalNode('vbe_tap');
      return {
        cards: [
          `Q_${comp.id} ${c} ${internal} ${e} BJT_NPN`,
          `R_${comp.id}_base ${internal} 0 1k`,
        ],
        modelsUsed: new Set(['BJT_NPN']),
      };
    };
    expectTypeOf(bjt).toMatchTypeOf<SpiceMapper>();
  });

  it('defineSpiceMapper threads the SpiceMapperContext type through unchanged', () => {
    const mapper = defineSpiceMapper((comp, netLookup, ctx) => {
      const a = netLookup('1');
      if (!a) return null;
      // ctx is SpiceMapperContext at the call site — internalNode resolves.
      const tap: string = ctx.internalNode('alpha');
      return {
        cards: [`R_${comp.id} ${a} ${tap} 1k`],
        modelsUsed: new Set(),
      };
    });
    expectTypeOf(mapper).toEqualTypeOf<SpiceMapper>();
  });

  it('SpiceEmission shape stays a plain { cards, modelsUsed } object', () => {
    expectTypeOf<SpiceEmission>().toMatchTypeOf<{
      cards: ReadonlyArray<string>;
      modelsUsed: ReadonlySet<string>;
    }>();
  });

  it('mapper invocation is identity (no host wrapping at the SDK boundary)', () => {
    const fn: SpiceMapper = () => null;
    const wrapped = defineSpiceMapper(fn);
    expect(wrapped).toBe(fn);
  });
});
