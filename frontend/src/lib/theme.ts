/* Theme mode — the app half of the velxio.dev-wide light/dark preference.
 *
 * ── The cross-site contract ──────────────────────────────────────────────
 * The simulator (this app), the blog (/blog/) and the docs portal (/docs/)
 * are three separate builds served from ONE origin, which is what makes the
 * sync possible at all: they share a localStorage jar. The contract is:
 *
 *   key    'velxio-theme'
 *   value  'dark' | 'light' | 'system'      ← the PREFERENCE, not the result
 *   unset  means 'dark'                      ← velxio.dev is dark by default,
 *                                              regardless of what the OS says
 *
 * Whoever changes the preference also writes the two keys the other two
 * sites' own toggles read, so their native switches stay in sync instead of
 * fighting us:
 *
 *   'starlight-theme'  the docs portal (Starlight), same vocabulary but it
 *                      spells "system" as "auto"
 *   'theme'            the blog, which only understands a RESOLVED value
 *
 * Reading works the same way in reverse: a reader who flips the docs to
 * light and then opens the simulator lands in light. See MIRRORS below.
 *
 * ── Why the OS preference is not the default ─────────────────────────────
 * A simulator is a dark-room tool and the product's identity is dark, so an
 * unset preference is dark even on a machine set to light. `system` is a
 * third, opt-in mode — never the fallback.
 */

import { decodeWorkspaceTheme, workspaceThemeVariables, type WorkspaceTheme } from './workspaceTheme';

export type ThemeMode = 'dark' | 'light' | 'system';
/** What `system` resolves to. This is what lands on `<html data-theme>`. */
export type ResolvedTheme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'velxio-theme';
const WORKSPACE_THEMES_KEY = 'velxio-workspace-themes';

/** Storage keys owned by the other two velxio.dev surfaces. Kept in sync on
 *  every change so their built-in toggles show the right state. */
const MIRROR_STARLIGHT = 'starlight-theme';
const MIRROR_BLOG = 'theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function isMode(v: unknown): v is ThemeMode {
  return v === 'dark' || v === 'light' || v === 'system';
}

/** Read a key without letting a locked-down browser (Safari private mode,
 *  "block all cookies") throw on the way in. */
function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage denied — the theme still applies for this page's lifetime */
  }
}

/** The stored preference, falling back to the sibling sites' keys before
 *  giving up and calling it dark. */
export function readStoredMode(): ThemeMode {
  const own = readKey(THEME_STORAGE_KEY);
  if (isMode(own)) return own;

  // Docs portal: same vocabulary, different word for "system".
  const starlight = readKey(MIRROR_STARLIGHT);
  if (starlight === 'auto') return 'system';
  if (isMode(starlight)) return starlight;

  // Blog: only ever stores a resolved value.
  const blog = readKey(MIRROR_BLOG);
  if (blog === 'dark' || blog === 'light') return blog;

  return 'dark';
}

export function systemPrefers(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

export function resolveMode(mode: ThemeMode): ResolvedTheme {
  return mode === 'system' ? systemPrefers() : mode;
}

// ── Reading tokens from JS ──────────────────────────────────────────────
// Anything painted outside CSS's reach — a 2D canvas, a Monaco theme, an
// inline SVG attribute — needs the token's VALUE, not its name. Resolving a
// custom property means a getComputedStyle call, which forces style recalc,
// so results are cached and the cache is dropped whenever the theme moves.

const varCache = new Map<string, string>();

/** Resolved value of a CSS custom property, e.g. cssVar('--wb-6'). */
export function cssVar(name: string, fallback = '#000'): string {
  const hit = varCache.get(name);
  if (hit !== undefined) return hit;
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const out = v || fallback;
  varCache.set(name, out);
  return out;
}

/** Paint the resolved theme onto the document and tell the browser which
 *  scheme its own widgets (scrollbars, form controls, the caret) should use. */
const paintedVariables = new Set<string>();

function paint(resolved: ResolvedTheme, theme: WorkspaceTheme | null): void {
  if (typeof document === 'undefined') return;
  varCache.clear();
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.style.colorScheme = resolved;
  for (const name of paintedVariables) root.style.removeProperty(name);
  paintedVariables.clear();
  if (theme) {
    for (const [name, value] of Object.entries(workspaceThemeVariables(theme))) {
      root.style.setProperty(name, value);
      paintedVariables.add(name);
    }
  }

  // The address-bar tint on mobile. Matches --color-bg-canvas per theme.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const fallback = resolved === 'light' ? '#f5f5f7' : '#0a0a0c';
    meta.setAttribute('content', root.style.getPropertyValue('--color-bg-canvas') || fallback);
  }
}

// ── Subscribable state ──────────────────────────────────────────────────
// A plain module store rather than Zustand: index.html has already applied a
// theme before React exists, so the source of truth is the DOM + storage, and
// React only needs to be told when it changes (useSyncExternalStore).

let currentMode: ThemeMode = 'dark';
let currentResolved: ResolvedTheme = 'dark';
interface WorkspaceThemes {
  themes: readonly WorkspaceTheme[];
  active: string | null;
}
export const EMPTY_WORKSPACE_THEMES: WorkspaceThemes = { themes: [], active: null };
let workspaceThemes = EMPTY_WORKSPACE_THEMES;
let preview: WorkspaceTheme | null = null;
let themeRevision = 0;
const listeners = new Set<() => void>();

function refresh(): void {
  const theme = getActiveWorkspaceTheme();
  currentResolved = theme?.base ?? resolveMode(currentMode);
  paint(currentResolved, theme);
  themeRevision += 1;
  for (const l of listeners) l();
}

export function getMode(): ThemeMode {
  return currentMode;
}

export function getResolvedTheme(): ResolvedTheme {
  return currentResolved;
}

export function getThemeRevision(): number {
  return themeRevision;
}

export function getWorkspaceThemes(): WorkspaceThemes {
  return workspaceThemes;
}

export function getActiveWorkspaceTheme(): WorkspaceTheme | null {
  return preview ?? workspaceThemes.themes.find((item) => item.name === workspaceThemes.active) ?? null;
}

function readWorkspaceThemes(): WorkspaceThemes {
  const raw = readKey(WORKSPACE_THEMES_KEY);
  if (!raw) return EMPTY_WORKSPACE_THEMES;
  try {
    const stored = JSON.parse(raw);
    if (!Array.isArray(stored?.themes)) return EMPTY_WORKSPACE_THEMES;
    const unique = new Map<string, WorkspaceTheme>();
    for (const value of stored.themes) {
      const theme = decodeWorkspaceTheme(value);
      if (theme) unique.set(theme.name, theme);
    }
    return {
      themes: [...unique.values()],
      active: typeof stored.active === 'string' && unique.has(stored.active) ? stored.active : null,
    };
  } catch {
    return EMPTY_WORKSPACE_THEMES;
  }
}

function saveWorkspaceThemes(state: WorkspaceThemes): void {
  workspaceThemes = state;
  writeKey(WORKSPACE_THEMES_KEY, JSON.stringify(state));
}

export function previewWorkspaceTheme(theme: WorkspaceTheme | null): void {
  if (theme === preview) return;
  preview = theme;
  refresh();
}

export function applyWorkspaceTheme(theme: WorkspaceTheme): void {
  const themes = new Map(workspaceThemes.themes.map((item) => [item.name, item]));
  themes.set(theme.name, theme);
  preview = null;
  saveWorkspaceThemes({ themes: [...themes.values()], active: theme.name });
  refresh();
}

export function resetWorkspaceTheme(): void {
  preview = null;
  if (workspaceThemes.active) saveWorkspaceThemes({ ...workspaceThemes, active: null });
  refresh();
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Apply a mode, persist it, and mirror it to the blog and docs keys. */
export function setThemeMode(mode: ThemeMode): void {
  preview = null;
  if (workspaceThemes.active) saveWorkspaceThemes({ ...workspaceThemes, active: null });
  writeMode(mode);
}

function writeMode(mode: ThemeMode): void {
  currentMode = mode;

  writeKey(THEME_STORAGE_KEY, mode);
  writeKey(MIRROR_STARLIGHT, mode === 'system' ? 'auto' : mode);
  writeKey(MIRROR_BLOG, resolveMode(mode));

  refresh();
}

/** Apply the stored preference without rewriting it — used on boot and when
 *  another tab (or another velxio.dev surface) changes the preference. */
function adoptStored(): void {
  currentMode = readStoredMode();
  workspaceThemes = readWorkspaceThemes();
  refresh();
}

let started = false;

/** Called once from main.tsx. The theme is already on the page by now (the
 *  index.html bootstrap did that before first paint); this wires up the two
 *  ways it can change out from under us. */
export function initTheme(): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  adoptStored();

  // The OS flipping while the user is in `system` mode.
  const mq = window.matchMedia?.(DARK_QUERY);
  const onSystemChange = () => {
    if (currentMode === 'system' && !getActiveWorkspaceTheme()) refresh();
  };
  if (mq?.addEventListener) mq.addEventListener('change', onSystemChange);
  else mq?.addListener(onSystemChange);

  // Another tab on this origin changing the preference — including the docs
  // portal and the blog. A reader with the simulator and the docs open side
  // by side sees both flip.
  window.addEventListener('storage', (e) => {
    if (e.key === null) {
      adoptStored(); // storage cleared wholesale
      return;
    }
    if (e.key === THEME_STORAGE_KEY || e.key === WORKSPACE_THEMES_KEY) {
      adoptStored();
      return;
    }
    // A MIRROR key moving means a sibling site was the one that changed the
    // preference. Its write is newer than our own key, so it wins and we
    // re-canonicalise — otherwise readStoredMode(), which prefers our key,
    // would keep answering with the stale value. Writing storage from here
    // does not re-fire this event in this tab, so there is no loop.
    if (e.key === MIRROR_STARLIGHT) {
      const v = e.newValue;
      const mode = v === 'auto' ? 'system' : isMode(v) ? v : readStoredMode();
      if (mode !== currentMode) writeMode(mode);
      return;
    }
    if (e.key === MIRROR_BLOG) {
      const v = e.newValue;
      // The blog stores a resolved value. Adopting it as an explicit mode is
      // right: the reader made an explicit choice over there.
      if ((v === 'dark' || v === 'light') && (currentMode !== 'system' || v !== resolveMode('system'))) {
        if (v !== currentMode) writeMode(v);
      }
    }
  });
}
