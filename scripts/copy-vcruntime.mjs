// Puts the Visual C++ runtime DLLs next to onnxruntime-node's Windows binding before packaging.
// onnxruntime.dll and its binding link the CRT dynamically (MSVCP140*, VCRUNTIME140*), unlike
// the whisper.cpp and sherpa-onnx addons, so on a PC without a recent VC++ Redistributable
// semantic search wouldn't start. Microsoft allows shipping these DLLs in the app's folder
// ("app-local"); Windows looks for them next to the .node file that needs them.
//
//   node scripts/copy-vcruntime.mjs        (npm run dist:win runs it)
//
// The DLLs come from the Visual Studio that builds the app (vswhere finds it). Elsewhere, e.g.
// cross-building on a Mac, it warns and copies nothing: the installer then needs the
// Redistributable on the target PC.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DLLS = ['msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_atomic_wait.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']
const target = join('node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64')

function warn(message) {
  console.warn(`copy-vcruntime: ${message}`)
  console.warn('copy-vcruntime: semantic search will need the VC++ Redistributable (x64) installed on the PC.')
}

function crtFolder() {
  const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  if (!existsSync(vswhere)) return null
  const install = execFileSync(vswhere, ['-latest', '-products', '*', '-property', 'installationPath'], { encoding: 'utf8' }).trim()
  const redist = join(install, 'VC', 'Redist', 'MSVC')
  if (!install || !existsSync(redist)) return null
  // Newest toolset first; its x64 CRT folder is Microsoft.VC<version>.CRT.
  const versions = readdirSync(redist)
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  for (const v of versions) {
    const x64 = join(redist, v, 'x64')
    if (!existsSync(x64)) continue
    const crt = readdirSync(x64).find((d) => /^Microsoft\.VC\d+\.CRT$/.test(d))
    if (crt && DLLS.every((dll) => existsSync(join(x64, crt, dll)))) return join(x64, crt)
  }
  return null
}

if (process.platform !== 'win32') {
  warn('not on Windows, so there is no Visual Studio to take the DLLs from.')
} else if (!existsSync(target)) {
  warn(`${target} is missing; run npm install first.`)
  process.exitCode = 1
} else {
  const from = crtFolder()
  if (!from) {
    warn('no Visual Studio with the C++ build tools found.')
    process.exitCode = 1
  } else {
    for (const dll of DLLS) copyFileSync(join(from, dll), join(target, dll))
    console.log(`copy-vcruntime: copied ${DLLS.length} DLLs from ${from}`)
  }
}
