import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { codeInspectorPlugin } from 'code-inspector-plugin'

export default defineConfig({
  plugins: [
    // Compile-time data-insp-path injection. MUST come before react().
    // Survives React 19 + production builds + file:// — no Fiber, no sourcemap.
    codeInspectorPlugin({
      bundler: 'vite',
      dev: () => true,
      // Quirk: plugin checks `server !== "close"` (string!), not boolean.
      server: 'close',
      behavior: { locate: false, copy: false }, // custom formatter in src/index.jsx
      hotKeys: ['altKey', 'shiftKey'],
      pathType: 'relative',
    }),
    react(),
    tailwindcss(),
  ],
  base: './',
  // This repository contains vendored apps under packages/. Vite's default
  // HTML discovery can walk their demo pages after a lockfile change and then
  // fail on dependencies that are intentionally private to those packages.
  optimizeDeps: {
    entries: ['index.html'],
  },
  server: {
    port: 5156,
    strictPort: true,
    watch: {
      // Vite watches the project root. After Python workers moved inside the
      // project, Telethon's SQLite WAL files (session.session-wal/-shm) and
      // Python __pycache__ touches were triggering full-reloads on every
      // tg_sessions_ndjson.py run — DevTools blinked, store reset, screen
      // jumped to home. Exclude all non-source trees.
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
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
