/**
 * Language switcher dropdown — mirrors the blog's
 * `pro/blog/src/components/LanguageSwitcher.astro`. Clicking a locale
 * rewrites the current URL under the chosen locale's prefix; the
 * `LocaleSync` wrapper at the top of the router picks up the change,
 * lazy-loads the resource bundle, and persists the choice to the
 * `velxio_locale` cookie shared with the blog.
 */

import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Globe } from 'lucide-react';
import {
  LOCALES,
  LOCALE_META,
  type Locale,
} from '../../i18n/config';
import {
  getLocaleFromPath,
  switchLocale,
} from '../../i18n/path';

export const LanguageSwitcher: React.FC = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const current: Locale = getLocaleFromPath(location.pathname);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, []);

  const choose = (target: Locale) => {
    setOpen(false);
    if (target === current) return;
    const nextPath = switchLocale(location.pathname, target);
    navigate(nextPath + location.search + location.hash);
  };

  return (
    <div ref={rootRef} className="velxio-language-switcher">
      <button
        type="button"
        className="velxio-language-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('header.language')}
        title={t('header.language')}
        onClick={() => setOpen((v) => !v)}
      >
        <Globe size={16} strokeWidth={1.8} aria-hidden="true" />
        <span className="velxio-language-current">{current.toUpperCase()}</span>
      </button>
      {open && (
        <ul
          className="velxio-language-menu dropdown-panel"
          role="listbox"
          aria-label={t('header.language')}
        >
          {LOCALES.map((loc) => {
            const meta = LOCALE_META[loc];
            const active = loc === current;
            return (
              <li
                key={loc}
                role="option"
                aria-selected={active}
              >
                <button
                  type="button"
                  className={
                    'velxio-language-item' +
                    (active ? ' velxio-language-item-active' : '')
                  }
                  onClick={() => choose(loc)}
                  lang={meta.htmlLang}
                >
                  <span className="velxio-language-native">
                    {meta.nativeName}
                  </span>
                  <span className="velxio-language-code">
                    {loc.toUpperCase()}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
