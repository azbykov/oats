import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { LibVariant, WhisperContext } from '@fugood/whisper.node'

export const SAMPLE_RATE = 16_000

export class CLIError extends Error {}

export const usage = `usage:
  oats-audio diarize --input <wav> [--max-speakers N] [--output <json>] [--models-dir <dir>]
  oats-audio embed --input <wav> [--output <json>] [--models-dir <dir>]
  oats-audio prepare-asr --model <variant> --models-dir <dir>
  oats-audio listen --model <variant> --models-dir <dir> [--language <code>] [--words-channels 1]
  oats-audio transcribe --input <wav> --model <variant> --models-dir <dir> [--language <code>] [--words 1] [--output <json>]
  oats-audio watch-mic`

/** Parses `--flag value` pairs after the subcommand. */
export function flags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]
    const value = args[i + 1]
    if (!key.startsWith('--') || value === undefined) throw new CLIError(`bad argument ${key}\n${usage}`)
    out[key.slice(2)] = value
  }
  return out
}

export function requireFlag(f: Record<string, string>, name: string): string {
  const v = f[name]
  if (!v) throw new CLIError(`--${name} is required`)
  return v
}

/** Writes one JSON object per line to stdout (the Electron main process reads these). */
export function emit(object: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(object)}\n`)
}

/** "multi" (or nothing) means let Whisper detect the language. */
export const whisperLanguage = (language?: string) => (!language || language === 'multi' ? 'auto' : language)

/** Same place the main process uses: <appData>/Oats/models. */
export function defaultModelsDir() {
  const appData =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'))
  return join(appData, 'Oats', 'models')
}

/** Downloads to a temp file first so an interrupted download never looks complete. */
export async function download(url: string, dest: string, onProgress?: (fraction: number) => void) {
  await mkdir(dirname(dest), { recursive: true })
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new CLIError(`download failed (${res.status}) ${url}`)
  const total = Number(res.headers.get('content-length')) || 0
  let received = 0
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
  body.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (total) onProgress?.(received / total)
  })
  const tmp = `${dest}.part`
  try {
    await pipeline(body, createWriteStream(tmp))
    await rename(tmp, dest)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

/** Reads a 16 kHz mono 16-bit PCM WAV (what the app records) as samples in [-1, 1]. */
export async function readWav(path: string): Promise<Float32Array> {
  const fh = await open(path, 'r').catch(() => {
    throw new CLIError(`input file not found: ${path}`)
  })
  try {
    const buf = await fh.readFile()
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
      throw new CLIError('input is not a WAV file')
    }
    let offset = 12
    let format: { channels: number; rate: number; bits: number } | null = null
    while (offset + 8 <= buf.length) {
      const id = buf.toString('ascii', offset, offset + 4)
      let size = buf.readUInt32LE(offset + 4)
      const body = offset + 8
      if (id === 'fmt ') {
        format = { channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) }
      } else if (id === 'data') {
        if (!format || format.channels !== 1 || format.rate !== SAMPLE_RATE || format.bits !== 16) {
          throw new CLIError('expected 16 kHz mono 16-bit PCM audio')
        }
        // A file left by a crash may claim less (or more) than it holds.
        size = Math.min(buf.length - body, size || buf.length - body) & ~1
        const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + body, buf.byteOffset + body + size))
        return int16ToFloat(pcm)
      }
      offset = body + size + (size & 1)
    }
    throw new CLIError('no audio data in the WAV file')
  } finally {
    await fh.close()
  }
}

export function int16ToFloat(pcm: Int16Array) {
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768
  return out
}

export function floatToInt16(samples: Float32Array) {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff
  }
  return out
}

// ---- whisper.cpp ----

// Whisper's well-known hallucinations on silence or music.
const HALLUCINATIONS = [
  'продолжение следует', 'субтитры', 'редактор субтитров', 'спасибо за просмотр', 'подписывайтесь',
  'thank you for watching', 'thanks for watching', 'amara.org', 'please subscribe'
]

export function clean(text: string): string | null {
  const t = text
    .trim()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, '')
    .trim()
  if (!/\p{L}/u.test(t)) return null
  const lower = t.toLowerCase()
  if (HALLUCINATIONS.some((h) => lower.includes(h))) return null
  return t
}

/**
 * GPU build of whisper.cpp where one is installed (Vulkan covers NVIDIA, AMD and
 * Intel on Windows; Metal is built in on macOS); falls back to the CPU build.
 * OATS_WHISPER_VARIANT=default|vulkan|cuda overrides it.
 */
function variant(): LibVariant {
  const env = process.env.OATS_WHISPER_VARIANT
  if (env === 'default' || env === 'vulkan' || env === 'cuda') return env
  return process.platform === 'darwin' ? 'default' : 'vulkan'
}

const loaded = new Set<WhisperContext>()

export async function loadWhisper(modelPath: string): Promise<WhisperContext> {
  const { initWhisper } = await import('@fugood/whisper.node')
  try {
    const ctx = await initWhisper({ filePath: modelPath, useGpu: true }, variant())
    loaded.add(ctx)
    return ctx
  } catch (err) {
    throw new CLIError(`failed to load ${modelPath}: ${err instanceof Error ? err.message : err}`)
  }
}

export async function releaseWhisper(ctx: WhisperContext) {
  if (loaded.delete(ctx)) await ctx.release()
}

/** ggml's Metal backend aborts at exit if a model is still loaded, so free them all first. */
export async function releaseAll() {
  await Promise.all([...loaded].map((ctx) => releaseWhisper(ctx).catch(() => {})))
}

/** sherpa-onnx-node is CommonJS without named-export hints, so take its default export. */
export async function loadSherpa() {
  const mod = (await import('sherpa-onnx-node')) as unknown as { default?: typeof import('sherpa-onnx-node') }
  return mod.default ?? (mod as unknown as typeof import('sherpa-onnx-node'))
}

export interface Word {
  w: string
  s: number
  e: number
}

/**
 * whisper.cpp has no word timestamps as such; with maxLen 1 and token timestamps
 * every segment is one token, and a token that starts with a space begins a new word.
 */
export function wordsFromTokens(segments: { text: string; t0: number; t1: number }[], offsetMs = 0): Word[] {
  const words: Word[] = []
  for (const seg of segments) {
    if (!seg.text || /^\[.*\]$/.test(seg.text.trim())) continue
    const last = words.at(-1)
    if (last && !/^\s/.test(seg.text)) {
      last.w += seg.text
      last.e = offsetMs + seg.t1
    } else {
      words.push({ w: seg.text, s: offsetMs + seg.t0, e: offsetMs + seg.t1 })
    }
  }
  return words.filter((w) => w.w.trim())
}

export interface PassOptions {
  language: string
  /** Token-level segments (maxLen 1) for word timings. */
  words?: boolean
  /** Retry at higher temperatures when decoding fails; off for quick partials. */
  fallback?: boolean
  /** Recent transcript of the same speaker, so names and terms stay consistent. */
  prompt?: string
}

/** Runs one whisper.cpp pass over 16 kHz samples. */
export async function whisperPass(ctx: WhisperContext, samples: Float32Array, opts: PassOptions) {
  const pcm = floatToInt16(samples)
  const { promise } = ctx.transcribeData(pcm.buffer as ArrayBuffer, {
    language: opts.language,
    temperature: 0,
    temperatureInc: opts.fallback === false ? 0 : 0.2,
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    ...(opts.words ? { tokenTimestamps: true, maxLen: 1 } : {})
  })
  return promise
}

// ---- model files ----

const SHERPA_MODELS = 'https://github.com/k2-fsa/sherpa-onnx/releases/download'

/** Small ONNX models fetched on first use (VAD, speaker segmentation and embeddings). */
export const AUX_MODELS = {
  vad: { file: 'silero_vad.onnx', url: `${SHERPA_MODELS}/asr-models/silero_vad.onnx` },
  segmentation: {
    file: 'pyannote-segmentation-3.0.onnx',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx'
  },
  embedding: {
    file: 'wespeaker_en_voxceleb_resnet34_LM.onnx',
    url: `${SHERPA_MODELS}/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx`
  }
} as const

/** Path of an auxiliary model under <models dir>/sherpa, downloading it if missing. */
export async function auxModel(modelsDir: string, name: keyof typeof AUX_MODELS) {
  const { file, url } = AUX_MODELS[name]
  const path = join(modelsDir, 'sherpa', file)
  if (!existsSync(path)) await download(url, path)
  return path
}
