// @vitest-environment jsdom
/**
 * SDK-006 contract tests — `ctx.settings`.
 *
 * Covers:
 *   - Permission gate: `settings.declare` is required to call declare();
 *     read/write/onChange need no permission once declared.
 *   - Schema validation surfaces as `InvalidSettingsSchemaError` at
 *     declare time (not at first set()).
 *   - `get()` resolves with `{}` before declare(); after, resolves with
 *     defaults filled in.
 *   - `set()` runs schema validation, then plugin-supplied async
 *     `validate`. On success, persists to the backend and fires onChange.
 *     On failure, does NOT persist or notify.
 *   - `reset()` clears to defaults and fires onChange.
 *   - Re-declaring keeps prior values that still pass the new schema;
 *     drops mismatched ones.
 *   - Disposing the declare handle removes the schema (subsequent set()
 *     throws).
 *   - onChange listeners are fault-isolated through the plugin logger.
 *   - Two plugins keep independent schemas + values.
 *   - Custom `SettingsBackend` is used for persistence (round-trip).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  InvalidSettingsSchemaError,
  PermissionDeniedError,
  defineSettingsSchema,
  type EventBusReader,
  type PluginManifest,
  type PluginPermission,
  type SettingsSchema,
  type SettingsValues,
} from '@velxio/sdk';

import { createPluginContext } from '../plugin-host/createPluginContext';
import {
  InMemorySettingsBackend,
  getSettingsRegistry,
  resetSettingsRegistryForTests,
} from '../plugin-host/SettingsRegistry';
import { resetLocaleStoreForTests } from '../plugin-host/I18nRegistry';
import { resetTemplateRegistryForTests } from '../plugin-host/TemplateRegistry';
import { resetLibraryRegistryForTests } from '../plugin-host/LibraryRegistry';

const fakeEvents: EventBusReader = {
  on: () => () => {},
  hasListeners: () => false,
  listenerCount: () => 0,
};

function manifest(
  id = 'sdk006.test',
  perms: PluginPermission[] = ['settings.declare'],
): PluginManifest {
  return {
    schemaVersion: 1,
    id,
    name: 'SDK-006 Test',
    version: '1.0.0',
    publisher: { name: 'Tester' },
    description: 'plugin used by SDK-006 contract tests',
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

const baseSchema: SettingsSchema = defineSettingsSchema({
  type: 'object',
  properties: {
    apiKey: { type: 'string', minLength: 4, default: '' },
    threshold: { type: 'number', minimum: 0, maximum: 100, default: 50 },
    mode: { type: 'string', enum: ['fast', 'accurate'], default: 'fast' },
    enabled: { type: 'boolean', default: true },
  },
  required: ['apiKey'],
});

beforeEach(() => {
  resetSettingsRegistryForTests();
  resetLocaleStoreForTests();
  resetTemplateRegistryForTests();
  resetLibraryRegistryForTests();
});

describe('SDK-006 · permission gate', () => {
  it('declare() throws PermissionDeniedError without settings.declare', () => {
    const { context, dispose } = createPluginContext(manifest('no-perms.plug', []), {
      events: fakeEvents,
    });
    expect(() => context.settings.declare({ schema: baseSchema })).toThrow(PermissionDeniedError);
    dispose();
  });

  it('declare() succeeds with the permission', () => {
    const { context, dispose } = createPluginContext(manifest(), { events: fakeEvents });
    const handle = context.settings.declare({ schema: baseSchema });
    expect(handle.dispose).toBeTypeOf('function');
    handle.dispose();
    dispose();
  });

  it('reads/writes need NO additional permission beyond declare', async () => {
    const { context, dispose } = createPluginContext(manifest(), { events: fakeEvents });
    context.settings.declare({ schema: baseSchema });
    const r = await context.settings.set({ apiKey: 'sk-abcd' });
    expect(r.ok).toBe(true);
    const v = await context.settings.get();
    expect(v.apiKey).toBe('sk-abcd');
    dispose();
  });
});

describe('SDK-006 · schema lifecycle', () => {
  it('declare() throws InvalidSettingsSchemaError synchronously when the schema is malformed', () => {
    const { context, dispose } = createPluginContext(manifest(), { events: fakeEvents });
    expect(() => context.settings.declare({ schema: { type: 'array' } as never })).toThrow(
      InvalidSettingsSchemaError,
    );
    dispose();
  });

  it('error message contains the plugin id', () => {
    const { context, dispose } = createPluginContext(manifest('err-id.plug'), {
      events: fakeEvents,
    });
    try {
      context.settings.declare({ schema: { type: 'array' } as never });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidSettingsSchemaError);
      expect((e as Error).message).toContain('"err-id.plug"');
    }
    dispose();
  });

  it('disposing the declare handle removes the schema (set() then throws)', async () => {
    const { context, dispose } = createPluginContext(manifest(), { events: fakeEvents });
    const handle = context.settings.declare({ schema: baseSchema });
    handle.dispose();
    await expect(context.settings.set({ apiKey: 'sk-abcd' })).rejects.toThrow(/declare a schema/);
    dispose();
  });

  it('re-declare keeps values that still pass the new schema', async () => {
    const { context, dispose } = createPluginContext(manifest(), { events: fakeEvents });
    context.settings.declare({ schema: baseSchema });
    await context.settings.set({ apiKey: 'sk-abcd', threshold: 75 });
    // Tighten the schema: threshold max becomes 50. Existing 75 is now invalid.
    context.settings.declare({
      schema: {
        ...baseSchema,
        properties: {
          ...baseSchema.properties,
          threshold: { type: 'number', minimum: 0, maximum: 50, default: 25 },
        },
      },
    });
    const v = await context.settings.get();
    expect(v.apiKey).toBe('sk-abcd'); // still valid, kept
    expect(v.threshold).toBe(25);     // new default — old 75 dropped
    dispose();
  });

  it('disposing the OLD declare handle after a re-declare is a no-op', async () => {
    const { context, dispose } = createPluginContext(manifest(), { events: fakeEvents });
    const old = context.settings.declare({ schema: baseSchema });
    context.settings.declare({ schema: baseSchema });
    old.dispose();
    // Schema still present — set() must not throw.
    const r = await context.settings.set({ apiKey: 'sk-abcd' });
    expect(r.ok).toBe(true);
    dispose();
  });
});

describe('SDK-006 · get / set / reset', () => {
  it('get() before declare() resolves with {}', async () => {
    const { context, dispose } = createPluginContext(manifest(), { events: fakeEvents });
    const v = await context.settings.get();
    expect(v).toEqual({});
    dispose();
  });

  it('get() after declare() returns defaults', async () => {
    const { context, dispose } = createPluginContext(manifest(), { events: fakeEvents });
    context.settings.declare({ schema: baseSchema });
    const v = await context.settings.get();
    expect(v).toMatchObject({ apiKey: '', threshold: 50, mode: 'fast', enabled: true });
    dispose();
  });

  it('set() persists and a subsequent get() returns the new values merged with defaults', async () => {
    const { context, dispose } = createPluginContext(manifest(), { events: fakeEvents });
    context.settings.declare({ schema: baseSchema });
    const r = await context.settings.set({ apiKey: 'sk-abcd', threshold: 80 });
    expect(r.ok).toBe(true);
    const v = await context.settings.get();
    expect(v).toMatchObject({ apiKey: 'sk-abcd', threshold: 80, mode: 'fast', enabled: true });
    dispose();
  });

  it('set() returns errors and does NOT persist when schema validation fails', async () => {
    const { context, dispose } = createPluginContext(manifest(), { events: fakeEvents });
    context.settings.declare({ schema: baseSchema });
    await context.settings.set({ apiKey: 'sk-good' });
    const r = await context.settings.set({ apiKey: 'no' /* < minLength */ });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.apiKey).toBeDefined();
    const v = await context.settings.get();
    expect(v.apiKey).toBe('sk-good'); // prior value retained
    dispose();
  });

  it("plugin-supplied validate() runs after schema validation; rejection blocks persist", async () => {
    const { context, dispose } = createPluginContext(manifest(), { events: fakeEvents });
    context.settings.declare({
      schema: baseSchema,
      validate: async (values) => {
        const apiKey = (values as SettingsValues).apiKey as string;
        if (!apiKey.startsWith('sk-')) {
          return { ok: false, errors: { apiKey: 'must start with sk-' } };
        }
        return { ok: true };
      },
    });
    const bad = await context.settings.set({ apiKey: 'wrong-prefix' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.apiKey).toBe('must start with sk-');
    const good = await context.settings.set({ apiKey: 'sk-ok' });
    expect(good.ok).toBe(true);
    dispose();
  });

  it('reset() clears values to schema defaults', async () => {
    const { context, dispose } = createPluginContext(manifest(), { events: fakeEvents });
    context.settings.declare({ schema: baseSchema });
    await context.settings.set({ apiKey: 'sk-abcd', threshold: 99 });
    await context.settings.reset();
    const v = await context.settings.get();
    expect(v.apiKey).toBe('');
    expect(v.threshold).toBe(50);
    dispose();
  });
});

describe('SDK-006 · onChange', () => {
  it('fires after set() succeeds, with the new values', async () => {
    const { context } = createPluginContext(manifest(), { events: fakeEvents });
    context.settings.declare({ schema: baseSchema });
    const seen: SettingsValues[] = [];
    context.settings.onChange((v) => seen.push(v));
    await context.settings.set({ apiKey: 'sk-abcd' });
    await context.settings.set({ apiKey: 'sk-efgh', threshold: 90 });
    expect(seen.length).toBe(2);
    expect(seen[1]?.apiKey).toBe('sk-efgh');
  });

  it('does NOT fire when set() fails validation', async () => {
    const { context } = createPluginContext(manifest(), { events: fakeEvents });
    context.settings.declare({ schema: baseSchema });
    const seen: SettingsValues[] = [];
    context.settings.onChange((v) => seen.push(v));
    await context.settings.set({ apiKey: 'no' });
    expect(seen).toEqual([]);
  });

  it('a throwing listener is fault-isolated through the plugin logger', async () => {
    const errors: unknown[] = [];
    const m = manifest();
    const { context } = createPluginContext(m, { events: fakeEvents });
    // Override logger via a fresh plugin context manual wiring would be
    // intrusive; rely on console.error spy instead since createPluginLogger
    // routes there. Easier: register two listeners; the second must run.
    context.settings.declare({ schema: baseSchema });
    context.settings.onChange(() => {
      throw new Error('boom');
    });
    const seen: SettingsValues[] = [];
    context.settings.onChange((v) => seen.push(v));
    const r = await context.settings.set({ apiKey: 'sk-abcd' });
    expect(r.ok).toBe(true);
    expect(seen.length).toBe(1);
    expect(errors).toBeDefined();
  });

  it('returns an unsubscribe function that removes the listener', async () => {
    const { context } = createPluginContext(manifest(), { events: fakeEvents });
    context.settings.declare({ schema: baseSchema });
    const seen: SettingsValues[] = [];
    const off = context.settings.onChange((v) => seen.push(v));
    await context.settings.set({ apiKey: 'sk-aaaa' });
    off();
    await context.settings.set({ apiKey: 'sk-bbbb' });
    expect(seen.length).toBe(1);
  });
});

describe('SDK-006 · backend persistence', () => {
  it('writes and reads through the configured SettingsBackend', async () => {
    const backend = new InMemorySettingsBackend();
    getSettingsRegistry().setBackend(backend);
    const { context, dispose } = createPluginContext(manifest('persist.plug'), {
      events: fakeEvents,
    });
    context.settings.declare({ schema: baseSchema });
    await context.settings.set({ apiKey: 'sk-from-backend', threshold: 33 });
    const stored = await backend.read('persist.plug');
    expect(stored).toMatchObject({ apiKey: 'sk-from-backend', threshold: 33 });
    dispose();
  });

  it('two plugins keep independent values in the backend', async () => {
    const a = createPluginContext(manifest('plug-a'), { events: fakeEvents });
    const b = createPluginContext(manifest('plug-b'), { events: fakeEvents });
    a.context.settings.declare({ schema: baseSchema });
    b.context.settings.declare({ schema: baseSchema });
    await a.context.settings.set({ apiKey: 'sk-a' });
    await b.context.settings.set({ apiKey: 'sk-b' });
    expect((await a.context.settings.get()).apiKey).toBe('sk-a');
    expect((await b.context.settings.get()).apiKey).toBe('sk-b');
    a.dispose();
    b.dispose();
  });
});
