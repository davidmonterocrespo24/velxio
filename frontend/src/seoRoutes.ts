/**
 * Single source of truth for all public, indexable routes.
 * Used by:
 *  1. scripts/generate-sitemap.ts  → builds sitemap.xml at build time
 *  2. Any component that needs the canonical URL list
 *
 * Routes with `noindex: true` are excluded from the sitemap.
 */

export interface SeoRoute {
  path: string;
  /** 0.0 – 1.0 (default 0.5) */
  priority?: number;
  changefreq?: 'daily' | 'weekly' | 'monthly' | 'yearly';
  /** If true, excluded from sitemap */
  noindex?: boolean;
}

export const SEO_ROUTES: SeoRoute[] = [
  // ── Main pages
  { path: '/',                          priority: 1.0,  changefreq: 'weekly' },
  { path: '/editor',                    priority: 0.9,  changefreq: 'weekly' },
  { path: '/examples',                  priority: 0.8,  changefreq: 'weekly' },

  // ── Documentation
  { path: '/docs',                      priority: 0.8,  changefreq: 'monthly' },
  { path: '/docs/intro',                priority: 0.8,  changefreq: 'monthly' },
  { path: '/docs/getting-started',      priority: 0.8,  changefreq: 'monthly' },
  { path: '/docs/emulator',             priority: 0.7,  changefreq: 'monthly' },
  { path: '/docs/esp32-emulation',      priority: 0.7,  changefreq: 'monthly' },
  { path: '/docs/riscv-emulation',      priority: 0.7,  changefreq: 'monthly' },
  { path: '/docs/rp2040-emulation',     priority: 0.7,  changefreq: 'monthly' },
  { path: '/docs/raspberry-pi3-emulation', priority: 0.7, changefreq: 'monthly' },
  { path: '/docs/components',           priority: 0.7,  changefreq: 'monthly' },
  { path: '/docs/architecture',         priority: 0.7,  changefreq: 'monthly' },
  { path: '/docs/wokwi-libs',           priority: 0.7,  changefreq: 'monthly' },
  { path: '/docs/mcp',                  priority: 0.7,  changefreq: 'monthly' },
  { path: '/docs/setup',                priority: 0.6,  changefreq: 'monthly' },
  { path: '/docs/roadmap',              priority: 0.6,  changefreq: 'monthly' },

  // ── SEO keyword landing pages
  { path: '/arduino-simulator',         priority: 0.9,  changefreq: 'monthly' },
  { path: '/arduino-emulator',          priority: 0.9,  changefreq: 'monthly' },
  { path: '/atmega328p-simulator',      priority: 0.85, changefreq: 'monthly' },
  { path: '/arduino-mega-simulator',    priority: 0.85, changefreq: 'monthly' },
  { path: '/esp32-simulator',           priority: 0.9,  changefreq: 'monthly' },
  { path: '/esp32-s3-simulator',        priority: 0.85, changefreq: 'monthly' },
  { path: '/esp32-c3-simulator',        priority: 0.85, changefreq: 'monthly' },
  { path: '/raspberry-pi-pico-simulator', priority: 0.9, changefreq: 'monthly' },
  { path: '/raspberry-pi-simulator',    priority: 0.85, changefreq: 'monthly' },

  // ── Release pages
  { path: '/v2',                        priority: 0.9,  changefreq: 'monthly' },

  // ── Auth / admin (noindex)
  { path: '/login',                     noindex: true },
  { path: '/register',                  noindex: true },
  { path: '/admin',                     noindex: true },
];
