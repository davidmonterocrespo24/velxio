// @vitest-environment jsdom
/**
 * SDK-005 contract tests — `ctx.i18n` + host `LocaleStore`.
 *
 * Covers:
 *   - The shared `LocaleStore` fans out locale changes to subscribers.
 *   - Per-plugin `I18nAPI` resolves keys against its own bundle, with
 *     locale fallback (region → language → default → key).
 *   - Validation errors at `registerBundle` surface as
 *     `InvalidI18nBundleError` with the plugin id baked in.
 *   - Re-registering the bundle replaces the prior atomically.
 *   - Disposing a bundle handle clears it (next `t()` returns the key).
 *   - Plugin `onLocaleChange` listeners are fault-isolated — a throw in
 *     one does not stop subsequent subscribers from firing.
 *   - Locale-store writes ignore malformed locale tags rather than throw.
 *   - Plugin context exposes `ctx.i18n` with no permission gate (i18n is
 *     read-only local data, not a sensitive surface).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InvalidI18nBundleError,
  defineI18nBundle,
  type EventBusReader,
  type PluginManifest,
  type PluginPermission,
} from '@velxio/sdk';

import { createPluginContext } from '../plugin-host/createPluginContext';
import {
  createPluginI18n,
  getActiveLocale,
  getLocaleStore,
  resetLocaleStoreForTests,
  setActiveLocale,
} from '../plugin-host/I18nRegistry';
import { resetTemplateRegistryForTests } from '../plugin-host/TemplateRegistry';
import { resetLibraryRegistryForTests } from '../plugin-host/LibraryRegistry';

const fakeEvents: EventBusReader = {
  on: () => () => {},
  hasListeners: () => false,
  listenerCount: () => 0,
};

function manifest(
  id = 'sdk005.test',
  perms: PluginPermission[] = [],
): PluginManifest {
  return {
    schemaVersion: 1,
    id,
    name: 'SDK-005 Test',
    version: '1.0.0',
    publisher: { name: 'Tester' },
    description: 'plugin used by SDK-005 contract tests',
    icon: 'https://example.com/icon.svg',
    license: 'MIT',
    category: 'utility',
    tags: [],
    type: ['ui-extension'],
    entry: { module: 'index.js' },
    permissions: perms,
    pricing: { model: 'free' },
    refundPolicy: 'none',
  } as PluginManifest;
}

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

beforeEach(() => {
  resetLocaleStoreForTests();
  resetTemplateRegistryForTests();
  resetLibraryRegistryForTests();
});

describe('LocaleStore singleton', () => {
  it('initialises to a shaped locale (default `en` outside the browser)', () => {
    // jsdom's navigator reports `en-US` — accept either that or the
    // SDK default. The strict check is the regex shape.
    expect(getActiveLocale()).toMatch(/^[a-z]{2}(?:-[A-Z]{2})?$/);
  });

  it('setActiveLocale fans out to subscribers', () => {
    const calls: string[] = [];
    const unsub = getLocaleStore().subscribe((l) => calls.push(l));
    setActiveLocale('es');
    setActiveLocale('fr');
    unsub();
    setActiveLocale('de');
    expect(calls).toEqual(['es', 'fr']);
  });

  it('does not fire when the locale is unchanged', () => {
    setActiveLocale('es');
    const calls: string[] = [];
    getLocaleStore().subscribe((l) => calls.push(l));
    setActiveLocale('es');
    expect(calls).toEqual([]);
  });

  it('rejects malformed locale tags silently (host-side foot-gun)', () => {
    setActiveLocale('en');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setActiveLocale('not-a-locale');
    setActiveLocale('EN'); // wrong case
    expect(getActiveLocale()).toBe('en');
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('listener that mutates the listener set during dispatch does not skip peers', () => {
    setActiveLocale('en');
    const calls: string[] = [];
    let unsubSelf = (): void => {};
    unsubSelf = getLocaleStore().subscribe((l) => {
      calls.push(`A:${l}`);
      unsubSelf();
    });
    getLocaleStore().subscribe((l) => calls.push(`B:${l}`));
    setActiveLocale('es');
    expect(calls).toEqual(['A:es', 'B:es']);
  });
});

describe('createPluginI18n — bundle registration', () => {
  it('throws InvalidI18nBundleError with plugin id when the bundle shape is wrong', () => {
    const i18n = createPluginI18n(manifest('plug-a'), noopLogger);
    expect(() =>
      i18n.registerBundle({ EN: { x: 'y' } } as never),
    ).toThrowError(/Plugin "plug-a".*locale must be/);
  });

  it('availableLocales reflects the keys of the registered bundle', () => {
    const i18n = createPluginI18n(manifest(), noopLogger);
    expect(i18n.availableLocales).toEqual([]);
    i18n.registerBundle({ en: { greet: 'hi' }, es: { greet: 'hola' } });
    expect([...i18n.availableLocales].sort()).toEqual(['en', 'es']);
  });

  it('disposing the bundle handle clears the bundle', () => {
    const i18n = createPluginI18n(manifest(), noopLogger);
    const handle = i18n.registerBundle({ en: { greet: 'hi' } });
    expect(i18n.t('greet')).toBe('hi');
    handle.dispose();
    expect(i18n.t('greet')).toBe('greet');
    expect(i18n.availableLocales).toEqual([]);
  });

  it('re-registering replaces the prior bundle atomically; disposing the OLD handle is a no-op', () => {
    const i18n = createPluginI18n(manifest(), noopLogger);
    const oldHandle = i18n.registerBundle({ en: { greet: 'hi' } });
    i18n.registerBundle({ en: { greet: 'updated' } });
    oldHandle.dispose();
    expect(i18n.t('greet')).toBe('updated'); // new bundle survives the stale handle's dispose
  });
});

describe('createPluginI18n — translation lookup', () => {
  it('returns the key itself when there is no bundle', () => {
    const i18n = createPluginI18n(manifest(), noopLogger);
    expect(i18n.t('cmd.run')).toBe('cmd.run');
  });

  it('uses the active locale when present in the bundle', () => {
    setActiveLocale('es');
    const i18n = createPluginI18n(manifest(), noopLogger);
    i18n.registerBundle({ en: { 'cmd.run': 'Run' }, es: { 'cmd.run': 'Ejecutar' } });
    expect(i18n.t('cmd.run')).toBe('Ejecutar');
  });

  it('falls back from region to language-only when the region is absent', () => {
    setActiveLocale('es-MX');
    const i18n = createPluginI18n(manifest(), noopLogger);
    i18n.registerBundle({ en: { greet: 'hi' }, es: { greet: 'hola' } });
    expect(i18n.t('greet')).toBe('hola');
  });

  it('falls back to the default locale when the active locale has no table', () => {
    setActiveLocale('ja');
    const i18n = createPluginI18n(manifest(), noopLogger);
    i18n.registerBundle({ en: { greet: 'hi' } });
    expect(i18n.t('greet')).toBe('hi');
  });

  it('returns the key itself when the key is missing in every locale', () => {
    setActiveLocale('en');
    const i18n = createPluginI18n(manifest(), noopLogger);
    i18n.registerBundle({ en: { greet: 'hi' } });
    expect(i18n.t('absent')).toBe('absent');
  });

  it('interpolates variables in the translated string', () => {
    setActiveLocale('en');
    const i18n = createPluginI18n(manifest(), noopLogger);
    i18n.registerBundle({ en: { hello: 'Hello, {name}!' } });
    expect(i18n.t('hello', { name: 'David' })).toBe('Hello, David!');
  });

  it('format() interpolates an arbitrary template (not from the bundle)', () => {
    const i18n = createPluginI18n(manifest(), noopLogger);
    expect(i18n.format('{n} items', { n: 3 })).toBe('3 items');
  });
});

describe('createPluginI18n — onLocaleChange', () => {
  it('fires for the plugin when the locale changes', () => {
    const i18n = createPluginI18n(manifest(), noopLogger);
    const seen: string[] = [];
    i18n.onLocaleChange((l) => seen.push(l));
    setActiveLocale('es');
    setActiveLocale('fr');
    expect(seen).toEqual(['es', 'fr']);
  });

  it('a throwing listener is fault-isolated through the plugin logger', () => {
    const errors: unknown[] = [];
    const i18n = createPluginI18n(manifest(), {
      ...noopLogger,
      error: (...args) => errors.push(args),
    });
    i18n.onLocaleChange(() => {
      throw new Error('boom');
    });
    const seen: string[] = [];
    i18n.onLocaleChange((l) => seen.push(l));
    setActiveLocale('es');
    expect(seen).toEqual(['es']); // second listener still ran
    expect(errors.length).toBe(1);
  });

  it('returns an unsubscribe function that removes the listener', () => {
    const i18n = createPluginI18n(manifest(), noopLogger);
    const seen: string[] = [];
    const off = i18n.onLocaleChange((l) => seen.push(l));
    setActiveLocale('es');
    off();
    setActiveLocale('fr');
    expect(seen).toEqual(['es']);
  });
});

describe('createPluginContext — ctx.i18n integration', () => {
  it('exposes a working I18nAPI without any permission gate', () => {
    // Manifest has no permissions at all; i18n should still work.
    const { context, dispose } = createPluginContext(manifest('no-perms.plug'), {
      events: fakeEvents,
    });
    context.i18n.registerBundle(defineI18nBundle({ en: { greet: 'hi' } }));
    expect(context.i18n.t('greet')).toBe('hi');
    dispose();
  });

  it('the plugin id from the manifest is baked into validation errors', () => {
    const { context, dispose } = createPluginContext(manifest('error-id.plug'), {
      events: fakeEvents,
    });
    try {
      context.i18n.registerBundle({ FR: { x: 'y' } } as never);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidI18nBundleError);
      expect((e as Error).message).toContain('"error-id.plug"');
    }
    dispose();
  });

  it('two plugins keep separate bundles; locale changes notify each', () => {
    const a = createPluginContext(manifest('plug-a'), { events: fakeEvents });
    const b = createPluginContext(manifest('plug-b'), { events: fakeEvents });
    a.context.i18n.registerBundle({ en: { greet: 'A-hi' }, es: { greet: 'A-hola' } });
    b.context.i18n.registerBundle({ en: { greet: 'B-hi' }, es: { greet: 'B-hola' } });
    setActiveLocale('en');
    expect(a.context.i18n.t('greet')).toBe('A-hi');
    expect(b.context.i18n.t('greet')).toBe('B-hi');
    setActiveLocale('es');
    expect(a.context.i18n.t('greet')).toBe('A-hola');
    expect(b.context.i18n.t('greet')).toBe('B-hola');
    a.dispose();
    b.dispose();
  });
});
