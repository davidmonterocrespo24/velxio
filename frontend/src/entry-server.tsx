/**
 * SSR entry point for prerendering SEO pages at build time.
 *
 * Used by scripts/prerender-seo.mjs via Vite's ssrLoadModule.
 * Renders each page component to an HTML string so the prerender script
 * can inject it into the static dist/index.html per route.
 */

import React from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { SEO_ROUTES } from './seoRoutes';

// ── SEO page components ─────────────────────────────────────────────────────
import { exampleProjects } from './data/examples';
import { LandingPage } from './pages/LandingPage';
import { ExamplesPage } from './pages/ExamplesPage';
import { ArduinoSimulatorPage } from './pages/ArduinoSimulatorPage';
import { ArduinoEmulatorPage } from './pages/ArduinoEmulatorPage';
import { AtmegaSimulatorPage } from './pages/AtmegaSimulatorPage';
import { ArduinoMegaSimulatorPage } from './pages/ArduinoMegaSimulatorPage';
import { Esp32SimulatorPage } from './pages/Esp32SimulatorPage';
import { Esp32S3SimulatorPage } from './pages/Esp32S3SimulatorPage';
import { Esp32C3SimulatorPage } from './pages/Esp32C3SimulatorPage';
import { RaspberryPiPicoSimulatorPage } from './pages/RaspberryPiPicoSimulatorPage';
import { RaspberryPiSimulatorPage } from './pages/RaspberryPiSimulatorPage';
import { Velxio2Page } from './pages/Velxio2Page';
import { DocsPage } from './pages/DocsPage';
import { ExampleDetailPage } from './pages/ExampleDetailPage';

// Map route paths to their React component
const ROUTE_COMPONENTS: Record<string, React.FC> = {
  '/': LandingPage,
  '/examples': ExamplesPage,
  '/arduino-simulator': ArduinoSimulatorPage,
  '/arduino-emulator': ArduinoEmulatorPage,
  '/atmega328p-simulator': AtmegaSimulatorPage,
  '/arduino-mega-simulator': ArduinoMegaSimulatorPage,
  '/esp32-simulator': Esp32SimulatorPage,
  '/esp32-s3-simulator': Esp32S3SimulatorPage,
  '/esp32-c3-simulator': Esp32C3SimulatorPage,
  '/raspberry-pi-pico-simulator': RaspberryPiPicoSimulatorPage,
  '/raspberry-pi-simulator': RaspberryPiSimulatorPage,
  '/v2': Velxio2Page,
  // Docs sections — all use DocsPage with different URL params
  '/docs': DocsPage,
  '/docs/intro': DocsPage,
  '/docs/getting-started': DocsPage,
  '/docs/emulator': DocsPage,
  '/docs/esp32-emulation': DocsPage,
  '/docs/riscv-emulation': DocsPage,
  '/docs/rp2040-emulation': DocsPage,
  '/docs/raspberry-pi3-emulation': DocsPage,
  '/docs/components': DocsPage,
  '/docs/architecture': DocsPage,
  '/docs/wokwi-libs': DocsPage,
  '/docs/mcp': DocsPage,
  '/docs/setup': DocsPage,
  '/docs/roadmap': DocsPage,
};

/**
 * Returns all routes that have both seoMeta and a renderable component.
 */
export function getPrerenderedRoutes() {
  return SEO_ROUTES.filter(r => r.seoMeta && ROUTE_COMPONENTS[r.path]);
}

/**
 * Render a route's page component to an HTML string.
 */
export function render(path: string): string {
  const Component = ROUTE_COMPONENTS[path];
  if (!Component) return '';

  try {
    return renderToString(
      <MemoryRouter initialEntries={[path]}>
        <Component />
      </MemoryRouter>
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
    return renderToString(
      <MemoryRouter initialEntries={[`/examples/${exampleId}`]}>
        <ExampleDetailPage />
      </MemoryRouter>
    );
  } catch (err) {
    console.warn(`  ⚠ SSR render failed for /examples/${exampleId}:`, (err as Error).message);
    return '';
  }
}
