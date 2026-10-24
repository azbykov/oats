import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'

type Variant = 'ghost' | 'soft' | 'accent' | 'primary' | 'outline' | 'danger'
type Size = 'sm' | 'md' | 'lg'

const variants: Record<Variant, string> = {
  ghost: 'text-ink-secondary hover:bg-fill-soft hover:text-ink-primary',
  soft: 'bg-fill-soft text-ink-primary hover:bg-fill-soft-hover',
  accent: 'bg-fill-accent text-white hover:bg-fill-accent-hover shadow-sm',
  primary: 'bg-fill-primary text-surface hover:opacity-90',
  outline: 'border border-hairline bg-surface-elevated text-ink-primary hover:bg-fill-soft',
  danger: 'bg-ink-danger text-white hover:opacity-90'
}
const sizes: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-[13px] gap-1.5 rounded-lg',
  md: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  lg: 'h-10 px-4 text-sm gap-2 rounded-full'
}

export function Button({
  variant = 'soft',
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type="button"
      className={`inline-flex shrink-0 cursor-default items-center justify-center font-medium whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-50 ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  )
}

export function IconButton({
  label,
  className = '',
  size = 'md',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: 'sm' | 'md' }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 cursor-default items-center justify-center rounded-lg text-ink-secondary transition-colors hover:bg-fill-soft hover:text-ink-primary disabled:opacity-40 ${size === 'sm' ? 'size-6' : 'size-8'} ${className}`}
      {...props}
    />
  )
}

export function Chip({ children, className = '', onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'span'
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`inline-flex h-7 cursor-default items-center gap-1.5 rounded-lg border border-hairline px-2 text-[13px] text-ink-secondary ${onClick ? 'hover:bg-fill-soft hover:text-ink-primary' : ''} ${className}`}
    >
      {children}
    </Tag>
  )
}

/** Minimal anchored popover: click-outside and Escape close it. */
export function Popover({
  trigger,
  children,
  align = 'left',
  side = 'bottom',
  className = ''
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  side?: 'bottom' | 'top'
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          className={`absolute z-50 min-w-52 rounded-xl border border-hairline bg-surface-elevated p-1 shadow-lg ${align === 'right' ? 'right-0' : 'left-0'} ${side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'} ${className}`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

export function MenuItem({
  children,
  onClick,
  danger,
  active
}: {
  children: ReactNode
  onClick: () => void
  danger?: boolean
  active?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-fill-soft ${danger ? 'text-ink-danger' : 'text-ink-primary'} ${active ? 'bg-fill-soft' : ''}`}
    >
      {children}
    </button>
  )
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-ink-tertiary uppercase">{children}</div>
}

/** Dancing bars of the transcription pill. */
export function DancingBars({ active, level = 0.5, className = '' }: { active: boolean; level?: number; className?: string }) {
  const heights = [0.55, 1, 0.75]
  return (
    <span className={`flex h-4 items-center gap-[2px] ${className}`} aria-hidden>
      {heights.map((h, i) => (
        <span
          key={i}
          className={`w-[3px] origin-center rounded-full ${active ? 'bg-oats-grass' : 'bg-ink-tertiary'}`}
          style={{
            height: `${active ? Math.max(25, Math.min(100, (0.35 + level) * h * 100)) : 30}%`,
            animation: active ? `oats-bar ${0.7 + i * 0.15}s ease-in-out ${i * 0.1}s infinite` : undefined,
            transition: 'height 120ms ease'
          }}
        />
      ))}
    </span>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-hairline px-1 font-sans text-[11px] text-ink-tertiary">{children}</kbd>
  )
}

export function Avatar({ name, src, className = '' }: { name: string; src?: string; className?: string }) {
  const [broken, setBroken] = useState(false)
  if (src && !broken) {
    return (
      <img
        src={src}
        alt={name}
        title={name}
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className={`inline-block size-6 shrink-0 rounded-full object-cover ring-2 ring-surface ${className}`}
      />
    )
  }
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0)
  const letters = name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('')
  return (
    <span
      title={name}
      className={`inline-flex size-6 items-center justify-center rounded-full text-[10px] font-semibold text-white ring-2 ring-surface ${className}`}
      style={{ background: `oklch(0.62 0.09 ${hue})` }}
    >
      {letters || '?'}
    </span>
  )
}
