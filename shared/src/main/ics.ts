import type { Attendee, CalendarEvent } from '../common/types'

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

const formatters = new Map<string, Intl.DateTimeFormat | null>()

/** Clock of a named time zone, or null for a name this system doesn't know (e.g. Windows zone names). */
function formatter(timeZone: string) {
  let f = formatters.get(timeZone)
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
    } catch {
      f = null
    }
    formatters.set(timeZone, f)
  }
  return f
}

function tzOffsetMs(date: Date, format: Intl.DateTimeFormat) {
  const parts = format.formatToParts(date)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - date.getTime()
}

/**
 * A date as the calendar wrote it: the clock reading (kept as if it were UTC, so arithmetic
 * on it never meets a clock change) and the zone that reading is in.
 */
interface Wall {
  ms: number
  /** 'UTC', a zone name, or null for this computer's time. */
  zone: string | null
  dateOnly: boolean
}

function parseWall(prop: Prop): Wall | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(prop.value.trim())
  if (!m) return null
  const [, y, mo, d, h = '0', mi = '0', s = '0', z] = m
  const tz = prop.params.TZID
  return {
    ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s),
    zone: z ? 'UTC' : tz && formatter(tz) ? tz : null,
    dateOnly: !m[4]
  }
}

/** The moment a clock reading in a zone stands for. */
function fromWall(ms: number, zone: string | null): Date {
  if (zone === 'UTC') return new Date(ms)
  const format = zone ? formatter(zone) : null
  if (format) return new Date(ms - tzOffsetMs(new Date(ms), format))
  const w = new Date(ms)
  return new Date(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes(), w.getUTCSeconds())
}

function parseDate(prop: Prop): Date {
  const wall = parseWall(prop)
  return wall ? fromWall(wall.ms, wall.zone) : new Date(NaN)
}

const DAY = 86_400_000
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

const numbers = (list: string | undefined) => (list ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n !== 0)

/**
 * Occurrences of a repeating event inside the window. The rule is applied to the event's own
 * clock (the same time of day in its zone, whatever the clocks did in between), and each
 * occurrence is then turned into a moment.
 */
function expand(start: Wall, rrule: string, exdates: Set<number>, from: Date, to: Date): Date[] {
  const rule = Object.fromEntries(rrule.split(';').map((p) => p.split('='))) as Record<string, string>
  const freq = rule.FREQ
  const interval = Math.max(1, Number(rule.INTERVAL) || 1)
  const untilWall = rule.UNTIL ? parseWall({ name: 'UNTIL', params: {}, value: rule.UNTIL }) : null
  // A date alone means through the end of that day.
  const until = untilWall
    ? new Date(fromWall(untilWall.ms, untilWall.zone ?? start.zone).getTime() + (untilWall.dateOnly ? DAY - 1 : 0))
    : null
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity
  const out: Date[] = []
  let n = 0

  // Occurrences well before the window are only counted: no zone has an offset near two days.
  const early = from.getTime() - 2 * DAY
  const at = (wall: number) => (wall < early ? null : fromWall(wall, start.zone))
  /** Whether the series has ended by this clock reading. */
  const over = (wall: number) => {
    if (n >= count) return true
    const d = at(wall)
    return !!d && (d > to || (!!until && d > until))
  }
  /** Takes the occurrence at this clock reading; false once the series is over. */
  const add = (wall: number) => {
    if (over(wall)) return false
    n++
    const d = at(wall)
    if (d && d >= from && !exdates.has(d.getTime())) out.push(d)
    return true
  }

  const first = new Date(start.ms)
  const year = first.getUTCFullYear()
  const month = first.getUTCMonth()
  const time = start.ms - Date.UTC(year, month, first.getUTCDate())
  const byDay = rule.BYDAY?.split(',')
    .map((d) => ({ nth: parseInt(d, 10) || 0, weekday: WEEKDAYS.indexOf(d.slice(-2).toUpperCase()) }))
    .filter((d) => d.weekday >= 0)

  if (freq === 'DAILY') {
    for (let wall = start.ms; add(wall); wall += interval * DAY);
  } else if (freq === 'WEEKLY') {
    const days = byDay?.length ? [...new Set(byDay.map((d) => d.weekday))].sort((a, b) => a - b) : [first.getUTCDay()]
    const firstWeek = start.ms - first.getUTCDay() * DAY
    weeks: for (let week = firstWeek; !over(week); week += interval * 7 * DAY) {
      for (const weekday of days) {
        const wall = week + weekday * DAY
        if (wall < start.ms) continue
        if (!add(wall)) break weeks
      }
    }
  } else if (freq === 'MONTHLY' || freq === 'YEARLY') {
    const monthDays = numbers(rule.BYMONTHDAY)
    const positions = numbers(rule.BYSETPOS)
    const nth = (list: number[], p: number) => list.at(p > 0 ? p - 1 : p)
    const defined = (d: number | undefined): d is number => d !== undefined

    /** Days of one month the rule falls on, in order; a month without the day (the 31st, the fifth Friday) has none. */
    const daysOf = (y: number, m: number) => {
      const length = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
      let days: number[]
      if (byDay?.length) {
        const firstWeekday = new Date(Date.UTC(y, m, 1)).getUTCDay()
        days = byDay.flatMap((rule) => {
          const all: number[] = []
          for (let d = 1 + ((rule.weekday - firstWeekday + 7) % 7); d <= length; d += 7) all.push(d)
          return rule.nth ? [nth(all, rule.nth)].filter(defined) : all
        })
      } else {
        days = (monthDays.length ? monthDays : [first.getUTCDate()])
          .map((d) => (d < 0 ? length + 1 + d : d))
          .filter((d) => d >= 1 && d <= length)
      }
      days = [...new Set(days)].sort((a, b) => a - b)
      return positions.length ? positions.map((p) => nth(days, p)).filter(defined).sort((a, b) => a - b) : days
    }

    const yearly = freq === 'YEARLY'
    const byMonth = numbers(rule.BYMONTH).map((m) => m - 1).sort((a, b) => a - b)
    const months = yearly ? (byMonth.length ? byMonth : [month]) : [month]
    periods: for (let i = 0; ; i += interval) {
      for (const m of months) {
        const y = yearly ? year + i : year
        const mm = yearly ? m : m + i
        if (over(Date.UTC(y, mm, 1))) break periods
        for (const day of daysOf(y, mm)) {
          const wall = Date.UTC(y, mm, day) + time
          if (wall < start.ms) continue
          if (!add(wall)) break periods
        }
      }
    }
  } else {
    const d = fromWall(start.ms, start.zone)
    if (d >= from && d <= to) out.push(d)
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
    const wall = dtstart && parseWall(dtstart)
    // An event whose start can't be read is left out rather than failing the whole calendar.
    if (!dtstart || !wall || get('STATUS')?.value === 'CANCELLED') continue
    const start = fromWall(wall.ms, wall.zone)
    const dtend = get('DTEND')
    const length = dtend ? parseDate(dtend).getTime() - start.getTime() : NaN
    const duration = Number.isNaN(length) ? 30 * 60_000 : length
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
    const starts = rrule ? expand(wall, rrule, exdates, new Date(from.getTime() - duration), to) : [start]
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
