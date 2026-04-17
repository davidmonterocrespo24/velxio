#!/usr/bin/env node
/**
 * prerender-seo.mjs — Generates route-specific HTML for SEO-important pages.
 *
 * How it works:
 * 1. Starts a Vite dev server in SSR mode (no HTTP server, just the transform pipeline)
 * 2. Loads src/entry-server.tsx through Vite — handles TSX, CSS, SVG, path aliases
 * 3. For each route with seoMeta in seoRoutes.ts:
 *    a. Renders the React component to HTML via renderToString
 *    b. Replaces <title>, <meta>, OG/Twitter tags, canonical URL from seoMeta
 *    c. Injects the rendered HTML into #root-seo
 * 4. Writes to dist/{route}/index.html
 *
 * nginx's try_files ($uri/) serves these automatically.
 *
 * Run after `vite build`: node scripts/prerender-seo.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, '..', 'dist');

// Check that dist exists (vite build must have run first)
if (!existsSync(join(distDir, 'index.html'))) {
  console.error('❌ dist/index.html not found. Run `vite build` first.');
  process.exit(1);
}

const baseHtml = readFileSync(join(distDir, 'index.html'), 'utf-8');
const DOMAIN = 'https://velxio.dev';

// ── Mock browser globals for SSR ────────────────────────────────────────────
// Zustand's persist middleware and some components access these at import time.
if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    length: 0,
    key: () => null,
  };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}
if (typeof globalThis.navigator === 'undefined') {
  globalThis.navigator = { userAgent: 'prerender-seo' };
}
if (typeof globalThis.matchMedia === 'undefined') {
  globalThis.matchMedia = () => ({ matches: false, addListener: () => {}, removeListener: () => {} });
}

// ── Start Vite in SSR mode ──────────────────────────────────────────────────
console.log('🔧 Starting Vite SSR transform pipeline...');

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'warn',
});

let generated = 0;

try {
  // Load entry-server.tsx through Vite's transform pipeline
  const { getPrerenderedRoutes, render, getPrerenderedExampleRoutes, renderExample } =
    await vite.ssrLoadModule('/src/entry-server.tsx');

  const routes = getPrerenderedRoutes();
  const exampleRoutes = getPrerenderedExampleRoutes();

  console.log(`📄 Prerendering ${routes.length} SEO pages + ${exampleRoutes.length} example pages...\n`);

  for (const route of routes) {
    const { seoMeta } = route;
    if (!seoMeta) continue;

    // Render the React component to HTML
    let bodyHtml = render(route.path);

    // Build the page HTML
    let html = baseHtml;

    // Replace <title>
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${seoMeta.title}</title>`);

    // Replace meta description
    html = html.replace(
      /<meta name="description" content="[^"]*"/,
      `<meta name="description" content="${seoMeta.description}"`
    );

    // Add/replace canonical URL
    const canonicalTag = `<link rel="canonical" href="${seoMeta.url}" />`;
    if (html.includes('<link rel="canonical"')) {
      html = html.replace(/<link rel="canonical"[^>]*\/>/, canonicalTag);
    } else {
      html = html.replace('</head>', `  ${canonicalTag}\n  </head>`);
    }

    // Replace OG tags
    html = html.replace(
      /<meta property="og:title" content="[^"]*"/,
      `<meta property="og:title" content="${seoMeta.title}"`
    );
    html = html.replace(
      /<meta property="og:description" content="[^"]*"/,
      `<meta property="og:description" content="${seoMeta.description}"`
    );
    html = html.replace(
      /<meta property="og:url" content="[^"]*"/,
      `<meta property="og:url" content="${seoMeta.url}"`
    );

    // Replace Twitter tags
    html = html.replace(
      /<meta name="twitter:title" content="[^"]*"/,
      `<meta name="twitter:title" content="${seoMeta.title}"`
    );
    html = html.replace(
      /<meta name="twitter:description" content="[^"]*"/,
      `<meta name="twitter:description" content="${seoMeta.description}"`
    );

    // Replace #root-seo content with SSR-rendered body (or fallback to title+description)
    const seoBody = bodyHtml
      ? bodyHtml
      : `<h1>${seoMeta.title.split(' | ')[0]}</h1><p>${seoMeta.description}</p>`;

    html = html.replace(
      /<div id="root-seo"[^>]*>[\s\S]*?<\/div>\s*<script/,
      `<div id="root-seo" aria-hidden="true">${seoBody}</div>\n    <script`
    );

    // Write to dist/{path}/index.html
    const routePath = route.path === '/' ? '' : route.path.slice(1);
    if (routePath) {
      const dir = join(distDir, routePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'index.html'), html, 'utf-8');
    } else {
      // Root — update dist/index.html in place
      writeFileSync(join(distDir, 'index.html'), html, 'utf-8');
    }

    generated++;
    const ssrStatus = bodyHtml ? '✓' : '⚠ (meta only)';
    console.log(`  ${ssrStatus} ${route.path}`);
  }

  // ── Prerender example detail pages ──────────────────────────────────────────
  console.log('\n📦 Prerendering example pages...\n');
  let examplesGenerated = 0;

  for (const exRoute of exampleRoutes) {
    const exampleId = exRoute.path.split('/').pop();
    let bodyHtml = renderExample(exampleId);

    let html = baseHtml;

    html = html.replace(/<title>[^<]*<\/title>/, `<title>${exRoute.title}</title>`);
    html = html.replace(
      /<meta name="description" content="[^"]*"/,
      `<meta name="description" content="${exRoute.description}"`
    );

    const canonicalTag = `<link rel="canonical" href="${exRoute.url}" />`;
    if (html.includes('<link rel="canonical"')) {
      html = html.replace(/<link rel="canonical"[^>]*\/>/, canonicalTag);
    } else {
      html = html.replace('</head>', `  ${canonicalTag}\n  </head>`);
    }

    html = html.replace(/<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${exRoute.title}"`);
    html = html.replace(/<meta property="og:description" content="[^"]*"/, `<meta property="og:description" content="${exRoute.description}"`);
    html = html.replace(/<meta property="og:url" content="[^"]*"/, `<meta property="og:url" content="${exRoute.url}"`);
    html = html.replace(/<meta name="twitter:title" content="[^"]*"/, `<meta name="twitter:title" content="${exRoute.title}"`);
    html = html.replace(/<meta name="twitter:description" content="[^"]*"/, `<meta name="twitter:description" content="${exRoute.description}"`);

    const seoBody = bodyHtml || `<h1>${exRoute.title.split(' — ')[0]}</h1><p>${exRoute.description}</p>`;
    html = html.replace(
      /<div id="root-seo"[^>]*>[\s\S]*?<\/div>\s*<script/,
      `<div id="root-seo" aria-hidden="true">${seoBody}</div>\n    <script`
    );

    const dir = join(distDir, 'examples', exampleId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), html, 'utf-8');

    examplesGenerated++;
    const ssrStatus = bodyHtml ? '✓' : '⚠ (meta only)';
    if (examplesGenerated <= 5 || examplesGenerated % 20 === 0) {
      console.log(`  ${ssrStatus} /examples/${exampleId}`);
    }
  }
  if (exampleRoutes.length > 5) {
    console.log(`  ... (${examplesGenerated} total)`);
  }
  generated += examplesGenerated;

  // Also ensure root index.html has a canonical tag
  let rootHtml = readFileSync(join(distDir, 'index.html'), 'utf-8');
  const rootCanonical = `<link rel="canonical" href="${DOMAIN}/" />`;
  if (!rootHtml.includes('<link rel="canonical"')) {
    rootHtml = rootHtml.replace('</head>', `  ${rootCanonical}\n  </head>`);
    writeFileSync(join(distDir, 'index.html'), rootHtml, 'utf-8');
  }

} finally {
  await vite.close();
}

console.log(`\n✅ Prerendered ${generated} SEO pages with SSR content`);
