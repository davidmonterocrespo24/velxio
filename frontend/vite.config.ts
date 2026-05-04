import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// avr8js / rp2040js / @wokwi/elements are resolved from npm via package.json.
// (The third-party/ clones are reference-only — keep them updated for credits.)
export default defineConfig({
  plugins: [react()],
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
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/simulation/**/*.ts'],
      reporter: ['text', 'html'],
    },
  },
})
