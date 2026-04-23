/**
 * Manifest schema coverage.
 *
 * Every branch of the schema must have at least one positive case and
 * one negative case. Organized by field; group names match the manifest
 * key they exercise.
 */
import { describe, expect, it } from 'vitest';
import { validateManifest, PluginManifestSchema } from '../src/manifest';
import type { PluginManifest } from '../src/manifest';

// ── Fixture: minimal valid manifest ──────────────────────────────────────

const base: unknown = {
  schemaVersion: 1,
  id: 'my-plugin',
  name: 'My Plugin',
  version: '1.0.0',
  sdkVersion: '^1.0.0',
  minVelxioVersion: '>=2.0.0',
  author: { name: 'Jane Dev' },
  description: 'A totally reasonable plugin description that meets the minimum length.',
  icon: 'https://cdn.example.com/icon.png',
  license: 'MIT',
  category: 'tools',
  type: ['ui-extension'],
  entry: './plugin.mjs',
};

function withOverride<T extends object>(override: T): unknown {
  return { ...(base as object), ...override };
}

// ── Happy path ───────────────────────────────────────────────────────────

describe('validateManifest — happy path', () => {
  it('accepts a minimal manifest', () => {
    const r = validateManifest(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.id).toBe('my-plugin');
      expect(r.manifest.permissions).toEqual([]);
      expect(r.manifest.pricing).toEqual({ model: 'free' });
      expect(r.manifest.refundPolicy).toBe('14d');
    }
  });

  it('accepts a fully-featured manifest', () => {
    const full = withOverride({
      longDescription: '# Hello\n\nFull markdown doc.',
      cover: 'https://cdn.example.com/cover.png',
      screenshots: ['https://cdn.example.com/1.png', 'https://cdn.example.com/2.png'],
      homepage: 'https://plugin.example.com',
      repository: 'https://github.com/example/plugin',
      tags: ['analog', 'logic-analyzer'],
      permissions: ['simulator.events.read', 'http.fetch', 'ui.panel.register'],
      http: { allowlist: ['https://api.example.com'] },
      pricing: { model: 'one-time', currency: 'USD', amount: 999 },
      refundPolicy: '14d',
      i18n: ['en', 'en-US', 'pt-BR'],
    });
    const r = validateManifest(full);
    expect(r.ok).toBe(true);
  });

  it('accepts subscription pricing with trial', () => {
    const r = validateManifest(
      withOverride({
        pricing: { model: 'subscription', currency: 'EUR', amount: 500, trialDays: 7 },
        refundPolicy: '7d',
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('accepts subscription pricing without explicit trial (defaults to 0)', () => {
    const r = validateManifest(
      withOverride({
        pricing: { model: 'subscription', currency: 'USD', amount: 200 },
        refundPolicy: '14d',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.manifest.pricing.model === 'subscription') {
      expect(r.manifest.pricing.trialDays).toBe(0);
    }
  });
});

// ── schemaVersion ────────────────────────────────────────────────────────

describe('schemaVersion', () => {
  it('rejects schemaVersion !== 1', () => {
    const r = validateManifest(withOverride({ schemaVersion: 2 }));
    expect(r.ok).toBe(false);
  });
  it('rejects missing schemaVersion', () => {
    const bad = { ...(base as object) } as Record<string, unknown>;
    delete bad.schemaVersion;
    expect(validateManifest(bad).ok).toBe(false);
  });
});

// ── id ────────────────────────────────────────────────────────────────────

describe('id', () => {
  it.each(['abc', 'my-plugin', 'a1b', 'logic-analyzer-v2'])(
    'accepts valid id "%s"',
    (id) => {
      expect(validateManifest(withOverride({ id })).ok).toBe(true);
    },
  );

  it.each([
    'ab',            // too short
    '1-starts-digit',
    '-starts-dash',
    'has_underscore',
    'HasCaps',
    'has spaces',
    'a'.repeat(65),  // too long
  ])('rejects invalid id "%s"', (id) => {
    expect(validateManifest(withOverride({ id })).ok).toBe(false);
  });
});

// ── name ─────────────────────────────────────────────────────────────────

describe('name', () => {
  it('rejects too short', () => {
    expect(validateManifest(withOverride({ name: 'ab' })).ok).toBe(false);
  });
  it('rejects too long', () => {
    expect(validateManifest(withOverride({ name: 'a'.repeat(65) })).ok).toBe(false);
  });
});

// ── version (semver) ─────────────────────────────────────────────────────

describe('version', () => {
  it.each(['0.0.0', '1.2.3', '10.20.30', '1.0.0-beta', '2.0.0-rc.1', '1.0.0+build.42'])(
    'accepts %s',
    (v) => {
      expect(validateManifest(withOverride({ version: v })).ok).toBe(true);
    },
  );
  it.each(['1.0', '1', 'v1.0.0', '1.0.0.0', 'latest'])('rejects %s', (v) => {
    expect(validateManifest(withOverride({ version: v })).ok).toBe(false);
  });
});

// ── sdkVersion / minVelxioVersion ───────────────────────────────────────

describe('semver range fields', () => {
  it.each(['1.0.0', '^1.0.0', '~1.0', '1.x', '>=1.0.0 <2.0.0', '>=1.0 || <3'])(
    'accepts sdkVersion %s',
    (r) => {
      expect(validateManifest(withOverride({ sdkVersion: r })).ok).toBe(true);
    },
  );
  it('rejects empty sdkVersion', () => {
    expect(validateManifest(withOverride({ sdkVersion: '' })).ok).toBe(false);
  });
  it('rejects sdkVersion with invalid chars', () => {
    expect(validateManifest(withOverride({ sdkVersion: '1.0.0@foo' })).ok).toBe(false);
  });
});

// ── author ────────────────────────────────────────────────────────────────

describe('author', () => {
  it('rejects empty name', () => {
    expect(validateManifest(withOverride({ author: { name: '' } })).ok).toBe(false);
  });
  it('rejects malformed email', () => {
    expect(
      validateManifest(withOverride({ author: { name: 'Jane', email: 'not-an-email' } })).ok,
    ).toBe(false);
  });
  it('accepts velxioUserId uuid', () => {
    expect(
      validateManifest(
        withOverride({
          author: { name: 'Jane', velxioUserId: '11111111-2222-3333-4444-555555555555' },
        }),
      ).ok,
    ).toBe(true);
  });
  it('rejects non-uuid velxioUserId', () => {
    expect(
      validateManifest(withOverride({ author: { name: 'Jane', velxioUserId: 'not-uuid' } })).ok,
    ).toBe(false);
  });
});

// ── description ──────────────────────────────────────────────────────────

describe('description', () => {
  it('rejects < 20 chars', () => {
    expect(validateManifest(withOverride({ description: 'too short' })).ok).toBe(false);
  });
  it('rejects > 280 chars', () => {
    expect(validateManifest(withOverride({ description: 'a'.repeat(281) })).ok).toBe(false);
  });
});

// ── icon ──────────────────────────────────────────────────────────────────

describe('icon', () => {
  it('accepts https URL', () => {
    expect(validateManifest(withOverride({ icon: 'https://x.example/a.png' })).ok).toBe(true);
  });
  it('accepts base64 data URI (png)', () => {
    expect(validateManifest(withOverride({ icon: 'data:image/png;base64,AAAA' })).ok).toBe(true);
  });
  it('accepts base64 data URI (svg+xml)', () => {
    expect(validateManifest(withOverride({ icon: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })).ok).toBe(true);
  });
  it('rejects http (not https)', () => {
    expect(validateManifest(withOverride({ icon: 'http://x.example/a.png' })).ok).toBe(false);
  });
  it('rejects data URI with wrong mime', () => {
    expect(validateManifest(withOverride({ icon: 'data:image/jpeg;base64,XXX' })).ok).toBe(false);
  });
});

// ── license ──────────────────────────────────────────────────────────────

describe('license', () => {
  it('accepts SPDX id', () => {
    expect(validateManifest(withOverride({ license: 'Apache-2.0' })).ok).toBe(true);
  });
  it('accepts "Proprietary"', () => {
    expect(validateManifest(withOverride({ license: 'Proprietary' })).ok).toBe(true);
  });
  it('rejects empty', () => {
    expect(validateManifest(withOverride({ license: '' })).ok).toBe(false);
  });
});

// ── category / type ──────────────────────────────────────────────────────

describe('category/type', () => {
  it('rejects unknown category', () => {
    expect(validateManifest(withOverride({ category: 'banana' })).ok).toBe(false);
  });
  it('rejects empty type[]', () => {
    expect(validateManifest(withOverride({ type: [] })).ok).toBe(false);
  });
  it('rejects unknown type entry', () => {
    expect(validateManifest(withOverride({ type: ['banana'] })).ok).toBe(false);
  });
  it('accepts multiple types', () => {
    expect(
      validateManifest(withOverride({ type: ['component', 'simulation', 'spice-mapper'] })).ok,
    ).toBe(true);
  });
});

// ── tags ─────────────────────────────────────────────────────────────────

describe('tags', () => {
  it('rejects >10 tags', () => {
    expect(validateManifest(withOverride({ tags: Array(11).fill('x') })).ok).toBe(false);
  });
  it('rejects invalid tag format', () => {
    expect(validateManifest(withOverride({ tags: ['Has Caps'] })).ok).toBe(false);
  });
  it('defaults to []', () => {
    const r = validateManifest(base);
    expect(r.ok && r.manifest.tags).toEqual([]);
  });
});

// ── entry ────────────────────────────────────────────────────────────────

describe('entry', () => {
  it.each(['./plugin.mjs', './dist/index.js', './src/nested/entry.mjs'])(
    'accepts %s',
    (entry) => {
      expect(validateManifest(withOverride({ entry })).ok).toBe(true);
    },
  );
  it.each(['plugin.mjs', '/abs.mjs', './plugin.ts', './plugin.json', '../escape.mjs'])(
    'rejects %s',
    (entry) => {
      expect(validateManifest(withOverride({ entry })).ok).toBe(false);
    },
  );
});

// ── permissions ──────────────────────────────────────────────────────────

describe('permissions', () => {
  it('accepts empty array', () => {
    expect(validateManifest(withOverride({ permissions: [] })).ok).toBe(true);
  });
  it('rejects unknown permission', () => {
    expect(validateManifest(withOverride({ permissions: ['god.mode'] })).ok).toBe(false);
  });
  it('semantic: http.fetch requires http.allowlist', () => {
    const r = validateManifest(withOverride({ permissions: ['http.fetch'] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.path.includes('http.allowlist'))).toBe(true);
    }
  });
  it('semantic: http.fetch + http.allowlist is accepted', () => {
    expect(
      validateManifest(
        withOverride({
          permissions: ['http.fetch'],
          http: { allowlist: ['https://api.example.com'] },
        }),
      ).ok,
    ).toBe(true);
  });
});

// ── http.allowlist ───────────────────────────────────────────────────────

describe('http.allowlist', () => {
  it('rejects empty allowlist when http object is set', () => {
    const r = validateManifest(withOverride({ http: { allowlist: [] } }));
    expect(r.ok).toBe(false);
  });
  it('rejects > 10 entries', () => {
    expect(
      validateManifest(
        withOverride({ http: { allowlist: Array(11).fill('https://x.example') } }),
      ).ok,
    ).toBe(false);
  });
  it('rejects non-https', () => {
    expect(validateManifest(withOverride({ http: { allowlist: ['http://x.example'] } })).ok).toBe(
      false,
    );
  });
});

// ── pricing ──────────────────────────────────────────────────────────────

describe('pricing', () => {
  it('rejects zero amount', () => {
    expect(
      validateManifest(withOverride({ pricing: { model: 'one-time', currency: 'USD', amount: 0 } })).ok,
    ).toBe(false);
  });
  it('rejects negative amount', () => {
    expect(
      validateManifest(withOverride({ pricing: { model: 'one-time', currency: 'USD', amount: -5 } })).ok,
    ).toBe(false);
  });
  it('rejects unknown currency', () => {
    expect(
      validateManifest(
        withOverride({ pricing: { model: 'one-time', currency: 'BRL', amount: 100 } }),
      ).ok,
    ).toBe(false);
  });
  it('rejects trialDays > 30', () => {
    expect(
      validateManifest(
        withOverride({
          pricing: { model: 'subscription', currency: 'USD', amount: 100, trialDays: 31 },
        }),
      ).ok,
    ).toBe(false);
  });
  it('rejects non-integer amount', () => {
    expect(
      validateManifest(
        withOverride({ pricing: { model: 'one-time', currency: 'USD', amount: 1.5 } }),
      ).ok,
    ).toBe(false);
  });
});

// ── refundPolicy ─────────────────────────────────────────────────────────

describe('refundPolicy', () => {
  it('accepts "none"', () => {
    expect(validateManifest(withOverride({ refundPolicy: 'none' })).ok).toBe(true);
  });
  it('accepts "7d"', () => {
    expect(validateManifest(withOverride({ refundPolicy: '7d' })).ok).toBe(true);
  });
  it('accepts "14d"', () => {
    expect(validateManifest(withOverride({ refundPolicy: '14d' })).ok).toBe(true);
  });
  it('accepts "30d"', () => {
    expect(validateManifest(withOverride({ refundPolicy: '30d' })).ok).toBe(true);
  });
  it('rejects unknown value', () => {
    expect(validateManifest(withOverride({ refundPolicy: '60d' })).ok).toBe(false);
  });
});

// ── i18n ─────────────────────────────────────────────────────────────────

describe('i18n', () => {
  it.each(['en', 'en-US', 'pt-BR', 'es', 'zh-CN'])('accepts locale %s', (l) => {
    expect(validateManifest(withOverride({ i18n: [l] })).ok).toBe(true);
  });
  it.each(['EN', 'en_US', 'english', 'en-us'])('rejects locale %s', (l) => {
    expect(validateManifest(withOverride({ i18n: [l] })).ok).toBe(false);
  });
});

// ── screenshots cap ──────────────────────────────────────────────────────

describe('screenshots', () => {
  it('rejects > 8 screenshots', () => {
    expect(
      validateManifest(
        withOverride({
          screenshots: Array(9).fill('https://x.example/s.png'),
        }),
      ).ok,
    ).toBe(false);
  });
});

// ── round-trip (parse then re-parse) ─────────────────────────────────────

describe('round trip', () => {
  it('re-parses the normalized output cleanly', () => {
    const r1 = validateManifest(base);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = PluginManifestSchema.safeParse(r1.manifest);
    expect(r2.success).toBe(true);
  });

  it('preserves defaults across round trip', () => {
    const r = validateManifest(base);
    if (!r.ok) throw new Error('should have parsed');
    const m: PluginManifest = r.manifest;
    expect(m.tags).toEqual([]);
    expect(m.permissions).toEqual([]);
    expect(m.pricing).toEqual({ model: 'free' });
    expect(m.refundPolicy).toBe('14d');
  });
});

// ── top-level extras ─────────────────────────────────────────────────────

describe('top-level', () => {
  it('rejects null', () => {
    expect(validateManifest(null).ok).toBe(false);
  });
  it('rejects array', () => {
    expect(validateManifest([]).ok).toBe(false);
  });
  it('rejects string', () => {
    expect(validateManifest('plugin').ok).toBe(false);
  });
  it('accepts manifest with unknown keys (Zod strips them)', () => {
    const r = validateManifest({ ...(base as object), extraField: 'ignored' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((r.manifest as any).extraField).toBeUndefined();
    }
  });
});
