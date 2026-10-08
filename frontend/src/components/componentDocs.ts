/**
 * Component Markdown docs — lazy registry.
 *
 * Human-authored datasheets live in `./component-docs/<category>/<id>.md`
 * (organised by type for tidiness). Each file is matched by its basename
 * (`<id>`) so a doc resolves regardless of which category folder it is filed
 * under — moving `led.md` from `output/` to `misc/` doesn't break the link.
 *
 * A doc may open with a small YAML-ish front-matter block carrying the
 * component's brand and a purchase link:
 *
 *     ---
 *     brand: Aosong (AM2302)
 *     buy: https://www.example.com/dht22
 *     ---
 *     Body markdown…
 *
 * The raw Markdown is loaded on demand (Vite `?raw` + dynamic import) and
 * cached, so the ~150-file corpus never touches the initial bundle and each
 * doc is fetched at most once. See `component-docs/README.md` for the authoring
 * format and how the hover panel consumes it.
 */

export interface ComponentDoc {
  /** Markdown body with the front-matter stripped. */
  body: string;
  /** Manufacturer / brand, from front-matter. */
  brand?: string;
  /** Purchase URL, from front-matter (validated http(s) before use in the UI). */
  buy?: string;
}

const modules = import.meta.glob('./component-docs/**/*.md', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

// basename (component id, no extension) -> raw-markdown loader
const byId: Record<string, () => Promise<string>> = {};
for (const path in modules) {
  const id = path.split('/').pop()!.replace(/\.md$/, '');
  byId[id] = modules[path];
}

const cache = new Map<string, ComponentDoc | null>();

/**
 * Overlay seam: a private build (velxio.dev) can register the datasheet
 * markdown for a component it injects at runtime — the import.meta.glob above
 * only sees files committed in this tree. Same raw format as the .md files
 * (optional front-matter + body). Last write wins; the parsed cache for the
 * id is invalidated so a re-render picks the new doc up.
 */
export function registerComponentDoc(id: string, raw: string): void {
  byId[id] = () => Promise.resolve(raw);
  cache.delete(id);
}

// Purchase-link overrides, keyed by component id. Set at runtime (overlay
// seam below); they supersede the datasheet's `buy:` front-matter and can
// give a Buy button to a component with no authored datasheet at all.
const buyOverrides = new Map<string, string>();

/**
 * Overlay seam: register a purchase-URL override for a component id. A
 * private build fetches admin-curated links (e.g. affiliate URLs) from its
 * backend at boot and pipes them through here, so links can change without a
 * redeploy. The override wins over the datasheet front-matter; `loadDoc`
 * merges it, so every doc consumer — and the UTM decoration + click tracking
 * built on `doc.buy` — picks it up with no extra wiring.
 */
export function registerBuyLink(id: string, url: string): void {
  buyOverrides.set(id, url);
  cache.delete(id);
}

/** Merge a registered buy-link override into a parsed doc (synthesising an
 * empty-body doc when the component has no datasheet). */
function withBuyOverride(id: string, doc: ComponentDoc | null): ComponentDoc | null {
  const buy = buyOverrides.get(id);
  if (!buy) return doc;
  return { ...(doc ?? { body: '' }), buy };
}

/**
 * Which label the datasheet's outbound link should carry.
 *
 * Most of the catalog's `buy:` URLs really are shop or product pages, so
 * "Product page" is right for them. A few point at the vendor's user guide
 * instead -- for the Espressif dev kits, because the product pages
 * themselves render broken or 404 (see boards/espressif/register.ts) -- and
 * calling a specifications document a product page sends the reader
 * somewhere other than where the button says.
 *
 * Keyed on the DESTINATION rather than on a per-component flag: a docs host
 * is a documentation link whoever set it and however it got there,
 * including links set from /admin.
 */
export function productLinkKind(url: string): 'product' | 'docs' {
  try {
    const h = new URL(url).hostname;
    return h === 'docs.espressif.com' || h === 'github.com' || h.endsWith('.readthedocs.io')
      ? 'docs'
      : 'product';
  } catch {
    return 'product';
  }
}

/**
 * Decorate a datasheet Buy/Product-page URL with UTM attribution so the
 * vendor sees the referral came from Velxio. `componentId` lands in
 * utm_content so partner dashboards can tell WHICH part drove the visit.
 * Existing query params on the vendor URL are preserved.
 */
export function productPageHref(url: string, componentId: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set('utm_source', 'velxio');
    u.searchParams.set('utm_medium', 'simulator');
    u.searchParams.set('utm_campaign', 'datasheet');
    u.searchParams.set('utm_content', componentId);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Split an optional `---`-delimited front-matter block off the top of a
 * Markdown string. Only a leading block counts, so table separators
 * (`| --- |`) and thematic breaks inside the body are never mistaken for it.
 * The parser is deliberately tiny (flat `key: value` pairs only).
 */
function parseDoc(raw: string): ComponentDoc {
  // The closing fence must be a line of exactly `---` (optional trailing
  // spaces) terminated by EOL or EOF — `(?:\r?\n|$)` — so a body line that
  // merely starts with dashes (`--- notes`, `----`) is never mistaken for it.
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!m) return { body: raw };

  const body = raw.slice(m[0].length);
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    // Strip only a *matched* surrounding quote pair, so a value with a single
    // edge quote is left intact rather than mangled.
    const val = line
      .slice(idx + 1)
      .trim()
      .replace(/^"([\s\S]*)"$/, '$1')
      .replace(/^'([\s\S]*)'$/, '$1');
    if (key) meta[key] = val;
  }
  return { body, brand: meta.brand || undefined, buy: meta.buy || undefined };
}

/** True if an authored datasheet exists for this component id. */
export function hasDoc(id: string): boolean {
  return id in byId;
}

/** Load (and cache) the parsed datasheet for a component id, or null if none.
 * A registered buy-link override is merged into the result (and can produce a
 * doc for an id with no .md file — body empty, `buy` set). */
export async function loadDoc(id: string): Promise<ComponentDoc | null> {
  if (cache.has(id)) return cache.get(id) ?? null;
  const loader = byId[id];
  if (!loader) {
    const doc = withBuyOverride(id, null);
    cache.set(id, doc);
    return doc;
  }
  try {
    const doc = withBuyOverride(id, parseDoc(await loader()));
    cache.set(id, doc);
    return doc;
  } catch {
    const doc = withBuyOverride(id, null);
    cache.set(id, doc);
    return doc;
  }
}
