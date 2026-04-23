/**
 * Plugin host — barrel export.
 *
 * Public API for the host's plugin loader (and tests). Plugins themselves
 * never import from here — they only see `@velxio/sdk`.
 */

export { requirePermission, hasPermission } from './PermissionGate';
export {
  InMemoryCommandRegistry,
  InMemoryToolbarRegistry,
  InMemoryPanelRegistry,
  InMemoryStatusBarRegistry,
  InMemoryEditorActionRegistry,
  InMemoryCanvasOverlayRegistry,
  InMemoryContextMenuRegistry,
} from './UIRegistries';
export {
  InMemoryPluginStorage,
  MapStorageBackend,
  type StorageBackend,
  type StorageBucket,
} from './PluginStorage';
export { createScopedFetch, SCOPED_FETCH_MAX_BYTES } from './ScopedFetch';
export { createPluginLogger } from './PluginLogger';
export { SpiceModelRegistry, type SpiceModelHandle } from './SpiceModelRegistry';
export { HostDisposableStore } from './DisposableStore';
export {
  getTemplateRegistry,
  resetTemplateRegistryForTests,
  type HostTemplateRegistry,
} from './TemplateRegistry';
export {
  getLibraryRegistry,
  resetLibraryRegistryForTests,
  type HostLibraryRegistry,
} from './LibraryRegistry';
export {
  createPluginI18n,
  getActiveLocale,
  getLocaleStore,
  resetLocaleStoreForTests,
  setActiveLocale,
} from './I18nRegistry';
export {
  InMemorySettingsBackend,
  createPluginSettings,
  getSettingsRegistry,
  resetSettingsRegistryForTests,
  type HostSettingsRegistry,
  type SettingsBackend,
} from './SettingsRegistry';
export {
  createPluginContext,
  type CreatedPluginContext,
  type PluginHostServices,
  type PluginUIRegistries,
} from './createPluginContext';
