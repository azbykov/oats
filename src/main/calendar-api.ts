import type { AccountCalendar, CalendarEvent } from '../shared/types'

/** What each account provider (google.ts, yandex.ts) implements. */
export interface CalendarApi {
  profile(token: string): Promise<Profile>
  calendars(auth: Credentials): Promise<AccountCalendar[]>
  events(auth: Credentials, calendarId: string, from: Date, to: Date): Promise<CalendarEvent[]>
}

/** The OAuth access token, plus a Yandex app password when CalDAV won't take the token. */
export interface Credentials {
  token: string
  email: string
  appPassword?: string
}

export interface Profile {
  email: string
  name: string
  avatarUrl?: string
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export async function request(url: string | URL, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init)
  if (res.ok || res.status === 207) return res
  const body = await res.text().catch(() => '')
  let message = `${new URL(url).host} returned ${res.status}`
  try {
    const json = JSON.parse(body) as { error?: { message?: string } | string; error_description?: string }
    const detail = typeof json.error === 'string' ? json.error_description || json.error : json.error?.message
    if (detail) message = detail
  } catch {
    // not JSON (CalDAV answers in XML)
  }
  throw new ApiError(res.status, message)
}
