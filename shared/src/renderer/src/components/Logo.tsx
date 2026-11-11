import { useEffect, useRef, useState, type AnimationEvent } from 'react'

type Motion = 'drop' | 'spin' | 'sway' | null

// The drop plays once per app launch, not every time the sidebar remounts (focus mode).
let dropped = false

/**
 * The oat grain (assets/logo.svg) with motion: it drops in on launch, spins while `busy`
 * and wiggles when hovered. Each motion finishes at rest, so switching never jumps.
 * Animations live in styles.css (.oats-logo).
 */
export function Logo({ busy = false, className = '' }: { busy?: boolean; className?: string }) {
  const [motion, setMotion] = useState<Motion>(() => (dropped ? null : 'drop'))
  const busyRef = useRef(busy)
  busyRef.current = busy

  useEffect(() => {
    dropped = true
  }, [])
  useEffect(() => {
    if (busy) setMotion((m) => m ?? 'spin')
  }, [busy])

  const onEnd = (e: AnimationEvent) => {
    if (e.animationName === 'oats-logo-drop' || e.animationName === 'oats-logo-sway')
      setMotion(busyRef.current ? 'spin' : null)
  }
  // A spin turn ends where it started, so stop on a turn boundary once the work is done.
  const onIteration = (e: AnimationEvent) => {
    if (e.animationName === 'oats-logo-spin' && !busyRef.current) setMotion(null)
  }

  return (
    <svg
      viewBox="0 0 64 64"
      className={`oats-logo ${className}`}
      data-motion={motion ?? undefined}
      onAnimationEnd={onEnd}
      onAnimationIteration={onIteration}
      onMouseEnter={() => setMotion((m) => m ?? 'sway')}
      aria-hidden
    >
      <rect width="64" height="64" rx="16" fill="#313225" />
      <g className="oats-logo-grain">
        <ellipse cx="32" cy="32" rx="11" ry="21" fill="#d1e043" />
        <path
          className="oats-logo-groove"
          d="M32 15v34"
          stroke="#313225"
          strokeWidth="2.6"
          strokeLinecap="round"
          opacity=".55"
        />
      </g>
    </svg>
  )
}

/** Loading indicator: the grain's outline in currentColor, with a stroke running around it. */
export function GrainSpinner({ className = 'size-4' }: { className?: string }) {
  return (
    <svg viewBox="12 12 40 40" className={`grain-spinner ${className}`} role="status" aria-label="Loading">
      <g transform="rotate(-32 32 32)" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
        <ellipse cx="32" cy="32" rx="11" ry="21" opacity=".25" />
        <ellipse className="grain-spinner-chase" cx="32" cy="32" rx="11" ry="21" pathLength="100" />
        <path d="M32 21v22" opacity=".5" />
      </g>
    </svg>
  )
}
