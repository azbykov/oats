import { FileText, Folder, Search, Sparkles, SquarePen } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SemanticHit } from '../../../shared/types'
import { dayLabel, noteTitle } from '../lib/format'
import { useStore } from '../lib/store'

type Result = {
  key: string
  icon: ReactNode
  title: string
  subtitle?: string
  run: () => void
  /** Shown as a heading above the first result of the group. */
  group?: string
}

const RELATED = 5
// e5 scores everything fairly high: related passages measured ~0.84–0.89, unrelated ~0.74–0.78.
const RELATED_MIN_SCORE = 0.8
const RELATED_BELOW_BEST = 0.04

function snippet(text: string, q: string) {
  const i = text.toLowerCase().indexOf(q)
  if (i < 0) return undefined
  const start = Math.max(0, i - 30)
  return `${start ? '…' : ''}${text.slice(start, i + q.length + 50).replace(/\s+/g, ' ')}…`
}

export function SearchDialog() {
  const open = useStore((s) => s.searchOpen)
  const setOpen = useStore((s) => s.setSearchOpen)
  const data = useStore((s) => s.data!)
  const [q, setQ] = useState('')
  const [index, setIndex] = useState(0)
  // Notes the full-text index matched for the current query (words of 3+ characters).
  const [found, setFound] = useState<{ q: string; ids: Set<string> } | null>(null)

  useEffect(() => {
    const query = q.trim()
    if (!query.split(/\s+/).some((w) => [...w].length >= 3)) {
      setFound(null)
      return
    }
    let live = true
    window.oats.searchNotes(query).then((ids) => live && setFound({ q: query, ids: new Set(ids) }))
    return () => {
      live = false
    }
  }, [q])

  // Notes about the same thing in other words (or another language), from the local model.
  const [related, setRelated] = useState<{ q: string; hits: SemanticHit[] } | null>(null)
  useEffect(() => {
    const query = q.trim()
    if ([...query].length < 4) {
      setRelated(null)
      return
    }
    let live = true
    const timer = window.setTimeout(() => {
      window.oats
        .semanticSearch(query, undefined, 30)
        .then((hits) => live && setRelated(hits ? { q: query, hits } : null))
        .catch(() => {})
    }, 250)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [q])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(!useStore.getState().searchOpen)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setOpen])

  useEffect(() => {
    if (open) {
      setQ('')
      setIndex(0)
    }
  }, [open])

  const results = useMemo<Result[]>(() => {
    const { navigate, createNote } = useStore.getState()
    const query = q.trim().toLowerCase()
    const indexed = found && found.q.toLowerCase() === query ? found.ids : null
    const out: Result[] = []
    if (!query) {
      out.push({
        key: 'new',
        icon: <SquarePen size={15} />,
        title: 'New note',
        run: () => navigate({ view: 'note', id: createNote().id })
      })
    }
    for (const f of data.folders) {
      if (!query || f.name.toLowerCase().includes(query))
        out.push({ key: f.id, icon: <Folder size={15} />, title: f.name, run: () => navigate({ view: 'folder', id: f.id }) })
    }
    const notes = [...data.notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    for (const n of notes) {
      const title = noteTitle(n)
      let subtitle: string | undefined = dayLabel(n.createdAt)
      if (query) {
        const inTitle = title.toLowerCase().includes(query)
        if (indexed && !indexed.has(n.id) && !inTitle) continue
        const hit =
          snippet(n.notesMarkdown, query) ??
          snippet(n.panels.map((p) => p.markdown).join('\n'), query) ??
          snippet(n.transcript.map((s) => s.text).join(' '), query)
        if (!inTitle && !hit && !indexed) continue
        subtitle = hit ?? subtitle
      }
      out.push({ key: n.id, icon: <FileText size={15} />, title, subtitle, run: () => navigate({ view: 'note', id: n.id }) })
      if (out.length > 40) break
    }
    if (query && related && related.q.toLowerCase() === query) {
      const shown = new Set(out.map((r) => r.key))
      const byId = new Map(data.notes.map((n) => [n.id, n]))
      const floor = Math.max(RELATED_MIN_SCORE, (related.hits[0]?.score ?? 1) - RELATED_BELOW_BEST)
      let added = 0
      for (const hit of related.hits) {
        const n = byId.get(hit.noteId)
        if (!n || shown.has(n.id) || added >= RELATED || hit.score < floor) continue
        shown.add(n.id)
        out.push({
          key: `related-${n.id}`,
          icon: <Sparkles size={15} />,
          title: noteTitle(n),
          subtitle: hit.text.replace(/\s+/g, ' ').slice(0, 120),
          run: () => navigate({ view: 'note', id: n.id }),
          group: added === 0 ? 'Related by meaning' : undefined
        })
        added++
      }
    }
    return out
  }, [q, data, found, related])

  if (!open) return null
  const choose = (r?: Result) => {
    if (!r) return
    setOpen(false)
    r.run()
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/20 pt-[12vh] backdrop-blur-[1px]" onMouseDown={() => setOpen(false)}>
      <div
        className="flex h-fit max-h-[60vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-hairline bg-surface-elevated shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-hairline px-4">
          <Search size={16} className="text-ink-tertiary" />
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setIndex(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false)
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIndex((i) => Math.min(results.length - 1, i + 1))
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIndex((i) => Math.max(0, i - 1))
              }
              if (e.key === 'Enter') choose(results[index])
            }}
            placeholder="Search notes, transcripts and folders"
            className="h-12 flex-1 bg-transparent text-[15px] text-ink-primary outline-none placeholder:text-ink-tertiary"
          />
        </div>
        <div className="min-h-0 overflow-y-auto p-1.5">
          {results.map((r, i) => [
            r.group && (
              <div key={`${r.key}-group`} className="px-3 pt-2.5 pb-1 text-[11px] font-medium tracking-wide text-ink-tertiary uppercase">
                {r.group}
              </div>
            ),
            <button
              key={r.key}
              type="button"
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(r)}
              className={`flex w-full cursor-default items-center gap-3 rounded-lg px-3 py-2 text-left ${i === index ? 'bg-fill-soft' : ''}`}
            >
              <span className="text-ink-tertiary">{r.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] text-ink-primary">{r.title}</span>
                {r.subtitle && <span className="block truncate text-[12px] text-ink-tertiary">{r.subtitle}</span>}
              </span>
            </button>
          ])}
          {!results.length && <p className="px-3 py-6 text-center text-[13px] text-ink-tertiary">No results</p>}
        </div>
      </div>
    </div>
  )
}
