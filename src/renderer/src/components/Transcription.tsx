import { AlertCircle, Copy, Pause, Play, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Note, TranscriptSegment } from '../../../shared/types'
import { clock, mergeTranscript, transcriptText } from '../lib/format'
import { elapsedMs, startTranscription, stopTranscription } from '../lib/transcription'
import { useStore } from '../lib/store'
import { Button, DancingBars, IconButton } from './ui'

export function useTicker(active: boolean) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = window.setInterval(() => setTick((x) => x + 1), 1000)
    return () => window.clearInterval(t)
  }, [active])
}

export function TranscribePill({ note, onToggleTranscript }: { note: Note; onToggleTranscript: () => void }) {
  const recording = useStore((s) => s.recording)
  const level = useStore((s) => s.level)
  const navigate = useStore((s) => s.navigate)
  const isThis = recording.noteId === note.id
  const live = isThis && (recording.status === 'recording' || recording.status === 'starting')
  const error = isThis && recording.status === 'error'
  const elsewhere = !isThis && recording.status === 'recording'
  useTicker(live)

  const hasTranscript = note.transcript.length > 0
  const wantsSystemAudio = useStore((s) => s.data!.settings.captureSystemAudio)
  const micOnly = isThis && recording.status === 'recording' && wantsSystemAudio && !recording.systemAudio
  const loadingModel = isThis && recording.status === 'recording' && recording.loadingModel
  const autoStopped = isThis && recording.status === 'paused' ? recording.autoStopped : undefined
  const setRecording = useStore((s) => s.setRecording)

  return (
    <div className="relative">
      {autoStopped ? (
        <div className="absolute bottom-full left-0 mb-2 flex w-max max-w-80 items-center gap-1 rounded-full border border-hairline bg-surface-elevated py-1 pr-1 pl-3 text-[12px] text-ink-secondary shadow-md">
          Transcription stopped: {autoStopped}
          <IconButton label="Dismiss" size="sm" onClick={() => setRecording({ autoStopped: undefined })}>
            <X size={12} />
          </IconButton>
        </div>
      ) : loadingModel ? (
        <div className="absolute bottom-full left-0 mb-2 w-max max-w-80 rounded-2xl border border-hairline bg-surface-elevated px-3 py-1.5 text-[12px] leading-snug text-ink-secondary shadow-md">
          <span className="shimmer-text">Preparing the Whisper model…</span> Audio is being recorded; the transcript
          will catch up.
        </div>
      ) : micOnly && (
        <div className="absolute bottom-full left-0 mb-2 flex w-max items-center gap-2 rounded-full border border-hairline bg-surface-elevated py-1 pr-1 pl-3 text-[12px] text-ink-secondary shadow-md">
          Only your mic is being transcribed
          <Button
            variant="accent"
            size="sm"
            className="rounded-full"
            onClick={() => window.oats.requestPermission('systemAudio')}
          >
            Allow system audio
          </Button>
        </div>
      )}
      <div className="flex h-12 shrink-0 items-center rounded-full border border-hairline bg-surface-elevated p-1 shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
        <button
          type="button"
          aria-label="Show transcript"
          onClick={onToggleTranscript}
          className="flex h-10 cursor-default items-center gap-2 rounded-full px-3 hover:bg-fill-soft"
        >
          {error ? <AlertCircle size={16} className="text-ink-danger" /> : <DancingBars active={live} level={level} />}
          {live && <span className="text-[12px] text-ink-secondary tabular-nums">{clock(elapsedMs())}</span>}
          {!live && !error && hasTranscript && <span className="text-[12px] text-ink-tertiary">Transcript</span>}
        </button>
        {error ? (
          <button
            type="button"
            title={recording.error}
            onClick={() => navigate({ view: 'settings', tab: 'transcription' })}
            className="h-10 max-w-56 cursor-default truncate rounded-full px-3 text-[12px] text-ink-danger hover:bg-fill-soft"
          >
            {recording.error}
          </button>
        ) : live ? (
          <IconButton label="Pause transcription" className="size-10 rounded-full" onClick={stopTranscription}>
            <Pause size={15} fill="currentColor" />
          </IconButton>
        ) : (
          <button
            type="button"
            onClick={() => startTranscription(note.id)}
            className="flex h-10 cursor-default items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-ink-primary hover:bg-fill-soft"
            title={elsewhere ? 'Stops transcription in the other note' : undefined}
          >
            <Play size={13} fill="currentColor" />
            {hasTranscript ? 'Resume' : 'Transcribe'}
          </button>
        )}
      </div>
    </div>
  )
}

export function TranscriptDrawer({ note, onClose }: { note: Note; onClose: () => void }) {
  const partials = useStore((s) => s.partials)
  const recording = useStore((s) => s.recording)
  const live = recording.noteId === note.id && recording.status === 'recording'
  const loadingModel = live && recording.loadingModel
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [note.transcript.length, partials])

  const diarizing = useStore((s) => s.diarizing[note.id])
  const renameSpeaker = useStore((s) => s.renameSpeaker)
  const lines = mergeTranscript(note.transcript)

  const deleteLine = useStore((s) => s.deleteTranscriptLine)
  const [confirming, setConfirming] = useState<string | null>(null)

  const bubble = (speaker: 'me' | 'them', text: string, key: string, partial?: boolean, line?: TranscriptSegment) => (
    <div
      key={key}
      onMouseLeave={() => confirming === key && setConfirming(null)}
      className={`group flex items-center gap-1 ${speaker === 'me' ? 'flex-row-reverse' : ''}`}
    >
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-1.5 text-[13px] leading-snug ${
          speaker === 'me'
            ? 'rounded-br-md bg-oats-green-100 text-oats-green-700 dark:bg-oats-green-600 dark:text-oats-green-50'
            : 'rounded-bl-md bg-fill-soft text-ink-primary'
        } ${partial ? 'opacity-60' : ''}`}
      >
        {text}
      </div>
      {line &&
        (confirming === key ? (
          <button
            type="button"
            onClick={() => {
              setConfirming(null)
              deleteLine(note.id, line)
            }}
            className="h-6 shrink-0 cursor-default rounded-md px-1.5 text-[11px] font-medium text-ink-danger hover:bg-fill-soft"
          >
            Delete
          </button>
        ) : (
          <IconButton
            label="Delete from transcript"
            size="sm"
            className="opacity-0 group-hover:opacity-100"
            onClick={() => setConfirming(key)}
          >
            <Trash2 size={12} />
          </IconButton>
        ))}
    </div>
  )

  return (
    <div className="absolute top-[52px] right-3 bottom-[148px] z-30 flex w-[360px] flex-col rounded-2xl border border-hairline bg-surface-elevated shadow-xl">
      <div className="flex items-center justify-between border-b border-hairline px-4 py-2.5">
        <div>
          <div className="text-[13px] font-medium text-ink-primary">Transcript</div>
          <div className="text-[11px] text-ink-tertiary">
            {loadingModel ? (
              <span className="shimmer-text">Preparing the Whisper model…</span>
            ) : live ? (
              recording.systemAudio ? (
                'Listening to your mic and system audio'
              ) : (
                'Listening to your mic only'
              )
            ) : diarizing?.status === 'running' ? (
              <span className="shimmer-text">{diarizing.message ?? 'Processing audio…'}</span>
            ) : diarizing?.status === 'error' ? (
              <span className="text-ink-danger" title={diarizing.message}>
                {diarizing.message?.startsWith('Download')
                  ? 'Recovery needs a Whisper model'
                  : 'Audio processing failed'}
              </span>
            ) : note.speakers?.length ? (
              `${note.speakers.length + 1} speakers`
            ) : (
              `${lines.length} lines`
            )}
          </div>
        </div>
        <div className="flex items-center gap-0.5">
          <IconButton
            label="Copy transcript"
            size="sm"
            disabled={!note.transcript.length}
            onClick={() => navigator.clipboard.writeText(transcriptText(note))}
          >
            <Copy size={13} />
          </IconButton>
          <IconButton label="Close transcript" size="sm" onClick={onClose}>
            <X size={14} />
          </IconButton>
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 py-3 select-text"
      >
        {!note.transcript.length && !partials.me && !partials.them && (
          <p className="px-4 py-10 text-center text-[13px] leading-relaxed text-ink-tertiary">
            {loadingModel
              ? 'Recording. Whisper is still preparing its model — after an update this can take several minutes on the first run. The transcript catches up once it’s ready.'
              : live
              ? 'Listening… start talking.'
              : 'Press Transcribe to capture this conversation. Audio is never stored.'}
          </p>
        )}
        {lines.map((s, i) => {
          const sp = s.speaker === 'them' ? note.speakers?.find((x) => x.id === s.speakerId) : undefined
          const prev = lines[i - 1]
          const showName = sp && (prev?.speakerId !== s.speakerId || prev?.speaker !== 'them')
          return (
            <div key={s.id}>
              {showName && <SpeakerLabel name={sp.name} onRename={(name) => renameSpeaker(note.id, sp.id, name)} />}
              {bubble(s.speaker, s.text, s.id, false, s)}
            </div>
          )
        })}
        {live && partials.them && bubble('them', partials.them, 'p-them', true)}
        {live && partials.me && bubble('me', partials.me, 'p-me', true)}
      </div>
      <div className="flex justify-between border-t border-hairline px-4 py-2 text-[11px] text-ink-tertiary">
        <span>Them</span>
        <span>Me</span>
      </div>
    </div>
  )
}

function SpeakerLabel({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0)
  const commit = () => {
    if (value.trim() && value.trim() !== name) onRename(value.trim())
    setEditing(false)
  }
  return (
    <div className="mt-2 mb-0.5 flex items-center gap-1.5 pl-1 text-[11px] font-medium text-ink-secondary">
      <span className="size-1.5 rounded-full" style={{ background: `oklch(0.65 0.12 ${hue})` }} />
      {editing ? (
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setEditing(false)
          }}
          className="h-5 w-32 rounded border border-hairline bg-fill-input px-1 text-[11px] outline-none"
        />
      ) : (
        <button
          type="button"
          title="Rename speaker"
          onClick={() => {
            setValue(name)
            setEditing(true)
          }}
          className="cursor-default rounded px-0.5 hover:bg-fill-soft hover:text-ink-primary"
        >
          {name}
        </button>
      )}
    </div>
  )
}
