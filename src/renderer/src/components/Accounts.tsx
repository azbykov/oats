import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { Account, AccountProvider } from '../../../shared/types'
import { useStore } from '../lib/store'
import { Avatar, Button } from './ui'

export const PROVIDER_LABEL: Record<AccountProvider, string> = { google: 'Google', yandex: 'Yandex' }

// ipcRenderer.invoke wraps errors thrown in the main process.
const errorMessage = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')

function AccountCard({ account }: { account: Account }) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="rounded-xl border border-hairline">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <Avatar name={account.name} src={account.avatarUrl} className="size-8! ring-0!" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink-primary">{account.name}</div>
          <div className="truncate text-[12px] text-ink-tertiary">
            {PROVIDER_LABEL[account.provider]} · {account.email}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            await window.oats.disconnectAccount(account.id).finally(() => setBusy(false))
          }}
        >
          Disconnect
        </Button>
      </div>
      {account.error && (
        <div className="flex items-center justify-between gap-2 border-t border-hairline px-3 py-2 text-[12px] text-ink-danger">
          {account.error}
          <ConnectButton provider={account.provider} label="Sign in again" size="sm" />
        </div>
      )}
      {account.needsAppPassword && <AppPasswordForm account={account} />}
      {account.calendars.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-hairline px-3 py-2.5">
          {account.calendars.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-[13px] text-ink-primary">
              <input
                type="checkbox"
                className="accent-[var(--fill-accent)]"
                checked={c.enabled}
                onChange={(e) => window.oats.setCalendarEnabled(account.id, c.id, e.target.checked)}
              />
              <span className="size-2.5 shrink-0 rounded-full bg-event-blue" style={c.color ? { background: c.color } : undefined} />
              <span className="min-w-0 truncate">{c.name}</span>
              {c.primary && <span className="text-[11px] text-ink-tertiary">primary</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

const input =
  'h-8 min-w-0 flex-1 rounded-lg border border-hairline bg-fill-input px-3 text-[13px] text-ink-primary outline-none focus:border-ink-accent'

/** Yandex CalDAV may refuse the OAuth token; a calendar app password always works. */
function AppPasswordForm({ account }: { account: Account }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await window.oats.setAppPassword(account.id, password.replace(/\s+/g, ''))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const href = 'https://id.yandex.ru/security/app-passwords'
  return (
    <div className="flex flex-col gap-2 border-t border-hairline px-3 py-2.5 text-[12px] leading-snug text-ink-secondary">
      <div>
        Yandex Calendar didn’t accept the sign-in for reading calendars. Create an app password of type “Calendar
        (CalDAV)” in{' '}
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault()
            window.oats.openExternal(href)
          }}
          className="text-ink-accent underline underline-offset-2"
        >
          Yandex ID → Security → App passwords
        </a>{' '}
        and paste it here. It is stored encrypted on this computer.
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (password.trim()) save()
        }}
      >
        <input
          type="password"
          className={input}
          placeholder="App password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" variant="outline" disabled={busy || !password.trim()}>
          {busy ? 'Checking…' : 'Save'}
        </Button>
      </form>
      {error && <div className="text-ink-danger">{error}</div>}
    </div>
  )
}

/** One sign-in at a time, shared by every button so they all show it. */
const useSignIn = create<{
  provider: AccountProvider | null
  error: string | null
  start: (provider: AccountProvider) => Promise<void>
}>((set, get) => ({
  provider: null,
  error: null,
  start: async (provider) => {
    if (get().provider === provider) {
      window.oats.cancelConnect()
      return
    }
    set({ provider, error: null })
    try {
      const account = await window.oats.connectAccount(provider)
      const { data, updateSettings } = useStore.getState()
      if (data && !data.settings.userName) updateSettings({ userName: account.name })
    } catch (err) {
      const message = errorMessage(err)
      if (message !== 'Sign-in was cancelled') set({ error: message })
    } finally {
      set({ provider: null })
    }
  }
}))

function ConnectButton({
  provider,
  label,
  size = 'md',
  disabled
}: {
  provider: AccountProvider
  label: string
  size?: 'sm' | 'md'
  disabled?: boolean
}) {
  const active = useSignIn((s) => s.provider)
  const start = useSignIn((s) => s.start)
  return (
    <Button
      variant="outline"
      size={size}
      disabled={disabled || (active !== null && active !== provider)}
      onClick={() => start(provider)}
    >
      {active === provider ? 'Waiting for browser… Cancel' : label}
    </Button>
  )
}

export function AccountsSettings() {
  const accounts = useStore((s) => s.accounts)
  const error = useSignIn((s) => s.error)
  const [configured, setConfigured] = useState<Record<AccountProvider, boolean> | null>(null)
  useEffect(() => {
    window.oats.accountProviders().then(setConfigured)
  }, [])
  // One account per provider: its button comes back after Disconnect.
  const available = (['google', 'yandex'] as const).filter((p) => !accounts.some((a) => a.provider === p))
  const missing = configured ? available.filter((p) => !configured[p]) : []

  return (
    <div className="flex flex-col gap-3">
      {accounts.map((a) => (
        <AccountCard key={a.id} account={a} />
      ))}
      {available.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {available.map((p) => (
            <ConnectButton
              key={p}
              provider={p}
              label={`Continue with ${PROVIDER_LABEL[p]}`}
              disabled={configured ? !configured[p] : true}
            />
          ))}
        </div>
      )}
      {error && <div className="text-[12px] text-ink-danger">{error}</div>}
      {missing.length > 0 && (
        <div className="text-[12px] text-ink-tertiary">
          {missing.map((p) => PROVIDER_LABEL[p]).join(' and ')} sign-in isn’t set up in this build: add{' '}
          {missing.map((p) => `MAIN_VITE_${p.toUpperCase()}_CLIENT_ID`).join(', ')} to .env (see README).
        </div>
      )}
    </div>
  )
}
