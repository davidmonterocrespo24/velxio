// @vitest-environment jsdom

/**
 * `bootEditorLocale()` resolution-order tests.
 *
 * The boot routine runs once at app startup *before* any plugin context
 * is constructed — plugins read the active locale at register time, so
 * a regression here would silently lock plugins to the SDK default.
 * Tests pin the priority chain (localStorage → navigator.language →
 * I18N_DEFAULT_LOCALE) and the Safari private-mode tolerance.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Reset the host LocaleStore between tests by re-importing the module.
// vitest's `vi.resetModules()` would also work; we pin the call point.

const ORIGINAL_NAVIGATOR_LANGUAGE = Object.getOwnPropertyDescriptor(
  navigator,
  'language',
);

function setNavigatorLanguage(value: string | undefined): void {
  Object.defineProperty(navigator, 'language', {
    configurable: true,
    get: () => value,
  });
}

function restoreNavigatorLanguage(): void {
  if (ORIGINAL_NAVIGATOR_LANGUAGE !== undefined) {
    Object.defineProperty(navigator, 'language', ORIGINAL_NAVIGATOR_LANGUAGE);
  }
}

describe('bootEditorLocale', () => {
  beforeEach(async () => {
    vi.resetModules();
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
    // Reset the singleton in the (already-imported) registry so a stale
    // value from a previous test can't suppress our `set()` dispatch.
    const reg = await import('../plugin-host/I18nRegistry');
    reg.resetLocaleStoreForTests();
  });

  afterEach(() => {
    restoreNavigatorLanguage();
  });

  it('reads a stored locale and applies it', async () => {
    localStorage.setItem('velxio.locale', 'es');
    const { bootEditorLocale, getEditorLocale } = await import(
      '../i18n/LocaleProvider'
    );
    bootEditorLocale();
    expect(getEditorLocale()).toBe('es');
  });

  it('falls back to navigator.language when localStorage is empty', async () => {
    setNavigatorLanguage('es-MX');
    const { bootEditorLocale, getEditorLocale } = await import(
      '../i18n/LocaleProvider'
    );
    bootEditorLocale();
    expect(getEditorLocale()).toBe('es');
  });

  it('falls back to default `en` when no localStorage and no navigator', async () => {
    setNavigatorLanguage('');
    const { bootEditorLocale, getEditorLocale } = await import(
      '../i18n/LocaleProvider'
    );
    bootEditorLocale();
    expect(getEditorLocale()).toBe('en');
  });

  it('ignores malformed/unsupported stored locale values', async () => {
    localStorage.setItem('velxio.locale', 'klingon');
    setNavigatorLanguage('en-US');
    const { bootEditorLocale, getEditorLocale } = await import(
      '../i18n/LocaleProvider'
    );
    bootEditorLocale();
    // Stored value is rejected → fall through to navigator.language.
    expect(getEditorLocale()).toBe('en');
  });

  it('persists the boot decision to localStorage when none was stored', async () => {
    setNavigatorLanguage('es-AR');
    const { bootEditorLocale } = await import('../i18n/LocaleProvider');
    bootEditorLocale();
    expect(localStorage.getItem('velxio.locale')).toBe('es');
  });

  it('does not throw if localStorage.setItem rejects (Safari private mode)', async () => {
    setNavigatorLanguage('es');
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function () {
      throw new Error('QuotaExceeded');
    };
    try {
      const { bootEditorLocale, getEditorLocale } = await import(
        '../i18n/LocaleProvider'
      );
      expect(() => bootEditorLocale()).not.toThrow();
      // Choice still applies to the live session even if persistence fails.
      expect(getEditorLocale()).toBe('es');
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});

describe('setEditorLocale', () => {
  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    const reg = await import('../plugin-host/I18nRegistry');
    reg.resetLocaleStoreForTests();
  });

  it('rejects unsupported locale codes', async () => {
    const { setEditorLocale } = await import('../i18n/LocaleProvider');
    expect(setEditorLocale('klingon')).toBe(false);
  });

  it('accepts and persists a supported locale', async () => {
    const { setEditorLocale, getEditorLocale } = await import(
      '../i18n/LocaleProvider'
    );
    expect(setEditorLocale('es')).toBe(true);
    expect(getEditorLocale()).toBe('es');
    expect(localStorage.getItem('velxio.locale')).toBe('es');
  });

  it('drives the host LocaleStore (so plugins re-translate)', async () => {
    const { setEditorLocale, subscribeEditorLocale, getEditorLocale } = await import(
      '../i18n/LocaleProvider'
    );
    // Pin the starting locale so set('es') is a real change regardless
    // of jsdom's `navigator.language` default. Without this anchor, an
    // earlier test could leave `current === 'es'` and `set('es')` would
    // be a no-op (LocaleStore deduplicates same-value writes by design).
    setEditorLocale('en');
    expect(getEditorLocale()).toBe('en');

    let received: string | null = null;
    const off = subscribeEditorLocale((locale) => {
      received = locale;
    });
    setEditorLocale('es');
    off();
    expect(received).toBe('es');
  });
});
