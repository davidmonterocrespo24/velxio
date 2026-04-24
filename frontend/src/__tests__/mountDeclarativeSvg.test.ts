// @vitest-environment jsdom
/**
 * `mountDeclarativeSvg` — unit tests for the worker-safe SVG renderer.
 *
 * The function is the main-thread counterpart of `CanvasOverlayDefinition.svg`.
 * It must:
 *   1. Build an SVG tree via `createElementNS`, not `innerHTML`.
 *   2. Apply only allowlisted attributes (ignored: `style`, `on*`).
 *   3. Reject malformed trees with `InvalidSvgNodeError`.
 *   4. Support idempotent `dispose()`.
 */
import { describe, it, expect } from 'vitest';
import { InvalidSvgNodeError, type SvgNode } from '@velxio/sdk';

import { mountDeclarativeSvg } from '../plugin-host/mountDeclarativeSvg';

const SVG_NS = 'http://www.w3.org/2000/svg';

function makeRoot(): SVGElement {
  return document.createElementNS(SVG_NS, 'g') as SVGElement;
}

describe('mountDeclarativeSvg — happy path', () => {
  it('builds a single-node tree with allowlisted attributes', () => {
    const root = makeRoot();
    const handle = mountDeclarativeSvg(
      root,
      { tag: 'rect', attrs: { x: 0, y: 0, width: 10, height: 20, fill: 'red' } },
      'test',
    );
    const rect = root.firstElementChild as SVGElement;
    expect(rect).not.toBeNull();
    expect(rect.namespaceURI).toBe(SVG_NS);
    expect(rect.tagName.toLowerCase()).toBe('rect');
    expect(rect.getAttribute('x')).toBe('0');
    expect(rect.getAttribute('width')).toBe('10');
    expect(rect.getAttribute('fill')).toBe('red');
    expect(handle.element).toBe(rect);
  });

  it('builds a nested tree in document order', () => {
    const root = makeRoot();
    mountDeclarativeSvg(
      root,
      {
        tag: 'g',
        attrs: { id: 'wrap' },
        children: [
          { tag: 'circle', attrs: { cx: 5, cy: 5, r: 2 } },
          { tag: 'circle', attrs: { cx: 15, cy: 15, r: 3 } },
        ],
      },
      'test',
    );
    const g = root.firstElementChild as SVGElement;
    expect(g.tagName.toLowerCase()).toBe('g');
    expect(g.getAttribute('id')).toBe('wrap');
    expect(g.children.length).toBe(2);
    expect(g.children[0].tagName.toLowerCase()).toBe('circle');
    expect((g.children[0] as SVGElement).getAttribute('cx')).toBe('5');
    expect((g.children[1] as SVGElement).getAttribute('cx')).toBe('15');
  });

  it('renders text content', () => {
    const root = makeRoot();
    mountDeclarativeSvg(
      root,
      { tag: 'text', attrs: { x: 0, y: 0 }, text: 'hello world' },
      'test',
    );
    const text = root.firstElementChild as SVGElement;
    expect(text.textContent).toBe('hello world');
  });

  it('dispose removes the mounted element', () => {
    const root = makeRoot();
    const handle = mountDeclarativeSvg(
      root,
      { tag: 'circle', attrs: { cx: 0, cy: 0, r: 1 } },
      'test',
    );
    expect(root.children.length).toBe(1);
    handle.dispose();
    expect(root.children.length).toBe(0);
  });

  it('dispose is idempotent', () => {
    const root = makeRoot();
    const handle = mountDeclarativeSvg(
      root,
      { tag: 'g' },
      'test',
    );
    handle.dispose();
    expect(() => handle.dispose()).not.toThrow();
    expect(root.children.length).toBe(0);
  });
});

describe('mountDeclarativeSvg — rejects malformed trees', () => {
  it('rejects a node with a forbidden tag', () => {
    const root = makeRoot();
    expect(() =>
      mountDeclarativeSvg(root, { tag: 'script' } as unknown as SvgNode, 'test'),
    ).toThrow(InvalidSvgNodeError);
    // Nothing was appended.
    expect(root.children.length).toBe(0);
  });

  it('rejects an on* event attribute', () => {
    const root = makeRoot();
    expect(() =>
      mountDeclarativeSvg(
        root,
        { tag: 'rect', attrs: { onclick: 'alert(1)' } } as unknown as SvgNode,
        'test',
      ),
    ).toThrow(InvalidSvgNodeError);
    expect(root.children.length).toBe(0);
  });

  it('rejects javascript: in a href attribute', () => {
    const root = makeRoot();
    expect(() =>
      mountDeclarativeSvg(
        root,
        { tag: 'use', attrs: { href: 'javascript:alert(1)' } } as unknown as SvgNode,
        'test',
      ),
    ).toThrow(InvalidSvgNodeError);
    expect(root.children.length).toBe(0);
  });
});

describe('mountDeclarativeSvg — never injects through innerHTML', () => {
  it('stores literal text via textContent so markup is not parsed', () => {
    const root = makeRoot();
    mountDeclarativeSvg(
      root,
      { tag: 'text', attrs: { x: 0, y: 0 }, text: '<script>alert(1)</script>' },
      'test',
    );
    const text = root.firstElementChild as SVGElement;
    expect(text.children.length).toBe(0);
    expect(text.textContent).toContain('<script>');
  });
});
