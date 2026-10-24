import { writeFile } from 'node:fs/promises'
import {
  clean,
  readWav,
  releaseWhisper,
  requireFlag,
  SAMPLE_RATE,
  whisperLanguage,
  whisperPass,
  wordsFromTokens,
  type Word
} from './common'
import { requireModel } from './listen'

// Batch transcription of a recorded WAV, used to recover a session whose live
// transcription failed (network drop, crash) from the local audio backup.
//
//   oats-audio transcribe --input a.wav --model <variant> --models-dir <dir>
//                         [--language <code>] [--words 1] [--output out.json]
//     → { segments: [{ text, startMs, endMs, words?: [{w, s, e}] }] }

interface Segment {
  text: string
  startMs: number
  endMs: number
  words?: Word[]
}

function rms(samples: Float32Array, startMs: number, endMs: number) {
  const a = Math.max(0, Math.min(samples.length, Math.floor((startMs * SAMPLE_RATE) / 1000)))
  const b = Math.max(a, Math.min(samples.length, Math.floor((endMs * SAMPLE_RATE) / 1000)))
  if (b <= a) return 0
  let sum = 0
  for (let i = a; i < b; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / (b - a))
}

/**
 * Word mode decodes token by token, which loses Whisper's own segment
 * boundaries; rebuild lines at sentence ends, long pauses or every ~15 s.
 */
function groupWords(words: Word[]): Segment[] {
  const out: Segment[] = []
  let line: Word[] = []
  const close = () => {
    if (!line.length) return
    out.push({ text: line.map((w) => w.w).join(''), startMs: line[0].s, endMs: line.at(-1)!.e, words: line })
    line = []
  }
  for (const w of words) {
    const prev = line.at(-1)
    if (prev && (w.s - prev.e > 1000 || w.e - line[0].s > 15_000)) close()
    line.push(w)
    if (/[.!?…]$/.test(w.w.trim())) close()
  }
  close()
  return out
}

export async function runTranscribe(f: Record<string, string>) {
  const audio = await readWav(requireFlag(f, 'input'))
  const words = f.words === '1'
  const whisper = await requireModel(f)
  const res = await whisperPass(whisper, audio, { language: whisperLanguage(f.language), words })
  await releaseWhisper(whisper)

  const raw: Segment[] = words
    ? groupWords(wordsFromTokens(res.segments))
    : res.segments.map((s) => ({ text: s.text, startMs: Math.round(s.t0), endMs: Math.round(s.t1) }))

  const segments: Segment[] = []
  for (const s of raw) {
    // Whisper invents short phrases ("Thank you.") over silence; drop segments whose audio is silent.
    const text = clean(s.text)
    if (!text || rms(audio, s.startMs, s.endMs) <= 0.004) continue
    segments.push({ ...s, text })
  }

  const json = JSON.stringify({ segments })
  if (f.output) await writeFile(f.output, json)
  else process.stdout.write(`${json}\n`)
}
