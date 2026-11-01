/**
 * Gallery example filter: which of the registered examples a gallery list
 * shows (the examples page, and a part's "examples with this part" list).
 *
 * Mirrors the other OSS->Pro seams (`proSdCardGate.ts`, `proBoardGate.ts`):
 *   - OSS without an overlay -> every example (the identity).
 *   - With the pro overlay   -> its filter leaves out the examples its
 *     simulator cannot run. A filtered example keeps its own page and still
 *     opens in the editor from its URL; only the lists leave it out.
 */
import type { ExampleProject } from '../data/examples';

type GalleryExampleFilter = (examples: ExampleProject[]) => ExampleProject[];

let _impl: GalleryExampleFilter | null = null;

/** Installed by the pro overlay (mountPro). Pass null to clear (hot reload). */
export function installGalleryExampleFilter(impl: GalleryExampleFilter | null): void {
  _impl = impl;
}

/** The examples a gallery list shows, out of `examples`. */
export function galleryExamples(examples: ExampleProject[]): ExampleProject[] {
  if (!_impl) return examples;
  try {
    return _impl(examples);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[oss] gallery example filter threw:', err);
    return examples;
  }
}
