// @vitest-environment jsdom
/**
 * CORE-006b-step5b — worker-safe panel registration via the declarative
 * `layout` field on `PanelDefinition`.
 *
 * Contract:
 *   1. A valid `layout` registers cleanly; the stored panel ships a
 *      synthesized `mount(container)` that builds real DOM.
 *   2. A malformed `layout` throws `InvalidPanelLayoutError` at register
 *      time — nothing ends up in the registry.
 *   3. A definition with neither `mount` nor `layout` is rejected.
 *   4. If both `layout` and `mount` are supplied, the declarative path
 *      wins and a warning is logged.
 *   5. Delegated events (click/change) reach the plugin's `onEvent` with
 *      the right `targetId` and value.
 *   6. A throwing `onEvent` doesn't break the listener — subsequent
 *      events still flow.
 *   7. `dispose()` removes the registration AND (when invoked from the
 *      synthesized `mount` teardown) detaches the rendered DOM.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  InvalidPanelLayoutError,
  definePanelLayout,
  type DelegatedPanelEvent,
  type EventBusReader,
  type PanelDefinition,
  type PanelLayoutNode,
  type PluginManifest,
  type PluginPermission,
} from '@velxio/sdk';

import { createPluginContext } from '../plugin-host/createPluginContext';

const fakeEvents: EventBusReader = {
  on: () => () => {},
  hasListeners: () => false,
  listenerCount: () => 0,
};

function manifest(perms: PluginPermission[] = []): PluginManifest {
  return {
    schemaVersion: 1,
    id: 'panel.test',
    name: 'Panel Test',
    version: '1.0.0',
    publisher: { name: 'Tester' },
    description: 'plugin used by panel layout tests',
    icon: 'https://example.com/icon.svg',
    license: 'MIT',
    category: 'utility',
    tags: [],
    type: ['ui-extension'],
    entry: { module: 'index.js' },
    permissions: perms,
    pricing: { model: 'free' },
    refundPolicy: 'none',
  } as PluginManifest;
}

function uniqueId(prefix: string): string {
  return `panel.test.${prefix}.${Math.random().toString(36).slice(2, 8)}`;
}

describe('CORE-006b-step5b — declarative panel layout', () => {
  it('registers + renders a validated layout tree', () => {
    const id = uniqueId('basic');
    const { context, ui } = createPluginContext(
      manifest(['ui.panel.register']),
      { events: fakeEvents },
    );
    const handle = context.panels.register(
      definePanelLayout({
        id,
        title: 'Inspector',
        dock: 'right',
        layout: {
          root: {
            tag: 'section',
            attrs: { id: 'root' },
            children: [
              { tag: 'h2', text: 'Hello' },
              { tag: 'p', text: 'Body' },
            ],
          },
        },
      }),
    );

    // Registered shape must have a synthesized `mount` the host's panel
    // surface calls when it mounts the panel.
    const stored = ui.panels.entries().find((e) => e.id === id);
    expect(stored).toBeDefined();
    expect(stored?.mount).toBeTypeOf('function');
    expect(stored?.dock).toBe('right');
    expect(stored?.title).toBe('Inspector');

    // Feed the mount a real container and verify the DOM output.
    const container = document.createElement('div');
    document.body.appendChild(container);
    const teardown = stored!.mount!(container);
    const section = container.firstElementChild as HTMLElement;
    expect(section.tagName.toLowerCase()).toBe('section');
    expect(section.getAttribute('id')).toBe('root');
    expect(section.children[0].tagName.toLowerCase()).toBe('h2');
    expect(section.children[0].textContent).toBe('Hello');

    teardown();
    expect(container.children.length).toBe(0);

    handle.dispose();
    expect(ui.panels.entries().find((e) => e.id === id)).toBeUndefined();
  });

  it('rejects a malformed layout at register-time and never stores the panel', () => {
    const id = uniqueId('bad');
    const { context, ui } = createPluginContext(
      manifest(['ui.panel.register']),
      { events: fakeEvents },
    );
    expect(() =>
      context.panels.register({
        id,
        title: 'Bad',
        dock: 'right',
        layout: { root: { tag: 'script' as never } as PanelLayoutNode },
      } as PanelDefinition),
    ).toThrow(InvalidPanelLayoutError);
    expect(ui.panels.entries().find((e) => e.id === id)).toBeUndefined();
  });

  it('rejects a panel with neither `mount` nor `layout`', () => {
    const id = uniqueId('empty');
    const { context, ui } = createPluginContext(
      manifest(['ui.panel.register']),
      { events: fakeEvents },
    );
    expect(() =>
      context.panels.register({
        id,
        title: 'Empty',
        dock: 'right',
      } as PanelDefinition),
    ).toThrow(InvalidPanelLayoutError);
    expect(ui.panels.entries().find((e) => e.id === id)).toBeUndefined();
  });

  it('prefers declarative layout when both `mount` and `layout` are supplied', () => {
    const id = uniqueId('both');
    const { context, ui } = createPluginContext(
      manifest(['ui.panel.register']),
      { events: fakeEvents },
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mountSpy = vi.fn(() => () => {});
    context.panels.register({
      id,
      title: 'Both',
      dock: 'left',
      mount: mountSpy,
      layout: { root: { tag: 'div', text: 'declarative' } },
    });

    const stored = ui.panels.entries().find((e) => e.id === id);
    expect(stored).toBeDefined();

    // Call whatever mount ended up registered; the plugin's original mount
    // must NOT be invoked.
    const container = document.createElement('div');
    stored!.mount!(container);
    expect(mountSpy).not.toHaveBeenCalled();

    // Child is the div from the layout tree.
    expect(container.firstElementChild?.tagName.toLowerCase()).toBe('div');
    expect(container.firstElementChild?.textContent).toBe('declarative');

    // Warning surfaced to the console (via plugin logger).
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not fire the warning when only `layout` is set', () => {
    const id = uniqueId('clean');
    const { context } = createPluginContext(
      manifest(['ui.panel.register']),
      { events: fakeEvents },
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    context.panels.register(
      definePanelLayout({
        id,
        title: 'Clean',
        dock: 'right',
        layout: { root: { tag: 'div' } },
      }),
    );
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('delivers delegated click events through the plugin onEvent callback', () => {
    const id = uniqueId('click');
    const { context, ui } = createPluginContext(
      manifest(['ui.panel.register']),
      { events: fakeEvents },
    );
    const onEvent = vi.fn<(event: DelegatedPanelEvent) => void>();
    context.panels.register(
      definePanelLayout({
        id,
        title: 'Click',
        dock: 'right',
        layout: {
          root: {
            tag: 'div',
            children: [
              {
                tag: 'button',
                attrs: { type: 'button', 'data-velxio-event-target': 'go' },
                text: 'Go',
              },
            ],
          },
          events: ['click'],
          onEvent,
        },
      }),
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const stored = ui.panels.entries().find((e) => e.id === id)!;
    const teardown = stored.mount!(container);
    (container.querySelector('button') as HTMLButtonElement).click();
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'click', targetId: 'go' }),
    );
    teardown();
  });

  it('extracts value on change events from input fields', () => {
    const id = uniqueId('change');
    const { context, ui } = createPluginContext(
      manifest(['ui.panel.register']),
      { events: fakeEvents },
    );
    const onEvent = vi.fn<(event: DelegatedPanelEvent) => void>();
    context.panels.register(
      definePanelLayout({
        id,
        title: 'Change',
        dock: 'right',
        layout: {
          root: {
            tag: 'input',
            attrs: { type: 'text', 'data-velxio-event-target': 'name' },
          },
          events: ['change'],
          onEvent,
        },
      }),
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const stored = ui.panels.entries().find((e) => e.id === id)!;
    stored.mount!(container);
    const input = container.firstElementChild as HTMLInputElement;
    input.value = 'velxio';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'change', targetId: 'name', value: 'velxio' }),
    );
  });

  it('fault-isolates a throwing `onEvent` so subsequent events still flow', () => {
    const id = uniqueId('throws');
    const { context, ui } = createPluginContext(
      manifest(['ui.panel.register']),
      { events: fakeEvents },
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onEvent = vi.fn().mockImplementationOnce(() => {
      throw new Error('boom');
    });
    context.panels.register(
      definePanelLayout({
        id,
        title: 'Throws',
        dock: 'right',
        layout: {
          root: { tag: 'button', attrs: { type: 'button', 'data-velxio-event-target': 'b' } },
          events: ['click'],
          onEvent,
        },
      }),
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const stored = ui.panels.entries().find((e) => e.id === id)!;
    stored.mount!(container);
    const btn = container.firstElementChild as HTMLButtonElement;
    btn.click();
    btn.click();
    expect(onEvent).toHaveBeenCalledTimes(2);
    // First throw was logged via the plugin logger (which writes to console.error).
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('register-time throws when the plugin lacks `ui.panel.register` permission', () => {
    const id = uniqueId('perm');
    const { context, ui } = createPluginContext(
      manifest([]),
      { events: fakeEvents },
    );
    expect(() =>
      context.panels.register(
        definePanelLayout({
          id,
          title: 'Denied',
          dock: 'right',
          layout: { root: { tag: 'div' } },
        }),
      ),
    ).toThrow();
    expect(ui.panels.entries().find((e) => e.id === id)).toBeUndefined();
  });
});
