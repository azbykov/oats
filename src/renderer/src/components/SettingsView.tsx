import { useEffect, useState, type ReactNode } from 'react'
import type { CliStatus, Settings, WhisperModel } from '../../../shared/types'
import { isMac, thisComputer } from '../lib/platform'
import { useStore } from '../lib/store'
import { AccountsSettings } from './Accounts'
import { PermissionsList } from './Permissions'
import { Button } from './ui'

type Tab = 'general' | 'accounts' | 'ai' | 'transcription' | 'calendar'

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'ai', label: 'AI' },
  { id: 'transcription', label: 'Transcription' },
  { id: 'calendar', label: 'Calendar' }
]

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' }
]

const LANGUAGES = [
  { id: 'multi', label: 'Auto (multilingual)' },
  { id: 'en', label: 'English' },
  { id: 'ru', label: 'Русский' },
  { id: 'es', label: 'Español' },
  { id: 'de', label: 'Deutsch' },
  { id: 'fr', label: 'Français' },
  { id: 'pt', label: 'Português' },
  { id: 'it', label: 'Italiano' },
  { id: 'nl', label: 'Nederlands' },
  { id: 'ja', label: '日本語' }
]

const input =
  'h-9 w-full rounded-lg border border-hairline bg-fill-input px-3 text-[13px] text-ink-primary outline-none focus:border-ink-accent'

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-hairline py-4 last:border-b-0">
      <div className="text-[13px] font-medium text-ink-primary">{label}</div>
      {children}
      {hint && <div className="text-[12px] leading-snug text-ink-tertiary">{hint}</div>}
    </div>
  )
}

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault()
        window.oats.openExternal(href)
      }}
      className="text-ink-accent underline underline-offset-2"
    >
      {children}
    </a>
  )
}

export function SettingsView({ initialTab }: { initialTab?: Tab }) {
  const settings = useStore((s) => s.data!.settings)
  const update = useStore((s) => s.updateSettings)
  const [tab, setTab] = useState<Tab>(initialTab ?? 'general')
  const [calendarStatus, setCalendarStatus] = useState<string | null>(null)
  const [diarizer, setDiarizer] = useState<boolean | null>(null)
  const [audioMode, setAudioMode] = useState<'tap' | 'screen' | 'loopback'>('tap')
  useEffect(() => {
    window.oats.nativeAudioAvailable().then(setDiarizer)
    window.oats.getSystemAudioMode().then(setAudioMode)
  }, [])
  const set = <K extends keyof Settings>(k: K) => (v: Settings[K]) => update({ [k]: v } as Partial<Settings>)

  return (
    <div className="flex h-full flex-col">
      <div className="drag h-[52px] shrink-0" />
      <div className="min-h-0 flex-1 overflow-y-auto pb-16">
        <div className="mx-auto w-full max-w-2xl px-6">
          <h1 className="mb-4 font-display text-[28px] tracking-tight text-ink-strong">Settings</h1>
          <div className="mb-4 flex gap-0.5 rounded-xl bg-fill-soft p-0.5">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`h-7 flex-1 cursor-default rounded-[10px] text-[13px] ${tab === t.id ? 'bg-surface-elevated font-medium text-ink-strong shadow-sm' : 'text-ink-secondary hover:text-ink-primary'}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="rounded-2xl border border-hairline bg-surface-elevated px-5">
            {tab === 'general' && (
              <>
                <Row label="Your name" hint="Used to attribute your action items.">
                  <input className={input} value={settings.userName} onChange={(e) => set('userName')(e.target.value)} />
                </Row>
                <Row label="Appearance">
                  <div className="flex gap-2">
                    {(['system', 'light', 'dark'] as const).map((t) => (
                      <Button
                        key={t}
                        variant={settings.theme === t ? 'primary' : 'outline'}
                        onClick={() => set('theme')(t)}
                        className="capitalize"
                      >
                        {t}
                      </Button>
                    ))}
                  </div>
                </Row>
              </>
            )}

            {tab === 'accounts' && (
              <Row
                label="Accounts"
                hint={`Sign in with Google or Yandex to see their calendars in Coming up. Oats only reads calendars; sign-in tokens are encrypted on ${thisComputer}.`}
              >
                <AccountsSettings />
              </Row>
            )}

            {tab === 'ai' && (
              <>
                <Row
                  label="AI provider"
                  hint={`Used to enhance notes and answer questions. API keys are stored locally on ${thisComputer}; a subscription runs through its own app installed here.`}
                >
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        ['anthropic', 'Claude API'],
                        ['openai', 'OpenAI API'],
                        ['claude-cli', 'Claude subscription'],
                        ['codex-cli', 'ChatGPT subscription']
                      ] as const
                    ).map(([id, label]) => (
                      <Button
                        key={id}
                        variant={settings.aiProvider === id ? 'primary' : 'outline'}
                        onClick={() => set('aiProvider')(id)}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                </Row>
                {settings.aiProvider === 'anthropic' && (
                  <Row
                    label="Anthropic API key"
                    hint={
                      <>
                        Get one at{' '}
                        <ExtLink href="https://console.anthropic.com/settings/keys">console.anthropic.com</ExtLink>.
                      </>
                    }
                  >
                    <input
                      type="password"
                      className={input}
                      placeholder="sk-ant-…"
                      value={settings.anthropicApiKey}
                      onChange={(e) => set('anthropicApiKey')(e.target.value.trim())}
                    />
                  </Row>
                )}
                {settings.aiProvider === 'claude-cli' && (
                  <Row
                    label="Claude Code"
                    hint={
                      <>
                        Uses your Claude Pro or Max plan through the Claude Code app, so requests count toward its usage
                        limits. Install it from <ExtLink href="https://claude.com/claude-code">claude.com/claude-code</ExtLink>,
                        then run <code>claude</code> in Terminal and log in.
                      </>
                    }
                  >
                    <CliStatusLine kind="claude" />
                  </Row>
                )}
                {(settings.aiProvider === 'anthropic' || settings.aiProvider === 'claude-cli') && (
                  <Row label="Model">
                    <select className={input} value={settings.model} onChange={(e) => set('model')(e.target.value)}>
                      {MODELS.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </Row>
                )}
                {settings.aiProvider === 'openai' && (
                  <>
                    <Row
                      label="OpenAI API key"
                      hint={
                        <>
                          Get one at <ExtLink href="https://platform.openai.com/api-keys">platform.openai.com</ExtLink>.
                        </>
                      }
                    >
                      <input
                        type="password"
                        className={input}
                        placeholder="sk-…"
                        value={settings.openaiApiKey}
                        onChange={(e) => set('openaiApiKey')(e.target.value.trim())}
                      />
                    </Row>
                    <Row label="Model" hint="Suggestions come from the models available to your key; any model id can be typed.">
                      <OpenAIModelInput
                        apiKey={settings.openaiApiKey}
                        value={settings.openaiModel}
                        onChange={set('openaiModel')}
                      />
                    </Row>
                  </>
                )}
                {settings.aiProvider === 'codex-cli' && (
                  <>
                    <Row
                      label="Codex"
                      hint={
                        <>
                          Uses your ChatGPT plan through the Codex CLI, so requests count toward its usage limits. Install
                          it with <code>npm i -g @openai/codex</code>, then run <code>codex login</code> in Terminal. Notes
                          appear all at once instead of streaming in.
                        </>
                      }
                    >
                      <CliStatusLine kind="codex" />
                    </Row>
                    <Row label="Model" hint="Leave empty to use the Codex default.">
                      <input
                        className={input}
                        value={settings.codexModel}
                        onChange={(e) => set('codexModel')(e.target.value.trim())}
                        placeholder="Codex default"
                      />
                    </Row>
                  </>
                )}
              </>
            )}

            {tab === 'transcription' && (
              <>
                <Row label="Speech-to-text">
                  <div className="flex gap-2">
                    {(
                      [
                        ['whisper', `Whisper on ${thisComputer}`],
                        ['deepgram', 'Deepgram (cloud)']
                      ] as const
                    ).map(([id, label]) => (
                      <Button
                        key={id}
                        variant={settings.transcriptionProvider === id ? 'primary' : 'outline'}
                        onClick={() => set('transcriptionProvider')(id)}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                </Row>
                {settings.transcriptionProvider === 'whisper' ? (
                  <Row
                    label="Whisper model"
                    hint={
                      isMac
                        ? 'Runs offline on the Neural Engine; no audio leaves your Mac. large-v3 turbo is the most accurate, especially for Russian; smaller models are faster and lighter.'
                        : 'Runs offline with whisper.cpp, on the graphics card when it can; no audio leaves your PC. small keeps up live on any PC; large-v3 turbo is the most accurate, especially for Russian, but needs a fast computer.'
                    }
                  >
                    <WhisperModels selected={settings.whisperModel} onSelect={set('whisperModel')} />
                  </Row>
                ) : (
                  <Row
                    label="Deepgram API key"
                    hint={
                      <>
                        Live speech-to-text. Create a key at{' '}
                        <ExtLink href="https://console.deepgram.com">console.deepgram.com</ExtLink>. Audio is streamed
                        for transcription and never saved.
                      </>
                    }
                  >
                    <input
                      type="password"
                      className={input}
                      value={settings.deepgramApiKey}
                      onChange={(e) => set('deepgramApiKey')(e.target.value.trim())}
                    />
                  </Row>
                )}
                <Row label="Language">
                  <select className={input} value={settings.language} onChange={(e) => set('language')(e.target.value)}>
                    {LANGUAGES.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </Row>
                <Row
                  label="Capture system audio"
                  hint={
                    audioMode === 'loopback'
                      ? 'Transcribes the other people on Zoom, Meet or Teams (“Them”) without a bot joining the call, from what this PC plays on its default output device. If the call plays through a headset, make the headset the default device in Windows sound settings.'
                      : audioMode === 'tap'
                      ? 'Transcribes the other people on Zoom, Meet or Teams (“Them”) without a bot joining the call. Uses Core Audio Tap: only System Audio Recording permission, no screen capture. Your microphone cancels what the Mac plays, so the other side doesn’t leak into “Me” even without headphones.'
                      : 'Transcribes the other people on Zoom, Meet or Teams (“Them”) without a bot joining the call. On this macOS version it needs Screen & System Audio Recording permission.'
                  }
                >
                  <label className="flex items-center gap-2 text-[13px] text-ink-primary">
                    <input
                      type="checkbox"
                      className="accent-[var(--fill-accent)]"
                      checked={settings.captureSystemAudio}
                      onChange={(e) => set('captureSystemAudio')(e.target.checked)}
                    />
                    Enabled
                  </label>
                </Row>
                <Row
                  label="Separate speakers (offline)"
                  hint={
                    <>
                      After you pause or stop, identifies who said what among the other participants (“Speaker 1”, “Speaker
                      2”…) on {isMac ? 'this Mac with FluidAudio' : 'this PC with sherpa-onnx'}.
                      {diarizer === false &&
                        (isMac ? ' Not installed: run npm run build:native.' : ' The audio helper is missing from this build.')}
                    </>
                  }
                >
                  <label className="flex items-center gap-2 text-[13px] text-ink-primary">
                    <input
                      type="checkbox"
                      className="accent-[var(--fill-accent)]"
                      checked={settings.separateSpeakers}
                      disabled={diarizer === false || !settings.captureSystemAudio}
                      onChange={(e) => set('separateSpeakers')(e.target.checked)}
                    />
                    Enabled
                  </label>
                </Row>
                <Row
                  label="Keep audio until processed"
                  hint={`Saves each session’s audio on ${thisComputer} until it has been transcribed and separated, then deletes it. If live transcription drops or the app quits mid-call, the transcript is rebuilt from it with local Whisper.`}
                >
                  <label className="flex items-center gap-2 text-[13px] text-ink-primary">
                    <input
                      type="checkbox"
                      className="accent-[var(--fill-accent)]"
                      checked={settings.keepAudioBackup}
                      disabled={diarizer === false}
                      onChange={(e) => set('keepAudioBackup')(e.target.checked)}
                    />
                    Enabled
                  </label>
                </Row>
                <Row
                  label="Detect meetings"
                  hint={`Offers to take notes when Zoom, Teams, ${isMac ? 'FaceTime, ' : ''}Slack or a browser call starts using the microphone${isMac ? ' (macOS 14.2+)' : ''}. When Oats isn’t in front, a card appears in the top-right corner of the screen.`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <label className="flex items-center gap-2 text-[13px] text-ink-primary">
                      <input
                        type="checkbox"
                        className="accent-[var(--fill-accent)]"
                        checked={settings.detectMeetings}
                        disabled={diarizer === false}
                        onChange={(e) => set('detectMeetings')(e.target.checked)}
                      />
                      Enabled
                    </label>
                    <Button variant="outline" size="sm" onClick={() => window.oats.previewMeetingCard()}>
                      Preview card
                    </Button>
                  </div>
                  {(settings.ignoredMeetingApps ?? []).length > 0 && (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-tertiary">
                      Never ask for:
                      {settings.ignoredMeetingApps.map((id) => (
                        <button
                          key={id}
                          type="button"
                          title="Ask again for this app"
                          onClick={() => set('ignoredMeetingApps')(settings.ignoredMeetingApps.filter((x) => x !== id))}
                          className="cursor-default rounded-md border border-hairline px-1.5 py-0.5 text-ink-secondary hover:bg-fill-soft"
                        >
                          {id} ×
                        </button>
                      ))}
                    </div>
                  )}
                </Row>
                <Row label="Permissions">
                  <PermissionsList kinds={settings.captureSystemAudio ? ['microphone', 'systemAudio'] : ['microphone']} />
                </Row>
              </>
            )}

            {tab === 'calendar' && (
              <Row
                label="Calendar feed (ICS)"
                hint={
                  <>
                    For calendars not on a connected account. Paste a private iCal link. Google Calendar: Settings →
                    your calendar → “Secret address in iCal format”. Outlook: Settings → Calendar → Shared calendars →
                    Publish. Google and Yandex accounts can be connected in{' '}
                    <button
                      type="button"
                      onClick={() => setTab('accounts')}
                      className="cursor-default text-ink-accent underline underline-offset-2"
                    >
                      Accounts
                    </button>
                    .
                  </>
                }
              >
                <div className="flex gap-2">
                  <input
                    className={input}
                    placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
                    value={settings.icsUrl}
                    onChange={(e) => {
                      set('icsUrl')(e.target.value.trim())
                      setCalendarStatus(null)
                    }}
                  />
                  <Button
                    variant="outline"
                    className="h-9"
                    disabled={!settings.icsUrl}
                    onClick={async () => {
                      setCalendarStatus('Checking…')
                      try {
                        const { events, errors } = await window.oats.getCalendarEvents()
                        useStore.getState().setEvents(events, errors)
                        const feedError = errors.find((e) => e.startsWith('Calendar feed: '))
                        setCalendarStatus(feedError ?? `Connected — ${events.length} events in the next week.`)
                      } catch (err) {
                        setCalendarStatus(err instanceof Error ? err.message : String(err))
                      }
                    }}
                  >
                    Test
                  </Button>
                </div>
                {calendarStatus && <div className="text-[12px] text-ink-secondary">{calendarStatus}</div>}
              </Row>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function WhisperModels({ selected, onSelect }: { selected: string; onSelect: (id: string) => void }) {
  const [models, setModels] = useState<WhisperModel[]>([])
  useEffect(() => {
    window.oats.listWhisperModels().then(setModels)
    return window.oats.onWhisperModels(setModels)
  }, [])

  return (
    <div className="flex flex-col gap-1.5">
      {models.map((m) => (
        <div
          key={m.id}
          onClick={() => onSelect(m.id)}
          className={`flex cursor-default items-center gap-3 rounded-xl border px-3 py-2.5 ${selected === m.id ? 'border-ink-accent bg-fill-accent-soft' : 'border-hairline hover:bg-fill-soft'}`}
        >
          <input type="radio" readOnly checked={selected === m.id} className="accent-[var(--fill-accent)]" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-ink-primary">
              {m.label} <span className="font-normal text-ink-tertiary">· {m.size}</span>
            </div>
            {m.status === 'downloading' && (
              <div className="mt-1.5 flex items-center gap-2">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-fill-soft">
                  <div
                    className={`h-full rounded-full bg-fill-accent transition-[width] ${m.stage === 'compile' ? 'animate-pulse' : ''}`}
                    style={{ width: `${Math.round((m.stage === 'compile' ? 1 : (m.progress ?? 0)) * 100)}%` }}
                  />
                </div>
                <span className="text-[11px] text-ink-tertiary tabular-nums">
                  {m.stage === 'compile' ? (isMac ? 'Optimising for this Mac…' : 'Loading…') : `${Math.round((m.progress ?? 0) * 100)}%`}
                </span>
              </div>
            )}
            {m.error && <div className="mt-1 text-[12px] text-ink-danger">{m.error}</div>}
          </div>
          {m.status === 'ready' && <span className="text-[12px] text-ink-accent">Downloaded</span>}
          {m.status === 'missing' && (
            <Button
              variant="outline"
              size="sm"
              onClick={(e) => {
                e.stopPropagation()
                onSelect(m.id)
                window.oats.downloadWhisperModel(m.id)
              }}
            >
              Download
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}

function CliStatusLine({ kind }: { kind: 'claude' | 'codex' }) {
  const [status, setStatus] = useState<CliStatus | null>(null)
  const check = () => {
    setStatus(null)
    window.oats.cliStatus(kind).then(setStatus)
  }
  useEffect(check, [kind])
  return (
    <div className="flex items-center gap-3">
      <div
        className={`min-w-0 flex-1 text-[13px] ${
          !status ? 'text-ink-tertiary' : status.ok ? 'text-ink-primary' : 'text-ink-danger'
        }`}
      >
        {!status ? 'Checking…' : status.ok ? status.detail : status.message}
      </div>
      <Button variant="outline" onClick={check}>
        Check again
      </Button>
    </div>
  )
}

function OpenAIModelInput({
  apiKey,
  value,
  onChange
}: {
  apiKey: string
  value: string
  onChange: (model: string) => void
}) {
  const [models, setModels] = useState<string[]>([])
  useEffect(() => {
    if (!apiKey) {
      setModels([])
      return
    }
    // Debounced so typing a key doesn't fire a request per keystroke.
    const t = window.setTimeout(() => window.oats.listOpenAIModels().then(setModels), 600)
    return () => window.clearTimeout(t)
  }, [apiKey])
  return (
    <>
      <input
        className={input}
        list="openai-models"
        value={value}
        onChange={(e) => onChange(e.target.value.trim())}
        placeholder="gpt-6.1-sol"
      />
      <datalist id="openai-models">
        {models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </>
  )
}
