import type { DiarizationResult, NoteSpeaker, TranscriptSegment, TranscriptWord } from '../../../shared/types'

// Same-voice threshold for WeSpeaker embeddings from the FluidAudio pipeline:
// measured ~0.95 for the same voice and ~0.36 for different voices.
const SAME_SPEAKER = 0.7
const MAX_GAP_MS = 1500

export function cosine(a: number[], b: number[]) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/**
 * Labels the "them" transcript segments of one recording session with the
 * speakers found by offline diarization. Speakers are matched to the note's
 * existing speakers by voice embedding, so "Speaker 1" stays the same person
 * across pause/resume sessions.
 */
export function applyDiarization(
  transcript: TranscriptSegment[],
  speakers: NoteSpeaker[],
  result: DiarizationResult,
  sessionStart: number,
  sessionEnd: number,
  newId: () => string
): { transcript: TranscriptSegment[]; speakers: NoteSpeaker[] } {
  const nextSpeakers = [...speakers]
  const taken = new Set<string>()
  const mapping = new Map<string, NoteSpeaker>()

  const talkTime = new Map<string, number>()
  for (const s of result.segments) talkTime.set(s.speakerId, (talkTime.get(s.speakerId) ?? 0) + s.endMs - s.startMs)
  const ids = [...talkTime.keys()].sort((a, b) => talkTime.get(b)! - talkTime.get(a)!)

  // Longest-speaking voices claim existing identities first.
  for (const id of ids) {
    const embedding = result.speakerEmbeddings[id] ?? []
    let best: NoteSpeaker | undefined
    let bestScore = SAME_SPEAKER
    for (const sp of speakers) {
      if (taken.has(sp.id) || !embedding.length) continue
      const score = cosine(sp.embedding, embedding)
      if (score >= bestScore) {
        best = sp
        bestScore = score
      }
    }
    if (best) {
      taken.add(best.id)
      mapping.set(id, best)
    }
  }

  // Voices not heard before become new speakers, numbered in order of appearance.
  const resolve = (id: string) => {
    let sp = mapping.get(id)
    if (!sp) {
      sp = { id: newId(), name: `Speaker ${nextSpeakers.length + 1}`, embedding: result.speakerEmbeddings[id] ?? [] }
      nextSpeakers.push(sp)
      mapping.set(id, sp)
    }
    return sp
  }

  /** Diarized speaker for a time span (absolute ms): most overlap, else the nearest turn. */
  const pick = (absStart: number, absEnd: number): string | null => {
    const start = absStart - sessionStart
    const end = Math.max(absEnd, absStart + 1) - sessionStart
    let bestId: string | null = null
    let bestOverlap = 0
    let nearestId: string | null = null
    let nearestGap = MAX_GAP_MS
    for (const d of result.segments) {
      const overlap = Math.min(end, d.endMs) - Math.max(start, d.startMs)
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        bestId = d.speakerId
      }
      const gap = overlap > 0 ? 0 : Math.min(Math.abs(start - d.endMs), Math.abs(d.startMs - end))
      if (gap < nearestGap) {
        nearestGap = gap
        nearestId = d.speakerId
      }
    }
    return bestId ?? nearestId
  }

  const labelled = transcript.flatMap((seg): TranscriptSegment[] => {
    if (seg.speaker !== 'them' || seg.start < sessionStart || seg.start >= sessionEnd) return [seg]
    const words = seg.words?.filter((w) => w.text)
    if (!words?.length) {
      const id = pick(seg.start, seg.end)
      return [id ? { ...seg, speakerId: resolve(id).id, words: undefined } : seg]
    }

    // One transcript line can span a turn change (short pauses between speakers),
    // so assign each word and split the line wherever the speaker changes.
    const runs: { id: string | null; words: TranscriptWord[] }[] = []
    for (const w of words) {
      const id = pick(w.start, w.end) ?? runs.at(-1)?.id ?? null
      const last = runs.at(-1)
      if (last && last.id === id) last.words.push(w)
      else runs.push({ id, words: [w] })
    }
    // A lone word inside one speaker's turn (A x A) is timing jitter, not a turn change.
    for (let i = 1; i < runs.length - 1; ) {
      if (runs[i].words.length === 1 && runs[i - 1].id === runs[i + 1].id) {
        runs[i - 1].words.push(...runs[i].words, ...runs[i + 1].words)
        runs.splice(i, 2)
      } else {
        i++
      }
    }
    if (runs.length === 1) {
      const id = runs[0].id
      return [{ ...seg, speakerId: id ? resolve(id).id : seg.speakerId, words: undefined }]
    }
    return runs.map((r, i) => ({
      id: i === 0 ? seg.id : `${seg.id}-${i}`,
      speaker: 'them' as const,
      text: r.words.map((w) => w.text).join(' '),
      start: r.words[0].start,
      end: r.words[r.words.length - 1].end,
      speakerId: r.id ? resolve(r.id).id : undefined
    }))
  })

  return { transcript: labelled, speakers: nextSpeakers }
}

export function speakerName(seg: TranscriptSegment, speakers: NoteSpeaker[] | undefined) {
  if (seg.speaker === 'me') return 'Me'
  return speakers?.find((s) => s.id === seg.speakerId)?.name ?? 'Them'
}
