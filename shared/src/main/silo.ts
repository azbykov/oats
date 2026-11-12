import { app, safeStorage, utilityProcess, type UtilityProcess } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS } from '../common/defaults'
import type { AppData, DataOp, Settings, Template } from '../common/types'
import {
  pickSecrets,
  SECRET_KEYS,
  type Secrets,
  type SiloApi,
  type SiloMethod,
  type SiloRequest,
  type SiloResponse,
  type SiloTransport,
  type StoredChunk
} from '../silo/api'
import { product } from './product'
import { seal, unseal } from './sealed'

// The main process's side of the silo, the process that owns the database (shared/src/silo).
// Everything here is a request to it, so reading and saving are asynchronous. What the main
// process reads all the time (settings, the template list) is kept as a copy in `state`:
// every change goes through this file, which updates the copy as it sends the change on.

/** Settings and the full template list, as last saved. */
export const state: { settings: Settings; templates: Template[] } = {
  settings: { ...DEFAULT_SETTINGS, ...product.settings },
  templates: product.templates
}

/** What the silo opens the database with: where it is, its key and the app's defaults. */
const opening = (): Parameters<SiloApi['open']> => [
  app.getPath('userData'),
  databaseKey(),
  { settings: { ...DEFAULT_SETTINGS, ...product.settings }, templates: product.templates, recipes: product.recipes }
]

const CLOSE_TIMEOUT_MS = 3000

let child: UtilityProcess | null = null
/** Processes stopped on purpose (closeSilo), whose exit isn't a failure. */
const stopped = new WeakSet<UtilityProcess>()
let nextId = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function request(method: SiloMethod, args: unknown[]): Promise<unknown> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    fork().postMessage({ id, method, args } satisfies SiloRequest)
  })
}

function fork() {
  if (child) return child
  const proc = utilityProcess.fork(join(__dirname, 'oats-silo.js'), [], { serviceName: `${product.name} Silo` })
  proc.on('message', (msg: SiloResponse) => {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    if ('error' in msg) p?.reject(new Error(msg.error))
    else p?.resolve(msg.result)
  })
  proc.on('exit', (code) => {
    if (child === proc) child = null
    if (!stopped.has(proc)) console.error(`The silo stopped (exit code ${code})`)
    // Whatever was committed is on disk (WAL); only the requests still waiting are lost.
    const error = new Error(`The notes database stopped (exit code ${code}).`)
    for (const p of pending.values()) p.reject(error)
    pending.clear()
  })
  child = proc
  return proc
}

/** Requests over the silo process. One started again after a crash opens the database first. */
const overProcess: SiloTransport = (method, args) => {
  if (!child && method !== 'open') request('open', opening()).catch(() => {})
  return request(method, args)
}

// The database is encrypted with 32 random bytes made on first launch. They are kept in
// oats.key, sealed with the OS keychain (Keychain on macOS, DPAPI on Windows), so the file
// is of no use on another computer or under another user. The key is never replaced: without
// it the notes can't be read. Where there is no keychain the database stays unencrypted.
let key: string | null | undefined

function databaseKey() {
  if (key !== undefined) return key
  if (!safeStorage.isEncryptionAvailable()) return (key = null)
  const file = join(app.getPath('userData'), 'oats.key')
  if (existsSync(file)) {
    try {
      return (key = unseal<string>(readFileSync(file, 'utf8')))
    } catch (err) {
      throw new Error(
        'The key to your notes couldn’t be read from this computer’s keychain. ' +
          'That happens when the notes were copied from another computer or user account, or the keychain was reset.',
        { cause: err }
      )
    }
  }
  const made = randomBytes(32).toString('hex')
  // Written in full before the database is encrypted with it.
  writeFileSync(`${file}.new`, seal(made), { flush: true })
  renameSync(`${file}.new`, file)
  return (key = made)
}

let transport = overProcess
/** Not started yet, or closed for quitting: nothing is sent, so nothing starts the process. */
let closed = true

function call<K extends SiloMethod>(method: K, ...args: Parameters<SiloApi[K]>) {
  if (closed) return Promise.reject(new Error('The notes database is closed.'))
  return transport(method, args) as Promise<ReturnType<SiloApi[K]>>
}

/**
 * Starts the silo and opens the database, encrypting one from an older version first.
 * Rejects when it can't be opened; the file is left as it is. `over` replaces the process in tests.
 */
export async function startSilo(over: SiloTransport = overProcess) {
  transport = over
  closed = false
  await call('open', ...opening())
  Object.assign(state, await call('loadState'))
}

/** Lets the silo finish what it was sent and close the database, then stops it. */
export async function closeSilo() {
  if (closed) return
  const closing = call('close').catch((err) => console.error('The silo did not close cleanly', err))
  closed = true
  await Promise.race([closing, new Promise((r) => setTimeout(r, CLOSE_TIMEOUT_MS))])
  if (child) {
    stopped.add(child)
    child.kill()
  }
}

// API keys are kept out of the settings JSON, in a `secrets` row encrypted with the OS
// keychain (safeStorage). Until unlockSecrets() has run (or when there is no keychain) the
// settings are saved as they were read, keys and all.
let secrets: Secrets | undefined

/** Shows a change in `state` at once and takes it back if the silo couldn't save it. */
async function saving(next: Partial<typeof state>, save: (sealed?: string) => Promise<void>) {
  const before = { ...state, secrets }
  const nextSecrets = next.settings && secrets ? pickSecrets(next.settings) : secrets
  const sealed = next.settings && nextSecrets ? seal(nextSecrets) : undefined
  Object.assign(state, next)
  secrets = nextSecrets
  const after = { ...state, secrets }
  try {
    await save(sealed)
  } catch (err) {
    if (state.settings === after.settings) state.settings = before.settings
    if (state.templates === after.templates) state.templates = before.templates
    if (secrets === after.secrets) secrets = before.secrets
    throw err
  }
}

/** Saves a batch of changes from the renderer, all or nothing. */
export function applyOps(ops: DataOp[]) {
  const next: Partial<typeof state> = {}
  for (const op of ops) {
    if (op.type === 'settings') next.settings = op.settings
    else if (op.type === 'templates') next.templates = op.templates
  }
  return saving(next, (sealed) => call('applyOps', ops, sealed))
}

export function updateSettings(patch: Partial<Settings>) {
  const settings = { ...state.settings, ...patch }
  return saving({ settings }, (sealed) => call('saveSettings', settings, sealed))
}

/** Decrypts the API keys into the settings, moving any plaintext keys from older versions. */
export async function unlockSecrets() {
  if (secrets || !safeStorage.isEncryptionAvailable()) return
  const row = await call('sealedSecrets')
  let stored: Secrets | undefined
  if (row) {
    try {
      stored = pickSecrets(unseal<Partial<Secrets>>(row))
    } catch (err) {
      // Another keychain (a copied profile, a reset login keychain): the keys have to be entered again.
      console.error('Could not decrypt the saved API keys', err)
    }
  }
  const plaintext = !row && SECRET_KEYS.some((k) => state.settings[k])
  secrets = stored ?? pickSecrets(state.settings)
  const settings = { ...state.settings, ...secrets }
  await saving({ settings }, (sealed) => call('saveSettings', settings, sealed))
  if (plaintext) await call('compact')
}

export async function loadData(): Promise<AppData> {
  const data = await call('loadData')
  // The copy here has the unlocked API keys and any change still on its way to the silo.
  return { ...data, settings: state.settings, templates: state.templates }
}

/** Ids of notes whose title, notes, generated notes or transcript contain every word of `query`. */
export const searchNotes = (query: string) => call('searchNotes', query)

// For semantic search (semantic.ts).
export const noteForIndex = (id: string) => call('noteForIndex', id)
export const allNoteIds = () => call('allNoteIds')
export const indexStats = () => call('indexStats')
export const chunkHash = (noteId: string) => call('chunkHash', noteId)
export const saveChunks = (noteId: string, hash: string, chunks: StoredChunk[]) => call('saveChunks', noteId, hash, chunks)
export const loadChunks = () => call('loadChunks')
/** Drops every embedding, e.g. when the model is removed. */
export const clearChunks = () => call('clearChunks')
