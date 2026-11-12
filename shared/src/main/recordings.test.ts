import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { RecordingMeta } from '../common/types'

const env = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => env.dir } }))
vi.mock('./asr', () => ({ readyModel: () => null, whisperModelsDir: () => '' }))
vi.mock('./sidecar', () => ({ audioHelper: () => null, NOT_INSTALLED: 'Not installed.', runAudio: async () => {} }))

import { product } from './product'
import * as recordings from './recordings'

const folder = () => join(env.dir, 'recordings')
const meta = (id: string): RecordingMeta => ({
  id,
  sessionId: 's1',
  noteId: 'n1',
  channel: 'them',
  offset: 0,
  startedAt: '2026-11-12T10:00:00.000Z'
})

beforeEach(() => {
  delete product.audioRetentionDays
  env.dir = mkdtempSync(join(tmpdir(), 'recordings-'))
})
afterEach(() => rmSync(env.dir, { recursive: true, force: true }))

test('nothing to recover without a recordings folder', () => {
  expect(recordings.leftovers()).toEqual([])
})

test('leftovers keeps what can be recovered and deletes the rest', () => {
  mkdirSync(folder())
  const put = (name: string, content = '') => writeFileSync(join(folder(), name), content)
  put('a.wav')
  put('a.json', JSON.stringify(meta('a')))
  put('b.wav') // audio whose metadata was never written
  put('c.wav')
  put('c.json', '{"id":') // cut off mid-write
  put('d.json', JSON.stringify(meta('d'))) // metadata whose audio is gone
  put('a.wav.1731400000000.out.json', '{"segments":[{"text":"said in session"}]}') // the helper's result

  expect(recordings.leftovers()).toEqual([meta('a')])
  expect(readdirSync(folder()).sort()).toEqual(['a.json', 'a.wav'])
})

test('a recording in progress is neither a leftover nor deleted', async () => {
  recordings.begin(meta('live'))
  recordings.append('live', new ArrayBuffer(320))
  expect(recordings.leftovers()).toEqual([])
  await recordings.finish('live')
  expect(readdirSync(folder()).sort()).toEqual(['live.json', 'live.wav'])
  expect(recordings.leftovers()).toEqual([{ ...meta('live'), endedCleanly: true }])

  await recordings.remove('live')
  expect(readdirSync(folder())).toEqual([])
})

test('audio waits for recovery no longer than the app allows', async () => {
  mkdirSync(folder())
  const put = (id: string, startedAt: string) => {
    writeFileSync(join(folder(), `${id}.wav`), '')
    writeFileSync(join(folder(), `${id}.json`), JSON.stringify({ ...meta(id), startedAt }))
  }
  const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 3600_000).toISOString()
  put('old', daysAgo(4))
  put('fresh', daysAgo(2))
  put('undated', 'not a date')

  // No limit: everything waits.
  await recordings.expire()
  expect(recordings.leftovers().map((m) => m.id).sort()).toEqual(['fresh', 'old', 'undated'])

  product.audioRetentionDays = 3
  await recordings.expire()
  expect(readdirSync(folder()).sort()).toEqual(['fresh.json', 'fresh.wav'])

  // At startup too, before anything is offered for recovery.
  put('old', daysAgo(4))
  expect(recordings.leftovers().map((m) => m.id)).toEqual(['fresh'])
  expect(readdirSync(folder()).sort()).toEqual(['fresh.json', 'fresh.wav'])
})
