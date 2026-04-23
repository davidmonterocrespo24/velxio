/**
 * Host-side i18n — singleton locale store + per-plugin `I18nAPI` factory.
 *
 * One global `LocaleStore` keeps the user's currently selected locale and
 * fans out change notifications. Each plugin gets its own `I18nAPI`
 * instance from `createPluginI18n` that holds *its* translation bundle
 * and resolves keys against the shared current locale.
 *
 * Plugins NEVER import from this file — they receive their `I18nAPI`
 * through `ctx.i18n`. Read this file only when wiring the host (the
 * editor sets the locale; the loader instantiates per-plugin APIs).
 *
 * Locale change semantics: when the user switches locales, every
 * `onLocaleChange` listener attached by every plugin fires synchronously
 * in registration order. Errors in one listener are logged via that
 * plugin's logger and do not block the rest — same fault-isolation rule
 * as `EventBus`.
 */

import {
  I18N_DEFAULT_LOCALE,
  interpolate,
  resolveLocale,
  validateI18nBundle,
  type Disposable,
  type I18nAPI,
  type LocaleId,
  type PluginI18nBundle,
  type PluginLogger,
  type PluginManifest,
} from '@velxio/sdk';

// ─── locale store ──────────────────────────────────────────────────────────

/**
 * Process-wide active locale. Held in a small store so the editor's
 * settings UI can change it and every plugin's `onLocaleChange` listener
 * fires from a single source.
 *
 * Default-locale detection happens once on first access — we read
 * `navigator.language` if available (browser/jsdom) and accept it only
 * if it shape-checks against `[a-z]{2}(?:-[A-Z]{2})?`. Anything weirder
 * falls through to `I18N_DEFAULT_LOCALE` so we never feed a malformed
 * tag into the resolver.
 */
class LocaleStore {
  private current: LocaleId = detectInitialLocale();
  private readonly listeners = new Set<(locale: LocaleId) => void>();

  get(): LocaleId {
    return this.current;
  }

  set(locale: LocaleId): void {
    if (!isShapedLocale(locale)) {
      // Reject silently rather than throw: the caller is host code, not
      // a plugin. A bad value here is a host bug; warn and keep the old
      // value so the UI stays consistent.
      console.warn(`[plugin-host] LocaleStore.set("${locale}"): malformed locale, ignored`);
      return;
    }
    if (locale === this.current) return;
    this.current = locale;
    // Snapshot the listener set so a listener that mutates the set
    // during dispatch (e.g. unsubscribes itself) can't skip its peers.
    const snapshot = Array.from(this.listeners);
    for (const fn of snapshot) {
      try {
        fn(locale);
      } catch {
        // Per-listener errors are the responsibility of the listener's
        // owner — `createPluginI18n` already wraps plugin callbacks so
        // their throws never reach this loop. Anything that lands here
        // is a host bug; swallow to keep dispatch going.
      }
    }
  }

  subscribe(fn: (locale: LocaleId) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Test helper: drop every listener and reset to the initial locale. */
  clearForTests(): void {
    this.listeners.clear();
    this.current = detectInitialLocale();
  }

  /** Test helper: number of attached listeners. */
  listenerCount(): number {
    return this.listeners.size;
  }
}

let storeSingleton: LocaleStore | null = null;

export function getLocaleStore(): LocaleStore {
  if (storeSingleton === null) storeSingleton = new LocaleStore();
  return storeSingleton;
}

export function resetLocaleStoreForTests(): void {
  storeSingleton = null;
}

/** Convenience: read the active locale without going through the store reference. */
export function getActiveLocale(): LocaleId {
  return getLocaleStore().get();
}

/**
 * Set the active locale. Called by the editor's settings UI; also
 * useful in tests. No-op when the value is unchanged or malformed.
 */
export function setActiveLocale(locale: LocaleId): void {
  getLocaleStore().set(locale);
}

// ─── per-plugin I18nAPI ───────────────────────────────────────────────────

/**
 * Factory used by `createPluginContext`. Returns an `I18nAPI` instance
 * scoped to a single plugin — its own bundle, its own listener
 * registrations.
 *
 * The store argument defaults to the singleton; tests pass a fresh one
 * to keep state isolated.
 */
export function createPluginI18n(
  manifest: PluginManifest,
  logger: PluginLogger,
  store: LocaleStore = getLocaleStore(),
): I18nAPI {
  // We hold one bundle at a time. `registerBundle` replaces the prior
  // bundle atomically (and swaps the disposable), matching the API
  // contract that re-registration is expected and cheap.
  let bundle: PluginI18nBundle = {};
  let availableLocales: ReadonlyArray<LocaleId> = [];

  const api: I18nAPI = {
    get locale() {
      return store.get();
    },
    get availableLocales() {
      return availableLocales;
    },
    t(key, vars) {
      const active = store.get();
      const target = resolveLocale(active, availableLocales, I18N_DEFAULT_LOCALE);
      const table = bundle[target] ?? bundle[I18N_DEFAULT_LOCALE];
      const raw = table?.[key];
      if (raw === undefined) {
        // Falling back to the key itself surfaces missing translations
        // as visible UI strings rather than empty space. That's the
        // standard i18n-debugging affordance.
        return key;
      }
      return interpolate(raw, vars);
    },
    format(template, vars) {
      return interpolate(template, vars);
    },
    onLocaleChange(fn) {
      // Wrap the plugin callback so a throw inside it lands on the
      // plugin's logger, not on whoever flipped the locale. This is
      // the same fault-isolation rule the EventBus uses.
      const wrapped = (locale: LocaleId): void => {
        try {
          fn(locale);
        } catch (err) {
          logger.error('onLocaleChange listener threw:', err);
        }
      };
      const unsub = store.subscribe(wrapped);
      return unsub;
    },
    registerBundle(next) {
      const validated = validateI18nBundle(next, manifest.id);
      bundle = validated;
      availableLocales = Object.freeze(Object.keys(validated));
      const handle: Disposable = {
        dispose: () => {
          // Only clear if this handle still owns the current bundle —
          // if the plugin called `registerBundle` again, the newer
          // registration owns it now and its dispose() should clear,
          // not ours.
          if (bundle === validated) {
            bundle = {};
            availableLocales = [];
          }
        },
      };
      return handle;
    },
  };

  return api;
}

// ─── helpers ───────────────────────────────────────────────────────────────

const LOCALE_SHAPE_RE = /^[a-z]{2}(?:-[A-Z]{2})?$/;

function isShapedLocale(value: string): boolean {
  return LOCALE_SHAPE_RE.test(value);
}

function detectInitialLocale(): LocaleId {
  // Best-effort browser detection. `navigator` may be absent in a Node
  // unit-test environment that doesn't load jsdom; in that case we fall
  // back to the SDK default.
  if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
    if (isShapedLocale(navigator.language)) return navigator.language;
    // Some browsers report `en-us` lowercased; normalise the region.
    const dash = navigator.language.indexOf('-');
    if (dash > 0) {
      const lang = navigator.language.slice(0, dash).toLowerCase();
      const region = navigator.language.slice(dash + 1).toUpperCase();
      const candidate = `${lang}-${region}`;
      if (isShapedLocale(candidate)) return candidate;
    }
  }
  return I18N_DEFAULT_LOCALE;
}
