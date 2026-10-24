import { app, BrowserWindow, net } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../shared/types'

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

/** Offers the new build as a download when the site lists one for this computer. */
async function checkManifest() {
  if (!BUILD) return
  const res = await net.fetch(`${FEED}/version.json`, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`version.json: HTTP ${res.status}`)
  const latest = (await res.json()) as { version: string } & Partial<Record<Build, { url: string }>>
  const build = latest[BUILD]
  if (!build || !newer(latest.version, app.getVersion())) return
  // The release's own copy: latest/* can lag behind in a browser cache.
  publish({ status: 'available', version: latest.version, downloadUrl: `${SITE}/download/${build.url}` })
}

export function startUpdateChecks() {
  // Off unless the build names a site (CI builds do; .env usually doesn't).
  if (!SITE || !BUILD) return
  let check: () => void
  // electron-updater only works in a packaged app; in development Windows gets the download card.
  if (BUILD === 'windows' && app.isPackaged) {
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
