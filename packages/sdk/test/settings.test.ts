import { describe, expect, it } from 'vitest';

import {
  InvalidSettingsSchemaError,
  SETTINGS_MAX_PROPERTIES,
  SETTINGS_MAX_VALUES_BYTES,
  applyAndValidate,
  defineSettingsSchema,
  validateSettingsSchema,
  type SettingsSchema,
} from '../src';

describe('SDK · validateSettingsSchema', () => {
  it('accepts a flat schema with mixed primitive types', () => {
    const schema = defineSettingsSchema({
      type: 'object',
      properties: {
        apiKey: { type: 'string', format: 'password', title: 'API Key' },
        threshold: { type: 'number', minimum: 0, maximum: 100, default: 50 },
        mode: { type: 'string', enum: ['fast', 'accurate'], default: 'fast' },
        enabled: { type: 'boolean', default: true },
      },
      required: ['apiKey'],
    });
    expect(validateSettingsSchema(schema, 'plug-a')).toEqual(schema);
  });

  it('accepts a schema with one level of nested object', () => {
    const schema: SettingsSchema = {
      type: 'object',
      properties: {
        proxy: {
          type: 'object',
          properties: {
            host: { type: 'string' },
            port: { type: 'integer', minimum: 1, maximum: 65535 },
          },
          required: ['host'],
        },
      },
    };
    expect(validateSettingsSchema(schema, 'plug-a')).toEqual(schema);
  });

  it('accepts an array-of-strings property', () => {
    const schema: SettingsSchema = {
      type: 'object',
      properties: {
        boards: { type: 'array', items: { type: 'string' }, default: ['arduino-uno'] },
      },
    };
    expect(validateSettingsSchema(schema, 'plug-a')).toEqual(schema);
  });

  it('rejects a schema with two levels of nested objects', () => {
    expect(() =>
      validateSettingsSchema(
        {
          type: 'object',
          properties: {
            outer: {
              type: 'object',
              properties: {
                inner: {
                  type: 'object',
                  properties: { x: { type: 'string' } },
                },
              },
            },
          },
        },
        'plug-a',
      ),
    ).toThrow(InvalidSettingsSchemaError);
  });

  it('rejects an array of non-strings (renderer ships only string lists)', () => {
    expect(() =>
      validateSettingsSchema(
        {
          type: 'object',
          properties: {
            ports: { type: 'array', items: { type: 'number' } as never },
          },
        },
        'plug-a',
      ),
    ).toThrow(InvalidSettingsSchemaError);
  });

  it('rejects a required key that does not exist in properties', () => {
    expect(() =>
      validateSettingsSchema(
        {
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['a', 'missing'],
        },
        'plug-a',
      ),
    ).toThrow(/required key "missing"/);
  });

  it('rejects an inner object whose required key is not in its properties', () => {
    expect(() =>
      validateSettingsSchema(
        {
          type: 'object',
          properties: {
            wrap: {
              type: 'object',
              properties: { a: { type: 'string' } },
              required: ['absent'],
            },
          },
        },
        'plug-a',
      ),
    ).toThrow(/object "wrap" requires "absent"/);
  });

  it('rejects more than SETTINGS_MAX_PROPERTIES top-level keys', () => {
    const properties: Record<string, { type: 'string' }> = {};
    for (let i = 0; i <= SETTINGS_MAX_PROPERTIES; i += 1) {
      properties[`k${i}`] = { type: 'string' };
    }
    expect(() => validateSettingsSchema({ type: 'object', properties }, 'plug-a')).toThrow(
      /max is 64/,
    );
  });

  it('error message contains the plugin id', () => {
    try {
      validateSettingsSchema({ type: 'array' } as never, 'my-plugin');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidSettingsSchemaError);
      expect((e as Error).message).toContain('"my-plugin"');
    }
  });
});

describe('SDK · applyAndValidate — happy paths', () => {
  const schema: SettingsSchema = {
    type: 'object',
    properties: {
      apiKey: { type: 'string', minLength: 4, default: '' },
      threshold: { type: 'number', minimum: 0, maximum: 100, default: 50 },
      port: { type: 'integer', minimum: 1, maximum: 65535 },
      mode: { type: 'string', enum: ['fast', 'accurate'], default: 'fast' },
      enabled: { type: 'boolean', default: true },
      tags: { type: 'array', items: { type: 'string' }, default: [] },
    },
    required: ['apiKey'],
  };

  it('fills defaults from the schema when the partial omits a key', () => {
    const r = applyAndValidate(schema, { apiKey: 'abcd' }, {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.values).toMatchObject({
        apiKey: 'abcd',
        threshold: 50,
        mode: 'fast',
        enabled: true,
        tags: [],
      });
    }
  });

  it('coerces a string-form number into a number for numeric fields', () => {
    const r = applyAndValidate(schema, { apiKey: 'abcd', threshold: '42' }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values?.threshold).toBe(42);
  });

  it('rejects an integer field with a fractional value', () => {
    const r = applyAndValidate(schema, { apiKey: 'abcd', port: 80.5 }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.port).toMatch(/integer/);
  });

  it('rejects a value out of range (minimum)', () => {
    const r = applyAndValidate(schema, { apiKey: 'abcd', threshold: -1 }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.threshold).toMatch(/≥ 0/);
  });

  it('rejects an enum value that is not in the allowed list', () => {
    const r = applyAndValidate(schema, { apiKey: 'abcd', mode: 'turbo' }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.mode).toMatch(/one of/);
  });

  it('flags a required string when empty', () => {
    const r = applyAndValidate(schema, { apiKey: '' }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.apiKey).toBe('required');
  });

  it('flags a required string when absent (no default to fall back to)', () => {
    const r = applyAndValidate(schema, {}, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.apiKey).toBe('required');
  });

  it('rejects an unknown top-level key by silently dropping it', () => {
    const r = applyAndValidate(schema, { apiKey: 'abcd', extra: 'ignored' }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.values as Record<string, unknown>).extra).toBeUndefined();
  });

  it('preserves existing values when partial does not mention them', () => {
    const r = applyAndValidate(
      schema,
      { mode: 'accurate' }, // partial; apiKey unchanged
      { apiKey: 'sk-abc', threshold: 75 },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.values?.apiKey).toBe('sk-abc');
      expect(r.values?.threshold).toBe(75);
      expect(r.values?.mode).toBe('accurate');
    }
  });
});

describe('SDK · applyAndValidate — pattern + multipleOf', () => {
  it('accepts a string matching the schema pattern', () => {
    const r = applyAndValidate(
      {
        type: 'object',
        properties: { token: { type: 'string', pattern: '^sk-[a-z0-9]+$' } },
      },
      { token: 'sk-abc123' },
      {},
    );
    expect(r.ok).toBe(true);
  });

  it('rejects a string failing the pattern', () => {
    const r = applyAndValidate(
      {
        type: 'object',
        properties: { token: { type: 'string', pattern: '^sk-[a-z0-9]+$' } },
      },
      { token: 'NOPE' },
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.token).toMatch(/pattern/);
  });

  it('handles invalid regex in the schema gracefully', () => {
    const r = applyAndValidate(
      {
        type: 'object',
        properties: { x: { type: 'string', pattern: '(unclosed' } },
      },
      { x: 'anything' },
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.x).toMatch(/pattern is invalid/);
  });

  it('enforces multipleOf for numbers', () => {
    const r = applyAndValidate(
      {
        type: 'object',
        properties: { stride: { type: 'number', multipleOf: 5 } },
      },
      { stride: 12 },
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.stride).toMatch(/multiple of 5/);
  });
});

describe('SDK · applyAndValidate — nested objects', () => {
  const schema: SettingsSchema = {
    type: 'object',
    properties: {
      proxy: {
        type: 'object',
        properties: {
          host: { type: 'string' },
          port: { type: 'integer', default: 8080 },
        },
        required: ['host'],
      },
    },
  };

  it('fills inner defaults', () => {
    const r = applyAndValidate(schema, { proxy: { host: 'example.com' } }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values?.proxy).toMatchObject({ host: 'example.com', port: 8080 });
  });

  it('flags inner required field with a path-prefixed error', () => {
    const r = applyAndValidate(schema, { proxy: {} }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors['proxy.host']).toBe('required');
  });

  it('rejects when the outer key is not actually an object', () => {
    const r = applyAndValidate(schema, { proxy: 'not-an-object' }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.proxy).toMatch(/must be an object/);
  });
});

describe('SDK · applyAndValidate — size cap', () => {
  it('rejects values whose JSON exceeds SETTINGS_MAX_VALUES_BYTES', () => {
    const big = 'x'.repeat(SETTINGS_MAX_VALUES_BYTES);
    const r = applyAndValidate(
      {
        type: 'object',
        properties: { blob: { type: 'string' } },
      },
      { blob: big },
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.__root__).toMatch(/exceed/);
  });
});

describe('SDK · defineSettingsSchema', () => {
  it('returns the same object reference (identity helper)', () => {
    const s = { type: 'object', properties: {} } as const;
    expect(defineSettingsSchema(s as SettingsSchema)).toBe(s);
  });
});
