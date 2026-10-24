import { app, desktopCapturer, shell, systemPreferences } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { PermissionKind, PermissionState, Permissions } from '../shared/types'

// Microphone and system-audio permissions: check the current state and, on
// "Allow", show the macOS prompt if it was never asked, or open the right pane of
// System Settings when it was denied (macOS never re-prompts after a denial).
// Windows has no prompt: microphone access is a privacy switch in Settings, and
// system audio (loopback) needs no permission at all.
//
// System audio (Core Audio Tap) needs the "Audio Capture" permission, which has no
// Electron API and is only prompted for when requested from the app process
// itself, so native/tcc is a small N-API addon calling TCC in-process.

interface TccAddon {
  preflight(service: string): string
  request(service: string): Promise<boolean>
}

const AUDIO_CAPTURE = 'kTCCServiceAudioCapture'
let addon: TccAddon | null | undefined

function tcc(): TccAddon | null {
  if (addon !== undefined) return addon
  const candidates = [
    app.isPackaged ? join(process.resourcesPath, 'oats_tcc.node') : undefined,
    join(app.getAppPath(), 'native', 'tcc', 'build', 'Release', 'oats_tcc.node')
  ]
  const path = candidates.find((p) => p && existsSync(p))
  try {
    addon = path ? (require(path) as TccAddon) : null
  } catch (err) {
    console.error('Failed to load TCC addon', err)
    addon = null
  }
  return addon
}

const PANES: Record<PermissionKind, string> = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  // "System Audio Recording Only" lives in the Screen & System Audio Recording pane.
  systemAudio: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
}

const WINDOWS_PANES: Record<PermissionKind, string> = {
  microphone: 'ms-settings:privacy-microphone',
  systemAudio: 'ms-settings:sound'
}

const normalize = (s: string): PermissionState =>
  s === 'granted' || s === 'denied' || s === 'not-determined' ? s : s === 'restricted' ? 'denied' : 'unknown'

async function systemAudioStatus(coreAudioTap: boolean): Promise<PermissionState> {
  if (process.platform !== 'darwin') return 'granted'
  if (!coreAudioTap) return normalize(systemPreferences.getMediaAccessStatus('screen'))
  return normalize(tcc()?.preflight(AUDIO_CAPTURE) ?? 'unknown')
}

export async function permissionStatus(coreAudioTap: boolean): Promise<Permissions> {
  const status = (): PermissionState => {
    if (process.platform === 'darwin') return normalize(systemPreferences.getMediaAccessStatus('microphone'))
    // Windows only knows on/off; anything but an explicit "off" lets getUserMedia try.
    if (process.platform === 'win32') return systemPreferences.getMediaAccessStatus('microphone') === 'denied' ? 'denied' : 'granted'
    return 'granted'
  }
  const microphone = status()
  return { microphone, systemAudio: await systemAudioStatus(coreAudioTap) }
}

export function openPermissionSettings(kind: PermissionKind) {
  if (process.platform === 'darwin') shell.openExternal(PANES[kind])
  else if (process.platform === 'win32') shell.openExternal(WINDOWS_PANES[kind])
}

/** Shows the system prompt when possible, otherwise opens System Settings. Returns the new state. */
export async function requestPermission(kind: PermissionKind, coreAudioTap: boolean): Promise<PermissionState> {
  const before = (await permissionStatus(coreAudioTap))[kind]
  if (before === 'granted') return before
  if (before === 'not-determined' && process.platform === 'darwin') {
    if (kind === 'microphone') {
      await systemPreferences.askForMediaAccess('microphone')
    } else if (coreAudioTap) {
      await tcc()?.request(AUDIO_CAPTURE)
    } else {
      // Asking for screen sources makes macOS register the app and show its prompt.
      await desktopCapturer.getSources({ types: ['screen'] }).catch(() => {})
    }
    const after = (await permissionStatus(coreAudioTap))[kind]
    if (after === 'granted') return after
  }
  openPermissionSettings(kind)
  return (await permissionStatus(coreAudioTap))[kind]
}
