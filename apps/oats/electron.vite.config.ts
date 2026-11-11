import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import pkg from './package.json'

// The app's code lives in shared/ (the repository root), next to the other apps'.
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
          index: shared('main/index.ts'),
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
    root: shared('renderer'),
    envDir,
    plugins: [react(), tailwindcss()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: { input: shared('renderer/index.html') }
    },
    // Shown in Settings; package.json is the version electron-builder ships.
    define: { __APP_VERSION__: JSON.stringify(pkg.version) }
  }
})
