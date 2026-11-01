/**
 * The gallery example filter (lib/galleryExampleFilter.ts), the overlay seam
 * the gallery lists read: every example without an overlay, what an installed
 * filter keeps, and every example again when the filter is cleared or throws.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExampleProject } from '../data/examples';
import { galleryExamples, installGalleryExampleFilter } from '../lib/galleryExampleFilter';

const example = (id: string): ExampleProject => ({ id, title: id }) as unknown as ExampleProject;

describe('galleryExamples', () => {
  afterEach(() => installGalleryExampleFilter(null));

  it('lists every example without an overlay', () => {
    const list = [example('a'), example('b')];
    expect(galleryExamples(list)).toBe(list);
  });

  it('lists what the installed filter keeps, and every example once it is cleared', () => {
    const list = [example('a'), example('b'), example('c')];
    installGalleryExampleFilter((examples) => examples.filter((e) => e.id !== 'b'));
    expect(galleryExamples(list).map((e) => e.id)).toEqual(['a', 'c']);
    installGalleryExampleFilter(null);
    expect(galleryExamples(list)).toBe(list);
  });

  it('lists every example when the filter throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const list = [example('a')];
    installGalleryExampleFilter(() => {
      throw new Error('broken filter');
    });
    expect(galleryExamples(list)).toBe(list);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
