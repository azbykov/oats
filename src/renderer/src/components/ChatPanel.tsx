import { ArrowUp, Square, Sparkles, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChatMessage, ChatRequest, Note } from '../../../shared/types'
import { streamChat } from '../lib/ai'
import { fullDate, transcriptText } from '../lib/format'
import { markdownToHtml } from '../lib/markdown'
import { useStore } from '../lib/store'
import { IconButton } from './ui'

function noteContext(n: Note): ChatRequest['context'][number] {
  const enhanced = n.panels.at(-1)?.markdown
  return {
    title: n.title,
    date: fullDate(n.createdAt),
    notesMarkdown: enhanced ? `${n.notesMarkdown}\n\n--- Enhanced notes ---\n${enhanced}` : n.notesMarkdown,
    transcript: transcriptText(n)
  }
}

const MAX_NOTES_IN_GLOBAL_CHAT = 50

export function ChatDock({
  scope,
  noteId,
  leading,
  above
}: {
  scope: 'note' | 'all'
  noteId?: string
  leading?: ReactNode
  above?: ReactNode
}) {
  const recipes = useStore((s) => s.data!.recipes)
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
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

  const send = (text: string) => {
    if (!text.trim() || streaming) return
    const data = useStore.getState().data!
    const notes =
      scope === 'note'
        ? data.notes.filter((n) => n.id === noteId)
        : [...data.notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_NOTES_IN_GLOBAL_CHAT)
    const history: ChatMessage[] = [...messages, { role: 'user', content: text.trim() }]
    setMessages([...history, { role: 'assistant', content: '' }])
    setInput('')
    setOpen(true)
    setError(null)
    const s = streamChat(
      { messages: history, context: notes.map(noteContext), scope },
      {
        onDelta: (_d, full) =>
          setMessages((m) => [...m.slice(0, -1), { role: 'assistant', content: full }])
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
              <Sparkles size={13} /> {scope === 'note' ? 'Chat about this meeting' : 'Chat across all your notes'}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="cursor-default rounded-md px-2 py-0.5 text-[12px] text-ink-tertiary hover:bg-fill-soft hover:text-ink-primary"
                onClick={() => {
                  streaming?.abort()
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
          <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 select-text">
            {messages.map((m, i) =>
              m.role === 'user' ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[80%] rounded-2xl rounded-br-md bg-fill-soft px-3.5 py-2 text-[14px] text-ink-primary">
                    {m.content}
                  </div>
                </div>
              ) : m.content ? (
                <div
                  key={i}
                  className="markdown-chat text-[14px] leading-relaxed text-ink-primary"
                  dangerouslySetInnerHTML={{ __html: markdownToHtml(m.content) }}
                />
              ) : (
                <div key={i} className="shimmer-text text-[14px]">
                  Thinking…
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
