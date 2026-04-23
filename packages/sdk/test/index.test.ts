/**
 * Smoke test for the barrel — verifies every public symbol is exported
 * and that helpers (`definePlugin`, constants) are runtime-available.
 */
import { describe, expect, it, expectTypeOf } from 'vitest';
import {
  SDK_VERSION,
  MANIFEST_SCHEMA_VERSION,
  definePlugin,
  PLUGIN_PERMISSIONS,
  PluginPermissionSchema,
  PluginManifestSchema,
  validateManifest,
  PermissionDeniedError,
  StorageQuotaError,
  HttpAllowlistDeniedError,
  DuplicateComponentError,
  PLUGIN_STORAGE_QUOTA_BYTES,
  defineTemplate,
  defineLibrary,
  InvalidTemplateError,
  DuplicateTemplateError,
  InvalidLibraryError,
  DuplicateLibraryError,
  LibraryDependencyCycleError,
  TEMPLATE_MAX_TOTAL_BYTES,
  LIBRARY_MAX_TOTAL_BYTES,
  LIBRARY_MAX_FILE_BYTES,
} from '../src/index';
import type {
  PluginManifest,
  PluginContext,
  ComponentDefinition,
  PartSimulation,
  SpiceMapper,
  EventBusReader,
  SimulatorEvents,
  SimulatorEventName,
  SimulatorEventPayload,
  CompileMiddlewareRegistry,
  Plugin,
} from '../src/index';

describe('barrel exports', () => {
  it('SDK_VERSION matches the package version shape', () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('MANIFEST_SCHEMA_VERSION is 1', () => {
    expect(MANIFEST_SCHEMA_VERSION).toBe(1);
  });

  it('definePlugin is an identity function', () => {
    const p: Plugin = { activate: () => {} };
    expect(definePlugin(p)).toBe(p);
  });

  it('PLUGIN_PERMISSIONS array and enum agree', () => {
    for (const p of PLUGIN_PERMISSIONS) {
      expect(PluginPermissionSchema.safeParse(p).success).toBe(true);
    }
  });

  it('PermissionDeniedError carries the permission + plugin id', () => {
    const err = new PermissionDeniedError('http.fetch', 'my-plugin');
    expect(err.permission).toBe('http.fetch');
    expect(err.pluginId).toBe('my-plugin');
    expect(err.name).toBe('PermissionDeniedError');
    expect(err).toBeInstanceOf(Error);
  });

  it('PLUGIN_STORAGE_QUOTA_BYTES is 1 MB', () => {
    expect(PLUGIN_STORAGE_QUOTA_BYTES).toBe(1_048_576);
  });

  it('StorageQuotaError carries bucket + sizes', () => {
    const err = new StorageQuotaError('user', 2_000_000, 1_048_576);
    expect(err.bucket).toBe('user');
    expect(err.attemptedBytes).toBe(2_000_000);
    expect(err.quotaBytes).toBe(1_048_576);
    expect(err.name).toBe('StorageQuotaError');
    expect(err).toBeInstanceOf(Error);
  });

  it('DuplicateComponentError carries componentId + pluginId', () => {
    const err = new DuplicateComponentError('wokwi-led', 'my-plugin');
    expect(err.componentId).toBe('wokwi-led');
    expect(err.pluginId).toBe('my-plugin');
    expect(err.name).toBe('DuplicateComponentError');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('my-plugin.wokwi-led');
  });

  it('SDK-004 helpers and errors are exported from the barrel', () => {
    expect(typeof defineTemplate).toBe('function');
    expect(typeof defineLibrary).toBe('function');
    expect(TEMPLATE_MAX_TOTAL_BYTES).toBe(1_048_576);
    expect(LIBRARY_MAX_TOTAL_BYTES).toBe(2_097_152);
    expect(LIBRARY_MAX_FILE_BYTES).toBe(524_288);
    const tplErr = new InvalidTemplateError('t', 'p', 'r');
    expect(tplErr.name).toBe('InvalidTemplateError');
    const dupTpl = new DuplicateTemplateError('t', 'p');
    expect(dupTpl.name).toBe('DuplicateTemplateError');
    const libErr = new InvalidLibraryError('l', 'p', 'r');
    expect(libErr.name).toBe('InvalidLibraryError');
    const dupLib = new DuplicateLibraryError('l', 'p');
    expect(dupLib.name).toBe('DuplicateLibraryError');
    const cyc = new LibraryDependencyCycleError(['a', 'b', 'a']);
    expect(cyc.name).toBe('LibraryDependencyCycleError');
    expect(cyc.message).toContain('a → b → a');
  });

  it('HttpAllowlistDeniedError carries url + allowlist', () => {
    const err = new HttpAllowlistDeniedError('https://evil.com/', [
      'https://api.good.com/',
    ]);
    expect(err.url).toBe('https://evil.com/');
    expect(err.allowlist).toEqual(['https://api.good.com/']);
    expect(err.name).toBe('HttpAllowlistDeniedError');
    expect(err).toBeInstanceOf(Error);
  });

  it('PluginManifestSchema + validateManifest are the same contract', () => {
    const manifest = {
      schemaVersion: 1,
      id: 'a-b',
      name: 'Hello',
      version: '1.0.0',
      sdkVersion: '^1.0.0',
      minVelxioVersion: '^2.0.0',
      author: { name: 'Jane' },
      description: 'A reasonable description of the plugin contents.',
      icon: 'https://x.example/i.png',
      license: 'MIT',
      category: 'tools',
      type: ['ui-extension'],
      entry: './p.mjs',
    };
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(true);
    expect(validateManifest(manifest).ok).toBe(true);
  });
});

describe('type-level contract', () => {
  it('SimulatorEventPayload resolves to the right payload shape', () => {
    expectTypeOf<SimulatorEventPayload<'pin:change'>>().toEqualTypeOf<
      SimulatorEvents['pin:change']
    >();
  });

  it('SimulatorEventName covers every event key', () => {
    expectTypeOf<SimulatorEventName>().toEqualTypeOf<keyof SimulatorEvents>();
  });

  it('ComponentDefinition is readonly-safe', () => {
    // Verifies the interface shape compiles against a realistic value.
    const c: ComponentDefinition = {
      id: 'my-widget',
      name: 'My Widget',
      category: 'sensors',
      description: 'Example',
      element: 'wokwi-led',
      pins: [{ name: 'A', x: 0, y: 0 }],
    };
    expect(c.pins.length).toBe(1);
  });

  it('PartSimulation is all-optional', () => {
    const empty: PartSimulation = {};
    expect(empty).toEqual({});
  });

  it('SpiceMapper signature is called correctly (compile-time check)', () => {
    const m: SpiceMapper = (component, _lookup, _ctx) => ({
      cards: [`R_${component.id} a b 1k`],
      modelsUsed: new Set(),
    });
    const out = m(
      { id: 'r1', metadataId: 'wokwi-resistor', properties: {} },
      () => null,
      { vcc: 5, analysis: { kind: 'op' } },
    );
    expect(out?.cards[0]).toContain('R_r1');
  });

  it('EventBusReader is assignable from a minimal stub', () => {
    const stub: EventBusReader = {
      on: () => () => {},
      hasListeners: () => false,
      listenerCount: () => 0,
    };
    expect(typeof stub.on).toBe('function');
  });

  it('PluginContext + CompileMiddlewareRegistry compose without any', () => {
    // Just needs to compile; ensures no implicit `any` sneaks in.
    const _assert = (ctx: PluginContext): PluginContext => ctx;
    const _assertCompile = (r: CompileMiddlewareRegistry): CompileMiddlewareRegistry => r;
    expect(_assert).toBeDefined();
    expect(_assertCompile).toBeDefined();
  });

  it('PluginManifest type round-trips through validateManifest', () => {
    const raw = {
      schemaVersion: 1,
      id: 'a-b',
      name: 'Hello',
      version: '1.0.0',
      sdkVersion: '^1.0.0',
      minVelxioVersion: '^2.0.0',
      author: { name: 'Jane' },
      description: 'A reasonable description of the plugin contents.',
      icon: 'https://x.example/i.png',
      license: 'MIT',
      category: 'tools',
      type: ['ui-extension'],
      entry: './p.mjs',
    };
    const r = validateManifest(raw);
    if (!r.ok) throw new Error('expected ok');
    expectTypeOf(r.manifest).toMatchTypeOf<PluginManifest>();
  });
});
