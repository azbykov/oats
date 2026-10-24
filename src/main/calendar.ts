import type { CalendarEvent, CalendarResult } from '../shared/types'
import { accountEvents, listAccounts } from './accounts'
import { eventWindow, fetchEvents } from './ics'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** "Coming up": the ICS feed plus every connected account, merged. */
export async function fetchCalendar(icsUrl: string): Promise<CalendarResult> {
  const { from, to } = eventWindow()
  const errors: string[] = []
  const sources: Promise<CalendarEvent[]>[] = []
  if (icsUrl) {
    sources.push(
      fetchEvents(icsUrl).catch((err) => {
        errors.push(`Calendar feed: ${message(err)}`)
        return []
      })
    )
  }
  for (const account of listAccounts()) {
    sources.push(
      accountEvents(account.id, from, to).catch((err) => {
        errors.push(`${account.email}: ${message(err)}`)
        return []
      })
    )
  }
  // One meeting can appear in several sources (an invite on two accounts, or a
  // feed next to its own account); occurrences share an id, keep the first.
  const byId = new Map<string, CalendarEvent>()
  for (const e of (await Promise.all(sources)).flat()) if (!byId.has(e.id)) byId.set(e.id, e)
  return { events: [...byId.values()].sort((a, b) => a.start.localeCompare(b.start)), errors }
}
