/**
 * Fixed wire routes of gallery examples (utils/exampleWireRoutes.ts): an
 * entry applies only to the layout it was made for.
 */
import { describe, it, expect } from 'vitest';
import type { ExampleProject } from '../data/examples';
import {
  cornersFromEntry,
  exampleLayoutKey,
  exampleWireCorners,
  registerExampleWireRoutes,
} from '../utils/exampleWireRoutes';
import table from '../data/example-wire-routes';

const example = {
  id: 'probe',
  title: 'probe',
  description: '',
  category: 'basics',
  difficulty: 'beginner',
  code: 'void setup() {}\nvoid loop() {}\n',
  components: [{ type: 'wokwi-led', id: 'led', x: 300, y: 100, properties: { color: 'red' } }],
  wires: [
    { id: 'w1', start: { componentId: 'arduino-uno', pinName: '13' }, end: { componentId: 'led', pinName: 'A' }, color: '#0f0' },
    { id: 'w2', start: { componentId: 'led', pinName: 'C' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000' },
  ],
} as unknown as ExampleProject;

describe('exampleWireRoutes', () => {
  const entry = { key: exampleLayoutKey(example), wires: [[10, 20, 30, 20], []] };

  it('unflattens the corners in wire order; an empty list leaves that wire alone', () => {
    expect(cornersFromEntry(example, entry)).toEqual([
      [
        { x: 10, y: 20 },
        { x: 30, y: 20 },
      ],
      undefined,
    ]);
  });

  it('the key ignores code and text, so editing a sketch keeps the routes', () => {
    const edited = { ...example, code: 'void setup() { pinMode(13, OUTPUT); }', title: 'x' } as ExampleProject;
    expect(cornersFromEntry(edited, entry)).not.toBeNull();
  });

  it('a moved part, a changed property, or a rewired end voids the entry', () => {
    const moved = { ...example, components: [{ ...example.components[0], x: 310 }] } as ExampleProject;
    const recoloured = {
      ...example,
      components: [{ ...example.components[0], properties: { color: 'blue' } }],
    } as ExampleProject;
    const rewired = {
      ...example,
      wires: [{ ...example.wires[0], start: { componentId: 'arduino-uno', pinName: '12' } }, example.wires[1]],
    } as ExampleProject;
    for (const e of [moved, recoloured, rewired]) expect(cornersFromEntry(e, entry)).toBeNull();
  });

  it('no entry, or a wire count that does not match, applies nothing', () => {
    expect(cornersFromEntry(example, undefined)).toBeNull();
    expect(cornersFromEntry(example, { ...entry, wires: [[1, 2]] })).toBeNull();
  });

  it('every stored entry is well formed', () => {
    for (const [id, e] of Object.entries(table.examples)) {
      expect(e.key, id).toMatch(/^[0-9a-f]{8}$/);
      for (const w of e.wires) {
        expect(w.length % 2, id).toBe(0);
        expect(w.every((v) => Number.isFinite(v)), id).toBe(true);
      }
    }
  });

  it('an overlay table registered later is read on the next open', async () => {
    expect(await exampleWireCorners(example)).toBeNull();
    registerExampleWireRoutes(async () => ({ examples: { probe: entry } }));
    expect(await exampleWireCorners(example)).toEqual(cornersFromEntry(example, entry));
  });

  it('a table that fails to load costs nothing but its own corners', async () => {
    registerExampleWireRoutes(async () => {
      throw new Error('chunk failed');
    });
    expect(await exampleWireCorners(example)).toEqual(cornersFromEntry(example, entry));
  });
});
