/**
 * Schema + limit tests for the declarative SVG contribution shape.
 *
 * The schema is the worker-plugin trust boundary: a plugin that tries to
 * smuggle a `<script>` or an `onclick="…"` attribute through the
 * `CanvasOverlayDefinition.svg` path MUST be rejected with a typed
 * `InvalidSvgNodeError` before any rendering happens.
 */

import { describe, it, expect } from 'vitest';
import {
  ALLOWED_SVG_TAGS,
  InvalidSvgNodeError,
  MAX_SVG_ATTR_LENGTH,
  MAX_SVG_DEPTH,
  MAX_SVG_NODES,
  MAX_SVG_TEXT_LENGTH,
  getAllowedAttributes,
  getGlobalAttributes,
  validateSvgNode,
} from '../src/svg';
import { defineSvgOverlay } from '../src/ui';
import type { SvgNode } from '../src/svg';

const PID = 'test-plugin';

function makeDeepTree(depth: number): SvgNode {
  let node: SvgNode = { tag: 'g' };
  for (let i = 0; i < depth - 1; i++) {
    node = { tag: 'g', children: [node] };
  }
  return node;
}

describe('validateSvgNode — happy path', () => {
  it('accepts the minimum possible node (just tag)', () => {
    expect(() => validateSvgNode({ tag: 'g' }, PID)).not.toThrow();
  });

  it('accepts every allowlisted tag', () => {
    for (const tag of ALLOWED_SVG_TAGS) {
      expect(() => validateSvgNode({ tag }, PID)).not.toThrow();
    }
  });

  it('accepts numeric attributes on their allowed tags', () => {
    const node: SvgNode = {
      tag: 'rect',
      attrs: { x: 0, y: 0, width: 100, height: 50, rx: 4 },
    };
    expect(() => validateSvgNode(node, PID)).not.toThrow();
  });

  it('accepts global styling attributes on any tag', () => {
    for (const attr of getGlobalAttributes()) {
      const node: SvgNode = { tag: 'g', attrs: { [attr]: 'inherit' } };
      expect(() => validateSvgNode(node, PID)).not.toThrow();
    }
  });

  it('accepts data-* attributes on any tag', () => {
    const node: SvgNode = {
      tag: 'rect',
      attrs: { 'data-part-id': 'led-1', 'data-state': 'on' },
    };
    expect(() => validateSvgNode(node, PID)).not.toThrow();
  });

  it('accepts text children on <text> and <tspan>', () => {
    expect(() => validateSvgNode({ tag: 'text', text: 'hello' }, PID)).not.toThrow();
    expect(() => validateSvgNode({ tag: 'tspan', text: 'world' }, PID)).not.toThrow();
  });

  it('accepts <use href="#id">', () => {
    expect(() =>
      validateSvgNode({ tag: 'use', attrs: { href: '#gear' } }, PID),
    ).not.toThrow();
  });

  it('accepts a deeply nested tree up to the depth limit', () => {
    // root is depth 1, so MAX_SVG_DEPTH levels is fine
    expect(() => validateSvgNode(makeDeepTree(MAX_SVG_DEPTH), PID)).not.toThrow();
  });

  it('accepts a tree at exactly the node count limit', () => {
    const children: SvgNode[] = [];
    for (let i = 0; i < MAX_SVG_NODES - 1; i++) {
      children.push({ tag: 'circle', attrs: { r: 1 } });
    }
    expect(() => validateSvgNode({ tag: 'g', children }, PID)).not.toThrow();
  });
});

describe('validateSvgNode — rejects the obvious attacks', () => {
  it('rejects a <script> tag outright', () => {
    expect(() => validateSvgNode({ tag: 'script' as never }, PID))
      .toThrow(InvalidSvgNodeError);
  });

  it('rejects <foreignObject>', () => {
    expect(() => validateSvgNode({ tag: 'foreignObject' as never }, PID))
      .toThrow(InvalidSvgNodeError);
  });

  it('rejects <style>', () => {
    expect(() => validateSvgNode({ tag: 'style' as never }, PID))
      .toThrow(InvalidSvgNodeError);
  });

  it('rejects any on* attribute', () => {
    const attack: SvgNode = {
      tag: 'rect',
      attrs: { onclick: 'alert(1)' } as never,
    };
    expect(() => validateSvgNode(attack, PID)).toThrow(InvalidSvgNodeError);
  });

  it('rejects javascript: URIs in attribute values', () => {
    const attack: SvgNode = {
      tag: 'use',
      attrs: { href: 'javascript:alert(1)' } as never,
    };
    expect(() => validateSvgNode(attack, PID)).toThrow(InvalidSvgNodeError);
  });

  it('rejects data:text/html URIs in attribute values', () => {
    const attack: SvgNode = {
      tag: 'g',
      attrs: { fill: 'data:text/html,<script>alert(1)</script>' },
    };
    expect(() => validateSvgNode(attack, PID)).toThrow(InvalidSvgNodeError);
  });

  it('rejects <use href> that is not a #fragment', () => {
    const attack: SvgNode = {
      tag: 'use',
      attrs: { href: 'https://evil.example/hit' },
    };
    expect(() => validateSvgNode(attack, PID)).toThrow(InvalidSvgNodeError);
  });

  it('rejects `style` attribute (would bypass the per-tag allowlist)', () => {
    const attack: SvgNode = {
      tag: 'rect',
      attrs: { style: 'fill:red' } as never,
    };
    expect(() => validateSvgNode(attack, PID)).toThrow(InvalidSvgNodeError);
  });
});

describe('validateSvgNode — structural invariants', () => {
  it('rejects non-object nodes', () => {
    expect(() => validateSvgNode(null, PID)).toThrow(InvalidSvgNodeError);
    expect(() => validateSvgNode(42 as unknown, PID)).toThrow(InvalidSvgNodeError);
    expect(() => validateSvgNode('hi' as unknown, PID)).toThrow(InvalidSvgNodeError);
  });

  it('rejects a node with non-string tag', () => {
    expect(() => validateSvgNode({ tag: 42 } as unknown, PID))
      .toThrow(InvalidSvgNodeError);
  });

  it('rejects attrs that are arrays', () => {
    const bad = { tag: 'g', attrs: [] as unknown } as unknown;
    expect(() => validateSvgNode(bad, PID)).toThrow(InvalidSvgNodeError);
  });

  it('rejects attribute values with non-finite numbers', () => {
    const bad: SvgNode = {
      tag: 'rect',
      attrs: { x: Number.POSITIVE_INFINITY },
    };
    expect(() => validateSvgNode(bad, PID)).toThrow(InvalidSvgNodeError);
  });

  it('rejects attribute values whose type is neither string nor number', () => {
    const bad: SvgNode = {
      tag: 'rect',
      attrs: { x: true as unknown as number },
    };
    expect(() => validateSvgNode(bad, PID)).toThrow(InvalidSvgNodeError);
  });

  it('rejects attribute values exceeding MAX_SVG_ATTR_LENGTH', () => {
    const bad: SvgNode = {
      tag: 'path',
      attrs: { d: 'M'.repeat(MAX_SVG_ATTR_LENGTH + 1) },
    };
    expect(() => validateSvgNode(bad, PID)).toThrow(InvalidSvgNodeError);
  });

  it('rejects attributes not listed on the given tag', () => {
    // `cx` is valid on <circle> but not <rect>
    const bad: SvgNode = { tag: 'rect', attrs: { cx: 10 } as never };
    expect(() => validateSvgNode(bad, PID)).toThrow(InvalidSvgNodeError);
  });

  it('rejects non-string text', () => {
    const bad = { tag: 'text', text: 42 } as unknown;
    expect(() => validateSvgNode(bad, PID)).toThrow(InvalidSvgNodeError);
  });

  it('rejects text exceeding MAX_SVG_TEXT_LENGTH', () => {
    const bad: SvgNode = {
      tag: 'text',
      text: 'x'.repeat(MAX_SVG_TEXT_LENGTH + 1),
    };
    expect(() => validateSvgNode(bad, PID)).toThrow(InvalidSvgNodeError);
  });

  it('rejects mixing text and children', () => {
    const bad: SvgNode = {
      tag: 'text',
      text: 'hi',
      children: [{ tag: 'tspan' }],
    };
    expect(() => validateSvgNode(bad, PID)).toThrow(InvalidSvgNodeError);
  });

  it('rejects non-array children', () => {
    const bad = { tag: 'g', children: 'oops' } as unknown;
    expect(() => validateSvgNode(bad, PID)).toThrow(InvalidSvgNodeError);
  });
});

describe('validateSvgNode — size limits', () => {
  it('rejects depth beyond MAX_SVG_DEPTH', () => {
    expect(() => validateSvgNode(makeDeepTree(MAX_SVG_DEPTH + 1), PID))
      .toThrow(InvalidSvgNodeError);
  });

  it('rejects node count beyond MAX_SVG_NODES', () => {
    const children: SvgNode[] = [];
    for (let i = 0; i < MAX_SVG_NODES + 1; i++) {
      children.push({ tag: 'circle' });
    }
    expect(() => validateSvgNode({ tag: 'g', children }, PID))
      .toThrow(InvalidSvgNodeError);
  });
});

describe('InvalidSvgNodeError', () => {
  it('carries pluginId + reason and has the correct name', () => {
    try {
      validateSvgNode({ tag: 'script' } as unknown, PID);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidSvgNodeError);
      const e = err as InvalidSvgNodeError;
      expect(e.name).toBe('InvalidSvgNodeError');
      expect(e.pluginId).toBe(PID);
      expect(e.reason).toContain('script');
      expect(e.message).toContain(PID);
    }
  });
});

describe('defineSvgOverlay — identity helper', () => {
  it('returns the input verbatim with full type inference', () => {
    const input = {
      id: 'grid',
      zIndex: 5,
      svg: {
        tag: 'g' as const,
        children: [{ tag: 'line' as const, attrs: { x1: 0, y1: 0, x2: 10, y2: 10 } }],
      },
    };
    const result = defineSvgOverlay(input);
    expect(result).toBe(input);
  });
});

describe('getAllowedAttributes', () => {
  it('returns the per-tag allowlist', () => {
    expect(getAllowedAttributes('circle')).toContain('cx');
    expect(getAllowedAttributes('circle')).toContain('cy');
    expect(getAllowedAttributes('circle')).toContain('r');
    expect(getAllowedAttributes('circle')).not.toContain('width');
  });
});
