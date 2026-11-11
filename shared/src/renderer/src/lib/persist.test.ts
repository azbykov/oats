import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../common/defaults'
import type { AppData, Note, Panel, TranscriptSegment } from '../../../common/types'
import { changes } from './persist'

const seg = (id: string, start = 0): TranscriptSegment => ({ id, speaker: 'me', text: id, start, end: start + 1000 })

const note = (id: string, patch: Partial<Note> = {}): Note => ({
  id,
  title: id,
  notesHtml: '',
  notesMarkdown: '',
  transcript: [],
  panels: [],
  folderIds: [],
  attendees: [],
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
  ...patch
})

const panel = (id: string): Panel => ({
  id,
  templateId: 't',
  title: id,
  markdown: '',
  html: '',
  createdAt: '2026-01-01T10:00:00.000Z'
})

const data = (patch: Partial<AppData> = {}): AppData => ({
  notes: [],
  folders: [],
  templates: [],
  recipes: [],
  settings: DEFAULT_SETTINGS,
  ...patch
})

/** The next AppData after replacing one note, the way the store updates it. */
const withNote = (prev: AppData, next: Note): AppData => ({
  ...prev,
  notes: prev.notes.map((n) => (n.id === next.id ? next : n))
})

describe('changes', () => {
  it('saves nothing when nothing changed', () => {
    const d = data({ notes: [note('a')] })
    expect(changes(d, d)).toEqual([])
    expect(changes(d, { ...d })).toEqual([])
  })

  it('saves a new empty note as its record only', () => {
    const prev = data()
    const n = note('a')
    const ops = changes(prev, { ...prev, notes: [n] })
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ type: 'note', note: { id: 'a' } })
    expect((ops[0] as { note: object }).note).not.toHaveProperty('transcript')
    expect((ops[0] as { note: object }).note).not.toHaveProperty('panels')
  })

  it('saves a new note together with the transcript and panels it already has', () => {
    const prev = data()
    const n = note('a', { transcript: [seg('s1')], panels: [panel('p1')] })
    const ops = changes(prev, { ...prev, notes: [n] })
    expect(ops.map((o) => o.type)).toEqual(['note', 'transcript-append', 'panels'])
  })

  it('sends only the lines added at the end of a transcript', () => {
    const s1 = seg('s1')
    const before = note('a', { transcript: [s1] })
    const prev = data({ notes: [before] })
    const s2 = seg('s2', 2000)
    const s3 = seg('s3', 4000)
    const ops = changes(prev, withNote(prev, { ...before, transcript: [s1, s2, s3] }))
    expect(ops).toEqual([{ type: 'transcript-append', noteId: 'a', segments: [s2, s3] }])
  })

  it('replaces the transcript when an earlier line changed', () => {
    const s1 = seg('s1')
    const s2 = seg('s2', 2000)
    const before = note('a', { transcript: [s1, s2] })
    const prev = data({ notes: [before] })
    const edited = { ...s1, text: 'edited' }
    const s3 = seg('s3', 4000)
    const ops = changes(prev, withNote(prev, { ...before, transcript: [edited, s2, s3] }))
    expect(ops).toEqual([{ type: 'transcript-replace', noteId: 'a', segments: [edited, s2, s3] }])
  })

  it('replaces the transcript when lines were removed or cleared', () => {
    const s1 = seg('s1')
    const s2 = seg('s2', 2000)
    const before = note('a', { transcript: [s1, s2] })
    const prev = data({ notes: [before] })
    expect(changes(prev, withNote(prev, { ...before, transcript: [s1] }))).toEqual([
      { type: 'transcript-replace', noteId: 'a', segments: [s1] }
    ])
    expect(changes(prev, withNote(prev, { ...before, transcript: [] }))).toEqual([
      { type: 'transcript-replace', noteId: 'a', segments: [] }
    ])
  })

  it('does not resend the note record when only the transcript grew', () => {
    const before = note('a')
    const prev = data({ notes: [before] })
    const ops = changes(prev, withNote(prev, { ...before, transcript: [seg('s1')] }))
    expect(ops.map((o) => o.type)).toEqual(['transcript-append'])
  })

  it('saves the record alone when a field of the note changed', () => {
    const before = note('a', { transcript: [seg('s1')], panels: [panel('p1')] })
    const prev = data({ notes: [before] })
    const ops = changes(prev, withNote(prev, { ...before, title: 'Renamed' }))
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ type: 'note', note: { id: 'a', title: 'Renamed' } })
  })

  it('notices a field that was added or removed', () => {
    const before = note('a')
    const prev = data({ notes: [before] })
    const deleted = { ...before, deletedAt: '2026-01-02T00:00:00.000Z' }
    expect(changes(prev, withNote(prev, deleted)).map((o) => o.type)).toEqual(['note'])
    const afterDelete = data({ notes: [deleted] })
    expect(changes(afterDelete, withNote(afterDelete, before)).map((o) => o.type)).toEqual(['note'])
  })

  it('saves panels when they change, including down to none', () => {
    const before = note('a', { panels: [panel('p1')] })
    const prev = data({ notes: [before] })
    const p2 = panel('p2')
    expect(changes(prev, withNote(prev, { ...before, panels: [before.panels[0], p2] }))).toEqual([
      { type: 'panels', noteId: 'a', panels: [before.panels[0], p2] }
    ])
    expect(changes(prev, withNote(prev, { ...before, panels: [] }))).toEqual([
      { type: 'panels', noteId: 'a', panels: [] }
    ])
  })

  it('deletes notes that are gone and leaves the others alone', () => {
    const a = note('a')
    const b = note('b')
    const prev = data({ notes: [a, b] })
    expect(changes(prev, { ...prev, notes: [b] })).toEqual([{ type: 'note-delete', id: 'a' }])
  })

  it('saves nothing for notes that were only reordered', () => {
    const a = note('a')
    const b = note('b')
    const prev = data({ notes: [a, b] })
    expect(changes(prev, { ...prev, notes: [b, a] })).toEqual([])
  })

  it('saves folders, templates, recipes and settings when replaced', () => {
    const prev = data()
    const next = data({
      folders: [{ id: 'f', name: 'F', createdAt: '2026-01-01T10:00:00.000Z' }],
      templates: [],
      recipes: [],
      settings: { ...DEFAULT_SETTINGS }
    })
    expect(changes(prev, next).map((o) => o.type)).toEqual(['folders', 'templates', 'recipes', 'settings'])
  })
})
