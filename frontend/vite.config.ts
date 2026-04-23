import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'avr8js': path.resolve(__dirname, '../wokwi-libs/avr8js/dist/esm'),
      'rp2040js': path.resolve(__dirname, '../wokwi-libs/rp2040js/dist/esm'),
      '@wokwi/elements': path.resolve(__dirname, '../wokwi-libs/wokwi-elements/dist/esm'),
      '@velxio/sdk': path.resolve(__dirname, '../packages/sdk/src/index.ts'),
      '@velxio/sdk/manifest': path.resolve(__dirname, '../packages/sdk/src/manifest.ts'),
      '@velxio/sdk/events': path.resolve(__dirname, '../packages/sdk/src/events.ts'),
    },
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
    include: ['avr8js', 'rp2040js', '@wokwi/elements', 'littlefs', 'zod'],
    // Force Vite to re-bundle local wokwi-elements after adding new components
    force: true,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts', 'src/__tests__/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      include: ['src/simulation/**/*.ts'],
      reporter: ['text', 'html'],
    },
  },
})
