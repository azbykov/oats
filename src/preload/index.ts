import { contextBridge, ipcRenderer } from 'electron'
import type {
  AiStreamEvent,
  AsrEvent,
  AppData,
  CalendarEvent,
  ChatRequest,
  DiarizationResult,
  EnhanceRequest,
  MeetingApp,
  MeetingStart,
  PermissionKind,
  PermissionState,
  Permissions,
  PillAction,
  PillState,
  RecordingMeta,
  RecoveredSegment,
  WhisperModel
} from '../shared/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const on = <A extends any[]>(channel: string, cb: (...args: A) => void) => {
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]) => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.off(channel, listener)
  }
}

const api = {
  platform: process.platform,
  loadData: (): Promise<AppData> => ipcRenderer.invoke('data:load'),
  saveData: (data: AppData) => ipcRenderer.send('data:save', data),
  enhance: (id: string, req: EnhanceRequest) => ipcRenderer.invoke('ai:enhance', id, req),
  chat: (id: string, req: ChatRequest) => ipcRenderer.invoke('ai:chat', id, req),
  abortAi: (id: string) => ipcRenderer.send('ai:abort', id),
  listOpenAIModels: (): Promise<string[]> => ipcRenderer.invoke('ai:openai-models'),
  onAiEvent: (cb: (id: string, event: AiStreamEvent) => void) => on('ai:event', cb),
  listWhisperModels: (): Promise<WhisperModel[]> => ipcRenderer.invoke('asr:models'),
  downloadWhisperModel: (id: string) => ipcRenderer.send('asr:prepare', id),
  onWhisperModels: (cb: (models: WhisperModel[]) => void) => on('asr:models', cb),
  startWhisper: (model: string, language: string, words: boolean): Promise<void> =>
    ipcRenderer.invoke('asr:start', model, language, words),
  sendWhisperFrame: (kind: 1 | 2 | 3, channel: number, pcm?: ArrayBuffer) =>
    ipcRenderer.send('asr:frame', kind, channel, pcm),
  onWhisperEvent: (cb: (event: AsrEvent) => void) => on('asr:event', cb),
  nativeAudioAvailable: (): Promise<boolean> => ipcRenderer.invoke('native:available'),
  beginRecording: (meta: RecordingMeta) => ipcRenderer.send('rec:begin', meta),
  appendRecording: (id: string, pcm: ArrayBuffer) => ipcRenderer.send('rec:chunk', id, pcm),
  finishRecording: (id: string): Promise<void> => ipcRenderer.invoke('rec:finish', id),
  diarizeRecording: (id: string, maxSpeakers?: number): Promise<DiarizationResult> =>
    ipcRenderer.invoke('rec:diarize', id, maxSpeakers),
  transcribeRecording: (id: string, words: boolean): Promise<RecoveredSegment[]> =>
    ipcRenderer.invoke('rec:transcribe', id, words),
  removeRecording: (id: string): Promise<void> => ipcRenderer.invoke('rec:remove', id),
  leftoverRecordings: (): Promise<RecordingMeta[]> => ipcRenderer.invoke('rec:leftovers'),
  activeMeetingApps: (): Promise<MeetingApp[]> => ipcRenderer.invoke('meeting:active'),
  onMeetingDetected: (cb: (app: MeetingApp) => void) => on('meeting:detected', cb),
  onMeetingEnded: (cb: (app: MeetingApp) => void) => on('meeting:ended', cb),
  onMeetingStart: (cb: (start: MeetingStart) => void) => on('meeting:start', cb),
  onMeetingIgnore: (cb: (app: MeetingApp) => void) => on('meeting:ignore', cb),
  previewMeetingCard: () => ipcRenderer.send('meeting:preview'),
  getPillState: (): Promise<PillState | null> => ipcRenderer.invoke('pill:get'),
  onPillState: (cb: (state: PillState) => void) => on('pill:state', cb),
  sendPillAction: (action: PillAction) => ipcRenderer.send('pill:action', action),
  setPillIgnoreMouse: (ignore: boolean) => ipcRenderer.send('pill:ignore-mouse', ignore),
  getCalendarEvents: (): Promise<CalendarEvent[]> => ipcRenderer.invoke('calendar:events'),
  getSystemAudioMode: (): Promise<'tap' | 'screen' | 'loopback'> => ipcRenderer.invoke('media:system-audio-mode'),
  getPermissions: (): Promise<Permissions> => ipcRenderer.invoke('permissions:status'),
  requestPermission: (kind: PermissionKind): Promise<PermissionState> => ipcRenderer.invoke('permissions:request', kind),
  openPermissionSettings: (kind: PermissionKind) => ipcRenderer.send('permissions:open', kind),
  exportMarkdown: (name: string, markdown: string): Promise<boolean> =>
    ipcRenderer.invoke('export:markdown', name, markdown),
  openExternal: (url: string) => ipcRenderer.send('open-external', url),
  onMenu: (name: 'new-note' | 'search' | 'settings', cb: () => void) => on(`menu:${name}`, cb)
}

export type OatsApi = typeof api

contextBridge.exposeInMainWorld('oats', api)
