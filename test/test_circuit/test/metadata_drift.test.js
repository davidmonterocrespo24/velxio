import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Metadata drift detector.
 *
 * Verifies that every component declared in `scripts/component-overrides.json`
 * under `_customComponents[]` is also present in
 * `frontend/public/components-metadata.json`.
 *
 * If this test fails, run `npm run generate:metadata` in the frontend folder
 * (or whatever equivalent your build uses) to refresh the JSON. The committed
 * metadata.json must always contain the latest custom components so that the
 * picker works in production builds that skip the generator step.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OVERRIDES_PATH = resolve(ROOT, 'scripts/component-overrides.json');
const METADATA_PATH = resolve(ROOT, 'frontend/public/components-metadata.json');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('component-overrides → components-metadata drift detector', () => {
  const overrides = readJson(OVERRIDES_PATH);
  const metadata = readJson(METADATA_PATH);
  const custom = overrides._customComponents ?? [];
  const metadataIds = new Set(metadata.components.map(c => c.id));

  it('overrides file declares at least one custom component', () => {
    expect(custom.length).toBeGreaterThan(0);
  });

  it('every _customComponents entry has the required fields', () => {
    for (const c of custom) {
      expect(c.id, `custom component missing 'id': ${JSON.stringify(c)}`).toBeTypeOf('string');
      expect(c.tagName, `${c.id} missing 'tagName'`).toBeTypeOf('string');
      expect(c.name, `${c.id} missing 'name'`).toBeTypeOf('string');
      expect(c.category, `${c.id} missing 'category'`).toBeTypeOf('string');
      expect(c.pinCount, `${c.id} missing 'pinCount'`).toBeTypeOf('number');
      expect(Array.isArray(c.tags), `${c.id} tags must be an array`).toBe(true);
    }
  });

  it('every _customComponents id is present in components-metadata.json', () => {
    const missing = custom
      .map(c => c.id)
      .filter(id => !metadataIds.has(id));
    expect(
      missing,
      `Stale metadata. Run 'npm run generate:metadata'. Missing: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every _customComponents entry is reflected faithfully in metadata', () => {
    for (const c of custom) {
      const meta = metadata.components.find(m => m.id === c.id);
      expect(meta, `${c.id} missing in metadata`).toBeDefined();
      expect(meta.tagName, `${c.id}: tagName drift`).toBe(c.tagName);
      expect(meta.category, `${c.id}: category drift`).toBe(c.category);
      expect(meta.pinCount, `${c.id}: pinCount drift`).toBe(c.pinCount);
    }
  });

  it('all _customComponents tagNames are unique (no collisions)', () => {
    const tagNames = custom.map(c => c.tagName);
    const dupes = tagNames.filter((t, i) => tagNames.indexOf(t) !== i);
    expect(dupes, `Duplicate tagNames: ${dupes.join(', ')}`).toEqual([]);
  });

  it('all _customComponents ids are unique', () => {
    const ids = custom.map(c => c.id);
    const dupes = ids.filter((t, i) => ids.indexOf(t) !== i);
    expect(dupes, `Duplicate ids: ${dupes.join(', ')}`).toEqual([]);
  });
});
