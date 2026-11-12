import type { CloudChannel, CloudChannelOptions, CloudTranscription } from './cloud'
import { uid, useStore } from './store'

// Deepgram's live API: one WebSocket per channel, the audio streamed to their servers as it
// is captured. The only code that sends audio off this computer; only an app that offers
// cloud transcription imports it (see cloud.ts).

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

function open({
  speaker,
  stream,
  apiKey,
  language,
  noteId,
  offset,
  recorder: rec,
  onHeard,
  onDropped
}: CloudChannelOptions): CloudChannel {
  const ws = new WebSocket(listenUrl(language), ['token', apiKey])
  let recorder: MediaRecorder | null = null
  let keepAlive = 0
  let closing = false
  const { appendTranscript, setPartial, setRecording } = useStore.getState()

  ws.onopen = () => {
    recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) ws.send(e.data)
    }
    recorder.start(250)
    rec?.start()
    keepAlive = window.setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }))
    }, 8000)
    setRecording({ status: 'recording' })
  }

  ws.onmessage = (msg) => {
    const data = JSON.parse(String(msg.data))
    if (data.type !== 'Results') return
    const text: string = data.channel?.alternatives?.[0]?.transcript ?? ''
    if (text.trim()) onHeard()
    if (data.is_final) {
      setPartial(speaker, '')
      if (text.trim()) {
        const words: { punctuated_word?: string; word: string; start: number; end: number }[] =
          data.channel.alternatives[0].words ?? []
        appendTranscript(noteId, {
          id: uid(),
          speaker,
          text: text.trim(),
          start: offset + Math.round(data.start * 1000),
          end: offset + Math.round((data.start + data.duration) * 1000),
          words: words.map((w) => ({
            text: w.punctuated_word ?? w.word,
            start: offset + Math.round(w.start * 1000),
            end: offset + Math.round(w.end * 1000)
          }))
        })
      }
    } else {
      setPartial(speaker, text)
    }
  }

  ws.onclose = (e) => {
    window.clearInterval(keepAlive)
    if (recorder?.state === 'recording') recorder.stop()
    if (!closing)
      onDropped(
        e.code === 1008 || e.code === 4001 ? 'Deepgram rejected the API key.' : `Transcription disconnected (${e.code}).`
      )
  }

  return {
    close() {
      closing = true
      window.clearInterval(keepAlive)
      if (recorder?.state === 'recording') recorder.stop()
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }))
      // Give Deepgram a moment to flush the final results before closing.
      window.setTimeout(() => ws.close(), 1500)
    }
  }
}

export const deepgram: CloudTranscription = { open }
