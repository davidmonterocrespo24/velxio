import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'

// https://vite.dev/config/
// avr8js / rp2040js / @wokwi/elements are resolved from npm via package.json.
// (The third-party/ clones are reference-only — keep them updated for credits.)
//
// The `@pro` alias resolves to a no-op stub by default. Private overlays
// (e.g. velxio-prod) set VITE_PRO_BUILD=true and PRO_OVERLAY_PATH at build
// time to point at their actual pro source tree. See README's "Pro overlay"
// section.
const proOverlayPath =
  process.env.VITE_PRO_BUILD && process.env.PRO_OVERLAY_PATH
    ? path.resolve(process.env.PRO_OVERLAY_PATH)
    : path.resolve(__dirname, 'src/__pro_stub__')

// The gallery thumbnails are served with a long max-age under a fixed URL, so
// a refreshed thumbnail stayed hidden behind the old one in every browser and
// at the CDN for up to 30 days. Their URL carries this version: a hash of
// every thumbnail's name and bytes, so it changes exactly when one of them
// does (utils/exampleThumbUrl.ts).
function exampleThumbsVersion(): string {
  const dir = path.resolve(__dirname, 'public/examples-thumbs')
  let names: string[] = []
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.webp')).sort()
  } catch {
    return ''
  }
  const h = crypto.createHash('sha1')
  for (const n of names) {
    h.update(n)
    h.update(fs.readFileSync(path.join(dir, n)))
  }
  return h.digest('hex').slice(0, 10)
}

export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: {
    __EXAMPLE_THUMBS_VERSION__: JSON.stringify(exampleThumbsVersion()),
  },
  resolve: {
    alias: {
      '@pro': proOverlayPath,
      // Stable alias for OSS modules that the pro overlay needs to import
      // (e.g. lib/proRoutes for route registration). Using an alias instead
      // of a relative path makes the import location-independent: it works
      // whether the overlay is symlinked into src/pro/ (local dev — Rollup
      // resolves the import from the real overlay path) or physically
      // COPYed into src/pro/ (Docker build). Either way `@velxio/<x>`
      // points at the OSS src tree.
      '@velxio': path.resolve(__dirname, 'src'),
    },
    // When the pro overlay is wired in via a junction/symlink
    // (Windows pattern: `frontend/src/pro` → `velxio-prod/pro/frontend/src/pro`),
    // Rollup's default behavior walks the symlink to the real path and
    // resolves imports from THAT location — but the real overlay path
    // has no node_modules nearby AND its `../../<x>` paths land outside
    // the OSS src tree. Preserving symlinks keeps the overlay logically
    // anchored inside src/pro/.
    //
    // In Docker builds the overlay is COPYed in physically (no symlinks
    // to follow), so this flag is effectively a no-op there. We keep it
    // gated on VITE_PRO_BUILD so OSS-only builds without the overlay
    // see the default behavior.
    preserveSymlinks: !!process.env.VITE_PRO_BUILD,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8001',
        changeOrigin: true,
      },
    },
  },
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    include: ['avr8js', 'rp2040js', '@wokwi/elements', 'littlefs'],
  },
  build: {
    // Phase 1d #4 — split heavy long-lived chunks so cache-hits stay
    // meaningful and the cold-load entry stays small.  The previous
    // bundle landed the whole app + Monaco + every MCU sim in one
    // index chunk (>23 MB).  Manual chunks below collapse it into
    // cacheable groups that match the user's actual flow (editor
    // load, run simulator, edit code in Monaco).
    rollupOptions: {
      output: {
        manualChunks: {
          // ngspice WASM client — only loaded when the user opens
          // a circuit with electrical components.
          'spice-wasm': [
            './src/simulation/spice/adapters/NgSpiceWorkerAdapter.ts',
            './src/simulation/spice/wasm/NgSpiceInteractive.ts',
          ],
          // MCU emulators — bulky, infrequent updates.
          'mcu-emulators': ['avr8js', 'rp2040js'],
          // Wokwi visual elements — large but cacheable; only loaded
          // once per session.
          'wokwi-elements': ['@wokwi/elements'],
          // React vendor — stable across deploys, near-permanent cache.
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
    chunkSizeWarningLimit: 8000,
  },
  // Vitest config lives in `vitest.config.ts` (split out so CI can
  // reference it directly and so vite build doesn't pay test deps).
}))
