import { createRoot } from 'react-dom/client';
import { loader } from '@monaco-editor/react';
import './index.css';
// Side-effect import: initialises i18next BEFORE any component renders so
// useTranslation() always resolves against a live instance. Must come
// before App.
import './i18n';
// Side-effect-free on the DOM (index.html already painted the theme) —
// this only subscribes to the OS preference and to sibling velxio.dev tabs.
import { initTheme } from './lib/theme';
import { markProExamplesSettled } from './data/examples';
import { markProRoutesSettled } from './lib/proRoutes';

/** The overlay import has settled (either way): registries are final. */
const markProOverlaySettled = (): void => {
  markProExamplesSettled();
  markProRoutesSettled();
};
import './components/velxio-components/IC74HC595';
import './components/velxio-components/LogicGateElements';
import './components/velxio-components/TransistorElements';
import './components/velxio-components/OpAmpElements';
import './components/velxio-components/PowerElements';
import './components/velxio-components/DiodeElements';
import './components/velxio-components/RelayElements';
import './components/velxio-components/LogicICElements';
import './components/velxio-components/MotorDriverElements';
import './components/velxio-components/FlipFlopElements';
import './components/velxio-components/RaspberryPi3Element';
import './components/velxio-components/Bmp280Element';
import './components/velxio-components/Ds3231Element';
import './components/velxio-components/GpsNeo6mElement';
import './components/velxio-components/EPaperElement';
import App from './App.tsx';

// Configure monaco-editor for offline use via local static assets
const monacoVsPath = `${import.meta.env.BASE_URL}monaco/vs`;
loader.config({ paths: { vs: monacoVsPath } });

// Adopt the stored light/dark preference and start listening for it changing
// elsewhere (the OS, another tab, the docs portal). index.html already put the
// right theme on <html> before the first paint; this keeps it there.
initTheme();

// Every deploy renames the hashed chunks and the old ones are gone from the
// image. A tab opened before the deploy fails its next lazy import with
// "Failed to fetch dynamically imported module" (seen on the flash dialog's
// Rp2WebFlasher chunk right after a deploy). Vite raises this event first;
// reloading once picks up the new index and its chunk names. The timestamp
// guard keeps a genuinely missing chunk from reloading forever.
window.addEventListener('vite:preloadError', (event) => {
  const key = 'velxio-chunk-reload-at';
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(key) || 0);
  } catch {
    /* storage blocked: reload without the guard */
  }
  if (Date.now() - last < 60_000) return; // let the error surface the second time
  try {
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    /* ignore */
  }
  event.preventDefault();
  window.location.reload();
});

createRoot(document.getElementById('root')!).render(<App />);

// Tear down the Tauri-only splash now that React has mounted. Wait
// two animation frames so React's first paint commits before we
// touch the splash — otherwise users see a black flash between the
// splash fading and the editor first appearing. Fade via CSS
// transition for a smoother handoff, then remove the node entirely
// once the transition finishes.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const splash = document.getElementById('velxio-splash');
    if (!splash) return;
    splash.style.transition = 'opacity 250ms ease-out';
    splash.style.opacity = '0';
    splash.style.pointerEvents = 'none';
    window.setTimeout(() => splash.remove(), 320);
  });
});

// Optional pro overlay. The `@pro` import resolves to a no-op stub in the
// open-source build (see vite.config.ts) and to the real overlay only when
// VITE_PRO_BUILD=true at build time. The dynamic import keeps the pro chunk
// out of the OSS bundle entirely (Vite tree-shakes the never-taken branch).
//
// Two desktop modes since v0.4.0:
//   - VITE_PRO_BUILD + VITE_DESKTOP → slim pro entry (@pro/desktop_index)
//     that ONLY mounts the AI agent + DiagnoseCompileButton, no analytics
//     / sessions / billing / admin / save overrides (those talk to
//     velxio.dev with cookies the desktop doesn't have).
//   - VITE_PRO_BUILD only (web) → full mountPro with every surface.
// VITE_DESKTOP alone (no pro) stays a pure-OSS desktop build.
if (import.meta.env.VITE_PRO_BUILD) {
  if (import.meta.env.VITE_DESKTOP) {
    import('@pro/desktop_index')
      .then((m) => m.mountProDesktop?.())
      .catch((err) => console.warn('[pro-desktop] failed to load slim overlay:', err))
      .finally(markProOverlaySettled);
  } else {
    import('@pro/index')
      .then((m) => m.mountPro?.())
      .catch((err) => console.warn('[pro] failed to load overlay:', err))
      .finally(markProOverlaySettled);
  }
} else {
  // No overlay is coming: what the registries have now is all there will be.
  markProOverlaySettled();
}

// Desktop-only hooks (ESP32 QEMU prompt now, welcome screen in Phase 3).
// Dynamic import so the OSS bundle never pulls this in.
if (import.meta.env.VITE_DESKTOP) {
  import('./desktop/index')
    .then((m) => m.mountDesktop?.())
    .catch((err) => console.warn('[desktop] failed to load hooks:', err));
}

// DEV-only: expose the core stores for E2E harnesses (the platform-bugs QA
// harness drives the STORE paths — property updates, group switches — the
// way the agent tools do, which raw DOM access cannot reach). Guarded by
// import.meta.env.DEV so production bundles never ship it.
if (import.meta.env.DEV) {
  Promise.all([
    import('./store/useSimulatorStore'),
    import('./store/useEditorStore'),
    import('./store/useElectricalStore'),
    import('./store/useOscilloscopeStore'),
  ]).then(([sim, ed, el, osc]) => {
    (window as unknown as Record<string, unknown>).__velxioStores = {
      useSimulatorStore: sim.useSimulatorStore,
      useEditorStore: ed.useEditorStore,
      useElectricalStore: el.useElectricalStore,
      useOscilloscopeStore: osc.useOscilloscopeStore,
      getBoardSimulator: sim.getBoardSimulator,
    };
  });
}
