/**
 * Tests for the in-house semver-range subset used by the license
 * verifier. Covers exact / caret / tilde / wildcard plus the npm-style
 * 0.x special cases, since those are the easiest to get wrong.
 */
import { describe, expect, it } from 'vitest';

import { parseVersion, satisfies } from '../plugins/license/semver';

describe('parseVersion', () => {
  it('parses normal triplets', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion('0.0.0')).toEqual({ major: 0, minor: 0, patch: 0 });
  });

  it('rejects pre-release / build metadata', () => {
    expect(parseVersion('1.2.3-rc.1')).toBeNull();
    expect(parseVersion('1.2.3+build')).toBeNull();
  });

  it('rejects malformed versions', () => {
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('not.a.version')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });
});

describe('satisfies — exact', () => {
  it('matches identical versions', () => {
    expect(satisfies('1.2.3', '1.2.3')).toBe(true);
    expect(satisfies('1.2.3', '=1.2.3')).toBe(true);
  });

  it('rejects different versions', () => {
    expect(satisfies('1.2.4', '1.2.3')).toBe(false);
    expect(satisfies('2.0.0', '1.2.3')).toBe(false);
  });
});

describe('satisfies — caret', () => {
  it('locks major when major > 0', () => {
    expect(satisfies('1.2.3', '^1.0.0')).toBe(true);
    expect(satisfies('1.99.99', '^1.0.0')).toBe(true);
    expect(satisfies('2.0.0', '^1.0.0')).toBe(false);
    expect(satisfies('0.99.99', '^1.0.0')).toBe(false);
  });

  it('rejects versions below the floor', () => {
    expect(satisfies('1.2.2', '^1.2.3')).toBe(false);
  });

  it('locks minor when major is 0 and minor > 0 (npm semantics)', () => {
    expect(satisfies('0.2.99', '^0.2.0')).toBe(true);
    expect(satisfies('0.3.0', '^0.2.0')).toBe(false);
    expect(satisfies('0.1.99', '^0.2.0')).toBe(false);
  });

  it('locks patch when major and minor are both 0', () => {
    expect(satisfies('0.0.3', '^0.0.3')).toBe(true);
    expect(satisfies('0.0.4', '^0.0.3')).toBe(false);
  });
});

describe('satisfies — tilde', () => {
  it('locks minor', () => {
    expect(satisfies('1.2.3', '~1.2.0')).toBe(true);
    expect(satisfies('1.2.99', '~1.2.0')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.0')).toBe(false);
  });
});

describe('satisfies — wildcard', () => {
  it('matches any version with *', () => {
    expect(satisfies('99.0.0', '*')).toBe(true);
    expect(satisfies('0.0.1', '*')).toBe(true);
  });

  it('locks major with N.x', () => {
    expect(satisfies('1.99.99', '1.x')).toBe(true);
    expect(satisfies('2.0.0', '1.x')).toBe(false);
  });

  it('locks major+minor with N.M.x', () => {
    expect(satisfies('1.2.99', '1.2.x')).toBe(true);
    expect(satisfies('1.3.0', '1.2.x')).toBe(false);
  });
});

describe('satisfies — defensive', () => {
  it('returns false on malformed range', () => {
    expect(satisfies('1.2.3', 'not-a-range')).toBe(false);
    expect(satisfies('1.2.3', '^abc')).toBe(false);
  });

  it('returns false on malformed version (caller should handle)', () => {
    expect(satisfies('not.a.version', '^1.0.0')).toBe(false);
  });
});
