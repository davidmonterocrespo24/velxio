// @vitest-environment jsdom

/**
 * React hook contract for `useLocale` / `useTranslate`.
 *
 * The hooks back onto the same host LocaleStore that plugins subscribe
 * to, so a single `setEditorLocale` call must re-render every consumer
 * — editor shell and plugin UI alike. We mount a minimal component
 * tree, flip the locale, and assert the new translation is in the DOM.
 */

import React, { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { useLocale, useTranslate } from '../i18n/useLocale';
import { setEditorLocale } from '../i18n/LocaleProvider';
import { resetLocaleStoreForTests } from '../plugin-host/I18nRegistry';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  // React 18+ requires this flag set or `act` warnings break test output.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (typeof localStorage !== 'undefined') localStorage.clear();
  resetLocaleStoreForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe('useLocale + useTranslate', () => {
  it('returns the active locale and re-renders on change', () => {
    setEditorLocale('en');

    function Probe(): React.ReactElement {
      const locale = useLocale();
      return <span data-testid="locale">{locale}</span>;
    }

    act(() => {
      root!.render(<Probe />);
    });
    expect(container!.querySelector('[data-testid="locale"]')!.textContent).toBe(
      'en',
    );

    act(() => {
      setEditorLocale('es');
    });
    expect(container!.querySelector('[data-testid="locale"]')!.textContent).toBe(
      'es',
    );
  });

  it('useTranslate returns translated text and updates with the locale', () => {
    setEditorLocale('en');

    function Probe(): React.ReactElement {
      const t = useTranslate();
      return <span data-testid="text">{t('nav.home')}</span>;
    }

    act(() => {
      root!.render(<Probe />);
    });
    expect(container!.querySelector('[data-testid="text"]')!.textContent).toBe(
      'Home',
    );

    act(() => {
      setEditorLocale('es');
    });
    expect(container!.querySelector('[data-testid="text"]')!.textContent).toBe(
      'Inicio',
    );
  });

  it('fans out a single locale flip to multiple consumers', () => {
    setEditorLocale('en');

    function ShellLabel(): React.ReactElement {
      const t = useTranslate();
      return <span data-testid="shell">{t('common.cancel')}</span>;
    }
    function PluginLabel(): React.ReactElement {
      // A plugin would receive its own I18nAPI, but the host LocaleStore
      // is the same — assert that a second consumer also re-renders.
      const t = useTranslate();
      return <span data-testid="plugin">{t('common.confirm')}</span>;
    }

    act(() => {
      root!.render(
        <>
          <ShellLabel />
          <PluginLabel />
        </>,
      );
    });
    expect(container!.querySelector('[data-testid="shell"]')!.textContent).toBe('Cancel');
    expect(container!.querySelector('[data-testid="plugin"]')!.textContent).toBe('Confirm');

    act(() => {
      setEditorLocale('es');
    });
    expect(container!.querySelector('[data-testid="shell"]')!.textContent).toBe('Cancelar');
    expect(container!.querySelector('[data-testid="plugin"]')!.textContent).toBe('Confirmar');
  });

  it('useTranslate identity is stable across renders at the same locale', () => {
    setEditorLocale('en');

    const seen: Array<unknown> = [];
    function Probe(): React.ReactElement {
      const t = useTranslate();
      // Push the function identity on every render to detect new closures.
      useEffect(() => {
        seen.push(t);
      }, [t]);
      return <span>{t('nav.home')}</span>;
    }

    act(() => {
      root!.render(<Probe />);
    });
    act(() => {
      // Force a re-render by toggling unrelated state.
      root!.render(<Probe />);
    });
    // Same locale → same callback identity → useEffect should NOT have
    // run twice (only the initial mount).
    expect(seen.length).toBe(1);

    act(() => {
      setEditorLocale('es');
    });
    // Locale changed → new callback identity → effect re-runs.
    expect(seen.length).toBe(2);
  });
});
