/**
 * @velxio/sdk — public types and helpers for Velxio plugins and the Core's
 * internal registries.
 *
 * This barrel re-exports every type plugin authors consume. The Core
 * implements every interface here; plugins receive the implementations
 * through `PluginContext` at activation.
 *
 * Versioning: semver. The MAJOR version matches the plugin protocol
 * version — a plugin manifest with `sdkVersion: "^1.0.0"` is compatible
 * with any 1.x host.
 *
 * See:
 *   - docs/SDK.md for the API tour.
 *   - docs/EVENT_BUS.md for event payload catalog.
 *   - docs/COMPILE_MIDDLEWARE.md for the middleware model.
 */

export * from './components';
export * from './simulation';
export * from './spice';
export * from './ui';
export * from './events';
export * from './permissions';
export * from './permissions-catalog';
export * from './manifest';
export * from './lifecycle';
export * from './compile';
export * from './templates';
export * from './libraries';
export * from './i18n';
export * from './settings';

/** Package version — kept in sync with package.json by tsup build. */
export const SDK_VERSION = '0.1.0' as const;

/** Current manifest schema version. */
export const MANIFEST_SCHEMA_VERSION = 1 as const;
