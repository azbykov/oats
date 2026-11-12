import type { Settings } from './types'

// The settings every app starts from; an app's profile changes what it needs to (Product.settings).

export const DEFAULT_SETTINGS: Settings = {
  aiProvider: 'anthropic',
  anthropicApiKey: '',
  openaiApiKey: '',
  openaiModel: 'gpt-6.1-sol',
  codexModel: '',
  transcriptionProvider: 'whisper',
  whisperModel: 'openai_whisper-large-v3-v20240930_turbo_632MB',
  deepgramApiKey: '',
  model: 'claude-opus-5-5',
  language: 'multi',
  icsUrl: '',
  theme: 'system',
  userName: '',
  micSource: 'call',
  micLabel: '',
  captureSystemAudio: true,
  separateSpeakers: true,
  keepAudioBackup: true,
  detectMeetings: true,
  setupCompleted: false,
  ignoredMeetingApps: []
}
