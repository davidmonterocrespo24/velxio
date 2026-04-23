import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    manifest: 'src/manifest.ts',
    events: 'src/events.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Keep zod external — consumers bring it. This keeps our bundle small and
  // avoids version drift when the host app already has a different zod copy.
  external: ['zod'],
  target: 'es2022',
  splitting: false,
});
