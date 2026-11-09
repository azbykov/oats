import { BrowserWindow } from 'electron'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { MeetingApp, MicInput } from '../shared/types'
import { spawnAudio } from './sidecar'

// Meeting detection: `oats-audio watch-mic` reports which apps are recording from
// the microphone (Core Audio process objects on macOS 14.2+, the privacy usage
// records on Windows). When a known call app starts, Oats offers to take notes
// (the floating card in pill.ts), the way Notion's MicrophoneUsageMonitor does.
//
// The same watcher tells which input device the call records from (macOS only),
// so a session can open that microphone rather than the system default
// ("Same as the call" in Settings → Transcription).

const CALL_APPS: Record<string, string> = {
  'us.zoom.xos': 'Zoom',
  'com.microsoft.teams2': 'Microsoft Teams',
  'com.microsoft.teams': 'Microsoft Teams',
  'com.apple.FaceTime': 'FaceTime',
  'com.tinyspeck.slackmacgap': 'Slack',
  'com.hnc.Discord': 'Discord',
  'com.cisco.webexmeetingsapp': 'Webex',
  'Cisco-Systems.Spark': 'Webex',
  'com.skype.skype': 'Skype',
  'ru.yandex.telemost': 'Yandex Telemost',
  'ru.vk.calls': 'VK Calls'
}

// A browser using the mic is most often a Google Meet / Teams / Zoom web call.
const BROWSERS: Record<string, string> = {
  'com.google.Chrome': 'Chrome',
  'company.thebrowser.Browser': 'Arc',
  'com.apple.Safari': 'Safari',
  'com.microsoft.edgemac': 'Edge',
  'org.mozilla.firefox': 'Firefox',
  'com.brave.Browser': 'Brave',
  'ru.yandex.desktop.yandex-browser': 'Yandex Browser'
}

// Windows reports exe names (or Store package families); they map onto the macOS
// ids so names, browser detection and ignored apps work the same on both.
const WINDOWS_APPS: Record<string, string> = {
  'zoom.exe': 'us.zoom.xos',
  'ms-teams.exe': 'com.microsoft.teams2',
  'msteams_8wekyb3d8bbwe': 'com.microsoft.teams2',
  'teams.exe': 'com.microsoft.teams',
  'slack.exe': 'com.tinyspeck.slackmacgap',
  'discord.exe': 'com.hnc.Discord',
  'webex.exe': 'com.cisco.webexmeetingsapp',
  'ciscocollabhost.exe': 'com.cisco.webexmeetingsapp',
  'skype.exe': 'com.skype.skype',
  'yandextelemost.exe': 'ru.yandex.telemost',
  'chrome.exe': 'com.google.Chrome',
  'arc.exe': 'company.thebrowser.Browser',
  'msedge.exe': 'com.microsoft.edgemac',
  'firefox.exe': 'org.mozilla.firefox',
  'brave.exe': 'com.brave.Browser',
  'browser.exe': 'ru.yandex.desktop.yandex-browser'
}

function describe(reported: string): MeetingApp | null {
  const bundleId = WINDOWS_APPS[reported.toLowerCase()] ?? reported
  // Helper processes (e.g. "com.google.Chrome.helper") report their own bundle ids.
  const base = Object.keys({ ...CALL_APPS, ...BROWSERS }).find((id) => bundleId === id || bundleId.startsWith(`${id}.`))
  if (!base) return null
  return { bundleId: base, name: CALL_APPS[base] ?? BROWSERS[base], browser: base in BROWSERS }
}

let proc: ChildProcessWithoutNullStreams | null = null
/** Offer notes when a call starts (Settings → Detect meetings). */
let detecting = false
/** A recording wants to know which microphone the call uses. */
let following = false
let handlers: MeetingHandlers | null = null
let active = new Map<string, MeetingApp>()
let callInputs: MicInput[] = []
/** Resolves on the watcher's first report, so a fresh start can be waited for. */
let firstReport: Promise<void> | null = null
let reported: (() => void) | null = null
let restartTimer: NodeJS.Timeout | null = null

function broadcast(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
}

export interface MeetingHandlers {
  isIgnored: (bundleId: string) => boolean
  onDetected: (app: MeetingApp) => void
  onEnded: (app: MeetingApp) => void
}

interface ReportedApp {
  bundleId: string
  inputs?: MicInput[]
}

/** Input devices of the call apps, dedicated apps before browsers. */
function inputsOf(apps: ReportedApp[]): MicInput[] {
  const calls = apps
    .map((a) => ({ app: describe(a.bundleId), inputs: a.inputs ?? [] }))
    .filter((a): a is { app: MeetingApp; inputs: MicInput[] } => a.app !== null)
    .sort((a, b) => Number(a.app.browser) - Number(b.app.browser) || a.app.bundleId.localeCompare(b.app.bundleId))
  const seen = new Set<string>()
  return calls.flatMap((c) => c.inputs).filter((i) => !seen.has(i.uid) && !!seen.add(i.uid))
}

function update(apps: ReportedApp[]) {
  const inputs = inputsOf(apps)
  if (JSON.stringify(inputs) !== JSON.stringify(callInputs)) {
    callInputs = inputs
    broadcast('mic:call-inputs', inputs)
  }
  if (!detecting || !handlers) return
  const now = new Map<string, MeetingApp>()
  for (const { bundleId } of apps) {
    const app = describe(bundleId)
    if (app && !handlers.isIgnored(app.bundleId)) now.set(app.bundleId, app)
  }
  for (const [id, app] of now) {
    if (active.has(id)) continue
    broadcast('meeting:detected', app)
    handlers.onDetected(app)
  }
  for (const [id, app] of active) {
    if (now.has(id)) continue
    broadcast('meeting:ended', app)
    handlers.onEnded(app)
  }
  active = now
}

/** Runs `watch-mic` while meeting detection or a recording needs it. */
function syncWatcher() {
  if (!detecting && !following) {
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = null
    const child = proc
    proc = null
    firstReport = null
    reported?.()
    callInputs = []
    child?.kill()
    return
  }
  if (proc || restartTimer) return
  const child = spawnAudio(['watch-mic'])
  if (!child) return
  proc = child
  firstReport = new Promise((resolve) => (reported = resolve))
  let buf = ''
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8')
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line.startsWith('{')) continue
      try {
        const e = JSON.parse(line) as { type: string; apps: ReportedApp[] }
        if (e.type === 'mic') {
          update(e.apps)
          reported?.()
        }
      } catch {
        // ignore malformed lines
      }
    }
  })
  child.on('exit', () => {
    if (proc !== child) return
    proc = null
    reported?.()
    // An unsupported OS version exits immediately; otherwise restart after a crash.
    restartTimer = setTimeout(() => {
      restartTimer = null
      syncWatcher()
    }, 30_000)
  })
}

export function setMeetingDetection(on: boolean, meetingHandlers: MeetingHandlers) {
  detecting = on
  handlers = meetingHandlers
  if (!on) active.clear()
  syncWatcher()
}

/** A recording starts (true) or stops (false) following the call's microphone. */
export function followCallMic(on: boolean) {
  following = on
  syncWatcher()
}

/** The input devices the current call records from; empty when unknown. */
export async function callMicInputs(): Promise<MicInput[]> {
  if (firstReport) await Promise.race([firstReport, new Promise((r) => setTimeout(r, 2000))])
  return callInputs
}

export const activeMeetingApps = () => [...active.values()]
