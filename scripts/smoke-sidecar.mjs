// Smoke test for the packaged Node audio sidecar: runs every oats-audio command
// the app uses through the built app's own executable (ELECTRON_RUN_AS_NODE),
// so it checks packaging (asar, unpacked addons) as well as whisper.cpp and
// sherpa-onnx on this machine.
//
//   node scripts/smoke-sidecar.mjs <dist/win-unpacked | dist/mac-arm64/Oats.app> <speech.wav>
//
// The WAV must be 16 kHz mono 16-bit with a few seconds of speech. Models go to
// $RUNNER_TEMP (or the OS temp dir)/oats-smoke-models.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const [appDir, wav] = process.argv.slice(2).map((p) => p && resolve(p))
if (!appDir || !wav) {
  console.error('usage: node scripts/smoke-sidecar.mjs <unpacked app> <speech.wav>')
  process.exit(2)
}

const mac = appDir.endsWith('.app')
const exe = mac ? join(appDir, 'Contents', 'MacOS', 'Oats') : join(appDir, 'Oats.exe')
const resources = mac ? join(appDir, 'Contents', 'Resources') : join(appDir, 'resources')
const script = join(resources, 'app.asar', 'out', 'main', 'oats-audio.js')
const models = join(process.env.RUNNER_TEMP ?? tmpdir(), 'oats-smoke-models')
const MODEL = 'ggml-base-q5_1'

/** Runs one sidecar command; resolves with its stdout JSON lines once it exits (or `until` matches). */
function run(args, { stdin, until, timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((done, fail) => {
    const started = Date.now()
    const proc = spawn(exe, [script, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    const lines = []
    let buf = ''
    let stderr = ''
    const timer = setTimeout(() => {
      proc.kill()
      fail(new Error(`${args[0]} timed out\n${stderr.slice(-2000)}`))
    }, timeoutMs)
    proc.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line.startsWith('{')) continue
        const event = JSON.parse(line)
        lines.push(event)
        if (until?.(event)) proc.kill()
      }
    })
    proc.stderr.on('data', (d) => (stderr += d))
    proc.on('error', fail)
    proc.on('exit', (code, signal) => {
      clearTimeout(timer)
      const ok = code === 0 || (until && signal && lines.some(until))
      if (!ok) return fail(new Error(`${args[0]} exited with ${code ?? signal}\n${stderr.slice(-2000)}`))
      console.log(`✓ ${args[0]} (${((Date.now() - started) / 1000).toFixed(1)} s)`)
      done(lines)
    })
    stdin?.(proc)
  })
}

function check(condition, message) {
  if (!condition) throw new Error(message)
}

/** Feeds the WAV to `listen` the way the app does: 100 ms frames on channel 1, then flush. */
function streamWav(proc) {
  const data = readFileSync(wav)
  const pcm = data.subarray(data.indexOf('data') + 8)
  const frame = (kind, payload = Buffer.alloc(0)) => {
    const header = Buffer.alloc(6)
    header[0] = kind
    header[1] = 1
    header.writeUInt32LE(payload.length, 2)
    proc.stdin.write(Buffer.concat([header, payload]))
  }
  let started = false
  proc.stdout.on('data', async (d) => {
    if (started || !String(d).includes('"ready"')) return
    started = true
    frame(2)
    for (let i = 0; i < pcm.length; i += 3200) {
      frame(1, pcm.subarray(i, i + 3200))
      await new Promise((r) => setTimeout(r, 10))
    }
    frame(1, Buffer.alloc(32_000)) // 1 s of silence ends the utterance
    frame(3)
    proc.stdin.end()
  })
}

try {
  check(existsSync(exe), `missing ${exe}`)
  check(existsSync(wav), `missing ${wav}`)
  rmSync(models, { recursive: true, force: true })

  const prepared = await run(['prepare-asr', '--model', MODEL, '--models-dir', models])
  check(prepared.at(-1)?.type === 'ready', 'prepare-asr did not report ready')

  const listened = await run(
    ['listen', '--model', MODEL, '--models-dir', models, '--language', 'en', '--words-channels', '1'],
    { stdin: streamWav, timeoutMs: 5 * 60_000 }
  )
  const finals = listened.filter((e) => e.type === 'final' && e.text)
  check(finals.length > 0, 'listen produced no final text')
  check(finals.some((e) => e.words?.length), 'listen finals on channel 1 carry no word timings')
  console.log(`  listen: ${finals.map((e) => e.text).join(' ')}`)

  const out = join(models, 'out.json')
  await run(['transcribe', '--input', wav, '--model', MODEL, '--models-dir', models, '--language', 'en', '--words', '1', '--output', out])
  const { segments } = JSON.parse(readFileSync(out, 'utf8'))
  check(segments.length > 0, 'transcribe found no speech')
  console.log(`  transcribe: ${segments.map((s) => s.text).join(' ')}`)

  await run(['diarize', '--input', wav, '--models-dir', models, '--output', out])
  const diarized = JSON.parse(readFileSync(out, 'utf8'))
  check(diarized.segments.length > 0, 'diarize found no speech')
  check(Object.values(diarized.speakerEmbeddings).every((v) => v.length > 0), 'diarize returned an empty voice embedding')
  console.log(`  diarize: ${Object.keys(diarized.speakerEmbeddings).length} speaker(s), ${diarized.segments.length} segment(s)`)

  if (!mac) {
    const mic = await run(['watch-mic'], { until: (e) => e.type === 'mic', timeoutMs: 30_000 })
    console.log(`  watch-mic: ${JSON.stringify(mic[0].apps)}`)
  }
  console.log('All sidecar checks passed.')
} catch (err) {
  console.error(`✗ ${err.message}`)
  process.exit(1)
}
