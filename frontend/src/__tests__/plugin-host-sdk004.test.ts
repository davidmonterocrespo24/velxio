// @vitest-environment jsdom
/**
 * SDK-004 contract tests — `ctx.templates` + `ctx.libraries`.
 *
 * Covers:
 *   - Permission gates fail-fast: missing perm throws PermissionDeniedError.
 *   - Schema validation surfaces as `InvalidTemplateError` / `InvalidLibraryError`
 *     at register time (not at instantiation/compile time).
 *   - Duplicate ids throw `DuplicateTemplateError` / `DuplicateLibraryError`,
 *     even across plugins. Disposing the prior handle re-opens the slot.
 *   - Dispose of the plugin context tears down every template/library handle.
 *   - LibraryRegistry.resolve() topologically sorts a dependency graph and
 *     throws on cycles.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PermissionDeniedError,
  DuplicateLibraryError,
  DuplicateTemplateError,
  InvalidLibraryError,
  InvalidTemplateError,
  LibraryDependencyCycleError,
  defineLibrary,
  defineTemplate,
  type EventBusReader,
  type LibraryDefinition,
  type PluginManifest,
  type PluginPermission,
  type ProjectSnapshot,
  type TemplateDefinition,
} from '@velxio/sdk';

import { createPluginContext } from '../plugin-host/createPluginContext';
import { getTemplateRegistry, resetTemplateRegistryForTests } from '../plugin-host/TemplateRegistry';
import { getLibraryRegistry, resetLibraryRegistryForTests } from '../plugin-host/LibraryRegistry';

const fakeEvents: EventBusReader = {
  on: () => () => {},
  hasListeners: () => false,
  listenerCount: () => 0,
};

function manifest(
  perms: PluginPermission[] = [],
  extras: Partial<PluginManifest> = {},
): PluginManifest {
  return {
    schemaVersion: 1,
    id: 'sdk004.test',
    name: 'SDK-004 Test',
    version: '1.0.0',
    publisher: { name: 'Tester' },
    description: 'plugin used by SDK-004 contract tests',
    icon: 'https://example.com/icon.svg',
    license: 'MIT',
    category: 'utility',
    tags: [],
    type: ['ui-extension'],
    entry: { module: 'index.js' },
    permissions: perms,
    pricing: { model: 'free' },
    refundPolicy: 'none',
    ...extras,
  } as PluginManifest;
}

function snapshot(): ProjectSnapshot {
  return {
    schemaVersion: 1,
    board: 'arduino-uno',
    files: [{ name: 'sketch.ino', content: 'void setup(){}\nvoid loop(){}' }],
    components: [],
    wires: [],
  };
}

function template(id: string): TemplateDefinition {
  return defineTemplate({
    id,
    name: `Template ${id}`,
    description: 'A template for testing.',
    category: 'beginner',
    difficulty: 1,
    snapshot: snapshot(),
  });
}

function library(id: string, dependsOn?: string[]): LibraryDefinition {
  return defineLibrary({
    id,
    version: '1.0.0',
    files: [
      { path: 'src/main.h', content: '#pragma once\n' },
      { path: 'src/main.cpp', content: '#include "main.h"\n' },
    ],
    platforms: ['avr'],
    ...(dependsOn ? { dependsOn } : {}),
  });
}

beforeEach(() => {
  resetTemplateRegistryForTests();
  resetLibraryRegistryForTests();
});

// ── Templates ────────────────────────────────────────────────────────────

describe('ctx.templates', () => {
  it('register requires templates.provide permission — missing throws PermissionDeniedError', () => {
    const { context } = createPluginContext(manifest([]), { events: fakeEvents });
    expect(() => context.templates.register(template('t1'))).toThrowError(PermissionDeniedError);
    // The host registry stays empty — gate failed fast, no state changed.
    expect(getTemplateRegistry().size()).toBe(0);
  });

  it('register with permission lands the template in the global registry', () => {
    const { context } = createPluginContext(manifest(['templates.provide']), {
      events: fakeEvents,
    });
    context.templates.register(template('t1'));
    expect(getTemplateRegistry().get('t1')?.definition.id).toBe('t1');
    expect(getTemplateRegistry().get('t1')?.pluginId).toBe('sdk004.test');
  });

  it('throws InvalidTemplateError when the snapshot is malformed', () => {
    const { context } = createPluginContext(manifest(['templates.provide']), {
      events: fakeEvents,
    });
    const bad: TemplateDefinition = {
      id: 't.bad',
      name: 'Bad',
      description: 'x',
      category: 'beginner',
      difficulty: 1,
      // Wire references a component that doesn't exist — validator catches it.
      snapshot: {
        schemaVersion: 1,
        board: 'arduino-uno',
        files: [{ name: 'sketch.ino', content: '' }],
        components: [],
        wires: [
          {
            id: 'w1',
            start: { componentId: 'ghost', pinName: 'A' },
            end: { componentId: 'ghost', pinName: 'B' },
          },
        ],
      },
    };
    expect(() => context.templates.register(bad)).toThrowError(InvalidTemplateError);
    // No partial registration leaks through.
    expect(getTemplateRegistry().size()).toBe(0);
  });

  it('throws DuplicateTemplateError when the id is already registered (cross-plugin too)', () => {
    const a = createPluginContext(
      manifest(['templates.provide'], { id: 'pluginA' }),
      { events: fakeEvents },
    );
    a.context.templates.register(template('shared'));

    const b = createPluginContext(
      manifest(['templates.provide'], { id: 'pluginB' }),
      { events: fakeEvents },
    );
    expect(() => b.context.templates.register(template('shared'))).toThrowError(
      DuplicateTemplateError,
    );
  });

  it('disposing the prior handle frees the id for re-registration', () => {
    const { context } = createPluginContext(manifest(['templates.provide']), {
      events: fakeEvents,
    });
    const first = context.templates.register(template('t1'));
    first.dispose();
    expect(getTemplateRegistry().get('t1')).toBeUndefined();
    expect(() => context.templates.register(template('t1'))).not.toThrow();
  });

  it('host dispose() unregisters every template the plugin contributed', () => {
    const { context, dispose } = createPluginContext(manifest(['templates.provide']), {
      events: fakeEvents,
    });
    context.templates.register(template('t1'));
    context.templates.register(template('t2'));
    context.templates.register(template('t3'));
    expect(getTemplateRegistry().size()).toBe(3);
    dispose();
    expect(getTemplateRegistry().size()).toBe(0);
  });

  it('list() returns templates sorted by category then name', () => {
    const { context } = createPluginContext(manifest(['templates.provide']), {
      events: fakeEvents,
    });
    context.templates.register({
      ...template('zeta'),
      category: 'showcase',
    });
    context.templates.register({
      ...template('alpha'),
      category: 'beginner',
    });
    context.templates.register({
      ...template('mike'),
      category: 'beginner',
    });
    const ids = getTemplateRegistry()
      .list()
      .map((t) => t.definition.id);
    // beginner: alpha, mike (alphabetical) — then showcase: zeta.
    expect(ids).toEqual(['alpha', 'mike', 'zeta']);
  });
});

// ── Libraries ────────────────────────────────────────────────────────────

describe('ctx.libraries', () => {
  it('register requires libraries.provide permission — missing throws PermissionDeniedError', () => {
    const { context } = createPluginContext(manifest([]), { events: fakeEvents });
    expect(() => context.libraries.register(library('LibA'))).toThrowError(PermissionDeniedError);
    expect(getLibraryRegistry().size()).toBe(0);
  });

  it('register with permission lands the library in the global registry', () => {
    const { context } = createPluginContext(manifest(['libraries.provide']), {
      events: fakeEvents,
    });
    context.libraries.register(library('LibA'));
    expect(getLibraryRegistry().get('LibA')?.definition.version).toBe('1.0.0');
    expect(getLibraryRegistry().get('LibA')?.pluginId).toBe('sdk004.test');
  });

  it('throws InvalidLibraryError on a per-file size cap violation', () => {
    const { context } = createPluginContext(manifest(['libraries.provide']), {
      events: fakeEvents,
    });
    const bad: LibraryDefinition = {
      id: 'BadLib',
      version: '1.0.0',
      files: [
        // 600 KB > 512 KB per-file cap.
        { path: 'src/big.cpp', content: 'a'.repeat(600_000) },
      ],
      platforms: ['avr'],
    };
    expect(() => context.libraries.register(bad)).toThrowError(InvalidLibraryError);
    expect(getLibraryRegistry().size()).toBe(0);
  });

  it('throws InvalidLibraryError on an unsafe file path', () => {
    const { context } = createPluginContext(manifest(['libraries.provide']), {
      events: fakeEvents,
    });
    const bad: LibraryDefinition = {
      id: 'EscapeLib',
      version: '1.0.0',
      files: [{ path: '../escape.h', content: '#pragma once\n' }],
      platforms: ['avr'],
    };
    expect(() => context.libraries.register(bad)).toThrowError(/safe relative path/);
  });

  it('throws DuplicateLibraryError on an id collision (cross-plugin)', () => {
    const a = createPluginContext(
      manifest(['libraries.provide'], { id: 'pluginA' }),
      { events: fakeEvents },
    );
    a.context.libraries.register(library('Adafruit_GFX'));

    const b = createPluginContext(
      manifest(['libraries.provide'], { id: 'pluginB' }),
      { events: fakeEvents },
    );
    expect(() => b.context.libraries.register(library('Adafruit_GFX'))).toThrowError(
      DuplicateLibraryError,
    );
  });

  it('host dispose() unregisters every library the plugin registered', () => {
    const { context, dispose } = createPluginContext(manifest(['libraries.provide']), {
      events: fakeEvents,
    });
    context.libraries.register(library('A'));
    context.libraries.register(library('B'));
    context.libraries.register(library('C'));
    expect(getLibraryRegistry().size()).toBe(3);
    dispose();
    expect(getLibraryRegistry().size()).toBe(0);
  });

  it('resolve() topologically sorts dependencies (deps before dependents)', () => {
    const { context } = createPluginContext(manifest(['libraries.provide']), {
      events: fakeEvents,
    });
    context.libraries.register(library('Adafruit_GFX'));
    context.libraries.register(library('Adafruit_BusIO'));
    context.libraries.register(library('Adafruit_SSD1306', ['Adafruit_GFX', 'Adafruit_BusIO']));

    const order = context.libraries
      .resolve(['Adafruit_SSD1306'])
      .map((l) => l.definition.id);
    expect(order[order.length - 1]).toBe('Adafruit_SSD1306');
    // Both deps come before the dependent.
    expect(order.indexOf('Adafruit_GFX')).toBeLessThan(order.indexOf('Adafruit_SSD1306'));
    expect(order.indexOf('Adafruit_BusIO')).toBeLessThan(order.indexOf('Adafruit_SSD1306'));
  });

  it('resolve() silently skips unknown ids (not registered)', () => {
    const { context } = createPluginContext(manifest(['libraries.provide']), {
      events: fakeEvents,
    });
    context.libraries.register(library('Known'));
    const out = context.libraries.resolve(['Known', 'Phantom', 'Ghost']);
    expect(out.map((l) => l.definition.id)).toEqual(['Known']);
  });

  it('resolve() throws LibraryDependencyCycleError when the graph cycles', () => {
    const { context } = createPluginContext(manifest(['libraries.provide']), {
      events: fakeEvents,
    });
    context.libraries.register(library('A', ['B']));
    context.libraries.register(library('B', ['C']));
    context.libraries.register(library('C', ['A']));
    expect(() => context.libraries.resolve(['A'])).toThrowError(LibraryDependencyCycleError);
    try {
      context.libraries.resolve(['A']);
    } catch (err) {
      const e = err as LibraryDependencyCycleError;
      // Cycle starts and ends with the same id — A → B → C → A.
      expect(e.cyclePath[0]).toBe(e.cyclePath[e.cyclePath.length - 1]);
    }
  });

  it('resolve() handles a diamond (no double-emit)', () => {
    const { context } = createPluginContext(manifest(['libraries.provide']), {
      events: fakeEvents,
    });
    // top depends on left + right, both depend on bottom.
    context.libraries.register(library('bottom'));
    context.libraries.register(library('left', ['bottom']));
    context.libraries.register(library('right', ['bottom']));
    context.libraries.register(library('top', ['left', 'right']));

    const order = context.libraries.resolve(['top']).map((l) => l.definition.id);
    expect(order).toHaveLength(4);
    expect(new Set(order).size).toBe(4); // no dupes
    expect(order[0]).toBe('bottom');
    expect(order[order.length - 1]).toBe('top');
  });
});

// ── Subscribe / live updates ─────────────────────────────────────────────

describe('host registry subscribers', () => {
  it('TemplateRegistry.subscribe fires on register and unregister', () => {
    const listener = vi.fn();
    const off = getTemplateRegistry().subscribe(listener);
    const { context, dispose } = createPluginContext(manifest(['templates.provide']), {
      events: fakeEvents,
    });
    context.templates.register(template('x'));
    expect(listener).toHaveBeenCalledTimes(1);
    dispose();
    expect(listener).toHaveBeenCalledTimes(2);
    off();
  });

  it('LibraryRegistry.subscribe fires on register and unregister', () => {
    const listener = vi.fn();
    const off = getLibraryRegistry().subscribe(listener);
    const { context, dispose } = createPluginContext(manifest(['libraries.provide']), {
      events: fakeEvents,
    });
    context.libraries.register(library('X'));
    expect(listener).toHaveBeenCalledTimes(1);
    dispose();
    expect(listener).toHaveBeenCalledTimes(2);
    off();
  });
});
