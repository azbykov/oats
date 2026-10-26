import { FileText, Trash2 } from 'lucide-react'
import type { Note } from '../../../shared/types'
import { groupByDay, noteTitle, timeLabel } from '../lib/format'
import { useStore } from '../lib/store'
import { stopTranscription } from '../lib/transcription'
import { Avatar, DancingBars, IconButton } from './ui'

/** Nothing typed, transcribed or generated: deleting it loses nothing, so no confirmation. */
const isEmpty = (n: Note) => !n.title.trim() && !n.notesMarkdown.trim() && !n.transcript.length && !n.panels.length

function deleteNote(note: Note) {
  if (!isEmpty(note) && !confirm(`Delete “${noteTitle(note)}”? This can’t be undone.`)) return
  const { recording, deleteNote } = useStore.getState()
  if (recording.noteId === note.id && (recording.status === 'recording' || recording.status === 'starting')) {
    stopTranscription()
  }
  deleteNote(note.id)
}

export function NoteRow({ note }: { note: Note }) {
  const folders = useStore((s) => s.data!.folders)
  const recording = useStore(
    (s) => (s.recording.status === 'recording' || s.recording.status === 'starting') && s.recording.noteId === note.id
  )
  const navigate = useStore((s) => s.navigate)
  const noteFolders = folders.filter((f) => note.folderIds.includes(f.id))

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => navigate({ view: 'note', id: note.id })}
        className="flex w-full cursor-default items-center gap-3 rounded-xl px-3 py-2.5 text-left group-hover:bg-fill-soft"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-fill-soft text-ink-tertiary">
          {recording ? <DancingBars active /> : <FileText size={15} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[14px] ${note.title ? 'text-ink-primary' : 'text-ink-tertiary'}`}>
            {noteTitle(note)}
          </span>
          <span className="flex items-center gap-1.5 truncate text-[12px] text-ink-tertiary">
            {note.attendees.length > 0 && (
              <span className="truncate">
                {note.attendees
                  .slice(0, 3)
                  .map((a) => a.name)
                  .join(', ')}
                {note.attendees.length > 3 && ` +${note.attendees.length - 3}`}
              </span>
            )}
            {note.attendees.length === 0 && <span>{note.panels.length ? 'Enhanced notes' : 'Me'}</span>}
            {noteFolders.map((f) => (
              <span key={f.id} className="rounded bg-fill-soft px-1.5 py-px text-[11px] text-ink-secondary">
                {f.name}
              </span>
            ))}
          </span>
        </span>
        {note.attendees.length > 0 && (
          <span className="hidden -space-x-1.5 @md:flex">
            {note.attendees.slice(0, 3).map((a) => (
              <Avatar key={a.email ?? a.name} name={a.name} />
            ))}
          </span>
        )}
        {/* The delete button takes the time's place on hover. */}
        <span className="shrink-0 text-[12px] text-ink-tertiary tabular-nums group-hover:invisible">
          {timeLabel(note.createdAt)}
        </span>
      </button>
      <IconButton
        label="Delete note"
        className="absolute top-1/2 right-2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-ink-danger"
        onClick={() => deleteNote(note)}
      >
        <Trash2 size={14} />
      </IconButton>
    </div>
  )
}

export function NoteList({ notes, empty }: { notes: Note[]; empty?: string }) {
  if (!notes.length)
    return <p className="px-3 py-8 text-center text-[13px] text-ink-tertiary">{empty ?? 'No notes yet.'}</p>
  return (
    <div className="@container flex flex-col gap-4">
      {groupByDay(notes).map((g) => (
        <section key={g.label}>
          <h3 className="sticky top-0 z-10 bg-surface px-3 pt-1 pb-1.5 text-[12px] font-medium text-ink-tertiary">
            {g.label}
          </h3>
          {g.notes.map((n) => (
            <NoteRow key={n.id} note={n} />
          ))}
        </section>
      ))}
    </div>
  )
}
