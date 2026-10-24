import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { WhisperContext } from '@fugood/whisper.node'
import { GGML_DIR } from '../shared/asr-models'
import {
  auxModel,
  clean,
  CLIError,
  emit,
  int16ToFloat,
  loadSherpa,
  loadWhisper,
  releaseWhisper,
  requireFlag,
  SAMPLE_RATE,
  whisperLanguage,
  whisperPass,
  wordsFromTokens
} from './common'

// Local streaming transcription with whisper.cpp — the cross-platform twin of
// the Swift sidecar's `listen` (same stdin frames, same JSON lines).
//
// Whisper is not a streaming model, so each channel is segmented with Silero
// VAD: while someone is talking the open utterance is re-transcribed about once
// a second ("partial"); when they pause, the whole utterance is transcribed once
// more and committed ("final"). Finals carry the channel's recent text as a
// prompt so names and terms stay consistent across utterances.
//
// stdin  — binary frames: [kind u8][channel u8][length u32 LE][payload]
//            kind 1 audio: payload is 16 kHz mono Int16 LE PCM
//            kind 2 reset: a new recording session starts at t = 0 for this channel
//            kind 3 flush: the user stopped; finalise any open utterance
// stdout — JSON lines: {type: ready | partial | final | error, channel, text, startMs, endMs}
//          finals on channels listed in --words-channels also carry words:
//          [{w, s, e}] (ms) so the app can split a line at speaker changes

export const modelPath = (modelsDir: string, id: string) => join(modelsDir, GGML_DIR, `${id}.bin`)

export async function requireModel(f: Record<string, string>) {
  const id = requireFlag(f, 'model')
  const path = modelPath(requireFlag(f, 'models-dir'), id)
  if (!existsSync(path)) throw new CLIError(`model ${id} is not downloaded`)
  return loadWhisper(path)
}

// Silero works on 512-sample (32 ms) windows at 16 kHz.
const HOP = 512
const PREROLL = 10 // hops kept before speech onset
const ONSET = 3
const END_SILENCE = 22 // ~700 ms pause ends an utterance
const TRAIL = 5 // ~150 ms of trailing silence kept so the last word isn't clipped
const MAX_HOPS = Math.floor((20 * SAMPLE_RATE) / HOP) // force a cut after 20 s
const PROMPT_CHARS = 200

interface Utterance {
  channel: number
  startSample: number
  audio: Float32Array
  final: boolean
}

type SherpaVad = InstanceType<typeof import('sherpa-onnx-node').Vad>

function concat(parts: Float32Array[]) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

class Channel {
  sessionSample = 0
  carry = new Float32Array(0)
  hops: Float32Array[] = [] // preroll or the open utterance
  energy: number[] = []
  bufferStart = 0 // session sample index of hops[0]
  inSpeech = false
  voicedRun = 0
  silentRun = 0
  lastPartialAt = 0
  prompt = ''

  constructor(
    readonly id: number,
    private vad: SherpaVad
  ) {}

  reset() {
    this.sessionSample = 0
    this.carry = new Float32Array(0)
    this.hops = []
    this.energy = []
    this.bufferStart = 0
    this.inSpeech = false
    this.voicedRun = 0
    this.silentRun = 0
    this.lastPartialAt = 0
    this.prompt = ''
    this.vad.reset()
  }

  /** Returns utterances that ended while consuming `samples`. */
  feed(samples: Float32Array): Utterance[] {
    const done: Utterance[] = []
    const all = this.carry.length ? concat([this.carry, samples]) : samples
    let offset = 0
    while (all.length - offset >= HOP) {
      const hop = all.slice(offset, offset + HOP)
      offset += HOP
      this.vad.acceptWaveform(hop)
      const voiced = this.vad.isDetected()
      // Only the live flag is used; drop the detector's own completed segments.
      while (!this.vad.isEmpty()) this.vad.pop()
      const u = this.consume(hop, voiced)
      if (u) done.push(u)
    }
    this.carry = all.slice(offset)
    return done
  }

  private consume(hop: Float32Array, voiced: boolean): Utterance | null {
    let sum = 0
    for (const v of hop) sum += v * v
    this.hops.push(hop)
    this.energy.push(Math.sqrt(sum / hop.length))
    this.sessionSample += hop.length

    if (!this.inSpeech) {
      this.voicedRun = voiced ? this.voicedRun + 1 : 0
      if (this.voicedRun >= ONSET) {
        this.inSpeech = true
        this.silentRun = 0
      } else {
        this.trim(PREROLL + ONSET)
      }
      return null
    }

    this.silentRun = voiced ? 0 : this.silentRun + 1
    if (this.silentRun >= END_SILENCE) {
      this.inSpeech = false
      this.voicedRun = 0
      return this.cut(this.hops.length - this.silentRun + TRAIL)
    }
    if (this.hops.length >= MAX_HOPS) {
      // Cut a long monologue at the quietest hop of the last 3 seconds.
      const from = this.hops.length - Math.floor((3 * SAMPLE_RATE) / HOP)
      let quietest = from
      for (let i = from; i < this.energy.length; i++) if (this.energy[i] < this.energy[quietest]) quietest = i
      return this.cut(quietest)
    }
    return null
  }

  private trim(keep: number) {
    const drop = this.hops.length - keep
    if (drop <= 0) return
    this.hops.splice(0, drop)
    this.energy.splice(0, drop)
    this.bufferStart += drop * HOP
  }

  private cut(at: number): Utterance {
    const n = Math.max(1, Math.min(at, this.hops.length))
    const audio = concat(this.hops.splice(0, n))
    this.energy.splice(0, n)
    const u = { channel: this.id, startSample: this.bufferStart, audio, final: true }
    this.bufferStart += audio.length
    return u
  }

  /** Open utterance so far, for a partial result. */
  snapshot(): Utterance | null {
    if (!this.inSpeech || this.hops.length * HOP < SAMPLE_RATE) return null
    return { channel: this.id, startSample: this.bufferStart, audio: concat(this.hops), final: false }
  }

  /** Ends any open utterance (user pressed stop). */
  flush(): Utterance | null {
    const open = this.inSpeech && this.hops.length > 0
    const u = open ? { channel: this.id, startSample: this.bufferStart, audio: concat(this.hops), final: true } : null
    this.hops = []
    this.energy = []
    this.bufferStart = this.sessionSample
    this.inSpeech = false
    this.voicedRun = 0
    return u
  }
}

/** Finals are processed in order; only the newest partial per channel is kept. */
class Jobs {
  private finals: Utterance[] = []
  private partials = new Map<number, Utterance>()
  private wake: (() => void) | null = null
  closed = false

  push(u: Utterance) {
    if (u.final) {
      this.finals.push(u)
      this.partials.delete(u.channel)
    } else {
      this.partials.set(u.channel, u)
    }
    this.notify()
  }

  close() {
    this.closed = true
    this.notify()
  }

  private notify() {
    this.wake?.()
    this.wake = null
  }

  async take(): Promise<Utterance | null> {
    for (;;) {
      const final = this.finals.shift()
      if (final) return final
      const [key] = [...this.partials.keys()].sort((a, b) => a - b)
      if (key !== undefined) {
        const u = this.partials.get(key)!
        this.partials.delete(key)
        return u
      }
      if (this.closed) return null
      await new Promise<void>((resolve) => (this.wake = resolve))
    }
  }
}

/** Parses framed messages from stdin. */
async function* stdinFrames(): AsyncGenerator<{ kind: number; channel: number; payload: Buffer }> {
  let buf: Buffer = Buffer.alloc(0)
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    while (buf.length >= 6) {
      const length = buf.readUInt32LE(2)
      if (buf.length < 6 + length) break
      yield { kind: buf[0], channel: buf[1], payload: buf.subarray(6, 6 + length) }
      buf = buf.subarray(6 + length)
    }
  }
}

async function transcribeUtterance(
  whisper: WhisperContext,
  u: Utterance,
  ch: Channel,
  language: string,
  words: boolean
) {
  const wantWords = u.final && words
  const res = await whisperPass(whisper, u.audio, {
    language,
    words: wantWords,
    fallback: u.final,
    prompt: ch.prompt || undefined
  }).catch(() => null)
  const text = res ? clean(wantWords ? res.segments.map((s) => s.text).join('') : res.result) : null
  const offsetMs = Math.round((u.startSample * 1000) / SAMPLE_RATE)
  const event: Record<string, unknown> = {
    type: u.final ? 'final' : 'partial',
    channel: u.channel,
    text: text ?? '',
    startMs: offsetMs,
    endMs: Math.round(((u.startSample + u.audio.length) * 1000) / SAMPLE_RATE)
  }
  if (res?.language && language === 'auto') event.language = res.language
  if (wantWords && text && res) event.words = wordsFromTokens(res.segments, offsetMs)
  if (u.final && text) ch.prompt = `${ch.prompt} ${text}`.slice(-PROMPT_CHARS).trim()
  if (u.final || text) emit(event)
}

export async function runListen(f: Record<string, string>) {
  const language = whisperLanguage(f.language)
  // Word timings cost extra decoder work, so only compute them where they're used.
  const wordChannels = new Set((f['words-channels'] ?? '').split(',').filter(Boolean).map(Number))
  const modelsDir = requireFlag(f, 'models-dir')

  const [whisper, vadModel] = await Promise.all([requireModel(f), auxModel(modelsDir, 'vad')])
  const { Vad } = await loadSherpa()
  const newVad = () =>
    new Vad(
      {
        sileroVad: { model: vadModel, threshold: 0.5, minSilenceDuration: 0.1, minSpeechDuration: 0.1, windowSize: HOP },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
        debug: false
      },
      30
    )

  const jobs = new Jobs()
  const channels = new Map<number, Channel>()
  emit({ type: 'ready', model: f.model })

  const worker = (async () => {
    for (let u = await jobs.take(); u; u = await jobs.take()) {
      await transcribeUtterance(whisper, u, channels.get(u.channel)!, language, wordChannels.has(u.channel))
    }
  })()

  for await (const { kind, channel: id, payload } of stdinFrames()) {
    let channel = channels.get(id)
    if (!channel) {
      channel = new Channel(id, newVad())
      channels.set(id, channel)
    }
    if (kind === 1) {
      const pcm = new Int16Array(payload.buffer.slice(payload.byteOffset, payload.byteOffset + (payload.length & ~1)))
      for (const u of channel.feed(int16ToFloat(pcm))) jobs.push(u)
      const now = Date.now()
      if (now - channel.lastPartialAt > 1000) {
        const snap = channel.snapshot()
        if (snap) {
          channel.lastPartialAt = now
          jobs.push(snap)
        }
      }
    } else if (kind === 2) {
      channel.reset()
    } else if (kind === 3) {
      const u = channel.flush()
      if (u) jobs.push(u)
    }
  }

  // stdin closed: finish what's queued, then exit.
  for (const channel of channels.values()) {
    const u = channel.flush()
    if (u) jobs.push(u)
  }
  jobs.close()
  await worker
  await releaseWhisper(whisper)
}
