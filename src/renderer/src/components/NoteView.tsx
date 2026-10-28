import {
  CalendarDays,
  Check,
  ChevronLeft,
  Copy,
  Download,
  FileText,
  Folder,
  FolderPlus,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  RefreshCw,
  Sparkles,
  Trash2,
  UserPlus,
  Users,
  X
} from 'lucide-react'
import { useCallback, useRef, useState, type ReactNode } from 'react'
import type { Note, Template } from '../../../shared/types'
import { streamEnhance } from '../lib/ai'
import { dayLabel, fullDate, noteTitle, timeLabel, transcriptText } from '../lib/format'
import { htmlToMarkdown, markAuthorship, markdownToHtml } from '../lib/markdown'
import { isMac } from '../lib/platform'
import { stopTranscription } from '../lib/transcription'
import { uid, useNote, useStore } from '../lib/store'
import { ChatDock } from './ChatPanel'
import { NoteEditor } from './NoteEditor'
import { TranscribePill, TranscriptDrawer } from './Transcription'
import { Avatar, Button, Chip, IconButton, MenuItem, MenuLabel, Popover } from './ui'

function TitleInput({ note }: { note: Note }) {
  const updateNote = useStore((s) => s.updateNote)
  const ref = useRef<HTMLTextAreaElement>(null)
  return (
    <textarea
      ref={ref}
      rows={1}
      value={note.title}
      placeholder="New note"
      onChange={(e) => updateNote(note.id, { title: e.target.value.replace(/\n/g, ' ') })}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ;(document.querySelector('.prose-oats') as HTMLElement | null)?.focus()
        }
      }}
      className="field-sizing-content w-full resize-none bg-transparent font-display text-[30px] leading-tight tracking-tight text-ink-strong outline-none placeholder:text-ink-tertiary"
    />
  )
}

function FolderPicker({ note }: { note: Note }) {
  const folders = useStore((s) => s.data!.folders)
  const { toggleNoteFolder, createFolder } = useStore.getState()
  const [name, setName] = useState('')
  return (
    <Popover
      align="right"
      trigger={({ toggle }) => (
        <Button variant="ghost" size="sm" onClick={toggle}>
          <FolderPlus size={14} /> {note.folderIds.length ? 'Folders' : 'Add to folder'}
        </Button>
      )}
    >
      {() => (
        <>
          <MenuLabel>Folders</MenuLabel>
          {folders.map((f) => (
            <MenuItem key={f.id} onClick={() => toggleNoteFolder(note.id, f.id)}>
              <Folder size={14} className="text-ink-tertiary" />
              <span className="flex-1">{f.name}</span>
              {note.folderIds.includes(f.id) && <Check size={14} className="text-ink-accent" />}
            </MenuItem>
          ))}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) {
                const f = createFolder(name.trim())
                toggleNoteFolder(note.id, f.id)
                setName('')
              }
            }}
            placeholder="New folder…"
            className="mt-1 h-8 w-full rounded-lg border border-hairline bg-fill-input px-2.5 text-[13px] outline-none"
          />
        </>
      )}
    </Popover>
  )
}

function AttendeesChip({ note }: { note: Note }) {
  const updateNote = useStore((s) => s.updateNote)
  const [name, setName] = useState('')
  return (
    <Popover
      trigger={({ toggle }) => (
        <Chip onClick={toggle}>
          {note.attendees.length ? (
            <>
              <span className="flex -space-x-1.5">
                {note.attendees.slice(0, 3).map((a) => (
                  <Avatar key={a.email ?? a.name} name={a.name} className="size-5 text-[9px]" />
                ))}
              </span>
              {note.attendees.length === 1 ? note.attendees[0].name : `${note.attendees.length} people`}
            </>
          ) : (
            <>
              <Users size={13} /> Add people
            </>
          )}
        </Chip>
      )}
    >
      {() => (
        <div className="w-64">
          <MenuLabel>Participants</MenuLabel>
          {note.attendees.map((a, i) => (
            <div key={i} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px]">
              <Avatar name={a.name} className="size-5 text-[9px]" />
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
              <IconButton
                label="Remove"
                size="sm"
                onClick={() => updateNote(note.id, { attendees: note.attendees.filter((_, j) => j !== i) })}
              >
                <X size={12} />
              </IconButton>
            </div>
          ))}
          <div className="mt-1 flex items-center gap-1.5 px-1">
            <UserPlus size={14} className="text-ink-tertiary" />
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim()) {
                  updateNote(note.id, { attendees: [...note.attendees, { name: name.trim() }] })
                  setName('')
                }
              }}
              placeholder="Name or email"
              className="h-8 flex-1 rounded-lg bg-transparent px-1.5 text-[13px] outline-none"
            />
          </div>
        </div>
      )}
    </Popover>
  )
}

function TemplateMenu({
  templates,
  label,
  onPick,
  icon,
  side = 'top',
  align = 'left'
}: {
  templates: Template[]
  label: string
  onPick: (t: Template) => void
  icon: ReactNode
  side?: 'top' | 'bottom'
  align?: 'left' | 'right'
}) {
  return (
    <Popover
      side={side}
      align={align}
      className="max-h-[60vh] overflow-y-auto"
      trigger={({ toggle }) => (
        <Button variant="ghost" size="sm" onClick={toggle}>
          {icon} {label}
        </Button>
      )}
    >
      {(close) => (
        <div className="w-64">
          <MenuLabel>Templates</MenuLabel>
          {templates.map((t) => (
            <MenuItem
              key={t.id}
              onClick={() => {
                close()
                onPick(t)
              }}
            >
              <span className="flex min-w-0 flex-col">
                <span>{t.title}</span>
                <span className="truncate text-[11px] text-ink-tertiary">{t.description}</span>
              </span>
            </MenuItem>
          ))}
        </div>
      )}
    </Popover>
  )
}

function EditedWarning({
  action,
  onConfirm,
  onKeepBoth,
  onCancel
}: {
  action: 'regenerate' | 'delete'
  onConfirm: () => void
  onKeepBoth?: () => void
  onCancel: () => void
}) {
  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/20"
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
    >
      <div className="w-[380px] rounded-2xl border border-hairline bg-surface-elevated p-5 shadow-xl">
        <div className="text-[15px] font-medium text-ink-strong">You’ve edited these notes</div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
          {action === 'regenerate'
            ? 'Regenerating replaces them, and your changes will be lost. Keep both to get the new version in its own tab.'
            : 'Deleting them also deletes your changes. This can’t be undone.'}
        </p>
        <div className="mt-4 flex justify-end gap-1.5">
          <Button variant="ghost" onClick={onCancel} autoFocus>
            Cancel
          </Button>
          {onKeepBoth && (
            <Button variant="outline" onClick={onKeepBoth}>
              Keep both
            </Button>
          )}
          <Button variant="danger" onClick={onConfirm}>
            {action === 'regenerate' ? 'Replace' : 'Delete'}
          </Button>
        </div>
      </div>
    </div>
  )
}

export function NoteView({ id }: { id: string }) {
  const note = useNote(id)
  const templates = useStore((s) => s.data!.templates)
  const isRecordingThis = useStore((s) => s.recording.noteId === id && s.recording.status === 'recording')
  const focusMode = useStore((s) => s.focusMode)
  const setFocusMode = useStore((s) => s.setFocusMode)
  const { updateNote, addPanel, updatePanel, removePanel, deleteNote, navigate, back } = useStore.getState()

  const [view, setView] = useState<string>(() => note?.panels.at(-1)?.id ?? 'mine')
  const [showTranscript, setShowTranscript] = useState(false)
  const [generating, setGenerating] = useState<{ panelId: string; text: string; abort: () => void } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [warning, setWarning] = useState<
    { kind: 'regenerate'; template: Template; panelId: string } | { kind: 'delete'; panelId: string } | null
  >(null)

  const onNotesChange = useCallback(
    (html: string) => updateNote(id, { notesHtml: html, notesMarkdown: htmlToMarkdown(html) }),
    [id, updateNote]
  )

  if (!note) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-ink-tertiary">
        <div className="drag absolute inset-x-0 top-0 h-[52px]" />
        This note was deleted.
        <Button onClick={() => navigate({ view: 'home' })}>Go home</Button>
      </div>
    )
  }

  const panel = note.panels.find((p) => p.id === view)
  const mine = !panel

  /** Generates notes into a new tab, or in place of the panel `replace` once they're done. */
  const generate = async (template: Template, replace?: string) => {
    if (generating) return
    if (isRecordingThis) stopTranscription()
    setError(null)
    const panelId = replace ?? uid()
    const current = useStore.getState().data!.notes.find((n) => n.id === id)!
    if (!replace)
      addPanel(id, { id: panelId, templateId: template.id, title: template.title, markdown: '', html: '', createdAt: new Date().toISOString() })
    setView(panelId)
    const stream = streamEnhance(
      {
        title: current.title,
        notesMarkdown: current.notesMarkdown,
        transcript: transcriptText(current),
        template,
        attendees: current.attendees,
        date: fullDate(current.createdAt),
        needsTitle: !current.title.trim()
      },
      { onDelta: (_d, full) => setGenerating((g) => (g ? { ...g, text: full } : g)) }
    )
    setGenerating({ panelId, text: '', abort: stream.abort })
    try {
      let md = (await stream.promise).trim()
      const titleMatch = /^#\s+(.+)\n/.exec(md)
      if (titleMatch) {
        if (!current.title.trim()) updateNote(id, { title: titleMatch[1].trim() })
        md = md.slice(titleMatch[0].length).trim()
      }
      if (!md) throw new Error('Nothing was generated.')
      updatePanel(id, panelId, {
        templateId: template.id,
        title: template.title,
        markdown: md,
        html: markAuthorship(markdownToHtml(md), current.notesMarkdown),
        edited: false
      })
    } catch (err) {
      // A replaced panel keeps its old text; only a new, empty tab goes away.
      if (!replace) {
        removePanel(id, panelId)
        setView('mine')
      }
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(null)
    }
  }

  // Regenerating from a generated tab replaces it, after asking if the user has edited it.
  const regenerate = (template: Template) => {
    if (panel?.edited) setWarning({ kind: 'regenerate', template, panelId: panel.id })
    else generate(template, panel?.id)
  }
  const deletePanel = (panelId: string) => {
    removePanel(note.id, panelId)
    setView('mine')
  }

  const currentMarkdown = () => {
    const body = panel ? htmlToMarkdown(panel.html) : note.notesMarkdown
    return `# ${noteTitle(note)}\n\n${body}`
  }
  const copy = async () => {
    await navigator.clipboard.writeText(currentMarkdown())
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const defaultTemplate = templates.find((t) => t.id === note.templateId) ?? templates[0]
  const canGenerate = note.transcript.length > 0 || note.notesMarkdown.trim().length > 0
  const showGenerate = canGenerate && note.panels.length === 0 && !generating && !isRecordingThis
  const streamingHtml =
    generating && generating.panelId === view
      ? markAuthorship(markdownToHtml(generating.text.replace(/^#\s+.+\n/, '')), note.notesMarkdown)
      : null

  return (
    <div className="relative flex h-full flex-col">
      <header
        className={`drag titlebar-pr flex h-[52px] shrink-0 items-center justify-between px-3 transition-opacity duration-300 ${focusMode ? `opacity-0 hover:opacity-100 focus-within:opacity-100 ${isMac ? 'pl-[84px]' : ''}` : ''}`}
      >
        <IconButton label="Back" onClick={back}>
          <ChevronLeft size={18} />
        </IconButton>
        <div className="flex items-center gap-1">
          <IconButton
            label={focusMode ? 'Exit focus mode (Esc)' : 'Focus mode'}
            onClick={() => setFocusMode(!focusMode)}
          >
            {focusMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </IconButton>
          <FolderPicker note={note} />
          <Button variant="ghost" size="sm" onClick={copy}>
            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
          </Button>
          <Popover
            align="right"
            trigger={({ toggle }) => (
              <IconButton label="More" onClick={toggle}>
                <MoreHorizontal size={16} />
              </IconButton>
            )}
          >
            {(close) => (
              <>
                <MenuItem
                  onClick={() => {
                    close()
                    window.oats.exportMarkdown(noteTitle(note), currentMarkdown())
                  }}
                >
                  <Download size={14} /> Export as Markdown
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    close()
                    navigator.clipboard.writeText(transcriptText(note))
                  }}
                >
                  <FileText size={14} /> Copy transcript
                </MenuItem>
                <MenuItem
                  danger
                  onClick={() => {
                    close()
                    if (confirm(`Delete “${noteTitle(note)}”? This can’t be undone.`)) {
                      if (isRecordingThis) stopTranscription()
                      deleteNote(note.id)
                      navigate({ view: 'home' })
                    }
                  }}
                >
                  <Trash2 size={14} /> Delete note
                </MenuItem>
              </>
            )}
          </Popover>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-6 pt-4">
          <TitleInput note={note} />
          <div className="mt-3 mb-6 flex flex-wrap items-center gap-1.5">
            <Chip>
              <CalendarDays size={13} /> {dayLabel(note.createdAt)} · {timeLabel(note.createdAt)}
            </Chip>
            <AttendeesChip note={note} />
            {note.folderIds.map((fid) => {
              const f = useStore.getState().data!.folders.find((x) => x.id === fid)
              return f ? (
                <Chip key={fid} onClick={() => navigate({ view: 'folder', id: fid })}>
                  <Folder size={13} /> {f.name}
                </Chip>
              ) : null
            })}
          </div>

          {(note.panels.length > 0 || generating) && (
            <div className="mb-5 flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-xl bg-fill-soft p-0.5">
                <button
                  type="button"
                  onClick={() => setView('mine')}
                  className={`h-7 shrink-0 cursor-default rounded-[10px] px-3 text-[13px] ${mine ? 'bg-surface-elevated font-medium text-ink-strong shadow-sm' : 'text-ink-secondary hover:text-ink-primary'}`}
                >
                  My notes
                </button>
                {note.panels.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setView(p.id)}
                    className={`group flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-[10px] px-3 text-[13px] ${view === p.id ? 'bg-surface-elevated font-medium text-ink-strong shadow-sm' : 'text-ink-secondary hover:text-ink-primary'}`}
                  >
                    <Sparkles size={12} className="text-ink-accent" /> {p.title}
                    {view === p.id && !generating && (
                      <span
                        role="button"
                        aria-label="Delete generated notes"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (p.edited) setWarning({ kind: 'delete', panelId: p.id })
                          else deletePanel(p.id)
                        }}
                        className="-mr-1 rounded p-0.5 text-ink-tertiary opacity-0 group-hover:opacity-100 hover:bg-fill-soft"
                      >
                        <X size={11} />
                      </span>
                    )}
                  </button>
                ))}
              </div>
              {!generating && (
                <TemplateMenu
                  templates={templates}
                  label="Regenerate"
                  icon={<RefreshCw size={13} />}
                  onPick={regenerate}
                  side="bottom"
                  align="right"
                />
              )}
            </div>
          )}

          {error && (
            <div className="mb-4 rounded-xl border border-hairline bg-fill-soft px-3.5 py-2.5 text-[13px] text-ink-danger">
              {error}
            </div>
          )}

          {mine && (
            <NoteEditor
              key="mine"
              html={note.notesHtml}
              placeholder="Write notes…"
              onChange={onNotesChange}
              autofocus={!note.notesHtml && !note.title}
              noteId={note.id}
            />
          )}
          {panel && streamingHtml !== null && (
            <div>
              <div className="shimmer-text mb-3 text-[13px] font-medium">Generating notes…</div>
              <div className="prose-oats pb-40" dangerouslySetInnerHTML={{ __html: streamingHtml }} />
            </div>
          )}
          {panel && streamingHtml === null && (
            <NoteEditor
              key={panel.id}
              html={panel.html}
              placeholder="Generated notes"
              onChange={(html) => updatePanel(note.id, panel.id, { html, edited: true })}
              noteId={note.id}
            />
          )}
        </div>
      </div>

      {showTranscript && <TranscriptDrawer note={note} onClose={() => setShowTranscript(false)} />}

      {warning && (
        <EditedWarning
          action={warning.kind}
          onCancel={() => setWarning(null)}
          onConfirm={() => {
            setWarning(null)
            if (warning.kind === 'regenerate') generate(warning.template, warning.panelId)
            else deletePanel(warning.panelId)
          }}
          onKeepBoth={
            warning.kind === 'regenerate'
              ? () => {
                  setWarning(null)
                  generate(warning.template)
                }
              : undefined
          }
        />
      )}

      <ChatDock
        scope="note"
        noteId={note.id}
        leading={<TranscribePill note={note} onToggleTranscript={() => setShowTranscript((v) => !v)} />}
        above={
          showGenerate && (
            <div className="flex items-center gap-1 rounded-full border border-hairline bg-surface-elevated p-1 shadow-lg">
              <Button variant="accent" size="lg" onClick={() => generate(defaultTemplate)}>
                <Sparkles size={16} />
                {note.notesMarkdown.length > 20 ? 'Enhance notes' : 'Generate notes'}
              </Button>
              <TemplateMenu templates={templates} label="Template" icon={null} onPick={generate} />
            </div>
          )
        }
      />
    </div>
  )
}
