import { app, BrowserWindow } from 'electron'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ASR_MODELS, DEFAULT_MODEL, GGML_DIR } from '../shared/asr-models'
import type { AsrEvent, WhisperModel } from '../shared/types'
import { audioEngine, audioHelper, NOT_INSTALLED, spawnAudio } from './sidecar'

// Local Whisper transcription through `oats-audio listen` (WhisperKit on Apple
// Silicon, whisper.cpp elsewhere). One long-lived process serves both channels
// so the model is loaded once.

const whisperModels = () => ASR_MODELS[audioEngine()]

// Independent of userData so test profiles (OATS_USER_DATA) share downloads.
const modelsDir = () => join(app.getPath('appData'), 'Oats', 'models')
export const whisperModelsDir = modelsDir
const modelFolder = (id: string) =>
  audioEngine() === 'whisperkit'
    ? join(modelsDir(), 'models', 'argmaxinc', 'whisperkit-coreml', id)
    : join(modelsDir(), GGML_DIR, `${id}.bin`)

/** The preferred model if downloaded, else any downloaded one. */
export function readyModel(preferred: string): string | null {
  if (existsSync(modelFolder(preferred))) return preferred
  return whisperModels().find((m) => existsSync(modelFolder(m.id)))?.id ?? null
}

/** A model id from settings that this engine knows, e.g. after moving data between a Mac and a PC. */
export function knownModel(id: string) {
  return whisperModels().some((m) => m.id === id) ? id : DEFAULT_MODEL[audioEngine()]
}

const downloads = new Map<string, Pick<WhisperModel, 'stage' | 'progress' | 'error'>>()

export function listModels(): WhisperModel[] {
  return whisperModels().map(({ id, label, size }) => {
    const d = downloads.get(id)
    if (d && !d.error) return { id, label, size, status: 'downloading', ...d }
    return { id, label, size, status: existsSync(modelFolder(id)) ? 'ready' : 'missing', error: d?.error }
  })
}

const broadcast = () => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('asr:models', listModels())
}

/** Splits a child's stdout into JSON lines; anything that isn't JSON is log noise. */
function jsonLines(proc: ChildProcessWithoutNullStreams, onEvent: (e: Record<string, unknown>) => void) {
  let buf = ''
  proc.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8')
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line.startsWith('{')) continue
      try {
        onEvent(JSON.parse(line))
      } catch {
        // ignore malformed lines
      }
    }
  })
}

const lastStderrLine = (text: string) =>
  text.trim().split('\n').pop()?.replace(/^oats-audio:\s*/, '') || 'exited unexpectedly'

export function prepareModel(id: string) {
  if (downloads.has(id) && !downloads.get(id)!.error) return
  const proc = spawnAudio(['prepare-asr', '--model', id, '--models-dir', modelsDir()])
  if (!proc) {
    downloads.set(id, { error: NOT_INSTALLED })
    broadcast()
    return
  }
  downloads.set(id, { stage: 'download', progress: 0 })
  broadcast()
  let stderr = ''
  let last = 0
  proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
  jsonLines(proc, (e) => {
    if (e.type !== 'progress') return
    downloads.set(id, { stage: e.stage as 'download' | 'compile', progress: Number(e.fraction) })
    if (Date.now() - last > 250 || e.stage === 'compile') {
      last = Date.now()
      broadcast()
    }
  })
  proc.on('exit', (code) => {
    if (code === 0) downloads.delete(id)
    else downloads.set(id, { error: `Download failed: ${lastStderrLine(stderr)}` })
    broadcast()
  })
}

// ---- prewarm ----

// CoreML compiles a WhisperKit model for the Neural Engine on first load and caches
// the result, but a new oats-audio build (an update, another copy of the app, a dev
// rebuild) misses that cache. Compiling large-v3 takes many minutes, so it is done
// at launch instead of when the next meeting starts.

const warmFile = () => join(app.getPath('userData'), 'asr-warm.json')
let warming: Promise<void> | null = null

/** Identifies the helper build and model the compiled cache was made for. */
function warmKey(model: string) {
  const helper = audioHelper()
  if (!helper) return null
  return `${helper.command}|${statSync(helper.command).mtimeMs}|${model}`
}

export function prewarmModel(preferred: string) {
  if (audioEngine() !== 'whisperkit' || warming) return
  const model = readyModel(preferred)
  const key = model && warmKey(model)
  if (!model || !key) return
  try {
    if (readFileSync(warmFile(), 'utf8') === key) return
  } catch {
    // never warmed
  }
  const proc = spawnAudio(['prewarm-asr', '--model', model, '--models-dir', modelsDir()])
  if (!proc) return
  // It doesn't read stdin, so nothing else ends it when Oats quits; the next launch retries.
  const stop = () => proc.kill()
  app.once('will-quit', stop)
  downloads.set(model, { stage: 'compile', progress: 1 })
  broadcast()
  let stderr = ''
  proc.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)))
  warming = new Promise<void>((resolve) => {
    proc.on('exit', (code) => {
      app.off('will-quit', stop)
      if (code === 0) writeFileSync(warmFile(), key)
      else console.warn(`Whisper prewarm failed: ${lastStderrLine(stderr)}`)
      downloads.delete(model)
      broadcast()
      warming = null
      resolve()
    })
  })
}

// ---- listener ----

let listener: {
  proc: ChildProcessWithoutNullStreams
  key: string
  ready: Promise<void>
  sender: Electron.WebContents | null
} | null = null

/** words: also return word timings for system audio, used to split lines by speaker. */
export async function startListener(
  model: string,
  language: string,
  words: boolean,
  sender: Electron.WebContents
): Promise<void> {
  // Loading alongside the prewarm would compile the same model twice; the renderer
  // keeps the audio until the listener is ready.
  if (warming) await warming
  const key = `${model}|${language}|${words}`
  if (listener && listener.key === key && listener.proc.exitCode === null) {
    listener.sender = sender
    return listener.ready
  }
  stopListener()
  if (!existsSync(modelFolder(model))) {
    return Promise.reject(new Error('Download the Whisper model in Settings → Transcription first.'))
  }

  const args = ['listen', '--model', model, '--models-dir', modelsDir(), '--language', language]
  if (words) args.push('--words-channels', '1')
  const proc = spawnAudio(args)
  if (!proc) return Promise.reject(new Error(NOT_INSTALLED))
  let stderr = ''
  proc.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)))
  const current = { proc, key, sender: sender as Electron.WebContents | null, ready: Promise.resolve() }
  current.ready = new Promise<void>((resolve, reject) => {
    jsonLines(proc, (e) => {
      if (e.type === 'ready') return resolve()
      const target = current.sender
      if (target && !target.isDestroyed()) target.send('asr:event', e as AsrEvent)
    })
    proc.on('exit', () => {
      reject(new Error(`Whisper failed to start: ${lastStderrLine(stderr)}`))
      if (listener === current) {
        listener = null
        const target = current.sender
        if (stderr && target && !target.isDestroyed()) {
          target.send('asr:event', { type: 'error', message: `Whisper stopped: ${lastStderrLine(stderr)}` } satisfies AsrEvent)
        }
      }
    })
  })
  listener = current
  return current.ready
}

/** kind: 1 audio, 2 reset (new session), 3 flush (finalise open speech). */
export function sendFrame(kind: number, channel: number, payload?: ArrayBuffer) {
  if (!listener || listener.proc.exitCode !== null) return
  const body = payload ? Buffer.from(payload) : Buffer.alloc(0)
  const header = Buffer.alloc(6)
  header[0] = kind
  header[1] = channel
  header.writeUInt32LE(body.length, 2)
  listener.proc.stdin.write(Buffer.concat([header, body]))
}

export function stopListener() {
  if (!listener) return
  const { proc } = listener
  listener = null
  proc.stdin.end()
  // Let it drain queued finals, then make sure it is gone.
  setTimeout(() => proc.exitCode === null && proc.kill(), 15_000)
}
