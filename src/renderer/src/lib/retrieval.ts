import type { ChatMeeting, Note, SemanticHit } from '../../../shared/types'
import { clock, fullDate, mergeTranscript } from './format'
import { speakerName } from './speakers'

// Picks the meetings a chat question is about, so a chat over many notes reads the relevant
// ones instead of only the latest. BM25 over title, people, notes and transcript; words match
// by their first letters, which covers most Russian and English inflections. When the local
// embedding model is there, passages found by meaning (SemanticHit) are fused in by rank.

const STEM = 6
const STOP = new Set(
  (
    'the and for are was were you your with that this what when where who why how about from have has had ' +
    'did does not but all any can our out they them their there then than into been will would could should ' +
    'just like also some more most very much its it’s i’m we’re про что как это эта этот эти где когда кто ' +
    'почему зачем все всё был была были было есть нет для или его она они оно мне мой моя мои наш наша ' +
    'нам нас вам вас вы мы ты так уже ещё еще тоже только даже если чтобы потом там тут здесь'
  ).split(' ')
)

export function terms(text: string): string[] {
  return (text.toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => w.slice(0, STEM))
}

interface Doc {
  tf: Map<string, number>
  len: number
}

// Notes are replaced on every edit, so an object key is a cache that never goes stale.
const docs = new WeakMap<Note, Doc>()

function docOf(note: Note): Doc {
  const cached = docs.get(note)
  if (cached) return cached
  const tf = new Map<string, number>()
  let len = 0
  const add = (text: string, weight: number) => {
    for (const t of terms(text)) {
      tf.set(t, (tf.get(t) ?? 0) + weight)
      len += weight
    }
  }
  add(note.title, 3)
  add(note.attendees.map((a) => a.name).join(' '), 3)
  add(note.speakers?.map((s) => s.name).join(' ') ?? '', 2)
  add(note.notesMarkdown, 2)
  add(note.panels.map((p) => p.markdown).join('\n'), 2)
  add(note.transcript.map((s) => s.text).join(' '), 1)
  const doc = { tf, len }
  docs.set(note, doc)
  return doc
}

/** Reciprocal rank fusion constant: how much the top few ranks outweigh the rest. */
const RRF_K = 60

/** Notes matching the query by relevance, then the rest newest first. */
export function rankNotes(notes: Note[], query: string[], semantic?: SemanticHit[] | null): Note[] {
  const q = [...new Set(query)]
  const all = notes.map((note) => ({ note, doc: docOf(note), score: 0 }))
  if (q.length) {
    const avg = all.reduce((sum, d) => sum + d.doc.len, 0) / Math.max(all.length, 1) || 1
    for (const t of q) {
      const df = all.filter((d) => d.doc.tf.has(t)).length
      if (!df) continue
      const idf = Math.log(1 + (all.length - df + 0.5) / (df + 0.5))
      for (const d of all) {
        const f = d.doc.tf.get(t)
        if (f) d.score += (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * d.doc.len) / avg))
      }
    }
  }
  const fused = new Map<Note, number>()
  ;[...all]
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .forEach((d, rank) => fused.set(d.note, 1 / (RRF_K + rank)))
  if (semantic?.length) {
    // Each note ranks by its best passage; hits come sorted best first.
    const byId = new Map(notes.map((n) => [n.id, n]))
    const seen = new Set<string>()
    for (const hit of semantic) {
      const note = byId.get(hit.noteId)
      if (!note || seen.has(hit.noteId)) continue
      fused.set(note, (fused.get(note) ?? 0) + 1 / (RRF_K + seen.size))
      seen.add(hit.noteId)
    }
  }
  return [...notes].sort(
    (a, b) => (fused.get(b) ?? 0) - (fused.get(a) ?? 0) || b.createdAt.localeCompare(a.createdAt)
  )
}

/** The transcript as the chat sees it: one line per turn, with when it was said. */
const transcriptLines = (note: Note) =>
  mergeTranscript(note.transcript).map((s) => ({
    start: s.start,
    end: s.end,
    text: `[${clock(s.start)}] ${speakerName(s, note.speakers)}: ${s.text}`
  }))

/**
 * Transcript lines that mention the query or fall in a passage found by meaning, with a
 * little context, up to `max` characters.
 */
function excerpt(
  lines: ReturnType<typeof transcriptLines>,
  query: Set<string>,
  hits: SemanticHit[],
  max: number
) {
  const keep = new Set<number>()
  lines.forEach((line, i) => {
    const said = hits.some((h) => h.startMs! <= line.end && h.endMs! >= line.start)
    if (said) keep.add(i)
    if (terms(line.text).some((t) => query.has(t))) for (let j = i - 2; j <= i + 2; j++) keep.add(j)
  })
  // Nothing matched: the opening of the meeting is the most useful part to show.
  if (!keep.size) for (let i = 0; i < lines.length; i++) keep.add(i)
  const out: string[] = []
  let size = 0
  let prev = -1
  for (let i = 0; i < lines.length; i++) {
    if (!keep.has(i)) continue
    const piece = (prev >= 0 && i !== prev + 1 ? '…\n' : '') + lines[i].text
    if (size + piece.length > max) break
    out.push(piece)
    size += piece.length + 1
    prev = i
  }
  return out.join('\n')
}

const CONTEXT_CHARS = 300_000
const MEETING_CHARS = 40_000

/**
 * The meetings to send with a chat question: the most relevant first, as many as fit.
 * `refFor` names each meeting for citations and is only called for the ones included.
 */
export function chatContext(
  notes: Note[],
  question: string,
  refFor: (noteId: string) => string,
  {
    budget = CONTEXT_CHARS,
    perMeeting = MEETING_CHARS,
    semantic
  }: { budget?: number; perMeeting?: number; semantic?: SemanticHit[] | null } = {}
): ChatMeeting[] {
  const query = terms(question)
  const querySet = new Set(query)
  const out: ChatMeeting[] = []
  let used = 0
  for (const note of rankNotes(notes, query, semantic)) {
    const room = Math.min(perMeeting, budget - used)
    if (room < 2_000) break
    const enhanced = note.panels.at(-1)?.markdown
    let notesMarkdown = enhanced ? `${note.notesMarkdown}\n\n--- Enhanced notes ---\n${enhanced}` : note.notesMarkdown
    notesMarkdown = notesMarkdown.slice(0, room)
    const lines = transcriptLines(note)
    const full = lines.map((l) => l.text).join('\n')
    const transcriptRoom = room - notesMarkdown.length
    const cut = full.length > transcriptRoom
    const hits = semantic?.filter((h) => h.noteId === note.id && h.kind === 'transcript') ?? []
    const transcript = cut ? excerpt(lines, querySet, hits, transcriptRoom) : full
    out.push({
      ref: refFor(note.id),
      title: note.title.trim() || 'Untitled',
      date: fullDate(note.createdAt),
      attendees: [...note.attendees.map((a) => a.name), ...(note.speakers?.map((s) => s.name) ?? [])].join(', '),
      notesMarkdown,
      transcript,
      excerpt: cut || undefined
    })
    used += notesMarkdown.length + transcript.length
  }
  return out
}
