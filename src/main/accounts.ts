import { app, BrowserWindow, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Account, AccountCalendar, AccountProvider, CalendarEvent } from '../shared/types'
import { ApiError, type CalendarApi, type Credentials } from './calendar-api'
import { google } from './google'
import { authorize, isConfigured, OAuthError, refreshTokens, revokeTokens, type Tokens } from './oauth'
import { CalDavAuthError, yandex } from './yandex'

// Signed-in accounts live apart from oats-data.json, which is handed to the
// renderer whole: tokens never leave the main process and are encrypted with
// the OS keychain (safeStorage: Keychain on macOS, DPAPI on Windows).

const APIS: Record<AccountProvider, CalendarApi> = { google, yandex }

interface StoredAccount extends Account {
  /** Tokens JSON, encrypted with safeStorage, base64. */
  tokens: string
  /** Yandex calendar app password, sealed the same way. */
  appPassword?: string
}

const file = () => join(app.getPath('userData'), 'oats-accounts.json')

let accounts: StoredAccount[] | null = null
const tokenCache = new Map<string, Tokens>()
const refreshing = new Map<string, Promise<string>>()
/** Accounts whose calendar list was re-read this session (new calendars show up). */
const listed = new Set<string>()

function load(): StoredAccount[] {
  if (accounts) return accounts
  try {
    accounts = existsSync(file()) ? (JSON.parse(readFileSync(file(), 'utf8')) as StoredAccount[]) : []
  } catch (err) {
    console.error('Failed to read accounts file', err)
    accounts = []
  }
  return accounts
}

const strip = ({ tokens: _, appPassword: __, ...account }: StoredAccount): Account => account

export const listAccounts = () => load().map(strip)

export const configuredProviders = (): Record<AccountProvider, boolean> => ({
  google: isConfigured('google'),
  yandex: isConfigured('yandex')
})

function persist() {
  mkdirSync(app.getPath('userData'), { recursive: true })
  const tmp = `${file()}.tmp`
  writeFileSync(tmp, JSON.stringify(load(), null, 2))
  renameSync(tmp, file())
  const list = listAccounts()
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('accounts:changed', list)
}

function seal(value: Tokens | string) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this computer')
  return safeStorage.encryptString(JSON.stringify(value)).toString('base64')
}

const unseal = <T>(sealed: string) => JSON.parse(safeStorage.decryptString(Buffer.from(sealed, 'base64'))) as T

const credentials = (account: StoredAccount, token: string): Credentials => ({
  token,
  email: account.email,
  appPassword: account.appPassword ? unseal<string>(account.appPassword) : undefined
})

const APP_PASSWORD_NEEDED = 'Add a calendar app password in Settings → Accounts'

function update(id: string, patch: Partial<StoredAccount>) {
  accounts = load().map((a) => (a.id === id ? { ...a, ...patch } : a))
  persist()
}

function find(id: string) {
  const account = load().find((a) => a.id === id)
  if (!account) throw new Error('Account not found')
  return account
}

const REAUTH = 'Access expired — sign in again'

// unauthorized_client: the refresh token belongs to another OAuth client, e.g. the
// account was connected from a dev build (own client) and is now used by a build
// that signs in through the Oats site, or the other way round. Both share this file.
const NEEDS_SIGN_IN = new Set(['invalid_grant', 'unauthorized_client'])

/** A fresh calendar list, keeping the on/off choices the user made. */
const keepChoices = (fresh: AccountCalendar[], old: AccountCalendar[] = []) =>
  fresh.map((c) => {
    const prev = old.find((x) => x.id === c.id)
    return prev?.chosen ? { ...c, enabled: prev.enabled, chosen: true } : c
  })

/** A valid access token, refreshed when it is about to expire. */
async function accessToken(id: string): Promise<string> {
  const account = find(id)
  const tokens = tokenCache.get(id) ?? unseal<Tokens>(account.tokens)
  if (!tokens.expiresAt || tokens.expiresAt - 60_000 > Date.now()) {
    tokenCache.set(id, tokens)
    return tokens.accessToken
  }
  // Calendars of one account are fetched in parallel; refresh once for all of them.
  let pending = refreshing.get(id)
  if (!pending) {
    pending = refreshTokens(account.provider, tokens)
      .then((next) => {
        tokenCache.set(id, next)
        update(id, { tokens: seal(next), error: undefined })
        return next.accessToken
      })
      .catch((err) => {
        if (err instanceof OAuthError && err.code && NEEDS_SIGN_IN.has(err.code)) {
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

/** Signs in through the browser and adds the account, or refreshes it when it is already connected. */
export async function connectAccount(provider: AccountProvider): Promise<Account> {
  const api = APIS[provider]
  const tokens = await authorize(provider)
  const profile = await api.profile(tokens.accessToken)
  const existing = load().find((a) => a.provider === provider && a.email === profile.email)
  // Signed in either way: when Yandex CalDAV won't take the token, the account
  // is kept and asks for an app password.
  let needsAppPassword: true | undefined
  const calendars = await api
    .calendars(existing ? credentials({ ...existing, ...profile }, tokens.accessToken) : { token: tokens.accessToken, email: profile.email })
    .catch((err) => {
      if (!(err instanceof CalDavAuthError)) throw err
      needsAppPassword = true
      return existing?.calendars ?? []
    })
  const account: StoredAccount = {
    id: existing?.id ?? randomUUID(),
    provider,
    ...profile,
    // Reconnecting keeps the calendars the user picked.
    calendars: keepChoices(calendars, existing?.calendars),
    connectedAt: existing?.connectedAt ?? new Date().toISOString(),
    tokens: seal(tokens),
    appPassword: existing?.appPassword,
    needsAppPassword
  }
  accounts = existing ? load().map((a) => (a.id === existing.id ? account : a)) : [...load(), account]
  tokenCache.set(account.id, tokens)
  listed.add(account.id)
  persist()
  return strip(account)
}

export async function disconnectAccount(id: string) {
  const account = find(id)
  let tokens = tokenCache.get(id) ?? null
  try {
    tokens ??= unseal<Tokens>(account.tokens)
  } catch {
    // unreadable (e.g. data copied from another computer): nothing to revoke
  }
  accounts = load().filter((a) => a.id !== id)
  tokenCache.delete(id)
  listed.delete(id)
  persist()
  if (tokens) await revokeTokens(account.provider, tokens).catch((err) => console.warn('Token revoke failed', err))
}

export function setCalendarEnabled(id: string, calendarId: string, enabled: boolean) {
  const account = find(id)
  update(id, { calendars: account.calendars.map((c) => (c.id === calendarId ? { ...c, enabled, chosen: true } : c)) })
}

/** Checks a Yandex calendar app password against CalDAV and keeps it if it works. */
export async function setAppPassword(id: string, password: string) {
  const account = find(id)
  const token = await accessToken(id)
  const fresh = await APIS[account.provider]
    .calendars({ token, email: account.email, appPassword: password })
    .catch((err) => {
      throw err instanceof CalDavAuthError ? new Error('Yandex didn’t accept this app password') : err
    })
  update(id, {
    appPassword: seal(password),
    needsAppPassword: undefined,
    error: undefined,
    calendars: keepChoices(fresh, account.calendars)
  })
  listed.add(id)
}

async function refreshCalendarList(account: StoredAccount, token: string) {
  const api = APIS[account.provider]
  const fresh = await api.calendars(credentials(account, token))
  const calendars = keepChoices(fresh, account.calendars)
  listed.add(account.id)
  update(account.id, { calendars })
  return calendars
}

/** Events from the account's enabled calendars, each tagged with its calendar's colour. */
export async function accountEvents(id: string, from: Date, to: Date): Promise<CalendarEvent[]> {
  const account = find(id)
  const api = APIS[account.provider]
  if (account.needsAppPassword) throw new Error(APP_PASSWORD_NEEDED)
  try {
    const token = await accessToken(id)
    const auth = credentials(account, token)
    const calendars = listed.has(id)
      ? account.calendars
      : await refreshCalendarList(account, token).catch((err) => {
          if (err instanceof CalDavAuthError) throw err
          console.warn('Calendar list refresh failed', err)
          return account.calendars
        })
    const lists = await Promise.all(
      calendars
        .filter((c) => c.enabled)
        .map(async (c) => (await api.events(auth, c.id, from, to)).map((e) => ({ ...e, color: e.color ?? c.color })))
    )
    if (account.error) update(id, { error: undefined })
    return lists.flat()
  } catch (err) {
    if (err instanceof CalDavAuthError) {
      update(id, { needsAppPassword: true })
      throw new Error(err.withAppPassword ? `${err.message}. ${APP_PASSWORD_NEEDED}` : APP_PASSWORD_NEEDED)
    }
    if (err instanceof ApiError && err.status === 401) {
      tokenCache.delete(id)
      update(id, { error: REAUTH })
      throw new Error(REAUTH)
    }
    throw err
  }
}
