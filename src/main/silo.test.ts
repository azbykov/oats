import Database from 'better-sqlite3-multiple-ciphers'
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILT_IN_RECIPES, BUILT_IN_TEMPLATES, DEFAULT_SETTINGS } from '../shared/defaults'
import type { Note, NoteRecord, Panel, Recipe, Template, TranscriptSegment } from '../shared/types'

// The silo's client (silo.ts) and the database behind it (silo/store.ts), joined without the
// process in between. Both keep module state (the connection, the unlocked API keys), so every
// test (and every simulated restart) imports fresh copies over a temporary userData folder.
const env = vi.hoisted(() => ({ dir: '', encryption: true, keychain: 'k1' }))

vi.mock('electron', () => ({
  app: { getPath: () => env.dir },
  utilityProcess: {},
  safeStorage: {
    isEncryptionAvailable: () => env.encryption,
    encryptString: (text: string) => Buffer.from(`${env.keychain}|${text}`),
    decryptString: (sealed: Buffer) => {
      const [keychain, ...rest] = sealed.toString().split('|')
      if (keychain !== env.keychain) throw new Error('Wrong keychain')
      return rest.join('|')
    }
  }
}))

type Store = typeof import('./silo')
let current: Store | undefined

/** Starts the app's store again over the same files, like quitting and reopening Oats. */
async function launch(): Promise<Store> {
  await current?.closeSilo()
  vi.resetModules()
  const { api } = await import('../silo/store')
  current = await import('./silo')
  // Requests and replies are copied on the way, as they are between the two processes.
  await current.startSilo(async (method, args) =>
    structuredClone((api[method] as (...a: unknown[]) => unknown)(...structuredClone(args)))
  )
  return current
}

/** The database key as the app saved it (sealed by the fake keychain), or null when there is none. */
function savedKey(): string | null {
  const file = join(env.dir, 'oats.key')
  if (!existsSync(file)) return null
  const [, ...sealed] = Buffer.from(readFileSync(file, 'utf8'), 'base64').toString().split('|')
  return JSON.parse(sealed.join('|'))
}

/** A separate connection to a database file, unlocked with the saved key if it is encrypted. */
function peek(name = 'oats.db') {
  const d = new Database(join(env.dir, name))
  const key = savedKey()
  if (key && !isPlain(name)) {
    d.pragma("cipher = 'sqlcipher'")
    d.pragma('legacy = 4')
    d.pragma(`key = "x'${key}'"`)
  }
  return d
}

const isPlain = (name = 'oats.db') => readFileSync(join(env.dir, name)).subarray(0, 15).toString() === 'SQLite format 3'

/** A value of the meta table, read through a separate connection. */
function meta(key: string) {
  const d = peek()
  try {
    return (d.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value
  } finally {
    d.close()
  }
}

beforeEach(() => {
  env.dir = mkdtempSync(join(tmpdir(), 'oats-store-'))
  env.encryption = true
  env.keychain = 'k1'
})

afterEach(async () => {
  await current?.closeSilo()
  current = undefined
  rmSync(env.dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const record = (id: string, patch: Partial<NoteRecord> = {}): NoteRecord => ({
  id,
  title: id,
  notesHtml: '',
  notesMarkdown: '',
  folderIds: [],
  attendees: [],
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
  ...patch
})

const seg = (id: string, text: string, start = 0, patch: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  id,
  speaker: 'them',
  text,
  start,
  end: start + 1000,
  ...patch
})

const panel = (id: string, html: string, patch: Partial<Panel> = {}): Panel => ({
  id,
  templateId: 'general',
  title: 'Notes',
  markdown: html,
  html,
  createdAt: '2026-01-01T11:00:00.000Z',
  ...patch
})

describe('notes', () => {
  it('starts empty with the built-in templates, recipes and default settings', async () => {
    const store = await launch()
    expect(await store.loadData()).toEqual({
      notes: [],
      folders: [],
      templates: BUILT_IN_TEMPLATES,
      recipes: BUILT_IN_RECIPES,
      settings: DEFAULT_SETTINGS
    })
  })

  it('reads back everything it saved, after a restart too', async () => {
    const full: Note = {
      ...record('a', {
        title: 'Planning',
        notesHtml: '<p>agenda</p>',
        notesMarkdown: 'agenda',
        folderIds: ['f2', 'f1'],
        attendees: [{ name: 'Anna', email: 'anna@example.com' }, { name: 'Boris' }],
        speakers: [{ id: 'sp1', name: 'Speaker 1', embedding: [0.25, -0.5] }],
        recordedMs: 12_345,
        calendarEventId: 'ev1',
        templateId: 'general',
        createdAt: '2026-01-02T10:00:00.000Z',
        deletedAt: '2026-01-03T10:00:00.000Z'
      }),
      transcript: [
        seg('s1', 'hello', 0, { speaker: 'me' }),
        seg('s2', 'hi there', 1500.5, { speakerId: 'sp1', words: [{ text: 'hi', start: 1500.5, end: 1700 }] })
      ],
      panels: [panel('p1', '<p>one</p>', { edited: true }), panel('p2', '<p>two</p>', { edited: false }), panel('p3', '')]
    }
    const bare: Note = { ...record('b'), transcript: [], panels: [] }
    const folders = [
      { id: 'f1', name: 'Work', icon: 'briefcase', createdAt: '2026-01-01T09:00:00.000Z' },
      { id: 'f2', name: 'Personal', createdAt: '2026-01-01T09:30:00.000Z' }
    ]

    let store = await launch()
    const { transcript, panels, ...rest } = full
    await store.applyOps([
      { type: 'folders', folders },
      { type: 'note', note: rest },
      { type: 'transcript-append', noteId: 'a', segments: transcript },
      { type: 'panels', noteId: 'a', panels },
      { type: 'note', note: record('b') }
    ])
    // Newest first.
    expect((await store.loadData()).notes).toEqual([full, bare])
    expect((await store.loadData()).folders).toEqual(folders)

    store = await launch()
    expect((await store.loadData()).notes).toEqual([full, bare])
    expect((await store.loadData()).folders).toEqual(folders)
  })

  it('updates a note in place and replaces its folder links', async () => {
    const store = await launch()
    await store.applyOps([{ type: 'note', note: record('a', { folderIds: ['f1', 'f2'] }) }])
    await store.applyOps([{ type: 'note', note: record('a', { title: 'Renamed', folderIds: ['f2'] }) }])
    const { notes } = await store.loadData()
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ title: 'Renamed', folderIds: ['f2'] })
  })

  it('appends transcript lines in order and replaces them all on request', async () => {
    const store = await launch()
    await store.applyOps([{ type: 'note', note: record('a') }])
    await store.applyOps([{ type: 'transcript-append', noteId: 'a', segments: [seg('s1', 'one')] }])
    await store.applyOps([{ type: 'transcript-append', noteId: 'a', segments: [seg('s2', 'two', 2000), seg('s3', 'three', 4000)] }])
    expect((await store.loadData()).notes[0].transcript.map((s) => s.id)).toEqual(['s1', 's2', 's3'])

    await store.applyOps([{ type: 'transcript-replace', noteId: 'a', segments: [seg('s9', 'only')] }])
    expect((await store.loadData()).notes[0].transcript.map((s) => s.id)).toEqual(['s9'])
    expect(await store.searchNotes('three')).toEqual([])
  })

  it('replaces the panels of one note without touching another', async () => {
    const store = await launch()
    await store.applyOps([
      { type: 'note', note: record('a') },
      { type: 'note', note: record('b') },
      { type: 'panels', noteId: 'a', panels: [panel('p1', '<p>a1</p>'), panel('p2', '<p>a2</p>')] },
      { type: 'panels', noteId: 'b', panels: [panel('p3', '<p>b1</p>')] }
    ])
    await store.applyOps([{ type: 'panels', noteId: 'a', panels: [panel('p2', '<p>a2</p>')] }])
    const byId = Object.fromEntries((await store.loadData()).notes.map((n) => [n.id, n.panels.map((p) => p.id)]))
    expect(byId).toEqual({ a: ['p2'], b: ['p3'] })
  })

  it('deletes a note with its transcript, panels, folder links and embeddings', async () => {
    const store = await launch()
    await store.applyOps([
      { type: 'note', note: record('a', { title: 'Quarterly review', folderIds: ['f1'] }) },
      { type: 'transcript-append', noteId: 'a', segments: [seg('s1', 'budget numbers')] },
      { type: 'panels', noteId: 'a', panels: [panel('p1', '<p>summary text</p>')] },
      { type: 'note', note: record('b', { title: 'Standup' }) }
    ])
    await store.saveChunks('a', 'h1', [{ noteId: 'a', kind: 'notes', text: 'x', vector: new Float32Array([1, 2]) }])
    await store.applyOps([{ type: 'note-delete', id: 'a' }])

    expect((await store.loadData()).notes.map((n) => n.id)).toEqual(['b'])
    expect(await store.loadChunks()).toEqual([])
    expect(await store.chunkHash('a')).toBeUndefined()
    expect(await store.noteForIndex('a')).toBeNull()
    for (const q of ['Quarterly', 'budget', 'summary']) expect(await store.searchNotes(q)).toEqual([])

    const d = peek()
    for (const table of ['transcript_segments', 'panels', 'note_folders', 'chunks', 'chunk_notes'])
      expect((d.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, table).toBe(0)
    d.close()
  })

  it('saves a batch all or nothing', async () => {
    const store = await launch()
    await store.applyOps([{ type: 'note', note: record('a', { title: 'Before' }) }])
    await expect(
      store.applyOps([
        { type: 'note', note: record('a', { title: 'After' }) },
        { type: 'note', note: record('b') },
        // No such note: the foreign key fails.
        { type: 'transcript-append', noteId: 'missing', segments: [seg('s1', 'lost')] }
      ])
    ).rejects.toThrow()
    const { notes } = await store.loadData()
    expect(notes.map((n) => [n.id, n.title])).toEqual([['a', 'Before']])
    // The store still works after the rollback.
    await store.applyOps([{ type: 'note', note: record('c') }])
    expect((await store.loadData()).notes).toHaveLength(2)
  })
})

describe('encryption', () => {
  const MARKER = 'a-phrase-nobody-else-should-read'
  const note = record('a', { title: MARKER, notesMarkdown: MARKER })
  const ops = [
    { type: 'note' as const, note },
    { type: 'transcript-append' as const, noteId: 'a', segments: [seg('s1', MARKER)] },
    { type: 'panels' as const, noteId: 'a', panels: [panel('p1', `<p>${MARKER}</p>`)] }
  ]
  /** Every file in the data folder, as bytes. */
  const files = () =>
    Object.fromEntries(readdirSync(env.dir).map((f) => [f, readFileSync(join(env.dir, f)).toString('latin1')]))

  /** Notes saved by a version from before encryption. */
  async function unencrypted() {
    env.encryption = false
    const store = await launch()
    await store.applyOps(ops)
    await store.closeSilo()
    current = undefined
    env.encryption = true
  }

  it('leaves no readable text in the data folder', async () => {
    const store = await launch()
    await store.applyOps(ops)
    // While it is open: the write-ahead log is on disk too.
    for (const [name, bytes] of Object.entries(files())) expect(bytes, name).not.toContain(MARKER)
    expect(isPlain()).toBe(false)
    await store.closeSilo()
    for (const [name, bytes] of Object.entries(files())) expect(bytes, name).not.toContain(MARKER)
    expect(await (await launch()).searchNotes(MARKER)).toEqual(['a'])
  })

  it('makes one key, seals it and keeps it', async () => {
    await launch()
    const key = savedKey()!
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(files()['oats.key']).not.toContain(key)
    await launch()
    expect(savedKey()).toBe(key)
  })

  it('encrypts a database from an older version and keeps the original as a backup', async () => {
    await unencrypted()
    expect(isPlain()).toBe(true)
    const original = readFileSync(join(env.dir, 'oats.db'))

    let store = await launch()
    const expected = [{ ...note, transcript: ops[1].segments, panels: ops[2].panels }]
    expect((await store.loadData()).notes).toEqual(expected)
    expect(await store.searchNotes(MARKER)).toEqual(['a'])
    expect(isPlain()).toBe(false)
    expect(files()['oats.db']).not.toContain(MARKER)
    expect(readFileSync(join(env.dir, 'oats-unencrypted.db.bak')).equals(original)).toBe(true)
    expect(existsSync(join(env.dir, 'oats.db.encrypting'))).toBe(false)

    // And it keeps working: saved again, restarted, read back.
    await store.applyOps([{ type: 'note', note: record('b') }])
    store = await launch()
    expect((await store.loadData()).notes.map((n) => n.id).sort()).toEqual(['a', 'b'])
  })

  it('starts over when it was stopped just before the encrypted copy took the original’s place', async () => {
    await unencrypted()
    renameSync(join(env.dir, 'oats.db'), join(env.dir, 'oats-unencrypted.db.bak'))
    writeFileSync(join(env.dir, 'oats.db.encrypting'), 'half-written')
    const store = await launch()
    expect((await store.loadData()).notes.map((n) => n.title)).toEqual([MARKER])
    expect(isPlain()).toBe(false)
    expect(isPlain('oats-unencrypted.db.bak')).toBe(true)
    expect(existsSync(join(env.dir, 'oats.db.encrypting'))).toBe(false)
  })

  it('removes the unencrypted backup two weeks later, not before', async () => {
    await unencrypted()
    await launch()
    const backup = join(env.dir, 'oats-unencrypted.db.bak')
    const setEncryptedAt = (daysAgo: number) => {
      const d = peek()
      d.prepare("UPDATE meta SET value = ? WHERE key = 'encrypted-at'").run(new Date(Date.now() - daysAgo * 86_400_000).toISOString())
      d.close()
    }
    setEncryptedAt(13)
    await launch()
    expect(existsSync(backup)).toBe(true)
    setEncryptedAt(15)
    const store = await launch()
    expect(existsSync(backup)).toBe(false)
    expect((await store.loadData()).notes).toHaveLength(1)
  })

  it('does not open, and changes nothing, when the key was sealed by another keychain', async () => {
    const store = await launch()
    await store.applyOps(ops)
    await store.closeSilo()
    current = undefined
    const before = files()

    env.keychain = 'k2'
    await expect(launch()).rejects.toThrow('keychain')
    expect(files()).toEqual(before)

    env.keychain = 'k1'
    expect((await (await launch()).loadData()).notes).toHaveLength(1)
  })

  it('does not open, and leaves the database alone, when its key file is gone', async () => {
    const store = await launch()
    await store.applyOps(ops)
    await store.closeSilo()
    current = undefined
    const database = readFileSync(join(env.dir, 'oats.db'))
    rmSync(join(env.dir, 'oats.key'))

    await expect(launch()).rejects.toThrow()
    expect(readFileSync(join(env.dir, 'oats.db')).equals(database)).toBe(true)
    expect(existsSync(join(env.dir, 'oats-unencrypted.db.bak'))).toBe(false)
  })

  it('stays unencrypted on a computer without a keychain', async () => {
    env.encryption = false
    const store = await launch()
    await store.applyOps(ops)
    expect(isPlain()).toBe(true)
    expect(savedKey()).toBeNull()
    expect((await (await launch()).loadData()).notes).toHaveLength(1)
  })
})

describe('a database that cannot be used', () => {
  it('leaves a file it cannot open exactly as it is', async () => {
    const file = join(env.dir, 'oats.db')
    const damaged = Buffer.from('not a database, but possibly someone’s notes'.repeat(100))
    writeFileSync(file, damaged)
    await expect(launch()).rejects.toThrow()
    expect(readFileSync(file).equals(damaged)).toBe(true)
  })

  it('takes back settings and templates that could not be saved', async () => {
    const store = await launch()
    const before = { ...store.state }
    const mine: Template = { id: 'mine', title: 'Mine', description: '', sections: [] }
    await expect(
      store.applyOps([
        { type: 'settings', settings: { ...DEFAULT_SETTINGS, userName: 'Anna' } },
        { type: 'templates', templates: [...BUILT_IN_TEMPLATES, mine] },
        // No such note: the foreign key fails, and the whole batch with it.
        { type: 'transcript-append', noteId: 'missing', segments: [seg('s1', 'lost')] }
      ])
    ).rejects.toThrow()
    expect(store.state).toEqual(before)
    expect((await store.loadData()).settings).toEqual(DEFAULT_SETTINGS)
  })

  it('refuses requests once it is closed', async () => {
    const store = await launch()
    await store.closeSilo()
    await expect(store.loadData()).rejects.toThrow('closed')
    await expect(store.applyOps([{ type: 'note', note: record('a') }])).rejects.toThrow('closed')
  })
})

describe('folders, templates and recipes', () => {
  it('keeps the order given and drops folders that were removed', async () => {
    const store = await launch()
    const f = (id: string) => ({ id, name: id, createdAt: '2026-01-01T09:00:00.000Z' })
    await store.applyOps([{ type: 'folders', folders: [f('a'), f('b'), f('c')] }])
    await store.applyOps([{ type: 'folders', folders: [f('c'), { ...f('a'), name: 'renamed' }] }])
    expect((await store.loadData()).folders.map((x) => [x.id, x.name])).toEqual([
      ['c', 'c'],
      ['a', 'renamed']
    ])
  })

  it('stores only the user’s own templates and recipes, after the built-in ones', async () => {
    const mine: Template = { id: 'mine', title: 'Mine', description: '', sections: [{ heading: 'H', instructions: 'I' }] }
    const recipe: Recipe = { id: 'r', slug: 'r', title: 'R', prompt: 'do it' }
    let store = await launch()
    await store.applyOps([
      { type: 'templates', templates: [...BUILT_IN_TEMPLATES, mine] },
      { type: 'recipes', recipes: [...BUILT_IN_RECIPES, recipe] }
    ])
    expect(store.state.templates).toEqual([...BUILT_IN_TEMPLATES, mine])

    store = await launch()
    const data = await store.loadData()
    expect(data.templates).toEqual([...BUILT_IN_TEMPLATES, mine])
    expect(data.recipes).toEqual([...BUILT_IN_RECIPES, recipe])
    expect(store.state.templates).toEqual(data.templates)
  })
})

describe('searchNotes', () => {
  async function seeded() {
    const store = await launch()
    await store.applyOps([
      { type: 'note', note: record('title', { title: 'Roadmap planning' }) },
      { type: 'note', note: record('body', { notesMarkdown: 'Discuss the hiring roadmap with Anna' }) },
      { type: 'note', note: record('panel') },
      { type: 'panels', noteId: 'panel', panels: [panel('p1', '<p>Action: update the <b>roadmap</b> &amp; budget</p>')] },
      { type: 'note', note: record('speech') },
      { type: 'transcript-append', noteId: 'speech', segments: [seg('s1', 'Обсудили бюджет и "план" на квартал')] },
      { type: 'note', note: record('other', { title: 'Lunch' }) }
    ])
    return store
  }

  it('finds a word in the title, the notes, generated notes and the transcript', async () => {
    const store = await seeded()
    expect((await store.searchNotes('roadmap')).sort()).toEqual(['body', 'panel', 'title'])
    expect(await store.searchNotes('бюджет')).toEqual(['speech'])
  })

  it('ignores case, in Cyrillic too, and matches inside words', async () => {
    const store = await seeded()
    expect((await store.searchNotes('ROADMAP')).sort()).toEqual(['body', 'panel', 'title'])
    expect(await store.searchNotes('БЮДЖЕТ')).toEqual(['speech'])
    expect((await store.searchNotes('oadma')).sort()).toEqual(['body', 'panel', 'title'])
  })

  it('requires every word of the query within one field', async () => {
    const store = await seeded()
    expect(await store.searchNotes('hiring roadmap')).toEqual(['body'])
    expect(await store.searchNotes('roadmap lunch')).toEqual([])
  })

  it('searches the text of generated notes, not their markup', async () => {
    const store = await seeded()
    expect(await store.searchNotes('roadmap & budget')).toEqual(['panel'])
    expect(await store.searchNotes('<b>')).toEqual([])
  })

  it('drops terms shorter than three characters and returns nothing when none are left', async () => {
    const store = await seeded()
    expect(await store.searchNotes('')).toEqual([])
    expect(await store.searchNotes('  an  ')).toEqual([])
    expect(await store.searchNotes('an Anna')).toEqual(['body'])
  })

  it('takes quotes and query syntax literally', async () => {
    const store = await seeded()
    expect(await store.searchNotes('"план"')).toEqual(['speech'])
    await expect(store.searchNotes('"unbalanced')).resolves.toEqual([])
    expect(await store.searchNotes('roadmap* OR NOT')).toEqual([])
  })

  it('follows edits to a note', async () => {
    const store = await seeded()
    await store.applyOps([{ type: 'note', note: record('title', { title: 'Retrospective' }) }])
    expect(await store.searchNotes('planning')).toEqual([])
    expect(await store.searchNotes('Retrospective')).toEqual(['title'])
  })
})

describe('embeddings', () => {
  it('reads back the passages and vectors it saved', async () => {
    const store = await launch()
    await store.applyOps([{ type: 'note', note: record('a') }])
    const chunks = [
      { noteId: 'a', kind: 'notes' as const, text: 'intro', vector: new Float32Array([0.1, -0.2, 0.3]) },
      { noteId: 'a', kind: 'transcript' as const, startMs: 0, endMs: 2500, text: 'said', vector: new Float32Array([1, 2, 3]) }
    ]
    await store.saveChunks('a', 'h1', chunks)
    expect(await store.loadChunks()).toEqual(chunks)
    expect(await store.chunkHash('a')).toBe('h1')
    expect(await store.indexStats()).toEqual({ indexed: 1, total: 1 })
  })

  it('saves a vector that is a view into a larger buffer', async () => {
    const store = await launch()
    await store.applyOps([{ type: 'note', note: record('a') }])
    const all = new Float32Array([9, 9, 1, 2, 3, 9])
    await store.saveChunks('a', 'h1', [{ noteId: 'a', kind: 'notes', text: 't', vector: all.subarray(2, 5) }])
    expect([...(await store.loadChunks())[0].vector]).toEqual([1, 2, 3])
  })

  it('replaces the passages of a note when it is indexed again', async () => {
    const store = await launch()
    await store.applyOps([{ type: 'note', note: record('a') }])
    const chunk = (text: string) => ({ noteId: 'a', kind: 'notes' as const, text, vector: new Float32Array([1]) })
    await store.saveChunks('a', 'h1', [chunk('old 1'), chunk('old 2')])
    await store.saveChunks('a', 'h2', [chunk('new')])
    expect((await store.loadChunks()).map((c) => c.text)).toEqual(['new'])
    expect(await store.chunkHash('a')).toBe('h2')
  })

  it('saves nothing for a note deleted while it was being embedded', async () => {
    const store = await launch()
    await store.saveChunks('gone', 'h1', [{ noteId: 'gone', kind: 'notes', text: 't', vector: new Float32Array([1]) }])
    expect(await store.loadChunks()).toEqual([])
    expect(await store.chunkHash('gone')).toBeUndefined()
  })

  it('clears every embedding', async () => {
    const store = await launch()
    await store.applyOps([{ type: 'note', note: record('a') }])
    await store.saveChunks('a', 'h1', [{ noteId: 'a', kind: 'notes', text: 't', vector: new Float32Array([1]) }])
    await store.clearChunks()
    expect(await store.loadChunks()).toEqual([])
    expect(await store.indexStats()).toEqual({ indexed: 0, total: 1 })
  })

  it('gives semantic search a note’s text, generated notes and transcript', async () => {
    const store = await launch()
    await store.applyOps([
      { type: 'note', note: record('a', { title: 'T', notesMarkdown: 'md', speakers: [{ id: 'sp1', name: 'Anna', embedding: [1] }] }) },
      { type: 'panels', noteId: 'a', panels: [panel('p1', '<p>first</p><p>second</p>')] },
      { type: 'transcript-append', noteId: 'a', segments: [seg('s1', 'hello', 100, { speakerId: 'sp1' })] }
    ])
    expect(await store.noteForIndex('a')).toEqual({
      title: 'T',
      notesMarkdown: 'md',
      speakers: [{ id: 'sp1', name: 'Anna', embedding: [1] }],
      panels: [' first\n second\n'],
      segments: [{ speaker: 'them', speaker_id: 'sp1', text: 'hello', start_ms: 100, end_ms: 1100 }]
    })
  })
})

describe('import of the old JSON file', () => {
  const legacyFile = () => join(env.dir, 'oats-data.json')
  const legacy = {
    notes: [
      {
        id: 'old',
        title: 'Old note',
        notesHtml: '<p>x</p>',
        notesMarkdown: 'x',
        transcript: [seg('s1', 'legacy words')],
        panels: [panel('p1', '<p>legacy panel</p>')],
        createdAt: '2025-06-01T10:00:00.000Z',
        updatedAt: '2025-06-01T10:00:00.000Z'
      }
    ],
    folders: [{ id: 'f1', name: 'Work', createdAt: '2025-06-01T09:00:00.000Z' }],
    templates: [{ id: 'mine', title: 'Mine', description: '', sections: [] }],
    settings: { detectMeetings: !DEFAULT_SETTINGS.detectMeetings }
  }

  it('imports the file once and keeps it as a backup', async () => {
    writeFileSync(legacyFile(), JSON.stringify(legacy))
    let store = await launch()
    let data = await store.loadData()
    expect(data.notes).toHaveLength(1)
    expect(data.notes[0]).toMatchObject({ id: 'old', title: 'Old note', folderIds: [], attendees: [] })
    expect(data.notes[0].transcript).toEqual(legacy.notes[0].transcript)
    expect(data.notes[0].panels).toEqual(legacy.notes[0].panels)
    expect(data.folders).toEqual(legacy.folders)
    expect(data.templates.at(-1)).toEqual(legacy.templates[0])
    expect(data.settings).toEqual({ ...DEFAULT_SETTINGS, ...legacy.settings })
    expect(await store.searchNotes('legacy words')).toEqual(['old'])
    expect(existsSync(legacyFile())).toBe(false)
    expect(JSON.parse(readFileSync(`${legacyFile()}.bak`, 'utf8'))).toEqual(legacy)

    // A file that shows up again later is not imported over the database.
    await store.applyOps([{ type: 'note-delete', id: 'old' }])
    writeFileSync(legacyFile(), JSON.stringify(legacy))
    store = await launch()
    data = await store.loadData()
    expect(data.notes).toEqual([])
    expect(existsSync(legacyFile())).toBe(true)
  })

  it('starts empty when the file is damaged, leaving it in place', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFileSync(legacyFile(), '{"notes": [')
    const store = await launch()
    expect((await store.loadData()).notes).toEqual([])
    expect(existsSync(legacyFile())).toBe(true)
    await store.applyOps([{ type: 'note', note: record('a') }])
    expect((await store.loadData()).notes).toHaveLength(1)
  })
})

describe('settings and API keys', () => {
  const KEYS = { anthropicApiKey: 'sk-ant-SECRET', openaiApiKey: 'sk-openai-SECRET', deepgramApiKey: 'dg-SECRET' }
  const NO_KEYS = { anthropicApiKey: '', openaiApiKey: '', deepgramApiKey: '' }
  const flipped = { detectMeetings: !DEFAULT_SETTINGS.detectMeetings }

  /** The database as bytes on disk (main file and write-ahead log), to look for leaked keys. */
  const onDisk = () =>
    ['oats.db', 'oats.db-wal']
      .map((f) => join(env.dir, f))
      .filter((f) => existsSync(f))
      .map((f) => readFileSync(f).toString('latin1'))
      .join('')

  /** What a version before encrypted keys left behind: the keys inside the settings JSON. */
  async function oldVersionWithKeys() {
    env.encryption = false
    const store = await launch()
    await store.loadData()
    await store.unlockSecrets()
    await store.updateSettings({ ...KEYS, ...flipped })
    env.encryption = true
  }

  it('merges a patch into the settings and keeps it across restarts', async () => {
    let store = await launch()
    await store.loadData()
    await store.unlockSecrets()
    await store.updateSettings(flipped)
    expect(store.state.settings).toEqual({ ...DEFAULT_SETTINGS, ...flipped })
    store = await launch()
    expect((await store.loadData()).settings).toEqual({ ...DEFAULT_SETTINGS, ...flipped })
  })

  it('fills in defaults for settings added since the file was written', async () => {
    let store = await launch()
    await store.loadData()
    const d = peek()
    d.prepare("INSERT INTO meta (key, value) VALUES ('settings', ?)").run(JSON.stringify(flipped))
    d.close()
    store = await launch()
    expect((await store.loadData()).settings).toEqual({ ...DEFAULT_SETTINGS, ...flipped })
  })

  it('keeps API keys encrypted, out of the settings JSON', async () => {
    let store = await launch()
    await store.loadData()
    await store.unlockSecrets()
    await store.applyOps([{ type: 'settings', settings: { ...DEFAULT_SETTINGS, ...KEYS } }])
    expect(store.state.settings).toMatchObject(KEYS)

    const saved = JSON.parse(meta('settings')!)
    for (const k of Object.keys(KEYS)) expect(saved).not.toHaveProperty(k)
    expect(Object.keys(saved).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).filter((k) => !(k in KEYS)).sort())
    expect(meta('secrets')).toBeTruthy()

    // After a restart the keys are missing until the keychain can be used, then they are back.
    store = await launch()
    expect((await store.loadData()).settings).toMatchObject(NO_KEYS)
    await store.unlockSecrets()
    expect(store.state.settings).toMatchObject(KEYS)
    expect((await store.loadData()).settings).toEqual({ ...DEFAULT_SETTINGS, ...KEYS })
  })

  it('moves plaintext keys from an older version into the encrypted row', async () => {
    await oldVersionWithKeys()
    expect(JSON.parse(meta('settings')!)).toMatchObject(KEYS)
    expect(onDisk()).toContain(KEYS.anthropicApiKey)

    const store = await launch()
    expect((await store.loadData()).settings).toMatchObject(KEYS)
    await store.unlockSecrets()
    expect(store.state.settings).toEqual({ ...DEFAULT_SETTINGS, ...KEYS, ...flipped })
    const saved = JSON.parse(meta('settings')!)
    for (const k of Object.keys(KEYS)) expect(saved).not.toHaveProperty(k)
    expect(saved).toMatchObject(flipped)
  })

  it('leaves no plaintext key anywhere in the database files after the move', async () => {
    await oldVersionWithKeys()
    const store = await launch()
    await store.loadData()
    await store.unlockSecrets()
    await store.closeSilo()
    current = undefined
    // The fake keychain "encrypts" as `<keychain>|<json>`, so a sealed key is not plaintext here either.
    const bytes = onDisk()
    for (const key of Object.values(KEYS)) expect(bytes).not.toContain(key)
  })

  it('does not lose the keys when settings are saved before the keychain is unlocked', async () => {
    let store = await launch()
    await store.loadData()
    await store.unlockSecrets()
    await store.updateSettings(KEYS)

    store = await launch()
    await store.loadData()
    // A setting saved while the keychain is still locked.
    await store.updateSettings(flipped)
    await store.unlockSecrets()
    expect(store.state.settings).toEqual({ ...DEFAULT_SETTINGS, ...KEYS, ...flipped })

    store = await launch()
    await store.loadData()
    await store.unlockSecrets()
    expect(store.state.settings).toEqual({ ...DEFAULT_SETTINGS, ...KEYS, ...flipped })
  })

  it('clears a key the user removed', async () => {
    let store = await launch()
    await store.loadData()
    await store.unlockSecrets()
    await store.updateSettings(KEYS)
    await store.updateSettings({ openaiApiKey: '' })
    store = await launch()
    await store.loadData()
    await store.unlockSecrets()
    expect(store.state.settings).toMatchObject({ ...KEYS, openaiApiKey: '' })
  })

  it('unlocks once: a second call changes nothing', async () => {
    const store = await launch()
    await store.loadData()
    await store.unlockSecrets()
    await store.updateSettings(KEYS)
    const sealed = meta('secrets')
    await store.unlockSecrets()
    expect(meta('secrets')).toBe(sealed)
    expect(store.state.settings).toMatchObject(KEYS)
  })

  it('asks for the keys again when they were sealed by another keychain', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let store = await launch()
    await store.loadData()
    await store.unlockSecrets()
    await store.updateSettings({ ...KEYS, ...flipped })

    // The database key made it to the new keychain (sealed again here); the API keys did not.
    const key = savedKey()
    env.keychain = 'k2'
    writeFileSync(join(env.dir, 'oats.key'), Buffer.from(`k2|${JSON.stringify(key)}`).toString('base64'))
    store = await launch()
    await store.loadData()
    await expect(store.unlockSecrets()).resolves.toBeUndefined()
    expect(error).toHaveBeenCalled()
    expect(store.state.settings).toEqual({ ...DEFAULT_SETTINGS, ...flipped })

    // New keys can be saved and read with the new keychain.
    await store.updateSettings({ anthropicApiKey: 'sk-new' })
    store = await launch()
    await store.loadData()
    await store.unlockSecrets()
    expect(store.state.settings).toMatchObject({ ...NO_KEYS, anthropicApiKey: 'sk-new' })
  })

  it('keeps working without a keychain, saving the keys as before', async () => {
    env.encryption = false
    let store = await launch()
    await store.loadData()
    await store.unlockSecrets()
    await store.updateSettings(KEYS)
    expect(meta('secrets')).toBeUndefined()

    store = await launch()
    expect((await store.loadData()).settings).toEqual({ ...DEFAULT_SETTINGS, ...KEYS })
    await store.unlockSecrets()
    expect(store.state.settings).toEqual({ ...DEFAULT_SETTINGS, ...KEYS })
  })
})
