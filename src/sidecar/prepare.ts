import { existsSync } from 'node:fs'
import { ASR_MODELS } from '../shared/asr-models'
import { auxModel, CLIError, download, emit, loadWhisper, releaseWhisper, requireFlag } from './common'
import { modelPath } from './listen'

//   oats-audio prepare-asr --model <id> --models-dir <dir>
//     stdout — {type: "progress", stage: "download" | "compile", fraction} … {type: "ready"}

export async function runPrepare(f: Record<string, string>) {
  const id = requireFlag(f, 'model')
  const modelsDir = requireFlag(f, 'models-dir')
  const model = ASR_MODELS.whispercpp.find((m) => m.id === id)
  if (!model?.url) throw new CLIError(`unknown model ${id}`)

  const path = modelPath(modelsDir, id)
  if (!existsSync(path)) {
    let last = -1
    await download(model.url, path, (fraction) => {
      const pct = Math.floor(fraction * 100)
      if (pct === last) return
      last = pct
      emit({ type: 'progress', stage: 'download', fraction })
    })
  }
  // Loading once checks the file and warms the GPU backend; the VAD model is
  // fetched now too so the first recording doesn't stall on it.
  emit({ type: 'progress', stage: 'compile', fraction: 1 })
  await auxModel(modelsDir, 'vad')
  await releaseWhisper(await loadWhisper(path))
  emit({ type: 'ready', modelFolder: path })
}
