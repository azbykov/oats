import { ChevronLeft, Folder, MoreHorizontal, Plus, Trash2 } from 'lucide-react'
import { useStore } from '../lib/store'
import { ChatDock } from './ChatPanel'
import { NoteList } from './NoteList'
import { Button, IconButton, MenuItem, Popover } from './ui'

export function FolderView({ id }: { id: string }) {
  const folder = useStore((s) => s.data!.folders.find((f) => f.id === id))
  const notes = useStore((s) => s.data!.notes)
  const { renameFolder, deleteFolder, navigate, back, createNote } = useStore.getState()

  if (!folder) return null
  const inFolder = notes
    .filter((n) => n.folderIds.includes(id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  return (
    <div className="relative flex h-full flex-col">
      <header className="drag titlebar-pr flex h-[52px] shrink-0 items-center justify-between px-3">
        <IconButton label="Back" onClick={back}>
          <ChevronLeft size={18} />
        </IconButton>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate({ view: 'note', id: createNote({ folderIds: [id] }).id })}
          >
            <Plus size={14} /> New note
          </Button>
          <Popover
            align="right"
            trigger={({ toggle }) => (
              <IconButton label="Folder options" onClick={toggle}>
                <MoreHorizontal size={16} />
              </IconButton>
            )}
          >
            {(close) => (
              <MenuItem
                danger
                onClick={() => {
                  close()
                  if (confirm(`Delete folder “${folder.name}”? Notes inside are kept.`)) {
                    deleteFolder(id)
                    navigate({ view: 'home' })
                  }
                }}
              >
                <Trash2 size={14} /> Delete folder
              </MenuItem>
            )}
          </Popover>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto pb-32">
        <div className="mx-auto w-full max-w-2xl px-6 pt-4">
          <div className="mb-6 flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-fill-soft text-ink-secondary">
              <Folder size={18} />
            </span>
            <input
              value={folder.name}
              onChange={(e) => renameFolder(id, e.target.value)}
              className="min-w-0 flex-1 bg-transparent font-display text-[28px] tracking-tight text-ink-strong outline-none"
            />
          </div>
          <NoteList notes={inFolder} empty="No notes in this folder yet. Add one from a note’s “Add to folder” menu." />
        </div>
      </div>
      <ChatDock scope="all" />
    </div>
  )
}
