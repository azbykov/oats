import { app } from 'electron'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, type WriteStream } from 'node:fs'
import { open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DiarizationResult, RecordingMeta, RecoveredSegment } from '../shared/types'
import { readyModel, whisperModelsDir } from './asr'
import { audioHelper, NOT_INSTALLED, runAudio } from './sidecar'

// Local audio backup for each recording session, one 16 kHz mono WAV per channel.
// It feeds offline speaker separation and, like Notion's meeting-notes failover
// cache, lets a session be re-transcribed when live transcription failed or the
// app quit mid-call. Files are deleted once the session has been processed.

const TIMEOUT_MS = 30 * 60_000
const SAMPLE_RATE = 16_000
const HEADER_BYTES = 44

const dir = () => join(app.getPath('userData'), 'recordings')
const wavPath = (id: string) => join(dir(), `${id}.wav`)
const metaPath = (id: string) => join(dir(), `${id}.json`)

const active = new Map<string, { stream: WriteStream; bytes: number; meta: RecordingMeta }>()

export function begin(meta: RecordingMeta) {
  mkdirSync(dir(), { recursive: true })
  const stream = createWriteStream(wavPath(meta.id))
  stream.write(Buffer.alloc(HEADER_BYTES)) // patched with real sizes in finish()
  active.set(meta.id, { stream, bytes: 0, meta })
  writeFile(metaPath(meta.id), JSON.stringify(meta)).catch(() => {})
}

export function append(id: string, pcm: ArrayBuffer) {
  const r = active.get(id)
  if (!r) return
  r.stream.write(Buffer.from(pcm))
  r.bytes += pcm.byteLength
}

function wavHeader(dataBytes: number) {
  const h = Buffer.alloc(HEADER_BYTES)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + dataBytes, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16) // PCM chunk size
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(1, 22) // mono
  h.writeUInt32LE(SAMPLE_RATE, 24)
  h.writeUInt32LE(SAMPLE_RATE * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(dataBytes, 40)
  return h
}

/** Writes the real WAV header; also repairs files left behind by a crash. */
async function seal(id: string) {
  const size = (await stat(wavPath(id))).size
  const dataBytes = Math.max(0, size - HEADER_BYTES)
  const fh = await open(wavPath(id), 'r+')
  await fh.write(wavHeader(dataBytes), 0, HEADER_BYTES, 0)
  await fh.close()
  return dataBytes
}

/** Closes the file; it stays on disk until remove(). */
export async function finish(id: string) {
  const r = active.get(id)
  if (!r) return
  active.delete(id)
  await new Promise<void>((resolve, reject) => r.stream.end((err?: Error | null) => (err ? reject(err) : resolve())))
  await seal(id)
  await writeFile(metaPath(id), JSON.stringify({ ...r.meta, endedCleanly: true } satisfies RecordingMeta))
}

const sidecarError = (err: unknown) => {
  const stderr = (err as { stderr?: string }).stderr?.trim().split('\n').pop()
  return new Error(stderr?.replace(/^oats-audio:\s*/, '') || (err instanceof Error ? err.message : String(err)))
}

/** Shown when live transcription took over; the renderer retries after the recording. */
export const DEFERRED = 'Deferred until live transcription ends.'

/** Offline transcriptions, stopped when live transcription starts so they don't compete for the Neural Engine. */
const yielding = new Set<AbortController>()

export function yieldToLive() {
  for (const c of yielding) c.abort()
}

async function withSidecar<T>(
  id: string,
  args: (wav: string, out: string) => string[],
  signal?: AbortSignal
): Promise<T> {
  if (!audioHelper()) throw new Error(NOT_INSTALLED)
  const dataBytes = await seal(id)
  // Less than ~2 s of audio has nothing useful in it.
  if (dataBytes < SAMPLE_RATE * 2 * 2) throw new Error('Not enough audio.')
  const out = `${wavPath(id)}.${Date.now()}.out.json`
  try {
    await runAudio(args(wavPath(id), out), { timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, signal })
    return JSON.parse(await readFile(out, 'utf8')) as T
  } catch (err) {
    if (signal?.aborted) throw new Error(DEFERRED)
    throw sidecarError(err)
  } finally {
    await rm(out, { force: true })
  }
}

export function diarize(id: string, maxSpeakers?: number) {
  return withSidecar<DiarizationResult>(id, (wav, out) => {
    const args = ['diarize', '--input', wav, '--output', out]
    if (maxSpeakers) args.push('--max-speakers', String(maxSpeakers))
    return args
  })
}

/** Offline re-transcription of a recording with the local Whisper model. */
export async function transcribe(id: string, preferredModel: string, language: string, words: boolean) {
  const model = readyModel(preferredModel)
  if (!model) throw new Error('Download a Whisper model in Settings → Transcription to recover this recording.')
  const controller = new AbortController()
  yielding.add(controller)
  try {
    const result = await withSidecar<{ segments: RecoveredSegment[] }>(
      id,
      (wav, out) => {
        const args = ['transcribe', '--input', wav, '--model', model, '--models-dir', whisperModelsDir(), '--language', language, '--output', out]
        if (words) args.push('--words', '1')
        return args
      },
      controller.signal
    )
    return result.segments
  } finally {
    yielding.delete(controller)
  }
}

export async function remove(id: string) {
  const r = active.get(id)
  if (r) {
    active.delete(id)
    r.stream.destroy()
  }
  await rm(wavPath(id), { force: true })
  await rm(metaPath(id), { force: true })
}

/** Recordings left from a previous run (the app quit or crashed before processing). */
export function leftovers(): RecordingMeta[] {
  if (!existsSync(dir())) return []
  const out: RecordingMeta[] = []
  for (const f of readdirSync(dir())) {
    if (!f.endsWith('.json')) continue
    const id = f.slice(0, -5)
    if (active.has(id) || !existsSync(wavPath(id))) continue
    try {
      out.push(JSON.parse(readFileSync(metaPath(id), 'utf8')) as RecordingMeta)
    } catch {
      // unreadable metadata: leave the file for manual inspection
    }
  }
  return out
}

export async function closeAll() {
  await Promise.all([...active.keys()].map((id) => finish(id).catch(() => {})))
}
