// Data model loosely mirrors Granola's document shape (title, notes, transcript,
// generated panels, folder lists) observed in the shipped renderer bundle.

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

export type AiProvider = 'anthropic' | 'openai'

export interface Settings {
  aiProvider: AiProvider
  anthropicApiKey: string
  openaiApiKey: string
  openaiModel: string
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

export interface ChatRequest {
  messages: ChatMessage[]
  context: { title: string; date: string; notesMarkdown: string; transcript: string }[]
  scope: 'note' | 'all'
}
