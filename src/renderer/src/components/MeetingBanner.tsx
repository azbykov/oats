import { PhoneOff, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { MeetingApp } from '../../../shared/types'
import { useStore } from '../lib/store'
import { autoStop, silentFor, startTranscription, stopTranscription } from '../lib/transcription'
import { Button, IconButton } from './ui'

/** Starts notes for a detected call, attaching the calendar event that is on now. */
export function startNotesForMeeting(app: MeetingApp, templateId?: string) {
  const { recording, events, navigate, createNote, createNoteFromEvent } = useStore.getState()
  if (recording.noteId && (recording.status === 'recording' || recording.status === 'starting')) {
    navigate({ view: 'note', id: recording.noteId })
    return
  }
  const now = Date.now()
  const live = events.find((e) => new Date(e.start).getTime() - 10 * 60_000 <= now && now <= new Date(e.end).getTime())
  const note = live ? createNoteFromEvent(live) : createNote({ title: app.browser ? '' : `${app.name} call` })
  if (templateId) useStore.getState().updateNote(note.id, { templateId })
  navigate({ view: 'note', id: note.id })
  startTranscription(note.id)
}

/** Keeps the store in sync with meeting detection and handles the notification's "Take notes". */
export function useMeetingDetection() {
  const setMeetingApps = useStore((s) => s.setMeetingApps)
  useEffect(() => {
    window.oats.activeMeetingApps().then(setMeetingApps)
    const offs = [
      window.oats.onMeetingDetected((app) => {
        const apps = useStore.getState().meetingApps
        setMeetingApps([...apps.filter((a) => a.bundleId !== app.bundleId), app])
      }),
      window.oats.onMeetingEnded((app) =>
        setMeetingApps(useStore.getState().meetingApps.filter((a) => a.bundleId !== app.bundleId))
      ),
      window.oats.onMeetingStart(({ app, templateId }) => startNotesForMeeting(app, templateId)),
      // "Don't show for this app" from the floating card.
      window.oats.onMeetingIgnore((app) => {
        const { data, updateSettings, meetingApps } = useStore.getState()
        const ignored = data!.settings.ignoredMeetingApps ?? []
        if (!ignored.includes(app.bundleId)) updateSettings({ ignoredMeetingApps: [...ignored, app.bundleId] })
        setMeetingApps(meetingApps.filter((a) => a.bundleId !== app.bundleId))
      })
    ]
    return () => offs.forEach((off) => off())
  }, [setMeetingApps])
}

const SILENCE_STOP_MS = 15 * 60_000

/** Stops transcription after 15 minutes without speech, and when the computer goes to sleep. */
export function useAutoStop() {
  useEffect(() => {
    const t = window.setInterval(() => {
      const { recording } = useStore.getState()
      // Nothing is heard while Whisper loads its model; that isn't silence.
      if (recording.status === 'recording' && !recording.loadingModel && silentFor() > SILENCE_STOP_MS) {
        autoStop('nothing was said for 15 minutes')
      }
    }, 30_000)
    const off = window.oats.onSystemSuspend(() => autoStop('the computer went to sleep'))
    return () => {
      window.clearInterval(t)
      off()
    }
  }, [])
}

// The call app letting go of the mic isn't proof the call is over: a browser does
// that when you mute yourself. Transcription stops once the other side has also
// been quiet this long; until then the banner counts down and can keep it going.
const CALL_END_GRACE_MS = 60_000

/** Stops transcription when the call it was started for ends. A detected call is offered by the floating card (main/pill.ts). */
export function MeetingBanner() {
  const apps = useStore((s) => s.meetingApps)
  const enabled = useStore((s) => s.data!.settings.detectMeetings)
  const recording = useStore((s) => s.recording)
  const [hadCall, setHadCall] = useState(false)
  const [endedAt, setEndedAt] = useState<number | null>(null)
  const [, setTick] = useState(0)

  const live = recording.status === 'recording' || recording.status === 'starting'
  useEffect(() => {
    if (live && apps.length) setHadCall(true)
    if (!live) setHadCall(false)
  }, [live, apps.length])
  const ended = enabled && live && hadCall && !apps.length
  useEffect(() => {
    setEndedAt(ended ? Date.now() : null)
    if (!ended) return
    const t = window.setInterval(() => setTick((x) => x + 1), 1000)
    return () => window.clearInterval(t)
  }, [ended])

  // Whisper still loading its model hears nothing yet, so it can't tell.
  const stopAt =
    endedAt === null || recording.loadingModel
      ? null
      : Math.max(endedAt, recording.systemAudio ? Date.now() - silentFor('them') : 0) + CALL_END_GRACE_MS
  const left = stopAt === null ? null : stopAt - Date.now()
  useEffect(() => {
    if (left !== null && left <= 0) autoStop('the call ended')
  }, [left])

  if (!ended) return null
  return (
    <Banner
      icon={<PhoneOff size={15} />}
      text={left === null ? 'The call ended' : `The call ended · stopping in ${Math.max(0, Math.ceil(left / 1000))} s`}
      onClose={() => setHadCall(false)}
      closeLabel="Keep transcribing"
    >
      <Button variant="ghost" size="sm" onClick={() => setHadCall(false)}>
        Keep transcribing
      </Button>
      <Button variant="primary" size="sm" onClick={stopTranscription}>
        Stop now
      </Button>
    </Banner>
  )
}

function Banner({
  icon,
  text,
  onClose,
  closeLabel = 'Dismiss',
  children
}: {
  icon: ReactNode
  text: string
  onClose: () => void
  closeLabel?: string
  children: ReactNode
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-40 flex justify-center">
      <div className="no-drag pointer-events-auto flex items-center gap-3 rounded-full border border-hairline bg-surface-elevated py-1.5 pr-1.5 pl-4 shadow-lg">
        <span className="text-ink-accent">{icon}</span>
        <span className="text-[13px] text-ink-primary">{text}</span>
        {children}
        <IconButton label={closeLabel} size="sm" onClick={onClose}>
          <X size={13} />
        </IconButton>
      </div>
    </div>
  )
}
