# @velxio/cli

Author CLI for [Velxio](https://velxio.dev) plugins.

```bash
npm install -g @velxio/cli

velxio-plugin init my-plugin --template component
cd my-plugin
npm install
npm run validate
npm run build
```

## Commands (step 1)

- `velxio-plugin init <name> [--template component]` — scaffold a new project.
- `velxio-plugin validate` — run the SDK manifest schema against `manifest.json`.
- `velxio-plugin build` — esbuild bundle to `dist/bundle.mjs`, rewrite the
  manifest's `bundleHash` to the real SHA-256, and emit `dist/integrity.json`.

`velxio-plugin dev` (HMR) and `velxio-plugin login` / `publish` (marketplace
submission) ship in step 2 and step 3 once the matching backend endpoints
are available.

See [the SDK author guide](https://velxio.dev/docs/plugins) for the full
plugin model.
