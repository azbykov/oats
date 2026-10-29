import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { Integration, NotionParentPage } from '../../../shared/types'
import { useStore } from '../lib/store'
import { errorMessage } from './Accounts'
import { Button } from './ui'

/** The Notion sign-in, shared by the Connect and Connect again buttons. */
const useNotionSignIn = create<{
  busy: boolean
  error: string | null
  start: () => Promise<void>
}>((set, get) => ({
  busy: false,
  error: null,
  start: async () => {
    if (get().busy) {
      window.oats.cancelConnect()
      return
    }
    set({ busy: true, error: null })
    try {
      await window.oats.connectNotion()
    } catch (err) {
      const message = errorMessage(err)
      if (message !== 'Sign-in was cancelled') set({ error: message })
    } finally {
      set({ busy: false })
    }
  }
}))

function ConnectNotion({ label, size = 'md', disabled }: { label: string; size?: 'sm' | 'md'; disabled?: boolean }) {
  const busy = useNotionSignIn((s) => s.busy)
  const start = useNotionSignIn((s) => s.start)
  return (
    <Button variant="outline" size={size} disabled={disabled} onClick={start}>
      {busy ? 'Waiting for browser… Cancel' : label}
    </Button>
  )
}

function WorkspaceIcon({ icon }: { icon?: string }) {
  const [broken, setBroken] = useState(false)
  if (icon && /^https?:\/\//.test(icon) && !broken) {
    return <img src={icon} alt="" className="size-8 shrink-0 rounded-lg object-cover" onError={() => setBroken(true)} />
  }
  return (
    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-fill-soft text-[15px]">
      {icon && !/^https?:\/\//.test(icon) ? icon : 'N'}
    </div>
  )
}

const select =
  'h-8 min-w-0 flex-1 rounded-lg border border-hairline bg-fill-input px-2 text-[13px] text-ink-primary outline-none focus:border-ink-accent'

/** Pages shared with Oats; it creates its "Oats Notes" database on the chosen one. */
function ParentPicker({ onDone }: { onDone?: () => void }) {
  const [pages, setPages] = useState<NotionParentPage[] | null>(null)
  const [chosen, setChosen] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = () => {
    setError(null)
    setPages(null)
    window.oats
      .notionParents()
      .then((list) => {
        setPages(list)
        setChosen((c) => (list.some((p) => p.id === c) ? c : (list[0]?.id ?? '')))
      })
      .catch((err) => {
        setPages([])
        setError(errorMessage(err))
      })
  }
  useEffect(load, [])
  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      await window.oats.setNotionParent(chosen)
      onDone?.()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-2 border-t border-hairline px-3 py-2.5 text-[12px] leading-snug text-ink-secondary">
      <div>Choose a page for the “Oats Notes” database. Each saved note becomes a page in it.</div>
      {pages && pages.length === 0 && !error ? (
        <div className="flex items-center justify-between gap-2">
          <span>
            No pages are shared with Oats. In Notion, open a page’s ••• menu → Connections and add Oats, then refresh.
          </span>
          <Button variant="ghost" size="sm" onClick={load}>
            Refresh
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <select className={select} value={chosen} disabled={!pages} onChange={(e) => setChosen(e.target.value)}>
            {!pages && <option>Loading pages…</option>}
            {pages?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.icon ? `${p.icon} ` : ''}
                {p.title}
              </option>
            ))}
          </select>
          <Button variant="outline" disabled={busy || !chosen} onClick={create}>
            {busy ? 'Creating…' : 'Create database'}
          </Button>
        </div>
      )}
      {error && <div className="text-ink-danger">{error}</div>}
    </div>
  )
}

function NotionCard({ integration }: { integration: Integration }) {
  const [busy, setBusy] = useState(false)
  const [changing, setChanging] = useState(false)
  const { target, error } = integration
  return (
    <div className="rounded-xl border border-hairline">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <WorkspaceIcon icon={integration.workspaceIcon} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink-primary">{integration.workspaceName}</div>
          <div className="truncate text-[12px] text-ink-tertiary">Notion</div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            await window.oats.disconnectIntegration(integration.id).finally(() => setBusy(false))
          }}
        >
          Disconnect
        </Button>
      </div>
      {error && (
        <div className="flex items-center justify-between gap-2 border-t border-hairline px-3 py-2 text-[12px] text-ink-danger">
          {error}
          {/* A lost database is fixed by choosing a page below, an expired sign-in by connecting again. */}
          {target && <ConnectNotion label="Connect again" size="sm" />}
        </div>
      )}
      {target && !changing && (
        <div className="flex items-center justify-between gap-2 border-t border-hairline px-3 py-2.5 text-[13px] text-ink-primary">
          <span className="min-w-0 truncate">
            Notes go to{' '}
            <a
              href={target.url}
              onClick={(e) => {
                e.preventDefault()
                window.oats.openExternal(target.url)
              }}
              className="text-ink-accent underline underline-offset-2"
            >
              {target.title}
            </a>
          </span>
          <Button variant="ghost" size="sm" onClick={() => setChanging(true)}>
            Change
          </Button>
        </div>
      )}
      {(!target || changing) && <ParentPicker onDone={() => setChanging(false)} />}
    </div>
  )
}

export function IntegrationsSettings() {
  const notion = useStore((s) => s.integrations.find((i) => i.provider === 'notion'))
  const error = useNotionSignIn((s) => s.error)
  const [configured, setConfigured] = useState<boolean | null>(null)
  useEffect(() => {
    window.oats.integrationProviders().then((p) => setConfigured(p.notion))
  }, [])

  return (
    <div className="flex flex-col gap-3">
      {notion ? (
        <NotionCard integration={notion} />
      ) : (
        <div className="flex">
          <ConnectNotion label="Connect Notion" disabled={!configured} />
        </div>
      )}
      {error && <div className="text-[12px] text-ink-danger">{error}</div>}
      {configured === false && !notion && (
        <div className="text-[12px] text-ink-tertiary">
          Notion connects through the Oats site, which this build doesn’t use: set MAIN_VITE_AUTH_URL in .env (see
          README).
        </div>
      )}
    </div>
  )
}
