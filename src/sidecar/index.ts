import { CLIError, flags, releaseAll, usage } from './common'
import { runDiarization } from './diarize'
import { runListen } from './listen'
import { runPrepare } from './prepare'
import { runTranscribe } from './transcribe'
import { runWatchMic } from './watch-mic'

// oats-audio (Node): the cross-platform build of the native audio sidecar, used
// on Windows (and Intel Macs) where the Swift/CoreML one can't run. Same
// subcommands, flags, stdin frames and JSON output as native/audio, so the
// main process drives either one the same way. Runs under Electron's own Node
// (ELECTRON_RUN_AS_NODE) with whisper.cpp and sherpa-onnx as native addons.
//   diarize / embed   offline speaker separation (sherpa-onnx)   — diarize.ts
//   prepare-asr       download + load a whisper.cpp model        — prepare.ts
//   listen            streaming local transcription              — listen.ts
//   transcribe        batch transcription of a recorded WAV      — transcribe.ts
//   watch-mic         which apps are recording from the mic      — watch-mic.ts

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  switch (command) {
    case 'diarize':
    case 'embed':
      return runDiarization(command, flags(rest))
    case 'prepare-asr':
      return runPrepare(flags(rest))
    case 'listen':
      return runListen(flags(rest))
    case 'transcribe':
      return runTranscribe(flags(rest))
    case 'watch-mic':
      return runWatchMic()
    default:
      throw new CLIError(usage)
  }
}

const exit = (code: number) => releaseAll().finally(() => process.exit(code))

// The main process stops a lingering listener with SIGTERM.
process.on('SIGTERM', () => exit(0))

main().then(
  () => exit(0),
  (err: unknown) => {
    process.stderr.write(`oats-audio: ${err instanceof Error ? err.message : String(err)}\n`)
    exit(1)
  }
)
