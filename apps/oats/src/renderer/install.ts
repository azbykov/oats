import { setProduct } from '../../../../shared/src/renderer/src/lib/product'
import { product } from '../product'

// Imported first by main.tsx: the shared code reads the profile as it loads.
setProduct(product)
