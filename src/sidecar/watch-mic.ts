import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CLIError, emit } from './common'

// Reports which apps are currently recording from the microphone, so Oats can
// notice a Zoom/Teams/Meet call starting — the Windows twin of the Swift
// `watch-mic` (Core Audio process objects).
//
//   oats-audio watch-mic
//     stdout — JSON line {type: "mic", apps: [{bundleId, pid}]} on every change
//
// Windows keeps per-app microphone usage under CapabilityAccessManager: while an
// app records, its LastUsedTimeStop is 0. Desktop apps are listed under
// NonPackaged by path ("C:#Program Files#Zoom#bin#Zoom.exe"), Store apps by
// package family name. bundleId is the lower-cased exe name or package family;
// the main process maps it to the same app ids as on macOS. pid is unknown (0).

const run = promisify(execFile)
const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone'
const POLL_MS = 1500

function appId(key: string) {
  const rel = key.slice(KEY.length + 1)
  if (!rel) return null
  const parts = rel.split('\\')
  const name = parts[0] === 'NonPackaged' ? parts[1]?.split('#').pop() : parts[0]
  return name ? name.toLowerCase() : null
}

/** Apps whose microphone session is open right now. */
async function micUsers(): Promise<string[]> {
  const { stdout } = await run('reg', ['query', KEY, '/s'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  return parseMicUsers(stdout)
}

/** Reads `reg query <KEY> /s` output: an app is recording while its start is set and its stop is 0. */
export function parseMicUsers(stdout: string): string[] {
  const users = new Set<string>()
  let id: string | null = null
  let start = 0n
  let stop = 0n
  const commit = () => {
    if (id && start !== 0n && stop === 0n) users.add(id)
  }
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('HKEY_')) {
      commit()
      id = appId(line.trim().replace(/^HKEY_CURRENT_USER/, 'HKCU'))
      start = 0n
      stop = 0n
      continue
    }
    const m = /^\s+(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+(0x[0-9a-f]+)/i.exec(line)
    if (!m) continue
    if (m[1] === 'LastUsedTimeStart') start = BigInt(m[2])
    else stop = BigInt(m[2])
  }
  commit()
  return [...users].sort()
}

export async function runWatchMic() {
  if (process.platform !== 'win32') throw new CLIError('watch-mic is only available on Windows in this helper')
  let last: string | null = null
  for (;;) {
    // The key doesn't exist until some app has used the microphone; report "nobody"
    // once, and otherwise skip a failed poll rather than end active meetings.
    const users = await micUsers().catch(() => (last === null ? [] : null))
    const key = users?.join('|') ?? null
    if (users && key !== last) {
      last = key
      emit({ type: 'mic', apps: users.map((bundleId) => ({ bundleId, pid: 0 })) })
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}
