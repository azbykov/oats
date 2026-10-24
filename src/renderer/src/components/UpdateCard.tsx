import { ArrowDownToLine, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { UpdateState } from '../../../shared/types'
import { useStore } from '../lib/store'
import { Button, IconButton } from './ui'

/** "A new version is available" at the bottom of the sidebar, once per version per launch. */
export function UpdateCard() {
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const live = useStore((s) => s.recording.status === 'recording' || s.recording.status === 'starting')

  useEffect(() => {
    window.oats.getUpdate().then((u) => u && setUpdate(u))
    return window.oats.onUpdate(setUpdate)
  }, [])

  if (!update || dismissed === `${update.status}:${update.version}`) return null
  const ready = update.status === 'ready'
  return (
    <div className="mx-2 mb-2 rounded-xl border border-hairline bg-surface-elevated p-3 shadow-sm">
      <div className="flex items-start gap-2.5">
        <ArrowDownToLine size={15} className="mt-0.5 shrink-0 text-ink-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-ink-strong">Oats {update.version}</div>
          <div className="text-[12px] leading-snug text-ink-tertiary">
            {!ready
              ? 'A new version is available.'
              : live
                ? 'Downloaded. Restart after the call to finish updating.'
                : 'Downloaded. Restart to finish updating.'}
          </div>
        </div>
        <IconButton label="Dismiss" size="sm" onClick={() => setDismissed(`${update.status}:${update.version}`)}>
          <X size={13} />
        </IconButton>
      </div>
      {ready ? (
        // Restarting mid-call would cut the recording; the update also installs on quit.
        <Button
          variant="accent"
          size="sm"
          className="mt-2.5 w-full"
          disabled={live}
          onClick={() => window.oats.installUpdate()}
        >
          Restart to update
        </Button>
      ) : (
        <Button variant="accent" size="sm" className="mt-2.5 w-full" onClick={() => window.oats.openExternal(update.downloadUrl)}>
          Download
        </Button>
      )}
    </div>
  )
}
