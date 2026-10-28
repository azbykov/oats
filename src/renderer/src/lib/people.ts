import type { Attendee, Note } from '../../../shared/types'
import { useStore } from './store'

// Everyone the user has met, gathered from meeting attendees: who can be @-mentioned in notes
// and what the card on a mention shows.

export interface Person {
  /** Lower-case email, or the lower-case name for people added without one. */
  id: string
  name: string
  email?: string
  /** Their meetings with the user, newest first. */
  notes: Note[]
}

export const personId = (a: Attendee) => (a.email?.trim() || a.name.trim()).toLowerCase()

function directory(notes: Note[]) {
  const people = new Map<string, Person>()
  const sorted = [...notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  for (const note of sorted) {
    for (const a of note.attendees) {
      if (!a.name.trim() && !a.email?.trim()) continue
      const id = personId(a)
      const p = people.get(id)
      if (p) {
        if (!p.notes.includes(note)) p.notes.push(note)
        // Calendar invites often carry only the email; keep a real name once one turns up.
        if (p.name.includes('@') && a.name.trim() && !a.name.includes('@')) p.name = a.name.trim()
      } else {
        people.set(id, { id, name: a.name.trim() || a.email!.trim(), email: a.email?.trim() || undefined, notes: [note] })
      }
    }
  }
  return people
}

/** People matching a query: this note's attendees first, then those met most often. */
export function suggestPeople(query: string, noteId?: string, limit = 8): Person[] {
  const notes = useStore.getState().data?.notes ?? []
  const here = new Set(notes.find((n) => n.id === noteId)?.attendees.map(personId))
  const q = query.trim().toLowerCase()
  return [...directory(notes).values()]
    .filter((p) => !q || p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || p.name.toLowerCase().startsWith(q) || p.email?.toLowerCase().startsWith(q))
    .sort((a, b) => Number(here.has(b.id)) - Number(here.has(a.id)) || b.notes.length - a.notes.length)
    .slice(0, limit)
}

export function findPerson(id: string): Person | undefined {
  return directory(useStore.getState().data?.notes ?? []).get(id)
}
