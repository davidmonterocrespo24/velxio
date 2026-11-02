/**
 * URL of a gallery example's thumbnail (`public/examples-thumbs/<id>.webp`).
 *
 * The files are served with a long max-age under fixed names, so a thumbnail
 * re-captured after an example changed stayed hidden behind the cached old
 * one, in the browser and at the CDN, for up to 30 days. The build stamps a
 * hash of all the thumbnails (vite.config.ts) into the query string, which
 * changes exactly when one of them changes. Without it (tests, a dev server
 * that did not define it) the plain path is used.
 */
declare const __EXAMPLE_THUMBS_VERSION__: string | undefined;

const VERSION = typeof __EXAMPLE_THUMBS_VERSION__ === 'string' ? __EXAMPLE_THUMBS_VERSION__ : '';

export function exampleThumbUrl(exampleId: string): string {
  const base = `/examples-thumbs/${exampleId}.webp`;
  return VERSION ? `${base}?v=${VERSION}` : base;
}
