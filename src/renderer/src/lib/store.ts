import { create } from 'zustand'
import type {
  Account,
  AppData,
  CalendarEvent,
  Folder,
  Integration,
  MeetingApp,
  Note,
  Panel,
  Settings,
  Template,
  TranscriptSegment
} from '../../../shared/types'
import { changes } from './persist'

export type Route =
  | { view: 'home' }
  | { view: 'note'; id: string }
  | { view: 'folder'; id: string }
  | { view: 'templates' }
  | { view: 'settings'; tab?: 'general' | 'accounts' | 'integrations' | 'ai' | 'transcription' | 'calendar' }

export type RecordingStatus = 'idle' | 'starting' | 'recording' | 'paused' | 'error'

interface State {
  data: AppData | null
  route: Route
  history: Route[]
  events: CalendarEvent[]
  /** Calendar sources that failed on the last refresh. */
  eventsErrors: string[]
  /** Signed-in Google / Yandex accounts (tokens stay in the main process). */
  accounts: Account[]
  /** Connected Notion workspace (tokens stay in the main process). */
  integrations: Integration[]
  searchOpen: boolean
  /** Note view without the sidebar and with the header hidden until hovered. */
  focusMode: boolean
  recording: {
    noteId: string | null
    status: RecordingStatus
    error?: string
    systemAudio: boolean
    /** Local Whisper is loading its model; audio is recorded and transcribed once it's ready. */
    loadingModel?: boolean
    /** Why transcription stopped by itself, shown until it is resumed. */
    autoStopped?: string
  }
  partials: Record<'me' | 'them', string>
  level: number
  diarizing: Record<string, { status: 'running' | 'error'; message?: string }>
  /** Call apps currently using the microphone (meeting detection). */
  meetingApps: MeetingApp[]

  load: () => Promise<void>
  navigate: (route: Route) => void
  back: () => void
  setSearchOpen: (open: boolean) => void
  setFocusMode: (on: boolean) => void
  setEvents: (events: CalendarEvent[], errors?: string[]) => void
  setAccounts: (accounts: Account[]) => void
  setIntegrations: (integrations: Integration[]) => void

  createNote: (init?: Partial<Note>) => Note
  createNoteFromEvent: (event: CalendarEvent) => Note
  updateNote: (id: string, patch: Partial<Note>) => void
  deleteNote: (id: string) => void
  appendTranscript: (id: string, seg: TranscriptSegment) => void
  renameSpeaker: (id: string, speakerId: string, name: string) => void
  /** Removes a transcript line as shown (consecutive segments merged by mergeTranscript). */
  deleteTranscriptLine: (id: string, line: TranscriptSegment) => void
  addPanel: (id: string, panel: Panel) => void
  updatePanel: (id: string, panelId: string, patch: Partial<Panel>) => void
  removePanel: (id: string, panelId: string) => void

  createFolder: (name: string) => Folder
  renameFolder: (id: string, name: string) => void
  deleteFolder: (id: string) => void
  toggleNoteFolder: (noteId: string, folderId: string) => void

  saveTemplate: (t: Template) => void
  deleteTemplate: (id: string) => void
  updateSettings: (patch: Partial<Settings>) => void

  setRecording: (patch: Partial<State['recording']>) => void
  setPartial: (speaker: 'me' | 'them', text: string) => void
  setLevel: (level: number) => void
  setDiarizing: (noteId: string, state: State['diarizing'][string] | null) => void
  setMeetingApps: (apps: MeetingApp[]) => void
}

export const uid = () => crypto.randomUUID()
const now = () => new Date().toISOString()

export const useStore = create<State>((set, get) => {
  const mutate = (fn: (d: AppData) => AppData) => {
    const d = get().data
    if (!d) return
    const next = fn(d)
    set({ data: next })
    const ops = changes(d, next)
    if (ops.length) window.oats.applyData(ops)
  }
  const mapNote = (id: string, fn: (n: Note) => Note) =>
    mutate((d) => ({ ...d, notes: d.notes.map((n) => (n.id === id ? fn(n) : n)) }))

  return {
    data: null,
    route: { view: 'home' },
    history: [],
    events: [],
    eventsErrors: [],
    accounts: [],
    integrations: [],
    searchOpen: false,
    focusMode: false,
    recording: { noteId: null, status: 'idle', systemAudio: false },
    partials: { me: '', them: '' },
    level: 0,
    diarizing: {},
    meetingApps: [],

    load: async () => {
      const [data, accounts, integrations] = await Promise.all([
        window.oats.loadData(),
        window.oats.listAccounts(),
        window.oats.listIntegrations()
      ])
      set({ data, accounts, integrations })
    },
    navigate: (route) => set((s) => ({ route, history: [...s.history, s.route].slice(-50) })),
    back: () =>
      set((s) => {
        const history = [...s.history]
        const route = history.pop() ?? { view: 'home' }
        return { route, history }
      }),
    setSearchOpen: (searchOpen) => set({ searchOpen }),
    setFocusMode: (focusMode) => set({ focusMode }),
    setEvents: (events, eventsErrors = []) => set({ events, eventsErrors }),
    setAccounts: (accounts) => set({ accounts }),
    setIntegrations: (integrations) => set({ integrations }),

    createNote: (init) => {
      const note: Note = {
        id: uid(),
        title: '',
        notesHtml: '',
        notesMarkdown: '',
        transcript: [],
        panels: [],
        folderIds: [],
        attendees: [],
        createdAt: now(),
        updatedAt: now(),
        ...init
      }
      mutate((d) => ({ ...d, notes: [note, ...d.notes] }))
      return note
    },
    createNoteFromEvent: (event) => {
      const existing = get().data?.notes.find((n) => n.calendarEventId === event.id && !n.deletedAt)
      if (existing) return existing
      return get().createNote({ title: event.title, attendees: event.attendees, calendarEventId: event.id })
    },
    updateNote: (id, patch) => mapNote(id, (n) => ({ ...n, ...patch, updatedAt: now() })),
    deleteNote: (id) =>
      mutate((d) => ({ ...d, notes: d.notes.filter((n) => n.id !== id) })),
    // Segments stay as Deepgram finalised them so speaker separation can label each
    // one; the transcript view merges consecutive lines from the same speaker.
    appendTranscript: (id, seg) =>
      mapNote(id, (n) => ({ ...n, transcript: [...n.transcript, seg], updatedAt: now() })),
    renameSpeaker: (id, speakerId, name) =>
      mapNote(id, (n) => ({
        ...n,
        speakers: n.speakers?.map((s) => (s.id === speakerId ? { ...s, name } : s))
      })),
    deleteTranscriptLine: (id, line) =>
      mapNote(id, (n) => ({
        ...n,
        transcript: n.transcript.filter(
          (s) =>
            !(
              s.speaker === line.speaker &&
              s.speakerId === line.speakerId &&
              s.start >= line.start &&
              s.end <= line.end
            )
        ),
        updatedAt: now()
      })),
    addPanel: (id, panel) => mapNote(id, (n) => ({ ...n, panels: [...n.panels, panel], updatedAt: now() })),
    updatePanel: (id, panelId, patch) =>
      mapNote(id, (n) => ({
        ...n,
        panels: n.panels.map((p) => (p.id === panelId ? { ...p, ...patch } : p))
      })),
    removePanel: (id, panelId) =>
      mapNote(id, (n) => ({ ...n, panels: n.panels.filter((p) => p.id !== panelId) })),

    createFolder: (name) => {
      const folder: Folder = { id: uid(), name, createdAt: now() }
      mutate((d) => ({ ...d, folders: [...d.folders, folder] }))
      return folder
    },
    renameFolder: (id, name) =>
      mutate((d) => ({ ...d, folders: d.folders.map((f) => (f.id === id ? { ...f, name } : f)) })),
    deleteFolder: (id) =>
      mutate((d) => ({
        ...d,
        folders: d.folders.filter((f) => f.id !== id),
        notes: d.notes.map((n) => ({ ...n, folderIds: n.folderIds.filter((f) => f !== id) }))
      })),
    toggleNoteFolder: (noteId, folderId) =>
      mapNote(noteId, (n) => ({
        ...n,
        folderIds: n.folderIds.includes(folderId)
          ? n.folderIds.filter((f) => f !== folderId)
          : [...n.folderIds, folderId]
      })),

    saveTemplate: (t) =>
      mutate((d) => ({
        ...d,
        templates: d.templates.some((x) => x.id === t.id)
          ? d.templates.map((x) => (x.id === t.id ? t : x))
          : [...d.templates, t]
      })),
    deleteTemplate: (id) => mutate((d) => ({ ...d, templates: d.templates.filter((t) => t.id !== id) })),
    updateSettings: (patch) => mutate((d) => ({ ...d, settings: { ...d.settings, ...patch } })),

    setRecording: (patch) => set((s) => ({ recording: { ...s.recording, ...patch } })),
    setPartial: (speaker, text) => set((s) => ({ partials: { ...s.partials, [speaker]: text } })),
    setLevel: (level) => set({ level }),
    setMeetingApps: (meetingApps) => set({ meetingApps }),
    setDiarizing: (noteId, state) =>
      set((s) => {
        const diarizing = { ...s.diarizing }
        if (state) diarizing[noteId] = state
        else delete diarizing[noteId]
        return { diarizing }
      })
  }
})

export const useNote = (id: string) => useStore((s) => s.data?.notes.find((n) => n.id === id))
