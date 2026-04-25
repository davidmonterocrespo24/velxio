/**
 * Shell-string locale catalogue.
 *
 * `SHELL_LOCALES` is the canonical map consumed by `translator.ts` and
 * `LocaleProvider.ts`. Adding a locale means: (1) drop a new file in this
 * folder, (2) add an entry here, (3) add the descriptor to
 * `SUPPORTED_LOCALES`. The Language picker reads `SUPPORTED_LOCALES`
 * directly, so a new locale shows up without touching UI code.
 */

import { de } from './de';
import { en, type ShellTranslationKey } from './en';
import { es } from './es';
import { fr } from './fr';
import { pt } from './pt';

export type ShellTranslations = Partial<Record<ShellTranslationKey, string>>;

export const SHELL_LOCALES: Readonly<Record<string, ShellTranslations>> = {
  en,
  es,
  fr,
  de,
  pt,
};

/**
 * User-visible locale descriptors. The `code` must match a key in
 * `SHELL_LOCALES`. The `nativeName` is shown in the picker — always in
 * the locale's own language so a user who can't read the current UI can
 * still find their language.
 */
export interface LocaleDescriptor {
  readonly code: string;
  readonly nativeName: string;
  readonly flag: string;
}

export const SUPPORTED_LOCALES: ReadonlyArray<LocaleDescriptor> = Object.freeze([
  { code: 'en', nativeName: 'English', flag: 'EN' },
  { code: 'es', nativeName: 'Español', flag: 'ES' },
  { code: 'fr', nativeName: 'Français', flag: 'FR' },
  { code: 'de', nativeName: 'Deutsch', flag: 'DE' },
  { code: 'pt', nativeName: 'Português', flag: 'PT' },
]);

export const SUPPORTED_LOCALE_CODES: ReadonlyArray<string> = Object.freeze(
  SUPPORTED_LOCALES.map((l) => l.code),
);

export type { ShellTranslationKey };
