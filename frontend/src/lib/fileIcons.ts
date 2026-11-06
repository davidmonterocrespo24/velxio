/**
 * File icons an extension adds to the file explorer, by file name: a file
 * that means something special to the extension (a scene, a config, a data
 * set) can stand out among the sketch files without the OSS tree knowing
 * what it is. Plain data (SVG path data in a 24 x 24 box, drawn as 2 px
 * strokes like the built-in icons), so a registrant needs no React.
 *
 * Same shape as the other OSS seams (galleryFacets, galleryExampleFilter):
 * the OSS build registers none and the explorer draws its own icons.
 */

export interface FileIconRule {
  /** Whether this rule draws the icon of a file (its full name, folders included). */
  match: (fileName: string) => boolean;
  /** SVG path data in a 24 x 24 viewBox. */
  paths: string[];
  /** Stroke colour (any CSS colour or var()). Default: the row's text colour. */
  color?: string;
}

const rules: FileIconRule[] = [];
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version++;
  for (const l of listeners) l();
}

/** Register a rule; the first registered rule that matches wins. Returns a remover. */
export function registerFileIcon(rule: FileIconRule): () => void {
  rules.push(rule);
  changed();
  return () => {
    const i = rules.indexOf(rule);
    if (i >= 0) {
      rules.splice(i, 1);
      changed();
    }
  };
}

/** The rule that draws `fileName`, or null for the built-in icon. A throwing matcher is skipped. */
export function fileIconFor(fileName: string): FileIconRule | null {
  for (const r of rules) {
    try {
      if (r.match(fileName)) return r;
    } catch {
      /* a broken rule never hides a file */
    }
  }
  return null;
}

export function subscribeFileIcons(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getFileIconsVersion(): number {
  return version;
}
