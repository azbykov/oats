import { CalendarPlus, Video } from 'lucide-react'
import type { CalendarEvent } from '../../../shared/types'
import { timeLabel } from '../lib/format'
import { shortcut } from '../lib/platform'
import { useStore } from '../lib/store'
import { ChatDock } from './ChatPanel'
import { NoteList } from './NoteList'
import { Avatar, Button } from './ui'

function DateBadge({ date }: { date: Date }) {
  return (
    <div className="flex w-12 shrink-0 flex-col items-center pt-0.5">
      <span className="text-[11px] font-semibold tracking-wide text-ink-danger uppercase">
        {date.toLocaleDateString(undefined, { month: 'short' })}
      </span>
      <span className="font-display text-[26px] leading-none text-ink-strong">{date.getDate()}</span>
      <span className="mt-0.5 text-[11px] text-ink-tertiary">
        {date.toLocaleDateString(undefined, { weekday: 'short' })}
      </span>
    </div>
  )
}

function EventRow({ event }: { event: CalendarEvent }) {
  const { createNoteFromEvent, navigate } = useStore.getState()
  const start = new Date(event.start)
  const end = new Date(event.end)
  const now = Date.now()
  const live = start.getTime() - 5 * 60_000 <= now && now <= end.getTime()

  const open = () => navigate({ view: 'note', id: createNoteFromEvent(event).id })

  return (
    <div
      onClick={open}
      className="group flex cursor-default items-center gap-3 rounded-lg py-1.5 pr-1.5 pl-2 hover:bg-fill-soft"
    >
      <span
        className={`h-8 w-[3px] shrink-0 rounded-full ${live ? 'bg-oats-grass' : 'bg-event-blue'}`}
        style={!live && event.color ? { background: event.color } : undefined}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] text-ink-primary">{event.title}</div>
        <div className="text-[12px] text-ink-tertiary tabular-nums">
          {timeLabel(event.start)} – {timeLabel(event.end)}
        </div>
      </div>
      <span className="hidden -space-x-1.5 sm:flex">
        {event.attendees.slice(0, 3).map((a) => (
          <Avatar key={a.email ?? a.name} name={a.name} />
        ))}
      </span>
      {event.url && (
        <Button
          variant="ghost"
          size="sm"
          className="opacity-0 group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation()
            window.oats.openExternal(event.url!)
            open()
          }}
        >
          <Video size={14} /> Join
        </Button>
      )}
      {live && (
        <Button variant="accent" size="sm" onClick={open}>
          Take notes
        </Button>
      )}
    </div>
  )
}

function ComingUp() {
  const events = useStore((s) => s.events)
  const errors = useStore((s) => s.eventsErrors)
  const hasCalendar = useStore((s) => !!s.data!.settings.icsUrl || s.accounts.length > 0)
  const navigate = useStore((s) => s.navigate)

  const upcoming = events.filter((e) => new Date(e.end).getTime() > Date.now())
  const byDay = new Map<string, CalendarEvent[]>()
  for (const e of upcoming) {
    const key = new Date(e.start).toDateString()
    byDay.set(key, [...(byDay.get(key) ?? []), e])
  }
  const days = [...byDay.entries()].slice(0, 3)

  return (
    <section className="group/coming-up mb-8">
      <h2 className="mb-3 px-1 text-[20px] font-semibold tracking-tight text-ink-strong">Coming up</h2>
      <div className="rounded-2xl border border-hairline bg-surface-elevated p-3 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
        {!hasCalendar && (
          <div className="flex items-center gap-3 p-2">
            <span className="flex size-10 items-center justify-center rounded-xl bg-oats-green-50 text-ink-accent dark:bg-oats-green-700">
              <CalendarPlus size={18} />
            </span>
            <div className="flex-1">
              <div className="text-[14px] font-medium text-ink-primary">Connect your calendar</div>
              <div className="text-[12px] text-ink-tertiary">See upcoming meetings and start notes in one click.</div>
            </div>
            <Button variant="outline" onClick={() => navigate({ view: 'settings', tab: 'accounts' })}>
              Connect
            </Button>
          </div>
        )}
        {hasCalendar &&
          errors.map((error) => (
            <p key={error} className="px-2 py-1 text-[13px] text-ink-danger">
              {error}
            </p>
          ))}
        {hasCalendar && !errors.length && days.length === 0 && (
          <p className="p-2 text-[13px] text-ink-tertiary">No upcoming meetings this week.</p>
        )}
        {days.map(([key, list], i) => (
          <div key={key} className={`flex gap-2 ${i > 0 ? 'mt-2 border-t border-hairline pt-3' : ''}`}>
            <DateBadge date={new Date(list[0].start)} />
            <div className="min-w-0 flex-1">
              {list.map((e) => (
                <EventRow key={e.id} event={e} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

export function Home() {
  const notes = useStore((s) => s.data!.notes)
  const sorted = [...notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  return (
    <div className="flex h-full flex-col">
      <div className="drag h-[52px] shrink-0" />
      <div className="min-h-0 flex-1 overflow-y-auto pb-32">
        <div className="mx-auto w-full max-w-2xl px-6">
          <ComingUp />
          <NoteList notes={sorted} empty={`Your notes will show up here. Press ${shortcut('N')} to start one.`} />
        </div>
      </div>
      <ChatDock scope="all" />
    </div>
  )
}
