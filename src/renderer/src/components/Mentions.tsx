import Mention from '@tiptap/extension-mention'
import { ReactRenderer } from '@tiptap/react'
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion'
import { Copy, Mail } from 'lucide-react'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type MouseEvent } from 'react'
import { dayLabel, noteTitle } from '../lib/format'
import { findPerson, suggestPeople, type Person } from '../lib/people'
import { useStore } from '../lib/store'
import { Avatar, Button } from './ui'

// @-mentions of people from the user's meetings, and the card shown when hovering one.

interface ListHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean
}

const MentionList = forwardRef<ListHandle, SuggestionProps<Person>>(function MentionList({ items, command }, ref) {
  const [index, setIndex] = useState(0)
  useEffect(() => setIndex(0), [items])
  const pick = (i: number) => {
    const p = items[i]
    if (p) command({ id: p.id, label: p.name })
  }
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (!items.length) return false
      if (event.key === 'ArrowDown') setIndex((i) => (i + 1) % items.length)
      else if (event.key === 'ArrowUp') setIndex((i) => (i - 1 + items.length) % items.length)
      else if (event.key === 'Enter' || event.key === 'Tab') pick(index)
      else return false
      return true
    }
  }))
  if (!items.length) return null
  return (
    <div className="w-64 rounded-xl border border-hairline bg-surface-elevated p-1 shadow-lg">
      {items.map((p, i) => (
        <button
          key={p.id}
          type="button"
          onMouseEnter={() => setIndex(i)}
          onMouseDown={(e) => {
            e.preventDefault()
            pick(i)
          }}
          className={`flex w-full cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-left ${i === index ? 'bg-fill-soft' : ''}`}
        >
          <Avatar name={p.name} className="size-5 text-[9px] ring-0" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[13px] text-ink-primary">{p.name}</span>
            {p.email && p.email !== p.name && <span className="truncate text-[11px] text-ink-tertiary">{p.email}</span>}
          </span>
        </button>
      ))}
    </div>
  )
})

/** The mention node; `noteId` puts the current note's attendees first. */
export function PersonMention(noteId: () => string | undefined) {
  return Mention.configure({
    HTMLAttributes: { class: 'mention' },
    renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
    suggestion: {
      char: '@',
      items: ({ query }) => suggestPeople(query, noteId()),
      render: () => {
        let list: ReactRenderer<ListHandle, SuggestionProps<Person>> | undefined
        let box: HTMLDivElement | undefined
        const place = (props: SuggestionProps<Person>) => {
          const rect = props.clientRect?.()
          if (!box || !rect) return
          box.style.left = `${rect.left}px`
          box.style.top = `${rect.bottom + 6}px`
        }
        return {
          onStart: (props) => {
            list = new ReactRenderer(MentionList, { props, editor: props.editor })
            box = document.createElement('div')
            box.style.position = 'fixed'
            box.style.zIndex = '60'
            box.appendChild(list.element)
            document.body.appendChild(box)
            place(props)
          },
          onUpdate: (props) => {
            list?.updateProps(props)
            if (box) box.style.display = ''
            place(props)
          },
          onKeyDown: (props) => {
            if (props.event.key === 'Escape') {
              if (box) box.style.display = 'none'
              return true
            }
            return list?.ref?.onKeyDown(props) ?? false
          },
          onExit: () => {
            box?.remove()
            list?.destroy()
          }
        }
      }
    }
  })
}

/** Shows a person's card while the pointer rests on a mention inside `container`. */
export function useMentionCard() {
  const [card, setCard] = useState<{ id: string; label: string; rect: DOMRect } | null>(null)
  const timer = useRef<number>(undefined)
  const schedule = (fn: () => void, ms: number) => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(fn, ms)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const handlers = {
    onMouseOver: (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-type="mention"]')
      if (!el) return
      const id = el.dataset.id ?? ''
      schedule(() => setCard({ id, label: el.dataset.label ?? id, rect: el.getBoundingClientRect() }), 350)
    },
    onMouseOut: (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('[data-type="mention"]')) schedule(() => setCard(null), 250)
    }
  }
  const view = card && (
    <PersonCard
      key={card.id}
      id={card.id}
      label={card.label}
      rect={card.rect}
      onEnter={() => window.clearTimeout(timer.current)}
      onLeave={() => schedule(() => setCard(null), 250)}
      onClose={() => setCard(null)}
    />
  )
  return { handlers, card: view }
}

function PersonCard({
  id,
  label,
  rect,
  onEnter,
  onLeave,
  onClose
}: {
  id: string
  label: string
  rect: DOMRect
  onEnter: () => void
  onLeave: () => void
  onClose: () => void
}) {
  const person = findPerson(id)
  const navigate = useStore((s) => s.navigate)
  const [copied, setCopied] = useState(false)
  const name = person?.name ?? label
  const email = person?.email
  const below = rect.bottom + 260 < window.innerHeight
  return (
    <div
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        position: 'fixed',
        left: Math.min(rect.left, window.innerWidth - 300),
        ...(below ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 })
      }}
      className="z-60 w-72 rounded-xl border border-hairline bg-surface-elevated p-3 shadow-xl select-none"
    >
      <div className="flex items-center gap-2.5">
        <Avatar name={name} className="size-9 text-[13px] ring-0" />
        <div className="min-w-0">
          <div className="truncate text-[14px] font-medium text-ink-strong">{name}</div>
          {email && email !== name && <div className="truncate text-[12px] text-ink-tertiary">{email}</div>}
        </div>
      </div>
      <div className="mt-3 text-[11px] font-medium tracking-wide text-ink-tertiary uppercase">
        {person ? `${person.notes.length} meeting${person.notes.length === 1 ? '' : 's'} together` : 'Not in any meeting yet'}
      </div>
      {person && (
        <div className="mt-1 -mx-1">
          {person.notes.slice(0, 4).map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => {
                onClose()
                navigate({ view: 'note', id: n.id })
              }}
              className="flex w-full cursor-default items-center justify-between gap-2 rounded-lg px-1.5 py-1 text-left text-[13px] hover:bg-fill-soft"
            >
              <span className="truncate text-ink-primary">{noteTitle(n)}</span>
              <span className="shrink-0 text-[11px] text-ink-tertiary">{dayLabel(n.createdAt)}</span>
            </button>
          ))}
        </div>
      )}
      {email && (
        <div className="mt-2.5 flex gap-1.5">
          <Button size="sm" variant="outline" onClick={() => window.oats.openExternal(`mailto:${email}`)}>
            <Mail size={13} /> Email
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              navigator.clipboard.writeText(email)
              setCopied(true)
            }}
          >
            <Copy size={13} /> {copied ? 'Copied' : 'Copy email'}
          </Button>
        </div>
      )}
    </div>
  )
}
