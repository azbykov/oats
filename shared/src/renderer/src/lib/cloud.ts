import type { Speaker } from '../../../common/types'
import type { ChannelRecorder } from './capture'

// Transcription by a service outside this computer. Nothing here talks to one: an app that
// offers it hands the code over in its entry (apps/<name>/src/renderer/install.ts), next to
// the profile. An app that doesn't never imports that code, so its build has nothing that
// could send audio out, whatever the saved settings say.

export interface CloudChannelOptions {
  speaker: Speaker
  stream: MediaStream
  apiKey: string
  language: string
  noteId: string
  /** Where this session starts on the note's timeline, ms. */
  offset: number
  /** The channel's local copy; started together with the stream so both share a zero. */
  recorder?: ChannelRecorder
  /** Speech was recognised on this channel. */
  onHeard(): void
  /** The connection closed on its own; `reason` is shown to the user. */
  onDropped(reason: string): void
}

export interface CloudChannel {
  /** Lets the service flush its last results, then disconnects. */
  close(): void
}

export interface CloudTranscription {
  open(options: CloudChannelOptions): CloudChannel
}

let installed: CloudTranscription | null = null

export function setCloudTranscription(service: CloudTranscription) {
  installed = service
}

export const cloudTranscription = () => installed
