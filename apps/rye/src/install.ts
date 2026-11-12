import { setProduct } from '../../../shared/src/main/product'
import { product } from './product'
import { prompts } from './prompts'

// Imported first by main.ts: the shared code reads the profile as it loads.
setProduct(product, prompts)
