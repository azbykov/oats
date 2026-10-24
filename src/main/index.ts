import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  session,
  shell
} from 'electron'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  AccountProvider,
  AiStreamEvent,
  AppData,
  ChatRequest,
  EnhanceRequest,
  MeetingApp,
  MeetingStart,
  PermissionKind,
  PillAction,
  RecordingMeta,
  Theme
} from '../shared/types'
import {
  configuredProviders,
  connectAccount,
  disconnectAccount,
  listAccounts,
  setAppPassword,
  setCalendarEnabled
} from './accounts'
import { abort, chat, enhance, listOpenAIModels } from './ai'
import * as asr from './asr'
import { fetchCalendar } from './calendar'
import { activeMeetingApps, setMeetingDetection, type MeetingHandlers } from './meetings'
import { cancelAuthorization } from './oauth'
import { openPermissionSettings, permissionStatus, requestPermission } from './permissions'
import { closeMeetingPill, initMeetingPill, showMeetingPill } from './pill'
import * as recordings from './recordings'
import { audioHelper } from './sidecar'
import { flushData, loadData, saveData } from './store'

// Lets a second copy (or a test run) keep its data separate.
if (process.env.OATS_USER_DATA) app.setPath('userData', process.env.OATS_USER_DATA)

// oats:// links bring Oats to the front; the browser tab that finishes a sign-in
// opens one (oauth.ts). An unpackaged run (npm run dev) registers Electron with
// the app's path as its argument.
if (process.defaultApp) {
  if (process.argv[1]) app.setAsDefaultProtocolClient('oats', process.execPath, [resolve(process.argv[1])])
} else {
  app.setAsDefaultProtocolClient('oats')
}
// On Windows a link starts a second copy, which hands over to this one and quits.
// The lock lives in userData, so OATS_USER_DATA copies still run side by side.
if (!app.requestSingleInstanceLock()) app.quit()

let win: BrowserWindow | null = null
let data: AppData = loadData()
data.settings.whisperModel = asr.knownModel(data.settings.whisperModel)

// Core Audio Tap (macOS 14.2+) captures system audio without screen recording:
// only the "System Audio Recording" permission is needed and no video is captured.
// Notion's desktop app enables the same Chromium feature for its meeting notes.
const coreAudioTap = (() => {
  if (process.platform !== 'darwin') return false
  const [major, minor] = process.getSystemVersion().split('.').map(Number)
  return major > 14 || (major === 14 && minor >= 2)
})()
if (coreAudioTap) app.commandLine.appendSwitch('enable-features', 'MacCatapLoopbackAudioForScreenShare')

const BG = { light: '#fcfcf8', dark: '#1e1e1e' }
const TITLE_BAR_HEIGHT = 52

// Windows draws its own minimize/maximize/close buttons over the hidden title bar.
const titleBarOverlay = (): Electron.TitleBarOverlay => ({
  height: TITLE_BAR_HEIGHT,
  color: '#00000000',
  symbolColor: nativeTheme.shouldUseDarkColors ? '#e8e8e3' : '#3b3b38'
})

function applyTheme(theme: Theme) {
  nativeTheme.themeSource = theme
  syncWindowColors()
}

function syncWindowColors() {
  if (!win || win.isDestroyed()) return
  win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? BG.dark : BG.light)
  if (process.platform !== 'darwin') win.setTitleBarOverlay(titleBarOverlay())
}

function createWindow() {
  applyTheme(data.settings.theme)
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'Oats',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay() }),
    backgroundColor: nativeTheme.shouldUseDarkColors ? BG.dark : BG.light,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

function setupMedia() {
  // getDisplayMedia (system audio) is gated by "display-capture", not "media".
  const allowed = new Set(['media', 'display-capture', 'clipboard-sanitized-write'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
  // System audio: an audio-only getDisplayMedia() is answered with loopback of
  // everything the computer plays — Core Audio Tap on macOS 14.2+, WASAPI
  // loopback of the default output device on Windows. Older macOS falls back to
  // ScreenCaptureKit, which needs a screen source (and Screen Recording
  // permission) alongside the loopback audio.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (req, cb) => {
      if ((coreAudioTap || process.platform === 'win32') && !req.videoRequested) {
        cb({ audio: 'loopback' })
        return
      }
      try {
        const [screen] = await desktopCapturer.getSources({ types: ['screen'] })
        cb({ video: screen, audio: 'loopback' })
      } catch (err) {
        console.error('System audio capture unavailable', err)
        cb({})
      }
    },
    { useSystemPicker: false }
  )
}

/** Bring Oats forward and run something in its window once it is ready. */
function withMainWindow(fn: (w: BrowserWindow) => void) {
  if (!win || win.isDestroyed()) {
    createWindow()
    win!.webContents.once('did-finish-load', () => fn(win!))
  } else {
    fn(win)
  }
  win?.show()
  win?.focus()
}

function onPillAction(app: MeetingApp, action: PillAction) {
  if (action.type === 'take-notes') {
    withMainWindow((w) => w.webContents.send('meeting:start', { app, templateId: action.templateId } satisfies MeetingStart))
  } else if (app.bundleId === 'preview') {
    // the settings preview has nothing to ignore
  } else if (action.type === 'ignore-app' && win && !win.isDestroyed()) {
    // The renderer owns the data, so it records the change and saves it back.
    win.webContents.send('meeting:ignore', app)
  } else if (action.type === 'ignore-app') {
    data.settings.ignoredMeetingApps = [...(data.settings.ignoredMeetingApps ?? []), app.bundleId]
    saveData(data)
  }
}

// When Oats is in front, the in-app banner offers notes; otherwise the floating card does.
const meetingHandlers: MeetingHandlers = {
  isIgnored: (bundleId) => (data.settings.ignoredMeetingApps ?? []).includes(bundleId),
  onDetected: (app) => {
    if (!BrowserWindow.getFocusedWindow()) showMeetingPill(app)
  },
  onEnded: (app) => closeMeetingPill(app.bundleId)
}

function setupMenu() {
  const send = (channel: string) => () => win?.webContents.send(channel)
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as const] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Note', accelerator: 'CmdOrCtrl+N', click: send('menu:new-note') },
        { label: 'Search', accelerator: 'CmdOrCtrl+K', click: send('menu:search') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('menu:settings') },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function setupIpc() {
  ipcMain.handle('data:load', () => data)
  ipcMain.on('data:save', (_e, next: AppData) => {
    const themeChanged = next.settings.theme !== data.settings.theme
    const detectionChanged = next.settings.detectMeetings !== data.settings.detectMeetings
    data = next
    saveData(data)
    if (themeChanged) applyTheme(data.settings.theme)
    if (detectionChanged) setMeetingDetection(data.settings.detectMeetings, meetingHandlers)
  })

  const emitTo = (sender: Electron.WebContents, id: string) => (ev: AiStreamEvent) => {
    if (!sender.isDestroyed()) sender.send('ai:event', id, ev)
  }
  ipcMain.handle('ai:enhance', (e, id: string, req: EnhanceRequest) => {
    enhance(id, data.settings, req, emitTo(e.sender, id))
  })
  ipcMain.handle('ai:chat', (e, id: string, req: ChatRequest) => {
    chat(id, data.settings, req, emitTo(e.sender, id))
  })
  ipcMain.on('ai:abort', (_e, id: string) => abort(id))
  ipcMain.handle('ai:openai-models', () => listOpenAIModels(data.settings.openaiApiKey).catch(() => []))

  ipcMain.handle('asr:models', () => asr.listModels())
  ipcMain.on('asr:prepare', (_e, id: string) => asr.prepareModel(id))
  ipcMain.handle('asr:start', (e, model: string, language: string, words: boolean) =>
    asr.startListener(model, language, words, e.sender)
  )
  ipcMain.on('asr:frame', (_e, kind: number, channel: number, pcm?: ArrayBuffer) => asr.sendFrame(kind, channel, pcm))

  ipcMain.handle('native:available', () => audioHelper() !== null)
  ipcMain.on('rec:begin', (_e, meta: RecordingMeta) => recordings.begin(meta))
  ipcMain.on('rec:chunk', (_e, id: string, pcm: ArrayBuffer) => recordings.append(id, pcm))
  ipcMain.handle('rec:finish', (_e, id: string) => recordings.finish(id))
  ipcMain.handle('rec:diarize', (_e, id: string, maxSpeakers?: number) => recordings.diarize(id, maxSpeakers))
  ipcMain.handle('rec:transcribe', (_e, id: string, words: boolean) =>
    recordings.transcribe(id, data.settings.whisperModel, data.settings.language, words)
  )
  ipcMain.handle('rec:remove', (_e, id: string) => recordings.remove(id))
  ipcMain.handle('rec:leftovers', () => recordings.leftovers())

  ipcMain.handle('meeting:active', () => activeMeetingApps())
  // Settings → "Preview" shows the card without waiting for a real call.
  ipcMain.on('meeting:preview', () => showMeetingPill({ bundleId: 'preview', name: 'Zoom', browser: false }))

  ipcMain.handle('calendar:events', () => fetchCalendar(data.settings.icsUrl))

  ipcMain.handle('accounts:list', () => listAccounts())
  ipcMain.handle('accounts:providers', () => configuredProviders())
  ipcMain.handle('accounts:connect', (_e, provider: AccountProvider) => connectAccount(provider))
  ipcMain.on('accounts:cancel', () => cancelAuthorization())
  ipcMain.handle('accounts:disconnect', (_e, id: string) => disconnectAccount(id))
  ipcMain.handle('accounts:app-password', (_e, id: string, password: string) => setAppPassword(id, password))
  ipcMain.handle('accounts:set-calendar', (_e, id: string, calendarId: string, enabled: boolean) =>
    setCalendarEnabled(id, calendarId, enabled)
  )

  ipcMain.handle('media:system-audio-mode', () =>
    process.platform === 'win32' ? 'loopback' : coreAudioTap ? 'tap' : 'screen'
  )
  ipcMain.handle('permissions:status', () => permissionStatus(coreAudioTap))
  ipcMain.handle('permissions:request', (_e, kind: PermissionKind) => requestPermission(kind, coreAudioTap))
  ipcMain.on('permissions:open', (_e, kind: PermissionKind) => openPermissionSettings(kind))

  ipcMain.handle('export:markdown', async (_e, name: string, markdown: string) => {
    if (!win) return false
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `${name.replace(/[/\\?%*:|"<>]/g, '-') || 'Untitled'}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (canceled || !filePath) return false
    await writeFile(filePath, markdown, 'utf8')
    return true
  })
  ipcMain.on('open-external', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
  })
}

app.setName('Oats')
app.whenReady().then(() => {
  setupMedia()
  setupMenu()
  setupIpc()
  initMeetingPill({
    getState: (app) => ({
      app,
      templates: data.templates.map((t) => ({ id: t.id, title: t.title })),
      theme: data.settings.theme
    }),
    onAction: onPillAction
  })
  createWindow()
  setMeetingDetection(data.settings.detectMeetings, meetingHandlers)
  nativeTheme.on('updated', syncWindowColors)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

const showMainWindow = () => withMainWindow(() => {})
app.on('second-instance', showMainWindow)
app.on('open-url', (e) => {
  e.preventDefault()
  // A link that launched Oats is answered by the window opening on ready.
  if (app.isReady()) showMainWindow()
})

app.on('before-quit', () => {
  flushData()
  recordings.closeAll()
  setMeetingDetection(false, meetingHandlers)
  asr.stopListener()
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
