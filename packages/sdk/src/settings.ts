/**
 * Plugin settings — schema-driven, host-rendered, plugin-validated.
 *
 * A plugin declares the *shape* of its user-tunable configuration as a
 * JSON-Schema-like object. The host then renders a form (built into the
 * "Installed Plugins" panel — wired in CORE-008/SDK-006b), persists the
 * values, and notifies the plugin via `ctx.settings.onChange`.
 *
 * The schema language is intentionally a small subset of JSON Schema:
 *
 *   - `type`: one of `string` | `number` | `integer` | `boolean` | `object` | `array`
 *   - `string`: optional `format` (`text`, `password`, `url`, `email`, `multiline`),
 *     `enum`, `minLength`, `maxLength`, `pattern`
 *   - `number` / `integer`: `minimum`, `maximum`, `multipleOf`
 *   - `array`: `items` must be `string` (string-list only — keeps the
 *     renderer trivial)
 *   - `object`: `properties` map, optional `required` list, max one
 *     level of nesting (no objects inside objects)
 *   - every leaf may carry `title`, `description`, `default`
 *
 * Why a subset and not full JSON Schema:
 *   - the renderer is bounded — we ship one canonical form per type
 *   - validation surface is bounded — fewer corners for plugin authors to
 *     trip over (no `oneOf`, `allOf`, recursive refs, etc.)
 *   - settings are user-tunable knobs, not arbitrary structured data;
 *     anything richer belongs in `userStorage`.
 *
 * Settings persist per (user, pluginId) — the host owns the namespace.
 * No permission is required to *read* settings (they are the plugin's
 * own config); declaring them requires `settings.declare`.
 */

import { z } from 'zod';

import type { Disposable } from './components';

/** Maximum number of top-level properties in a settings schema. */
export const SETTINGS_MAX_PROPERTIES = 64;

/** Maximum nesting depth (1 = flat, 2 = one level of `object` allowed). */
export const SETTINGS_MAX_DEPTH = 2;

/** Maximum bytes (UTF-8) of the persisted values JSON. */
export const SETTINGS_MAX_VALUES_BYTES = 32_768; // 32 KB

/** Maximum length of an enum entry list. */
export const SETTINGS_MAX_ENUM = 64;

/** Maximum length of a string-typed value (chars, not bytes). */
export const SETTINGS_MAX_STRING_LENGTH = 4_096;

// ─── Schema language ──────────────────────────────────────────────────────

export const StringFormatSchema = z.enum([
  'text',
  'password',
  'url',
  'email',
  'multiline',
]);
export type StringFormat = z.infer<typeof StringFormatSchema>;

const propertyMetaSchema = z.object({
  title: z.string().max(120).optional(),
  description: z.string().max(800).optional(),
});

const stringPropertySchema = propertyMetaSchema.extend({
  type: z.literal('string'),
  format: StringFormatSchema.optional(),
  enum: z.array(z.string()).max(SETTINGS_MAX_ENUM).optional(),
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().positive().max(SETTINGS_MAX_STRING_LENGTH).optional(),
  pattern: z.string().max(200).optional(),
  default: z.string().optional(),
});

const numberPropertySchema = propertyMetaSchema.extend({
  type: z.union([z.literal('number'), z.literal('integer')]),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  multipleOf: z.number().positive().optional(),
  default: z.number().optional(),
});

const booleanPropertySchema = propertyMetaSchema.extend({
  type: z.literal('boolean'),
  default: z.boolean().optional(),
});

const arrayPropertySchema = propertyMetaSchema.extend({
  type: z.literal('array'),
  items: z.object({ type: z.literal('string') }),
  minItems: z.number().int().min(0).optional(),
  maxItems: z.number().int().positive().max(256).optional(),
  default: z.array(z.string()).optional(),
});

// One-level nested object — the inner schema cannot contain another `object`.
const leafPropertySchema = z.union([
  stringPropertySchema,
  numberPropertySchema,
  booleanPropertySchema,
  arrayPropertySchema,
]);

const objectPropertySchema = propertyMetaSchema.extend({
  type: z.literal('object'),
  properties: z.record(z.string(), leafPropertySchema),
  required: z.array(z.string()).optional(),
});

export const SettingsPropertySchema = z.union([leafPropertySchema, objectPropertySchema]);
export type SettingsProperty = z.infer<typeof SettingsPropertySchema>;
export type SettingsLeafProperty = z.infer<typeof leafPropertySchema>;
export type SettingsObjectProperty = z.infer<typeof objectPropertySchema>;

export const SettingsSchemaSchema = z.object({
  type: z.literal('object'),
  properties: z.record(z.string(), SettingsPropertySchema),
  required: z.array(z.string()).optional(),
  title: z.string().max(120).optional(),
  description: z.string().max(800).optional(),
});
export type SettingsSchema = z.infer<typeof SettingsSchemaSchema>;

/** A flat or one-level-nested values record. */
export type SettingsValuesPrimitive = string | number | boolean | ReadonlyArray<string>;
export type SettingsValues = Readonly<
  Record<string, SettingsValuesPrimitive | Readonly<Record<string, SettingsValuesPrimitive>>>
>;

// ─── Validation result ────────────────────────────────────────────────────

export type SettingsValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

// ─── Plugin-side declaration ──────────────────────────────────────────────

export interface SettingsDeclaration {
  readonly schema: SettingsSchema;
  /**
   * Optional async validator for cross-field rules the schema can't
   * express (e.g. "apiKey must start with sk-"). Runs after schema
   * validation passes; if it returns `{ ok: false }` the host rejects
   * the write and surfaces the per-field errors in the form.
   */
  validate?(values: SettingsValues): SettingsValidationResult | Promise<SettingsValidationResult>;
}

// ─── Plugin-facing API ────────────────────────────────────────────────────

export interface SettingsAPI {
  /**
   * Register the schema. Throws `InvalidSettingsSchemaError` synchronously
   * if the schema doesn't match the SDK's subset. Returns a `Disposable`
   * that clears the declaration (and stops emitting `onChange`) on
   * dispose. Re-declaring replaces the prior declaration atomically;
   * existing values are kept if the new schema accepts them, otherwise
   * dropped to defaults.
   */
  declare(declaration: SettingsDeclaration): Disposable;
  /**
   * Read the current values. Defaults are filled in for any property
   * the user hasn't set. Resolves with `{}` when no schema has been
   * declared yet — that's the consistent shape; readers should always
   * tolerate missing keys.
   */
  get(): Promise<SettingsValues>;
  /**
   * Write a partial update. Schema validation runs first; then the
   * plugin's own `validate` (if any). On success, persists and fires
   * `onChange` to every subscriber. On failure, does not persist and
   * returns the error map.
   */
  set(partial: SettingsValues): Promise<SettingsValidationResult>;
  /** Reset every key to its schema default. Fires `onChange`. */
  reset(): Promise<void>;
  /**
   * Subscribe to value changes. Called with the new values immediately
   * after `set()` or `reset()` resolves successfully — not on subscribe.
   */
  onChange(fn: (values: SettingsValues) => void): () => void;
}

// ─── Errors ───────────────────────────────────────────────────────────────

export class InvalidSettingsSchemaError extends Error {
  public override readonly name = 'InvalidSettingsSchemaError';
  constructor(
    public readonly pluginId: string,
    public readonly reason: string,
  ) {
    super(`Plugin "${pluginId}" tried to declare a settings schema but it is invalid: ${reason}`);
  }
}

// ─── Schema validation ────────────────────────────────────────────────────

/**
 * Validate a `SettingsSchema` and return the parsed shape on success.
 * Throws `InvalidSettingsSchemaError` (with `pluginId` baked into the
 * message) on any rule violation.
 */
export function validateSettingsSchema(
  schema: unknown,
  pluginId: string,
): SettingsSchema {
  const parsed = SettingsSchemaSchema.safeParse(schema);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join('.') ?? '<root>';
    const msg = first?.message ?? 'unknown';
    throw new InvalidSettingsSchemaError(pluginId, `at "${path}": ${msg}`);
  }
  const data = parsed.data;
  const propCount = Object.keys(data.properties).length;
  if (propCount > SETTINGS_MAX_PROPERTIES) {
    throw new InvalidSettingsSchemaError(
      pluginId,
      `top-level has ${propCount} properties, max is ${SETTINGS_MAX_PROPERTIES}`,
    );
  }
  if (data.required) {
    for (const key of data.required) {
      if (!(key in data.properties)) {
        throw new InvalidSettingsSchemaError(
          pluginId,
          `required key "${key}" is not in properties`,
        );
      }
    }
  }
  for (const [key, prop] of Object.entries(data.properties)) {
    if (prop.type === 'object' && prop.required) {
      for (const innerKey of prop.required) {
        if (!(innerKey in prop.properties)) {
          throw new InvalidSettingsSchemaError(
            pluginId,
            `object "${key}" requires "${innerKey}" but it is not in its properties`,
          );
        }
      }
    }
  }
  return data;
}

// ─── Defaults + validation against schema ────────────────────────────────

/**
 * Fill defaults from the schema, drop unknown keys, coerce primitive
 * types, and check enum/min/max/pattern/required constraints. Returns
 * either the cleaned values or a per-field error map. Designed for the
 * host's `set()` path; the plugin's own `validate` runs *after* this.
 *
 * Type-mismatched values are coerced where it's unambiguous (string ↔
 * number for numeric fields) and rejected otherwise. Coercion is a
 * convenience for the form renderer (`<input type="number">` returns a
 * string); it is NOT a feature plugins should rely on for their own
 * `set()` calls — pass the right type.
 */
export function applyAndValidate(
  schema: SettingsSchema,
  partial: Readonly<Record<string, unknown>>,
  current: SettingsValues,
): SettingsValidationResult & { readonly values?: SettingsValues } {
  const errors: Record<string, string> = {};
  const result: Record<string, unknown> = {};

  // Seed with defaults + current values so we can validate the merged shape.
  for (const [key, prop] of Object.entries(schema.properties)) {
    const incoming = key in partial ? partial[key] : current[key];
    const filled = fillDefault(prop, incoming);
    const checked = checkValue(prop, filled, key, errors);
    if (checked !== undefined) result[key] = checked;
  }

  // Required: must be present AND non-empty for strings/arrays.
  for (const key of schema.required ?? []) {
    const value = result[key];
    const prop = schema.properties[key];
    if (prop === undefined) continue;
    if (value === undefined) {
      errors[key] = 'required';
      continue;
    }
    if (prop.type === 'string' && value === '') {
      errors[key] = 'required';
    } else if (prop.type === 'array' && Array.isArray(value) && value.length === 0) {
      errors[key] = 'required';
    }
  }

  if (Object.keys(errors).length > 0) {
    // Surface the partially-cleaned `result` so callers like `get()` and
    // schema-migration paths can fill defaults even when the user hasn't
    // satisfied every required field yet. `set()` ignores `values` on
    // failure and just shows the error map.
    return { ok: false, errors, values: result as SettingsValues };
  }
  const valuesJson = JSON.stringify(result);
  if (valuesJson.length > SETTINGS_MAX_VALUES_BYTES) {
    return {
      ok: false,
      errors: { __root__: `values exceed ${SETTINGS_MAX_VALUES_BYTES}-byte cap` },
    };
  }
  return { ok: true, values: result as SettingsValues };
}

function fillDefault(prop: SettingsProperty, incoming: unknown): unknown {
  if (incoming !== undefined) return incoming;
  if (prop.type === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(prop.properties)) {
      const filled = fillDefault(p, undefined);
      if (filled !== undefined) out[k] = filled;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  if ('default' in prop && prop.default !== undefined) return prop.default;
  return undefined;
}

function checkValue(
  prop: SettingsProperty,
  value: unknown,
  path: string,
  errors: Record<string, string>,
): unknown {
  if (value === undefined) return undefined;

  if (prop.type === 'string') {
    let s: string;
    if (typeof value === 'string') s = value;
    else if (typeof value === 'number' || typeof value === 'boolean') s = String(value);
    else {
      errors[path] = 'must be a string';
      return undefined;
    }
    if (prop.enum && !prop.enum.includes(s)) {
      errors[path] = `must be one of: ${prop.enum.join(', ')}`;
      return undefined;
    }
    if (prop.minLength !== undefined && s.length < prop.minLength) {
      errors[path] = `must be at least ${prop.minLength} characters`;
      return undefined;
    }
    if (prop.maxLength !== undefined && s.length > prop.maxLength) {
      errors[path] = `must be at most ${prop.maxLength} characters`;
      return undefined;
    }
    if (prop.pattern !== undefined) {
      let re: RegExp;
      try {
        re = new RegExp(prop.pattern);
      } catch {
        errors[path] = 'schema pattern is invalid';
        return undefined;
      }
      if (!re.test(s)) {
        errors[path] = 'does not match pattern';
        return undefined;
      }
    }
    return s;
  }

  if (prop.type === 'number' || prop.type === 'integer') {
    let n: number;
    if (typeof value === 'number') n = value;
    else if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
      n = Number(value);
    } else {
      errors[path] = 'must be a number';
      return undefined;
    }
    if (!Number.isFinite(n)) {
      errors[path] = 'must be finite';
      return undefined;
    }
    if (prop.type === 'integer' && !Number.isInteger(n)) {
      errors[path] = 'must be an integer';
      return undefined;
    }
    if (prop.minimum !== undefined && n < prop.minimum) {
      errors[path] = `must be ≥ ${prop.minimum}`;
      return undefined;
    }
    if (prop.maximum !== undefined && n > prop.maximum) {
      errors[path] = `must be ≤ ${prop.maximum}`;
      return undefined;
    }
    if (prop.multipleOf !== undefined && Math.abs(n / prop.multipleOf - Math.round(n / prop.multipleOf)) > 1e-9) {
      errors[path] = `must be a multiple of ${prop.multipleOf}`;
      return undefined;
    }
    return n;
  }

  if (prop.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    errors[path] = 'must be a boolean';
    return undefined;
  }

  if (prop.type === 'array') {
    if (!Array.isArray(value)) {
      errors[path] = 'must be an array of strings';
      return undefined;
    }
    if (!value.every((v) => typeof v === 'string')) {
      errors[path] = 'must be an array of strings';
      return undefined;
    }
    if (prop.minItems !== undefined && value.length < prop.minItems) {
      errors[path] = `must have at least ${prop.minItems} items`;
      return undefined;
    }
    if (prop.maxItems !== undefined && value.length > prop.maxItems) {
      errors[path] = `must have at most ${prop.maxItems} items`;
      return undefined;
    }
    return value;
  }

  if (prop.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors[path] = 'must be an object';
      return undefined;
    }
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(prop.properties)) {
      const v = k in obj ? obj[k] : undefined;
      const filled = fillDefault(p, v);
      const checked = checkValue(p, filled, `${path}.${k}`, errors);
      if (checked !== undefined) out[k] = checked;
    }
    for (const k of prop.required ?? []) {
      if (!(k in out)) {
        errors[`${path}.${k}`] = 'required';
      }
    }
    return out;
  }

  return undefined;
}

/**
 * Identity helper for authoring `SettingsSchema` literals with type
 * inference. No runtime validation — that runs at `declare`.
 */
export function defineSettingsSchema<T extends SettingsSchema>(schema: T): T {
  return schema;
}
