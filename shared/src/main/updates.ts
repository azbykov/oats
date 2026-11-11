import { app, BrowserWindow, dialog, net, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../common/types'

// New releases come from the site that serves the landing's downloads (oats-site,
// /download/*, filled by CI on release tags; see scripts/publish-r2.sh).
// - Windows: electron-updater downloads the installer in the background (latest.yml)
//   and runs it on restart.
// - Macs: builds are signed ad hoc, which Squirrel.Mac refuses to update, so the app
//   reads latest/version.json and offers a link to the new build.
const SITE = import.meta.env.MAIN_VITE_UPDATE_URL?.replace(/\/+$/, '') || undefined
const FEED = `${SITE}/download/latest`
const CHECK_EVERY = 6 * 60 * 60_000

type Build = 'windows' | 'macArm64' | 'macX64'
const BUILD: Build | null =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? (process.arch === 'arm64' ? 'macArm64' : 'macX64') : null

let state: UpdateState | null = null

export const updateState = () => state

function publish(next: UpdateState) {
  state = next
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('update:state', next)
}

/** a > b for dotted versions; a pre-release suffix is ignored. */
function newer(a: string, b: string) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  }
  return false
}

/** Offers the new build as a download when the site lists one for this computer; returns its version. */
async function checkManifest(): Promise<string | null> {
  if (!BUILD) return null
  const res = await net.fetch(`${FEED}/version.json`, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`version.json: HTTP ${res.status}`)
  const latest = (await res.json()) as { version: string } & Partial<Record<Build, { url: string }>>
  const build = latest[BUILD]
  if (!build || !newer(latest.version, app.getVersion())) return null
  // The release's own copy: latest/* can lag behind in a browser cache.
  publish({ status: 'available', version: latest.version, downloadUrl: `${SITE}/download/${build.url}` })
  return latest.version
}

const useAutoUpdater = () => BUILD === 'windows' && app.isPackaged

export function startUpdateChecks() {
  // Off unless the build names a site (CI builds do; .env usually doesn't).
  if (!SITE || !BUILD) return
  let check: () => void
  // electron-updater only works in a packaged app; in development Windows gets the download card.
  if (useAutoUpdater()) {
    autoUpdater.setFeedURL({ provider: 'generic', url: FEED })
    autoUpdater.on('update-downloaded', (info) => publish({ status: 'ready', version: info.version }))
    // A failed check or download still tells the user about the release, as on the Mac.
    autoUpdater.on('error', (err) => {
      console.warn('Update failed', err)
      if (state?.status !== 'ready') checkManifest().catch((e) => console.warn('Update check failed', e))
    })
    check = () => void autoUpdater.checkForUpdates().catch(() => {}) // reported through 'error'
  } else {
    check = () => void checkManifest().catch((err) => console.warn('Update check failed', err))
  }
  setTimeout(check, 10_000)
  setInterval(check, CHECK_EVERY)
}

/** Restarts into the downloaded update (Windows). */
export function installUpdate() {
  if (state?.status === 'ready') autoUpdater.quitAndInstall(true, true)
}

let manualCheck: Promise<void> | null = null

/** Help → Check for Updates…: checks now and says what it found, including "up to date". */
export function checkForUpdatesNow(parent?: BrowserWindow) {
  manualCheck ??= runManualCheck(parent).finally(() => (manualCheck = null))
  return manualCheck
}

async function runManualCheck(parent?: BrowserWindow) {
  const current = app.getVersion()
  const say = (message: string, detail?: string, buttons = ['OK']) => {
    const options = { type: 'info' as const, message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1 }
    return parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)
  }

  if (!SITE || !BUILD) {
    await say('Updates are off in this build.', 'It was built without MAIN_VITE_UPDATE_URL.')
    return
  }
  if (state?.status === 'ready') {
    await say(`Oats ${state.version} is ready to install.`, 'Use "Restart to update" in the sidebar, or quit Oats to install it.')
    return
  }

  let version: string | null
  try {
    if (useAutoUpdater()) {
      const result = await autoUpdater.checkForUpdates()
      version = result?.isUpdateAvailable ? result.updateInfo.version : null
      if (version) {
        await say(`Oats ${version} is downloading.`, 'Oats will offer to restart once it is ready.')
        return
      }
    } else {
      version = await checkManifest()
    }
  } catch (err) {
    console.warn('Update check failed', err)
    await say("Couldn't check for updates.", err instanceof Error ? err.message : String(err))
    return
  }

  if (!version || state?.status !== 'available') {
    await say("You're up to date.", `Oats ${current} is the latest version.`)
    return
  }
  const { downloadUrl } = state
  const { response } = await say(`Oats ${version} is available.`, `You have ${current}.`, ['Download', 'Later'])
  if (response === 0) void shell.openExternal(downloadUrl)
}
