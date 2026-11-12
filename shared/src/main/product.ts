import type { Product, Prompts } from '../common/product'

// The app's profile in the main process. The app's entry (apps/<name>/src/main.ts) sets it
// in its first import, before any module here is evaluated, so it can be read anywhere,
// at module level too.

export const product = {} as Product & { prompts: Prompts }

export function setProduct(profile: Product, prompts: Prompts) {
  Object.assign(product, profile, { prompts })
}
