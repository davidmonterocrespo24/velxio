// @vitest-environment jsdom
/**
 * Every label in the static component SVGs has a font size of its own
 * (velxio/velxio-prod#112).
 *
 * public/component-svgs/*.svg are standalone files: the fallback thumbnail of
 * an example (CircuitPreview), and art the docs and the book reuse. The
 * potentiometer's GND / SIG / VCC labels took their size and colour from the
 * element's CSS (`svg text { font-size: 1px; fill: #ffffff }` in
 * wokwi-elements' potentiometer-element), which the static export did not
 * carry. A standalone renderer then drew them black at its 16 px default in a
 * 20-unit viewBox: a black blob over the knob and the right edge (4,993 dark
 * pixels at 228 px in cairosvg, 175 with the two attributes).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = resolve(process.cwd(), 'public/component-svgs');

/** The value of `prop` set on `el` by attribute or inline style, or null. */
function own(el: Element, prop: string): string | null {
  const attr = el.getAttribute(prop);
  if (attr) return attr;
  const style = el.getAttribute('style') ?? '';
  const m = style.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
  return m ? m[1].trim() : null;
}

/** True when `prop` reaches `text` from itself, an ancestor, every tspan in
 *  it, or a <style> block of the document that names it. */
function styled(doc: Document, text: Element, prop: string): boolean {
  for (let el: Element | null = text; el; el = el.parentElement) if (own(el, prop)) return true;
  const spans = [...text.getElementsByTagName('tspan')];
  if (spans.length > 0 && spans.every((s) => own(s, prop))) return true;
  return [...doc.getElementsByTagName('style')].some((s) => (s.textContent ?? '').includes(prop));
}

describe('static component SVG labels (velxio/velxio-prod#112)', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.svg'));

  it('finds the SVGs', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain('potentiometer.svg');
  });

  it('no <text> falls back to the renderer default font size', () => {
    const unsized: string[] = [];
    for (const f of files) {
      const doc = new DOMParser().parseFromString(readFileSync(resolve(DIR, f), 'utf-8'), 'image/svg+xml');
      for (const t of [...doc.getElementsByTagName('text')]) {
        if ((t.textContent ?? '').trim() && !styled(doc, t, 'font-size')) unsized.push(`${f}: ${t.textContent}`);
      }
    }
    expect(unsized).toEqual([]);
  });

  it('the potentiometer labels are the element\'s: 1 unit high, white', () => {
    const doc = new DOMParser().parseFromString(
      readFileSync(resolve(DIR, 'potentiometer.svg'), 'utf-8'),
      'image/svg+xml',
    );
    const labels = [...doc.getElementsByTagName('text')];
    expect(labels.map((t) => t.textContent)).toEqual(['GND', 'SIG', 'VCC']);
    for (const t of labels) {
      let size: string | null = null;
      let fill: string | null = null;
      for (let el: Element | null = t; el; el = el.parentElement) {
        size ??= own(el, 'font-size');
        fill ??= own(el, 'fill');
      }
      expect(parseFloat(size ?? 'NaN')).toBe(1);
      expect((fill ?? '').toLowerCase()).toMatch(/^#fff(fff)?$/);
    }
  });
});
