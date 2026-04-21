/**
 * Ensures that circuitExamples (examples-circuits.ts) are merged into
 * exampleProjects so the /examples gallery and SSR prerender include them.
 */
import { describe, it, expect } from 'vitest';
import { exampleProjects } from '../data/examples';
import { circuitExamples } from '../data/examples-circuits';

describe('circuitExamples integration', () => {
  it('circuitExamples has at least 30 new examples', () => {
    expect(circuitExamples.length).toBeGreaterThanOrEqual(30);
  });

  it('every circuitExample id appears in exampleProjects', () => {
    const allIds = new Set(exampleProjects.map((e) => e.id));
    const missing = circuitExamples.map((e) => e.id).filter((id) => !allIds.has(id));
    expect(missing).toEqual([]);
  });

  it('no duplicate ids in exampleProjects', () => {
    const ids = exampleProjects.map((e) => e.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
  });

  it('all circuit examples use the circuits category', () => {
    const nonCircuits = circuitExamples.filter((e) => e.category !== 'circuits');
    expect(nonCircuits.map((e) => e.id)).toEqual([]);
  });

  it('every example has valid required fields', () => {
    for (const e of circuitExamples) {
      expect(e.id, `missing id: ${JSON.stringify(e)}`).toBeTypeOf('string');
      expect(e.title).toBeTypeOf('string');
      expect(e.description).toBeTypeOf('string');
      expect(e.category).toMatch(
        /^(basics|sensors|displays|communication|games|robotics|circuits)$/,
      );
      expect(e.difficulty).toMatch(/^(beginner|intermediate|advanced)$/);
      expect(e.code).toBeTypeOf('string');
      expect(Array.isArray(e.components)).toBe(true);
      expect(Array.isArray(e.wires)).toBe(true);
    }
  });
});
