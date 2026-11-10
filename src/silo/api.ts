import type { AppData, DataOp, Settings, Template } from '../shared/types'

// What the main process and the silo (the database's own process) say to each other.
// The main process sends a request per call and gets one reply; requests are answered in
// the order they were sent.

export interface StoredChunk {
  noteId: string
  kind: 'notes' | 'panel' | 'transcript'
  startMs?: number
  endMs?: number
  text: string
  vector: Float32Array
}

/** What semantic search splits into passages: a note's text, generated notes and transcript. */
export interface NoteForIndex {
  title: string
  notesMarkdown: string
  speakers: { id: string; name: string }[]
  panels: string[]
  segments: { speaker: string; speaker_id: string | null; text: string; start_ms: number; end_ms: number }[]
}

export interface SiloApi {
  /**
   * Opens the database in this userData folder; the first request the silo gets. `key` is
   * what it is encrypted with (64 hex digits), or null where there is no keychain to keep one.
   */
  open(userData: string, key: string | null): void
  close(): void
  loadState(): { settings: Settings; templates: Template[] }
  loadData(): AppData
  applyOps(ops: DataOp[], sealed?: string): void
  saveSettings(settings: Settings, sealed?: string): void
  sealedSecrets(): string | undefined
  compact(): void
  searchNotes(query: string): string[]
  noteForIndex(id: string): NoteForIndex | null
  allNoteIds(): string[]
  indexStats(): { indexed: number; total: number }
  chunkHash(noteId: string): string | undefined
  saveChunks(noteId: string, hash: string, chunks: StoredChunk[]): void
  loadChunks(): StoredChunk[]
  clearChunks(): void
}

export type SiloMethod = keyof SiloApi

export interface SiloRequest {
  id: number
  method: SiloMethod
  args: unknown[]
}
export type SiloResponse = { id: number; result: unknown } | { id: number; error: string }

/** Sends one request to the silo and resolves with its reply. */
export type SiloTransport = (method: SiloMethod, args: unknown[]) => Promise<unknown>

// API keys are kept out of the settings JSON, in a row of their own that the main process
// encrypts with the OS keychain.
export const SECRET_KEYS = ['anthropicApiKey', 'openaiApiKey', 'deepgramApiKey'] as const
export type Secrets = Pick<Settings, (typeof SECRET_KEYS)[number]>

export const pickSecrets = (s: Partial<Settings>) =>
  Object.fromEntries(SECRET_KEYS.map((k) => [k, s[k] ?? ''])) as Secrets
export const withoutSecrets = (s: Settings) =>
  Object.fromEntries(Object.entries(s).filter(([k]) => !(SECRET_KEYS as readonly string[]).includes(k)))
