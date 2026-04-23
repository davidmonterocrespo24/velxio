# @velxio/sdk

[![npm version](https://img.shields.io/npm/v/@velxio/sdk.svg)](https://www.npmjs.com/package/@velxio/sdk)
[![npm downloads](https://img.shields.io/npm/dm/@velxio/sdk.svg)](https://www.npmjs.com/package/@velxio/sdk)
[![license](https://img.shields.io/npm/l/@velxio/sdk.svg)](https://github.com/davidmonterocrespo24/velxio/blob/master/packages/sdk/LICENSE)
[![SDK tests](https://github.com/davidmonterocrespo24/velxio/actions/workflows/sdk-tests.yml/badge.svg)](https://github.com/davidmonterocrespo24/velxio/actions/workflows/sdk-tests.yml)

Public types and helpers for building [Velxio](https://velxio.dev) plugins
and for the Velxio Core's internal registries.

> ⚠️ This package is pre-1.0. The manifest schema is frozen at v1, but
> runtime APIs may change. Pin the SDK version in your plugin manifest
> (`sdkVersion: "^0.1.0"`) until 1.0 ships.

## What this package is

- **Types** for the full Velxio plugin contract: components, part
  simulation, SPICE mappers, UI contributions, lifecycle, events,
  permissions, manifest, compile middleware.
- **Runtime helpers** limited to:
  - `definePlugin(plugin)` — identity helper for plugin modules.
  - `validateManifest(raw)` — Zod-backed manifest validation.
  - `PluginManifestSchema`, `PluginPermissionSchema` — raw Zod schemas.
  - `PermissionDeniedError` — thrown when a plugin tries to use a
    registry its manifest does not authorize.
  - Constants: `SDK_VERSION`, `MANIFEST_SCHEMA_VERSION`, `PLUGIN_PERMISSIONS`.

The actual registries (component registry, event bus, SPICE engine) are
implemented by the **Core**. Plugins receive them through `PluginContext`
at activation.

## Install

```bash
npm install @velxio/sdk
# or
pnpm add @velxio/sdk
# or
yarn add @velxio/sdk
```

The package ships ESM + CJS bundles and `.d.ts` types — works in both
modern bundlers (Vite, esbuild, webpack 5) and Node ≥20.

### Subpath imports

```ts
import { definePlugin, validateManifest } from '@velxio/sdk';
import { PluginManifestSchema } from '@velxio/sdk/manifest';
import type { SimulatorEvents, EventBusReader } from '@velxio/sdk/events';
```

### Within the Velxio monorepo

The Core consumes this package directly from source via a Vite alias —
see `frontend/vite.config.ts`. Plugin authors outside the monorepo
should always install from npm.

## Writing a plugin

```ts
import { definePlugin, type PluginContext } from '@velxio/sdk';

export default definePlugin({
  async activate(ctx: PluginContext) {
    ctx.logger.info(`Activating ${ctx.manifest.name}`);

    const off = ctx.events.on('pin:change', ({ componentId, pinName, state }) => {
      ctx.logger.debug(`${componentId}.${pinName} = ${state}`);
    });

    ctx.addDisposable({ dispose: off });
  },

  async deactivate() {
    // Any additional teardown. Disposables registered via addDisposable
    // are disposed automatically.
  },
});
```

## Manifest

Every plugin ships a `plugin.json` (or embeds it in the bundle) that the
marketplace and the host validate against `PluginManifestSchema`.

```jsonc
{
  "$schema": "https://sdk.velxio.dev/schemas/plugin-manifest.v1.json",
  "schemaVersion": 1,
  "id": "logic-analyzer",
  "name": "Logic Analyzer",
  "version": "0.3.2",
  "sdkVersion": "^0.1.0",
  "minVelxioVersion": "^2.0.0",
  "author": { "name": "Jane Dev", "url": "https://example.com" },
  "description": "4-channel logic analyzer that captures GPIO traces from the running MCU.",
  "icon": "https://cdn.example.com/icon.png",
  "license": "MIT",
  "category": "tools",
  "tags": ["logic", "debug"],
  "type": ["ui-extension", "component"],
  "entry": "./plugin.mjs",
  "permissions": ["simulator.events.read", "ui.panel.register"],
  "pricing": { "model": "free" },
  "refundPolicy": "none"
}
```

Validate locally:

```ts
import { validateManifest } from '@velxio/sdk';

const raw = JSON.parse(await fs.readFile('./plugin.json', 'utf8'));
const result = validateManifest(raw);
if (!result.ok) {
  for (const err of result.errors) console.error(`${err.path}: ${err.message}`);
  process.exit(1);
}
```

## Type map

| Concern | File | Key exports |
| --- | --- | --- |
| Components | `components.ts` | `ComponentDefinition`, `PinInfo`, `ComponentRegistry` |
| Sim | `simulation.ts` | `PartSimulation`, `SimulatorHandle`, `PinChangeListener` |
| SPICE | `spice.ts` | `SpiceMapper`, `SpiceEmission`, `SpiceRegistry` |
| UI | `ui.ts` | `CommandRegistry`, `ToolbarRegistry`, `PanelRegistry`, `StatusBarRegistry`, `EditorActionRegistry`, `CanvasOverlayRegistry`, `ContextMenuRegistry` |
| Events | `events.ts` | `SimulatorEvents`, `EventBusReader`, `SimulatorEventListener` |
| Manifest | `manifest.ts` | `PluginManifestSchema`, `validateManifest`, `PluginManifest` |
| Permissions | `permissions.ts` | `PLUGIN_PERMISSIONS`, `PluginPermissionSchema`, `PermissionDeniedError` |
| Lifecycle | `lifecycle.ts` | `Plugin`, `PluginContext`, `PluginStorage`, `ScopedFetch`, `definePlugin` |
| Compile | `compile.ts` | `CompileMiddlewareRegistry`, `PreCompileMiddleware`, `PostCompileMiddleware` |

## Development

```bash
npm install
npm run build          # tsup → dist/*.js + *.d.ts
npm run test           # vitest
npm run typecheck      # tsc --noEmit
npm run schema:emit    # regenerate dist/schemas/plugin-manifest.v1.json
npm run smoke          # pack + install in a tmp project + import from ESM/CJS/types
```

`npm run smoke` is the same script the release workflow runs as a
gate before publishing. If it fails locally, the publish will fail too —
typically because `dist/` is stale or the `exports` map is broken.

## Versioning & releases

This package follows semver. The major version of `@velxio/sdk` matches
the plugin protocol major version. A host implementing `@velxio/sdk@1.x`
can load any plugin whose `sdkVersion` is satisfied by `^1.0.0`.

Releases are managed by [changesets](https://github.com/changesets/changesets):

1. Any PR that changes `packages/sdk/src/**` must include a changeset
   (`npx changeset` from the repo root).
2. On push to `master`, the [Release workflow](../../.github/workflows/release.yml)
   opens a "Version Packages" PR that bumps the version and updates
   `CHANGELOG.md`.
3. Merging that PR triggers the same workflow, which publishes the new
   version to npm with [provenance attestation](https://docs.npmjs.com/generating-provenance-statements).

Never edit `CHANGELOG.md` or bump `version` in `package.json` by hand.

## License

MIT.
