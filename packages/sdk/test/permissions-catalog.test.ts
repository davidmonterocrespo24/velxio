import { describe, expect, it } from 'vitest';

import {
  PERMISSION_CATALOG,
  PLUGIN_PERMISSIONS,
  classifyUpdateDiff,
  diffPermissions,
  getPermissionEntry,
  partitionPermissionsByRisk,
  requiresConsent,
  type PermissionRisk,
  type PluginPermission,
} from '../src';

describe('PERMISSION_CATALOG — shape', () => {
  it('has exactly one catalog entry per PLUGIN_PERMISSIONS string', () => {
    expect(PERMISSION_CATALOG).toHaveLength(PLUGIN_PERMISSIONS.length);
    const catalogPerms = new Set(PERMISSION_CATALOG.map((e) => e.permission));
    for (const perm of PLUGIN_PERMISSIONS) {
      expect(catalogPerms.has(perm)).toBe(true);
    }
  });

  it('has no duplicate entries', () => {
    const seen = new Set<string>();
    for (const entry of PERMISSION_CATALOG) {
      expect(seen.has(entry.permission)).toBe(false);
      seen.add(entry.permission);
    }
  });

  it('every entry has non-empty allows/denies copy and a valid risk class', () => {
    const validRisks: ReadonlySet<PermissionRisk> = new Set(['low', 'medium', 'high']);
    for (const entry of PERMISSION_CATALOG) {
      expect(entry.allows.length).toBeGreaterThan(10);
      expect(entry.denies.length).toBeGreaterThan(10);
      expect(validRisks.has(entry.risk)).toBe(true);
    }
  });
});

describe('getPermissionEntry', () => {
  it('returns the entry for a known permission', () => {
    const entry = getPermissionEntry('http.fetch');
    expect(entry).toBeDefined();
    expect(entry!.risk).toBe('high');
    expect(entry!.permission).toBe('http.fetch');
  });

  it('returns undefined for an unknown permission', () => {
    const entry = getPermissionEntry('totally.fake' as PluginPermission);
    expect(entry).toBeUndefined();
  });
});

describe('partitionPermissionsByRisk', () => {
  it('groups by risk and preserves order within a group', () => {
    const result = partitionPermissionsByRisk([
      'ui.command.register',
      'http.fetch',
      'storage.user.write',
      'ui.toolbar.register',
      'components.register',
    ]);
    expect(result.low.map((e) => e.permission)).toEqual([
      'ui.command.register',
      'ui.toolbar.register',
    ]);
    expect(result.medium.map((e) => e.permission)).toEqual([
      'storage.user.write',
      'components.register',
    ]);
    expect(result.high.map((e) => e.permission)).toEqual(['http.fetch']);
    expect(result.unknown).toEqual([]);
  });

  it('isolates unknown permissions instead of throwing', () => {
    const result = partitionPermissionsByRisk([
      'ui.command.register',
      'totally.fake' as PluginPermission,
    ]);
    expect(result.low.map((e) => e.permission)).toEqual(['ui.command.register']);
    expect(result.unknown).toEqual(['totally.fake']);
  });
});

describe('requiresConsent', () => {
  it('returns false when every permission is Low', () => {
    expect(
      requiresConsent([
        'ui.command.register',
        'ui.toolbar.register',
        'simulator.events.read',
        'settings.declare',
      ]),
    ).toBe(false);
  });

  it('returns true when any permission is Medium', () => {
    expect(requiresConsent(['ui.command.register', 'storage.user.write'])).toBe(true);
  });

  it('returns true when any permission is High', () => {
    expect(requiresConsent(['ui.command.register', 'http.fetch'])).toBe(true);
  });

  it('returns true defensively when an unknown permission appears', () => {
    expect(
      requiresConsent(['ui.command.register', 'totally.fake' as PluginPermission]),
    ).toBe(true);
  });

  it('returns false on an empty permissions array', () => {
    expect(requiresConsent([])).toBe(false);
  });
});

describe('diffPermissions', () => {
  it('computes added and removed', () => {
    const result = diffPermissions(
      ['ui.command.register', 'storage.user.write'],
      ['ui.command.register', 'http.fetch'],
    );
    expect(result.added).toEqual(['http.fetch']);
    expect(result.removed).toEqual(['storage.user.write']);
  });

  it('returns empty arrays when sets are equal', () => {
    const result = diffPermissions(
      ['ui.command.register', 'http.fetch'],
      ['http.fetch', 'ui.command.register'],
    );
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('de-duplicates input', () => {
    const result = diffPermissions(
      ['ui.command.register', 'ui.command.register'],
      ['ui.command.register'],
    );
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });
});

describe('classifyUpdateDiff', () => {
  it('returns auto-approve when no permissions were added', () => {
    const decision = classifyUpdateDiff({
      added: [],
      removed: ['storage.user.write'],
    });
    expect(decision.kind).toBe('auto-approve');
  });

  it('returns auto-approve-with-toast when only Low were added', () => {
    const decision = classifyUpdateDiff({
      added: ['ui.command.register', 'ui.toolbar.register'],
      removed: [],
    });
    expect(decision.kind).toBe('auto-approve-with-toast');
    if (decision.kind === 'auto-approve-with-toast') {
      expect(decision.added.map((e) => e.permission)).toEqual([
        'ui.command.register',
        'ui.toolbar.register',
      ]);
    }
  });

  it('returns requires-consent when a Medium is added', () => {
    const decision = classifyUpdateDiff({
      added: ['ui.command.register', 'storage.user.write'],
      removed: ['simulator.events.read'],
    });
    expect(decision.kind).toBe('requires-consent');
    if (decision.kind === 'requires-consent') {
      expect(decision.added).toEqual(['ui.command.register', 'storage.user.write']);
      expect(decision.addedHighRisk.medium.map((e) => e.permission)).toEqual([
        'storage.user.write',
      ]);
      expect(decision.removed).toEqual(['simulator.events.read']);
    }
  });

  it('returns requires-consent when a High is added', () => {
    const decision = classifyUpdateDiff({
      added: ['http.fetch'],
      removed: [],
    });
    expect(decision.kind).toBe('requires-consent');
  });

  it('returns requires-consent when an unknown is added (fail-closed)', () => {
    const decision = classifyUpdateDiff({
      added: ['totally.fake' as PluginPermission],
      removed: [],
    });
    expect(decision.kind).toBe('requires-consent');
  });
});
