import { writeFile } from 'node:fs/promises'
import type { DiarizationSegment } from 'sherpa-onnx-node'
import { auxModel, CLIError, defaultModelsDir, loadSherpa, readWav, requireFlag, SAMPLE_RATE } from './common'

// Offline speaker diarization with sherpa-onnx (pyannote segmentation 3.0 +
// WeSpeaker ResNet34 embeddings, the same model family FluidAudio converts to
// CoreML), so voice embeddings stay comparable with the app's thresholds.
//
//   oats-audio diarize --input a.wav [--max-speakers N] --output out.json
//     → { modelId, durationMs, segments: [{ speakerId, startMs, endMs }],
//         speakerEmbeddings: { speakerId: [Float] } }
//
//   oats-audio embed --input a.wav --output out.json
//     → { modelId, embedding, speechMs, speakerCount, dominantShare }
//
// Models (~32 MB) are downloaded on first use into <models dir>/sherpa.

const MODEL_ID = 'sherpa-onnx/pyannote-segmentation-3.0+wespeaker-resnet34-LM'
// Agglomerative clustering distance; higher merges more voices into one speaker.
// sherpa's 0.5 default merged two different voices in a short two-person clip,
// 0.3 split one voice in two; 0.4 separated every test mix correctly.
const CLUSTER_THRESHOLD = 0.4
// Speech per speaker used for its voice embedding.
const EMBED_SECONDS = 30
const MIN_EMBED_SECONDS = 1

const ms = (seconds: number) => Math.round(seconds * 1000)

function normalize(v: Float32Array | number[]) {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  return Array.from(v, (x) => x / n)
}

async function diarize(input: string, modelsDir: string, maxSpeakers?: number) {
  const prepStart = Date.now()
  const [segmentation, embedding] = await Promise.all([
    auxModel(modelsDir, 'segmentation'),
    auxModel(modelsDir, 'embedding')
  ])
  const { OfflineSpeakerDiarization, SpeakerEmbeddingExtractor } = await loadSherpa()
  const sd = new OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: segmentation }, numThreads: 2 },
    embedding: { model: embedding, numThreads: 2 },
    clustering: { numClusters: -1, threshold: CLUSTER_THRESHOLD },
    minDurationOn: 0.3,
    minDurationOff: 0.5
  })
  const extractor = new SpeakerEmbeddingExtractor({ model: embedding, numThreads: 2 })
  const prepMs = Date.now() - prepStart

  const samples = await readWav(input)
  if (!samples.length) throw new CLIError('no speech detected in the audio')
  let segments = sd.process(samples)
  // The threshold decides the speaker count; when it finds more than the caller
  // allows, cluster again into exactly that many.
  if (maxSpeakers && new Set(segments.map((s) => s.speaker)).size > maxSpeakers) {
    sd.setConfig({ clustering: { numClusters: maxSpeakers } })
    segments = sd.process(samples)
  }
  if (!segments.length) throw new CLIError('no speech detected in the audio')

  /** Average of per-segment embeddings over a speaker's longest stretches of speech. */
  const voiceOf = (speaker: number) => {
    const own = segments.filter((s) => s.speaker === speaker).sort((a, b) => b.end - b.start - (a.end - a.start))
    const long = own.filter((s) => s.end - s.start >= MIN_EMBED_SECONDS)
    const picked: DiarizationSegment[] = []
    let total = 0
    for (const s of long.length ? long : own.slice(0, 1)) {
      if (total >= EMBED_SECONDS) break
      picked.push(s)
      total += s.end - s.start
    }
    const sum = new Float64Array(extractor.dim)
    let count = 0
    for (const s of picked) {
      const stream = extractor.createStream()
      stream.acceptWaveform({
        sampleRate: SAMPLE_RATE,
        samples: samples.subarray(Math.floor(s.start * SAMPLE_RATE), Math.ceil(s.end * SAMPLE_RATE))
      })
      stream.inputFinished()
      if (!extractor.isReady(stream)) continue
      normalize(extractor.compute(stream, false)).forEach((x, i) => (sum[i] += x))
      count++
    }
    return count ? normalize(Array.from(sum)) : []
  }

  return { segments, samples, prepMs, voiceOf }
}

const speakerId = (n: number) => `speaker_${n + 1}`

export async function runDiarization(command: 'diarize' | 'embed', f: Record<string, string>) {
  const input = requireFlag(f, 'input')
  const modelsDir = f['models-dir'] ?? defaultModelsDir()
  let out: unknown

  if (command === 'diarize') {
    const max = f['max-speakers'] ? Number(f['max-speakers']) : undefined
    if (max !== undefined && !(Number.isInteger(max) && max > 0)) {
      throw new CLIError('--max-speakers must be a positive integer')
    }
    const { segments, samples, prepMs, voiceOf } = await diarize(input, modelsDir, max)
    const speakers = [...new Set(segments.map((s) => s.speaker))]
    out = {
      modelId: MODEL_ID,
      durationMs: Math.round((samples.length * 1000) / SAMPLE_RATE),
      segments: [...segments]
        .sort((a, b) => a.start - b.start)
        .map((s) => ({ speakerId: speakerId(s.speaker), startMs: ms(s.start), endMs: ms(s.end) })),
      speakerEmbeddings: Object.fromEntries(speakers.map((s) => [speakerId(s), voiceOf(s)])),
      modelPrepMs: prepMs
    }
  } else {
    // embed: a voice sample that should mostly contain one speaker
    const { segments, prepMs, voiceOf } = await diarize(input, modelsDir)
    const speech = new Map<number, number>()
    for (const s of segments) speech.set(s.speaker, (speech.get(s.speaker) ?? 0) + s.end - s.start)
    const total = [...speech.values()].reduce((a, b) => a + b, 0)
    const [dominant, dominantSeconds] = [...speech].sort((a, b) => b[1] - a[1])[0]
    const embedding = voiceOf(dominant)
    if (!embedding.length) throw new CLIError('no speech detected in the audio')
    out = {
      modelId: MODEL_ID,
      embedding,
      speechMs: ms(total),
      speakerCount: speech.size,
      dominantShare: total > 0 ? dominantSeconds / total : 0,
      modelPrepMs: prepMs
    }
  }

  const json = JSON.stringify(out)
  if (f.output) await writeFile(f.output, json)
  else process.stdout.write(`${json}\n`)
}
