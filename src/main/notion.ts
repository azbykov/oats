import type { NotionParentPage, NotionSaveRequest } from '../shared/types'

// Notion's REST API. The version with page markdown (create with `markdown`,
// replace with PATCH /pages/:id/markdown), so notes go over as they are; pages
// live in a database's data source.

const API = 'https://api.notion.com/v1'
const VERSION = '2026-03-11'
export const DATABASE_TITLE = 'Oats Notes'

export class NotionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message)
  }
}

/** Notion no longer has the database Oats saves to, or Oats lost access to it. */
export class NotionTargetLost extends Error {}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
export type NotionCall = (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) => Promise<Json>

/** One request; rate limits (429, and 529 when Notion is overloaded) are waited out twice at most. */
export async function notionRequest(token: string, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': VERSION,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    if ((res.status === 429 || res.status === 529) && attempt < 2) {
      const wait = Math.min(Number(res.headers.get('Retry-After')) || 1, 30)
      await new Promise((r) => setTimeout(r, wait * 1000))
      continue
    }
    const json = (await res.json().catch(() => ({}))) as Json
    if (!res.ok) throw new NotionError(json.message || `Notion answered ${res.status}`, res.status, json.code)
    return json
  }
}

/** The database notes go to. Pages are created in its first data source. */
export interface NotionTarget {
  databaseId: string
  dataSourceId: string
  title: string
  url: string
}

const plain = (rich: Json): string => (Array.isArray(rich) ? rich.map((t) => t.plain_text ?? '').join('') : '')

const pageTitle = (page: Json) => {
  const title = Object.values(page.properties ?? {}).find((p: Json) => p.type === 'title') as Json
  return plain(title?.title)
}

const isRow = (page: Json) => page.parent?.type === 'data_source_id' || page.parent?.type === 'database_id'

export async function databaseTarget(call: NotionCall, databaseId: string): Promise<NotionTarget> {
  const db = await call('GET', `/databases/${databaseId}`)
  const source = db.data_sources?.[0]
  if (!source) throw new Error('This Notion database has no data source')
  return { databaseId: db.id, dataSourceId: source.id, title: plain(db.title) || DATABASE_TITLE, url: db.url }
}

/** The database in the copy of the Oats template the user chose on Notion's consent page. */
export async function templateTarget(call: NotionCall, pageId: string): Promise<NotionTarget | undefined> {
  const children = await call('GET', `/blocks/${pageId}/children?page_size=100`).catch((err) => {
    // The template may be a database itself rather than a page holding one.
    if (err instanceof NotionError && (err.status === 404 || err.status === 400)) return null
    throw err
  })
  if (!children) return databaseTarget(call, pageId)
  const block = children.results?.find((b: Json) => b.type === 'child_database')
  return block ? databaseTarget(call, block.id) : undefined
}

/** A database called "Oats Notes" the workspace already shares with Oats, e.g. from an earlier connection. */
export async function findOatsDatabase(call: NotionCall): Promise<NotionTarget | undefined> {
  const found = await call('POST', '/search', {
    query: DATABASE_TITLE,
    filter: { property: 'object', value: 'data_source' },
    page_size: 20
  })
  const source = found.results?.find(
    (s: Json) => !s.in_trash && plain(s.title) === DATABASE_TITLE && s.parent?.type === 'database_id'
  )
  return source ? databaseTarget(call, source.parent.database_id) : undefined
}

/** Pages shared with Oats, most recently edited first, where it can create its database. */
export async function parentPages(call: NotionCall): Promise<NotionParentPage[]> {
  const found = await call('POST', '/search', {
    filter: { property: 'object', value: 'page' },
    sort: { direction: 'descending', timestamp: 'last_edited_time' },
    page_size: 100
  })
  return (found.results ?? [])
    .filter((p: Json) => !p.in_trash && !p.archived && !isRow(p))
    .map((p: Json) => ({
      id: p.id,
      title: pageTitle(p) || 'Untitled',
      icon: p.icon?.type === 'emoji' ? p.icon.emoji : undefined
    }))
}

/** Properties of a database Oats creates; a template's database should have the same. */
const PROPERTIES = {
  Name: { title: {} },
  Date: { date: {} },
  Attendees: { rich_text: {} },
  Folders: { multi_select: {} },
  'Oats ID': { rich_text: {} }
}

export async function createDatabase(call: NotionCall, pageId: string): Promise<NotionTarget> {
  const db = await call('POST', '/databases', {
    parent: { type: 'page_id', page_id: pageId },
    title: [{ type: 'text', text: { content: DATABASE_TITLE } }],
    icon: { type: 'emoji', emoji: '🥣' },
    initial_data_source: { properties: PROPERTIES }
  })
  // The answer can be a partial object with only the id.
  if (!db.data_sources?.length || !db.url) return databaseTarget(call, db.id)
  return { databaseId: db.id, dataSourceId: db.data_sources[0].id, title: DATABASE_TITLE, url: db.url }
}

const text = (value: string) => [{ type: 'text', text: { content: value.slice(0, 2000) } }]

/** Multi-select options may not contain commas. */
const tags = (values: string[]) =>
  [...new Set(values.map((v) => v.replace(/,/g, ' ').trim().slice(0, 100)).filter(Boolean))].slice(0, 100).map((name) => ({ name }))

/**
 * The note's fields, written only to properties the database has with a type Oats
 * understands: a template's database may lack some or have renamed its title.
 */
function properties(schema: Record<string, { type: string }>, req: NotionSaveRequest) {
  const out: Record<string, unknown> = {}
  const list = (name: string, values: string[]) => {
    const type = schema[name]?.type
    if (type === 'rich_text') out[name] = { rich_text: text(values.join(', ')) }
    else if (type === 'multi_select') out[name] = { multi_select: tags(values) }
  }
  const title = Object.entries(schema).find(([, p]) => p.type === 'title')?.[0]
  if (title) out[title] = { title: text(req.title) }
  if (schema.Date?.type === 'date') out.Date = { date: { start: req.date } }
  list('Attendees', req.attendees)
  list('Folders', req.folders)
  if (schema['Oats ID']?.type === 'rich_text') out['Oats ID'] = { rich_text: text(req.noteId) }
  return out
}

/** The page a note went to before, if it is still there. */
async function livePage(call: NotionCall, pageId: string) {
  const page = await call('GET', `/pages/${pageId}`).catch((err) => {
    if (err instanceof NotionError && err.status === 404) return null
    throw err
  })
  return page && !page.in_trash && !page.archived ? page : null
}

/** Creates the note's page, or rewrites the one it was saved to before. */
export async function savePage(
  call: NotionCall,
  target: NotionTarget,
  req: NotionSaveRequest,
  previousPageId?: string
): Promise<{ pageId: string; url: string }> {
  const source = await call('GET', `/data_sources/${target.dataSourceId}`).catch((err) => {
    if (err instanceof NotionError && err.status === 404) throw new NotionTargetLost(err.message)
    throw err
  })
  const schema = (source.properties ?? {}) as Record<string, { type: string }>
  const props = properties(schema, req)

  let page = previousPageId ? await livePage(call, previousPageId) : null
  // Saved from another computer or before Oats lost track: find the note by its id.
  if (!page && schema['Oats ID']?.type === 'rich_text') {
    const found = await call('POST', `/data_sources/${target.dataSourceId}/query`, {
      filter: { property: 'Oats ID', rich_text: { equals: req.noteId } },
      page_size: 1
    })
    page = found.results?.[0] ?? null
  }

  if (page) {
    await call('PATCH', `/pages/${page.id}`, { properties: props })
    await call('PATCH', `/pages/${page.id}/markdown`, {
      type: 'replace_content',
      replace_content: { new_str: req.markdown }
    })
    return { pageId: page.id, url: page.url }
  }
  const created = await call('POST', '/pages', {
    parent: { type: 'data_source_id', data_source_id: target.dataSourceId },
    properties: props,
    ...(req.markdown.trim() ? { markdown: req.markdown } : {})
  })
  return { pageId: created.id, url: created.url }
}
