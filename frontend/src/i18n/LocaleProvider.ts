/**
 * Editor-side locale wiring.
 *
 * The host's plugin-i18n module already owns a singleton `LocaleStore`
 * (`frontend/src/plugin-host/I18nRegistry.ts`) — that is the canonical
 * source of truth so a locale change from the editor's settings UI
 * fans out to every plugin's `onLocaleChange` listener through the same
 * dispatch loop.
 *
 * This module's job is the *editor* half: persist the chosen locale to
 * `localStorage` so it survives reloads, boot the LocaleStore from that
 * persisted value (or from `navigator.language`) before plugin contexts
 * are constructed, and expose the typed setter the picker UI calls.
 *
 * IMPORTANT: `bootEditorLocale()` must run before the plugin loader
 * instantiates any plugin context. Plugins read the active locale at
 * `registerBundle` time, so a late boot would leave them stuck on the
 * default until the next user-driven locale change.
 */

import { I18N_DEFAULT_LOCALE, resolveLocale } from '@velxio/sdk';
import { getLocaleStore, setActiveLocale } from '../plugin-host/I18nRegistry';
import { SUPPORTED_LOCALE_CODES, SUPPORTED_LOCALES, type LocaleDescriptor } from './locales';

export const LOCALE_STORAGE_KEY = 'velxio.locale';

/**
 * Read-only re-export so the picker doesn't depend on `./locales`
 * directly. Centralising the surface keeps the locale list one
 * find-and-replace away.
 */
export const supportedLocales: ReadonlyArray<LocaleDescriptor> = SUPPORTED_LOCALES;

/**
 * Boot the editor's locale on app startup.
 *
 * Resolution order:
 *   1. `localStorage[velxio.locale]` if it points to a supported locale.
 *   2. `navigator.language` resolved against supported locales (tolerates
 *      `es-MX` → `es` collapse, `en` → `en-US` expansion).
 *   3. `I18N_DEFAULT_LOCALE` ('en').
 *
 * The resolved value is written back to `localStorage` so the next boot
 * is deterministic — even if `navigator.language` flips because the
 * user changed their OS preferences, we keep the explicit choice.
 */
export function bootEditorLocale(): void {
  const stored = readStoredLocale();
  if (stored !== null) {
    setActiveLocale(stored);
    return;
  }

  const navLang = readNavigatorLanguage();
  const resolved = navLang === null
    ? I18N_DEFAULT_LOCALE
    : resolveLocale(navLang, SUPPORTED_LOCALE_CODES, I18N_DEFAULT_LOCALE);

  // Persist the boot decision so subsequent loads don't redo
  // `navigator.language` resolution (and so explicit changes via the
  // picker survive — `setEditorLocale` writes to the same slot).
  writeStoredLocale(resolved);
  setActiveLocale(resolved);
}

/**
 * Set the editor's locale and persist it.
 *
 * No-op when `code` is not in `SUPPORTED_LOCALE_CODES` — the picker
 * should only ever pass values from `supportedLocales`, but a stray
 * call (e.g. from a stale localStorage entry someone hand-edited)
 * shouldn't blow up the editor. Returns `true` if the change was
 * accepted.
 */
export function setEditorLocale(code: string): boolean {
  if (!SUPPORTED_LOCALE_CODES.includes(code)) return false;
  writeStoredLocale(code);
  setActiveLocale(code);
  return true;
}

/**
 * Current active locale. Thin wrapper over the host's LocaleStore so
 * editor code can avoid importing from `plugin-host/`.
 */
export function getEditorLocale(): string {
  return getLocaleStore().get();
}

/**
 * Subscribe to locale changes. Returns an unsubscribe function.
 *
 * The subscription delegates to the host's LocaleStore — the same
 * dispatch loop plugin `onLocaleChange` listeners use. That is
 * intentional: when the picker changes the locale, the editor shell
 * and every plugin re-translate from a single fan-out.
 */
export function subscribeEditorLocale(fn: (locale: string) => void): () => void {
  return getLocaleStore().subscribe(fn);
}

// ── private helpers ─────────────────────────────────────────────────────

function readStoredLocale(): string | null {
  if (typeof localStorage === 'undefined') return null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    // Safari private mode and some sandboxes throw on access. Treat as
    // "no stored value" — boot will fall through to navigator.language.
    return null;
  }
  if (raw === null) return null;
  if (!SUPPORTED_LOCALE_CODES.includes(raw)) return null;
  return raw;
}

function writeStoredLocale(code: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, code);
  } catch {
    // Quota or private-mode error — non-fatal. The choice still applies
    // to the live session via `setActiveLocale`; only persistence fails.
  }
}

function readNavigatorLanguage(): string | null {
  if (typeof navigator === 'undefined') return null;
  if (typeof navigator.language !== 'string' || navigator.language.length === 0) return null;
  return navigator.language;
}
