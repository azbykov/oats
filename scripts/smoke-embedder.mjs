// Smoke test for semantic search's ONNX runtime in the packaged app: loads onnxruntime-node
// from the app bundle through the app's own executable (ELECTRON_RUN_AS_NODE) and makes it
// parse a model, which loads onnxruntime.dll / libonnxruntime itself. On Windows it also
// checks that the VC++ runtime DLLs ship next to the binding (scripts/copy-vcruntime.mjs):
// CI runners have the Redistributable installed, so loading alone wouldn't catch them missing.
//
//   node scripts/smoke-embedder.mjs <dist/win-unpacked | dist/mac-arm64/Oats.app>
//
// Needs no model download: a few bytes that aren't a model are enough to reach the parser.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const appDir = process.argv[2] && resolve(process.argv[2])
if (!appDir) {
  console.error('usage: node scripts/smoke-embedder.mjs <unpacked app>')
  process.exit(2)
}

const mac = appDir.endsWith('.app')
const exe = mac ? join(appDir, 'Contents', 'MacOS', 'Oats') : join(appDir, 'Oats.exe')
const resources = mac ? join(appDir, 'Contents', 'Resources') : join(appDir, 'resources')
const binDir = join(resources, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', process.platform, process.arch)

const fail = (message) => {
  console.error(`smoke-embedder: ${message}`)
  process.exit(1)
}

if (!existsSync(join(binDir, 'onnxruntime_binding.node'))) fail(`no unpacked binding in ${binDir}`)
if (process.platform === 'win32') {
  const dlls = ['msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_atomic_wait.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']
  const missing = dlls.filter((d) => !existsSync(join(binDir, d)))
  if (missing.length) fail(`VC++ runtime DLLs missing next to the binding: ${missing.join(', ')}`)
}

const probe = `
const ort = require(${JSON.stringify(join(resources, 'app.asar', 'node_modules', 'onnxruntime-node'))})
ort.InferenceSession.create(Buffer.from('not an onnx model')).then(
  () => { console.log('UNEXPECTED: garbage parsed as a model'); process.exit(1) },
  (err) => { console.log('ORT: ' + err.message); process.exit(0) }
)`
const run = spawnSync(exe, ['-e', probe], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
  timeout: 60_000
})
const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim()
// A runtime that loaded rejects the bytes with a protobuf parse error; a missing DLL ends
// the process or fails the require instead.
if (run.status !== 0 || !/protobuf|pars/i.test(output)) fail(`ONNX runtime didn't load (exit ${run.status}):\n${output.slice(-2000)}`)
console.log(`smoke-embedder: ok\n${output}`)
