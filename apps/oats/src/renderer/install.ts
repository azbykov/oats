import { setCloudTranscription } from '../../../../shared/src/renderer/src/lib/cloud'
import { deepgram } from '../../../../shared/src/renderer/src/lib/deepgram'
import { setProduct } from '../../../../shared/src/renderer/src/lib/product'
import { product } from '../product'

// Imported first by main.tsx: the shared code reads the profile as it loads.
setProduct(product)
// Oats offers Deepgram next to local Whisper (features.cloudTranscription).
setCloudTranscription(deepgram)
