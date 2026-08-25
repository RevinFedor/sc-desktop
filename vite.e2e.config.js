import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Hermetic Electron E2E renderer. The regular dev config includes the
// repository-wide code-inspector plugin; after lockfile changes it scans
// vendored packages unrelated to SC Desktop. E2E exercises the same src/
// application without that development-only scanner.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  optimizeDeps: {
    entries: ['index.html'],
  },
  server: {
    port: 5156,
    strictPort: true,
    watch: {
      ignored: [
        '**/python-workers/**',
        '**/browser-extension/**',
        '**/packages/**',
        '**/logs/**',
        '**/dist/**',
        '**/.semantic-index.json',
      ],
    },
  },
})
