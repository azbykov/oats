import type { OatsApi } from '../../preload/index'

declare global {
  interface Window {
    oats: OatsApi
  }
}

export {}
