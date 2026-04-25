import { defineConfig } from 'tsup';

export default defineConfig([
  // Library entry — exposes init/validate/build as JS APIs so tests and
  // future tooling can drive the same code paths the CLI does.
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    target: 'es2022',
    splitting: false,
    external: ['esbuild', '@velxio/sdk'],
  },
  // Bin entry — single CJS file with shebang so `npx velxio-plugin` works
  // on Node 20+ regardless of the consumer's package type.
  {
    entry: { cli: 'src/cli.ts' },
    format: ['cjs'],
    dts: false,
    sourcemap: true,
    clean: false,
    treeshake: true,
    target: 'es2022',
    splitting: false,
    banner: { js: '#!/usr/bin/env node' },
    external: ['esbuild', '@velxio/sdk'],
  },
]);
