/**
 * React hook surface for the editor's i18n.
 *
 * `useLocale()` returns the active locale code and re-renders on every
 * change — backed by `useSyncExternalStore` against the same host
 * LocaleStore plugins use, so a switch from the picker fans out to the
 * editor shell and to every plugin in the same dispatch.
 *
 * `useTranslate()` returns a stable `t(key, vars?)` bound to the active
 * locale. It is `useCallback`-memoised on the locale itself, so a
 * downstream `React.memo` keeps its identity until the locale changes —
 * matching the `<SlotOutlet />` render-fn discipline.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { getLocaleStore } from '../plugin-host/I18nRegistry';
import { translate, type TranslationVars } from './translator';
import type { ShellTranslationKey } from './locales';

export type Translator = (key: ShellTranslationKey, vars?: TranslationVars) => string;

export function useLocale(): string {
  return useSyncExternalStore(
    (cb) => getLocaleStore().subscribe(cb),
    () => getLocaleStore().get(),
    () => getLocaleStore().get(),
  );
}

export function useTranslate(): Translator {
  const locale = useLocale();
  return useCallback(
    (key, vars) => translate(locale, key, vars),
    [locale],
  );
}
