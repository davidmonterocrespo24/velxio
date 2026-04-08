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
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8001',
        changeOrigin: true,
      },
    },
  },
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
