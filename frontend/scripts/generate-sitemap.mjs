/**
 * Auto-generates public/sitemap.xml by parsing seoRoutes.ts
 * Pure Node.js — no tsx/ts-node needed.
 * Run: node scripts/generate-sitemap.mjs [--ping]
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOMAIN = 'https://velxio.dev';
const TODAY = new Date().toISOString().slice(0, 10);

// Extract top-level ExampleProject ids from examples.ts.
// Top-level ids are indented with exactly 4 spaces; component/wire ids use 8+.
function parseExampleIds(source) {
  const ids = [];
  const re = /^ {4}id: '([^']+)'/gm;
  let m;
  while ((m = re.exec(source)) !== null) {
    ids.push(m[1]);
  }
  return ids;
}

// Parse a route-table source file and evaluate the literal array bound to
// `name` (safe: the arrays hold only string/number/boolean literals).
// Comments are stripped first; DOMAIN is injected so template literals like
// `${DOMAIN}/path` resolve.
function parseRouteArray(path, name) {
  const source = readFileSync(path, 'utf-8');
  const match = source.match(new RegExp(`${name}[^=]*=\\s*\\[([\\s\\S]*?)\\];`));
  if (!match) {
    console.error(`Could not parse ${name} from ${path}`);
    process.exit(1);
  }
  const arrayStr = match[1]
    .replace(/\/\/.*$/gm, '')   // remove line comments
    .replace(/\/\*[\s\S]*?\*\//g, ''); // remove block comments
  return new Function('DOMAIN', `return [${arrayStr}]`)(DOMAIN);
}

// seoRoutes.ts binds the literal table to OSS_SEO_ROUTES and exports
// SEO_ROUTES = [...OSS_SEO_ROUTES, ...PRO_SEO_ROUTES].
const routes = parseRouteArray(resolve(__dirname, '../src/seoRoutes.ts'), 'OSS_SEO_ROUTES');

// The overlay's own SEO routes (per-board simulator landings) are spread into
// SEO_ROUTES through the `@pro/seoRoutes` alias, which this text parser cannot
// follow — read the overlay file directly, as for proExamples below.
if (process.env.VITE_PRO_BUILD && process.env.PRO_OVERLAY_PATH) {
  const proRoutesPath = resolve(process.env.PRO_OVERLAY_PATH, 'seoRoutes.ts');
  if (existsSync(proRoutesPath)) {
    routes.push(...parseRouteArray(proRoutesPath, 'PRO_SEO_ROUTES'));
  }
}

const indexable = routes.filter((r) => !r.noindex);

// Parse example project IDs and add /examples/:id URLs.
// Reads both examples.ts (legacy) and examples-circuits.ts (analog/digital/
// electromech examples added in circuitExamples).
const examplesSource = readFileSync(resolve(__dirname, '../src/data/examples.ts'), 'utf-8');
const circuitSource  = readFileSync(resolve(__dirname, '../src/data/examples-circuits.ts'), 'utf-8');
const exampleIds = [
  ...parseExampleIds(examplesSource),
  ...parseExampleIds(circuitSource),
];

// Pro overlay examples (e.g. the Pico W WiFi showcase) live in
// <PRO_OVERLAY_PATH>/data/proExamples.ts and are spread into examples.ts via the
// `@pro` alias at build time. This script parses example IDs from source TEXT
// (it never executes the module), so it can't follow the alias — read the
// overlay file directly when building with the overlay. OSS builds skip this.
if (process.env.VITE_PRO_BUILD && process.env.PRO_OVERLAY_PATH) {
  try {
    const proSource = readFileSync(
      resolve(process.env.PRO_OVERLAY_PATH, 'data/proExamples.ts'),
      'utf-8',
    );
    exampleIds.push(...parseExampleIds(proSource));
  } catch {
    // No overlay examples file — nothing to add.
  }
}

// The overlay's say in which of them the sitemap lists (velxio/velxio-prod#31,
// #68): <PRO_OVERLAY_PATH>/sitemap.mjs may export sitemapExampleIds(ids), the
// ids to list of those found (an example the overlay's gallery hides keeps its
// page, but is not promoted). No hook, the default: every example.
let sitemapExampleIds = (ids) => ids;
if (process.env.VITE_PRO_BUILD && process.env.PRO_OVERLAY_PATH) {
  const hookPath = resolve(process.env.PRO_OVERLAY_PATH, 'sitemap.mjs');
  if (existsSync(hookPath)) {
    const hook = await import(pathToFileURL(hookPath).href);
    if (typeof hook.sitemapExampleIds === 'function') sitemapExampleIds = hook.sitemapExampleIds;
  }
}
const listedExampleIds = sitemapExampleIds(exampleIds);

const exampleUrls = listedExampleIds.map((id) => ({
  loc: `${DOMAIN}/examples/${id}`,
  changefreq: 'monthly',
  priority: 0.6,
}));

// No <lastmod>: this runs at build time with no per-page history to draw
// on, so every URL used to carry the build date. A lastmod that changes on
// every deploy for every page is provably unreliable and search engines
// discard the whole signal; omitting it is the honest option (the projects
// sitemap, which has real updated_at timestamps, keeps its lastmod).

// Every <loc> carries a trailing slash. nginx serves the prerendered route
// files as `<route>/index.html` and 301-redirects the slash-less form to add
// the slash, so a slash-less sitemap URL is fetched as a redirect and filed
// under "Page with redirect" in Search Console. Matching the served (slash)
// form keeps the sitemap URL == canonical == 200, with no redirect hop.
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${indexable
  .map(
    (r) => `
  <url>
    <loc>${DOMAIN}${r.path}${r.path.endsWith('/') ? '' : '/'}</loc>
    <changefreq>${r.changefreq ?? 'monthly'}</changefreq>
    <priority>${r.priority ?? 0.5}</priority>
  </url>`
  )
  .join('')}
${exampleUrls
  .map(
    (u) => `
  <url>
    <loc>${u.loc}/</loc>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`
  )
  .join('')}

</urlset>
`;

const outPath = resolve(__dirname, '../public/sitemap.xml');
writeFileSync(outPath, xml.trimStart(), 'utf-8');
console.log(`sitemap.xml generated → ${indexable.length + listedExampleIds.length} URLs (${TODAY}) [${indexable.length} routes + ${listedExampleIds.length} examples]`);

// Ping search engines (optional)
if (process.argv.includes('--ping')) {
  const sitemapUrl = `${DOMAIN}/sitemap.xml`;
  const pings = [
    `https://www.google.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`,
    `https://www.bing.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`,
  ];
  console.log('Pinging search engines...');
  await Promise.allSettled(
    pings.map(async (url) => {
      try {
        const res = await fetch(url);
        console.log(`  ${res.ok ? 'OK' : 'FAIL'} ${url.split('?')[0]}`);
      } catch (e) {
        console.log(`  FAIL ${url.split('?')[0]}: ${e.message}`);
      }
    })
  );
}
