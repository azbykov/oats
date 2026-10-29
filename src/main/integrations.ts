import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  Integration,
  IntegrationProvider,
  NotionPageRef,
  NotionParentPage,
  NotionSaveRequest
} from '../shared/types'
import {
  createDatabase,
  databaseTarget,
  findOatsDatabase,
  NotionError,
  notionRequest,
  NotionTargetLost,
  parentPages,
  savePage,
  templateTarget,
  type NotionCall,
  type NotionTarget
} from './notion'
import { authorizeNotion, isConfigured, OAuthError, refreshTokens, type Tokens } from './oauth'
import { seal, unseal } from './sealed'

// Connected workspaces of the tools notes are sent to (for now, Notion). Like the
// accounts, they live apart from the notes database and their tokens never leave
// the main process.

interface StoredIntegration extends Integration {
  /** Tokens JSON, encrypted with safeStorage, base64. */
  tokens: string
  workspaceId: string
  notion?: NotionTarget
  /** The page each note was saved to, by note id. */
  pages: Record<string, NotionPageRef>
}

const file = () => join(app.getPath('userData'), 'oats-integrations.json')

let integrations: StoredIntegration[] | null = null
const tokenCache = new Map<string, Tokens>()
const refreshing = new Map<string, Promise<string>>()

function load(): StoredIntegration[] {
  if (integrations) return integrations
  try {
    integrations = existsSync(file()) ? (JSON.parse(readFileSync(file(), 'utf8')) as StoredIntegration[]) : []
  } catch (err) {
    console.error('Failed to read integrations file', err)
    integrations = []
  }
  return integrations
}

const strip = ({ tokens: _, workspaceId: __, notion, pages: ___, ...integration }: StoredIntegration): Integration => ({
  ...integration,
  target: notion ? { title: notion.title, url: notion.url } : undefined
})

export const listIntegrations = () => load().map(strip)

export const integrationProviders = (): Record<IntegrationProvider, boolean> => ({ notion: isConfigured('notion') })

function persist() {
  mkdirSync(app.getPath('userData'), { recursive: true })
  const tmp = `${file()}.tmp`
  writeFileSync(tmp, JSON.stringify(load(), null, 2))
  renameSync(tmp, file())
  const list = listIntegrations()
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('integrations:changed', list)
}

function update(id: string, patch: Partial<StoredIntegration>) {
  integrations = load().map((i) => (i.id === id ? { ...i, ...patch } : i))
  persist()
}

function notionIntegration() {
  const integration = load().find((i) => i.provider === 'notion')
  if (!integration) throw new Error('Connect Notion in Settings → Integrations')
  return integration
}

const REAUTH = 'Access expired — connect Notion again'

/** A new access token from the refresh token; once for all requests waiting on it. */
function refreshAccess(id: string): Promise<string> {
  let pending = refreshing.get(id)
  if (!pending) {
    const integration = notionIntegration()
    pending = refreshTokens('notion', tokenCache.get(id) ?? unseal<Tokens>(integration.tokens))
      .then((next) => {
        tokenCache.set(id, next)
        // A lost database stays reported; an expired sign-in no longer is.
        update(id, { tokens: seal(next), ...(notionIntegration().error === REAUTH ? { error: undefined } : {}) })
        return next.accessToken
      })
      .catch((err) => {
        if (err instanceof OAuthError && err.code === 'invalid_grant') {
          update(id, { error: REAUTH })
          throw new Error(REAUTH)
        }
        throw err
      })
      .finally(() => refreshing.delete(id))
    refreshing.set(id, pending)
  }
  return pending
}

/** Notion requests for a stored connection: on 401 the token is refreshed and the request tried once more. */
function notionCall(integration: StoredIntegration): NotionCall {
  const { id } = integration
  return async (method, path, body) => {
    const tokens = tokenCache.get(id) ?? unseal<Tokens>(integration.tokens)
    tokenCache.set(id, tokens)
    try {
      return await notionRequest(tokens.accessToken, method, path, body)
    } catch (err) {
      if (!(err instanceof NotionError && err.status === 401)) throw err
      const fresh = await refreshAccess(id)
      try {
        return await notionRequest(fresh, method, path, body)
      } catch (again) {
        if (again instanceof NotionError && again.status === 401) {
          tokenCache.delete(id)
          update(id, { error: REAUTH })
          throw new Error(REAUTH)
        }
        throw again
      }
    }
  }
}

/**
 * Signs in to Notion and finds the database to save notes to: the copy of the Oats
 * template, the one from an earlier connection, or one called "Oats Notes". Without
 * any, the user picks a page for a new one (notionParents, setNotionParent).
 */
export async function connectNotion(): Promise<Integration> {
  const { grant, tokens } = await authorizeNotion()
  const call: NotionCall = (method, path, body) => notionRequest(tokens.accessToken, method, path, body)
  const existing = load().find((i) => i.provider === 'notion')
  const sameWorkspace = existing?.workspaceId === grant.workspace_id
  const lookup = (what: string, find: () => Promise<NotionTarget | undefined>) =>
    find().catch((err) => {
      console.warn(`Notion: ${what} failed`, err)
      return undefined
    })
  let target = grant.duplicated_template_id
    ? await lookup('template lookup', () => templateTarget(call, grant.duplicated_template_id!))
    : undefined
  if (!target && sameWorkspace && existing.notion) {
    target = await lookup('database check', () => databaseTarget(call, existing.notion!.databaseId))
  }
  target ??= await lookup('database search', () => findOatsDatabase(call))

  const integration: StoredIntegration = {
    id: existing?.id ?? randomUUID(),
    provider: 'notion',
    workspaceId: grant.workspace_id,
    workspaceName: grant.workspace_name || 'Notion',
    // An emoji, an image URL, or a path on notion.so.
    workspaceIcon: grant.workspace_icon?.startsWith('/') ? `https://www.notion.so${grant.workspace_icon}` : grant.workspace_icon || undefined,
    connectedAt: existing?.connectedAt ?? new Date().toISOString(),
    tokens: seal(tokens),
    notion: target,
    // Pages of another workspace are out of reach.
    pages: sameWorkspace ? existing.pages : {}
  }
  integrations = [...load().filter((i) => i.provider !== 'notion'), integration]
  tokenCache.set(integration.id, tokens)
  persist()
  return strip(integration)
}

/** Forgets the connection. Notion has no revoke endpoint: access is removed in Notion's settings. */
export function disconnectIntegration(id: string) {
  integrations = load().filter((i) => i.id !== id)
  tokenCache.delete(id)
  persist()
}

export const notionParents = (): Promise<NotionParentPage[]> => parentPages(notionCall(notionIntegration()))

/** Creates the Oats Notes database on the chosen page and saves notes there from now on. */
export async function setNotionParent(pageId: string) {
  const integration = notionIntegration()
  const target = await createDatabase(notionCall(integration), pageId)
  update(integration.id, { notion: target, error: undefined })
}

export function notionPage(noteId: string): NotionPageRef | null {
  return load().find((i) => i.provider === 'notion')?.pages[noteId] ?? null
}

/** Saves the note to its page in Notion, creating the page the first time. */
export async function saveToNotion(req: NotionSaveRequest): Promise<NotionPageRef> {
  const integration = notionIntegration()
  const target = integration.notion
  if (!target) throw new Error('Choose where to save notes in Settings → Integrations')
  try {
    const page = await savePage(notionCall(integration), target, req, integration.pages[req.noteId]?.pageId)
    const ref: NotionPageRef = { ...page, savedAt: new Date().toISOString() }
    // Read again: a token refresh may have rewritten the record meanwhile.
    const current = notionIntegration()
    update(current.id, { pages: { ...current.pages, [req.noteId]: ref } })
    return ref
  } catch (err) {
    if (err instanceof NotionTargetLost) {
      const message = `Oats can’t reach “${target.title}” in Notion. Choose where to save notes again.`
      update(integration.id, { notion: undefined, error: message })
      throw new Error(message)
    }
    throw err
  }
}
