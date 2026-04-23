/**
 * canonicalJsonStringify must produce stable bytes regardless of key
 * insertion order — that is the entire reason it exists. These tests
 * lock the contract.
 */
import { describe, expect, it } from 'vitest';

import { canonicalJsonStringify } from '../plugins/license/canonicalize';

describe('canonicalJsonStringify', () => {
  it('sorts object keys lexicographically', () => {
    const a = { b: 1, a: 2, c: 3 };
    const b = { c: 3, a: 2, b: 1 };
    expect(canonicalJsonStringify(a)).toBe('{"a":2,"b":1,"c":3}');
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
  });

  it('preserves array order', () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('omits undefined properties', () => {
    expect(canonicalJsonStringify({ a: 1, b: undefined, c: 2 })).toBe('{"a":1,"c":2}');
  });

  it('encodes nested objects with sorted keys at every level', () => {
    expect(
      canonicalJsonStringify({ outer: { z: 1, a: { y: 2, b: 3 } } }),
    ).toBe('{"outer":{"a":{"b":3,"y":2},"z":1}}');
  });

  it('handles primitives like JSON.stringify', () => {
    expect(canonicalJsonStringify('hello')).toBe('"hello"');
    expect(canonicalJsonStringify(42)).toBe('42');
    expect(canonicalJsonStringify(true)).toBe('true');
    expect(canonicalJsonStringify(null)).toBe('null');
  });

  it('throws on non-finite numbers', () => {
    expect(() => canonicalJsonStringify(NaN)).toThrow();
    expect(() => canonicalJsonStringify(Infinity)).toThrow();
  });

  it('throws on unsupported types', () => {
    expect(() => canonicalJsonStringify(() => 1)).toThrow();
    expect(() => canonicalJsonStringify(BigInt(1) as unknown)).toThrow();
  });
});
