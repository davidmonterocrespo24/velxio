/**
 * Plugin-scoped logger.
 *
 * Routes `ctx.logger.info(...)` to the host console with a `[plugin:<id>]`
 * prefix so devs can grep for plugin output in DevTools without it bleeding
 * into the editor's own logs. The implementation is intentionally minimal —
 * the editor's DevTools panel (CORE-008) will subscribe to a richer event
 * stream; this is the plain-console fallback.
 */

import type { PluginLogger, PluginManifest } from '@velxio/sdk';

export function createPluginLogger(manifest: PluginManifest): PluginLogger {
  const prefix = `[plugin:${manifest.id}]`;
  return {
    debug: (message, ...args) => console.debug(prefix, message, ...args),
    info: (message, ...args) => console.info(prefix, message, ...args),
    warn: (message, ...args) => console.warn(prefix, message, ...args),
    error: (message, ...args) => console.error(prefix, message, ...args),
  };
}
