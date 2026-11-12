import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import pkg from './package.json'

// Most of the code is in shared/ (the repository root), next to the other apps'. What is
// Oats's own is in src/: the profile and the entries that set it before the shared code loads.
const shared = (path: string) => resolve(__dirname, '../../shared/src', path)
// .env sits at the repository root (see .env.example).
const envDir = resolve(__dirname, '../..')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    envDir,
    build: {
      rollupOptions: {
        // oats-audio.js: the Node audio sidecar (whisper.cpp / sherpa-onnx), spawned
        // with ELECTRON_RUN_AS_NODE where the Swift one can't run. embedder.js: the
        // embedding model's utility process (semantic search). oats-silo.js: the
        // database's utility process.
        input: {
          index: resolve(__dirname, 'src/main.ts'),
          'oats-audio': shared('sidecar/index.ts'),
          'oats-silo': shared('silo/index.ts'),
          embedder: shared('main/embedder.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: shared('preload/index.ts') } } }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    publicDir: shared('renderer/public'),
    envDir,
    plugins: [react(), tailwindcss()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') }
    },
    // Shown in Settings; package.json is the version electron-builder ships.
    define: { __APP_VERSION__: JSON.stringify(pkg.version) }
  }
})
