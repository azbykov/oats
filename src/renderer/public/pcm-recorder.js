// AudioWorklet that forwards mono Float32 frames to the main thread. The owning
// AudioContext runs at 16 kHz, so Chromium has already resampled the input.
class PcmRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0]
    if (channels && channels.length) {
      const frame = new Float32Array(channels[0].length)
      for (const ch of channels) for (let i = 0; i < frame.length; i++) frame[i] += ch[i] / channels.length
      this.port.postMessage(frame, [frame.buffer])
    }
    return true
  }
}
registerProcessor('pcm-recorder', PcmRecorder)
