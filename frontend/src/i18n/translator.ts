/**
 * Shell-string translator.
 *
 * Pure function: given a locale code and a key, look up the localised
 * string. The chain mirrors the SDK's plugin-side resolution so users
 * experience the same fallback semantics in core UI and plugin UI:
 *
 *   1. Exact locale (`es-MX`) → its table.
 *   2. Language-only (`es`)   → its table.
 *   3. Region collapse (`es`) → first available `es-XX` table.
 *   4. Default `en`           → the English table.
 *   5. Key itself             → so missing strings are visible debug output.
 *
 * `resolveLocale` from `@velxio/sdk/i18n` does steps 1–4; step 5 is the
 * final fallback we apply here.
 */

import { I18N_DEFAULT_LOCALE, interpolate, resolveLocale } from '@velxio/sdk';
import {
  SHELL_LOCALES,
  SUPPORTED_LOCALE_CODES,
  type ShellTranslationKey,
} from './locales';

export type TranslationVars = Readonly<Record<string, string | number>>;

/**
 * Translate a shell key for a given locale.
 *
 * `vars` are interpolated with the same `{name}` syntax the SDK uses
 * for plugin translations. Doubled braces (`{{`, `}}`) escape to a
 * literal brace.
 */
export function translate(
  locale: string,
  key: ShellTranslationKey,
  vars?: TranslationVars,
): string {
  const target = resolveLocale(locale, SUPPORTED_LOCALE_CODES, I18N_DEFAULT_LOCALE);
  const table = SHELL_LOCALES[target];
  const englishTable = SHELL_LOCALES[I18N_DEFAULT_LOCALE]!;

  // Try the resolved locale first, then English, then the key itself.
  // The key-as-fallback is intentional: a missing translation should be
  // visible to the developer instead of rendering as empty space.
  const raw = table?.[key] ?? englishTable[key] ?? key;
  return interpolate(raw, vars);
}
