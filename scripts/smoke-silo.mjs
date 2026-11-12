// Smoke test for the encrypted database in the packaged app: loads
// better-sqlite3-multiple-ciphers from the app bundle through the app's own executable
// (ELECTRON_RUN_AS_NODE), writes a database with a key the way the silo does
// (shared/src/silo/store.ts) and reads it back. Catches a native binary that was left out of the
// package, kept inside app.asar, or can't load on this system: any of those would stop
// the app from opening anyone's notes.
//
//   node scripts/smoke-silo.mjs <dist/win-unpacked | dist/mac-arm64/Oats.app | dist/rye/mac-arm64/Rye.app>

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { appExecutable } from './app-exe.mjs'

const appDir = process.argv[2] && resolve(process.argv[2])
if (!appDir) {
  console.error('usage: node scripts/smoke-silo.mjs <unpacked app>')
  process.exit(2)
}

const mac = appDir.endsWith('.app')
const exe = appExecutable(appDir)
const resources = mac ? join(appDir, 'Contents', 'Resources') : join(appDir, 'resources')

const fail = (message) => {
  console.error(`smoke-silo: ${message}`)
  process.exit(1)
}

// The binary has to be a real file outside app.asar; the rest is checked from inside the app, below.
const prebuilt = join(resources, 'app.asar.unpacked', 'node_modules', 'better-sqlite3-multiple-ciphers', 'prebuilds', `${process.platform}-${process.arch}.node`)
if (!existsSync(prebuilt)) fail(`no unpacked binary at ${prebuilt}`)

const dir = mkdtempSync(join(tmpdir(), 'oats-smoke-silo-'))
const probe = `
const fs = require('fs')
const app = ${JSON.stringify(join(resources, 'app.asar'))}
if (!fs.existsSync(app + '/out/main/oats-silo.js')) throw new Error('oats-silo.js is not in the package')
const Database = require(app + '/node_modules/better-sqlite3-multiple-ciphers')
const file = ${JSON.stringify(join(dir, 'smoke.db'))}
const key = 'ab'.repeat(32)
const open = (k) => {
  const d = new Database(file)
  if (k) { d.pragma("cipher = 'sqlcipher'"); d.pragma('legacy = 4'); d.pragma(\`key = "x'\${k}'"\`) }
  return d
}
let d = open(key)
d.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x TEXT); CREATE VIRTUAL TABLE f USING fts5 (x, tokenize = 'trigram case_sensitive 0')")
d.prepare('INSERT INTO t VALUES (?)').run('smoke-marker')
d.prepare('INSERT INTO f VALUES (?)').run('Smoke-Marker')
d.close()
if (fs.readFileSync(file).includes('smoke-marker')) throw new Error('the database is not encrypted')
d = open(key)
const found = d.prepare("SELECT x FROM f WHERE f MATCH '\\"marker\\"'").all().length
const read = d.prepare('SELECT x FROM t').get().x
d.close()
let refused = false
try { open(null).prepare('SELECT count(*) FROM sqlite_master').get() } catch { refused = true }
if (read !== 'smoke-marker' || found !== 1 || !refused) throw new Error('unexpected result: ' + JSON.stringify({ read, found, refused }))
console.log('SILO: encrypted database written, searched and read back')
`
const run = spawnSync(exe, ['-e', probe], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
  timeout: 60_000
})
rmSync(dir, { recursive: true, force: true })
const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim()
if (run.status !== 0 || !output.includes('SILO: ')) fail(`the encrypted database didn't work (exit ${run.status}):\n${output.slice(-2000)}`)
console.log(`smoke-silo: ok\n${output}`)
