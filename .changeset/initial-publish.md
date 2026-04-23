---
'@velxio/sdk': minor
---

Initial public release of `@velxio/sdk` to npm.

This package contains the public types and runtime helpers that
both Velxio Core and third-party plugin authors consume to build
plugins for the Velxio simulator and the upcoming marketplace:

- Manifest schema (Zod-backed) frozen at `schemaVersion: 1`.
- `definePlugin`, `definePartSimulation`, `defineComponent`,
  `defineSpiceMapper` identity helpers.
- Typed event surface (`SimulatorEvents`, `EventBusReader`).
- Permission catalog (`PLUGIN_PERMISSIONS`,
  `PluginPermissionSchema`, `PermissionDeniedError`).
- Compile middleware contracts.
- Settings, i18n, templates, and library registry contracts.

The runtime surface is pre-1.0 and may change before 1.0 ships.
The manifest schema is stable: pin `sdkVersion: "^0.1.0"` in your
plugin manifest.
