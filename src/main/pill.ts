import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'node:path'
import type { MeetingApp, PillAction, PillState } from '../shared/types'

// "Meeting detected — Take notes" card that floats over every app, like Notion's
// meeting_notification_pill: a small
// transparent, non-activating panel in the top-right corner of the screen the
// pointer is on. Transparent parts let clicks through to the windows below.

const WIDTH = 440
const HEIGHT = 460 // room for the template menu under the card

let pill: BrowserWindow | null = null
let state: PillState | null = null

interface Deps {
  getState: (app: MeetingApp) => PillState
  onAction: (app: MeetingApp, action: PillAction) => void
}

let deps: Deps | null = null

export function initMeetingPill(d: Deps) {
  deps = d
  ipcMain.handle('pill:get', () => state)
  ipcMain.on('pill:action', (_e, action: PillAction) => {
    const app = state?.app
    closeMeetingPill()
    if (app) deps?.onAction(app, action)
  })
  ipcMain.on('pill:ignore-mouse', (_e, ignore: boolean) => {
    pill?.setIgnoreMouseEvents(ignore, { forward: true })
  })
}

export function showMeetingPill(app: MeetingApp) {
  if (!deps) return
  state = deps.getState(app)
  if (pill && !pill.isDestroyed()) {
    pill.webContents.send('pill:state', state)
    return
  }
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  pill = new BrowserWindow({
    x: workArea.x + workArea.width - WIDTH - 8,
    y: workArea.y + 8,
    width: WIDTH,
    height: HEIGHT,
    // NSPanel on macOS: shows over full-screen apps without activating Oats.
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  pill.setAlwaysOnTop(true, 'screen-saver')
  // Without skipTransformProcessType Electron briefly turns Oats into a UIElement app,
  // and when the call app has focus it can stay one, losing its Dock icon. The panel
  // type already lets the card show over full-screen apps.
  pill.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  // Until the pointer is over the card, clicks pass through to the apps below.
  pill.setIgnoreMouseEvents(true, { forward: true })
  pill.once('ready-to-show', () => pill?.showInactive())
  pill.on('closed', () => {
    pill = null
    state = null
  })
  if (process.env.ELECTRON_RENDERER_URL) pill.loadURL(`${process.env.ELECTRON_RENDERER_URL}#pill`)
  else pill.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'pill' })
}

export function closeMeetingPill(bundleId?: string) {
  if (!pill || pill.isDestroyed()) return
  if (bundleId && state?.app.bundleId !== bundleId) return
  pill.close()
}
