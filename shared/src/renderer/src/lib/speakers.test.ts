import { describe, expect, it } from 'vitest'
import type { DiarizationResult, NoteSpeaker, TranscriptSegment } from '../../../common/types'
import { applyDiarization, cosine, speakerName } from './speakers'

const VOICE_A = [1, 0, 0]
const VOICE_B = [0, 1, 0]
const VOICE_C = [0, 0, 1]

const ids = () => {
  let n = 0
  return () => `new-${++n}`
}

const them = (id: string, start: number, end: number, patch: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  id,
  speaker: 'them',
  text: id,
  start,
  end,
  ...patch
})

const result = (
  segments: [speakerId: string, startMs: number, endMs: number][],
  speakerEmbeddings: Record<string, number[]>
): DiarizationResult => ({
  modelId: 'test',
  durationMs: Math.max(0, ...segments.map((s) => s[2])),
  segments: segments.map(([speakerId, startMs, endMs]) => ({ speakerId, startMs, endMs })),
  speakerEmbeddings
})

const words = (...list: [text: string, start: number, end: number][]) =>
  list.map(([text, start, end]) => ({ text, start, end }))

describe('cosine', () => {
  it('is 1 for the same direction, 0 for orthogonal and for empty vectors', () => {
    expect(cosine([1, 2, 3], [2, 4, 6])).toBeCloseTo(1)
    expect(cosine(VOICE_A, VOICE_B)).toBe(0)
    expect(cosine([], VOICE_A)).toBe(0)
    expect(cosine([0, 0, 0], VOICE_A)).toBe(0)
  })
})

describe('applyDiarization', () => {
  it('numbers new voices in order of appearance in the transcript', () => {
    const transcript = [them('a', 0, 1000), them('b', 2000, 3000)]
    const r = result(
      [
        ['x', 0, 1000],
        ['y', 2000, 9000]
      ],
      { x: VOICE_A, y: VOICE_B }
    )
    const out = applyDiarization(transcript, [], r, 0, 10_000, ids())
    expect(out.speakers.map((s) => s.name)).toEqual(['Speaker 1', 'Speaker 2'])
    expect(out.speakers[0].embedding).toEqual(VOICE_A)
    expect(out.transcript.map((s) => s.speakerId)).toEqual([out.speakers[0].id, out.speakers[1].id])
  })

  it('keeps a known voice as the same speaker in a later session', () => {
    const known: NoteSpeaker[] = [
      { id: 'sp1', name: 'Anna', embedding: VOICE_A },
      { id: 'sp2', name: 'Speaker 2', embedding: VOICE_B }
    ]
    // Session two starts at 60 s; diarization times are relative to it.
    const transcript = [them('old', 1000, 2000, { speakerId: 'sp1' }), them('a', 60_000, 61_000), them('b', 62_000, 63_000)]
    const r = result(
      [
        ['x', 0, 1000],
        ['y', 2000, 3000]
      ],
      { x: [0.1, 0.99, 0], y: [0.99, 0.1, 0] }
    )
    const out = applyDiarization(transcript, known, r, 60_000, 70_000, ids())
    expect(out.speakers).toEqual(known)
    expect(out.transcript.map((s) => s.speakerId)).toEqual(['sp1', 'sp2', 'sp1'])
  })

  it('adds a speaker for a voice unlike the known ones', () => {
    const known: NoteSpeaker[] = [{ id: 'sp1', name: 'Speaker 1', embedding: VOICE_A }]
    const r = result([['x', 0, 1000]], { x: VOICE_C })
    const out = applyDiarization([them('a', 0, 1000)], known, r, 0, 10_000, ids())
    expect(out.speakers).toHaveLength(2)
    expect(out.speakers[1]).toMatchObject({ id: 'new-1', name: 'Speaker 2', embedding: VOICE_C })
    expect(out.transcript[0].speakerId).toBe('new-1')
  })

  it('gives a known identity to one voice only, the one that spoke longest', () => {
    const known: NoteSpeaker[] = [{ id: 'sp1', name: 'Speaker 1', embedding: VOICE_A }]
    const transcript = [them('a', 0, 1000), them('b', 2000, 8000)]
    const r = result(
      [
        ['short', 0, 1000],
        ['long', 2000, 8000]
      ],
      { short: [1, 0.05, 0], long: [1, 0.1, 0] }
    )
    const out = applyDiarization(transcript, known, r, 0, 10_000, ids())
    expect(out.transcript[1].speakerId).toBe('sp1')
    expect(out.transcript[0].speakerId).toBe('new-1')
    expect(out.speakers).toHaveLength(2)
  })

  it('leaves my lines and lines outside the session untouched', () => {
    const mine: TranscriptSegment = { id: 'me', speaker: 'me', text: 'hi', start: 60_500, end: 61_000 }
    const before = them('before', 1000, 2000, { speakerId: 'sp1' })
    const after = them('after', 70_000, 71_000)
    const inside = them('inside', 60_000, 61_000)
    const r = result([['x', 0, 20_000]], { x: VOICE_A })
    const out = applyDiarization([before, mine, inside, after], [], r, 60_000, 70_000, ids())
    expect(out.transcript[0]).toBe(before)
    expect(out.transcript[1]).toBe(mine)
    expect(out.transcript[3]).toBe(after)
    expect(out.transcript[2].speakerId).toBe('new-1')
  })

  it('uses the nearest turn within 1.5 s when a line overlaps none', () => {
    const r = result([['x', 0, 1000]], { x: VOICE_A })
    const near = applyDiarization([them('a', 2000, 2400)], [], r, 0, 10_000, ids())
    expect(near.transcript[0].speakerId).toBe('new-1')

    const far = applyDiarization([them('a', 5000, 5400)], [], r, 0, 10_000, ids())
    expect(far.transcript[0].speakerId).toBeUndefined()
    expect(far.speakers).toEqual([])
  })

  it('picks the speaker with the most overlap', () => {
    const r = result(
      [
        ['x', 0, 1000],
        ['y', 1000, 5000]
      ],
      { x: VOICE_A, y: VOICE_B }
    )
    const out = applyDiarization([them('a', 800, 3000)], [], r, 0, 10_000, ids())
    expect(out.speakers).toHaveLength(1)
    expect(out.speakers[0].embedding).toEqual(VOICE_B)
  })

  it('splits a line where the speaker changes and drops its word timings', () => {
    const line = them('line', 0, 4000, {
      text: 'hello there fine thanks',
      words: words(['hello', 0, 500], ['there', 500, 1000], ['fine', 2000, 2500], ['thanks', 2500, 3000])
    })
    const r = result(
      [
        ['x', 0, 1000],
        ['y', 2000, 3000]
      ],
      { x: VOICE_A, y: VOICE_B }
    )
    const out = applyDiarization([line], [], r, 0, 10_000, ids())
    expect(out.transcript).toEqual([
      { id: 'line', speaker: 'them', text: 'hello there', start: 0, end: 1000, speakerId: 'new-1' },
      { id: 'line-1', speaker: 'them', text: 'fine thanks', start: 2000, end: 3000, speakerId: 'new-2' }
    ])
  })

  it('treats a lone word between two runs of one speaker as jitter', () => {
    const line = them('line', 0, 5000, {
      text: 'one two three four five',
      words: words(['one', 0, 400], ['two', 400, 800], ['three', 1000, 1400], ['four', 2000, 2400], ['five', 2400, 2800])
    })
    const r = result(
      [
        ['x', 0, 900],
        ['y', 1000, 1400],
        ['x', 2000, 3000]
      ],
      { x: VOICE_A, y: VOICE_B }
    )
    const out = applyDiarization([line], [], r, 0, 10_000, ids())
    expect(out.transcript).toHaveLength(1)
    expect(out.transcript[0]).toMatchObject({ id: 'line', text: 'one two three four five', speakerId: 'new-1' })
    expect(out.transcript[0].words).toBeUndefined()
    expect(out.speakers).toHaveLength(1)
  })

  it('labels a line without word timings as a whole', () => {
    const r = result([['x', 0, 5000]], { x: VOICE_A })
    const out = applyDiarization([them('a', 0, 4000, { words: [] })], [], r, 0, 10_000, ids())
    expect(out.transcript).toEqual([{ id: 'a', speaker: 'them', text: 'a', start: 0, end: 4000, speakerId: 'new-1', words: undefined }])
  })

  it('does not mutate the speakers it was given', () => {
    const known: NoteSpeaker[] = [{ id: 'sp1', name: 'Speaker 1', embedding: VOICE_A }]
    const r = result([['x', 0, 1000]], { x: VOICE_C })
    applyDiarization([them('a', 0, 1000)], known, r, 0, 10_000, ids())
    expect(known).toHaveLength(1)
  })
})

describe('speakerName', () => {
  const speakers: NoteSpeaker[] = [{ id: 'sp1', name: 'Anna', embedding: [] }]
  it('names me, a known speaker, and falls back to Them', () => {
    expect(speakerName({ id: '1', speaker: 'me', text: '', start: 0, end: 0 }, speakers)).toBe('Me')
    expect(speakerName(them('1', 0, 0, { speakerId: 'sp1' }), speakers)).toBe('Anna')
    expect(speakerName(them('1', 0, 0, { speakerId: 'gone' }), speakers)).toBe('Them')
    expect(speakerName(them('1', 0, 0), undefined)).toBe('Them')
  })
})
