/**
 * SSR entry point for prerendering SEO pages at build time.
 *
 * Used by scripts/prerender-seo.mjs via Vite's ssrLoadModule.
 * Renders each page component to an HTML string so the prerender script
 * can inject it into the static dist/index.html per route.
 */

import React from 'react';
import { renderToString } from 'react-dom/server';
// Initialise i18next with the bundled English resources before any page
// renders: without this every t() call in the SSR output came back as its
// KEY ("landing.hero.titleLine1"), which is what the prerendered bodies
// shipped once they were actually injected.
import './i18n';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { SEO_ROUTES } from './seoRoutes';

// ── SEO page components ─────────────────────────────────────────────────────
import { exampleProjects } from './data/examples';
import { ExamplesPage } from './pages/ExamplesPage';
import { ExampleDetailPage } from './pages/ExampleDetailPage';
import { ImageToCodePage } from './pages/ImageToCodePage';

// Map route paths to their React component. The OSS build prerenders only
// what it ships (the examples gallery); the marketing surface lives in the
// pro overlay and is merged in by loadRouteComponents() below.
/**
 * /editor is the live workspace (Monaco, WASM engines) — nothing there
 * survives renderToString, so its prerender is a static crawlable summary.
 * Being prerendered at all is what matters: nginx then serves /editor/ as
 * a real page and 301s /editor to it, instead of both forms answering 200
 * with the homepage head (Google had indexed the two as separate pages).
 */
const EditorSeoSummary: React.FC = () => (
  <main>
    <h1>Velxio Editor — multi-board circuit and code simulator</h1>
    <p>
      Write, compile and simulate Arduino, ESP32, ESP32-C3, ESP32-S3, Raspberry Pi
      Pico and Raspberry Pi code in your browser, wired to a live circuit canvas
      with SPICE analog simulation. Free, open source, no install and no account
      needed.
    </p>
  </main>
);

const OSS_ROUTE_COMPONENTS: Record<string, React.FC> = {
  '/editor': EditorSeoSummary,
  '/examples': ExamplesPage,
  '/tools/image-to-code': ImageToCodePage,
};

let routeComponents: Record<string, React.FC> = OSS_ROUTE_COMPONENTS;

/**
 * Merge in the overlay's marketing pages (landing, about, docs, the SEO
 * simulator landings). Pro-gated dynamic import — the never-taken branch
 * keeps the OSS build from ever referencing files it does not have, the
 * same pattern main.tsx uses for mountPro. The prerender script awaits
 * this before asking for routes.
 */
export async function loadRouteComponents(): Promise<Record<string, React.FC>> {
  if (import.meta.env.VITE_PRO_BUILD) {
    const m = await import('@pro/pages/marketing');
    routeComponents = { ...OSS_ROUTE_COMPONENTS, ...m.MARKETING_ROUTE_COMPONENTS };
    // The overlay's own namespace ("pro": landing sections, pricing...),
    // else its t() calls render as keys too.
    try {
      const reg = await import('@pro/i18n/register');
      reg.registerProI18n?.();
    } catch (err) {
      console.warn('  ⚠ pro i18n not registered for SSR:', (err as Error).message);
    }
  }
  return routeComponents;
}

/**
 * Returns all routes that have both seoMeta and a renderable component.
 */
export function getPrerenderedRoutes() {
  return SEO_ROUTES.filter((r) => r.seoMeta && routeComponents[r.path]);
}

/**
 * Render a route's page component to an HTML string.
 */
export function render(path: string): string {
  const Component = routeComponents[path];
  if (!Component) return '';

  try {
    return renderToString(
      <MemoryRouter initialEntries={[path]}>
        <Component />
      </MemoryRouter>,
    );
  } catch (err) {
    console.warn(`  ⚠ SSR render failed for ${path}:`, (err as Error).message);
    return '';
  }
}

/**
 * Returns all example routes to prerender, one per example project.
 */
export function getPrerenderedExampleRoutes() {
  return exampleProjects.map((e) => ({
    path: `/examples/${e.id}`,
    title: `${e.title} — Free Arduino Simulator Example | Velxio`,
    description: `${e.description}. Run this example free in your browser — no install, no account required.`,
    url: `https://velxio.dev/examples/${e.id}`,
  }));
}

/**
 * Render an example detail page to an HTML string.
 */
export function renderExample(exampleId: string): string {
  try {
    // Mounted under its real route so useParams() sees exampleId; rendered
    // bare it had no params and every example page SSR'd as "not found".
    return renderToString(
      <MemoryRouter initialEntries={[`/examples/${exampleId}`]}>
        <Routes>
          <Route path="/examples/:exampleId" element={<ExampleDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
  } catch (err) {
    console.warn(`  ⚠ SSR render failed for /examples/${exampleId}:`, (err as Error).message);
    return '';
  }
}
