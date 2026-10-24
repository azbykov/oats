import { PhoneCall, PhoneOff, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { MeetingApp } from '../../../shared/types'
import { useStore } from '../lib/store'
import { startTranscription, stopTranscription } from '../lib/transcription'
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

export function MeetingBanner() {
  const apps = useStore((s) => s.meetingApps)
  const enabled = useStore((s) => s.data!.settings.detectMeetings)
  const recording = useStore((s) => s.recording)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [hadCall, setHadCall] = useState(false)

  const live = recording.status === 'recording' || recording.status === 'starting'
  useEffect(() => {
    if (live && apps.length) setHadCall(true)
    if (!live) setHadCall(false)
  }, [live, apps.length])

  if (!enabled) return null
  const app = apps.find((a) => !dismissed.has(a.bundleId))

  if (live && hadCall && !apps.length) {
    return (
      <Banner icon={<PhoneOff size={15} />} text="The call ended" onClose={() => setHadCall(false)}>
        <Button variant="primary" size="sm" onClick={stopTranscription}>
          Stop transcribing
        </Button>
      </Banner>
    )
  }
  if (live || !app) return null
  return (
    <Banner
      icon={<PhoneCall size={15} />}
      text={app.browser ? `${app.name} is using your microphone` : `${app.name} call detected`}
      onClose={() => setDismissed(new Set([...dismissed, app.bundleId]))}
    >
      <Button variant="accent" size="sm" onClick={() => startNotesForMeeting(app)}>
        Take notes
      </Button>
    </Banner>
  )
}

function Banner({
  icon,
  text,
  onClose,
  children
}: {
  icon: ReactNode
  text: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-40 flex justify-center">
      <div className="no-drag pointer-events-auto flex items-center gap-3 rounded-full border border-hairline bg-surface-elevated py-1.5 pr-1.5 pl-4 shadow-lg">
        <span className="text-ink-accent">{icon}</span>
        <span className="text-[13px] text-ink-primary">{text}</span>
        {children}
        <IconButton label="Dismiss" size="sm" onClick={onClose}>
          <X size={13} />
        </IconButton>
      </div>
    </div>
  )
}
