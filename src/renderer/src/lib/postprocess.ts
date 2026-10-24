import type { RecordingMeta, Speaker, TranscriptSegment } from '../../../shared/types'
import type { ChannelRecorder } from './capture'
import { applyDiarization } from './speakers'
import { uid, useStore } from './store'

// What happens to a recording session's local audio after it stops:
//   1. if live transcription failed, re-transcribe each channel offline (Whisper)
//      and replace that part of the transcript — Notion keeps a similar failover
//      copy of meeting audio for the same reason;
//   2. separate the other speakers ("Speaker 1/2…") on the system-audio channel;
//   3. delete the audio.
// Recordings left over from a crash are recovered the same way on the next start.

interface Rec {
  id: string
  channel: Speaker
}

const IGNORABLE = /no speech|not enough audio/i
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function replaceChannel(
  transcript: TranscriptSegment[],
  channel: Speaker,
  from: number,
  to: number,
  recovered: TranscriptSegment[]
) {
  const kept = transcript.filter((s) => !(s.speaker === channel && s.start >= from && s.start < to))
  return [...kept, ...recovered].sort((a, b) => a.start - b.start)
}

async function run(noteId: string, recs: Rec[], offset: number, end: number, failed: boolean) {
  const { setDiarizing } = useStore.getState()
  const settings = () => useStore.getState().data!.settings
  const note = () => useStore.getState().data?.notes.find((n) => n.id === noteId)
  let keepAudio = false
  try {
    if (failed) {
      keepAudio = true // until recovery succeeds, so it can be retried
      setDiarizing(noteId, { status: 'running', message: 'Recovering transcript from local audio…' })
      for (const r of recs) {
        const words = r.channel === 'them' && settings().separateSpeakers
        let segments
        try {
          segments = await window.oats.transcribeRecording(r.id, words)
        } catch (err) {
          if (IGNORABLE.test(err instanceof Error ? err.message : String(err))) continue
          throw err
        }
        const current = note()
        if (!current) return
        const recovered: TranscriptSegment[] = segments.map((s) => ({
          id: uid(),
          speaker: r.channel,
          text: s.text,
          start: offset + s.startMs,
          end: offset + s.endMs,
          words: s.words?.map((w) => ({ text: w.w.trim(), start: offset + w.s, end: offset + w.e }))
        }))
        useStore.getState().updateNote(noteId, {
          transcript: replaceChannel(current.transcript, r.channel, offset, end, recovered)
        })
      }
      keepAudio = false
    }

    const them = recs.find((r) => r.channel === 'them')
    if (them && settings().separateSpeakers) {
      setDiarizing(noteId, { status: 'running', message: 'Identifying speakers…' })
      try {
        const result = await window.oats.diarizeRecording(them.id)
        const current = note()
        if (current) {
          useStore
            .getState()
            .updateNote(noteId, applyDiarization(current.transcript, current.speakers ?? [], result, offset, end, uid))
        }
      } catch (err) {
        if (!IGNORABLE.test(err instanceof Error ? err.message : String(err))) throw err
      }
    }
    setDiarizing(noteId, null)
  } catch (err) {
    setDiarizing(noteId, { status: 'error', message: err instanceof Error ? err.message : String(err) })
  } finally {
    if (!keepAudio) await Promise.all(recs.map((r) => window.oats.removeRecording(r.id)))
  }
}

export async function processSession(s: {
  noteId: string
  offset: number
  end: number
  recorders: ChannelRecorder[]
  failed: boolean
  settleMs: number
}) {
  const started = s.recorders.filter((r) => r.started)
  await Promise.all(s.recorders.map((r) => (r.started ? r.stop() : window.oats.removeRecording(r.id))))
  if (!started.length) return
  if (s.failed || started.some((r) => r.meta.channel === 'them')) {
    useStore.getState().setDiarizing(s.noteId, { status: 'running', message: 'Processing audio…' })
  }
  // Let the session's last live results arrive before touching the transcript.
  await sleep(s.settleMs)
  // Allow the transcript end to stretch by the settle time for late finals.
  await run(s.noteId, started.map((r) => ({ id: r.id, channel: r.meta.channel })), s.offset, s.end + s.settleMs, s.failed)
}

/** Recordings from a session the app never finished (quit or crash): recover them. */
export async function recoverLeftovers() {
  const metas = await window.oats.leftoverRecordings()
  const sessions = new Map<string, RecordingMeta[]>()
  for (const m of metas) sessions.set(m.sessionId, [...(sessions.get(m.sessionId) ?? []), m])
  for (const group of sessions.values()) {
    const { noteId, offset } = group[0]
    if (!useStore.getState().data?.notes.some((n) => n.id === noteId)) {
      await Promise.all(group.map((m) => window.oats.removeRecording(m.id)))
      continue
    }
    await run(noteId, group.map((m) => ({ id: m.id, channel: m.channel })), offset, Number.POSITIVE_INFINITY, true)
  }
}
