import { app } from 'electron'
import { execFile, spawn, type ExecFileOptions } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AudioEngine } from '../shared/asr-models'

// Locates the audio sidecar (diarize, embed, prepare-asr, listen, transcribe, watch-mic).
// Apple Silicon uses the Swift build in native/audio (WhisperKit/FluidAudio on
// the Neural Engine). Everywhere else — Windows, Intel Macs, or any Mac with
// OATS_AUDIO_ENGINE=node — the same commands come from out/main/oats-audio.js
// (whisper.cpp/sherpa-onnx), run by Electron's own Node.

interface Helper {
  engine: AudioEngine
  command: string
  prefix: string[]
  env?: NodeJS.ProcessEnv
}

function swiftBinary(): string | null {
  const candidates = [
    process.env.OATS_AUDIO_PATH,
    app.isPackaged ? join(process.resourcesPath, 'oats-audio') : undefined,
    join(app.getAppPath(), 'native', 'audio', '.build', 'release', 'oats-audio')
  ]
  for (const p of candidates) {
    if (!p) continue
    try {
      accessSync(p, constants.X_OK)
      return p
    } catch {
      // try the next location
    }
  }
  return null
}

function nodeScript(): string | null {
  const script = join(__dirname, 'oats-audio.js')
  if (!existsSync(script)) return null
  try {
    require.resolve('@fugood/whisper.node')
    require.resolve('sherpa-onnx-node')
    return script
  } catch {
    return null
  }
}

export function audioHelper(): Helper | null {
  const appleSilicon = process.platform === 'darwin' && process.arch === 'arm64'
  if (appleSilicon && process.env.OATS_AUDIO_ENGINE !== 'node') {
    const bin = swiftBinary()
    return bin ? { engine: 'whisperkit', command: bin, prefix: [] } : null
  }
  const script = nodeScript()
  if (!script) return null
  return {
    engine: 'whispercpp',
    command: process.execPath,
    prefix: [script],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  }
}

/** Which Whisper build the models in Settings are for. */
export const audioEngine = (): AudioEngine =>
  audioHelper()?.engine ?? (process.platform === 'darwin' && process.arch === 'arm64' ? 'whisperkit' : 'whispercpp')

/** Starts a long-lived sidecar command; null when no helper is installed. */
export function spawnAudio(args: string[]) {
  const h = audioHelper()
  if (!h) return null
  return spawn(h.command, [...h.prefix, ...args], { env: h.env, windowsHide: true })
}

const execFileAsync = promisify(execFile)

/** Runs a one-shot sidecar command to completion. */
export function runAudio(args: string[], options: ExecFileOptions) {
  const h = audioHelper()
  if (!h) return Promise.reject(new Error(NOT_INSTALLED))
  return execFileAsync(h.command, [...h.prefix, ...args], { ...options, env: h.env, windowsHide: true })
}

export const NOT_INSTALLED =
  process.platform === 'darwin' && process.arch === 'arm64'
    ? 'The native audio helper is not installed (run npm run build:native).'
    : 'The audio helper is missing from this build.'
