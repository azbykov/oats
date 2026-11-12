import type { Product } from '../../../common/product'
import type { Settings } from '../../../common/types'

// The app's profile in the window. The app's entry (apps/<name>/src/renderer/main.tsx) sets
// it in its first import, before any module here is evaluated, so it can be read anywhere,
// at module level too.

export const product = {} as Product

export function setProduct(profile: Product) {
  Object.assign(product, profile)
}

/** Speech is transcribed on this computer: always, in an app without cloud transcription. */
export const localTranscription = (settings: Settings) =>
  !product.features.cloudTranscription || settings.transcriptionProvider === 'whisper'
