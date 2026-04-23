import { describe, expect, it } from 'vitest';

import {
  I18N_DEFAULT_LOCALE,
  I18N_KEY_RE,
  I18N_MAX_KEYS_PER_LOCALE,
  I18N_MAX_TOTAL_BYTES,
  I18N_MAX_VALUE_BYTES,
  InvalidI18nBundleError,
  defineI18nBundle,
  interpolate,
  resolveLocale,
  validateI18nBundle,
  type PluginI18nBundle,
} from '../src';

describe('SDK · i18n constants', () => {
  it('default locale is "en"', () => {
    expect(I18N_DEFAULT_LOCALE).toBe('en');
  });

  it('key regex accepts dotted identifiers and rejects whitespace', () => {
    expect(I18N_KEY_RE.test('cmd.run')).toBe(true);
    expect(I18N_KEY_RE.test('panel.title')).toBe(true);
    expect(I18N_KEY_RE.test('a')).toBe(true);
    expect(I18N_KEY_RE.test('a-b_c.d')).toBe(true);
    expect(I18N_KEY_RE.test('1.bad')).toBe(false);
    expect(I18N_KEY_RE.test('has space')).toBe(false);
    expect(I18N_KEY_RE.test('')).toBe(false);
    expect(I18N_KEY_RE.test('x'.repeat(129))).toBe(false);
  });
});

describe('SDK · defineI18nBundle', () => {
  it('returns the same object reference (identity helper)', () => {
    const b = { en: { greet: 'hi' } };
    expect(defineI18nBundle(b)).toBe(b);
  });
});

describe('SDK · validateI18nBundle', () => {
  it('accepts a well-formed bundle', () => {
    const bundle: PluginI18nBundle = {
      en: { 'cmd.run': 'Run', 'panel.title': 'Probe' },
      es: { 'cmd.run': 'Ejecutar', 'panel.title': 'Sonda' },
    };
    expect(validateI18nBundle(bundle, 'plugin-a')).toEqual(bundle);
  });

  it('accepts an empty bundle (plugin opted into i18n but ships no strings yet)', () => {
    expect(validateI18nBundle({}, 'plugin-a')).toEqual({});
  });

  it('throws InvalidI18nBundleError when the locale tag is malformed', () => {
    expect(() => validateI18nBundle({ EN: { x: 'y' } }, 'plugin-a')).toThrow(
      /Plugin "plugin-a".*locale must be/,
    );
  });

  it('throws when a translation key violates the regex', () => {
    expect(() => validateI18nBundle({ en: { 'has space': 'oops' } }, 'plugin-a')).toThrow(
      InvalidI18nBundleError,
    );
  });

  it('rejects a value larger than I18N_MAX_VALUE_BYTES', () => {
    const big = 'a'.repeat(I18N_MAX_VALUE_BYTES + 1);
    expect(() => validateI18nBundle({ en: { big } }, 'plugin-a')).toThrow(
      /key "big".*max is 4096/,
    );
  });

  it('rejects more than I18N_MAX_KEYS_PER_LOCALE keys', () => {
    const table: Record<string, string> = {};
    for (let i = 0; i < I18N_MAX_KEYS_PER_LOCALE + 1; i += 1) {
      table[`k${i}`] = 'v';
    }
    expect(() => validateI18nBundle({ en: table }, 'plugin-a')).toThrow(/has \d+ keys, max is 1024/);
  });

  it('rejects a bundle larger than I18N_MAX_TOTAL_BYTES', () => {
    const table: Record<string, string> = {};
    const value = 'x'.repeat(I18N_MAX_VALUE_BYTES); // 4 KB each
    for (let i = 0; i < 65; i += 1) {
      table[`k${i}`] = value; // 65 * 4 KB ≈ 260 KB > 256 KB
    }
    expect(() => validateI18nBundle({ en: table }, 'plugin-a')).toThrow(
      new RegExp(`bundle is \\d+ bytes, max is ${I18N_MAX_TOTAL_BYTES}`),
    );
  });

  it('rejects non-string values', () => {
    expect(() =>
      validateI18nBundle({ en: { greet: 123 as unknown as string } }, 'plugin-a'),
    ).toThrow(InvalidI18nBundleError);
  });

  it('error message contains the plugin id', () => {
    try {
      validateI18nBundle({ FR: { x: 'y' } }, 'my-plugin');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidI18nBundleError);
      expect((e as Error).message).toContain('"my-plugin"');
    }
  });
});

describe('SDK · resolveLocale', () => {
  it('returns the requested locale when it is in the available list', () => {
    expect(resolveLocale('es-MX', ['en', 'es', 'es-MX'])).toBe('es-MX');
  });

  it('falls back from region to language-only when region match is absent', () => {
    expect(resolveLocale('es-MX', ['en', 'es'])).toBe('es');
  });

  it('expands a language-only request to a region variant when no exact match', () => {
    expect(resolveLocale('es', ['en', 'es-MX', 'es-AR'])).toBe('es-MX');
  });

  it('returns the explicit fallback when nothing matches', () => {
    expect(resolveLocale('ja', ['en', 'es'], 'en')).toBe('en');
  });

  it('uses the default fallback (en) when no fallback is passed', () => {
    expect(resolveLocale('ja', ['fr', 'de'])).toBe('en');
  });

  it('returns fallback when the available list is empty', () => {
    expect(resolveLocale('en-US', [], 'en')).toBe('en');
  });
});

describe('SDK · interpolate', () => {
  it('returns the template unchanged when no vars and no braces', () => {
    expect(interpolate('hello world')).toBe('hello world');
  });

  it('substitutes named placeholders', () => {
    expect(interpolate('Hello, {name}!', { name: 'David' })).toBe('Hello, David!');
  });

  it('coerces numbers via String()', () => {
    expect(interpolate('{n} items', { n: 3 })).toBe('3 items');
  });

  it('leaves missing placeholders literal so the bug is visible', () => {
    expect(interpolate('Hello, {name}!', {})).toBe('Hello, {name}!');
  });

  it('handles multiple substitutions in one string', () => {
    expect(interpolate('{a}+{b}={c}', { a: 1, b: 2, c: 3 })).toBe('1+2=3');
  });

  it('escapes doubled braces as literal braces', () => {
    expect(interpolate('{{not a var}}')).toBe('{not a var}');
    expect(interpolate('use {{ for {x}', { x: 'left brace' })).toBe('use { for left brace');
  });

  it('preserves an unclosed opening brace as literal text', () => {
    expect(interpolate('hello {name', { name: 'x' })).toBe('hello {name');
  });

  it('does not coerce undefined explicitly passed as a vars value (regex stays literal)', () => {
    expect(interpolate('{x}', undefined)).toBe('{x}');
  });
});
