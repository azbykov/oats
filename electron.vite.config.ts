import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // oats-audio.js: the Node audio sidecar (whisper.cpp / sherpa-onnx), spawned
        // with ELECTRON_RUN_AS_NODE where the Swift one can't run.
        input: { index: resolve('src/main/index.ts'), 'oats-audio': resolve('src/sidecar/index.ts') }
      }
    }
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    plugins: [react(), tailwindcss()]
  }
})
