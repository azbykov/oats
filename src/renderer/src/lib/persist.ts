import type { AppData, DataOp, Note, NoteRecord } from '../../../shared/types'

// Store updates replace only what they change, so comparing references between the previous
// and next AppData finds exactly what to save. A note's transcript is sent as the lines added
// at its end when that is all that happened, which is every line during live transcription.

function record({ transcript: _t, panels: _p, ...rest }: Note): NoteRecord {
  return rest
}

function sameRecord(a: Note, b: Note) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    if (k === 'transcript' || k === 'panels') continue
    if (a[k as keyof Note] !== b[k as keyof Note]) return false
  }
  return true
}

function transcriptOps(prev: Note | undefined, next: Note): DataOp[] {
  const before = prev?.transcript ?? []
  const after = next.transcript
  if (before === after) return []
  const appended = after.length > before.length && before.every((s, i) => after[i] === s)
  if (appended) return [{ type: 'transcript-append', noteId: next.id, segments: after.slice(before.length) }]
  if (!prev && !after.length) return []
  return [{ type: 'transcript-replace', noteId: next.id, segments: after }]
}

export function changes(prev: AppData, next: AppData): DataOp[] {
  const ops: DataOp[] = []
  if (prev.notes !== next.notes) {
    const before = new Map(prev.notes.map((n) => [n.id, n]))
    for (const n of next.notes) {
      const p = before.get(n.id)
      before.delete(n.id)
      if (p === n) continue
      if (!p || !sameRecord(p, n)) ops.push({ type: 'note', note: record(n) })
      ops.push(...transcriptOps(p, n))
      if (p ? p.panels !== n.panels : n.panels.length) ops.push({ type: 'panels', noteId: n.id, panels: n.panels })
    }
    for (const id of before.keys()) ops.push({ type: 'note-delete', id })
  }
  if (prev.folders !== next.folders) ops.push({ type: 'folders', folders: next.folders })
  if (prev.templates !== next.templates) ops.push({ type: 'templates', templates: next.templates })
  if (prev.recipes !== next.recipes) ops.push({ type: 'recipes', recipes: next.recipes })
  if (prev.settings !== next.settings) ops.push({ type: 'settings', settings: next.settings })
  return ops
}
