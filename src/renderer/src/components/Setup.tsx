import { Check, CircleAlert, Circle, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { PermissionKind } from '../../../shared/types'
import { isMac, thisComputer } from '../lib/platform'
import {
  checkCli,
  refreshSetup,
  SETUP_STEPS,
  stepState,
  useProbe,
  useSetup,
  type CheckState,
  type SetupItem,
  type SetupStep
} from '../lib/setup'
import { useStore } from '../lib/store'
import { AccountsSettings } from './Accounts'
import { GrainSpinner } from './Logo'
import { PermissionRow } from './Permissions'
import { ExtLink, input, WhisperModels } from './SettingsView'
import { Button, IconButton } from './ui'

function StateIcon({ state, required = true }: { state: CheckState | null; required?: boolean }) {
  if (state === 'ok') return <Check size={14} className="text-ink-accent" />
  if (state === 'working' || state === 'checking') return <GrainSpinner className="size-3.5 text-ink-tertiary" />
  if (state === 'todo' && required) return <CircleAlert size={14} className="text-ink-danger" />
  return <Circle size={14} className="text-ink-tertiary" />
}

/** Every check with a way to fix it: Settings → Setup and the wizard's last step. */
export function SetupChecklist({ onFix }: { onFix?: (item: SetupItem) => void }) {
  const { items } = useSetup()
  const openSetup = useStore((s) => s.openSetup)
  const fix = onFix ?? ((item: SetupItem) => openSetup(item.step))
  const row = (item: SetupItem) => (
    <div key={item.id} className="flex items-center gap-3 py-2">
      <span className="flex size-5 shrink-0 items-center justify-center">
        <StateIcon state={item.state} required={item.required} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink-primary">{item.title}</div>
        <div className={`text-[12px] leading-snug ${item.required && item.state === 'todo' ? 'text-ink-danger' : 'text-ink-tertiary'}`}>
          {item.detail}
        </div>
      </div>
      {item.state === 'todo' && (
        <Button variant={item.required ? 'accent' : 'outline'} size="sm" onClick={() => fix(item)}>
          {item.required ? 'Fix' : 'Set up'}
        </Button>
      )}
    </div>
  )
  const required = items.filter((i) => i.required)
  const optional = items.filter((i) => !i.required)
  return (
    <div>
      <div className="divide-y divide-hairline">{required.map(row)}</div>
      {optional.length > 0 && (
        <>
          <div className="mt-3 mb-1 text-[11px] font-medium tracking-wide text-ink-tertiary uppercase">Recommended</div>
          <div className="divide-y divide-hairline">{optional.map(row)}</div>
        </>
      )}
    </div>
  )
}

/** Sidebar card when something required stopped working after setup (a permission, a model, a login). */
export function SetupCard() {
  const completed = useStore((s) => s.data!.settings.setupCompleted)
  const wizardOpen = useStore((s) => s.setupStep !== null)
  const openSetup = useStore((s) => s.openSetup)
  const { attention } = useSetup()
  const [dismissed, setDismissed] = useState<string | null>(null)
  const key = attention.map((i) => `${i.id}:${i.detail}`).join('|')
  if (!completed || wizardOpen || !attention.length || dismissed === key) return null
  return (
    <div className="mx-2 mb-2 rounded-xl border border-hairline bg-surface-elevated p-3 shadow-sm">
      <div className="flex items-start gap-2.5">
        <CircleAlert size={15} className="mt-0.5 shrink-0 text-ink-danger" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-ink-strong">Oats needs attention</div>
          <div className="text-[12px] leading-snug text-ink-tertiary">
            {attention.length === 1 ? attention[0].detail : attention.map((i) => i.title).join(', ')}
          </div>
        </div>
        <IconButton label="Dismiss" size="sm" onClick={() => setDismissed(key)}>
          <X size={13} />
        </IconButton>
      </div>
      <Button variant="accent" size="sm" className="mt-2.5 w-full" onClick={() => openSetup(attention[0].step)}>
        Fix
      </Button>
    </div>
  )
}

/**
 * First launch: opens the wizard unless everything required already works (then
 * setup counts as done). Later launches leave problems to the sidebar card.
 */
export function useFirstRun() {
  const completed = useStore((s) => s.data!.settings.setupCompleted)
  const { settled, ready } = useSetup()
  const decided = useRef(false)
  useEffect(() => {
    if (completed || decided.current || !settled) return
    decided.current = true
    const { openSetup, updateSettings } = useStore.getState()
    if (ready) updateSettings({ setupCompleted: true })
    else openSetup('permissions')
  }, [completed, settled, ready])
}

// ---- wizard ----

function ProviderButtons<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: readonly (readonly [T, string])[]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(([id, label]) => (
        <Button key={id} variant={value === id ? 'primary' : 'outline'} onClick={() => onChange(id)}>
          {label}
        </Button>
      ))}
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="text-[13px] font-medium text-ink-primary">{title}</div>
      {children}
      {hint && <div className="text-[12px] leading-snug text-ink-tertiary">{hint}</div>}
    </div>
  )
}

function PermissionsStep() {
  const settings = useStore((s) => s.data!.settings)
  const update = useStore((s) => s.updateSettings)
  const permissions = useProbe((s) => s.permissions)
  const request = async (kind: PermissionKind) => {
    await window.oats.requestPermission(kind)
    refreshSetup()
  }
  const kinds: PermissionKind[] = settings.captureSystemAudio ? ['microphone', 'systemAudio'] : ['microphone']
  return (
    <>
      <div className="divide-y divide-hairline">
        {kinds.map((k) => (
          <PermissionRow key={k} kind={k} state={permissions?.[k]} onRequest={request} />
        ))}
      </div>
      <label className="mt-3 flex items-start gap-2 text-[13px] text-ink-primary">
        <input
          type="checkbox"
          className="mt-0.5 accent-[var(--fill-accent)]"
          checked={settings.captureSystemAudio}
          onChange={(e) => update({ captureSystemAudio: e.target.checked })}
        />
        <span>
          Transcribe the other participants
          <span className="block text-[12px] leading-snug text-ink-tertiary">
            Records what Zoom, Meet or Teams plays, without a bot joining the call. Off: only your microphone.
          </span>
        </span>
      </label>
      {isMac && (
        <p className="mt-3 text-[12px] leading-snug text-ink-tertiary">
          After allowing in System Settings, come back here: the status updates by itself.
        </p>
      )}
    </>
  )
}

function TranscriptionStep() {
  const settings = useStore((s) => s.data!.settings)
  const update = useStore((s) => s.updateSettings)
  const native = useProbe((s) => s.native)
  return (
    <>
      <Section title="Speech-to-text">
        <ProviderButtons
          value={settings.transcriptionProvider}
          options={[
            ['whisper', `Whisper on ${thisComputer}`],
            ['deepgram', 'Deepgram (cloud)']
          ]}
          onChange={(transcriptionProvider) => update({ transcriptionProvider })}
        />
      </Section>
      {settings.transcriptionProvider === 'whisper' ? (
        native === false ? (
          <p className="text-[13px] text-ink-danger">
            {import.meta.env.DEV
              ? 'The audio helper isn’t built. Run npm run build:native and restart Oats.'
              : 'The audio helper is missing from this build. Reinstall Oats or use Deepgram.'}
          </p>
        ) : (
          <Section
            title="Whisper model"
            hint="Pick one and download it. It keeps downloading in the background while you continue; audio never leaves this computer."
          >
            <WhisperModels selected={settings.whisperModel} onSelect={(whisperModel) => update({ whisperModel })} />
          </Section>
        )
      ) : (
        <Section
          title="Deepgram API key"
          hint={
            <>
              Create one at <ExtLink href="https://console.deepgram.com">console.deepgram.com</ExtLink>. Audio is streamed
              for transcription and never saved.
            </>
          }
        >
          <input
            type="password"
            className={input}
            value={settings.deepgramApiKey}
            onChange={(e) => update({ deepgramApiKey: e.target.value.trim() })}
          />
        </Section>
      )}
    </>
  )
}

function CliCheck({ kind }: { kind: 'claude' | 'codex' }) {
  const status = useProbe((s) => s.cli[kind])
  return (
    <div className="flex items-center gap-3">
      <div
        className={`min-w-0 flex-1 text-[13px] ${!status ? 'text-ink-tertiary' : status.ok ? 'text-ink-primary' : 'text-ink-danger'}`}
      >
        {!status ? 'Checking…' : status.ok ? status.detail : status.message}
      </div>
      <Button variant="outline" size="sm" onClick={() => checkCli(kind, true)}>
        Check again
      </Button>
    </div>
  )
}

function AiStep() {
  const settings = useStore((s) => s.data!.settings)
  const update = useStore((s) => s.updateSettings)
  return (
    <>
      <Section title="AI provider" hint="Writes the notes from the transcript and answers questions about your meetings.">
        <ProviderButtons
          value={settings.aiProvider}
          options={[
            ['claude-cli', 'Claude subscription'],
            ['codex-cli', 'ChatGPT subscription'],
            ['anthropic', 'Claude API'],
            ['openai', 'OpenAI API']
          ]}
          onChange={(aiProvider) => update({ aiProvider })}
        />
      </Section>
      {settings.aiProvider === 'anthropic' && (
        <Section
          title="Anthropic API key"
          hint={
            <>
              Get one at <ExtLink href="https://console.anthropic.com/settings/keys">console.anthropic.com</ExtLink>.
            </>
          }
        >
          <input
            type="password"
            className={input}
            placeholder="sk-ant-…"
            value={settings.anthropicApiKey}
            onChange={(e) => update({ anthropicApiKey: e.target.value.trim() })}
          />
        </Section>
      )}
      {settings.aiProvider === 'openai' && (
        <Section
          title="OpenAI API key"
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
            onChange={(e) => update({ openaiApiKey: e.target.value.trim() })}
          />
        </Section>
      )}
      {settings.aiProvider === 'claude-cli' && (
        <Section
          title="Claude Code"
          hint={
            <>
              Install it from <ExtLink href="https://claude.com/claude-code">claude.com/claude-code</ExtLink>, then run{' '}
              <code>claude</code> in Terminal and log in.
            </>
          }
        >
          <CliCheck kind="claude" />
        </Section>
      )}
      {settings.aiProvider === 'codex-cli' && (
        <Section
          title="Codex"
          hint={
            <>
              Install it with <code>npm i -g @openai/codex</code>, then run <code>codex login</code> in Terminal.
            </>
          }
        >
          <CliCheck kind="codex" />
        </Section>
      )}
    </>
  )
}

function CalendarStep() {
  return (
    <>
      <AccountsSettings />
      <p className="mt-3 text-[12px] leading-snug text-ink-tertiary">
        Optional. Oats only reads calendars. Another calendar can be added by its iCal link in Settings → Calendar.
      </p>
    </>
  )
}

function DoneStep({ onFix }: { onFix: (step: SetupStep) => void }) {
  const update = useStore((s) => s.updateSettings)
  return (
    <SetupChecklist
      onFix={(item) => {
        // Extras are one click; everything else goes back to its step.
        if (item.id === 'search') window.oats.downloadSemanticModel()
        else if (item.id === 'meetings') update({ detectMeetings: true })
        else onFix(item.step)
      }}
    />
  )
}

const STEP_COPY: Record<SetupStep, { title: string; hint: string }> = {
  permissions: { title: 'Let Oats hear the meeting', hint: 'Your microphone is “Me”; system audio is everyone else on the call.' },
  transcription: { title: 'Choose how speech becomes text', hint: 'Local Whisper is private and free; Deepgram is cloud and needs a key.' },
  ai: { title: 'Connect the AI that writes your notes', hint: 'A subscription you already pay for works, or an API key.' },
  calendar: { title: 'See your meetings coming up', hint: 'Notes start with the meeting’s title and people already filled in.' },
  done: { title: 'You’re set', hint: 'Everything Oats needs, at a glance. This list is always in Settings → Setup.' }
}

export function SetupWizard() {
  const step = useStore((s) => s.setupStep)
  const openSetup = useStore((s) => s.openSetup)
  const update = useStore((s) => s.updateSettings)
  const { items, ready } = useSetup()
  if (!step) return null
  const index = SETUP_STEPS.findIndex((s) => s.id === step)
  const last = index === SETUP_STEPS.length - 1
  const finish = () => {
    update({ setupCompleted: true })
    openSetup(null)
  }
  const { title, hint } = STEP_COPY[step]
  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-surface-window">
      <div className="drag h-[52px] shrink-0" />
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 gap-6 px-6 pb-8">
        <nav className="flex w-44 shrink-0 flex-col gap-0.5 pt-1">
          <div className="mb-3 px-2.5 font-display text-[22px] tracking-tight text-ink-strong">Set up Oats</div>
          {SETUP_STEPS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => openSetup(s.id)}
              className={`flex h-8 cursor-default items-center gap-2 rounded-lg px-2.5 text-left text-[13px] ${s.id === step ? 'bg-fill-soft font-medium text-ink-strong' : 'text-ink-secondary hover:bg-fill-soft'}`}
            >
              <span className="flex size-4 items-center justify-center">
                <StateIcon state={s.id === 'done' ? (ready ? 'ok' : null) : stepState(items, s.id)} />
              </span>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="flex min-h-0 flex-1 flex-col rounded-2xl border border-hairline bg-surface-elevated">
          <div className="flex items-start justify-between gap-3 px-6 pt-5">
            <div>
              <h2 className="font-display text-[22px] tracking-tight text-ink-strong">{title}</h2>
              <p className="mt-1 text-[13px] leading-snug text-ink-tertiary">{hint}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={finish}>
              {last ? 'Close' : 'Skip setup'}
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {step === 'permissions' && <PermissionsStep />}
            {step === 'transcription' && <TranscriptionStep />}
            {step === 'ai' && <AiStep />}
            {step === 'calendar' && <CalendarStep />}
            {step === 'done' && <DoneStep onFix={openSetup} />}
          </div>
          <div className="flex items-center justify-between border-t border-hairline px-6 py-3">
            <Button variant="ghost" disabled={index === 0} onClick={() => openSetup(SETUP_STEPS[index - 1].id)}>
              Back
            </Button>
            {last ? (
              <Button variant="accent" onClick={finish}>
                {ready ? 'Start using Oats' : 'Finish later'}
              </Button>
            ) : (
              <Button variant="accent" onClick={() => openSetup(SETUP_STEPS[index + 1].id)}>
                {step === 'calendar' ? 'Continue' : stepState(items, step) === 'todo' ? 'Skip for now' : 'Continue'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
