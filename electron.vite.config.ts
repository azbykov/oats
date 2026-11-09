import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import pkg from './package.json'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // oats-audio.js: the Node audio sidecar (whisper.cpp / sherpa-onnx), spawned
        // with ELECTRON_RUN_AS_NODE where the Swift one can't run. embedder.js: the
        // embedding model's utility process (semantic search).
        input: {
          index: resolve('src/main/index.ts'),
          'oats-audio': resolve('src/sidecar/index.ts'),
          embedder: resolve('src/main/embedder.ts')
        }
      }
    }
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    plugins: [react(), tailwindcss()],
    // Shown in Settings; package.json is the version electron-builder ships.
    define: { __APP_VERSION__: JSON.stringify(pkg.version) }
  }
})
