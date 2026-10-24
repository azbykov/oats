import type { Attendee, CalendarEvent } from '../shared/types'

// Besides signed-in accounts (accounts.ts), Oats accepts a private ICS feed
// URL (Google Calendar → Settings → "Secret address in iCal format"; Outlook →
// Publish calendar). Yandex CalDAV responses are parsed here too.

interface Prop {
  name: string
  params: Record<string, string>
  value: string
}

function unfold(text: string) {
  return text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
}

function parseLine(line: string): Prop | null {
  const colon = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/)
  if (colon < 0) return null
  const [name, ...rawParams] = line.slice(0, colon).split(';')
  const params: Record<string, string> = {}
  for (const p of rawParams) {
    const [k, v = ''] = p.split('=')
    params[k.toUpperCase()] = v.replace(/^"|"$/g, '')
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) }
}

function unescape(v: string) {
  return v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1')
}

function tzOffsetMs(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - date.getTime()
}

function parseDate(prop: Prop): Date {
  const v = prop.value
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v)
  if (!m) return new Date(NaN)
  const [, y, mo, d, h = '0', mi = '0', s = '0', z] = m
  const args = [+y, +mo - 1, +d, +h, +mi, +s] as const
  if (z) return new Date(Date.UTC(...args))
  const tz = prop.params.TZID
  if (tz) {
    try {
      const guess = new Date(Date.UTC(...args))
      return new Date(guess.getTime() - tzOffsetMs(guess, tz))
    } catch {
      // Unknown TZID (e.g. Windows zone names): fall through to local time.
    }
  }
  return new Date(...args)
}

const DAY = 86_400_000
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

function expand(start: Date, rrule: string, exdates: Set<number>, from: Date, to: Date): Date[] {
  const rule = Object.fromEntries(rrule.split(';').map((p) => p.split('='))) as Record<string, string>
  const freq = rule.FREQ
  const interval = Number(rule.INTERVAL || 1)
  const until = rule.UNTIL ? parseDate({ name: 'UNTIL', params: {}, value: rule.UNTIL }) : null
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity
  const byDay = rule.BYDAY?.split(',').map((d) => WEEKDAYS.indexOf(d.slice(-2)))
  const out: Date[] = []
  let n = 0
  const push = (d: Date) => {
    n++
    if (d >= from && d <= to && !exdates.has(d.getTime())) out.push(d)
  }
  const limit = (d: Date) => d > to || (until && d > until) || n >= count

  if (freq === 'DAILY') {
    for (let d = new Date(start); !limit(d); d = new Date(d.getTime() + interval * DAY)) push(d)
  } else if (freq === 'WEEKLY') {
    const days = byDay?.length ? byDay : [start.getDay()]
    const weekStart = new Date(start.getTime() - start.getDay() * DAY)
    for (let w = 0; ; w += interval) {
      const base = new Date(weekStart.getTime() + w * 7 * DAY)
      if (base > to || (until && base > until) || n >= count) break
      for (const wd of [...days].sort()) {
        const d = new Date(base.getTime() + wd * DAY)
        d.setHours(start.getHours(), start.getMinutes(), start.getSeconds())
        if (d < start) continue
        if (limit(d)) break
        push(d)
      }
    }
  } else if (freq === 'MONTHLY' && !byDay) {
    for (let i = 0; ; i += interval) {
      const d = new Date(start)
      d.setMonth(start.getMonth() + i)
      if (limit(d)) break
      push(d)
    }
  } else if (start >= from && start <= to) {
    out.push(start)
  }
  return out
}

export function parseIcs(text: string, from: Date, to: Date): CalendarEvent[] {
  const events: CalendarEvent[] = []
  const overrides = new Map<string, Set<number>>()
  let cur: Prop[] | null = null
  const blocks: Prop[][] = []
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') cur = []
    else if (line === 'END:VEVENT') {
      if (cur) blocks.push(cur)
      cur = null
    } else if (cur) {
      const p = parseLine(line)
      if (p) cur.push(p)
    }
  }

  // RECURRENCE-ID instances replace the matching occurrence of the series.
  for (const props of blocks) {
    const rid = props.find((p) => p.name === 'RECURRENCE-ID')
    const uid = props.find((p) => p.name === 'UID')?.value
    if (rid && uid) {
      const set = overrides.get(uid) ?? new Set<number>()
      set.add(parseDate(rid).getTime())
      overrides.set(uid, set)
    }
  }

  for (const props of blocks) {
    const get = (n: string) => props.find((p) => p.name === n)
    const dtstart = get('DTSTART')
    if (!dtstart || get('STATUS')?.value === 'CANCELLED') continue
    const start = parseDate(dtstart)
    const dtend = get('DTEND')
    const duration = dtend ? parseDate(dtend).getTime() - start.getTime() : 30 * 60_000
    const uid = get('UID')?.value ?? `${start.getTime()}`
    const attendees: Attendee[] = props
      .filter((p) => p.name === 'ATTENDEE')
      .map((p) => {
        const email = p.value.replace(/^mailto:/i, '')
        return { name: p.params.CN || email, email }
      })
    const description = unescape(get('DESCRIPTION')?.value ?? '')
    const location = unescape(get('LOCATION')?.value ?? '')
    const url = get('URL')?.value || meetingLink(`${location} ${description}`)

    const rrule = get('RRULE')?.value
    const exdates = new Set<number>(overrides.get(uid) && !get('RECURRENCE-ID') ? overrides.get(uid) : [])
    for (const ex of props.filter((p) => p.name === 'EXDATE')) {
      for (const v of ex.value.split(',')) exdates.add(parseDate({ ...ex, value: v }).getTime())
    }
    const starts = rrule ? expand(start, rrule, exdates, new Date(from.getTime() - duration), to) : [start]
    for (const s of starts) {
      const e = new Date(s.getTime() + duration)
      if (e < from || s > to) continue
      events.push({
        id: `${uid}:${s.getTime()}`,
        title: unescape(get('SUMMARY')?.value ?? 'Untitled event'),
        start: s.toISOString(),
        end: e.toISOString(),
        attendees,
        location: location || undefined,
        url,
        ...(/^\d{8}$/.test(dtstart.value) ? { allDay: true } : {})
      })
    }
  }
  return events.sort((a, b) => a.start.localeCompare(b.start))
}

/** Video call link in free text (location, description). */
export function meetingLink(text: string) {
  return /(https:\/\/[^\s"<>]*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|telemost\.yandex\.ru)[^\s"<>]*)/.exec(
    text
  )?.[1]
}

/** Today and the next week: what "Coming up" shows. */
export function eventWindow() {
  const from = new Date()
  from.setHours(0, 0, 0, 0)
  return { from, to: new Date(from.getTime() + 8 * DAY) }
}

export async function fetchEvents(url: string): Promise<CalendarEvent[]> {
  if (!url) return []
  const res = await fetch(url.replace(/^webcal:/i, 'https:'))
  if (!res.ok) throw new Error(`Calendar feed returned ${res.status}`)
  const { from, to } = eventWindow()
  return parseIcs(await res.text(), from, to)
}
