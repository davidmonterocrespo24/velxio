/**
 * Permission gating for plugin context APIs.
 *
 * Every registry method exposed through `PluginContext` is wrapped in a
 * `requirePermission(manifest, perm)` check. The check is **synchronous and
 * fail-fast**: if the permission is not in the manifest's declared list, the
 * call throws `PermissionDeniedError` immediately — before any side effect
 * touches the host. That makes the security boundary auditable from the call
 * site without inspecting the registry implementation.
 *
 * Why a function instead of a decorator: TS decorators are still in flux and
 * this helper is one line at every call site. Avoiding indirection keeps the
 * gate trivially greppable (`grep -n requirePermission`).
 */

import {
  PermissionDeniedError,
  type PluginManifest,
  type PluginPermission,
} from '@velxio/sdk';

/**
 * Throw `PermissionDeniedError` if the manifest does not declare `permission`.
 * The error carries the plugin id and the missing permission so the host UI
 * can surface a clear message to the user reviewing the install.
 */
export function requirePermission(
  manifest: PluginManifest,
  permission: PluginPermission,
): void {
  if (!manifest.permissions.includes(permission)) {
    throw new PermissionDeniedError(permission, manifest.id);
  }
}

/**
 * True when the manifest declares `permission`. Use this only for UI
 * affordances (greying out a button) — never as a substitute for the
 * gate in the actual API path. The gate is the security boundary.
 */
export function hasPermission(
  manifest: PluginManifest,
  permission: PluginPermission,
): boolean {
  return manifest.permissions.includes(permission);
}
