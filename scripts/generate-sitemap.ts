/**
 * Auto-generates frontend/public/sitemap.xml from seoRoutes.ts
 * Run: npx tsx scripts/generate-sitemap.ts
 * Integrated into: npm run build (via generate:sitemap)
 */

import { writeFileSync } from 'fs';
import { resolve } from 'path';

// Import the single source of truth
import { SEO_ROUTES } from '../frontend/src/seoRoutes';

const DOMAIN = 'https://velxio.dev';
const TODAY = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

const indexableRoutes = SEO_ROUTES.filter((r) => !r.noindex);

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${indexableRoutes
  .map(
    (r) => `
  <url>
    <loc>${DOMAIN}${r.path}</loc>
    <lastmod>${TODAY}</lastmod>
    <changefreq>${r.changefreq ?? 'monthly'}</changefreq>
    <priority>${r.priority ?? 0.5}</priority>
  </url>`
  )
  .join('')}

</urlset>
`;

const outPath = resolve(__dirname, '../frontend/public/sitemap.xml');
writeFileSync(outPath, xml.trimStart(), 'utf-8');
console.log(`sitemap.xml generated → ${indexableRoutes.length} URLs (${TODAY})`);

// Also ping Google & Bing sitemap endpoints (non-blocking, best-effort)
const SITEMAP_URL = `${DOMAIN}/sitemap.xml`;
const PING_URLS = [
  `https://www.google.com/ping?sitemap=${encodeURIComponent(SITEMAP_URL)}`,
  `https://www.bing.com/ping?sitemap=${encodeURIComponent(SITEMAP_URL)}`,
];

if (process.argv.includes('--ping')) {
  console.log('Pinging search engines...');
  Promise.allSettled(
    PING_URLS.map(async (url) => {
      try {
        const res = await fetch(url);
        console.log(`  ${res.ok ? 'OK' : 'FAIL'} ${url.split('?')[0]}`);
      } catch (e: any) {
        console.log(`  FAIL ${url.split('?')[0]}: ${e.message}`);
      }
    })
  );
}
