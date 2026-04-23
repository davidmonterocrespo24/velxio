/**
 * Plugin i18n — translatable UI strings for plugins.
 *
 * Plugins ship a `PluginI18nBundle` (a map of locale → key → string) and
 * read translations through `ctx.i18n.t(key, vars?)` at activation. The
 * host owns the active locale; the plugin reacts to changes via
 * `onLocaleChange`. Locale resolution falls back gracefully:
 *
 *   1. exact match: `es-MX` → bundle has `es-MX`
 *   2. language-only match: `es-MX` → bundle has `es`
 *   3. host fallback: typically `en`
 *   4. raw key returned (debuggable: missing strings show up as the key).
 *
 * Strings can contain `{name}` placeholders interpolated from `vars`.
 * Literal braces are escaped as `{{` and `}}`. Missing variables leave
 * the placeholder in place so the bug is visible rather than printing
 * `undefined`.
 *
 * Why a static bundle and not a fetch-from-server flow:
 *   - the marketplace already requires plugins to declare supported locales
 *     in the manifest (`manifest.i18n: ['en', 'es']`), so the bundle is
 *     known at publish time;
 *   - shipping translations as data avoids a runtime allowlist hole
 *     (no plugin needs `http.allowlist` just to fetch its own copy);
 *   - bundles are tiny (256 KB cap across all locales — translation
 *     strings, not a CMS).
 */

import { z } from 'zod';

import type { Disposable } from './components';

/** Default locale when the host cannot determine the user's preference. */
export const I18N_DEFAULT_LOCALE = 'en' as const;

/** Translation key syntax: identifier-with-dots (`cmd.run`, `panel.title`). */
export const I18N_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,127}$/;

/** Maximum number of keys per locale per plugin. Hard cap, not a soft warning. */
export const I18N_MAX_KEYS_PER_LOCALE = 1024;

/** Maximum bytes of a single translated string (UTF-8). */
export const I18N_MAX_VALUE_BYTES = 4_096;

/** Maximum bytes of all locale tables in a single bundle (UTF-8 sum). */
export const I18N_MAX_TOTAL_BYTES = 262_144; // 256 KB

/**
 * BCP-47-ish locale tag accepted across the SDK. Matches the same regex
 * used in the manifest: language code + optional region (`en`, `en-US`,
 * `pt-BR`). Stored as a plain string in public types because the runtime
 * already validates it on register; consumers shouldn't have to import a
 * branded type.
 */
const localeIdSchema = z
  .string()
  .regex(/^[a-z]{2}(?:-[A-Z]{2})?$/, 'locale must be e.g. "en" or "en-US"');
export type LocaleId = string;

/** Map of translation key → translated string for one locale. */
export const TranslationTableSchema = z.record(
  z.string().regex(I18N_KEY_RE, 'translation key must match I18N_KEY_RE'),
  z.string(),
);
export type TranslationTable = z.infer<typeof TranslationTableSchema>;

/** A plugin's full translation bundle: locale → table. */
export const PluginI18nBundleSchema = z.record(localeIdSchema, TranslationTableSchema);
export type PluginI18nBundle = z.infer<typeof PluginI18nBundleSchema>;

/**
 * Per-plugin i18n surface available on `PluginContext.i18n`. The plugin
 * registers its bundle once at activation and reads translations
 * synchronously. Locale changes fire the `onLocaleChange` callbacks the
 * plugin attached, *not* a re-render — the plugin owns its UI and decides
 * whether to re-translate-and-re-register the affected commands/panels.
 */
export interface I18nAPI {
  /** The host's current locale. Updated when the user switches; not reactive on its own — subscribe via `onLocaleChange`. */
  readonly locale: LocaleId;
  /** Locales for which this plugin's bundle has at least one translation table. Empty until `registerBundle` is called. */
  readonly availableLocales: ReadonlyArray<LocaleId>;
  /**
   * Translate `key`, optionally interpolating `vars`. Falls back through:
   * exact locale → language-only → default locale → key itself.
   */
  t(key: string, vars?: Readonly<Record<string, string | number>>): string;
  /**
   * Interpolate a string template with `vars` using the same `{name}`
   * substitution rules as `t()`. Useful when the source string already
   * came from outside the bundle (e.g. a backend error message).
   */
  format(template: string, vars?: Readonly<Record<string, string | number>>): string;
  /**
   * Subscribe to locale changes. Called with the new locale immediately
   * after the host switches; not invoked on subscribe. Returns a function
   * to unsubscribe — callers should also add the returned `Disposable`
   * via `ctx.subscriptions` so it tears down on plugin deactivate.
   */
  onLocaleChange(fn: (locale: LocaleId) => void): () => void;
  /**
   * Register a translation bundle. Validated synchronously; throws
   * `InvalidI18nBundleError` if any rule fails. The returned
   * `Disposable.dispose()` removes the bundle (the next `t()` call falls
   * back to the key). Re-registering replaces the previous bundle for
   * this plugin atomically.
   */
  registerBundle(bundle: PluginI18nBundle): Disposable;
}

/**
 * Thrown by `ctx.i18n.registerBundle()` when the bundle violates a
 * structural rule: bad key, oversized string, too many keys, or the
 * total bundle exceeds 256 KB. Plugin-author-facing.
 */
export class InvalidI18nBundleError extends Error {
  public override readonly name = 'InvalidI18nBundleError';
  constructor(
    public readonly pluginId: string,
    public readonly reason: string,
  ) {
    super(`Plugin "${pluginId}" tried to register an i18n bundle but it is invalid: ${reason}`);
  }
}

const utf8 = new TextEncoder();

/**
 * Validate a `PluginI18nBundle` and return the parsed shape on success.
 * Throws `InvalidI18nBundleError` (with `pluginId` baked into the
 * message) on any rule violation. Designed to run at register time so
 * authors fix bundles in dev, not after publishing.
 */
export function validateI18nBundle(bundle: unknown, pluginId: string): PluginI18nBundle {
  const parsed = PluginI18nBundleSchema.safeParse(bundle);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join('.') ?? '<root>';
    const msg = first?.message ?? 'unknown';
    throw new InvalidI18nBundleError(pluginId, `at "${path}": ${msg}`);
  }
  const data = parsed.data;
  let totalBytes = 0;
  for (const [locale, table] of Object.entries(data)) {
    const keys = Object.keys(table);
    if (keys.length > I18N_MAX_KEYS_PER_LOCALE) {
      throw new InvalidI18nBundleError(
        pluginId,
        `locale "${locale}" has ${keys.length} keys, max is ${I18N_MAX_KEYS_PER_LOCALE}`,
      );
    }
    for (const key of keys) {
      const value = table[key]!;
      const valueBytes = utf8.encode(value).byteLength;
      if (valueBytes > I18N_MAX_VALUE_BYTES) {
        throw new InvalidI18nBundleError(
          pluginId,
          `locale "${locale}" key "${key}" is ${valueBytes} bytes, max is ${I18N_MAX_VALUE_BYTES}`,
        );
      }
      totalBytes += valueBytes + utf8.encode(key).byteLength;
    }
  }
  if (totalBytes > I18N_MAX_TOTAL_BYTES) {
    throw new InvalidI18nBundleError(
      pluginId,
      `bundle is ${totalBytes} bytes, max is ${I18N_MAX_TOTAL_BYTES}`,
    );
  }
  return data;
}

/**
 * Pick the best locale from `available` to satisfy a `requested` locale.
 *
 *   1. exact match
 *   2. language-only match (request `es-MX`, available has `es`)
 *   3. region-collapse match (request `es`, available has any `es-XX` — first wins)
 *   4. `fallback`
 *
 * Returns `fallback` if nothing matches. Both inputs must already be
 * locale-shaped (no validation here — this is a hot-ish helper).
 */
export function resolveLocale(
  requested: LocaleId,
  available: ReadonlyArray<LocaleId>,
  fallback: LocaleId = I18N_DEFAULT_LOCALE,
): LocaleId {
  if (available.length === 0) return fallback;
  if (available.includes(requested)) return requested;
  const dash = requested.indexOf('-');
  if (dash > 0) {
    const lang = requested.slice(0, dash);
    if (available.includes(lang)) return lang;
  } else {
    const prefix = `${requested}-`;
    for (const a of available) {
      if (a.startsWith(prefix)) return a;
    }
  }
  return fallback;
}

/**
 * Replace `{name}` placeholders in `template` with values from `vars`.
 * Doubled braces (`{{`, `}}`) are emitted as literal `{` and `}`.
 * Unknown placeholders are left in place so the bug surfaces in UI
 * instead of printing `undefined`.
 *
 * Numbers are coerced via `String(n)` — locale-aware number formatting
 * is left to the plugin (it has access to `Intl` globally).
 */
export function interpolate(
  template: string,
  vars?: Readonly<Record<string, string | number>>,
): string {
  if (vars === undefined) {
    return template.replace(/\{\{|\}\}/g, (m) => (m === '{{' ? '{' : '}'));
  }
  let out = '';
  let i = 0;
  while (i < template.length) {
    const ch = template[i]!;
    const next = template[i + 1];
    if (ch === '{' && next === '{') {
      out += '{';
      i += 2;
      continue;
    }
    if (ch === '}' && next === '}') {
      out += '}';
      i += 2;
      continue;
    }
    if (ch === '{') {
      const end = template.indexOf('}', i + 1);
      if (end === -1) {
        // Unclosed brace — treat the rest as literal.
        out += template.slice(i);
        break;
      }
      const name = template.slice(i + 1, end);
      if (Object.prototype.hasOwnProperty.call(vars, name)) {
        const v = vars[name]!;
        out += typeof v === 'number' ? String(v) : v;
      } else {
        // Leave `{name}` literal so missing vars are visible in the UI.
        out += template.slice(i, end + 1);
      }
      i = end + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Identity helper for authoring `PluginI18nBundle` literals with type
 * inference. No runtime validation — that runs at `registerBundle`.
 *
 * ```ts
 * import { defineI18nBundle } from '@velxio/sdk';
 * export const strings = defineI18nBundle({
 *   en: { 'cmd.run': 'Run analysis' },
 *   es: { 'cmd.run': 'Analizar' },
 * });
 * ```
 */
export function defineI18nBundle<T extends PluginI18nBundle>(bundle: T): T {
  return bundle;
}
