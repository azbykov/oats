import { app, shell } from 'electron'
import { createDecipheriv, createECDH, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import type { AccountProvider } from '../shared/types'

// The installed-app OAuth flow (RFC 8252): the system browser shows the consent
// page and a listener on 127.0.0.1 catches the redirect, with PKCE. Two setups:
// - MAIN_VITE_AUTH_URL set: the Oats site (oats-site repo) holds the OAuth
//   clients and their secrets. It starts the flow, is the registered redirect
//   URI and relays it to the listener, and adds the secret to token requests.
// - otherwise the app talks to Google and Yandex directly with its own clients.
// Notion only works through the site: it has no PKCE, so the site redeems the code
// itself and hands the tokens back sealed to a key made for this sign-in.

const PORT = Number(import.meta.env.MAIN_VITE_OAUTH_PORT || 47821)
const LOOPBACK_URI = `http://127.0.0.1:${PORT}/oauth/callback`
const SITE = import.meta.env.MAIN_VITE_AUTH_URL?.replace(/\/+$/, '') || undefined

export interface Tokens {
  accessToken: string
  refreshToken?: string
  /** ms since epoch; absent when the provider gave no lifetime. */
  expiresAt?: number
}

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message)
  }
}

interface ProviderConfig {
  clientId: string
  clientSecret?: string
  authUrl: string
  tokenUrl: string
  params: Record<string, string>
}

const CONFIG: Record<AccountProvider, ProviderConfig> = {
  google: {
    clientId: import.meta.env.MAIN_VITE_GOOGLE_CLIENT_ID ?? '',
    // "Desktop app" clients still send their secret, which Google treats as public.
    clientSecret: import.meta.env.MAIN_VITE_GOOGLE_CLIENT_SECRET,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    params: {
      scope: 'openid email profile https://www.googleapis.com/auth/calendar.readonly',
      // offline + consent: a refresh token every time, also when reconnecting.
      access_type: 'offline',
      prompt: 'consent select_account'
    }
  },
  yandex: {
    clientId: import.meta.env.MAIN_VITE_YANDEX_CLIENT_ID ?? '',
    // Optional: with PKCE Yandex exchanges the code without it.
    clientSecret: import.meta.env.MAIN_VITE_YANDEX_CLIENT_SECRET,
    authUrl: 'https://oauth.yandex.ru/authorize',
    tokenUrl: 'https://oauth.yandex.ru/token',
    // Scopes (Yandex ID profile + Calendar) come from the app's registration.
    params: { force_confirm: 'yes' }
  }
}

export type OAuthProvider = AccountProvider | 'notion'

// With the site, whether a provider is set up is the site's business; it answers 503 otherwise.
export const isConfigured = (provider: OAuthProvider) => !!SITE || (provider !== 'notion' && !!CONFIG[provider].clientId)

const base64url = (buf: Buffer) => buf.toString('base64url')

const PAGES = {
  ok: ['You’re signed in', 'Going back to Oats. You can close this tab.'],
  error: ['Sign-in didn’t finish', 'Go back to Oats and try again.'],
  cancelled: ['Sign-in cancelled', 'Go back to Oats if you want to try again.'],
  expired: ['This sign-in has expired', 'Go back to Oats and start again.']
} as const

/** Opens Oats (the oats:// scheme registered in index.ts) from the finished sign-in tab. */
const APP_LINK = 'oats://signed-in'

const page = (title: string, text: string, backToApp: boolean) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;color:#3b3b38">` +
  `<div style="text-align:center"><h2 style="font-weight:600">${title}</h2><p>${text}</p>` +
  (backToApp
    ? `<p><a href="${APP_LINK}" style="display:inline-block;padding:8px 16px;border-radius:999px;background:#3b3b38;color:#fff;text-decoration:none">Open Oats</a></p>` +
      `<script>location.href = ${JSON.stringify(APP_LINK)}</script>`
    : '') +
  `</div>`

let cancelPending: (() => void) | null = null
/** Settles once the previous sign-in's listener has let go of the port. */
let released = Promise.resolve()

/** Stops a sign-in that is waiting for the browser. */
export function cancelAuthorization() {
  cancelPending?.()
}

/**
 * The browser part of a sign-in: listens on the loopback port, opens the page `startUrl`
 * gives for this sign-in's state, and resolves with the redirect's query.
 */
async function browserSignIn(startUrl: (state: string) => URL): Promise<{ state: string; query: URLSearchParams }> {
  cancelAuthorization()
  let cancelled = false
  cancelPending = () => (cancelled = true)
  await released
  if (cancelled) throw new OAuthError('Sign-in was cancelled', 'cancelled')

  // The site reads the listener's port from the state when it relays the redirect.
  const state = `${SITE ? `${PORT}.` : ''}${base64url(randomBytes(16))}`
  /** The page the browser tab ends on: the site's, or one served from here. */
  const reply = (res: ServerResponse, status: number, result: 'ok' | 'error' | 'cancelled' | 'expired') => {
    if (SITE) {
      res.writeHead(302, { Location: `${SITE}/connected?result=${result}` }).end()
      return
    }
    const [title, text] = PAGES[result]
    // A tab left from an older sign-in has nothing to go back to.
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(title, text, result !== 'expired'))
  }
  const query = await new Promise<URLSearchParams>((resolve, reject) => {
    const server = createServer((req, res) => {
      // A keep-alive connection from the browser would hold the server open.
      res.shouldKeepAlive = false
      const url = new URL(req.url ?? '/', LOOPBACK_URI)
      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404).end()
        return
      }
      // A tab left over from a cancelled sign-in must not end this one.
      if (url.searchParams.get('state') !== state) {
        reply(res, 400, 'expired')
        return
      }
      const error = url.searchParams.get('error')
      const ok = !error && (url.searchParams.has('code') || url.searchParams.has('sealed'))
      reply(res, 200, ok ? 'ok' : error === 'access_denied' ? 'cancelled' : 'error')
      // Back from the browser: Oats comes forward instead of leaving the user on the tab.
      app.focus({ steal: true })
      finish()
      if (ok) resolve(url.searchParams)
      else
        reject(
          new OAuthError(
            error === 'access_denied' ? 'Sign-in was cancelled' : url.searchParams.get('error_description') || 'Sign-in failed',
            error ?? undefined
          )
        )
    })
    const timer = setTimeout(() => {
      finish()
      reject(new OAuthError('Sign-in timed out'))
    }, 5 * 60_000)
    released = new Promise<void>((r) => {
      server.once('close', r)
      server.once('error', () => r())
    })
    let done = false
    const finish = () => {
      done = true
      clearTimeout(timer)
      if (server.listening) server.close()
      if (cancelPending === cancel) cancelPending = null
    }
    const cancel = () => {
      finish()
      reject(new OAuthError('Sign-in was cancelled', 'cancelled'))
    }
    cancelPending = cancel
    server.on('error', (err: NodeJS.ErrnoException) => {
      finish()
      reject(err.code === 'EADDRINUSE' ? new OAuthError(`Port ${PORT} is in use; close the app using it and try again`) : err)
    })
    server.listen(PORT, '127.0.0.1', () => {
      // Cancelled before the port was bound.
      if (done) {
        server.close()
        return
      }
      shell.openExternal(startUrl(state).toString())
    })
  })
  return { state, query }
}

/** Opens the provider's consent page in the browser and resolves with tokens once the user agrees. */
export async function authorize(provider: AccountProvider): Promise<Tokens> {
  const cfg = CONFIG[provider]
  if (!isConfigured(provider)) throw new OAuthError('Sign-in with this provider is not configured in this build')
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const { query } = await browserSignIn((state) => {
    const url = new URL(SITE ? `${SITE}/auth/${provider}/start` : cfg.authUrl)
    url.search = new URLSearchParams(
      SITE
        ? { state, code_challenge: challenge }
        : {
            response_type: 'code',
            client_id: cfg.clientId,
            redirect_uri: LOOPBACK_URI,
            state,
            code_challenge: challenge,
            code_challenge_method: 'S256',
            ...cfg.params
          }
    ).toString()
    return url
  })
  return tokenRequest(provider, {
    grant_type: 'authorization_code',
    code: query.get('code') ?? '',
    code_verifier: verifier,
    // The site adds its own redirect URI.
    ...(SITE ? {} : { redirect_uri: LOOPBACK_URI })
  })
}

/** What Notion's token endpoint returns, as the site passes it on. */
export interface NotionGrant {
  access_token: string
  refresh_token?: string
  expires_in?: number
  bot_id: string
  workspace_id: string
  workspace_name?: string | null
  workspace_icon?: string | null
  /** The copy of the template page, when the user chose the template on the consent page. */
  duplicated_template_id?: string | null
}

/** Signs in to Notion through the site; the tokens arrive sealed to a key only this sign-in holds. */
export async function authorizeNotion(): Promise<{ grant: NotionGrant; tokens: Tokens }> {
  if (!SITE) throw new OAuthError('Notion needs the Oats site (MAIN_VITE_AUTH_URL) in this build')
  const ecdh = createECDH('prime256v1')
  const key = base64url(ecdh.generateKeys())
  const { state, query } = await browserSignIn((state) => {
    const url = new URL(`${SITE}/auth/notion/start`)
    url.search = new URLSearchParams({ state, key }).toString()
    return url
  })
  let grant: NotionGrant
  try {
    grant = JSON.parse(openSealed(query.get('sealed') ?? '', ecdh, state)) as NotionGrant
  } catch {
    throw new OAuthError('Sign-in failed')
  }
  if (!grant.access_token) throw new OAuthError('Sign-in failed')
  return { grant, tokens: tokensFrom(grant) }
}

/** Reverses the site's seal(): ephemeral public key (65 bytes) ‖ IV (12) ‖ AES-256-GCM ciphertext with its tag. */
function openSealed(sealed: string, ecdh: ReturnType<typeof createECDH>, state: string) {
  const data = Buffer.from(sealed, 'base64url')
  const shared = ecdh.computeSecret(data.subarray(0, 65))
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), 'oats-oauth', 32))
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(65, 77))
  decipher.setAAD(Buffer.from(state))
  decipher.setAuthTag(data.subarray(data.length - 16))
  return Buffer.concat([decipher.update(data.subarray(77, data.length - 16)), decipher.final()]).toString('utf8')
}

/** New access token; the refresh token is kept when the provider doesn't rotate it. */
export async function refreshTokens(provider: OAuthProvider, tokens: Tokens): Promise<Tokens> {
  if (!tokens.refreshToken) throw new OAuthError('Access expired', 'invalid_grant')
  const next = await tokenRequest(provider, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken })
  return { ...next, refreshToken: next.refreshToken ?? tokens.refreshToken }
}

/** Best effort: the account is forgotten locally either way. */
export async function revokeTokens(provider: AccountProvider, tokens: Tokens) {
  const cfg = CONFIG[provider]
  const form = (body: Record<string, string>) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body)
  })
  if (SITE) {
    // Google revokes the whole grant from either token; Yandex takes the access token.
    const token = provider === 'google' ? (tokens.refreshToken ?? tokens.accessToken) : tokens.accessToken
    await fetch(`${SITE}/api/oauth/${provider}/revoke`, form({ token }))
  } else if (provider === 'google') {
    await fetch('https://oauth2.googleapis.com/revoke', form({ token: tokens.refreshToken ?? tokens.accessToken }))
  } else if (cfg.clientSecret) {
    await fetch(
      'https://oauth.yandex.ru/revoke_token',
      form({ access_token: tokens.accessToken, client_id: cfg.clientId, client_secret: cfg.clientSecret })
    )
  }
}

async function tokenRequest(provider: OAuthProvider, params: Record<string, string>): Promise<Tokens> {
  if (!SITE && provider === 'notion') throw new OAuthError('Notion needs the Oats site (MAIN_VITE_AUTH_URL) in this build')
  const cfg = provider === 'notion' ? null : CONFIG[provider]
  const res = await fetch(SITE || !cfg ? `${SITE}/api/oauth/${provider}/token` : cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      // The site holds the client and its secret.
      ...(SITE || !cfg ? {} : { client_id: cfg.clientId, ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}) }),
      ...params
    })
  })
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }
  if (!res.ok || !json.access_token) {
    throw new OAuthError(json.error_description || json.error || `Token request failed (${res.status})`, json.error)
  }
  return tokensFrom({ ...json, access_token: json.access_token })
}

const tokensFrom = (json: { access_token: string; refresh_token?: string; expires_in?: number }): Tokens => ({
  accessToken: json.access_token,
  refreshToken: json.refresh_token,
  expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined
})
