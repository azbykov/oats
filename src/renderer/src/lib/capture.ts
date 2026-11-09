import type { RecordingMeta } from '../../../shared/types'
import { uid } from './store'

const SAMPLE_RATE = 16_000
const CHUNK = SAMPLE_RATE / 10 // 100 ms

/**
 * Converts a MediaStream to 16 kHz mono Int16 PCM in ~100 ms chunks. Used to feed
 * local Whisper and to buffer audio for offline speaker separation.
 */
export class PcmTap {
  private ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
  private node: AudioWorkletNode | null = null
  private listeners = new Set<(pcm: Int16Array) => void>()
  private buf = new Int16Array(CHUNK)
  private len = 0
  readonly ready: Promise<void>

  constructor(stream: MediaStream) {
    this.ready = this.ctx.audioWorklet.addModule('./pcm-recorder.js').then(() => {
      if (this.ctx.state === 'closed') return
      const source = this.ctx.createMediaStreamSource(stream)
      this.node = new AudioWorkletNode(this.ctx, 'pcm-recorder')
      this.node.port.onmessage = (e: MessageEvent<Float32Array>) => this.push(e.data)
      const mute = this.ctx.createGain()
      mute.gain.value = 0
      source.connect(this.node).connect(mute).connect(this.ctx.destination)
    })
  }

  listen(fn: (pcm: Int16Array) => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private push(frame: Float32Array) {
    for (let i = 0; i < frame.length; i++) {
      const v = Math.max(-1, Math.min(1, frame[i]))
      this.buf[this.len++] = v < 0 ? v * 0x8000 : v * 0x7fff
      if (this.len === CHUNK) this.flush()
    }
  }

  private flush() {
    if (!this.len) return
    const chunk = this.buf.slice(0, this.len)
    this.len = 0
    for (const fn of this.listeners) fn(chunk)
  }

  stop() {
    this.flush()
    this.listeners.clear()
    this.node?.disconnect()
    this.ctx.close().catch(() => {})
  }
}

/**
 * Writes one channel to a local WAV in the main process for the length of a
 * session: the source for speaker separation and for recovering the transcript
 * if live transcription fails.
 */
export class ChannelRecorder {
  readonly id = uid()
  private unlisten: (() => void) | null = null
  private bytes = 0

  constructor(
    private tap: PcmTap,
    readonly meta: Omit<RecordingMeta, 'id' | 'startedAt'>
  ) {}

  /** Call when transcription actually starts so both timelines share a zero. */
  start() {
    if (this.unlisten) return
    window.oats.beginRecording({ ...this.meta, id: this.id, startedAt: new Date().toISOString() })
    this.unlisten = this.tap.listen((pcm) => {
      window.oats.appendRecording(this.id, pcm.buffer as ArrayBuffer)
      this.bytes += pcm.byteLength
    })
  }

  /** Stops writing; the file stays until it is removed after processing. */
  async stop() {
    this.unlisten?.()
    this.unlisten = null
    await window.oats.finishRecording(this.id)
  }

  get started() {
    return this.bytes > 0
  }
}

/**
 * The microphone ("Me") as one stream that outlives the device behind it: the
 * input can be switched mid-session (the call moved to another mic, or the
 * device was unplugged) without restarting Deepgram, Whisper or the local copy,
 * which all read `stream`.
 */
export class LiveMic {
  private ctx = new AudioContext()
  private dest = this.ctx.createMediaStreamDestination()
  private raw: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private stopped = false
  readonly stream: MediaStream
  /** undefined: the system default. */
  deviceId: string | undefined
  /** Called with the device label after every switch. */
  onSwitch: ((label: string) => void) | null = null

  private constructor(private constraints: MediaTrackConstraints) {
    this.dest.channelCount = 1
    this.stream = this.dest.stream
  }

  static async open(deviceId: string | undefined, constraints: MediaTrackConstraints) {
    const mic = new LiveMic(constraints)
    try {
      await mic.switchTo(deviceId)
    } catch (err) {
      mic.stop()
      throw err
    }
    return mic
  }

  get label() {
    return this.raw?.getAudioTracks()[0]?.label ?? ''
  }

  async switchTo(deviceId: string | undefined) {
    const raw = await navigator.mediaDevices.getUserMedia({
      audio: { ...this.constraints, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }
    })
    if (this.stopped) {
      raw.getTracks().forEach((t) => t.stop())
      return
    }
    const track = raw.getAudioTracks()[0]
    console.info('Microphone', track?.label, track?.getSettings())
    const source = this.ctx.createMediaStreamSource(raw)
    source.connect(this.dest)
    this.source?.disconnect()
    this.raw?.getTracks().forEach((t) => t.stop())
    this.source = source
    this.raw = raw
    this.deviceId = deviceId
    this.onSwitch?.(track?.label ?? '')
    // Unplugged mid-session: carry on with whatever the system picks next.
    track?.addEventListener('ended', () => {
      if (this.raw !== raw || this.stopped) return
      console.warn('Microphone disconnected; switching to the system default', track.label)
      this.switchTo(undefined).catch((err) => console.warn('No microphone to switch to', err))
    })
    if (this.ctx.state === 'suspended') await this.ctx.resume()
  }

  stop() {
    this.stopped = true
    this.source?.disconnect()
    this.raw?.getTracks().forEach((t) => t.stop())
    this.stream.getTracks().forEach((t) => t.stop())
    this.ctx.close().catch(() => {})
  }
}

/** Input devices other than the "Default"/"Communications" aliases. */
export async function microphones() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
}

/**
 * The device Chromium lists for a Core Audio input. Chromium labels a device by
 * its name (or selected data source) plus a suffix such as "(Built-in)" or
 * "(Bluetooth)"; ids are hashed per origin, so the label is all there is to match.
 */
export function matchMicrophone(devices: MediaDeviceInfo[], inputs: { name: string; source?: string }[]) {
  for (const input of inputs) {
    for (const name of [input.source, input.name]) {
      if (!name) continue
      const device = devices.find((d) => d.label === name || d.label.startsWith(`${name} (`))
      if (device) return device
    }
  }
  return undefined
}
