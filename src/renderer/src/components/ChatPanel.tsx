import { ArrowUp, FileText, Square, Sparkles, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import type { ChatMessage, ChatScope, Note } from '../../../shared/types'
import { streamChat } from '../lib/ai'
import { dayLabel, fullDate, noteTitle } from '../lib/format'
import { markdownToHtml } from '../lib/markdown'
import { chatContext } from '../lib/retrieval'
import { useStore } from '../lib/store'
import { IconButton } from './ui'

type Message = ChatMessage & {
  /** How many meetings the answer was given, out of how many searched. */
  read?: { count: number; of: number }
}

const CITE = /meeting:\/\/([\w-]+)/g
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** Turns the model's meeting://<ref> links into links that open the note. */
function answerHtml(markdown: string, notes: Map<string, Note>) {
  return markdownToHtml(markdown).replace(
    /<a href="meeting:\/\/([\w-]+)"[^>]*>([\s\S]*?)<\/a>/g,
    (_, ref: string, text: string) => {
      const note = notes.get(ref)
      if (!note) return text
      const title = escapeAttr(`${noteTitle(note)} · ${dayLabel(note.createdAt)}`)
      return `<a href="#" class="meeting-cite" data-note-id="${note.id}" title="${title}">${text}</a>`
    }
  )
}

/** The meetings an answer cites, in order of first mention. */
function citedNotes(markdown: string, notes: Map<string, Note>) {
  const refs = new Set([...markdown.matchAll(CITE)].map((m) => m[1]))
  return [...refs].map((r) => notes.get(r)).filter((n): n is Note => !!n)
}

export function ChatDock({
  scope,
  noteId,
  folderId,
  leading,
  above
}: {
  scope: ChatScope
  noteId?: string
  folderId?: string
  leading?: ReactNode
  above?: ReactNode
}) {
  const recipes = useStore((s) => s.data!.recipes)
  const allNotes = useStore((s) => s.data!.notes)
  const folderName = useStore((s) => s.data!.folders.find((f) => f.id === folderId)?.name)
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  // Each meeting keeps its citation ref for the whole conversation, so earlier answers stay linked.
  const refs = useRef(new Map<string, string>())
  const [open, setOpen] = useState(false)
  const [streaming, setStreaming] = useState<{ abort: () => void } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [recipeIndex, setRecipeIndex] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const slashQuery = input.startsWith('/') ? input.slice(1).toLowerCase() : null
  const matches = useMemo(
    () =>
      slashQuery === null
        ? []
        : recipes.filter((r) => r.slug.includes(slashQuery) || r.title.toLowerCase().includes(slashQuery)),
    [recipes, slashQuery]
  )

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  const byRef = useMemo(() => {
    const byId = new Map(allNotes.map((n) => [n.id, n]))
    const out = new Map<string, Note>()
    for (const [id, ref] of refs.current) {
      const note = byId.get(id)
      if (note) out.set(ref, note)
    }
    return out
    // refs only grow when a message is sent, which also changes `messages`.
  }, [allNotes, messages])

  const refFor = (id: string) => {
    let ref = refs.current.get(id)
    if (!ref) {
      ref = `m${refs.current.size + 1}`
      refs.current.set(id, ref)
    }
    return ref
  }

  const send = async (text: string) => {
    if (!text.trim() || streaming) return
    const notes = useStore.getState().data!.notes
    const pool =
      scope === 'note'
        ? notes.filter((n) => n.id === noteId)
        : scope === 'folder'
          ? notes.filter((n) => n.folderIds.includes(folderId!))
          : notes
    const history: Message[] = [...messages, { role: 'user', content: text.trim() }]
    // Earlier questions steer the search too, for follow-ups like "and what did she say about it?"
    const question = history
      .filter((m) => m.role === 'user')
      .slice(-3)
      .map((m) => m.content)
      .join('\n')
    setMessages([...history, { role: 'assistant', content: '' }])
    setInput('')
    setOpen(true)
    setError(null)
    // Passages found by meaning, when the local model is downloaded (Settings → AI).
    let cancelled = false
    setStreaming({
      abort: () => {
        cancelled = true
        setStreaming(null)
        setMessages((m) => m.slice(0, -1))
      }
    })
    const semantic =
      scope === 'note' || !pool.length
        ? null
        : await window.oats.semanticSearch(question, pool.map((n) => n.id), 60).catch(() => null)
    if (cancelled) return
    const context = chatContext(pool, question, refFor, scope === 'note' ? { perMeeting: Infinity } : { semantic })
    const read = scope === 'note' ? undefined : { count: context.length, of: pool.length }
    setMessages((m) => [...m.slice(0, -1), { role: 'assistant', content: '', read }])
    const s = streamChat(
      {
        messages: history.map(({ role, content }) => ({ role, content })),
        context,
        scope,
        folderName,
        searched: pool.length,
        today: fullDate(new Date().toISOString())
      },
      {
        onDelta: (_d, full) =>
          setMessages((m) => [...m.slice(0, -1), { role: 'assistant', content: full, read }])
      }
    )
    setStreaming(s)
    s.promise
      .catch((err: Error) => {
        setError(err.message)
        setMessages((m) => (m.at(-1)?.content ? m : m.slice(0, -1)))
      })
      .finally(() => setStreaming(null))
  }

  const openCitation = (e: MouseEvent) => {
    const link = (e.target as HTMLElement).closest<HTMLElement>('[data-note-id]')
    if (!link) return
    e.preventDefault()
    useStore.getState().navigate({ view: 'note', id: link.dataset.noteId! })
  }

  const pickRecipe = (i: number) => {
    const r = matches[i]
    if (r) send(r.prompt)
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center px-6 pb-5">
      {open && messages.length > 0 && (
        <div className="pointer-events-auto mb-3 flex max-h-[55vh] w-full max-w-2xl flex-col rounded-2xl border border-hairline bg-surface-elevated shadow-xl">
          <div className="flex items-center justify-between border-b border-hairline px-4 py-2">
            <span className="flex items-center gap-1.5 text-[12px] font-medium text-ink-tertiary">
              <Sparkles size={13} />{' '}
              {scope === 'note'
                ? 'Chat about this meeting'
                : scope === 'folder'
                  ? `Chat about “${folderName ?? 'this folder'}”`
                  : 'Chat across all your notes'}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="cursor-default rounded-md px-2 py-0.5 text-[12px] text-ink-tertiary hover:bg-fill-soft hover:text-ink-primary"
                onClick={() => {
                  streaming?.abort()
                  refs.current.clear()
                  setMessages([])
                  setError(null)
                }}
              >
                New chat
              </button>
              <IconButton label="Close chat" size="sm" onClick={() => setOpen(false)}>
                <X size={14} />
              </IconButton>
            </div>
          </div>
          <div
            ref={scrollRef}
            onClick={openCitation}
            className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 select-text"
          >
            {messages.map((m, i) =>
              m.role === 'user' ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[80%] rounded-2xl rounded-br-md bg-fill-soft px-3.5 py-2 text-[14px] text-ink-primary">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={i}>
                  {m.read && (
                    <div className="mb-1.5 text-[12px] text-ink-tertiary">
                      {m.read.of === 0
                        ? 'No meetings to search yet'
                        : m.read.count < m.read.of
                          ? `Read ${m.read.count} most relevant of ${m.read.of} meetings`
                          : `Read ${m.read.of} meeting${m.read.of === 1 ? '' : 's'}`}
                    </div>
                  )}
                  {m.content ? (
                    <div
                      className="markdown-chat text-[14px] leading-relaxed text-ink-primary"
                      dangerouslySetInnerHTML={{ __html: answerHtml(m.content, byRef) }}
                    />
                  ) : (
                    <div className="shimmer-text text-[14px]">
                      {scope !== 'note' && !m.read ? 'Searching your meetings…' : 'Thinking…'}
                    </div>
                  )}
                  {!(streaming && i === messages.length - 1) && <Sources notes={citedNotes(m.content, byRef)} />}
                </div>
              )
            )}
            {error && <p className="text-[13px] text-ink-danger">{error}</p>}
          </div>
        </div>
      )}

      {above && <div className="pointer-events-auto mb-3">{above}</div>}

      <div className="pointer-events-auto relative flex w-full max-w-2xl items-end gap-2">
        {leading}
        <div className="relative min-w-0 flex-1">
          {matches.length > 0 && (
            <div className="absolute bottom-full left-0 mb-2 w-72 rounded-xl border border-hairline bg-surface-elevated p-1 shadow-lg">
              <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-ink-tertiary uppercase">
                Recipes
              </div>
              {matches.map((r, i) => (
                <button
                  key={r.id}
                  type="button"
                  onMouseEnter={() => setRecipeIndex(i)}
                  onClick={() => pickRecipe(i)}
                  className={`flex w-full cursor-default items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] ${i === recipeIndex ? 'bg-fill-soft' : ''}`}
                >
                  <span className="text-ink-primary">{r.title}</span>
                  <span className="text-[11px] text-ink-tertiary">/{r.slug}</span>
                </button>
              ))}
            </div>
          )}
          <div
            className="flex min-h-12 items-end gap-2 rounded-[24px] border border-hairline bg-surface-elevated py-2 pr-2 pl-5 shadow-[0_2px_12px_rgba(0,0,0,0.06)]"
            onClick={() => inputRef.current?.focus()}
          >
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              placeholder={messages.length ? 'Ask a follow-up' : 'Ask anything'}
              onFocus={() => messages.length && setOpen(true)}
              onChange={(e) => {
                setInput(e.target.value)
                setRecipeIndex(0)
              }}
              onKeyDown={(e) => {
                if (matches.length) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setRecipeIndex((i) => (i + 1) % matches.length)
                    return
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setRecipeIndex((i) => (i - 1 + matches.length) % matches.length)
                    return
                  }
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault()
                    pickRecipe(recipeIndex)
                    return
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send(input)
                }
                if (e.key === 'Escape') setOpen(false)
              }}
              className="field-sizing-content max-h-40 min-h-7 flex-1 resize-none bg-transparent py-[3px] text-[15px] leading-[22px] text-ink-primary caret-fill-accent outline-none placeholder:text-ink-tertiary"
            />
            {streaming ? (
              <IconButton label="Stop" className="rounded-full bg-fill-soft" onClick={streaming.abort}>
                <Square size={12} fill="currentColor" />
              </IconButton>
            ) : (
              <button
                type="button"
                aria-label="Send"
                disabled={!input.trim()}
                onClick={() => send(input)}
                className="flex size-8 cursor-default items-center justify-center rounded-full bg-fill-primary text-surface transition-opacity disabled:opacity-20"
              >
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Sources({ notes }: { notes: Note[] }) {
  if (!notes.length) return null
  return (
    <div className="mt-2.5 flex flex-wrap gap-1.5">
      {notes.map((n) => (
        <button
          key={n.id}
          type="button"
          data-note-id={n.id}
          className="inline-flex h-6 max-w-64 cursor-default items-center gap-1.5 rounded-md border border-hairline px-2 text-[12px] text-ink-secondary hover:bg-fill-soft hover:text-ink-primary"
        >
          <FileText size={12} className="shrink-0" />
          <span className="truncate">{noteTitle(n)}</span>
          <span className="shrink-0 text-ink-tertiary">{dayLabel(n.createdAt)}</span>
        </button>
      ))}
    </div>
  )
}
