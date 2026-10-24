import { Check, Mic, Speaker } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { PermissionKind, Permissions } from '../../../shared/types'
import { isMac } from '../lib/platform'
import { Button } from './ui'

/** Current permission state, refreshed whenever the window regains focus (e.g. back from System Settings). */
export function usePermissions() {
  const [permissions, setPermissions] = useState<Permissions | null>(null)
  const refresh = useCallback(() => window.oats.getPermissions().then(setPermissions), [])
  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])
  const request = useCallback(
    async (kind: PermissionKind) => {
      await window.oats.requestPermission(kind)
      await refresh()
    },
    [refresh]
  )
  return { permissions, request, refresh }
}

const LABELS: Record<PermissionKind, { title: string; hint: string; icon: ReactNode }> = {
  microphone: { title: 'Microphone', hint: 'Your side of the conversation (“Me”).', icon: <Mic size={15} /> },
  systemAudio: {
    title: 'System audio',
    hint: 'The other people on Zoom, Meet or Teams (“Them”).',
    icon: <Speaker size={15} />
  }
}

export function PermissionRow({
  kind,
  state,
  onRequest
}: {
  kind: PermissionKind
  state: Permissions[PermissionKind] | undefined
  onRequest: (kind: PermissionKind) => void
}) {
  const { title, hint, icon } = LABELS[kind]
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-fill-soft text-ink-secondary">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink-primary">{title}</div>
        <div className="text-[12px] text-ink-tertiary">
          {state === 'denied'
            ? isMac
              ? 'Turned off in System Settings. Turn on “Electron” (or “Oats”) there.'
              : 'Turned off in Windows Settings → Privacy & security → Microphone. Turn on desktop app access there.'
            : state === 'not-determined'
              ? `Not allowed yet. ${hint}`
              : hint}
        </div>
      </div>
      {state === 'granted' ? (
        <span className="flex items-center gap-1 text-[12px] font-medium text-ink-accent">
          <Check size={14} /> Allowed
        </span>
      ) : state === 'denied' ? (
        <Button variant="outline" size="sm" onClick={() => onRequest(kind)}>
          Open Settings
        </Button>
      ) : (
        <Button variant="accent" size="sm" disabled={!state} onClick={() => onRequest(kind)}>
          Allow
        </Button>
      )}
    </div>
  )
}

export function PermissionsList({ kinds }: { kinds: PermissionKind[] }) {
  const { permissions, request } = usePermissions()
  return (
    <div className="divide-y divide-hairline">
      {kinds.map((k) => (
        <PermissionRow key={k} kind={k} state={permissions?.[k]} onRequest={request} />
      ))}
    </div>
  )
}
