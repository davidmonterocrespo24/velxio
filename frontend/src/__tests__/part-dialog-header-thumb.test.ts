// @vitest-environment jsdom
/**
 * The property dialog's header shows the part's picture, never its id, and
 * all of it.
 *
 * The metadata generator gave every part without SVG art a "thumbnail" that
 * was a grey square with the id printed in it at 10px, and the dialog (like
 * every consumer) takes an `<svg` thumbnail as the part's art: in the 40px
 * header the NTC showed the middle of "NTC-TEMPERATURE-SENSOR", i.e.
 * "ERATUR", and so did 104 other catalogue parts. The generator now leaves
 * such a part without a thumbnail, and the dialog draws the live element in
 * the header instead, scaled to fit, the way the picker card already did.
 *
 * The parts that do have SVG art were cut too: all 52 catalogue drawings are
 * 64x64 with no viewBox, and an SVG without one does not scale when the 40px
 * box shrinks its viewport, so the header (and the picker's hover card)
 * showed their top-left 40x40. scalableSvgThumbnail adds the viewBox.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PartInspectorDialog } from '../components/simulator/PartInspectorDialog';
import { useSimulatorStore } from '../store/useSimulatorStore';
import type { ComponentMetadata } from '../types/component-metadata';
import { scalableSvgThumbnail } from '../utils/svgThumbnail';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const META: ComponentMetadata[] = JSON.parse(
  readFileSync(resolve(process.cwd(), 'public/components-metadata.json'), 'utf-8'),
).components;
const meta = (id: string) => META.find((c) => c.id === id)!;

describe('catalogue thumbnails are art or nothing', () => {
  it('no thumbnail is a box with text in it (every SVG thumbnail draws a shape beyond its background)', () => {
    const shapes = (svg: string) =>
      (svg.match(/<(rect|circle|ellipse|path|line|polyline|polygon|image|use)\b/g) ?? []).length;
    const textOnly = META.filter((c) => {
      const t = (c.thumbnail ?? '').trim();
      return t.startsWith('<svg') && shapes(t) < 2;
    }).map((c) => c.id);
    expect(textOnly).toEqual([]);
  });

  it('every SVG thumbnail scales into a smaller box once through scalableSvgThumbnail', () => {
    const cropped = META.filter((c) => {
      const svg = scalableSvgThumbnail(c.thumbnail);
      return svg !== null && !/^<svg[^>]*\sviewBox=/.test(svg);
    }).map((c) => c.id);
    expect(cropped).toEqual([]);
  });

  it('the NTC has no thumbnail; the BMP280 keeps its drawn one', () => {
    expect(meta('ntc-temperature-sensor').thumbnail).toBe('');
    expect(meta('bmp280').thumbnail.trim().startsWith('<svg')).toBe(true);
  });
});

// A stand-in for a web-component part with no SVG thumbnail: 80x40 at natural
// size (jsdom lays nothing out, so the size is stubbed for this tag only).
class ThumbTestPart extends HTMLElement {}
const TAG = 'thumb-test-part';
let restoreW: PropertyDescriptor | undefined;
let restoreH: PropertyDescriptor | undefined;

beforeAll(() => {
  customElements.define(TAG, ThumbTestPart);
  restoreW = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  restoreH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.localName === TAG ? 80 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.localName === TAG ? 40 : 0;
    },
  });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
});
afterAll(() => {
  if (restoreW) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', restoreW);
  if (restoreH) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', restoreH);
  vi.unstubAllGlobals();
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useSimulatorStore.setState({ components: [], wires: [] } as never);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

function open(metadata: ComponentMetadata) {
  useSimulatorStore.getState().setComponents([
    { id: 'p1', metadataId: metadata.id, x: 0, y: 0, properties: {} },
  ] as never);
  act(() =>
    root.render(
      createElement(PartInspectorDialog, {
        componentId: 'p1',
        componentMetadata: metadata,
        componentProperties: {},
        pinInfo: [],
        onClose: () => {},
        onDelete: () => {},
      }),
    ),
  );
}

const header = () => document.querySelector<HTMLDivElement>('.pid-header')!;

describe('scalableSvgThumbnail', () => {
  it('adds the viewBox a 64px drawing implies', () => {
    expect(scalableSvgThumbnail('<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg"><rect/></svg>')).toBe(
      '<svg viewBox="0 0 64 64" width="64" height="64" xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
    );
  });
  it('leaves an SVG that has one alone, and reads width, not stroke-width', () => {
    const own = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 60 60'><rect/></svg>";
    expect(scalableSvgThumbnail(own)).toBe(own);
    expect(scalableSvgThumbnail('<svg stroke-width="2" width="30" height="20"></svg>')).toBe(
      '<svg viewBox="0 0 30 20" stroke-width="2" width="30" height="20"></svg>',
    );
  });
  it('is null for no art', () => {
    expect(scalableSvgThumbnail('')).toBeNull();
    expect(scalableSvgThumbnail(undefined)).toBeNull();
    expect(scalableSvgThumbnail('/img/part.png')).toBeNull();
  });
});

describe('the dialog header', () => {
  it('NTC: no text in the header thumbnail', () => {
    open(meta('ntc-temperature-sensor'));
    expect(header().querySelector('.pid-thumb text')).toBeNull();
    expect(header().querySelector('.pid-thumb')!.textContent).not.toContain('ERATUR');
    expect(header().querySelector('.pid-thumb--live')).not.toBeNull();
  });

  it('BMP280: its drawn art, whole: the 64px drawing scales into the 40px box', () => {
    open(meta('bmp280'));
    const img = header().querySelector<HTMLImageElement>('.pid-thumb img')!;
    expect(img).not.toBeNull();
    // An image, not inline markup: script in a thumbnail can never run.
    expect(header().querySelector('.pid-thumb svg')).toBeNull();
    const src = img.getAttribute('src')!;
    expect(src.startsWith('data:image/svg+xml')).toBe(true);
    expect(decodeURIComponent(src.slice(src.indexOf(',') + 1))).toContain('viewBox="0 0 64 64"');
    expect(header().querySelector('.pid-thumb--live')).toBeNull();
  });

  it('a part with no art gets its live element, scaled to fit the 40px box and centred', async () => {
    open({ ...meta('ntc-temperature-sensor'), id: 'thumb-test', tagName: TAG } as ComponentMetadata);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    const thumb = header().querySelector<HTMLElement>(`.pid-thumb--live ${TAG}`);
    expect(thumb).not.toBeNull();
    // 80x40 into 40x40: scale 0.5, 40x20 drawn, 10px down.
    expect(thumb!.style.transform).toBe('scale(0.5)');
    expect([thumb!.style.left, thumb!.style.top]).toEqual(['0px', '10px']);
    // The preview keeps its own instance.
    expect(document.querySelectorAll(TAG).length).toBe(2);
  });
});
