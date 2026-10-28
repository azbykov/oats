import { createHash } from 'node:crypto'
import type { SemanticHit, SemanticStatus } from '../shared/types'
import { downloadModel, embed, EmbedError, EMBEDDING_MODEL, modelReady, removeModel, runtimeAvailable } from './embeddings'
import {
  allNoteIds,
  chunkHash,
  clearChunks,
  indexStats,
  loadChunks,
  noteForIndex,
  saveChunks,
  type StoredChunk
} from './store'

// Semantic search over notes: each note is split into passages of about a thousand
// characters (transcript by time, notes and generated notes by paragraph), embedded once
// the note has been quiet for a minute (so not during a call), and searched by cosine
// similarity over all passages in memory. That is a few milliseconds for years of meetings.

const PASSAGE_CHARS = 1000
const QUIET_MS = 60_000
const TICK_MS = 10_000

type Passage = Omit<StoredChunk, 'vector' | 'noteId'>

let status: SemanticStatus = { model: 'missing', indexed: 0, total: 0 }
let notify: (s: SemanticStatus) => void = () => {}
/** Notes waiting to be embedded, with when they last changed. */
const dirty = new Map<string, number>()
let indexing = false
let cache: StoredChunk[] | null = null

function publish(patch: Partial<SemanticStatus> = {}) {
  status = { ...status, ...indexStats(), ...patch }
  notify(status)
}

export const semanticStatus = () => status

export async function initSemantic(onStatus: (s: SemanticStatus) => void) {
  notify = onStatus
  if (!runtimeAvailable()) return publish({ model: 'unavailable' })
  publish({ model: modelReady() ? 'ready' : 'missing' })
  // Picks up notes changed by an older version, or before the model was downloaded.
  for (const id of allNoteIds()) dirty.set(id, 0)
  setInterval(tick, TICK_MS).unref()
  tick()
}

export async function downloadSemanticModel() {
  if (status.model !== 'missing') return
  publish({ model: 'downloading', progress: 0, error: undefined })
  let last = 0
  try {
    await downloadModel((p) => {
      if (p - last < 0.01 && p < 1) return
      last = p
      publish({ progress: p })
    })
    publish({ model: 'ready', progress: undefined })
    tick()
  } catch (err) {
    publish({ model: 'missing', progress: undefined, error: err instanceof Error ? err.message : String(err) })
  }
}

export async function removeSemanticModel() {
  await removeModel()
  clearChunks()
  cache = null
  for (const id of allNoteIds()) dirty.set(id, 0)
  publish({ model: 'missing' })
}

/** The model can't run on this computer: say why in Settings and stop trying until restart. */
function giveUp(err: EmbedError) {
  console.error('Semantic search is off:', err.message)
  const error =
    process.platform === 'win32'
      ? 'The search model couldn’t start. Install the Microsoft Visual C++ Redistributable (x64) and restart Oats.'
      : `The search model couldn’t start: ${err.message.split('\n')[0].slice(0, 160)}`
  publish({ model: 'unavailable', error })
}

/** Notes that changed; they are embedded again once they've been quiet for a minute. */
export function touchNotes(ids: string[]) {
  const now = Date.now()
  for (const id of ids) dirty.set(id, now)
}

export function forgetNote(id: string) {
  dirty.delete(id)
  if (cache) cache = cache.filter((c) => c.noteId !== id)
}

function passages(noteId: string): { title: string; parts: Passage[] } | null {
  const note = noteForIndex(noteId)
  if (!note) return null
  const out: Passage[] = []

  // Paragraphs packed into passages of up to PASSAGE_CHARS; a longer paragraph is cut.
  const pack = (text: string, kind: Passage['kind']) => {
    let current = ''
    const flush = () => {
      if (current.trim()) out.push({ kind, text: current.trim() })
      current = ''
    }
    for (const para of text.split(/\n\s*\n|\n(?=#)/)) {
      for (let i = 0; i < para.length; i += PASSAGE_CHARS) {
        const piece = para.slice(i, i + PASSAGE_CHARS)
        if (current.length + piece.length > PASSAGE_CHARS) flush()
        current += (current ? '\n' : '') + piece
      }
    }
    flush()
  }
  pack(note.notesMarkdown, 'notes')
  for (const panel of note.panels) pack(panel, 'panel')

  const name = (s: (typeof note.segments)[number]) =>
    s.speaker === 'me' ? 'Me' : (note.speakers.find((x) => x.id === s.speaker_id)?.name ?? 'Them')
  let lines: string[] = []
  let start = 0
  let end = 0
  let size = 0
  for (const s of note.segments) {
    if (!lines.length) start = s.start_ms
    lines.push(`${name(s)}: ${s.text}`)
    size += s.text.length
    end = s.end_ms
    if (size >= PASSAGE_CHARS) {
      out.push({ kind: 'transcript', startMs: start, endMs: end, text: lines.join('\n') })
      lines = []
      size = 0
    }
  }
  if (lines.length) out.push({ kind: 'transcript', startMs: start, endMs: end, text: lines.join('\n') })

  return { title: note.title, parts: out }
}

async function indexNote(id: string) {
  const note = passages(id)
  if (!note) return
  const hash = createHash('sha1')
    .update(EMBEDDING_MODEL + JSON.stringify(note))
    .digest('hex')
  if (chunkHash(id) === hash) return
  // The title goes into every passage for embedding, so a passage keeps its context.
  const vectors = await embed(note.parts.map((p) => `passage: ${note.title}\n${p.text}`))
  const chunks: StoredChunk[] = note.parts.map((p, i) => ({ ...p, noteId: id, vector: vectors[i] }))
  saveChunks(id, hash, chunks)
  if (cache) cache = [...cache.filter((c) => c.noteId !== id), ...chunks]
}

async function tick() {
  // New and deleted notes change the count shown in Settings.
  const stats = indexStats()
  if (stats.indexed !== status.indexed || stats.total !== status.total) publish()
  if (indexing || status.model !== 'ready') return
  indexing = true
  try {
    const due = () => [...dirty].find(([, at]) => Date.now() - at >= QUIET_MS)?.[0]
    for (let id = due(); id; id = due()) {
      const at = dirty.get(id)
      try {
        await indexNote(id)
      } catch (err) {
        if (err instanceof EmbedError && err.fatal) return giveUp(err)
        console.error('Failed to embed note', id, err)
      }
      // Changed again while it was being embedded: leave it for the next round.
      if (dirty.get(id) === at) dirty.delete(id)
      publish()
      // Let the main process breathe between notes.
      await new Promise((r) => setImmediate(r))
    }
  } finally {
    indexing = false
  }
}

/**
 * Passages closest in meaning to `query`, best first, or null when the model isn't there.
 * `noteIds` limits the search to those notes.
 */
export async function semanticSearch(query: string, noteIds?: string[], limit = 40): Promise<SemanticHit[] | null> {
  if (status.model !== 'ready' || !query.trim()) return null
  let q: Float32Array
  try {
    ;[q] = await embed([`query: ${query.trim()}`])
  } catch (err) {
    if (err instanceof EmbedError && err.fatal) giveUp(err)
    throw err
  }
  cache ??= loadChunks()
  const only = noteIds && new Set(noteIds)
  const scored: SemanticHit[] = []
  for (const c of cache) {
    if (only && !only.has(c.noteId)) continue
    let score = 0
    for (let j = 0; j < q.length; j++) score += q[j] * c.vector[j]
    scored.push({ noteId: c.noteId, kind: c.kind, startMs: c.startMs, endMs: c.endMs, text: c.text, score })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit)
}
