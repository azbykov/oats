import { Folder, FolderPlus, Home as HomeIcon, LayoutTemplate, Search, Settings, SquarePen, UserRound } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { isMac, shortcut } from '../lib/platform'
import { useStore } from '../lib/store'
import { Avatar, DancingBars, IconButton, Kbd } from './ui'

function NavItem({
  icon,
  label,
  active,
  onClick,
  trailing
}: {
  icon: ReactNode
  label: string
  active?: boolean
  onClick: () => void
  trailing?: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex h-8 w-full cursor-default items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors ${active ? 'bg-fill-soft-hover font-medium text-ink-strong' : 'text-ink-secondary hover:bg-fill-soft hover:text-ink-primary'}`}
    >
      <span className="flex size-4 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  )
}

export function Sidebar() {
  const route = useStore((s) => s.route)
  const folders = useStore((s) => s.data!.folders)
  const notes = useStore((s) => s.data!.notes)
  const recording = useStore((s) => s.recording)
  const level = useStore((s) => s.level)
  const account = useStore((s) => s.accounts[0])
  const accountCount = useStore((s) => s.accounts.length)
  const { navigate, createNote, createFolder, setSearchOpen } = useStore.getState()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')

  const recordingNote = recording.status === 'recording' ? notes.find((n) => n.id === recording.noteId) : null

  const submitFolder = () => {
    if (name.trim()) {
      const f = createFolder(name.trim())
      navigate({ view: 'folder', id: f.id })
    }
    setName('')
    setAdding(false)
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col">
      <div className={`drag flex h-[52px] items-center justify-end px-3 ${isMac ? 'pl-20' : ''}`}>
        <IconButton label="New note" onClick={() => navigate({ view: 'note', id: createNote().id })}>
          <SquarePen size={16} />
        </IconButton>
      </div>

      <div className="px-2">
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="mb-2 flex h-8 w-full cursor-default items-center gap-2 rounded-lg border border-hairline bg-surface-elevated px-2.5 text-[13px] text-ink-tertiary hover:text-ink-secondary"
        >
          <Search size={14} />
          <span className="flex-1 text-left">Search</span>
          <Kbd>{shortcut('K')}</Kbd>
        </button>

        <NavItem
          icon={<HomeIcon size={15} />}
          label="Home"
          active={route.view === 'home'}
          onClick={() => navigate({ view: 'home' })}
        />
        <NavItem
          icon={<LayoutTemplate size={15} />}
          label="Templates"
          active={route.view === 'templates'}
          onClick={() => navigate({ view: 'templates' })}
        />
      </div>

      <div className="mt-5 flex items-center justify-between px-4 pb-1">
        <span className="text-[11px] font-medium tracking-wide text-ink-tertiary uppercase">Folders</span>
        <IconButton label="New folder" size="sm" onClick={() => setAdding(true)}>
          <FolderPlus size={14} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {folders.map((f) => (
          <NavItem
            key={f.id}
            icon={<Folder size={15} />}
            label={f.name}
            active={route.view === 'folder' && route.id === f.id}
            onClick={() => navigate({ view: 'folder', id: f.id })}
            trailing={
              <span className="text-[11px] text-ink-tertiary">
                {notes.filter((n) => n.folderIds.includes(f.id)).length || ''}
              </span>
            }
          />
        ))}
        {adding && (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={submitFolder}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitFolder()
              if (e.key === 'Escape') {
                setName('')
                setAdding(false)
              }
            }}
            placeholder="Folder name"
            className="mt-0.5 h-8 w-full rounded-lg border border-hairline bg-fill-input px-2.5 text-[13px] outline-none focus:border-ink-accent"
          />
        )}
        {!folders.length && !adding && (
          <p className="px-2.5 py-1 text-[12px] leading-snug text-ink-tertiary">
            Group notes by project, client or team.
          </p>
        )}
      </div>

      {recordingNote && (
        <button
          type="button"
          onClick={() => navigate({ view: 'note', id: recordingNote.id })}
          className="mx-2 mb-2 flex h-10 cursor-default items-center gap-2.5 rounded-xl border border-hairline bg-surface-elevated px-3 text-left text-[13px] shadow-sm"
        >
          <DancingBars active level={level} />
          <span className="min-w-0 flex-1 truncate text-ink-primary">{recordingNote.title || 'New note'}</span>
        </button>
      )}

      <div className="px-2 pb-3">
        <NavItem
          icon={account ? <Avatar name={account.name} src={account.avatarUrl} className="size-5! ring-0!" /> : <UserRound size={15} />}
          label={account ? account.name : 'Connect account'}
          active={route.view === 'settings' && route.tab === 'accounts'}
          onClick={() => navigate({ view: 'settings', tab: 'accounts' })}
          trailing={
            accountCount > 1 ? <span className="text-[11px] text-ink-tertiary">+{accountCount - 1}</span> : undefined
          }
        />
        <NavItem
          icon={<Settings size={15} />}
          label="Settings"
          active={route.view === 'settings' && route.tab !== 'accounts'}
          onClick={() => navigate({ view: 'settings' })}
        />
      </div>
    </aside>
  )
}
