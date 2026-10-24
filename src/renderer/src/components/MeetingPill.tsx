import { ChevronDown, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { PillState } from '../../../shared/types'
import { DancingBars } from './ui'

// Content of the floating "meeting detected" window (main/pill.ts). The window is
// transparent and lets clicks through, except over elements marked data-hit.

const AUTO_DISMISS_MS = 30_000

function useTheme(theme: PillState['theme'] | undefined) {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () =>
      document.documentElement.classList.toggle('dark', theme === 'dark' || (theme !== 'light' && media.matches))
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
}

/** Only the card and its menu catch the mouse; everything else passes through. */
function useClickThrough() {
  useEffect(() => {
    let over = false
    const onMove = (e: MouseEvent) => {
      const hit = !!(e.target as Element | null)?.closest?.('[data-hit]')
      if (hit !== over) {
        over = hit
        window.oats.setPillIgnoreMouse(!hit)
      }
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [])
}

export function MeetingPill() {
  const [state, setState] = useState<PillState | null>(null)
  const [menu, setMenu] = useState(false)
  const [hover, setHover] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const last = useRef(Date.now())

  useEffect(() => {
    window.oats.getPillState().then(setState)
    return window.oats.onPillState((s) => {
      setState(s)
      setElapsed(0)
    })
  }, [])
  useTheme(state?.theme)
  useClickThrough()

  // Counts down only while the user isn't looking at it.
  const paused = hover || menu
  useEffect(() => {
    last.current = Date.now()
    if (paused) return
    const t = window.setInterval(() => {
      const now = Date.now()
      setElapsed((e) => e + now - last.current)
      last.current = now
    }, 100)
    return () => window.clearInterval(t)
  }, [paused])
  useEffect(() => {
    if (elapsed >= AUTO_DISMISS_MS) window.oats.sendPillAction({ type: 'dismiss' })
  }, [elapsed])

  if (!state) return null
  const { app, templates } = state
  const progress = Math.max(0, 1 - elapsed / AUTO_DISMISS_MS)

  return (
    <div className="flex h-full flex-col items-end p-3" onMouseLeave={() => setHover(false)}>
      <div
        data-hit
        onMouseEnter={() => setHover(true)}
        className="group relative w-[400px] animate-[pill-in_220ms_ease-out] rounded-2xl border border-hairline bg-surface-elevated shadow-[0_8px_30px_rgba(0,0,0,0.18)]"
      >
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => window.oats.sendPillAction({ type: 'dismiss' })}
          className="absolute -top-2 -left-2 z-10 flex size-6 cursor-default items-center justify-center rounded-full border border-hairline bg-surface-elevated text-ink-secondary opacity-0 shadow-sm transition-opacity group-hover:opacity-100 hover:text-ink-primary"
        >
          <X size={12} />
        </button>
        <div className="flex items-center gap-3 p-3 pb-3.5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-oats-green-50 dark:bg-oats-green-700">
            <DancingBars active level={0.5} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-ink-strong">Meeting detected</div>
            <div className="truncate text-[12px] text-ink-secondary">{app.name}</div>
          </div>
          <div className="flex shrink-0 items-stretch overflow-hidden rounded-xl bg-fill-accent text-white shadow-sm">
            <button
              type="button"
              onClick={() => window.oats.sendPillAction({ type: 'take-notes' })}
              className="cursor-default px-3.5 py-2 text-[13px] font-medium hover:bg-fill-accent-hover"
            >
              Take notes
            </button>
            <button
              type="button"
              aria-label="More options"
              onClick={() => setMenu((m) => !m)}
              className="flex cursor-default items-center border-l border-white/25 px-2 hover:bg-fill-accent-hover"
            >
              <ChevronDown size={14} className={`transition-transform ${menu ? 'rotate-180' : ''}`} />
            </button>
          </div>
        </div>
        <div className="absolute inset-x-4 bottom-1 h-[2px] overflow-hidden rounded-full bg-fill-soft">
          <div className="h-full bg-fill-accent/60 transition-[width] duration-100" style={{ width: `${progress * 100}%` }} />
        </div>
      </div>

      {menu && (
        <div
          data-hit
          onMouseEnter={() => setHover(true)}
          className="mt-1.5 w-60 rounded-xl border border-hairline bg-surface-elevated p-1 shadow-[0_8px_30px_rgba(0,0,0,0.18)]"
        >
          <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-ink-tertiary uppercase">
            Take notes with
          </div>
          <div className="max-h-44 overflow-y-auto">
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => window.oats.sendPillAction({ type: 'take-notes', templateId: t.id })}
                className="block w-full cursor-default truncate rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink-primary hover:bg-fill-soft"
              >
                {t.title}
              </button>
            ))}
          </div>
          <div className="my-1 border-t border-hairline" />
          <button
            type="button"
            onClick={() => window.oats.sendPillAction({ type: 'dismiss' })}
            className="block w-full cursor-default rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink-primary hover:bg-fill-soft"
          >
            Not a meeting
          </button>
          <button
            type="button"
            onClick={() => window.oats.sendPillAction({ type: 'ignore-app' })}
            className="block w-full cursor-default truncate rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink-secondary hover:bg-fill-soft"
          >
            Don’t show for {app.name}
          </button>
        </div>
      )}
    </div>
  )
}
