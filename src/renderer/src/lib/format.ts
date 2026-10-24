import type { Note, TranscriptSegment } from '../../../shared/types'
import { speakerName } from './speakers'

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

export function dayLabel(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (sameDay(d, today)) return 'Today'
  if (sameDay(d, yesterday)) return 'Yesterday'
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }
  if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric'
  return d.toLocaleDateString(undefined, opts)
}

export const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

export const fullDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

export function clock(ms: number) {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

/** Joins consecutive finals from the same voice into readable lines. */
export function mergeTranscript(segments: TranscriptSegment[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = []
  for (const seg of segments) {
    const last = out.at(-1)
    if (
      last &&
      last.speaker === seg.speaker &&
      last.speakerId === seg.speakerId &&
      seg.start - last.end < 4000 &&
      last.text.length < 400
    ) {
      out[out.length - 1] = { ...last, text: `${last.text} ${seg.text}`, end: seg.end }
    } else {
      out.push(seg)
    }
  }
  return out
}

export function transcriptText(note: Pick<Note, 'transcript' | 'speakers'>) {
  return mergeTranscript(note.transcript)
    .map((s) => `[${clock(s.start)}] ${speakerName(s, note.speakers)}: ${s.text}`)
    .join('\n')
}

export function groupByDay(notes: Note[]) {
  const groups: { label: string; notes: Note[] }[] = []
  for (const n of notes) {
    const label = dayLabel(n.createdAt)
    const g = groups.at(-1)
    if (g && g.label === label) g.notes.push(n)
    else groups.push({ label, notes: [n] })
  }
  return groups
}

export function noteTitle(n: Pick<Note, 'title'>) {
  return n.title.trim() || 'New note'
}
