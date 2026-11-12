// The executable of a packaged app, whichever app it is: Contents/MacOS/<Name> in
// <Name>.app, <Name>.exe in an unpacked Windows build. The smoke scripts run the app's own
// modules through it (ELECTRON_RUN_AS_NODE).

import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

export function appExecutable(appDir) {
  if (appDir.endsWith('.app')) return join(appDir, 'Contents', 'MacOS', basename(appDir, '.app'))
  // The only .exe at the top of the folder is the app; the helpers are under resources/.
  const exe = readdirSync(appDir).find((name) => name.endsWith('.exe'))
  if (!exe) throw new Error(`no .exe in ${appDir}`)
  return join(appDir, exe)
}
