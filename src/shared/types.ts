// Data model: documents (title, notes, transcript, generated panels) and folder lists.

export type Speaker = 'me' | 'them'

export interface TranscriptSegment {
  id: string
  speaker: Speaker
  text: string
  start: number // ms since recording began
  end: number
  speakerId?: string // set by offline speaker separation for "them" segments
  /** Word timings (absolute ms), kept until speaker separation has split the line. */
  words?: TranscriptWord[]
}

export interface TranscriptWord {
  text: string
  start: number
  end: number
}

export interface NoteSpeaker {
  id: string
  name: string
  embedding: number[]
}

export type PermissionKind = 'microphone' | 'systemAudio'
export type PermissionState = 'granted' | 'denied' | 'not-determined' | 'unknown'
export type Permissions = Record<PermissionKind, PermissionState>

/** A call app detected using the microphone. */
export interface MeetingApp {
  bundleId: string
  name: string
  browser: boolean
}

/** What the floating "meeting detected" card shows. */
export interface PillState {
  app: MeetingApp
  templates: { id: string; title: string }[]
  theme: Theme
}

export type PillAction =
  | { type: 'take-notes'; templateId?: string }
  | { type: 'dismiss' }
  | { type: 'ignore-app' }

/** Sent to the main window to start notes for a detected call. */
export interface MeetingStart {
  app: MeetingApp
  templateId?: string
}

/** One channel of a recording session kept on disk as a 16 kHz WAV. */
export interface RecordingMeta {
  id: string
  sessionId: string
  noteId: string
  channel: Speaker
  /** Note transcript time (ms) at which this recording starts. */
  offset: number
  startedAt: string
  endedCleanly?: boolean
}

/** A segment from offline re-transcription of a recording (ms relative to its start). */
export interface RecoveredSegment {
  text: string
  startMs: number
  endMs: number
  words?: { w: string; s: number; e: number }[]
}

export interface DiarizationResult {
  modelId: string
  durationMs: number
  segments: { speakerId: string; startMs: number; endMs: number }[]
  speakerEmbeddings: Record<string, number[]>
}

export interface Panel {
  id: string
  templateId: string
  title: string
  markdown: string // raw model output
  html: string // rendered + authorship-marked, editable by the user
  /** The user changed the generated text, so replacing it would lose their edits. */
  edited?: boolean
  createdAt: string
}

export interface Attendee {
  name: string
  email?: string
}

export interface Note {
  id: string
  title: string
  notesHtml: string
  notesMarkdown: string
  transcript: TranscriptSegment[]
  /** How much audio has been recorded into this note (ms); the next session's timeline continues from it. */
  recordedMs?: number
  speakers?: NoteSpeaker[]
  panels: Panel[]
  folderIds: string[]
  attendees: Attendee[]
  calendarEventId?: string
  /** Template picked when the note was started (e.g. from the meeting card). */
  templateId?: string
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

export interface Folder {
  id: string
  name: string
  icon?: string
  createdAt: string
}

export interface Template {
  id: string
  title: string
  description: string
  sections: { heading: string; instructions: string }[]
  /** Free-form guidance for the whole document, used with or instead of fixed sections. */
  instructions?: string
  builtIn?: boolean
}

export interface Recipe {
  id: string
  slug: string
  title: string
  prompt: string
  builtIn?: boolean
}

export interface CalendarEvent {
  id: string
  title: string
  start: string
  end: string
  attendees: Attendee[]
  location?: string
  url?: string
  allDay?: boolean
  /** Colour of the calendar the event comes from (connected accounts only). */
  color?: string
}

/** Events from every calendar source; a failing source is reported without hiding the others. */
export interface CalendarResult {
  events: CalendarEvent[]
  errors: string[]
}

export type AccountProvider = 'google' | 'yandex'

export interface AccountCalendar {
  id: string
  name: string
  color?: string
  primary?: boolean
  enabled: boolean
  /** The user switched it on or off; otherwise it follows the default (on). */
  chosen?: boolean
}

/** A signed-in Google or Yandex account. Its tokens stay in the main process. */
export interface Account {
  id: string
  provider: AccountProvider
  email: string
  name: string
  avatarUrl?: string
  calendars: AccountCalendar[]
  connectedAt: string
  /** Set when the account needs to be signed in again. */
  error?: string
  /** Yandex: CalDAV didn't take the OAuth token, so it needs a calendar app password. */
  needsAppPassword?: boolean
}

export type Theme = 'system' | 'light' | 'dark'

export type TranscriptionProvider = 'deepgram' | 'whisper'

export interface WhisperModel {
  id: string
  label: string
  size: string
  status: 'missing' | 'downloading' | 'ready'
  stage?: 'download' | 'compile'
  progress?: number
  error?: string
}

/** Events from the local Whisper listener (channel 0 = mic, 1 = system audio). */
export type AsrEvent =
  | {
      type: 'partial' | 'final'
      channel: number
      text: string
      startMs: number
      endMs: number
      words?: { w: string; s: number; e: number }[]
    }
  | { type: 'error'; message: string }

/** A newer release: offered as a download, or (Windows) already downloaded and installed on restart. */
export type UpdateState =
  | { status: 'available'; version: string; downloadUrl: string }
  | { status: 'ready'; version: string }

/** API keys, or the user's own Claude Code / Codex CLI signed in with their subscription. */
export type AiProvider = 'anthropic' | 'openai' | 'claude-cli' | 'codex-cli'

export type CliStatus = { ok: true; detail: string } | { ok: false; message: string }

export interface Settings {
  aiProvider: AiProvider
  anthropicApiKey: string
  openaiApiKey: string
  openaiModel: string
  /** Model for `codex exec`; empty uses the CLI's own default. */
  codexModel: string
  transcriptionProvider: TranscriptionProvider
  whisperModel: string
  deepgramApiKey: string
  model: string
  language: string
  icsUrl: string
  theme: Theme
  userName: string
  captureSystemAudio: boolean
  separateSpeakers: boolean
  /** Keep a local copy of the audio until the session is processed, to recover from failures. */
  keepAudioBackup: boolean
  /** Offer to take notes when a meeting app starts using the microphone. */
  detectMeetings: boolean
  /** Bundle ids of apps the user chose never to be asked about. */
  ignoredMeetingApps: string[]
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Local semantic search: the embedding model and how far indexing has got. */
export interface SemanticStatus {
  /** "unavailable": no ONNX runtime for this platform (e.g. Intel Macs). */
  model: 'unavailable' | 'missing' | 'downloading' | 'ready'
  progress?: number
  error?: string
  /** Notes with up-to-date embeddings, out of all notes. */
  indexed: number
  total: number
}

/** A passage of a note that matches a query by meaning. */
export interface SemanticHit {
  noteId: string
  kind: 'notes' | 'panel' | 'transcript'
  /** Transcript passages only: where in the meeting it was said. */
  startMs?: number
  endMs?: number
  text: string
  score: number
}

/** A note without its transcript and generated panels, which are stored and sent apart. */
export type NoteRecord = Omit<Note, 'transcript' | 'panels'>

/** One change the renderer saves; it sends these instead of the whole AppData. */
export type DataOp =
  | { type: 'note'; note: NoteRecord }
  | { type: 'note-delete'; id: string }
  | { type: 'transcript-append'; noteId: string; segments: TranscriptSegment[] }
  | { type: 'transcript-replace'; noteId: string; segments: TranscriptSegment[] }
  | { type: 'panels'; noteId: string; panels: Panel[] }
  | { type: 'folders'; folders: Folder[] }
  | { type: 'templates'; templates: Template[] }
  | { type: 'recipes'; recipes: Recipe[] }
  | { type: 'settings'; settings: Settings }

export interface AppData {
  notes: Note[]
  folders: Folder[]
  templates: Template[]
  recipes: Recipe[]
  settings: Settings
}

export type AiStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string }

export interface EnhanceRequest {
  title: string
  notesMarkdown: string
  transcript: string
  template: Template
  attendees: Attendee[]
  date: string
  needsTitle: boolean
}

export type ChatScope = 'note' | 'folder' | 'all'

/** A meeting handed to the chat; `ref` is what the model cites it by (meeting://<ref>). */
export interface ChatMeeting {
  ref: string
  title: string
  date: string
  attendees: string
  notesMarkdown: string
  transcript: string
  /** The transcript was too long and only the passages matching the question are included. */
  excerpt?: boolean
}

export interface ChatRequest {
  messages: ChatMessage[]
  context: ChatMeeting[]
  scope: ChatScope
  /** Set for scope "folder". */
  folderName?: string
  /** How many meetings the search went through (the context holds the most relevant ones). */
  searched: number
  today: string
}
