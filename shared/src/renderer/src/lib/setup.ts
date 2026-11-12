import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import type { Account, CliStatus, Permissions, PermissionState, SemanticStatus, Settings, WhisperModel } from '../../../common/types'
import { isMac } from './platform'
import { useStore } from './store'
import { localTranscription, product } from './product'

// Is Oats ready to take notes? One checklist, used by the first-run wizard, the
// sidebar card (something required broke) and Settings → Setup. It is computed
// from what the app already reports: permissions, the audio helper, Whisper
// models, the AI provider, accounts and the search model.

export type SetupStep = 'permissions' | 'transcription' | 'ai' | 'calendar' | 'done'

export const SETUP_STEPS: { id: SetupStep; label: string }[] = [
  { id: 'permissions', label: 'Permissions' },
  { id: 'transcription', label: 'Transcription' },
  { id: 'ai', label: 'AI notes' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'done', label: 'Ready' }
]

/** ok · todo: needs the user · working: downloading or optimising · checking: not known yet · unknown: can't be checked. */
export type CheckState = 'ok' | 'todo' | 'working' | 'checking' | 'unknown'

export interface SetupItem {
  id: 'microphone' | 'systemAudio' | 'transcription' | 'ai' | 'calendar' | 'meetings' | 'search'
  /** Without it notes can't be taken; optional items are only suggested. */
  required: boolean
  title: string
  detail: string
  state: CheckState
  /** The wizard step that fixes it. */
  step: SetupStep
}

type CliKind = 'claude' | 'codex'

interface Probe {
  permissions: Permissions | null
  native: boolean | null
  models: WhisperModel[] | null
  cli: Partial<Record<CliKind, CliStatus>>
  semantic: SemanticStatus | null
}

export const useProbe = create<Probe>(() => ({ permissions: null, native: null, models: null, cli: {}, semantic: null }))

const cliCheckedAt: Partial<Record<CliKind, number>> = {}

/** Runs `claude`/`codex` to see that it is installed and logged in; at most once a minute unless forced. */
export function checkCli(kind: CliKind, force = false) {
  if (!force && Date.now() - (cliCheckedAt[kind] ?? 0) < 60_000) return
  cliCheckedAt[kind] = Date.now()
  if (force) useProbe.setState((s) => ({ cli: { ...s.cli, [kind]: undefined } }))
  window.oats
    .cliStatus(kind)
    .then((status) => useProbe.setState((s) => ({ cli: { ...s.cli, [kind]: status } })))
    .catch((err: Error) => useProbe.setState((s) => ({ cli: { ...s.cli, [kind]: { ok: false, message: err.message } } })))
}

const cliOf = (provider: Settings['aiProvider']): CliKind | null =>
  provider === 'claude-cli' ? 'claude' : provider === 'codex-cli' ? 'codex' : null

/** Re-reads what can change behind the app's back (System Settings, Terminal). */
export function refreshSetup() {
  window.oats.getPermissions().then((permissions) => useProbe.setState({ permissions }))
  const kind = cliOf(useStore.getState().data?.settings.aiProvider ?? 'anthropic')
  if (kind) checkCli(kind)
}

/** Called once from App: keeps the probe current for every checklist view. */
export function useSetupMonitor() {
  const provider = useStore((s) => s.data?.settings.aiProvider)
  useEffect(() => {
    window.oats.nativeAudioAvailable().then((native) => useProbe.setState({ native }))
    window.oats.listWhisperModels().then((models) => useProbe.setState({ models }))
    window.oats.getSemanticStatus().then((semantic) => useProbe.setState({ semantic }))
    const offs = [
      window.oats.onWhisperModels((models) => useProbe.setState({ models })),
      window.oats.onSemanticStatus((semantic) => useProbe.setState({ semantic }))
    ]
    // Back from System Settings or Terminal: permissions and CLI logins may have changed.
    window.addEventListener('focus', refreshSetup)
    return () => {
      offs.forEach((off) => off())
      window.removeEventListener('focus', refreshSetup)
    }
  }, [])
  useEffect(() => {
    if (provider) refreshSetup()
  }, [provider])
}

const where = isMac ? 'System Settings' : 'Windows Settings'

function permission(state: PermissionState | undefined, hint: string): Pick<SetupItem, 'state' | 'detail'> {
  if (!state) return { state: 'checking', detail: 'Checking…' }
  if (state === 'granted') return { state: 'ok', detail: 'Allowed' }
  if (state === 'denied') return { state: 'todo', detail: `Turned off in ${where}` }
  if (state === 'not-determined') return { state: 'todo', detail: `Not allowed yet. ${hint}` }
  return { state: 'unknown', detail: `Can’t be checked in this build; ${product.name} asks when it starts recording` }
}

const percent = (m: WhisperModel) => `${Math.round((m.progress ?? 0) * 100)}%`

function transcription(settings: Settings, probe: Probe): Pick<SetupItem, 'state' | 'detail'> {
  if (!localTranscription(settings)) {
    return settings.deepgramApiKey
      ? { state: 'ok', detail: 'Deepgram (cloud)' }
      : { state: 'todo', detail: 'Add a Deepgram API key, or switch to local Whisper' }
  }
  if (probe.native === false) {
    return {
      state: 'todo',
      detail: import.meta.env.DEV
        ? 'The audio helper isn’t built: run npm run build:native'
        : `The audio helper is missing from this build; reinstall ${product.name}${product.features.cloudTranscription ? ' or switch to Deepgram' : ''}`
    }
  }
  if (probe.native === null || !probe.models) return { state: 'checking', detail: 'Checking…' }
  const models = probe.models
  const chosen = models.find((m) => m.id === settings.whisperModel)
  if (chosen?.status === 'ready') return { state: 'ok', detail: `Whisper ${chosen.label}` }
  const busy = chosen?.status === 'downloading' ? chosen : models.find((m) => m.status === 'downloading')
  if (busy) {
    return {
      state: 'working',
      detail:
        busy.stage === 'compile'
          ? `Optimising Whisper ${busy.label} for this ${isMac ? 'Mac' : 'PC'}…`
          : `Downloading Whisper ${busy.label} · ${percent(busy)}`
    }
  }
  if (chosen?.error) return { state: 'todo', detail: chosen.error }
  const fallback = models.find((m) => m.status === 'ready')
  if (fallback) {
    return {
      state: 'todo',
      detail: `${chosen?.label ?? 'The chosen model'} isn’t downloaded; ${fallback.label} is used meanwhile`
    }
  }
  return {
    state: 'todo',
    detail: chosen ? `Download a Whisper model (${chosen.label} · ${chosen.size})` : 'Download a Whisper model'
  }
}

function ai(settings: Settings, probe: Probe): Pick<SetupItem, 'state' | 'detail'> {
  switch (settings.aiProvider) {
    case 'anthropic':
      return settings.anthropicApiKey
        ? { state: 'ok', detail: 'Claude API' }
        : { state: 'todo', detail: 'Add an Anthropic API key or use a subscription' }
    case 'openai':
      return settings.openaiApiKey
        ? { state: 'ok', detail: 'OpenAI API' }
        : { state: 'todo', detail: 'Add an OpenAI API key or use a subscription' }
    default: {
      const status = probe.cli[cliOf(settings.aiProvider)!]
      if (!status) return { state: 'checking', detail: 'Checking…' }
      return status.ok ? { state: 'ok', detail: status.detail } : { state: 'todo', detail: status.message }
    }
  }
}

export function setupItems(settings: Settings, accounts: Account[], probe: Probe): SetupItem[] {
  const p = probe.permissions
  const items: SetupItem[] = [
    {
      id: 'microphone',
      required: true,
      title: 'Microphone',
      step: 'permissions',
      ...permission(p?.microphone, 'Needed for your side of the conversation.')
    }
  ]
  if (settings.captureSystemAudio) {
    items.push({
      id: 'systemAudio',
      required: true,
      title: 'System audio',
      step: 'permissions',
      ...permission(p?.systemAudio, 'Needed to hear the other people on the call.')
    })
  }
  items.push(
    { id: 'transcription', required: true, title: 'Transcription', step: 'transcription', ...transcription(settings, probe) },
    { id: 'ai', required: true, title: 'AI notes', step: 'ai', ...ai(settings, probe) }
  )
  const calendars = accounts.some((a) => a.calendars.some((c) => c.enabled)) || !!settings.icsUrl
  items.push({
    id: 'calendar',
    required: false,
    title: 'Calendar',
    step: 'calendar',
    state: calendars ? 'ok' : 'todo',
    detail: calendars ? 'Upcoming meetings appear on Home' : 'Connect a calendar to see upcoming meetings'
  })
  if (probe.native) {
    items.push({
      id: 'meetings',
      required: false,
      title: 'Meeting detection',
      step: 'done',
      state: settings.detectMeetings ? 'ok' : 'todo',
      detail: settings.detectMeetings ? 'Offers to take notes when a call starts' : 'Off'
    })
  }
  const s = probe.semantic
  if (s && s.model !== 'unavailable') {
    items.push({
      id: 'search',
      required: false,
      title: 'Search by meaning',
      step: 'done',
      state: s.model === 'ready' ? 'ok' : s.model === 'downloading' ? 'working' : 'todo',
      detail:
        s.model === 'ready'
          ? 'Downloaded'
          : s.model === 'downloading'
            ? `Downloading · ${Math.round((s.progress ?? 0) * 100)}%`
            : 'Optional: a 118 MB model for chat and ⌘K'
    })
  }
  return items
}

export function useSetup() {
  const settings = useStore((s) => s.data!.settings)
  const accounts = useStore((s) => s.accounts)
  const probe = useProbe()
  return useMemo(() => {
    const items = setupItems(settings, accounts, probe)
    const required = items.filter((i) => i.required)
    return {
      items,
      /** Required items the user has to act on. */
      attention: required.filter((i) => i.state === 'todo'),
      /** Every required item is known (nothing still being checked). */
      settled: required.every((i) => i.state !== 'checking'),
      ready: required.every((i) => i.state === 'ok' || i.state === 'unknown')
    }
  }, [settings, accounts, probe])
}

/** The state of a wizard step, from the worst of its required items. */
export function stepState(items: SetupItem[], step: SetupStep): CheckState | null {
  const own = items.filter((i) => i.step === step && i.required)
  if (!own.length) return null
  for (const state of ['todo', 'checking', 'working'] as const) if (own.some((i) => i.state === state)) return state
  return 'ok'
}
