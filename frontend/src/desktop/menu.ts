/**
 * Native menubar event bridge.
 *
 * The Tauri shell (pro/desktop/src-tauri/src/menu.rs in velxio-prod)
 * builds a Velxio / File / Edit / View / Help menubar. Internal items
 * (Save .vlx, Open .vlx, Toggle Serial Monitor, Find, …) emit a
 * `velxio://menu` event with `{ action: '<id>' }`. URL items (Docs,
 * Examples, Discord, GitHub) are opened directly from Rust and don't
 * reach this listener.
 *
 * Actions handled directly here (no further plumbing needed):
 *   - save-vlx, open-vlx     → triggerDownloadVlx / file picker
 *   - toggle-serial-monitor  → useSimulatorStore.toggleSerialMonitor()
 *   - check-for-updates      → tauri-plugin-updater check()
 *
 * Actions forwarded to whoever's listening as a window CustomEvent
 * `velxio:menu:<action>`:
 *   - new-project, find-in-editor, toggle-file-explorer
 *
 * No-op outside Tauri (e.g. running the bundle in a regular browser
 * for debugging) — listen() returns a no-op when the global event
 * API isn't present.
 */

import { listen } from './tauriBridge';
import { describeError } from './describeError';
import { MANUAL_CHECK_EVENT } from './UpdateAvailableToast';
import { dlog } from './log';
import { triggerDownloadVlx, importVlxFile } from '../utils/vlxFile';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useOscilloscopeStore } from '../store/useOscilloscopeStore';
import { useEditorStore } from '../store/useEditorStore';
import { useProjectStore } from '../store/useProjectStore';
import { useCompileLogsStore } from '../store/useCompileLogsStore';
import { showMessageDialog } from '../store/useMessageDialogStore';
import { switchLocale } from '../i18n/path';
import { LOCALES, type Locale } from '../i18n/config';

type MenuAction =
  | 'new-project'
  | 'save-vlx'
  | 'open-vlx'
  | 'find-in-editor'
  | 'toggle-file-explorer'
  | 'toggle-serial-monitor'
  | 'check-for-updates'
  | 'set-locale'
  | 'navigate-route';

interface MenuEventPayload {
  action: MenuAction;
  // Only present when action='set-locale'. Matches an entry in
  // i18n/config.ts::LOCALES.
  locale?: string;
  // Only present when action='navigate-route'. Absolute pathname
  // (e.g. '/examples', '/docs', '/about') — navigated via React
  // Router so the current locale prefix gets applied.
  route?: string;
}

let installed = false;

export async function installDesktopMenuListener(): Promise<void> {
  if (installed) return;
  installed = true;
  await listen<MenuEventPayload>('velxio://menu', (event) => {
    dlog('menu event', event.payload);
    void handle(event.payload.action, event.payload);
  });
}

async function handle(action: MenuAction, payload?: MenuEventPayload): Promise<void> {
  switch (action) {
    case 'save-vlx':
      triggerDownloadVlx();
      return;
    case 'open-vlx':
      pickAndImportVlx();
      return;
    case 'toggle-serial-monitor':
      useSimulatorStore.getState().toggleSerialMonitor();
      return;
    case 'new-project':
      newProject();
      return;
    case 'find-in-editor':
    case 'toggle-file-explorer':
      window.dispatchEvent(new CustomEvent(`velxio:menu:${action}`));
      return;
    case 'check-for-updates':
      checkForUpdates();
      return;
    case 'set-locale':
      if (payload?.locale) setLocale(payload.locale);
      return;
    case 'navigate-route':
      if (payload?.route) navigateTo(payload.route);
      return;
  }
}

function navigateTo(route: string): void {
  // Prefix with the current locale if we're on a non-default one,
  // so `/examples` from `/es/editor` lands at `/es/examples` instead
  // of switching back to English. Mirrors how LanguageSwitcher does it.
  const cur = window.location.pathname;
  const localeMatch = cur.match(/^\/([a-z]{2}(?:-[a-z]{2})?)\b/);
  const prefix = localeMatch && LOCALES.includes(localeMatch[1] as Locale)
    ? `/${localeMatch[1]}`
    : '';
  const normalised = route.startsWith('/') ? route : `/${route}`;
  const next = `${prefix}${normalised}`;
  if (next === cur) return;
  // history.pushState + popstate keeps React Router happy without
  // reloading the SPA (Monaco state, simulator state, sidecar
  // connection all preserved).
  window.history.pushState(null, '', next);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function setLocale(locale: string): void {
  // Defensive: ignore unknown locales coming from the menu so a
  // stale shell doesn't navigate to a broken URL.
  if (!(LOCALES as readonly string[]).includes(locale)) {
    dlog('set-locale: ignoring unknown locale', { locale });
    return;
  }
  const target = locale as Locale;
  const next =
    switchLocale(window.location.pathname, target) +
    window.location.search +
    window.location.hash;
  if (next === window.location.pathname + window.location.search + window.location.hash) {
    return;
  }
  // history.pushState + popstate lets React Router pick the change up
  // without a full reload, preserving the editor state. Reload would
  // re-spawn the sidecar handshake and lose Monaco/sim state for ~5s.
  window.history.pushState(null, '', next);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function pickAndImportVlx(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.vlx,application/json';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (file) {
      try {
        await importVlxFile(file);
      } catch (err) {
        showMessageDialog(`Failed to open .vlx: ${describeError(err)}`, {
          kind: 'error',
        });
      }
    }
    document.body.removeChild(input);
  });
  input.click();
}

/**
 * Wipe the current workspace and start from the default Blink sketch +
 * empty canvas. Issue #210: the menu action used to just dispatch a
 * CustomEvent that nobody listened to.
 *
 * Confirms first if the user has unsaved changes (any modified file
 * or any component on the canvas). The Tauri-side menu can't show a
 * confirm dialog cheaply, so we use the browser-native `confirm()`
 * here — fine for the desktop bundle where it renders as a modal.
 */
function newProject(): void {
  const sim = useSimulatorStore.getState();
  const editor = useEditorStore.getState();
  const project = useProjectStore.getState();
  const compileLogs = useCompileLogsStore.getState();

  const hasWork =
    sim.boards.length > 0 ||
    sim.components.length > 0 ||
    sim.wires.length > 0 ||
    editor.files.some((f) => f.modified) ||
    project.currentProject !== null;

  if (hasWork) {
    const ok = window.confirm(
      'Start a new project? Any unsaved changes will be lost.',
    );
    if (!ok) return;
  }

  // Stop any running simulation first so workers / bridges shut down
  // cleanly. Idempotent — no-op if nothing is running.
  if (sim.running) {
    sim.stopSimulation();
  }

  // Drop every board (also disconnects its bridges + removes wires
  // touching it). Iterate over a snapshot copy since removeBoard
  // mutates the array.
  for (const board of [...sim.boards]) {
    sim.removeBoard(board.id);
  }

  // Any non-board components + wires that weren't connected to a
  // board still need to go.
  sim.setComponents([]);
  sim.setWires([]);
  // And the scope's channels: on an empty canvas no net holds the pins they
  // were probed at, so nothing else would ever clear them
  // (velxio/velxio-prod#119).
  useOscilloscopeStore.getState().resetChannels();

  // Reset the editor to the default Blink sketch. loadFiles takes
  // a {name, content}[] and rebuilds the file list, picking the
  // first .ino as active.
  editor.loadFiles([
    {
      name: 'sketch.ino',
      content:
        '// Arduino Blink Example\nvoid setup() {\n  pinMode(LED_BUILTIN, OUTPUT);\n}\n\nvoid loop() {\n  digitalWrite(LED_BUILTIN, HIGH);\n  delay(1000);\n  digitalWrite(LED_BUILTIN, LOW);\n  delay(1000);\n}\n',
    },
  ]);

  // Drop project metadata so the next Save .vlx doesn't reuse the
  // previous project's slug / name.
  project.clearCurrentProject();

  // Clear the compile output panel so old build logs don't carry over.
  compileLogs.clear();

  // Leave whatever project URL we were on: staying there would reload the
  // OLD project over this fresh workspace on refresh. replaceState (not
  // navigateTo's pushState) so the back button can't pop to the stale
  // project URL either; the popstate dispatch lets React Router render
  // the plain editor route.
  const cur = window.location.pathname;
  const localeMatch = cur.match(/^\/([a-z]{2}(?:-[a-z]{2})?)\b/);
  const prefix = localeMatch && LOCALES.includes(localeMatch[1] as Locale)
    ? `/${localeMatch[1]}`
    : '';
  const editorPath = `${prefix}/editor`;
  if (cur !== editorPath) {
    window.history.replaceState(null, '', editorPath);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
}

/**
 * Hand the request to <UpdateAvailableToast>, which owns the update UI:
 * it asks before downloading, shows progress, and reports failures.
 *
 * This used to run its own check and call `downloadAndInstall()` straight
 * away — ~100 MB fetched and the app relaunched with no prompt and no
 * progress, while the automatic check politely asked first. Two code
 * paths, two behaviours; now there is one.
 */
function checkForUpdates(): void {
  window.dispatchEvent(new Event(MANUAL_CHECK_EVENT));
}
