/**
 * The canvas must let a press through to every part that handles its own.
 *
 * DynamicComponent stops mousedown in the capture phase unless the part's tag
 * is in OWN_POINTER_TAGS. A wokwi element that binds its own mouse, pointer or
 * touch handler and is missing from that list looks alive on the canvas and
 * ignores every press. The IR remote shipped that way: its keys never fired
 * `button-press`, so the IR gallery examples received nothing.
 *
 * This reads the element sources out of the installed @wokwi/elements, so a
 * library bump that adds an interactive part fails here instead of in a
 * user's hands.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { OWN_POINTER_TAGS, tagOwnsPointer } from '../utils/partOwnsPointer';

/** Boards render through BoardOnCanvas, not the DynamicComponent wrapper, so
 *  their reset buttons are not this list's business. */
const BOARDS = new Set([
  'wokwi-arduino-uno',
  'wokwi-arduino-mega',
  'wokwi-arduino-nano',
  'wokwi-franzininho',
]);

const OWN_HANDLER =
  /@(mousedown|pointerdown|touchstart)=|addEventListener\(\s*['"](mousedown|pointerdown|touchstart)['"]/;

function elementsWithOwnHandlers(): string[] {
  const require = createRequire(import.meta.url);
  const esm = join(dirname(require.resolve('@wokwi/elements/package.json')), 'dist', 'esm');
  const tags: string[] = [];
  for (const f of readdirSync(esm)) {
    if (!f.endsWith('-element.js')) continue;
    const src = readFileSync(join(esm, f), 'utf8');
    const tag = src.match(/customElement\(\s*['"]([a-z0-9-]+)['"]\s*\)/)?.[1];
    if (tag && OWN_HANDLER.test(src)) tags.push(tag);
  }
  return tags.sort();
}

describe('parts that own their pointer while the simulation runs', () => {
  it('finds the interactive elements in the installed library', () => {
    // A guard on the scan itself: if the dist layout changes and nothing
    // matches, the next test would pass on an empty list.
    const found = elementsWithOwnHandlers();
    expect(found).toContain('wokwi-pushbutton');
    expect(found).toContain('wokwi-membrane-keypad');
    expect(found).toContain('wokwi-ir-remote');
  });

  it('lets every wokwi part with its own press handler receive the press', () => {
    const missing = elementsWithOwnHandlers().filter(
      (tag) => !BOARDS.has(tag) && !OWN_POINTER_TAGS.has(tag),
    );
    expect(missing).toEqual([]);
  });

  it('lets the IR remote keys through, so a press transmits', () => {
    expect(tagOwnsPointer('wokwi-ir-remote')).toBe(true);
    expect(tagOwnsPointer('WOKWI-IR-REMOTE')).toBe(true);
  });

  it('keeps parts without a press handler on the canvas path', () => {
    // These have attachEvents but no pointer handler: a click must still
    // open their sensor panel or property dialog.
    for (const tag of ['wokwi-dht22', 'wokwi-led', 'wokwi-ir-receiver', 'wokwi-hc-sr04']) {
      expect(tagOwnsPointer(tag)).toBe(false);
    }
  });
});
