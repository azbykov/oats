import { useEffect } from 'react'
import { FolderView } from './components/FolderView'
import { MeetingBanner, useAutoStop, useMeetingDetection } from './components/MeetingBanner'
import { Home } from './components/Home'
import { NoteView } from './components/NoteView'
import { SearchDialog } from './components/SearchDialog'
import { SettingsView } from './components/SettingsView'
import { Sidebar } from './components/Sidebar'
import { TemplatesView } from './components/TemplatesView'
import { recoverLeftovers } from './lib/postprocess'
import { useStore } from './lib/store'

function useTheme() {
  const theme = useStore((s) => s.data?.settings.theme ?? 'system')
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () =>
      document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && media.matches))
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
}

function useAccounts() {
  useEffect(() => window.oats.onAccountsChanged(useStore.getState().setAccounts), [])
}

function useCalendar() {
  const icsUrl = useStore((s) => s.data?.settings.icsUrl)
  // Refetch when an account or calendar is switched on or off, not on every account change.
  const sources = useStore((s) =>
    s.accounts.map((a) => `${a.id}:${a.calendars.filter((c) => c.enabled).map((c) => c.id)}`).join('|')
  )
  const setEvents = useStore((s) => s.setEvents)
  useEffect(() => {
    if (!icsUrl && !sources) {
      setEvents([])
      return
    }
    const refresh = () =>
      window.oats
        .getCalendarEvents()
        .then(({ events, errors }) => setEvents(events, errors))
        .catch((err: Error) => setEvents([], [err.message]))
    refresh()
    const timer = window.setInterval(refresh, 5 * 60_000)
    return () => window.clearInterval(timer)
  }, [icsUrl, sources, setEvents])
}

function useMenuShortcuts() {
  useEffect(() => {
    const { createNote, navigate, setSearchOpen } = useStore.getState()
    const offs = [
      window.oats.onMenu('new-note', () => navigate({ view: 'note', id: createNote().id })),
      window.oats.onMenu('search', () => setSearchOpen(true)),
      window.oats.onMenu('settings', () => navigate({ view: 'settings' }))
    ]
    return () => offs.forEach((off) => off())
  }, [])
}

export default function App() {
  const loaded = useStore((s) => !!s.data)
  const route = useStore((s) => s.route)
  const load = useStore((s) => s.load)

  useEffect(() => {
    // Recordings left by a crash or quit mid-call are re-transcribed once data is loaded.
    load().then(() => recoverLeftovers())
  }, [load])
  useTheme()
  useAccounts()
  useCalendar()
  useMenuShortcuts()
  useMeetingDetection()
  useAutoStop()

  if (!loaded) return <div className="drag h-full" />

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="relative my-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-hairline bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <MeetingBanner />
        {route.view === 'home' && <Home />}
        {route.view === 'note' && <NoteView key={route.id} id={route.id} />}
        {route.view === 'folder' && <FolderView key={route.id} id={route.id} />}
        {route.view === 'templates' && <TemplatesView />}
        {route.view === 'settings' && <SettingsView key={route.tab} initialTab={route.tab} />}
      </main>
      <SearchDialog />
    </div>
  )
}
