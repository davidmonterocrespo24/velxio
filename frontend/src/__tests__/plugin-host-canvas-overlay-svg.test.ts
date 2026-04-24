// @vitest-environment jsdom
/**
 * CORE-006b-step5 — worker-safe canvas overlay registration via the
 * declarative `svg` field on `CanvasOverlayDefinition`.
 *
 * Contract:
 *   1. A valid `svg` tree registers cleanly; the stored overlay ships a
 *      synthesized `mount(rootSvg)` that builds real DOM.
 *   2. A malformed `svg` throws `InvalidSvgNodeError` at register time —
 *      nothing ends up in the registry.
 *   3. If both `svg` and `mount` are provided, the declarative path wins
 *      and a warning is logged.
 *   4. The returned disposable removes the overlay from the registry.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  InvalidSvgNodeError,
  defineSvgOverlay,
  type EventBusReader,
  type PluginManifest,
  type PluginPermission,
} from '@velxio/sdk';

import { createPluginContext } from '../plugin-host/createPluginContext';

const SVG_NS = 'http://www.w3.org/2000/svg';

const fakeEvents: EventBusReader = {
  on: () => () => {},
  hasListeners: () => false,
  listenerCount: () => 0,
};

function manifest(perms: PluginPermission[] = []): PluginManifest {
  return {
    schemaVersion: 1,
    id: 'overlay.test',
    name: 'Overlay Test',
    version: '1.0.0',
    publisher: { name: 'Tester' },
    description: 'plugin used by overlay svg tests',
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
  return `overlay.test.${prefix}.${Math.random().toString(36).slice(2, 8)}`;
}

describe('CORE-006b-step5 — declarative canvas overlay svg', () => {
  it('registers + renders a validated svg tree', () => {
    const id = uniqueId('basic');
    const { context, ui } = createPluginContext(
      manifest(['ui.canvas.overlay.register']),
      { events: fakeEvents },
    );
    const handle = context.canvasOverlays.register(
      defineSvgOverlay({
        id,
        zIndex: 3,
        svg: {
          tag: 'g',
          attrs: { id: 'root' },
          children: [
            { tag: 'rect', attrs: { x: 0, y: 0, width: 20, height: 10, fill: 'red' } },
          ],
        },
      }),
    );

    // Registered shape must have a synthesized `mount` the canvas layer calls.
    const entries = ui.canvasOverlays.entries();
    const stored = entries.find((e) => e.id === id);
    expect(stored).toBeDefined();
    expect(stored?.mount).toBeTypeOf('function');
    expect(stored?.zIndex).toBe(3);

    // Feed the mount a real root and verify DOM output.
    const root = document.createElementNS(SVG_NS, 'g') as SVGGElement;
    const teardown = stored!.mount!(root);
    const g = root.firstElementChild as SVGElement;
    expect(g.tagName.toLowerCase()).toBe('g');
    expect(g.getAttribute('id')).toBe('root');
    expect(g.children[0].tagName.toLowerCase()).toBe('rect');
    expect((g.children[0] as SVGElement).getAttribute('fill')).toBe('red');

    teardown();
    expect(root.children.length).toBe(0);

    handle.dispose();
    expect(ui.canvasOverlays.entries().find((e) => e.id === id)).toBeUndefined();
  });

  it('rejects a malformed svg at register-time and never stores the overlay', () => {
    const id = uniqueId('bad');
    const { context, ui } = createPluginContext(
      manifest(['ui.canvas.overlay.register']),
      { events: fakeEvents },
    );
    expect(() =>
      context.canvasOverlays.register({
        id,
        svg: { tag: 'script' } as unknown as import('@velxio/sdk').SvgNode,
      }),
    ).toThrow(InvalidSvgNodeError);
    expect(ui.canvasOverlays.entries().find((e) => e.id === id)).toBeUndefined();
  });

  it('prefers declarative svg when both mount and svg are supplied', () => {
    const id = uniqueId('both');
    const { context, ui } = createPluginContext(
      manifest(['ui.canvas.overlay.register']),
      { events: fakeEvents },
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mountSpy = vi.fn(() => () => {});
    context.canvasOverlays.register({
      id,
      mount: mountSpy,
      svg: { tag: 'rect', attrs: { x: 0, y: 0, width: 5, height: 5 } },
    });

    const stored = ui.canvasOverlays.entries().find((e) => e.id === id);
    expect(stored).toBeDefined();

    // Call whatever mount ended up registered; the plugin's original mount
    // must NOT be invoked.
    const root = document.createElementNS(SVG_NS, 'g') as SVGGElement;
    stored!.mount!(root);
    expect(mountSpy).not.toHaveBeenCalled();

    // Child is the rect from the svg tree.
    expect(root.firstElementChild?.tagName.toLowerCase()).toBe('rect');

    // Warning surfaced to the console (via plugin logger).
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not fire the warning when only svg is set', () => {
    const id = uniqueId('clean');
    const { context } = createPluginContext(
      manifest(['ui.canvas.overlay.register']),
      { events: fakeEvents },
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    context.canvasOverlays.register(
      defineSvgOverlay({
        id,
        svg: { tag: 'circle', attrs: { cx: 0, cy: 0, r: 1 } },
      }),
    );
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
