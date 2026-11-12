// Local Whisper models per audio engine. The Swift sidecar (Apple Silicon) runs
// WhisperKit's CoreML builds; the cross-platform Node sidecar (Windows, Intel
// Macs) runs whisper.cpp's ggml builds. Shared by the main process (Settings
// list, "is it downloaded?") and the Node sidecar (where to download from).

export type AudioEngine = 'whisperkit' | 'whispercpp'

export interface AsrModel {
  id: string
  label: string
  size: string
  /** whisper.cpp only: download URL of the single ggml file. */
  url?: string
}

const GGML = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

export const ASR_MODELS: Record<AudioEngine, AsrModel[]> = {
  whisperkit: [
    { id: 'openai_whisper-large-v3-v20240930_turbo_632MB', label: 'Whisper large-v3 turbo', size: '632 MB' },
    { id: 'openai_whisper-small_216MB', label: 'Whisper small', size: '216 MB' },
    { id: 'openai_whisper-base', label: 'Whisper base', size: '145 MB' }
  ],
  whispercpp: [
    {
      id: 'ggml-large-v3-turbo-q5_0',
      label: 'Whisper large-v3 turbo',
      size: '574 MB',
      url: `${GGML}/ggml-large-v3-turbo-q5_0.bin`
    },
    { id: 'ggml-small-q5_1', label: 'Whisper small', size: '190 MB', url: `${GGML}/ggml-small-q5_1.bin` },
    { id: 'ggml-base-q5_1', label: 'Whisper base', size: '60 MB', url: `${GGML}/ggml-base-q5_1.bin` }
  ]
}

/**
 * Preselected model. whisper.cpp runs on whatever CPU or GPU the PC has, so it
 * starts with small, which keeps up live everywhere; large-v3 turbo is one click away.
 */
export const DEFAULT_MODEL: Record<AudioEngine, string> = {
  whisperkit: 'openai_whisper-large-v3-v20240930_turbo_632MB',
  whispercpp: 'ggml-small-q5_1'
}

/** whisper.cpp models are stored as <models dir>/ggml/<id>.bin. */
export const GGML_DIR = 'ggml'
