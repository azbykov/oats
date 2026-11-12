import type { Settings, Speaker } from '../../../common/types'
import { cloudTranscription, type CloudChannel } from './cloud'
import { ChannelRecorder, LiveMic, matchMicrophone, microphones, PcmTap } from './capture'
import { isMac } from './platform'
import { localTranscription } from './product'
import { processSession } from './postprocess'
import { uid, useStore } from './store'

// Two audio sources are transcribed: the microphone ("Me") and system output
// ("Them"), with Whisper running locally in the native sidecar (channel 0 = mic,
// 1 = system) or, in an app that offers it, against a cloud service's live API (cloud.ts).

let channels: CloudChannel[] = []
let ownedStreams: MediaStream[] = []
let liveMic: LiveMic | null = null
let taps = new Map<MediaStream, PcmTap>()
let activeLocal = false
/** Local Whisper is still loading its model; the session's audio is queued meanwhile. */
let whisperLoading = false
let whisperSession: { noteId: string; offset: number } | null = null
let audioCtx: AudioContext | null = null
let meterFrame = 0
let sessionStart = 0
let baseOffset = 0
let session: { id: string; noteId: string; offset: number; recorders: ChannelRecorder[]; failed: boolean } | null = null

const CHANNEL: Record<Speaker, number> = { me: 0, them: 1 }

/** When each side was last heard (any recognised speech); auto-stop goes by it. */
const heard: Record<Speaker, number> = { me: 0, them: 0 }
const hearNow = () => {
  heard.me = heard.them = Date.now()
}
/** ms since anyone was heard, counted from the start of the session. */
export const silentFor = (speaker?: Speaker) =>
  Date.now() - (speaker ? heard[speaker] : Math.max(heard.me, heard.them))
const speakerOf = (channel: number): Speaker => (channel === 1 ? 'them' : 'me')

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
    if (ev.text.trim()) heard[speaker] = Date.now()
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

/**
 * Audio is recorded from the start; Whisper gets it once its model is loaded,
 * which can take many minutes when CoreML compiles it for a new oats-audio build.
 * Until then the PCM is queued, so the transcript catches up instead of missing
 * the start of the meeting.
 */
async function startWhisper(noteId: string, streams: { speaker: Speaker; stream: MediaStream }[]) {
  const { settings } = useStore.getState().data!
  subscribeWhisper()
  const words = settings.separateSpeakers && !!session?.recorders.some((r) => r.meta.channel === 'them')
  const queue: [channel: number, pcm: ArrayBuffer][] = []
  let connected = false
  for (const { speaker, stream } of streams) {
    const tap = tapFor(stream)
    await tap.ready
    const ch = CHANNEL[speaker]
    tap.listen((pcm) => {
      if (connected) window.oats.sendWhisperFrame(1, ch, pcm.buffer as ArrayBuffer)
      else queue.push([ch, pcm.buffer as ArrayBuffer])
    })
  }
  session?.recorders.forEach((r) => r.start())
  whisperLoading = true
  const current = session
  const offset = baseOffset
  // Resuming with the listener still running is instant; only a real load gets the notice.
  const loaded = await window.oats.whisperLoaded(settings.whisperModel, settings.language, words)
  if (session !== current || !whisperLoading) return
  useStore.getState().setRecording({ status: 'recording', loadingModel: !loaded })

  window.oats
    .startWhisper(settings.whisperModel, settings.language, words)
    .then(() => {
      // Paused (or restarted) while the model loaded: the recording is re-transcribed instead.
      if (session !== current || !whisperLoading) return
      whisperLoading = false
      // Loading time isn't silence: the queued audio is about to be heard.
      hearNow()
      whisperSession = { noteId, offset }
      for (const { speaker } of streams) window.oats.sendWhisperFrame(2, CHANNEL[speaker])
      for (const [ch, pcm] of queue) window.oats.sendWhisperFrame(1, ch, pcm)
      queue.length = 0
      connected = true
      useStore.getState().setRecording({ loadingModel: false })
    })
    .catch((err: Error) => {
      if (session !== current) return
      stopTranscription()
      useStore.getState().setRecording({ noteId, status: 'error', error: err.message, loadingModel: false })
    })
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

/** The device to record "Me" from; undefined is the system default. */
async function chosenMic(settings: Settings): Promise<string | undefined> {
  if (settings.micSource === 'system') return undefined
  const devices = await microphones()
  if (settings.micSource === 'device') {
    const device = devices.find((d) => d.label === settings.micLabel)
    if (!device) console.warn('The chosen microphone is not connected; using the system default', settings.micLabel)
    return device?.deviceId
  }
  // Plugging in a headset makes it the system default, while the call may well
  // stay on another mic: record the one the call actually uses.
  const device = matchMicrophone(devices, await window.oats.callMicInputs())
  if (device) console.info('Recording from the call’s microphone', device.label)
  return device?.deviceId
}

let callMicSubscribed = false

/** Keeps "Me" on the call's microphone when the call switches devices mid-session. */
function followCallMic() {
  window.oats.followCallMic(true)
  if (callMicSubscribed) return
  callMicSubscribed = true
  window.oats.onCallMicInputs(async (inputs) => {
    const mic = liveMic
    if (!mic || useStore.getState().data?.settings.micSource !== 'call') return
    const device = matchMicrophone(await microphones(), inputs)
    if (!device || mic !== liveMic || device.deviceId === mic.deviceId || device.label === mic.label) return
    console.info('The call switched microphones; following it to', device.label)
    mic.switchTo(device.deviceId).catch((err) => console.warn('Could not switch microphones', err))
  })
}

/**
 * Audio settings changed mid-session (in Settings or the note's audio menu): the
 * microphone switches in place; system audio adds or drops a channel, which takes
 * a restart, the same as pause and resume.
 */
async function applyAudioSettings(now: Settings, before: Settings) {
  const { recording } = useStore.getState()
  if (recording.status !== 'recording' || !recording.noteId) return
  if (now.captureSystemAudio !== before.captureSystemAudio) {
    stopTranscription()
    await startTranscription(recording.noteId)
    return
  }
  if (now.micSource === before.micSource && now.micLabel === before.micLabel) return
  const mic = liveMic
  if (!mic) return
  if (now.micSource === 'call') followCallMic()
  else window.oats.followCallMic(false)
  const deviceId = await chosenMic(now)
  if (mic !== liveMic || deviceId === mic.deviceId) return
  await mic.switchTo(deviceId).catch((err) => console.warn('Could not switch microphones', err))
}

useStore.subscribe((state, prev) => {
  const now = state.data?.settings
  const before = prev.data?.settings
  if (now && before && now !== before) void applyAudioSettings(now, before)
})

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
  const {
    deepgramApiKey,
    language,
    captureSystemAudio,
    separateSpeakers,
    keepAudioBackup,
    micSource
  } = data.settings
  const cloud = localTranscription(data.settings) ? null : cloudTranscription()
  const local = !cloud
  if (cloud && !deepgramApiKey) {
    setRecording({ noteId, status: 'error', error: 'Add a Deepgram API key in Settings → Transcription.' })
    return
  }
  if (channels.length || taps.size) stopTranscription()
  // Start watching early: the call's device is needed once the mic opens.
  if (micSource === 'call') followCallMic()
  activeLocal = local
  setRecording({ noteId, status: 'starting', error: undefined, systemAudio: false, loadingModel: false, autoStopped: undefined })

  const note = data.notes.find((n) => n.id === noteId)
  // Continue after everything recorded so far, not after the last phrase Whisper
  // had finished: it can be minutes behind when the session stops.
  baseOffset = Math.max(note?.recordedMs ?? 0, note?.transcript.at(-1)?.end ?? 0)
  sessionStart = Date.now()
  hearNow()

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
    liveMic = await LiveMic.open(await chosenMic(data.settings), micConstraints(captureSystemAudio))
    setRecording({ micLabel: liveMic.label })
    liveMic.onSwitch = (label) => useStore.getState().setRecording({ micLabel: label })
    const mic = liveMic.stream
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
    if (cloud) {
      for (const { speaker, stream } of streams) {
        channels.push(
          cloud.open({
            speaker,
            stream,
            apiKey: deepgramApiKey,
            language,
            noteId,
            offset: baseOffset,
            recorder: recorderFor(speaker),
            onHeard: () => (heard[speaker] = Date.now()),
            onDropped: (reason) => {
              markFailed()
              stopTranscription()
              useStore.getState().setRecording({ status: 'error', error: reason })
            }
          })
        )
      }
    } else {
      await startWhisper(noteId, streams)
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
  // Whisper never heard this session: the local copy is transcribed after it ends.
  if (whisperLoading) markFailed()
  whisperLoading = false
  const ended = session
  session = null
  if (local) {
    window.oats.sendWhisperFrame(3, CHANNEL.me)
    window.oats.sendWhisperFrame(3, CHANNEL.them)
  }
  taps.forEach((t) => t.stop()) // flushes the last chunk to recorders
  taps = new Map()
  if (ended) {
    const end = elapsedMs()
    useStore.getState().updateNote(ended.noteId, { recordedMs: end })
    // Local Whisper finalises the last utterance a little later than Deepgram.
    processSession({ ...ended, end, settleMs: local ? 5000 : 2000 })
  }
  for (const c of channels) c.close()
  channels = []
  ownedStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
  ownedStreams = []
  liveMic?.stop()
  liveMic = null
  window.oats.followCallMic(false)
  cancelAnimationFrame(meterFrame)
  audioCtx?.close()
  audioCtx = null
  const { setRecording, setLevel, setPartial, recording } = useStore.getState()
  setLevel(0)
  setPartial('me', '')
  setPartial('them', '')
  if (recording.status !== 'error') setRecording({ status: recording.noteId ? 'paused' : 'idle', loadingModel: false })
}

/** Stops on its own (call ended, long silence, sleep); the note says why until resumed. */
export function autoStop(reason: string) {
  const { recording, setRecording } = useStore.getState()
  if (recording.status !== 'recording' && recording.status !== 'starting') return
  stopTranscription()
  setRecording({ autoStopped: reason })
}

export function elapsedMs() {
  return sessionStart ? Date.now() - sessionStart + baseOffset : 0
}
