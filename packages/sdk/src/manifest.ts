/**
 * Plugin manifest schema — the marketplace's contract.
 *
 * A plugin is uniquely identified by `id` (kebab-case, globally unique
 * within Velxio). Versioning follows semver. The manifest is the ONLY
 * source of truth for:
 *   - what the plugin does (capabilities, categories, tags)
 *   - what it needs (permissions, sdkVersion, minVelxioVersion)
 *   - how it's sold (pricing, refundPolicy)
 *   - how it's found (description, icon, screenshots, homepage)
 *
 * Shape is enforced by Zod. The JSON Schema (for IDE autocomplete) is
 * generated from the same source — run `npm run schema:emit`.
 */

import { z } from 'zod';
import { PluginPermissionSchema } from './permissions';

// ── Leaf schemas ──────────────────────────────────────────────────────────

/** kebab-case id, 3–64 chars, starts with a letter. */
const idSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{2,63}$/,
    'id must be kebab-case, 3–64 chars, start with a letter',
  );

const semverSchema = z
  .string()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    'version must be valid semver',
  );

/**
 * semver *range* — accepts common forms: `1.0.0`, `^1.0.0`, `~1.0`, `1.x`,
 * `>=1.0.0 <2.0.0`. We do not validate the exhaustive npm grammar; this
 * lightweight regex catches typos without becoming a parser.
 */
const semverRangeSchema = z
  .string()
  .min(1)
  .regex(
    /^[\^~><=0-9.xX*\s|-]+$/,
    'must be a valid semver range (e.g. "^1.0.0", ">=1.0.0 <2.0.0")',
  );

/** kebab-case tag. */
const tagSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'tag must be kebab-case, 1–32 chars');

/** Relative path to the plugin entry file inside the bundle. */
const entrySchema = z
  .string()
  .regex(/^\.\/[\w\-/.]+\.(?:mjs|js)$/, 'entry must be a relative path ending in .mjs or .js');

/** Icon: data URI (png/svg) or https URL. */
const iconSchema = z
  .string()
  .regex(
    /^(?:data:image\/(?:png|svg\+xml);base64,[A-Za-z0-9+/=]+|https:\/\/[^\s]+)$/,
    'icon must be a data URI (png/svg) or https URL',
  );

/** https URL with at most a path component. */
const httpsUrlSchema = z
  .string()
  .regex(/^https:\/\/[a-z0-9.-]+(?::\d+)?(\/[^\s]*)?$/i, 'must be a valid https URL');

/** BCP-47-ish locale: `en`, `en-US`, `pt-BR`. */
const localeSchema = z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/, 'locale must be e.g. "en" or "en-US"');

// ── Author ────────────────────────────────────────────────────────────────

export const AuthorSchema = z.object({
  name: z.string().min(1).max(80),
  url: z.string().url().optional(),
  email: z.string().email().optional(),
  /** Set by the marketplace when the author signs in; authors leave this unset. */
  velxioUserId: z.string().uuid().optional(),
});
export type Author = z.infer<typeof AuthorSchema>;

// ── Pricing ───────────────────────────────────────────────────────────────

export const CurrencySchema = z.enum(['USD', 'EUR']);
export type Currency = z.infer<typeof CurrencySchema>;

export const PricingSchema = z.discriminatedUnion('model', [
  z.object({ model: z.literal('free') }),
  z.object({
    model: z.literal('one-time'),
    currency: CurrencySchema,
    /** Price in minor units (cents). */
    amount: z.number().int().positive(),
  }),
  z.object({
    model: z.literal('subscription'),
    currency: CurrencySchema,
    /** Monthly price in minor units (cents). */
    amount: z.number().int().positive(),
    trialDays: z.number().int().min(0).max(30).default(0),
  }),
]);
export type Pricing = z.infer<typeof PricingSchema>;

// ── Capabilities ─────────────────────────────────────────────────────────

export const PluginCategorySchema = z.enum([
  'components',
  'templates',
  'libraries',
  'tools',
  'themes',
  'integrations',
]);
export type PluginCategory = z.infer<typeof PluginCategorySchema>;

export const PluginCapabilitySchema = z.enum([
  'component',
  'simulation',
  'spice-mapper',
  'template',
  'library',
  'compile-hook',
  'ui-extension',
  'theme',
]);
export type PluginCapability = z.infer<typeof PluginCapabilitySchema>;

// ── HTTP allowlist ────────────────────────────────────────────────────────

export const HttpAllowlistSchema = z.object({
  allowlist: z.array(httpsUrlSchema).max(10, 'up to 10 allowlist entries'),
});
export type HttpAllowlist = z.infer<typeof HttpAllowlistSchema>;

// ── Refund ────────────────────────────────────────────────────────────────

export const RefundPolicySchema = z.enum(['none', '7d', '14d', '30d']);
export type RefundPolicy = z.infer<typeof RefundPolicySchema>;

// ── Top-level manifest ────────────────────────────────────────────────────

export const PluginManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: idSchema,
  name: z.string().min(3).max(64),
  version: semverSchema,
  /** Version range of @velxio/sdk this plugin was built against. */
  sdkVersion: semverRangeSchema,
  /** Minimum Velxio Core version required to run this plugin. */
  minVelxioVersion: semverRangeSchema,
  author: AuthorSchema,
  /** Tweet-length description shown in listings (20–280 chars). */
  description: z.string().min(20).max(280),
  /** Markdown rendered in the plugin detail page (optional). */
  longDescription: z.string().max(20_000).optional(),
  icon: iconSchema,
  /** 1200×630 cover for the plugin detail page. */
  cover: z.string().url().optional(),
  screenshots: z.array(z.string().url()).max(8).optional(),
  homepage: z.string().url().optional(),
  repository: z.string().url().optional(),
  /** SPDX identifier or literal `"Proprietary"`. */
  license: z.string().min(1),
  category: PluginCategorySchema,
  tags: z.array(tagSchema).max(10).default([]),
  /** At least one capability must be declared. */
  type: z.array(PluginCapabilitySchema).min(1),
  entry: entrySchema,
  permissions: z.array(PluginPermissionSchema).default([]),
  http: HttpAllowlistSchema.optional(),
  pricing: PricingSchema.default({ model: 'free' }),
  refundPolicy: RefundPolicySchema.default('14d'),
  i18n: z.array(localeSchema).optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// ── Validation helper ─────────────────────────────────────────────────────

/** Result of `validateManifest`. */
export type ManifestValidationResult =
  | { readonly ok: true; readonly manifest: PluginManifest }
  | {
      readonly ok: false;
      readonly errors: ReadonlyArray<{
        readonly path: string;
        readonly message: string;
      }>;
    };

/**
 * Validate a raw JSON manifest. Never throws — returns a discriminated union.
 *
 * Additional semantic checks that Zod cannot express:
 *   - `permissions` contains `http.fetch` ⇒ `http.allowlist` must be set.
 *   - `pricing.model === 'free'` ⇒ `refundPolicy` must be `'none'`.
 */
export function validateManifest(raw: unknown): ManifestValidationResult {
  const parsed = PluginManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '<root>',
        message: issue.message,
      })),
    };
  }

  const manifest = parsed.data;
  const semanticErrors: Array<{ path: string; message: string }> = [];

  if (manifest.permissions.includes('http.fetch') && !manifest.http) {
    semanticErrors.push({
      path: 'http.allowlist',
      message: 'permissions includes "http.fetch" — http.allowlist is required',
    });
  }

  if (manifest.http && manifest.http.allowlist.length === 0) {
    semanticErrors.push({
      path: 'http.allowlist',
      message: 'allowlist must contain at least one entry when `http` is set',
    });
  }

  if (semanticErrors.length > 0) {
    return { ok: false, errors: semanticErrors };
  }

  return { ok: true, manifest };
}
