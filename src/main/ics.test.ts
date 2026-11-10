import { describe, expect, it } from 'vitest'
import { meetingLink, parseIcs } from './ics'

// vitest.config.ts pins TZ to Europe/Berlin: CET (UTC+1), CEST (UTC+2) from 29 March to 25 October 2026.

/** A local (Berlin) time as the ISO string events carry. */
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString()

const calendar = (...events: string[][]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']), 'END:VCALENDAR'].join(
    '\r\n'
  )

const JAN = [new Date(2026, 0, 1), new Date(2026, 1, 1)] as const
const starts = (text: string, from: Date, to: Date) => parseIcs(text, from, to).map((e) => e.start)

describe('parseIcs: a single event', () => {
  it('reads the title, times, place, link and attendees', () => {
    const [event, ...rest] = parseIcs(
      calendar([
        'UID:abc',
        'SUMMARY:Design review',
        'DTSTART:20260105T090000Z',
        'DTEND:20260105T100000Z',
        'LOCATION:Room 4',
        'DESCRIPTION:Join: https://meet.google.com/abc-defg-hij\\nBring notes',
        'ATTENDEE;CN=Anna Petrova;ROLE=REQ-PARTICIPANT:mailto:anna@example.com',
        'ATTENDEE:MAILTO:boris@example.com'
      ]),
      ...JAN
    )
    expect(rest).toEqual([])
    expect(event).toEqual({
      id: `abc:${Date.UTC(2026, 0, 5, 9)}`,
      title: 'Design review',
      start: '2026-01-05T09:00:00.000Z',
      end: '2026-01-05T10:00:00.000Z',
      attendees: [
        { name: 'Anna Petrova', email: 'anna@example.com' },
        { name: 'boris@example.com', email: 'boris@example.com' }
      ],
      location: 'Room 4',
      url: 'https://meet.google.com/abc-defg-hij'
    })
  })

  it('prefers the URL property over a link in the text', () => {
    const [event] = parseIcs(
      calendar(['UID:a', 'DTSTART:20260105T090000Z', 'URL:https://example.com/call', 'LOCATION:https://zoom.us/j/1']),
      ...JAN
    )
    expect(event.url).toBe('https://example.com/call')
  })

  it('falls back to a half-hour untitled event', () => {
    const [event] = parseIcs(calendar(['DTSTART:20260105T090000Z']), ...JAN)
    expect(event).toMatchObject({ title: 'Untitled event', end: '2026-01-05T09:30:00.000Z', attendees: [] })
    expect(event.location).toBeUndefined()
    expect(event.url).toBeUndefined()
  })

  it('unfolds long lines and unescapes text', () => {
    const [event] = parseIcs(
      calendar(['UID:a', 'DTSTART:20260105T090000Z', 'SUMMARY:Lunch\\, then a very lo', ' ng walk\\; maybe', 'LOCATION:Caf\\\\e', '\tteria']),
      ...JAN
    )
    expect(event.title).toBe('Lunch, then a very long walk; maybe')
    expect(event.location).toBe('Caf\\eteria')
  })

  it('accepts bare line feeds', () => {
    const text = calendar(['UID:a', 'SUMMARY:Unix', 'DTSTART:20260105T090000Z']).replace(/\r\n/g, '\n')
    expect(parseIcs(text, ...JAN).map((e) => e.title)).toEqual(['Unix'])
  })

  it('does not split a property at a colon inside a quoted parameter', () => {
    const [event] = parseIcs(
      calendar(['UID:a', 'DTSTART:20260105T090000Z', 'ATTENDEE;CN="Doe, John: PM";PARTSTAT=ACCEPTED:mailto:john@example.com']),
      ...JAN
    )
    expect(event.attendees).toEqual([{ name: 'Doe, John: PM', email: 'john@example.com' }])
  })

  it('reads property names in any case', () => {
    const [event] = parseIcs(calendar(['uid:a', 'summary:Lower', 'dtstart:20260105T090000Z']), ...JAN)
    expect(event).toMatchObject({ title: 'Lower', start: '2026-01-05T09:00:00.000Z' })
  })

  it('skips cancelled events and events without a start', () => {
    const text = calendar(
      ['UID:a', 'SUMMARY:Off', 'DTSTART:20260105T090000Z', 'STATUS:CANCELLED'],
      ['UID:b', 'SUMMARY:No start'],
      ['UID:c', 'SUMMARY:On', 'DTSTART:20260105T090000Z', 'STATUS:CONFIRMED']
    )
    expect(parseIcs(text, ...JAN).map((e) => e.title)).toEqual(['On'])
  })

  it('returns events sorted by start', () => {
    const text = calendar(
      ['UID:late', 'DTSTART:20260107T090000Z'],
      ['UID:early', 'DTSTART:20260105T090000Z'],
      ['UID:mid', 'DTSTART:20260106T090000Z']
    )
    expect(parseIcs(text, ...JAN).map((e) => e.id.split(':')[0])).toEqual(['early', 'mid', 'late'])
  })

  it('leaves out an event whose dates it cannot read, keeping the rest', () => {
    const text = calendar(
      ['UID:bad', 'DTSTART:next tuesday'],
      ['UID:badend', 'SUMMARY:Bad end', 'DTSTART:20260105T090000Z', 'DTEND:sometime'],
      ['UID:ok', 'SUMMARY:Fine', 'DTSTART:20260106T090000Z']
    )
    expect(parseIcs(text, ...JAN).map((e) => [e.title, e.end])).toEqual([
      ['Bad end', '2026-01-05T09:30:00.000Z'],
      ['Fine', '2026-01-06T09:30:00.000Z']
    ])
  })

  it('returns nothing for text that is not a calendar', () => {
    expect(parseIcs('', ...JAN)).toEqual([])
    expect(parseIcs('<html>Sign in</html>', ...JAN)).toEqual([])
  })
})

describe('parseIcs: times', () => {
  it('reads a time in the zone the event names', () => {
    const text = calendar(
      ['UID:winter', 'DTSTART;TZID=America/New_York:20260105T100000', 'DTEND;TZID=America/New_York:20260105T110000'],
      ['UID:summer', 'DTSTART;TZID=America/New_York:20260706T100000']
    )
    const events = parseIcs(text, new Date(2026, 0, 1), new Date(2026, 11, 31))
    expect(events.map((e) => e.start)).toEqual(['2026-01-05T15:00:00.000Z', '2026-07-06T14:00:00.000Z'])
    expect(events[0].end).toBe('2026-01-05T16:00:00.000Z')
  })

  it('reads a time without a zone, or with one it does not know, as local time', () => {
    const text = calendar(
      ['UID:floating', 'DTSTART:20260105T100000'],
      ['UID:windows', 'DTSTART;TZID=Romance Standard Time:20260106T100000']
    )
    expect(starts(text, ...JAN)).toEqual([local(2026, 1, 5, 10), local(2026, 1, 6, 10)])
  })

  it('marks all-day events, from local midnight to midnight', () => {
    const [event] = parseIcs(
      calendar(['UID:a', 'SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20260105', 'DTEND;VALUE=DATE:20260106']),
      ...JAN
    )
    expect(event).toMatchObject({ allDay: true, start: local(2026, 1, 5), end: local(2026, 1, 6) })
  })

  it('does not mark timed events as all-day', () => {
    const [event] = parseIcs(calendar(['UID:a', 'DTSTART:20260105T000000Z']), ...JAN)
    expect(event).not.toHaveProperty('allDay')
  })
})

describe('parseIcs: the window', () => {
  const event = calendar(['UID:a', 'DTSTART:20260105T090000Z', 'DTEND:20260105T100000Z'])
  const at = (h: number, mi = 0) => new Date(Date.UTC(2026, 0, 5, h, mi))

  it('includes events that overlap it, among them one already under way', () => {
    expect(parseIcs(event, at(8), at(12))).toHaveLength(1)
    expect(parseIcs(event, at(9, 30), at(12))).toHaveLength(1)
    expect(parseIcs(event, at(6), at(9, 15))).toHaveLength(1)
  })

  it('leaves out events that ended before it or start after it', () => {
    expect(parseIcs(event, at(10, 1), at(12))).toEqual([])
    expect(parseIcs(event, at(6), at(8, 59))).toEqual([])
  })

  it('includes a repeating event that is under way when the window opens', () => {
    const daily = calendar(['UID:a', 'DTSTART:20260101T090000Z', 'DTEND:20260101T100000Z', 'RRULE:FREQ=DAILY'])
    expect(starts(daily, at(9, 30), at(12))).toEqual(['2026-01-05T09:00:00.000Z'])
  })
})

describe('parseIcs: repeating events', () => {
  const series = (rrule: string, ...extra: string[]) =>
    calendar(['UID:s', 'SUMMARY:Standup', 'DTSTART:20260105T100000', 'DTEND:20260105T101500', `RRULE:${rrule}`, ...extra])
  const jan = (...days: number[]) => days.map((d) => local(2026, 1, d, 10))

  it('repeats daily, with an interval', () => {
    expect(starts(series('FREQ=DAILY'), new Date(2026, 0, 5), new Date(2026, 0, 9))).toEqual(jan(5, 6, 7, 8))
    expect(starts(series('FREQ=DAILY;INTERVAL=3'), ...JAN)).toEqual(jan(5, 8, 11, 14, 17, 20, 23, 26, 29))
  })

  it('gives each occurrence its own id and the length of the first', () => {
    const events = parseIcs(series('FREQ=DAILY;COUNT=2'), ...JAN)
    expect(events.map((e) => e.id)).toEqual([`s:${new Date(2026, 0, 5, 10).getTime()}`, `s:${new Date(2026, 0, 6, 10).getTime()}`])
    expect(events.map((e) => e.end)).toEqual([local(2026, 1, 5, 10, 15), local(2026, 1, 6, 10, 15)])
    expect(events.map((e) => e.title)).toEqual(['Standup', 'Standup'])
  })

  it('stops after COUNT occurrences, counted from the first one', () => {
    expect(starts(series('FREQ=DAILY;COUNT=3'), ...JAN)).toEqual(jan(5, 6, 7))
    // The window opens after the first two of five.
    expect(starts(series('FREQ=DAILY;COUNT=5'), new Date(2026, 0, 7), new Date(2026, 1, 1))).toEqual(jan(7, 8, 9))
    expect(starts(series('FREQ=DAILY;COUNT=2'), new Date(2026, 0, 7), new Date(2026, 1, 1))).toEqual([])
  })

  it('stops at UNTIL, which is inclusive', () => {
    expect(starts(series('FREQ=DAILY;UNTIL=20260107T090000Z'), ...JAN)).toEqual(jan(5, 6, 7))
    expect(starts(series('FREQ=DAILY;UNTIL=20260107T085959Z'), ...JAN)).toEqual(jan(5, 6))
  })

  it('repeats weekly on the weekday it started', () => {
    expect(starts(series('FREQ=WEEKLY'), ...JAN)).toEqual(jan(5, 12, 19, 26))
    expect(starts(series('FREQ=WEEKLY;INTERVAL=2'), ...JAN)).toEqual(jan(5, 19))
  })

  it('repeats weekly on the days listed, not before the first one', () => {
    // 5 January 2026 is a Monday; the Sunday of that week came before the start.
    expect(starts(series('FREQ=WEEKLY;BYDAY=WE,MO,SU'), new Date(2026, 0, 1), new Date(2026, 0, 16))).toEqual(
      jan(5, 7, 11, 12, 14)
    )
  })

  it('counts weekly occurrences across the days of a week', () => {
    expect(starts(series('FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=4'), ...JAN)).toEqual(jan(5, 7, 9, 12))
    expect(starts(series('FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20260112T090000Z'), ...JAN)).toEqual(jan(5, 7, 9, 12))
  })

  it('repeats monthly on the same day', () => {
    expect(starts(series('FREQ=MONTHLY'), new Date(2026, 0, 1), new Date(2026, 3, 30))).toEqual([
      local(2026, 1, 5, 10),
      local(2026, 2, 5, 10),
      local(2026, 3, 5, 10),
      local(2026, 4, 5, 10)
    ])
  })

  it('leaves out EXDATE occurrences', () => {
    const text = series('FREQ=DAILY;COUNT=5', 'EXDATE:20260106T100000,20260108T100000', 'EXDATE;TZID=Europe/Berlin:20260109T100000')
    expect(starts(text, ...JAN)).toEqual(jan(5, 7))
  })

  it('counts excluded occurrences towards COUNT', () => {
    expect(starts(series('FREQ=DAILY;COUNT=3', 'EXDATE:20260106T100000'), ...JAN)).toEqual(jan(5, 7))
  })

  it('replaces an occurrence with its moved instance', () => {
    const text = calendar(
      ['UID:s', 'SUMMARY:Standup', 'DTSTART:20260105T100000', 'DTEND:20260105T101500', 'RRULE:FREQ=DAILY;COUNT=3'],
      ['UID:s', 'SUMMARY:Standup (moved)', 'RECURRENCE-ID:20260106T100000', 'DTSTART:20260106T150000', 'DTEND:20260106T153000']
    )
    expect(parseIcs(text, ...JAN).map((e) => [e.title, e.start, e.end])).toEqual([
      ['Standup', local(2026, 1, 5, 10), local(2026, 1, 5, 10, 15)],
      ['Standup (moved)', local(2026, 1, 6, 15), local(2026, 1, 6, 15, 30)],
      ['Standup', local(2026, 1, 7, 10), local(2026, 1, 7, 10, 15)]
    ])
  })

  it('drops an occurrence whose instance was cancelled', () => {
    const text = calendar(
      ['UID:s', 'DTSTART:20260105T100000', 'RRULE:FREQ=DAILY;COUNT=3'],
      ['UID:s', 'RECURRENCE-ID:20260106T100000', 'DTSTART:20260106T100000', 'STATUS:CANCELLED']
    )
    expect(starts(text, ...JAN)).toEqual(jan(5, 7))
  })

  it('does not mix up the instances of different series', () => {
    const text = calendar(
      ['UID:one', 'DTSTART:20260105T100000', 'RRULE:FREQ=DAILY;COUNT=2'],
      ['UID:two', 'DTSTART:20260105T100000', 'RRULE:FREQ=DAILY;COUNT=2'],
      ['UID:two', 'RECURRENCE-ID:20260106T100000', 'DTSTART:20260106T120000']
    )
    const ids = parseIcs(text, ...JAN).map((e) => `${e.id.split(':')[0]}@${e.start}`)
    expect(ids).toEqual([
      `one@${local(2026, 1, 5, 10)}`,
      `two@${local(2026, 1, 5, 10)}`,
      `one@${local(2026, 1, 6, 10)}`,
      `two@${local(2026, 1, 6, 12)}`
    ])
  })

  it('does not run away on a series that started years ago', () => {
    const text = calendar(['UID:s', 'DTSTART:20100104T100000', 'RRULE:FREQ=DAILY'])
    expect(starts(text, new Date(2026, 0, 5), new Date(2026, 0, 7))).toEqual(jan(5, 6))
  })
})

describe('parseIcs: repeating events and daylight saving time', () => {
  // Clocks go forward in Berlin on 29 March 2026 and back on 25 October 2026.
  const MARCH = [new Date(2026, 2, 27), new Date(2026, 3, 1)] as const

  it('keeps a daily event at the same local time', () => {
    const text = calendar(['UID:s', 'DTSTART;TZID=Europe/Berlin:20260327T090000', 'RRULE:FREQ=DAILY'])
    expect(starts(text, ...MARCH)).toEqual([27, 28, 29, 30, 31].map((d) => local(2026, 3, d, 9)))
  })

  it('keeps a weekly event at the same local time', () => {
    const text = calendar(['UID:s', 'DTSTART;TZID=Europe/Berlin:20260323T090000', 'RRULE:FREQ=WEEKLY'])
    expect(starts(text, new Date(2026, 2, 23), new Date(2026, 3, 7))).toEqual([
      local(2026, 3, 23, 9),
      local(2026, 3, 30, 9),
      local(2026, 4, 6, 9)
    ])
  })

  it('keeps a late-evening weekly event on its weekday', () => {
    const text = calendar(['UID:s', 'DTSTART:20260323T233000', 'RRULE:FREQ=WEEKLY'])
    expect(starts(text, new Date(2026, 2, 23), new Date(2026, 3, 8))).toEqual([
      local(2026, 3, 23, 23, 30),
      local(2026, 3, 30, 23, 30),
      local(2026, 4, 6, 23, 30)
    ])
  })

  it('keeps an after-midnight weekly event on its weekday when clocks go back', () => {
    const text = calendar(['UID:s', 'DTSTART:20261019T003000', 'RRULE:FREQ=WEEKLY'])
    expect(starts(text, new Date(2026, 9, 19), new Date(2026, 10, 4))).toEqual([
      local(2026, 10, 19, 0, 30),
      local(2026, 10, 26, 0, 30),
      local(2026, 11, 2, 0, 30)
    ])
  })

  it('follows the clock of the event’s own zone, not this computer’s', () => {
    // New York changes on 8 March, three weeks before Berlin: 10:00 there is 16:00, then 15:00 here.
    const text = calendar(['UID:s', 'DTSTART;TZID=America/New_York:20260302T100000', 'RRULE:FREQ=WEEKLY'])
    expect(starts(text, new Date(2026, 2, 1), new Date(2026, 2, 20))).toEqual([
      '2026-03-02T15:00:00.000Z',
      '2026-03-09T14:00:00.000Z',
      '2026-03-16T14:00:00.000Z'
    ])
  })
})

describe('parseIcs: recurrence rules', () => {
  it('skips months that lack the day of a monthly event', () => {
    const text = calendar(['UID:s', 'DTSTART:20260131T100000', 'RRULE:FREQ=MONTHLY'])
    expect(starts(text, new Date(2026, 0, 1), new Date(2026, 5, 1))).toEqual([
      local(2026, 1, 31, 10),
      local(2026, 3, 31, 10),
      local(2026, 5, 31, 10)
    ])
  })

  it('repeats monthly on a weekday, like the second Tuesday', () => {
    const text = calendar(['UID:s', 'DTSTART:20260113T100000', 'RRULE:FREQ=MONTHLY;BYDAY=2TU'])
    expect(starts(text, new Date(2026, 0, 1), new Date(2026, 3, 1))).toEqual([
      local(2026, 1, 13, 10),
      local(2026, 2, 10, 10),
      local(2026, 3, 10, 10)
    ])
  })

  it('repeats yearly', () => {
    const text = calendar(['UID:s', 'DTSTART;VALUE=DATE:20200105', 'RRULE:FREQ=YEARLY'])
    expect(starts(text, ...JAN)).toEqual([local(2026, 1, 5)])
  })

  const YEAR = [new Date(2026, 0, 1), new Date(2026, 11, 31)] as const

  it('repeats on the last Friday of the month', () => {
    const text = calendar(['UID:s', 'DTSTART:20260130T100000', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR'])
    expect(starts(text, new Date(2026, 0, 1), new Date(2026, 3, 1))).toEqual([
      local(2026, 1, 30, 10),
      local(2026, 2, 27, 10),
      local(2026, 3, 27, 10)
    ])
  })

  it('skips months without a fifth weekday', () => {
    // Fifth Fridays of 2026: January, May, July, October.
    const text = calendar(['UID:s', 'DTSTART:20260130T100000', 'RRULE:FREQ=MONTHLY;BYDAY=5FR'])
    expect(starts(text, new Date(2026, 0, 1), new Date(2026, 7, 1))).toEqual([
      local(2026, 1, 30, 10),
      local(2026, 5, 29, 10),
      local(2026, 7, 31, 10)
    ])
  })

  it('repeats on the days of the month listed, counting from the end too', () => {
    const text = calendar(['UID:s', 'DTSTART:20260115T100000', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=15,-1'])
    expect(starts(text, new Date(2026, 0, 1), new Date(2026, 2, 20))).toEqual([
      local(2026, 1, 15, 10),
      local(2026, 1, 31, 10),
      local(2026, 2, 15, 10),
      local(2026, 2, 28, 10),
      local(2026, 3, 15, 10)
    ])
  })

  it('repeats on the last working day of the month', () => {
    const text = calendar(['UID:s', 'DTSTART:20260130T100000', 'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'])
    expect(starts(text, new Date(2026, 0, 1), new Date(2026, 5, 1))).toEqual([
      local(2026, 1, 30, 10),
      local(2026, 2, 27, 10),
      local(2026, 3, 31, 10),
      local(2026, 4, 30, 10),
      local(2026, 5, 29, 10)
    ])
  })

  it('repeats every other month and stops after COUNT', () => {
    const text = calendar(['UID:s', 'DTSTART:20260113T100000', 'RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=2TU;COUNT=3'])
    expect(starts(text, ...YEAR)).toEqual([local(2026, 1, 13, 10), local(2026, 3, 10, 10), local(2026, 5, 12, 10)])
  })

  it('repeats a 29 February event in leap years only', () => {
    const text = calendar(['UID:s', 'DTSTART;VALUE=DATE:20240229', 'RRULE:FREQ=YEARLY'])
    expect(starts(text, new Date(2025, 0, 1), new Date(2029, 0, 1))).toEqual([local(2028, 2, 29)])
  })

  it('repeats yearly on a weekday of a month, every other year', () => {
    // Fourth Thursday of November.
    const text = calendar(['UID:s', 'DTSTART:20241128T100000', 'RRULE:FREQ=YEARLY;INTERVAL=2;BYMONTH=11;BYDAY=4TH'])
    expect(starts(text, new Date(2025, 0, 1), new Date(2029, 0, 1))).toEqual([local(2026, 11, 26, 10), local(2028, 11, 23, 10)])
  })

  it('reads an UNTIL date as through the end of that day', () => {
    const text = calendar(['UID:s', 'DTSTART:20260105T100000', 'RRULE:FREQ=DAILY;UNTIL=20260107'])
    expect(starts(text, ...JAN)).toEqual([5, 6, 7].map((d) => local(2026, 1, d, 10)))
  })

  it('shows an event with a rule it does not know once', () => {
    const text = calendar(['UID:s', 'DTSTART:20260105T100000', 'RRULE:FREQ=HOURLY'])
    expect(starts(text, ...JAN)).toEqual([local(2026, 1, 5, 10)])
  })

  it('treats a zero interval as one instead of hanging', () => {
    const text = calendar(['UID:s', 'DTSTART:20260105T100000', 'RRULE:FREQ=DAILY;INTERVAL=0;COUNT=2'])
    expect(starts(text, ...JAN)).toEqual([local(2026, 1, 5, 10), local(2026, 1, 6, 10)])
  })
})

describe('meetingLink', () => {
  it('finds a call link in free text', () => {
    expect(meetingLink('Join at https://us02web.zoom.us/j/123?pwd=abc now')).toBe('https://us02web.zoom.us/j/123?pwd=abc')
    expect(meetingLink('<a href="https://teams.microsoft.com/l/meetup-join/1">Join</a>')).toBe(
      'https://teams.microsoft.com/l/meetup-join/1'
    )
    expect(meetingLink('https://telemost.yandex.ru/j/42')).toBe('https://telemost.yandex.ru/j/42')
  })

  it('ignores other links and plain text', () => {
    expect(meetingLink('Agenda: https://example.com/doc')).toBeUndefined()
    expect(meetingLink('')).toBeUndefined()
  })
})
