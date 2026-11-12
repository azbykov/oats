/// <reference types="vite/client" />
import type { OatsApi } from '../../preload/index'

declare global {
  /** package.json's version, injected by electron.vite.config.ts. */
  const __APP_VERSION__: string

  interface Window {
    oats: OatsApi
  }
}

export {}
