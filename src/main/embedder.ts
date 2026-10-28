import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InferenceSession } from 'onnxruntime-node'
import type { Tokenizer } from '@huggingface/tokenizers'

// The embedding model's own process (an Electron utility process started by embeddings.ts).
// The model takes ~280 MB once loaded, and the allocator keeps that after the session is
// released, so the process exits when idle instead: that is what gives the memory back.

export interface EmbedRequest {
  id: number
  dir: string
  texts: string[]
}
/** `fatal`: the runtime or model couldn't be loaded at all, so retrying won't help. */
export type EmbedResponse = { id: number; vectors: Float32Array[] } | { id: number; error: string; fatal?: boolean }

const MAX_TOKENS = 512
const IDLE_MS = 2 * 60_000

type Ort = typeof import('onnxruntime-node')
let model: Promise<{ session: InferenceSession; tokenizer: Tokenizer; ort: Ort }> | undefined
let idle: NodeJS.Timeout | undefined
let busy = 0

function load(dir: string) {
  model ??= (async () => {
    const ort = await import('onnxruntime-node')
    const { Tokenizer } = await import('@huggingface/tokenizers')
    const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'))
    const tokenizer = new Tokenizer(read('tokenizer.json'), read('tokenizer_config.json'))
    const session = await ort.InferenceSession.create(join(dir, 'model.onnx'), {
      intraOpNumThreads: 2,
      interOpNumThreads: 1,
      graphOptimizationLevel: 'all'
    })
    return { session, tokenizer, ort }
  })()
  return model
}

/** Unit-length embeddings: mean of the token vectors, scaled to length 1. */
async function embed(dir: string, texts: string[]) {
  let loaded: Awaited<ReturnType<typeof load>>
  try {
    loaded = await load(dir)
  } catch (err) {
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { fatal: true })
  }
  const { session, tokenizer, ort } = loaded
  const out: Float32Array[] = []
  for (const text of texts) {
    let ids = tokenizer.encode(text).ids
    // Keep the closing special token when cutting a long passage.
    if (ids.length > MAX_TOKENS) ids = [...ids.slice(0, MAX_TOKENS - 1), ids[ids.length - 1]]
    const n = ids.length
    const tensor = (values: number[]) => new ort.Tensor('int64', BigInt64Array.from(values, BigInt), [1, n])
    const result = await session.run({
      input_ids: tensor(ids),
      attention_mask: tensor(new Array(n).fill(1)),
      token_type_ids: tensor(new Array(n).fill(0))
    })
    const hidden = result.last_hidden_state
    const dim = hidden.dims[2]
    const data = hidden.data as Float32Array
    const v = new Float32Array(dim)
    for (let i = 0; i < n; i++) for (let j = 0; j < dim; j++) v[j] += data[i * dim + j]
    let norm = 0
    for (let j = 0; j < dim; j++) norm += v[j] * v[j]
    norm = Math.sqrt(norm) || 1
    for (let j = 0; j < dim; j++) v[j] /= norm
    out.push(v)
  }
  return out
}

process.parentPort.on('message', async ({ data }: { data: EmbedRequest }) => {
  clearTimeout(idle)
  busy++
  let reply: EmbedResponse
  try {
    reply = { id: data.id, vectors: await embed(data.dir, data.texts) }
  } catch (err) {
    const fatal = (err as { fatal?: boolean }).fatal
    reply = { id: data.id, error: err instanceof Error ? err.message : String(err), ...(fatal && { fatal }) }
  }
  process.parentPort.postMessage(reply)
  if (--busy === 0) idle = setTimeout(() => process.exit(0), IDLE_MS)
})
