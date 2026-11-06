/**
 * Gallery facets: extra on/off filters an extension adds to the examples
 * gallery, drawn as a toggle next to the board / category / difficulty
 * dropdowns ("examples with a 3D world", "examples for classrooms"...).
 *
 * A generic seam like `galleryExampleFilter.ts` and `proBoardRegistry.ts`:
 * the OSS build registers none, so the gallery renders nothing extra. A
 * facet is linkable: `/examples?facet=<id>` opens the gallery filtered, and
 * a link that arrives before its facet registers simply shows everything
 * until it does (the gallery re-renders on registration).
 */
import type { ExampleProject } from '../data/examples';

export interface GalleryFacet {
  /** Stable id, also the `facet` URL value. Lowercase letters, digits, dashes. */
  id: string;
  /** Toggle label, read at render time so it follows the UI language. */
  label: () => string;
  /** Tooltip for the toggle. */
  title?: () => string;
  /** Optional icon before the label: SVG path data in a 24 x 24 box, drawn
   *  as 1.8 px strokes in the text colour. Plain data, so a registrant needs
   *  no React. */
  iconPaths?: string[];
  /** Whether an example belongs to the facet. Must not throw; if it does, the example is left out. */
  match: (example: ExampleProject) => boolean;
  /** Called when the user turns the facet on (analytics, for one). */
  onActivate?: () => void;
}

const facets = new Map<string, GalleryFacet>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version++;
  for (const l of listeners) l();
}

/** Register (or replace) a facet. Returns a function that removes it. */
export function registerGalleryFacet(facet: GalleryFacet): () => void {
  facets.set(facet.id, facet);
  changed();
  return () => {
    if (facets.get(facet.id) === facet) {
      facets.delete(facet.id);
      changed();
    }
  };
}

/** Registered facets, in registration order. */
export function getGalleryFacets(): GalleryFacet[] {
  return [...facets.values()];
}

/** Whether an example belongs to a facet; a throwing matcher means no. */
export function facetMatches(facet: GalleryFacet, example: ExampleProject): boolean {
  try {
    return facet.match(example) === true;
  } catch {
    return false;
  }
}

export function subscribeGalleryFacets(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getGalleryFacetsVersion(): number {
  return version;
}
