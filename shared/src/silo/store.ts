import Database from 'better-sqlite3-multiple-ciphers'
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AppData,
  DataOp,
  Folder,
  Note,
  NoteRecord,
  Panel,
  Recipe,
  Settings,
  Template,
  TranscriptSegment
} from '../common/types'
import { withoutSecrets, type Defaults, type SiloApi, type StoredChunk } from './api'

// The database itself, run inside the silo process (index.ts) and nowhere else.
// SQLite in WAL mode, encrypted as a whole with SQLCipher (better-sqlite3-multiple-ciphers):
// the file, its write-ahead log and the search indexes hold no readable text. The key comes
// from the main process, which keeps it in the OS keychain.
// The renderer keeps the data in memory and sends each change as a DataOp; transcript lines
// are rows of their own, so live transcription appends one row instead of rewriting a file.
// FTS5 trigram indexes back full-text search in any language.

let dir = ''
/** 64 hex digits, or null on a computer without a keychain: the database is then left unencrypted. */
let key: string | null = null
/** The app's default settings and built-in templates and recipes, given with open(). */
let defaults: Defaults = { settings: {} as Settings, templates: [], recipes: [] }
const dbFile = () => join(dir, 'oats.db')
/** The database as it was before it was encrypted; removed BACKUP_DAYS later. */
const backupFile = () => join(dir, 'oats-unencrypted.db.bak')
const BACKUP_DAYS = 14
const legacyFile = () => join(dir, 'oats-data.json')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS notes (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  notes_html TEXT NOT NULL,
  notes_markdown TEXT NOT NULL,
  attendees TEXT NOT NULL,
  speakers TEXT,
  recorded_ms INTEGER,
  calendar_event_id TEXT,
  template_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS notes_created ON notes (created_at DESC);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  icon TEXT,
  created_at TEXT NOT NULL
);

-- No foreign key to folders: the renderer drops a deleted folder from its notes itself.
CREATE TABLE IF NOT EXISTS note_folders (
  note_id TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (note_id, folder_id)
);
CREATE INDEX IF NOT EXISTS note_folders_folder ON note_folders (folder_id);

CREATE TABLE IF NOT EXISTS panels (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  note_id TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  template_id TEXT NOT NULL,
  title TEXT NOT NULL,
  markdown TEXT NOT NULL,
  html TEXT NOT NULL,
  text TEXT NOT NULL,
  edited INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS panels_note ON panels (note_id, position);

CREATE TABLE IF NOT EXISTS transcript_segments (
  seq INTEGER PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  speaker TEXT NOT NULL,
  speaker_id TEXT,
  text TEXT NOT NULL,
  start_ms REAL NOT NULL,
  end_ms REAL NOT NULL,
  words TEXT
);
CREATE INDEX IF NOT EXISTS segments_note ON transcript_segments (note_id, seq);

-- Passages of each note with their embedding (semantic.ts); chunk_notes records which
-- version of a note they were made from, so unchanged notes aren't embedded again.
CREATE TABLE IF NOT EXISTS chunks (
  seq INTEGER PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  start_ms REAL,
  end_ms REAL,
  text TEXT NOT NULL,
  vector BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_note ON chunks (note_id);
CREATE TABLE IF NOT EXISTS chunk_notes (
  note_id TEXT PRIMARY KEY REFERENCES notes (id) ON DELETE CASCADE,
  hash TEXT NOT NULL
);

-- Templates and recipes the user made; the built-in ones come from the app.
CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recipes (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5 (
  title, notes_markdown, content = 'notes', content_rowid = 'seq', tokenize = 'trigram case_sensitive 0'
);
CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts (rowid, title, notes_markdown) VALUES (new.seq, new.title, new.notes_markdown);
END;
CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, title, notes_markdown) VALUES ('delete', old.seq, old.title, old.notes_markdown);
END;
CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes
WHEN old.title IS NOT new.title OR old.notes_markdown IS NOT new.notes_markdown BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, title, notes_markdown) VALUES ('delete', old.seq, old.title, old.notes_markdown);
  INSERT INTO notes_fts (rowid, title, notes_markdown) VALUES (new.seq, new.title, new.notes_markdown);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS panels_fts USING fts5 (
  text, content = 'panels', content_rowid = 'seq', tokenize = 'trigram case_sensitive 0'
);
CREATE TRIGGER IF NOT EXISTS panels_fts_insert AFTER INSERT ON panels BEGIN
  INSERT INTO panels_fts (rowid, text) VALUES (new.seq, new.text);
END;
CREATE TRIGGER IF NOT EXISTS panels_fts_delete AFTER DELETE ON panels BEGIN
  INSERT INTO panels_fts (panels_fts, rowid, text) VALUES ('delete', old.seq, old.text);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5 (
  text, content = 'transcript_segments', content_rowid = 'seq', tokenize = 'trigram case_sensitive 0'
);
CREATE TRIGGER IF NOT EXISTS segments_fts_insert AFTER INSERT ON transcript_segments BEGIN
  INSERT INTO segments_fts (rowid, text) VALUES (new.seq, new.text);
END;
CREATE TRIGGER IF NOT EXISTS segments_fts_delete AFTER DELETE ON transcript_segments BEGIN
  INSERT INTO segments_fts (segments_fts, rowid, text) VALUES ('delete', old.seq, old.text);
END;
`

type Db = Database.Database
let db: Db | undefined

/**
 * Opens the database in the given userData folder. A file that can't be opened is left
 * exactly as it is and the error goes back to the main process: this is the only copy of
 * the notes, so nothing here ever deletes or recreates it.
 */
function openStore(userData: string, withKey: string | null, appDefaults: Defaults) {
  if (withKey !== null && !/^[0-9a-f]{64}$/.test(withKey)) throw new Error('The database key is not valid.')
  closeStore()
  dir = userData
  key = withKey
  defaults = appDefaults
  open()
}

/** A connection to `file`, unlocked with `k`. Throws before writing anything if that isn't possible. */
function connect(file: string, k: string | null) {
  const d = new Database(file)
  try {
    if (k) {
      // SQLCipher 4's format, so the file can also be opened with the sqlcipher tools.
      d.pragma("cipher = 'sqlcipher'")
      d.pragma('legacy = 4')
      d.pragma(`key = "x'${k}'"`)
    }
    // The first read: fails on a wrong key, a missing key or a file that isn't a database.
    d.prepare('SELECT count(*) FROM sqlite_master').get()
    return d
  } catch (err) {
    d.close()
    throw err
  }
}

/** Whether `file` is a database that isn't encrypted (those start with a fixed header). */
function isPlain(file: string) {
  const head = Buffer.alloc(16)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, head, 0, 16, 0)
  } finally {
    closeSync(fd)
  }
  return head.toString('latin1') === 'SQLite format 3\0'
}

const rowCounts = (d: Db) =>
  (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => `${name}=${(d.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n}`)
    .join(' ')

/**
 * One-time move of a database from before encryption. An encrypted copy is made and checked
 * against the original; only then does it take the original's place. The original is never
 * rewritten or deleted here: it is renamed to oats-unencrypted.db.bak.
 */
function encrypt(file: string, k: string) {
  const copy = `${file}.encrypting`
  rmSync(copy, { force: true })
  const plain = connect(file, null)
  let before: string
  try {
    // What is still in the write-ahead log goes into the file first.
    plain.pragma('wal_checkpoint(TRUNCATE)')
    before = rowCounts(plain)
    // Copies the pages into a new file; the original is only read.
    plain.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`)
  } finally {
    plain.close()
  }
  // Closing the last connection removes the log. One that is still there belongs to another
  // connection, whose changes the copy may have missed.
  if (existsSync(`${file}-wal`) && statSync(`${file}-wal`).size > 0) {
    rmSync(copy, { force: true })
    throw new Error('The database is in use, so it could not be encrypted.')
  }
  const sealing = connect(copy, null)
  try {
    sealing.pragma("cipher = 'sqlcipher'")
    sealing.pragma('legacy = 4')
    sealing.pragma(`rekey = "x'${k}'"`)
  } finally {
    sealing.close()
  }

  const check = connect(copy, k)
  try {
    const integrity = check.pragma('integrity_check', { simple: true })
    if (integrity !== 'ok') throw new Error(`The encrypted copy of the database is damaged (${integrity}).`)
    if (rowCounts(check) !== before) throw new Error('The encrypted copy of the database is incomplete.')
  } catch (err) {
    check.close()
    rmSync(copy, { force: true })
    throw err
  }
  check.close()
  const fd = openSync(copy, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }

  rmSync(backupFile(), { force: true })
  renameSync(file, backupFile())
  renameSync(copy, file)
  for (const suffix of ['-wal', '-shm']) rmSync(file + suffix, { force: true })
}

function open() {
  if (db) return db
  if (!dir) throw new Error('The database was not opened.')
  const file = dbFile()
  // Stopped between the two renames at the end of encrypt(): put the original back and start over.
  if (!existsSync(file) && existsSync(backupFile()) && existsSync(`${file}.encrypting`)) renameSync(backupFile(), file)
  let encrypted: string | undefined
  if (key && existsSync(file) && statSync(file).size > 0 && isPlain(file)) {
    encrypt(file, key)
    encrypted = new Date().toISOString()
  }
  const d = connect(file, key)
  try {
    d.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;')
    d.exec(SCHEMA)
    db = d
    if (encrypted) putMeta('encrypted-at', encrypted)
    importLegacyJson(d)
    dropOldBackup(d)
  } catch (err) {
    db = undefined
    d.close()
    throw err
  }
  return d
}

/** The unencrypted backup is a safety net for the first BACKUP_DAYS days, then it goes. */
function dropOldBackup(d: Db) {
  if (!existsSync(backupFile())) return
  const row = d.prepare("SELECT value FROM meta WHERE key = 'encrypted-at'").get() as { value: string } | undefined
  if (row && Date.now() - Date.parse(row.value) > BACKUP_DAYS * 24 * 3600_000) rmSync(backupFile(), { force: true })
}

function transaction(fn: () => void) {
  const d = open()
  d.exec('BEGIN')
  try {
    fn()
    d.exec('COMMIT')
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  }
}

// SQLite binds neither undefined nor booleans.
const val = (v: unknown) => (v === undefined || v === null ? null : typeof v === 'boolean' ? Number(v) : v)
const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v))
const parse = <T>(s: unknown, fallback: T): T => (typeof s === 'string' ? (JSON.parse(s) as T) : fallback)
const htmlText = (html: string) =>
  html
    .replace(/<\/(p|li|h\d)>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')

function putNote(n: NoteRecord) {
  const d = open()
  d.prepare(
    `INSERT INTO notes (id, title, notes_html, notes_markdown, attendees, speakers, recorded_ms, calendar_event_id,
       template_id, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET title = excluded.title, notes_html = excluded.notes_html,
       notes_markdown = excluded.notes_markdown, attendees = excluded.attendees, speakers = excluded.speakers,
       recorded_ms = excluded.recorded_ms, calendar_event_id = excluded.calendar_event_id,
       template_id = excluded.template_id, created_at = excluded.created_at, updated_at = excluded.updated_at,
       deleted_at = excluded.deleted_at`
  ).run(
    n.id,
    n.title,
    n.notesHtml,
    n.notesMarkdown,
    JSON.stringify(n.attendees),
    json(n.speakers),
    val(n.recordedMs),
    val(n.calendarEventId),
    val(n.templateId),
    n.createdAt,
    n.updatedAt,
    val(n.deletedAt)
  )
  d.prepare('DELETE FROM note_folders WHERE note_id = ?').run(n.id)
  const link = d.prepare('INSERT OR IGNORE INTO note_folders (note_id, folder_id, position) VALUES (?, ?, ?)')
  n.folderIds.forEach((f, i) => link.run(n.id, f, i))
}

function appendSegments(noteId: string, segments: TranscriptSegment[]) {
  const insert = open().prepare(
    `INSERT INTO transcript_segments (note_id, id, speaker, speaker_id, text, start_ms, end_ms, words)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const s of segments)
    insert.run(noteId, s.id, s.speaker, val(s.speakerId), s.text, s.start, s.end, json(s.words))
}

function putPanels(noteId: string, panels: Panel[]) {
  const d = open()
  d.prepare('DELETE FROM panels WHERE note_id = ?').run(noteId)
  const insert = d.prepare(
    `INSERT INTO panels (id, note_id, position, template_id, title, markdown, html, text, edited, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  panels.forEach((p, i) =>
    insert.run(p.id, noteId, i, p.templateId, p.title, p.markdown, p.html, htmlText(p.html), val(p.edited), p.createdAt)
  )
}

function putFolders(folders: Folder[]) {
  const d = open()
  d.prepare('DELETE FROM folders WHERE id NOT IN (SELECT value FROM json_each(?))').run(
    JSON.stringify(folders.map((f) => f.id))
  )
  const upsert = d.prepare(
    `INSERT INTO folders (id, position, name, icon, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET position = excluded.position, name = excluded.name, icon = excluded.icon`
  )
  folders.forEach((f, i) => upsert.run(f.id, i, f.name, val(f.icon), f.createdAt))
}

function putList(table: 'templates' | 'recipes', items: (Template | Recipe)[]) {
  const d = open()
  d.exec(`DELETE FROM ${table}`)
  const insert = d.prepare(`INSERT INTO ${table} (id, position, data) VALUES (?, ?, ?)`)
  items.filter((t) => !t.builtIn).forEach((t, i) => insert.run(t.id, i, JSON.stringify(t)))
}

function putMeta(key: string, value: string) {
  open()
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}

// API keys are kept out of the settings JSON, in a `secrets` row the main process encrypts
// with the OS keychain (main/silo.ts). With `sealed` the keys are saved there and left out
// of the JSON; without it (no keychain yet, or none at all) the settings are saved whole.
function putSettings(settings: Settings, sealed?: string) {
  if (sealed === undefined) return putMeta('settings', JSON.stringify(settings))
  putMeta('secrets', sealed)
  putMeta('settings', JSON.stringify(withoutSecrets(settings)))
}

function apply(op: DataOp, sealed?: string) {
  const d = open()
  switch (op.type) {
    case 'note':
      return putNote(op.note)
    case 'note-delete':
      // Panels, transcript lines and folder links go with it (ON DELETE CASCADE).
      return d.prepare('DELETE FROM notes WHERE id = ?').run(op.id)
    case 'transcript-append':
      return appendSegments(op.noteId, op.segments)
    case 'transcript-replace':
      d.prepare('DELETE FROM transcript_segments WHERE note_id = ?').run(op.noteId)
      return appendSegments(op.noteId, op.segments)
    case 'panels':
      return putPanels(op.noteId, op.panels)
    case 'folders':
      return putFolders(op.folders)
    case 'templates':
      return putList('templates', op.templates)
    case 'recipes':
      return putList('recipes', op.recipes)
    case 'settings':
      return putSettings(op.settings, sealed)
  }
}

/** Saves a batch of changes from the renderer, all or nothing. `sealed` goes with a settings change. */
function applyOps(ops: DataOp[], sealed?: string) {
  transaction(() => ops.forEach((op) => apply(op, sealed)))
}

function saveSettings(settings: Settings, sealed?: string) {
  transaction(() => putSettings(settings, sealed))
}

/** The API keys as the main process sealed them, if it has. */
const sealedSecrets = () =>
  (open().prepare("SELECT value FROM meta WHERE key = 'secrets'").get() as { value: string } | undefined)?.value

/** Rebuilds the file, so plaintext keys from an older version don't linger in free pages or the WAL. */
function compact() {
  open().exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE);')
}

/** Settings (without the sealed API keys) and the full template list: what the main process keeps a copy of. */
function loadState() {
  const d = open()
  const settingsRow = d.prepare("SELECT value FROM meta WHERE key = 'settings'").get() as { value: string } | undefined
  const userTemplates = (d.prepare('SELECT data FROM templates ORDER BY position').all() as { data: string }[]).map((r) =>
    parse<Template>(r.data, null!)
  )
  return {
    settings: { ...defaults.settings, ...parse<Partial<Settings>>(settingsRow?.value, {}) } as Settings,
    templates: [...defaults.templates, ...userTemplates]
  }
}

function loadData(): AppData {
  const d = open()
  const rows = (sql: string) => d.prepare(sql).all() as Record<string, unknown>[]

  const state = loadState()
  const userRecipes = rows('SELECT data FROM recipes ORDER BY position').map((r) => parse<Recipe>(r.data, null!))

  const folderIds = new Map<string, string[]>()
  for (const r of rows('SELECT note_id, folder_id FROM note_folders ORDER BY note_id, position')) {
    const list = folderIds.get(r.note_id as string) ?? []
    list.push(r.folder_id as string)
    folderIds.set(r.note_id as string, list)
  }
  const panels = new Map<string, Panel[]>()
  for (const r of rows('SELECT * FROM panels ORDER BY note_id, position')) {
    const list = panels.get(r.note_id as string) ?? []
    list.push({
      id: r.id as string,
      templateId: r.template_id as string,
      title: r.title as string,
      markdown: r.markdown as string,
      html: r.html as string,
      ...(r.edited != null && { edited: !!r.edited }),
      createdAt: r.created_at as string
    })
    panels.set(r.note_id as string, list)
  }
  const transcripts = new Map<string, TranscriptSegment[]>()
  for (const r of rows('SELECT * FROM transcript_segments ORDER BY note_id, seq')) {
    const list = transcripts.get(r.note_id as string) ?? []
    list.push({
      id: r.id as string,
      speaker: r.speaker as TranscriptSegment['speaker'],
      text: r.text as string,
      start: r.start_ms as number,
      end: r.end_ms as number,
      ...(r.speaker_id != null && { speakerId: r.speaker_id as string }),
      ...(r.words != null && { words: parse(r.words, []) })
    })
    transcripts.set(r.note_id as string, list)
  }

  const notes: Note[] = rows('SELECT * FROM notes ORDER BY created_at DESC').map((r) => {
    const id = r.id as string
    return {
      id,
      title: r.title as string,
      notesHtml: r.notes_html as string,
      notesMarkdown: r.notes_markdown as string,
      transcript: transcripts.get(id) ?? [],
      ...(r.recorded_ms != null && { recordedMs: r.recorded_ms as number }),
      ...(r.speakers != null && { speakers: parse(r.speakers, []) }),
      panels: panels.get(id) ?? [],
      folderIds: folderIds.get(id) ?? [],
      attendees: parse(r.attendees, []),
      ...(r.calendar_event_id != null && { calendarEventId: r.calendar_event_id as string }),
      ...(r.template_id != null && { templateId: r.template_id as string }),
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      ...(r.deleted_at != null && { deletedAt: r.deleted_at as string })
    }
  })
  const folders: Folder[] = rows('SELECT * FROM folders ORDER BY position').map((r) => ({
    id: r.id as string,
    name: r.name as string,
    ...(r.icon != null && { icon: r.icon as string }),
    createdAt: r.created_at as string
  }))

  return {
    notes,
    folders,
    templates: state.templates,
    recipes: [...defaults.recipes, ...userRecipes],
    settings: state.settings
  }
}

/** Ids of notes whose title, notes, generated notes or transcript contain every word of `query`. */
function searchNotes(query: string): string[] {
  // Trigram matching needs at least three characters per term; shorter ones are left to the caller.
  const words = query.trim().split(/\s+/).filter((w) => [...w].length >= 3)
  if (!words.length) return []
  const match = words.map((w) => `"${w.replace(/"/g, '""')}"`).join(' ')
  const d = open()
  const ids = new Set<string>()
  const queries = [
    'SELECT n.id FROM notes_fts f JOIN notes n ON n.seq = f.rowid WHERE notes_fts MATCH ? ORDER BY rank',
    'SELECT p.note_id AS id FROM panels_fts f JOIN panels p ON p.seq = f.rowid WHERE panels_fts MATCH ? ORDER BY rank',
    'SELECT s.note_id AS id FROM segments_fts f JOIN transcript_segments s ON s.seq = f.rowid WHERE segments_fts MATCH ? ORDER BY rank'
  ]
  for (const sql of queries) for (const r of d.prepare(sql).all(match) as { id: string }[]) ids.add(r.id)
  return [...ids]
}

/** What semantic search splits into passages: a note's text, generated notes and transcript. */
function noteForIndex(id: string) {
  const d = open()
  const note = d.prepare('SELECT title, notes_markdown, speakers FROM notes WHERE id = ?').get(id) as
    | { title: string; notes_markdown: string; speakers: string | null }
    | undefined
  if (!note) return null
  return {
    title: note.title,
    notesMarkdown: note.notes_markdown,
    speakers: parse<{ id: string; name: string }[]>(note.speakers, []),
    panels: (d.prepare('SELECT text FROM panels WHERE note_id = ? ORDER BY position').all(id) as { text: string }[]).map(
      (p) => p.text
    ),
    segments: d
      .prepare('SELECT speaker, speaker_id, text, start_ms, end_ms FROM transcript_segments WHERE note_id = ? ORDER BY seq')
      .all(id) as { speaker: string; speaker_id: string | null; text: string; start_ms: number; end_ms: number }[]
  }
}

const allNoteIds = () => (open().prepare('SELECT id FROM notes').all() as { id: string }[]).map((r) => r.id)

function indexStats() {
  const d = open()
  const count = (sql: string) => (d.prepare(sql).get() as { n: number }).n
  return { indexed: count('SELECT count(*) AS n FROM chunk_notes'), total: count('SELECT count(*) AS n FROM notes') }
}

const chunkHash = (noteId: string) =>
  (open().prepare('SELECT hash FROM chunk_notes WHERE note_id = ?').get(noteId) as { hash: string } | undefined)?.hash

function saveChunks(noteId: string, hash: string, chunks: StoredChunk[]) {
  transaction(() => {
    const d = open()
    // The note may have been deleted while it was being embedded.
    if (!d.prepare('SELECT 1 FROM notes WHERE id = ?').get(noteId)) return
    d.prepare('DELETE FROM chunks WHERE note_id = ?').run(noteId)
    const insert = d.prepare(
      'INSERT INTO chunks (note_id, kind, start_ms, end_ms, text, vector) VALUES (?, ?, ?, ?, ?, ?)'
    )
    for (const c of chunks)
      insert.run(noteId, c.kind, val(c.startMs), val(c.endMs), c.text, new Uint8Array(c.vector.buffer, c.vector.byteOffset, c.vector.byteLength))
    d.prepare(
      'INSERT INTO chunk_notes (note_id, hash) VALUES (?, ?) ON CONFLICT (note_id) DO UPDATE SET hash = excluded.hash'
    ).run(noteId, hash)
  })
}

function loadChunks(): StoredChunk[] {
  return (open().prepare('SELECT note_id, kind, start_ms, end_ms, text, vector FROM chunks').all() as Record<string, unknown>[]).map(
    (r) => {
      const bytes = r.vector as Uint8Array
      return {
        noteId: r.note_id as string,
        kind: r.kind as StoredChunk['kind'],
        ...(r.start_ms != null && { startMs: r.start_ms as number }),
        ...(r.end_ms != null && { endMs: r.end_ms as number }),
        text: r.text as string,
        // A copy: the blob's bytes need not be aligned for a Float32Array view.
        vector: new Float32Array(new Uint8Array(bytes).buffer)
      }
    }
  )
}

/** Drops every embedding, e.g. when the model is removed. */
function clearChunks() {
  open().exec('DELETE FROM chunks; DELETE FROM chunk_notes;')
}

/** One-time move from the JSON file Oats used before; the file is kept as oats-data.json.bak. */
function importLegacyJson(d: Db) {
  if (d.prepare("SELECT 1 FROM meta WHERE key = 'imported-json'").get() || !existsSync(legacyFile())) return
  let legacy: Partial<AppData>
  try {
    legacy = JSON.parse(readFileSync(legacyFile(), 'utf8')) as Partial<AppData>
  } catch (err) {
    console.error('Failed to read the old data file, not importing it', err)
    return
  }
  transaction(() => {
    for (const n of legacy.notes ?? []) {
      const { transcript, panels, ...record } = n
      putNote({ ...record, folderIds: record.folderIds ?? [], attendees: record.attendees ?? [] })
      appendSegments(n.id, transcript ?? [])
      putPanels(n.id, panels ?? [])
    }
    putFolders(legacy.folders ?? [])
    putList('templates', legacy.templates ?? [])
    putList('recipes', legacy.recipes ?? [])
    putSettings({ ...defaults.settings, ...legacy.settings })
    d.prepare("INSERT INTO meta (key, value) VALUES ('imported-json', ?)").run(new Date().toISOString())
  })
  renameSync(legacyFile(), `${legacyFile()}.bak`)
}

function closeStore() {
  db?.close()
  db = undefined
}

/** Everything the main process can ask of the silo; index.ts answers each request with one of these. */
export const api: SiloApi = {
  open: openStore,
  close: closeStore,
  loadState,
  loadData,
  applyOps,
  saveSettings,
  sealedSecrets,
  compact,
  searchNotes,
  noteForIndex,
  allNoteIds,
  indexStats,
  chunkHash,
  saveChunks,
  loadChunks,
  clearChunks
}
