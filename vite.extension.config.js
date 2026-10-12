import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: path.join(rootDir, 'browser-extension', 'study-src'),
  base: './',
  plugins: [react()],
  build: {
    outDir: path.join(rootDir, 'browser-extension', 'study'),
    // This directory is a live unpacked extension. Direct Vite builds must
    // never remove its manifest-referenced options page before emitting it.
    emptyOutDir: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: 'study.js',
        chunkFileNames: 'study-[name].js',
        assetFileNames: (asset) => asset.name?.endsWith('.css') ? 'study.css' : '[name][extname]',
      },
    },
  },
})
