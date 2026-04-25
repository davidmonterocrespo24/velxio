import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // CLI tests shell out to esbuild and write tmpdirs — keep the
    // default 5s timeout but allow per-test override.
    testTimeout: 15_000,
  },
});
