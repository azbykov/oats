import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../shared/src/common/defaults'
import { product } from './product'

// What Rye must not do, held in place: a session's audio and notes are health data, and
// nothing here may send them off the computer on its own.

const root = resolve(__dirname, '../../..')

/** The file an import in `from` points to, if it is one of ours (not a package). */
function target(from: string, specifier: string) {
  if (!specifier.startsWith('.')) return null
  const base = resolve(dirname(from), specifier)
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]
  return candidates.find((f) => existsSync(f) && statSync(f).isFile()) ?? null
}

/** Every source file reachable from `entry` through imports, type-only ones aside. */
function reachable(entry: string) {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    if (!/\.tsx?$/.test(file)) continue
    const source = readFileSync(file, 'utf8')
    const imports = source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\s)(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)
    for (const m of imports) {
      const found = target(file, m[1] ?? m[2])
      if (found) queue.push(found)
    }
  }
  return [...seen].map((f) => relative(root, f))
}

const windowEntry = join(__dirname, 'renderer/main.tsx')

test('the import walk sees what an entry pulls in', () => {
  // Oats does offer Deepgram: if the walk misses it there, the test below proves nothing.
  const oats = reachable(join(root, 'apps/oats/src/renderer/main.tsx'))
  expect(oats).toContain('shared/src/renderer/src/lib/deepgram.ts')
  expect(oats).toContain('shared/src/renderer/src/lib/transcription.ts')
})

test('no code in the window opens a connection to a transcription service', () => {
  const files = reachable(windowEntry)
  expect(files).toContain('shared/src/renderer/src/lib/transcription.ts')
  expect(files).not.toContain('shared/src/renderer/src/lib/deepgram.ts')
  // No address a socket could be opened to anywhere else either.
  const sockets = files.filter((f) => /\.tsx?$/.test(f) && /wss?:\/\//.test(readFileSync(join(root, f), 'utf8')))
  expect(sockets).toEqual([])
})

test('the page may connect to nothing but itself', () => {
  const html = readFileSync(join(__dirname, 'renderer/index.html'), 'utf8')
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? ''
  const directives = Object.fromEntries(
    csp.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values])
  )
  expect(directives['connect-src']).toEqual(["'self'"])
  expect(directives['default-src']).toEqual(["'self'"])
})

test('cloud transcription and Notion are left out', () => {
  expect(product.features).toEqual({ notion: false, cloudTranscription: false })
})

test('the settings Rye starts from keep audio local and short-lived', () => {
  const settings = { ...DEFAULT_SETTINGS, ...product.settings }
  expect(settings.transcriptionProvider).toBe('whisper')
  expect(settings.keepAudioBackup).toBe(false)
  expect(product.audioRetentionDays).toBeLessThanOrEqual(7)
})
