import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, '..', 'dist', 'webview'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'src', 'webviewApp.tsx'),
      output: {
        entryFileNames: 'index.js',
        assetFileNames: 'index.[ext]',
        // Single chunk for simplicity in WebView loading
        manualChunks: undefined,
      },
    },
    // Inline small assets to avoid CSP issues
    assetsInlineLimit: 100000,
    sourcemap: true,
  },
});
