// The parts of sherpa-onnx-node (JS only, no bundled types) that the sidecar uses.
declare module 'sherpa-onnx-node' {
  export interface SpeechSegment {
    start: number
    samples: Float32Array
  }

  export class Vad {
    constructor(
      config: {
        sileroVad: {
          model: string
          threshold?: number
          minSilenceDuration?: number
          minSpeechDuration?: number
          windowSize?: number
          maxSpeechDuration?: number
        }
        sampleRate?: number
        numThreads?: number
        provider?: string
        debug?: boolean
      },
      bufferSizeInSeconds: number
    )
    acceptWaveform(samples: Float32Array): void
    isEmpty(): boolean
    isDetected(): boolean
    pop(): void
    front(enableExternalBuffer?: boolean): SpeechSegment
    reset(): void
    flush(): void
  }

  export interface DiarizationSegment {
    start: number
    end: number
    speaker: number
  }

  export interface ClusteringConfig {
    numClusters?: number
    threshold?: number
  }

  export class OfflineSpeakerDiarization {
    constructor(config: {
      segmentation: { pyannote: { model: string }; numThreads?: number; debug?: boolean }
      embedding: { model: string; numThreads?: number; debug?: boolean }
      clustering?: ClusteringConfig
      minDurationOn?: number
      minDurationOff?: number
    })
    readonly sampleRate: number
    process(samples: Float32Array): DiarizationSegment[]
    setConfig(config: { clustering: ClusteringConfig }): void
  }

  export interface OnlineStream {
    acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void
    inputFinished(): void
  }

  export class SpeakerEmbeddingExtractor {
    constructor(config: { model: string; numThreads?: number; debug?: boolean })
    readonly dim: number
    createStream(): OnlineStream
    isReady(stream: OnlineStream): boolean
    compute(stream: OnlineStream, enableExternalBuffer?: boolean): Float32Array
  }
}
