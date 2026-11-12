import { setProduct } from '../../../../shared/src/renderer/src/lib/product'
import { product } from '../product'

// Imported first by main.tsx: the shared code reads the profile as it loads.
setProduct(product)

// Unlike Oats, no cloud transcription is handed over here (shared lib/cloud.ts): the code
// that streams audio to a service is not part of Rye's window at all.
