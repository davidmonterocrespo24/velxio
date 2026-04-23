/**
 * Plugin runtime — public surface for the editor shell.
 *
 * The editor consumes `getPluginManager()` to load and unload plugins.
 * Plugins themselves never touch any of these APIs — they only see
 * `@velxio/sdk` and the `PluginContext` they receive at activation.
 */

export {
  getPluginManager,
  resetPluginManagerForTests,
  type PluginManager,
  type PluginEntry,
  type PluginStatus,
  type LoadOptions,
  type WorkerFactory,
} from './PluginManager';
export {
  PluginHost,
  type PluginHostInit,
  type PluginHostStats,
  type WorkerLike,
} from './PluginHost';
export { RpcChannel, RpcTimeoutError, RpcDisposedError, type RpcEndpoint, type RpcStats, type RpcOptions } from './rpc';
export { buildContextStub, type ContextStubInit } from './ContextStub';
export { bootWorker, type InitMessage } from './pluginWorker';
