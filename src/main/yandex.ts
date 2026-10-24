import type { AccountCalendar } from '../shared/types'
import { ApiError, request, type CalendarApi, type Credentials } from './calendar-api'
import { parseIcs } from './ics'

// Yandex Calendar has no REST API; it is read over CalDAV. Yandex documents
// CalDAV with an OAuth token only for Yandex 360 organisations, and not the
// header form, so each form is tried; personal accounts may need an app
// password (id.yandex.ru → Security → App passwords → Calendar) instead.
// The profile comes from Yandex ID.

const DAV = 'https://caldav.yandex.ru'

const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>'
const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:ical="http://apple.com/ns/ical/"'
const propfind = (props: string) => `${XML_HEAD}<d:propfind ${NS}><d:prop>${props}</d:prop></d:propfind>`

// A multistatus reply is small and flat enough for patterns; any namespace prefix is accepted.
const element = (name: string) =>
  new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>)`, 'i')

/** Raw inner XML of the first `name` element. */
const inner = (xml: string | undefined, name: string) => (xml ? element(name).exec(xml)?.[1] : undefined)

function decode(text: string) {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(text)
  if (cdata) return cdata[1]
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
}

const text = (xml: string | undefined, name: string) => {
  const v = inner(xml, name)
  return v === undefined ? undefined : decode(v).trim()
}

/** CalDAV turned down every way of signing in that was tried. */
export class CalDavAuthError extends ApiError {
  constructor(readonly withAppPassword: boolean) {
    super(
      401,
      withAppPassword ? 'Yandex Calendar didn’t accept the app password' : 'Yandex Calendar needs an app password'
    )
  }
}

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

type Scheme = (auth: Credentials) => string
const TOKEN_SCHEMES: Scheme[] = [
  (a) => `OAuth ${a.token}`,
  (a) => `Bearer ${a.token}`,
  (a) => basic(a.email, a.token)
]
/** The token form that worked last, tried first. */
let tokenScheme: Scheme = TOKEN_SCHEMES[0]

async function dav(auth: Credentials, method: 'PROPFIND' | 'REPORT', path: string, depth: '0' | '1', body: string) {
  const attempt = async (authorization: string) => {
    try {
      return await request(new URL(path, DAV), {
        method,
        headers: { Authorization: authorization, Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' },
        body
      })
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return null
      throw err
    }
  }
  let res: Response | null = null
  if (auth.appPassword) {
    res = await attempt(basic(auth.email, auth.appPassword))
  } else {
    for (const scheme of [tokenScheme, ...TOKEN_SCHEMES.filter((s) => s !== tokenScheme)]) {
      res = await attempt(scheme(auth))
      if (res) {
        tokenScheme = scheme
        break
      }
    }
  }
  if (!res) throw new CalDavAuthError(!!auth.appPassword)
  const xml = await res.text()
  return xml
    .split(/<(?:[\w-]+:)?response\b[^>]*>/i)
    .slice(1)
    .map((chunk) => ({ href: text(chunk, 'href') ?? '', xml: chunk }))
}

async function calendarHome(auth: Credentials) {
  try {
    const [root] = await dav(auth, 'PROPFIND', '/', '0', propfind('<d:current-user-principal/>'))
    const principal = text(inner(root?.xml, 'current-user-principal'), 'href')
    if (principal) {
      const [p] = await dav(auth, 'PROPFIND', principal, '0', propfind('<c:calendar-home-set/>'))
      const home = text(inner(p?.xml, 'calendar-home-set'), 'href')
      if (home) return home
    }
  } catch (err) {
    if (err instanceof CalDavAuthError) throw err
    console.warn('Yandex CalDAV discovery failed, using the default path', err)
  }
  return `/calendars/${auth.email}/`
}

/** "20261024T000000Z", the form CalDAV time ranges use. */
const utc = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

export const yandex: CalendarApi = {
  async profile(token) {
    const res = await request('https://login.yandex.ru/info?format=json', { headers: { Authorization: `OAuth ${token}` } })
    const me = (await res.json()) as {
      login: string
      default_email?: string
      real_name?: string
      display_name?: string
      default_avatar_id?: string
      is_avatar_empty?: boolean
    }
    return {
      email: me.default_email || `${me.login}@yandex.ru`,
      name: me.real_name || me.display_name || me.login,
      avatarUrl:
        me.default_avatar_id && !me.is_avatar_empty
          ? `https://avatars.yandex.net/get-yapic/${me.default_avatar_id}/islands-68`
          : undefined
    }
  },

  async calendars(auth) {
    const home = await calendarHome(auth)
    const list = await dav(
      auth,
      'PROPFIND',
      home,
      '1',
      propfind('<d:displayname/><d:resourcetype/><ical:calendar-color/><c:supported-calendar-component-set/>')
    )
    return list
      .filter((r) => {
        if (!/<(?:[\w-]+:)?calendar[\s/>]/i.test(inner(r.xml, 'resourcetype') ?? '')) return false
        // Task lists are calendars too, holding VTODO only.
        const components = inner(r.xml, 'supported-calendar-component-set')
        return !components || /name="VEVENT"/i.test(components)
      })
      .map(
        (r): AccountCalendar => ({
          id: r.href,
          name: text(r.xml, 'displayname') || 'Calendar',
          color: text(r.xml, 'calendar-color')?.slice(0, 7) || undefined,
          primary: /\/events-default\/?$/.test(r.href),
          enabled: true
        })
      )
  },

  async events(auth, calendarId, from, to) {
    const body =
      `${XML_HEAD}<c:calendar-query ${NS}><d:prop><c:calendar-data/></d:prop><c:filter>` +
      `<c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
      `<c:time-range start="${utc(from)}" end="${utc(to)}"/>` +
      `</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`
    const list = await dav(auth, 'REPORT', calendarId, '1', body)
    // Recurring series come back whole; the ICS parser expands them into the window.
    const ics = list.map((r) => text(r.xml, 'calendar-data') ?? '').join('\n')
    return parseIcs(ics, from, to).filter((e) => !e.allDay)
  }
}
