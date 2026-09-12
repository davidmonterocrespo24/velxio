import { configDefaults, defineConfig } from 'vitest/config';
import path from 'path';
import fs from 'fs';

/**
 * Vitest configuration — split out from `vite.config.ts` (Phase 1d-tests J).
 *
 * `vite.config.ts` no longer owns the `test:` block; vitest auto-loads
 * this file and CI workflows can reference it directly.  Defaults below
 * tune for the velxio test suite:
 *
 *   - 30 s test timeout: smoke tests iterating 200+ examples need
 *     headroom; per-test individual asserts are still fast.
 *   - `forks` pool with `singleFork: false` so each test file runs in
 *     its own Node worker.  The NgSpiceNodeAdapter is a process-wide
 *     singleton (emscripten module can't reinitialise); without per-file
 *     isolation, state leaks between tests sharing the same worker.
 *   - Coverage excludes the WASM bundle (large binary, irrelevant lcov)
 *     and the test files themselves.
 *
 *   - `resolve.alias` mirrors `vite.config.ts` — vitest's defineConfig
 *     does NOT auto-inherit from vite.config.ts, so the @velxio alias
 *     used by overlay tests (e.g. pro/.../snapshot.test.ts importing
 *     `@velxio/store/useEditorStore`) must be declared here too or
 *     test files explode with "Cannot find package '@velxio/...'".
 *   - `@pro` likewise mirrors vite.config.ts: it resolves to the OSS no-op
 *     stub by default, or the real overlay when VITE_PRO_BUILD +
 *     PRO_OVERLAY_PATH are set. data/examples.ts statically imports
 *     `@pro/data/proExamples`, so without this alias every test that loads
 *     examples.ts would explode with "Cannot find package '@pro/...'".
 */
/**
 * Engine packages the pro overlay imports (`esp32js` and friends). A pro test
 * file lives at `../../pro/frontend/src/pro/...`, OUTSIDE this package, so Node
 * resolution walks up from THERE and never reaches this project's
 * node_modules — the import dies with "Cannot find package 'esp32js'". Aliasing
 * them keeps overlay tests able to drive the real engine.
 *
 * Resolved lazily per name: on a pure-OSS clone the packages aren't installed
 * and no test imports them (the pro glob matches nothing), so a missing entry
 * is simply left unaliased rather than pointing at a path that isn't there.
 */
const ENGINE_PACKAGES = [
  'esp32js',
  'esp32s3js',
  'esp32c3js',
  'esp32c6js',
  'rp2350js',
  // The ARM XIAO engines. Only a test in a DOM environment needs these
  // aliased - a node test gets them from Node's own resolver - but a
  // missing name there fails at import analysis, before any test runs.
  'nrf52840js',
  'samd21js',
  'ra4m1js',
  'efr32mg24js',
  'nrf54ljs',
];
const engineAliases: Record<string, string> = {};
for (const name of ENGINE_PACKAGES) {
  const dir = path.resolve(__dirname, 'node_modules', name);
  if (fs.existsSync(dir)) engineAliases[name] = dir;
}

const proOverlayPath =
  process.env.VITE_PRO_BUILD && process.env.PRO_OVERLAY_PATH
    ? path.resolve(process.env.PRO_OVERLAY_PATH)
    : path.resolve(__dirname, 'src/__pro_stub__');

export default defineConfig({
  resolve: {
    alias: {
      '@velxio': path.resolve(__dirname, 'src'),
      '@pro': proOverlayPath,
      ...engineAliases,
    },
  },
  // Allow vitest to import test files / sources from outside this
  // project root - specifically `../../pro/frontend/src/pro/...` for
  // velxio-prod overlay tests. Without this, Vite's fs sandbox blocks
  // the read with "Cannot find module '/@fs/...'".
  server: { fs: { allow: ['..', '../..'] } },
  test: {
    globals: true,
    environment: 'node',
    include: [
      'src/__tests__/**/*.test.ts',
      'src/**/__tests__/**/*.test.ts',
      // velxio-prod pro overlay tests (when run from a velxio-prod
      // checkout — these are the source-of-truth pro tests, not the
      // stale copies at src/pro/). Harmless on pure-OSS clones
      // because the glob has nothing to match there.
      '../../pro/frontend/src/pro/**/__tests__/**/*.test.ts',
    ],
    exclude: [
      ...configDefaults.exclude,
      // `src/pro/` is a COPY of the overlay some dev setups rsync in for a
      // local pro build (it is gitignored; a clean OSS clone has nothing
      // here). The source of truth is the ../../pro/... glob above, so
      // running the copy duplicates the whole pro suite — and the copy's
      // paths to files OUTSIDE frontend/ (pro/guest-shims, pro/frontend/
      // public) resolve to velxio/ from there and simply do not exist, so a
      // stale snapshot fails the deploy gate for a file nobody edited.
      'src/pro/**',
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Vitest 4 removed `test.poolOptions` — config moved to top-level
    // `forks` / `threads` / etc. See the deprecation banner the runner
    // emits: "DEPRECATED test.poolOptions was removed in Vitest 4. All
    // previous poolOptions are now top-level options."
    //
    // Each forked worker also needs its heap cap raised because the
    // suite leaks state across the 117 test files (ngspice WASM ~30 MB
    // per init, MixedModeScheduler singleton, zustand stores). Even
    // sharded (60 files / shard) the leak overflows Node's 4 GB
    // default; 8 GB plus sharding fits the runner's 16 GB budget.
    forks: {
      singleFork: false,
      execArgv: ['--max-old-space-size=8192'],
    },
    coverage: {
      provider: 'v8',
      include: [
        'src/simulation/**/*.ts',
        'src/utils/exampleTo*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/__tests__/**',
        'src/simulation/spice/wasm/**',
      ],
      reporter: ['text', 'lcov', 'html'],
    },
  },
});
