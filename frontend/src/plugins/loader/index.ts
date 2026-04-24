/**
 * Plugin loader — public surface for the editor shell.
 *
 * Consumers:
 *   - editor startup: build a `PluginLoader`, call `loadInstalled()` with
 *     the list returned by the Pro backend.
 *   - Marketplace UI: call `loader.loadOne(plugin)` for a single install.
 *   - Installed Plugins panel: read `loader.getCache()` for stats.
 *
 * The runtime (`../runtime/`) does not depend on this folder — the
 * loader is a thin orchestration layer above it.
 */

export {
  PluginLoader,
  recomputeAndVerify,
  type CheckForUpdatesOptions,
  type InstalledPlugin,
  type LoadLicenseReason,
  type LoadOutcome,
  type LoadOutcomeStatus,
  type PluginLoaderOptions,
  type UpdateCheckDecision,
  type UpdateCheckOutcome,
} from './PluginLoader';
export {
  defaultLicenseResolver,
  inMemoryLicenseResolver,
  type InMemoryLicenseResolverInit,
  type LicenseResolver,
} from './LicenseResolver';
export {
  PluginCache,
  MemoryCacheBackend,
  type PluginCacheBackend,
  type PluginCacheEntry,
  type PluginCacheOptions,
} from './PluginCache';
export {
  fetchBundle,
  BundleFetchError,
  type BundleFetchOptions,
  type BundleFetchResult,
} from './BundleFetcher';
export {
  computeBundleHash,
  verifyBundleHash,
  BundleIntegrityError,
} from './BundleVerifier';
