import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

// app.requestSingleInstanceLock() on macOS relies on a socket in the temp folder.
// When that socket is gone, the next copy (npm run dev next to a built app, or a
// second build) gets the lock too, and both write oats-data.json over each other.
// The running copy also records itself here; a copy that finds another one alive
// with this data folder stops. Windows' lock is a named pipe and doesn't need this.

const file = () => join(app.getPath('userData'), 'oats.pid')

interface Owner {
  pid: number
  exe: string
}

/** The executable of a live process as it was started (possibly a relative path), or null. */
function executable(pid: number) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim() || null
  } catch {
    return null // not running
  }
}

function owner(): Owner | null {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as Owner
  } catch {
    return null
  }
}

/** The app path of another running copy that uses this data folder. */
export function otherInstance(): string | null {
  if (process.platform !== 'darwin') return null
  const o = owner()
  if (!o || o.pid === process.pid) return null
  // Still running if that pid is the same program; a reused pid belongs to another one.
  const running = executable(o.pid)
  if (!running || basename(running) !== basename(o.exe)) return null
  return o.exe.replace(/\/Contents\/MacOS\/[^/]+$/, '')
}

export function claimInstance() {
  if (process.platform !== 'darwin') return
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file(), JSON.stringify({ pid: process.pid, exe: process.execPath } satisfies Owner))
  app.on('will-quit', () => {
    if (owner()?.pid === process.pid) rmSync(file(), { force: true })
  })
}
