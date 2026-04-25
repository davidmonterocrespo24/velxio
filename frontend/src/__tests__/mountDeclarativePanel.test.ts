// @vitest-environment jsdom
/**
 * `mountDeclarativePanel` — unit tests for the worker-safe panel renderer.
 *
 * The function is the main-thread counterpart of `PanelDefinition.layout`.
 * It must:
 *   1. Build an HTML tree via `createElement`, never `innerHTML`.
 *   2. Apply only allowlisted attributes (rejects: `style`, `on*`, `<script>`).
 *   3. Honour boolean-attribute presence semantics
 *      (`true` → presence; `false` → absent — never `setAttribute(name, "false")`).
 *   4. Reject malformed trees with `InvalidPanelLayoutError`.
 *   5. Install one delegated listener per kind on the container, with
 *      element-local value/checked extraction.
 *   6. `dispose()` removes both DOM and listeners, idempotently.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  InvalidPanelLayoutError,
  type DelegatedPanelEvent,
  type PanelLayout,
  type PanelLayoutNode,
} from '@velxio/sdk';

import { mountDeclarativePanel } from '../plugin-host/mountDeclarativePanel';

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

describe('mountDeclarativePanel — happy path', () => {
  it('builds a single-node tree with allowlisted attributes', () => {
    const container = makeContainer();
    const handle = mountDeclarativePanel(
      container,
      { root: { tag: 'button', attrs: { type: 'button', name: 'go' }, text: 'Go' } },
      'test',
    );
    const btn = container.firstElementChild as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.tagName.toLowerCase()).toBe('button');
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.getAttribute('name')).toBe('go');
    expect(btn.textContent).toBe('Go');
    expect(handle.element).toBe(btn);
  });

  it('builds a nested tree in document order', () => {
    const container = makeContainer();
    mountDeclarativePanel(
      container,
      {
        root: {
          tag: 'section',
          attrs: { id: 'wrap' },
          children: [
            { tag: 'h2', text: 'Title' },
            { tag: 'p', text: 'Body' },
          ],
        },
      },
      'test',
    );
    const section = container.firstElementChild as HTMLElement;
    expect(section.tagName.toLowerCase()).toBe('section');
    expect(section.getAttribute('id')).toBe('wrap');
    expect(section.children.length).toBe(2);
    expect(section.children[0].tagName.toLowerCase()).toBe('h2');
    expect(section.children[0].textContent).toBe('Title');
    expect(section.children[1].tagName.toLowerCase()).toBe('p');
  });

  it('renders <select><option> tree', () => {
    const container = makeContainer();
    mountDeclarativePanel(
      container,
      {
        root: {
          tag: 'select',
          attrs: { name: 'mode' },
          children: [
            { tag: 'option', attrs: { value: 'a' }, text: 'A' },
            { tag: 'option', attrs: { value: 'b', selected: true }, text: 'B' },
          ],
        },
      },
      'test',
    );
    const select = container.firstElementChild as HTMLSelectElement;
    expect(select.children.length).toBe(2);
    expect((select.children[0] as HTMLOptionElement).value).toBe('a');
    expect((select.children[1] as HTMLOptionElement).hasAttribute('selected')).toBe(true);
  });
});

describe('mountDeclarativePanel — boolean attribute semantics', () => {
  it('boolean true → present (empty-string value)', () => {
    const container = makeContainer();
    mountDeclarativePanel(
      container,
      { root: { tag: 'input', attrs: { type: 'checkbox', checked: true, disabled: true } } },
      'test',
    );
    const input = container.firstElementChild as HTMLInputElement;
    expect(input.hasAttribute('checked')).toBe(true);
    expect(input.hasAttribute('disabled')).toBe(true);
  });

  it('boolean false → absent (NEVER setAttribute(name, "false"))', () => {
    const container = makeContainer();
    mountDeclarativePanel(
      container,
      { root: { tag: 'input', attrs: { type: 'checkbox', checked: false, disabled: false } } },
      'test',
    );
    const input = container.firstElementChild as HTMLInputElement;
    expect(input.hasAttribute('checked')).toBe(false);
    expect(input.hasAttribute('disabled')).toBe(false);
    // Specifically: the literal string "false" must not be a value anywhere.
    expect(input.getAttribute('checked')).toBeNull();
    expect(input.getAttribute('disabled')).toBeNull();
  });

  it('non-boolean attributes go through as their string form', () => {
    const container = makeContainer();
    mountDeclarativePanel(
      container,
      { root: { tag: 'input', attrs: { type: 'number', min: 0, max: 100, step: 5 } } },
      'test',
    );
    const input = container.firstElementChild as HTMLInputElement;
    expect(input.getAttribute('min')).toBe('0');
    expect(input.getAttribute('max')).toBe('100');
    expect(input.getAttribute('step')).toBe('5');
  });
});

describe('mountDeclarativePanel — XSS regression', () => {
  it('uses textContent (not innerHTML) so literal markup never executes', () => {
    const container = makeContainer();
    mountDeclarativePanel(
      container,
      { root: { tag: 'p', text: '<script>alert(1)</script>' } },
      'test',
    );
    const p = container.firstElementChild as HTMLElement;
    // No child <script> element materialised — the entire string is one text node.
    expect(p.children.length).toBe(0);
    expect(p.textContent).toBe('<script>alert(1)</script>');
  });
});

describe('mountDeclarativePanel — rejects malformed trees at re-validation', () => {
  it('rejects a node with a forbidden tag', () => {
    const container = makeContainer();
    expect(() =>
      mountDeclarativePanel(
        container,
        { root: { tag: 'script' as never } as PanelLayoutNode },
        'test',
      ),
    ).toThrow(InvalidPanelLayoutError);
    // Nothing was appended.
    expect(container.children.length).toBe(0);
  });

  it('rejects an on* event attribute', () => {
    const container = makeContainer();
    expect(() =>
      mountDeclarativePanel(
        container,
        {
          root: {
            tag: 'button',
            attrs: { onclick: 'alert(1)' } as never,
          },
        } as PanelLayout,
        'test',
      ),
    ).toThrow(InvalidPanelLayoutError);
    expect(container.children.length).toBe(0);
  });
});

describe('mountDeclarativePanel — delegated events', () => {
  it('delivers click events with targetId from the closest data marker', () => {
    const container = makeContainer();
    const onEvent = vi.fn<(event: DelegatedPanelEvent) => void>();
    mountDeclarativePanel(
      container,
      {
        root: {
          tag: 'div',
          children: [
            {
              tag: 'button',
              attrs: { type: 'button', 'data-velxio-event-target': 'go' },
              text: 'Go',
            },
            {
              tag: 'button',
              attrs: { type: 'button', 'data-velxio-event-target': 'stop' },
              text: 'Stop',
            },
          ],
        },
        events: ['click'],
        onEvent,
      },
      'test',
    );
    const buttons = container.querySelectorAll('button');
    buttons[0].click();
    buttons[1].click();
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent.mock.calls[0][0]).toMatchObject({ type: 'click', targetId: 'go' });
    expect(onEvent.mock.calls[1][0]).toMatchObject({ type: 'click', targetId: 'stop' });
  });

  it('returns null targetId when no data marker is in scope', () => {
    const container = makeContainer();
    const onEvent = vi.fn<(event: DelegatedPanelEvent) => void>();
    mountDeclarativePanel(
      container,
      {
        root: { tag: 'div', children: [{ tag: 'button', attrs: { type: 'button' } }] },
        events: ['click'],
        onEvent,
      },
      'test',
    );
    (container.querySelector('button') as HTMLButtonElement).click();
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'click', targetId: null }),
    );
  });

  it('extracts value from input change events', () => {
    const container = makeContainer();
    const onEvent = vi.fn<(event: DelegatedPanelEvent) => void>();
    mountDeclarativePanel(
      container,
      {
        root: {
          tag: 'input',
          attrs: { type: 'text', 'data-velxio-event-target': 'name' },
        },
        events: ['change'],
        onEvent,
      },
      'test',
    );
    const input = container.firstElementChild as HTMLInputElement;
    input.value = 'hello';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'change', targetId: 'name', value: 'hello' }),
    );
  });

  it('extracts checked from checkbox click events', () => {
    const container = makeContainer();
    const onEvent = vi.fn<(event: DelegatedPanelEvent) => void>();
    mountDeclarativePanel(
      container,
      {
        root: {
          tag: 'input',
          attrs: { type: 'checkbox', 'data-velxio-event-target': 'agree' },
        },
        events: ['click'],
        onEvent,
      },
      'test',
    );
    const input = container.firstElementChild as HTMLInputElement;
    input.click(); // toggles checked to true and fires click
    expect(onEvent).toHaveBeenCalledTimes(1);
    const payload = onEvent.mock.calls[0][0];
    expect(payload.type).toBe('click');
    expect(payload.targetId).toBe('agree');
    expect(payload.checked).toBe(true);
  });

  it('forwards modifier keys', () => {
    const container = makeContainer();
    const onEvent = vi.fn<(event: DelegatedPanelEvent) => void>();
    mountDeclarativePanel(
      container,
      {
        root: { tag: 'button', attrs: { type: 'button', 'data-velxio-event-target': 'b' } },
        events: ['click'],
        onEvent,
      },
      'test',
    );
    const btn = container.firstElementChild as HTMLButtonElement;
    btn.dispatchEvent(
      new MouseEvent('click', { bubbles: true, shiftKey: true, ctrlKey: true }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'click',
        shiftKey: true,
        ctrlKey: true,
        altKey: false,
        metaKey: false,
      }),
    );
  });

  it('focus / blur are translated to focusin / focusout so they bubble', () => {
    const container = makeContainer();
    const onEvent = vi.fn<(event: DelegatedPanelEvent) => void>();
    mountDeclarativePanel(
      container,
      {
        root: { tag: 'input', attrs: { type: 'text', 'data-velxio-event-target': 'i' } },
        events: ['focus', 'blur'],
        onEvent,
      },
      'test',
    );
    const input = container.firstElementChild as HTMLInputElement;
    // Dispatch focusin / focusout directly — jsdom .focus() doesn't always
    // fire focusin in older jsdom builds, and we want to assert the wiring,
    // not the platform.
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent.mock.calls[0][0].type).toBe('focus');
    expect(onEvent.mock.calls[1][0].type).toBe('blur');
  });

  it('fault-isolates a throwing onEvent — the next event still flows', () => {
    const container = makeContainer();
    const errs: unknown[] = [];
    const logger = { error: (..._args: unknown[]) => errs.push(_args) };
    const onEvent = vi.fn().mockImplementationOnce(() => {
      throw new Error('boom');
    });
    mountDeclarativePanel(
      container,
      {
        root: { tag: 'button', attrs: { type: 'button', 'data-velxio-event-target': 'b' } },
        events: ['click'],
        onEvent,
      },
      'test',
      logger,
    );
    const btn = container.firstElementChild as HTMLButtonElement;
    btn.click();
    btn.click();
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(errs.length).toBe(1);
  });
});

describe('mountDeclarativePanel — dispose', () => {
  it('removes the mounted element', () => {
    const container = makeContainer();
    const handle = mountDeclarativePanel(
      container,
      { root: { tag: 'span', text: 'x' } },
      'test',
    );
    expect(container.children.length).toBe(1);
    handle.dispose();
    expect(container.children.length).toBe(0);
  });

  it('removes installed listeners', () => {
    const container = makeContainer();
    const onEvent = vi.fn<(event: DelegatedPanelEvent) => void>();
    const handle = mountDeclarativePanel(
      container,
      {
        root: { tag: 'button', attrs: { type: 'button' } },
        events: ['click'],
        onEvent,
      },
      'test',
    );
    const btn = container.firstElementChild as HTMLButtonElement;
    handle.dispose();
    btn.click();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('is idempotent', () => {
    const container = makeContainer();
    const handle = mountDeclarativePanel(
      container,
      { root: { tag: 'div' } },
      'test',
    );
    handle.dispose();
    expect(() => handle.dispose()).not.toThrow();
    expect(container.children.length).toBe(0);
  });
});
