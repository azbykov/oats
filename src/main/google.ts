import type { AccountCalendar, CalendarEvent } from '../shared/types'
import { ApiError, request, type CalendarApi } from './calendar-api'
import { meetingLink } from './ics'

// Google Calendar API v3 with the calendar.readonly scope.

const API = 'https://www.googleapis.com/calendar/v3'

// Google's consent screen lets the user untick single permissions; without the
// calendar one sign-in succeeds but every Calendar API call is refused.
const NO_CALENDAR_SCOPE =
  'Oats wasn’t allowed to see your calendars. Sign in again and tick the calendar permission on the Google consent screen.'

interface GoogleEvent {
  id: string
  iCalUID?: string
  status?: string
  summary?: string
  description?: string
  location?: string
  hangoutLink?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  attendees?: { email?: string; displayName?: string; self?: boolean; resource?: boolean; responseStatus?: string }[]
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] }
}

async function get<T>(token: string, url: string): Promise<T> {
  try {
    return (await (await request(url, { headers: { Authorization: `Bearer ${token}` } })).json()) as T
  } catch (err) {
    if (err instanceof ApiError && err.status === 403 && /insufficient authentication scopes/i.test(err.message)) {
      throw new ApiError(403, NO_CALENDAR_SCOPE)
    }
    throw err
  }
}

function toEvent(e: GoogleEvent): CalendarEvent | null {
  // All-day entries (holidays, birthdays, out of office) aren't meetings.
  if (e.status === 'cancelled' || !e.start?.dateTime || !e.end?.dateTime) return null
  if (e.attendees?.some((a) => a.self && a.responseStatus === 'declined')) return null
  const start = new Date(e.start.dateTime)
  return {
    // The id an ICS feed gives the same occurrence, so notes stay linked to it
    // when switching from a feed to the account and duplicates merge.
    id: `${e.iCalUID ?? e.id}:${start.getTime()}`,
    title: e.summary || 'Untitled event',
    start: start.toISOString(),
    end: new Date(e.end.dateTime).toISOString(),
    attendees: (e.attendees ?? [])
      .filter((a) => !a.resource && a.email)
      .map((a) => ({ name: a.displayName || a.email!, email: a.email })),
    location: e.location || undefined,
    url:
      e.hangoutLink ??
      e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ??
      meetingLink(`${e.location ?? ''} ${e.description ?? ''}`)
  }
}

export const google: CalendarApi = {
  async profile(token) {
    const me = await get<{ email: string; name?: string; picture?: string }>(
      token,
      'https://openidconnect.googleapis.com/v1/userinfo'
    )
    return { email: me.email, name: me.name || me.email, avatarUrl: me.picture }
  },

  async calendars({ token }) {
    const list = await get<{
      items?: { id: string; summary: string; summaryOverride?: string; backgroundColor?: string; primary?: boolean; selected?: boolean }[]
    }>(token, `${API}/users/me/calendarList?minAccessRole=reader`)
    return (list.items ?? []).map(
      (c): AccountCalendar => ({
        id: c.id,
        name: c.summaryOverride || c.summary,
        color: c.backgroundColor,
        primary: c.primary,
        enabled: true
      })
    )
  },

  async events({ token }, calendarId, from, to) {
    const out: CalendarEvent[] = []
    let pageToken: string | undefined
    do {
      const query = new URLSearchParams({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
        ...(pageToken ? { pageToken } : {})
      })
      const page = await get<{ items?: GoogleEvent[]; nextPageToken?: string }>(
        token,
        `${API}/calendars/${encodeURIComponent(calendarId)}/events?${query}`
      )
      for (const e of page.items ?? []) {
        const event = toEvent(e)
        if (event) out.push(event)
      }
      pageToken = page.nextPageToken
    } while (pageToken)
    return out
  }
}
