/**
 * Plugin permission taxonomy.
 *
 * Every sensitive surface a plugin can touch requires a named permission.
 * The host enforces them at the registry level: a plugin without
 * `ui.command.register` cannot call `ctx.commands.register()` — the call
 * throws synchronously with a `PermissionDeniedError`.
 *
 * Permissions are coarse-grained on purpose. Fine-grained scoping (e.g.
 * "only read pin X") is not worth the UX cost of explaining to users.
 */

import { z } from 'zod';

export const PLUGIN_PERMISSIONS = [
  // Simulator
  'simulator.events.read',
  'simulator.pins.read',
  'simulator.pins.write',
  'simulator.pwm.read',
  'simulator.spi.read',
  'simulator.spi.write',
  'simulator.i2c.read',
  'simulator.i2c.write',
  'simulator.serial.write',
  'simulator.analog.write',
  'simulator.sensors.read',
  'simulator.spice.read',
  // Compile
  'compile.transform.client',
  // UI
  'ui.command.register',
  'ui.toolbar.register',
  'ui.panel.register',
  'ui.statusbar.register',
  'ui.context-menu.register',
  'ui.editor.action.register',
  'ui.canvas.overlay.register',
  // Storage (1MB quota per plugin per user)
  'storage.user.read',
  'storage.user.write',
  'storage.workspace.read',
  'storage.workspace.write',
  // Network (allowlist)
  'http.fetch',
  // Content
  'components.register',
  'libraries.provide',
  'templates.provide',
  // Settings
  'settings.declare',
] as const;

export const PluginPermissionSchema = z.enum(PLUGIN_PERMISSIONS);

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/** Thrown by the host when a plugin calls a registry API without the right permission. */
export class PermissionDeniedError extends Error {
  public override readonly name = 'PermissionDeniedError';
  constructor(
    public readonly permission: PluginPermission,
    public readonly pluginId: string,
  ) {
    super(
      `Plugin "${pluginId}" called an API requiring permission "${permission}", but the manifest does not declare it.`,
    );
  }
}
