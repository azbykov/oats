import { app, utilityProcess, type UtilityProcess } from 'electron'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { EmbedRequest, EmbedResponse } from './embedder'

// Text embeddings for local semantic search: multilingual-e5-small (int8 ONNX, ~118 MB),
// which places Russian and English passages with the same meaning close together.
// It runs on onnxruntime-node in a utility process (embedder.ts) with two threads, started
// on demand and gone after two idle minutes.

const REPO = 'https://huggingface.co/Xenova/multilingual-e5-small/resolve/main'
const FILES = [
  { url: `${REPO}/onnx/model_quantized.onnx`, name: 'model.onnx' },
  { url: `${REPO}/tokenizer.json`, name: 'tokenizer.json' },
  { url: `${REPO}/tokenizer_config.json`, name: 'tokenizer_config.json' }
]
export const EMBEDDING_MODEL = 'multilingual-e5-small-q8'

// Shared by every data folder, like the Whisper models.
const dir = () => join(app.getPath('appData'), 'Oats', 'models', 'multilingual-e5-small')

/**
 * Whether onnxruntime-node has a build for this platform (none for Intel Macs). Checked by
 * file so the main process never loads the native runtime itself.
 */
export function runtimeAvailable() {
  try {
    const pkg = dirname(require.resolve('onnxruntime-node/package.json'))
    return existsSync(join(pkg, 'bin', 'napi-v6', process.platform, process.arch, 'onnxruntime_binding.node'))
  } catch {
    return false
  }
}

export const modelReady = () => FILES.every((f) => existsSync(join(dir(), f.name)))

/** Downloads the model files, reporting progress from 0 to 1. */
export async function downloadModel(onProgress: (fraction: number) => void) {
  mkdirSync(dir(), { recursive: true })
  const responses = await Promise.all(
    FILES.map(async (f) => {
      const res = await fetch(f.url)
      if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${f.name}`)
      return { file: f, res }
    })
  )
  const total = responses.reduce((sum, r) => sum + Number(r.res.headers.get('content-length') ?? 0), 0) || 1
  let done = 0
  for (const { file, res } of responses) {
    const part = join(dir(), `${file.name}.part`)
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
    body.on('data', (chunk: Buffer) => {
      done += chunk.length
      onProgress(Math.min(done / total, 1))
    })
    await pipeline(body, createWriteStream(part))
    renameSync(part, join(dir(), file.name))
  }
}

/** Deletes the model once its process has exited: Windows can't delete files a process has open. */
export async function removeModel() {
  await unload()
  rmSync(dir(), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

/** `fatal`: the model can't run on this computer (e.g. a missing system library). */
export class EmbedError extends Error {
  constructor(
    message: string,
    readonly fatal = false
  ) {
    super(message)
  }
}

let child: UtilityProcess | null = null
/** Whether the process has ever answered; a crash before that means it can't start here. */
let started = false
/** Processes stopped on purpose (unload), whose exit isn't a failure. */
const stopped = new WeakSet<UtilityProcess>()
let nextId = 0
const pending = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: EmbedError) => void }>()

function embedder() {
  if (child) return child
  const proc = utilityProcess.fork(join(__dirname, 'embedder.js'), [], { serviceName: 'Oats embeddings' })
  proc.on('message', (msg: EmbedResponse) => {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    if ('error' in msg) p?.reject(new EmbedError(msg.error, msg.fatal))
    else {
      started = true
      p?.resolve(msg.vectors)
    }
  })
  // It exits by itself after two idle minutes, which frees the model's memory. Windows ends
  // a process whose DLLs can't be found (a delay-loaded onnxruntime.dll) instead of throwing.
  proc.on('exit', (code) => {
    if (child === proc) child = null
    const crashed = code !== 0 && !stopped.has(proc)
    const error = new EmbedError(`The embedding process stopped (exit code ${code}).`, crashed && !started)
    for (const p of pending.values()) p.reject(error)
    pending.clear()
  })
  child = proc
  return proc
}

function unload(): Promise<void> {
  const proc = child
  child = null
  if (!proc?.pid) return Promise.resolve()
  return new Promise((resolve) => {
    stopped.add(proc)
    proc.once('exit', () => resolve())
    proc.kill()
  })
}

/**
 * Unit-length embeddings (dot product = cosine similarity). e5 wants "query: " in front of
 * questions and "passage: " in front of the text being searched.
 */
export function embed(texts: string[]): Promise<Float32Array[]> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    embedder().postMessage({ id, dir: dir(), texts } satisfies EmbedRequest)
  })
}
