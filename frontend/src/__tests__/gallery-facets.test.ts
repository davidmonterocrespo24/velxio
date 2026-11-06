// @vitest-environment jsdom
/**
 * Gallery facets (lib/galleryFacets.ts): the seam an extension uses to add
 * an on/off filter to the examples gallery. The registry, and the gallery
 * honouring a facet from the URL (`/examples?facet=<id>`), its toggle and
 * its chip.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import {
  facetMatches,
  getGalleryFacets,
  getGalleryFacetsVersion,
  registerGalleryFacet,
  type GalleryFacet,
} from '../lib/galleryFacets';
import { ExamplesGallery } from '../components/examples/ExamplesGallery';
import { exampleProjects, type ExampleProject } from '../data/examples';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const blinky: GalleryFacet = {
  id: 'blinky',
  label: () => 'Blink only',
  iconPaths: ['M4 12h16'],
  match: (ex: ExampleProject) => /blink/i.test(ex.id),
};

let removers: Array<() => void> = [];
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  removers.forEach((r) => r());
  removers = [];
});

describe('gallery facet registry', () => {
  it('registers, replaces and removes a facet, bumping the version each time', () => {
    const v0 = getGalleryFacetsVersion();
    const off = registerGalleryFacet(blinky);
    expect(getGalleryFacets().map((f) => f.id)).toEqual(['blinky']);
    expect(getGalleryFacetsVersion()).toBeGreaterThan(v0);
    off();
    expect(getGalleryFacets()).toEqual([]);
  });

  it('treats a matcher that throws as no match', () => {
    const broken: GalleryFacet = { id: 'broken', label: () => 'x', match: () => { throw new Error('boom'); } };
    expect(facetMatches(broken, exampleProjects[0])).toBe(false);
  });
});

describe('gallery with a facet', () => {
  async function render(url: string) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        createElement(MemoryRouter, { initialEntries: [url] }, createElement(ExamplesGallery, { onLoadExample: () => {} })),
      );
    });
    return host;
  }

  it('filters to the facet named in the URL and shows it as a chip; the toggle clears it', async () => {
    removers.push(registerGalleryFacet(blinky));
    const expected = exampleProjects.filter((ex) => /blink/i.test(ex.id)).length;
    expect(expected).toBeGreaterThan(0);

    const el = await render('/examples?facet=blinky');
    expect(el.querySelectorAll('.example-card').length).toBe(expected);
    const toggle = el.querySelector<HTMLButtonElement>('.examples-facet')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.textContent).toContain('Blink only');
    expect(toggle.querySelector('svg path')?.getAttribute('d')).toBe('M4 12h16');
    expect([...el.querySelectorAll('.filter-chip')].some((c) => c.textContent?.includes('Blink only'))).toBe(true);

    await act(async () => toggle.click());
    expect(el.querySelectorAll('.example-card').length).toBe(exampleProjects.length);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });

  it('renders no toggle and filters nothing when no facet is registered', async () => {
    const el = await render('/examples?facet=blinky');
    expect(el.querySelector('.examples-facet')).toBeNull();
    expect(el.querySelectorAll('.example-card').length).toBe(exampleProjects.length);
  });
});
