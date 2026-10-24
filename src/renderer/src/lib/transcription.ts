import type { Speaker } from '../../../shared/types'
import { ChannelRecorder, PcmTap } from './capture'
import { isMac } from './platform'
import { processSession } from './postprocess'
import { uid, useStore } from './store'

// Granola streams two audio sources to its transcription backend (Deepgram /
// AssemblyAI behind api.granola.ai): the microphone ("Me") and system output
// ("Them"). The clone does the same either against Deepgram's live API or with
// Whisper running locally in the native sidecar (channel 0 = mic, 1 = system).

interface Channel {
  speaker: Speaker
  stream: MediaStream
  ws: WebSocket
  recorder: MediaRecorder | null
  keepAlive: number
  closing: boolean
}

let channels: Channel[] = []
let ownedStreams: MediaStream[] = []
let taps = new Map<MediaStream, PcmTap>()
let activeLocal = false
let whisperSession: { noteId: string; offset: number } | null = null
let audioCtx: AudioContext | null = null
let meterFrame = 0
let sessionStart = 0
let baseOffset = 0
let session: { id: string; noteId: string; offset: number; recorders: ChannelRecorder[]; failed: boolean } | null = null

const CHANNEL: Record<Speaker, number> = { me: 0, them: 1 }
const speakerOf = (channel: number): Speaker => (channel === 1 ? 'them' : 'me')

// ---- Deepgram ----

function listenUrl(language: string) {
  const params = new URLSearchParams({
    model: 'nova-3',
    language: language || 'multi',
    smart_format: 'true',
    punctuate: 'true',
    interim_results: 'true',
    endpointing: '300'
  })
  return `wss://api.deepgram.com/v1/listen?${params}`
}

function openChannel(
  speaker: Speaker,
  stream: MediaStream,
  apiKey: string,
  language: string,
  noteId: string,
  rec?: ChannelRecorder
) {
  const ws = new WebSocket(listenUrl(language), ['token', apiKey])
  const channel: Channel = { speaker, stream, ws, recorder: null, keepAlive: 0, closing: false }
  const { appendTranscript, setPartial, setRecording } = useStore.getState()

  ws.onopen = () => {
    const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) ws.send(e.data)
    }
    recorder.start(250)
    rec?.start()
    channel.recorder = recorder
    channel.keepAlive = window.setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }))
    }, 8000)
    setRecording({ status: 'recording' })
  }

  ws.onmessage = (msg) => {
    const data = JSON.parse(String(msg.data))
    if (data.type !== 'Results') return
    const text: string = data.channel?.alternatives?.[0]?.transcript ?? ''
    if (data.is_final) {
      setPartial(speaker, '')
      if (text.trim()) {
        const words: { punctuated_word?: string; word: string; start: number; end: number }[] =
          data.channel.alternatives[0].words ?? []
        appendTranscript(noteId, {
          id: uid(),
          speaker,
          text: text.trim(),
          start: baseOffset + Math.round(data.start * 1000),
          end: baseOffset + Math.round((data.start + data.duration) * 1000),
          words: words.map((w) => ({
            text: w.punctuated_word ?? w.word,
            start: baseOffset + Math.round(w.start * 1000),
            end: baseOffset + Math.round(w.end * 1000)
          }))
        })
      }
    } else {
      setPartial(speaker, text)
    }
  }

  ws.onclose = (e) => {
    window.clearInterval(channel.keepAlive)
    if (channel.recorder?.state === 'recording') channel.recorder.stop()
    if (!channel.closing) {
      const reason =
        e.code === 1008 || e.code === 4001 ? 'Deepgram rejected the API key.' : `Transcription disconnected (${e.code}).`
      markFailed()
      stopTranscription()
      useStore.getState().setRecording({ status: 'error', error: reason })
    }
  }
  return channel
}

// ---- Local Whisper ----

let whisperSubscribed = false

function subscribeWhisper() {
  if (whisperSubscribed) return
  whisperSubscribed = true
  window.oats.onWhisperEvent((ev) => {
    const { appendTranscript, setPartial, setRecording } = useStore.getState()
    if (ev.type === 'error') {
      markFailed()
      stopTranscription()
      setRecording({ status: 'error', error: ev.message })
      return
    }
    // Finals can arrive shortly after the user pauses; they still belong to that session.
    const session = whisperSession
    if (!session) return
    const speaker = speakerOf(ev.channel)
    if (ev.type === 'partial') {
      if (taps.size) setPartial(speaker, ev.text)
      return
    }
    setPartial(speaker, '')
    if (ev.text.trim()) {
      appendTranscript(session.noteId, {
        id: uid(),
        speaker,
        text: ev.text.trim(),
        start: session.offset + ev.startMs,
        end: session.offset + ev.endMs,
        words: ev.words?.map((w) => ({ text: w.w.trim(), start: session.offset + w.s, end: session.offset + w.e }))
      })
    }
  })
}

async function startWhisper(noteId: string, streams: { speaker: Speaker; stream: MediaStream }[]) {
  const { settings } = useStore.getState().data!
  subscribeWhisper()
  const words = settings.separateSpeakers && !!session?.recorders.some((r) => r.meta.channel === 'them')
  await window.oats.startWhisper(settings.whisperModel, settings.language, words)
  whisperSession = { noteId, offset: baseOffset }
  for (const { speaker, stream } of streams) {
    const tap = tapFor(stream)
    await tap.ready
    const ch = CHANNEL[speaker]
    window.oats.sendWhisperFrame(2, ch)
    tap.listen((pcm) => window.oats.sendWhisperFrame(1, ch, pcm.buffer as ArrayBuffer))
  }
  session?.recorders.forEach((r) => r.start())
  useStore.getState().setRecording({ status: 'recording' })
}

// ---- shared ----

/**
 * No noise suppression (Whisper and Deepgram handle noise better on their own), but
 * automatic gain stays on: a raw built-in MacBook mic is too quiet for reliable
 * speech detection. When system audio is captured, echoCancellation "all" asks Chromium to
 * cancel everything the computer plays, not just this page's audio, so the other side
 * of a call heard through speakers doesn't end up in "Me" (Notion does the same).
 */
function micConstraints(cancelSystemAudio: boolean): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: true,
    channelCount: 1
  }
  if (cancelSystemAudio) Reflect.set(constraints, 'echoCancellation', 'all')
  return constraints
}

/** One PCM tap per stream, shared by local Whisper and speaker separation. */
function tapFor(stream: MediaStream) {
  let tap = taps.get(stream)
  if (!tap) {
    tap = new PcmTap(stream)
    taps.set(stream, tap)
  }
  return tap
}

function startMeter(streams: MediaStream[]) {
  audioCtx = new AudioContext()
  const analyser = audioCtx.createAnalyser()
  analyser.fftSize = 512
  for (const s of streams) audioCtx.createMediaStreamSource(s).connect(analyser)
  const buf = new Uint8Array(analyser.fftSize)
  let last = 0
  const tick = (t: number) => {
    meterFrame = requestAnimationFrame(tick)
    if (t - last < 60) return
    last = t
    analyser.getByteTimeDomainData(buf)
    let sum = 0
    for (const v of buf) sum += ((v - 128) / 128) ** 2
    useStore.getState().setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4))
  }
  meterFrame = requestAnimationFrame(tick)
}

async function systemAudio(): Promise<MediaStream | null> {
  try {
    // With Core Audio Tap or Windows loopback an audio-only request is enough;
    // ScreenCaptureKit needs a screen too.
    const mode = await window.oats.getSystemAudioMode()
    const display = await navigator.mediaDevices.getDisplayMedia(
      mode === 'screen'
        ? { video: true, audio: true }
        : ({ video: false, audio: true, systemAudio: 'include' } as DisplayMediaStreamOptions)
    )
    ownedStreams.push(display)
    display.getVideoTracks().forEach((t) => t.stop())
    return display.getAudioTracks().length ? new MediaStream(display.getAudioTracks()) : null
  } catch (err) {
    console.warn('System audio unavailable; transcribing microphone only', err)
    return null
  }
}

export async function startTranscription(noteId: string) {
  const { data, setRecording } = useStore.getState()
  if (!data) return
  const { transcriptionProvider, deepgramApiKey, language, captureSystemAudio, separateSpeakers, keepAudioBackup } =
    data.settings
  const local = transcriptionProvider === 'whisper'
  if (!local && !deepgramApiKey) {
    setRecording({ noteId, status: 'error', error: 'Add a Deepgram API key in Settings → Transcription.' })
    return
  }
  if (channels.length || taps.size) stopTranscription()
  activeLocal = local
  setRecording({ noteId, status: 'starting', error: undefined, systemAudio: false })

  const note = data.notes.find((n) => n.id === noteId)
  baseOffset = note?.transcript.at(-1)?.end ?? 0
  sessionStart = Date.now()

  try {
    // Ask for anything macOS hasn't asked about yet; a denied permission opens System (or Windows) Settings.
    const perms = await window.oats.getPermissions()
    if (perms.microphone !== 'granted' && (await window.oats.requestPermission('microphone')) !== 'granted') {
      throw new Error(
        isMac
          ? 'Microphone access is off. Allow it in System Settings → Privacy → Microphone.'
          : 'Microphone access is off. Allow it in Windows Settings → Privacy & security → Microphone.'
      )
    }
    let systemAllowed = captureSystemAudio && perms.systemAudio !== 'denied'
    if (captureSystemAudio && perms.systemAudio === 'not-determined') {
      systemAllowed = (await window.oats.requestPermission('systemAudio')) === 'granted'
    }
    const mic = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(captureSystemAudio) })
    ownedStreams.push(mic)
    console.info('Microphone settings', mic.getAudioTracks()[0]?.getSettings())
    const system = systemAllowed ? await systemAudio() : null

    // Local copies feed speaker separation and let a failed session be re-transcribed.
    session = { id: uid(), noteId, offset: baseOffset, recorders: [], failed: false }
    if (await window.oats.nativeAudioAvailable()) {
      const record = (channel: Speaker, stream: MediaStream) =>
        session!.recorders.push(
          new ChannelRecorder(tapFor(stream), { sessionId: session!.id, noteId, channel, offset: baseOffset })
        )
      if (keepAudioBackup) record('me', mic)
      if (system && (keepAudioBackup || separateSpeakers)) record('them', system)
    }
    const recorderFor = (channel: Speaker) => session!.recorders.find((r) => r.meta.channel === channel)

    const streams: { speaker: Speaker; stream: MediaStream }[] = [{ speaker: 'me', stream: mic }]
    if (system) streams.push({ speaker: 'them', stream: system })
    if (local) {
      await startWhisper(noteId, streams)
    } else {
      for (const { speaker, stream } of streams) {
        channels.push(openChannel(speaker, stream, deepgramApiKey, language, noteId, recorderFor(speaker)))
      }
    }
    setRecording({ systemAudio: !!system })
    startMeter(system ? [mic, system] : [mic])
  } catch (err) {
    stopTranscription()
    setRecording({ noteId, status: 'error', error: err instanceof Error ? err.message : String(err) })
  }
}

/** Live transcription broke mid-session; the local copy will be re-transcribed. */
function markFailed() {
  if (session) session.failed = true
}

export function stopTranscription() {
  const local = activeLocal
  activeLocal = false
  const ended = session
  session = null
  if (local) {
    window.oats.sendWhisperFrame(3, CHANNEL.me)
    window.oats.sendWhisperFrame(3, CHANNEL.them)
  }
  taps.forEach((t) => t.stop()) // flushes the last chunk to recorders
  taps = new Map()
  if (ended) {
    // Local Whisper finalises the last utterance a little later than Deepgram.
    processSession({ ...ended, end: elapsedMs(), settleMs: local ? 5000 : 2000 })
  }
  for (const c of channels) {
    c.closing = true
    window.clearInterval(c.keepAlive)
    if (c.recorder?.state === 'recording') c.recorder.stop()
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ type: 'CloseStream' }))
    // Give Deepgram a moment to flush the final results before closing.
    window.setTimeout(() => c.ws.close(), 1500)
  }
  channels = []
  ownedStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
  ownedStreams = []
  cancelAnimationFrame(meterFrame)
  audioCtx?.close()
  audioCtx = null
  const { setRecording, setLevel, setPartial, recording } = useStore.getState()
  setLevel(0)
  setPartial('me', '')
  setPartial('them', '')
  if (recording.status !== 'error') setRecording({ status: recording.noteId ? 'paused' : 'idle' })
}

export function elapsedMs() {
  return sessionStart ? Date.now() - sessionStart + baseOffset : 0
}
