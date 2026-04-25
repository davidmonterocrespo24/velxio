/**
 * Schema + limit tests for the declarative panel layout shape.
 *
 * The schema is the worker-plugin trust boundary for `panels.register`: a
 * plugin that tries to smuggle a `<script>` or an `onclick="…"` attribute
 * through `PanelDefinition.layout` MUST be rejected with a typed
 * `InvalidPanelLayoutError` before any rendering happens.
 */

import { describe, it, expect } from 'vitest';
import {
  ALLOWED_PANEL_TAGS,
  BOOLEAN_ATTRS,
  BUTTON_TYPE_ALLOWLIST,
  INPUT_TYPE_ALLOWLIST,
  InvalidPanelLayoutError,
  MAX_PANEL_ATTR_LENGTH,
  MAX_PANEL_DEPTH,
  MAX_PANEL_NODES,
  MAX_PANEL_TEXT_LENGTH,
  OL_TYPE_ALLOWLIST,
  getAllowedPanelAttributes,
  getAllowedPanelEventKinds,
  getPanelGlobalAttributes,
  validatePanelDefinition,
  validatePanelLayout,
  validatePanelLayoutNode,
} from '../src/panel-layout';
import { definePanelLayout } from '../src/ui';
import type { PanelEventKind, PanelLayoutNode } from '../src/panel-layout';

const PID = 'test-plugin';

function makeDeepTree(depth: number): PanelLayoutNode {
  let node: PanelLayoutNode = { tag: 'div' };
  for (let i = 0; i < depth - 1; i++) {
    node = { tag: 'div', children: [node] };
  }
  return node;
}

describe('validatePanelLayoutNode — happy path', () => {
  it('accepts the minimum possible node (just tag)', () => {
    expect(() => validatePanelLayoutNode({ tag: 'div' }, PID)).not.toThrow();
  });

  it('accepts every allowlisted tag', () => {
    for (const tag of ALLOWED_PANEL_TAGS) {
      expect(() => validatePanelLayoutNode({ tag }, PID)).not.toThrow();
    }
  });

  it('accepts every input type in the allowlist', () => {
    for (const type of INPUT_TYPE_ALLOWLIST) {
      const node: PanelLayoutNode = { tag: 'input', attrs: { type } };
      expect(() => validatePanelLayoutNode(node, PID)).not.toThrow();
    }
  });

  it('accepts <button type="button">', () => {
    expect(() =>
      validatePanelLayoutNode({ tag: 'button', attrs: { type: 'button' } }, PID),
    ).not.toThrow();
  });

  it('accepts every <ol type> enumerator', () => {
    for (const type of OL_TYPE_ALLOWLIST) {
      const node: PanelLayoutNode = { tag: 'ol', attrs: { type } };
      expect(() => validatePanelLayoutNode(node, PID)).not.toThrow();
    }
  });

  it('accepts every boolean attribute as true and false', () => {
    // Pick a tag that legitimately carries each boolean attr.
    const cases: Array<[PanelLayoutNode['tag'], string]> = [
      ['button', 'disabled'],
      ['input', 'checked'],
      ['input', 'readonly'],
      ['input', 'required'],
      ['select', 'multiple'],
      ['option', 'selected'],
      ['div', 'hidden'],
      ['ol', 'reversed'],
    ];
    for (const [tag, attr] of cases) {
      expect(() =>
        validatePanelLayoutNode({ tag, attrs: { [attr]: true } }, PID),
      ).not.toThrow();
      expect(() =>
        validatePanelLayoutNode({ tag, attrs: { [attr]: false } }, PID),
      ).not.toThrow();
    }
  });

  it('accepts global structural attributes on any tag', () => {
    for (const attr of getPanelGlobalAttributes()) {
      const value = attr === 'tabindex' ? 0 : attr === 'hidden' ? true : 'x';
      const node: PanelLayoutNode = { tag: 'span', attrs: { [attr]: value } };
      expect(() => validatePanelLayoutNode(node, PID)).not.toThrow();
    }
  });

  it('accepts aria-* attributes on any tag', () => {
    const node: PanelLayoutNode = {
      tag: 'button',
      attrs: { 'aria-label': 'Refresh', 'aria-pressed': 'false' },
    };
    expect(() => validatePanelLayoutNode(node, PID)).not.toThrow();
  });

  it('accepts data-* attributes on any tag', () => {
    const node: PanelLayoutNode = {
      tag: 'div',
      attrs: { 'data-velxio-event-target': 'btn-1', 'data-state': 'idle' },
    };
    expect(() => validatePanelLayoutNode(node, PID)).not.toThrow();
  });

  it('accepts text children on any tag', () => {
    expect(() =>
      validatePanelLayoutNode({ tag: 'h1', text: 'Title' }, PID),
    ).not.toThrow();
    expect(() =>
      validatePanelLayoutNode({ tag: 'p', text: 'Some prose.' }, PID),
    ).not.toThrow();
    expect(() =>
      validatePanelLayoutNode({ tag: 'button', text: 'Click me' }, PID),
    ).not.toThrow();
  });

  it('accepts a deeply nested tree up to the depth limit', () => {
    expect(() =>
      validatePanelLayoutNode(makeDeepTree(MAX_PANEL_DEPTH), PID),
    ).not.toThrow();
  });

  it('accepts a tree at exactly the node count limit', () => {
    const children: PanelLayoutNode[] = [];
    for (let i = 0; i < MAX_PANEL_NODES - 1; i++) {
      children.push({ tag: 'span' });
    }
    expect(() =>
      validatePanelLayoutNode({ tag: 'div', children }, PID),
    ).not.toThrow();
  });
});

describe('validatePanelLayoutNode — rejects the obvious attacks', () => {
  it('rejects a <script> tag outright', () => {
    expect(() => validatePanelLayoutNode({ tag: 'script' as never }, PID))
      .toThrow(InvalidPanelLayoutError);
  });

  it('rejects <iframe>', () => {
    expect(() => validatePanelLayoutNode({ tag: 'iframe' as never }, PID))
      .toThrow(InvalidPanelLayoutError);
  });

  it('rejects <style>', () => {
    expect(() => validatePanelLayoutNode({ tag: 'style' as never }, PID))
      .toThrow(InvalidPanelLayoutError);
  });

  it('rejects <form> (no submit-side semantics in step5b)', () => {
    expect(() => validatePanelLayoutNode({ tag: 'form' as never }, PID))
      .toThrow(InvalidPanelLayoutError);
  });

  it('rejects <a> (defers URI allowlist to step5c)', () => {
    expect(() => validatePanelLayoutNode({ tag: 'a' as never }, PID))
      .toThrow(InvalidPanelLayoutError);
  });

  it('rejects <img> (defers HTTP allowlist to step5c)', () => {
    expect(() => validatePanelLayoutNode({ tag: 'img' as never }, PID))
      .toThrow(InvalidPanelLayoutError);
  });

  it('rejects <dialog> (would steal modal focus)', () => {
    expect(() => validatePanelLayoutNode({ tag: 'dialog' as never }, PID))
      .toThrow(InvalidPanelLayoutError);
  });

  it('rejects any on* attribute', () => {
    const attack: PanelLayoutNode = {
      tag: 'button',
      attrs: { onclick: 'alert(1)' } as never,
    };
    expect(() => validatePanelLayoutNode(attack, PID)).toThrow(InvalidPanelLayoutError);
  });

  it('rejects javascript: URIs in attribute values', () => {
    const attack: PanelLayoutNode = {
      tag: 'input',
      attrs: { value: 'javascript:alert(1)' },
    };
    expect(() => validatePanelLayoutNode(attack, PID)).toThrow(InvalidPanelLayoutError);
  });

  it('rejects data:text/html URIs in attribute values', () => {
    const attack: PanelLayoutNode = {
      tag: 'input',
      attrs: { value: 'data:text/html,<script>alert(1)</script>' },
    };
    expect(() => validatePanelLayoutNode(attack, PID)).toThrow(InvalidPanelLayoutError);
  });

  it('rejects `style` attribute (would bypass the per-tag allowlist)', () => {
    const attack: PanelLayoutNode = {
      tag: 'div',
      attrs: { style: 'background:red' } as never,
    };
    expect(() => validatePanelLayoutNode(attack, PID)).toThrow(InvalidPanelLayoutError);
  });

  it('rejects `href` on any tag (no <a> in allowlist)', () => {
    const attack: PanelLayoutNode = {
      tag: 'div',
      attrs: { href: 'https://evil.example' } as never,
    };
    expect(() => validatePanelLayoutNode(attack, PID)).toThrow(InvalidPanelLayoutError);
  });

  it('rejects `<input type="file">`', () => {
    const attack: PanelLayoutNode = {
      tag: 'input',
      attrs: { type: 'file' },
    };
    expect(() => validatePanelLayoutNode(attack, PID)).toThrow(InvalidPanelLayoutError);
  });

  it('rejects `<input type="submit">`', () => {
    const attack: PanelLayoutNode = {
      tag: 'input',
      attrs: { type: 'submit' },
    };
    expect(() => validatePanelLayoutNode(attack, PID)).toThrow(InvalidPanelLayoutError);
  });

  it('rejects `<input type="image">`', () => {
    const attack: PanelLayoutNode = {
      tag: 'input',
      attrs: { type: 'image' },
    };
    expect(() => validatePanelLayoutNode(attack, PID)).toThrow(InvalidPanelLayoutError);
  });

  it('rejects `<button type="submit">`', () => {
    const attack: PanelLayoutNode = {
      tag: 'button',
      attrs: { type: 'submit' },
    };
    expect(() => validatePanelLayoutNode(attack, PID)).toThrow(InvalidPanelLayoutError);
  });

  it('rejects `<ol type="x">` outside the standard enumerators', () => {
    const attack: PanelLayoutNode = {
      tag: 'ol',
      attrs: { type: 'x' },
    };
    expect(() => validatePanelLayoutNode(attack, PID)).toThrow(InvalidPanelLayoutError);
  });
});

describe('validatePanelLayoutNode — structural invariants', () => {
  it('rejects non-object nodes', () => {
    expect(() => validatePanelLayoutNode(null, PID)).toThrow(InvalidPanelLayoutError);
    expect(() => validatePanelLayoutNode(42 as unknown, PID)).toThrow(InvalidPanelLayoutError);
    expect(() => validatePanelLayoutNode('hi' as unknown, PID)).toThrow(InvalidPanelLayoutError);
  });

  it('rejects a node with non-string tag', () => {
    expect(() => validatePanelLayoutNode({ tag: 42 } as unknown, PID))
      .toThrow(InvalidPanelLayoutError);
  });

  it('rejects attrs that are arrays', () => {
    const bad = { tag: 'div', attrs: [] as unknown } as unknown;
    expect(() => validatePanelLayoutNode(bad, PID)).toThrow(InvalidPanelLayoutError);
  });

  it('rejects attribute values with non-finite numbers', () => {
    const bad: PanelLayoutNode = {
      tag: 'input',
      attrs: { min: Number.POSITIVE_INFINITY },
    };
    expect(() => validatePanelLayoutNode(bad, PID)).toThrow(InvalidPanelLayoutError);
  });

  it('rejects attribute values whose type is null or object', () => {
    const bad: PanelLayoutNode = {
      tag: 'input',
      attrs: { value: null as unknown as string },
    };
    expect(() => validatePanelLayoutNode(bad, PID)).toThrow(InvalidPanelLayoutError);

    const bad2: PanelLayoutNode = {
      tag: 'input',
      attrs: { value: {} as unknown as string },
    };
    expect(() => validatePanelLayoutNode(bad2, PID)).toThrow(InvalidPanelLayoutError);
  });

  it('rejects attribute values exceeding MAX_PANEL_ATTR_LENGTH', () => {
    const bad: PanelLayoutNode = {
      tag: 'input',
      attrs: { value: 'x'.repeat(MAX_PANEL_ATTR_LENGTH + 1) },
    };
    expect(() => validatePanelLayoutNode(bad, PID)).toThrow(InvalidPanelLayoutError);
  });

  it('rejects attributes not listed on the given tag', () => {
    // `for` is valid on <label> but not on <span>
    const bad: PanelLayoutNode = { tag: 'span', attrs: { for: 'x' } as never };
    expect(() => validatePanelLayoutNode(bad, PID)).toThrow(InvalidPanelLayoutError);
  });

  it('rejects non-string text', () => {
    const bad = { tag: 'p', text: 42 } as unknown;
    expect(() => validatePanelLayoutNode(bad, PID)).toThrow(InvalidPanelLayoutError);
  });

  it('rejects text exceeding MAX_PANEL_TEXT_LENGTH', () => {
    const bad: PanelLayoutNode = {
      tag: 'p',
      text: 'x'.repeat(MAX_PANEL_TEXT_LENGTH + 1),
    };
    expect(() => validatePanelLayoutNode(bad, PID)).toThrow(InvalidPanelLayoutError);
  });

  it('rejects mixing text and children', () => {
    const bad: PanelLayoutNode = {
      tag: 'div',
      text: 'hi',
      children: [{ tag: 'span' }],
    };
    expect(() => validatePanelLayoutNode(bad, PID)).toThrow(InvalidPanelLayoutError);
  });

  it('rejects non-array children', () => {
    const bad = { tag: 'div', children: 'oops' } as unknown;
    expect(() => validatePanelLayoutNode(bad, PID)).toThrow(InvalidPanelLayoutError);
  });
});

describe('validatePanelLayoutNode — size limits', () => {
  it('rejects depth beyond MAX_PANEL_DEPTH', () => {
    expect(() => validatePanelLayoutNode(makeDeepTree(MAX_PANEL_DEPTH + 1), PID))
      .toThrow(InvalidPanelLayoutError);
  });

  it('rejects node count beyond MAX_PANEL_NODES', () => {
    const children: PanelLayoutNode[] = [];
    for (let i = 0; i < MAX_PANEL_NODES + 1; i++) {
      children.push({ tag: 'span' });
    }
    expect(() => validatePanelLayoutNode({ tag: 'div', children }, PID))
      .toThrow(InvalidPanelLayoutError);
  });
});

describe('validatePanelLayout — events / onEvent pair', () => {
  it('accepts a layout with no events', () => {
    expect(() =>
      validatePanelLayout({ root: { tag: 'div' } }, PID),
    ).not.toThrow();
  });

  it('accepts every event kind in the allowlist', () => {
    for (const kind of getAllowedPanelEventKinds()) {
      expect(() =>
        validatePanelLayout(
          { root: { tag: 'button' }, events: [kind], onEvent: () => {} },
          PID,
        ),
      ).not.toThrow();
    }
  });

  it('accepts onEvent without events (no events delivered, but legal)', () => {
    expect(() =>
      validatePanelLayout(
        { root: { tag: 'div' }, onEvent: () => {} },
        PID,
      ),
    ).not.toThrow();
  });

  it('rejects events without onEvent', () => {
    expect(() =>
      validatePanelLayout(
        { root: { tag: 'button' }, events: ['click'] },
        PID,
      ),
    ).toThrow(InvalidPanelLayoutError);
  });

  it('rejects unknown event kinds', () => {
    expect(() =>
      validatePanelLayout(
        {
          root: { tag: 'button' },
          events: ['keydown' as PanelEventKind],
          onEvent: () => {},
        },
        PID,
      ),
    ).toThrow(InvalidPanelLayoutError);
  });

  it('rejects duplicate event kinds', () => {
    expect(() =>
      validatePanelLayout(
        {
          root: { tag: 'button' },
          events: ['click', 'click'],
          onEvent: () => {},
        },
        PID,
      ),
    ).toThrow(InvalidPanelLayoutError);
  });

  it('rejects layout that is not an object', () => {
    expect(() => validatePanelLayout(null, PID)).toThrow(InvalidPanelLayoutError);
    expect(() => validatePanelLayout(42 as unknown, PID)).toThrow(InvalidPanelLayoutError);
  });

  it('rejects events that are not an array', () => {
    expect(() =>
      validatePanelLayout(
        { root: { tag: 'div' }, events: 'click' as unknown as ReadonlyArray<PanelEventKind> },
        PID,
      ),
    ).toThrow(InvalidPanelLayoutError);
  });
});

describe('validatePanelDefinition', () => {
  it('accepts a definition with only `mount`', () => {
    expect(() =>
      validatePanelDefinition({ mount: () => () => {} }, PID),
    ).not.toThrow();
  });

  it('accepts a definition with only `layout`', () => {
    expect(() =>
      validatePanelDefinition({ layout: { root: { tag: 'div' } } }, PID),
    ).not.toThrow();
  });

  it('accepts a definition with both (declarative wins, but legal)', () => {
    expect(() =>
      validatePanelDefinition(
        { mount: () => () => {}, layout: { root: { tag: 'div' } } },
        PID,
      ),
    ).not.toThrow();
  });

  it('rejects a definition with neither', () => {
    expect(() => validatePanelDefinition({}, PID)).toThrow(InvalidPanelLayoutError);
  });
});

describe('InvalidPanelLayoutError', () => {
  it('carries pluginId + reason and has the correct name', () => {
    try {
      validatePanelLayoutNode({ tag: 'script' } as unknown, PID);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidPanelLayoutError);
      const e = err as InvalidPanelLayoutError;
      expect(e.name).toBe('InvalidPanelLayoutError');
      expect(e.pluginId).toBe(PID);
      expect(e.reason).toContain('script');
      expect(e.message).toContain(PID);
    }
  });
});

describe('definePanelLayout — identity helper', () => {
  it('returns the input verbatim with full type inference', () => {
    const input = {
      id: 'inspector',
      title: 'Inspector',
      dock: 'right' as const,
      layout: {
        root: {
          tag: 'div' as const,
          children: [{ tag: 'h2' as const, text: 'Hello' }],
        },
      },
    };
    const result = definePanelLayout(input);
    expect(result).toBe(input);
  });
});

describe('catalog helpers', () => {
  it('exposes the per-tag attribute allowlist', () => {
    expect(getAllowedPanelAttributes('input')).toContain('type');
    expect(getAllowedPanelAttributes('input')).toContain('value');
    expect(getAllowedPanelAttributes('button')).toContain('disabled');
    expect(getAllowedPanelAttributes('div')).toEqual([]);
  });

  it('exposes BOOLEAN_ATTRS as a closed Set', () => {
    expect(BOOLEAN_ATTRS.has('disabled')).toBe(true);
    expect(BOOLEAN_ATTRS.has('checked')).toBe(true);
    expect(BOOLEAN_ATTRS.has('value')).toBe(false);
  });

  it('exposes the button type allowlist as button-only', () => {
    expect(BUTTON_TYPE_ALLOWLIST).toEqual(['button']);
  });

  it('exposes input/ol type allowlists', () => {
    expect(INPUT_TYPE_ALLOWLIST).toContain('text');
    expect(INPUT_TYPE_ALLOWLIST).not.toContain('file');
    expect(OL_TYPE_ALLOWLIST).toEqual(['1', 'a', 'A', 'i', 'I']);
  });
});
