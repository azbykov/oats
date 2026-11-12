import type { ChatMessage, ChatRequest, EnhanceRequest, Recipe, Settings, Template } from './types'

// What makes one app built on this code different from another. Each app (apps/<name>) has
// a profile and hands it over before anything else loads; nothing here knows the apps by name.

/** What an app may leave out. A feature that is off has no handlers in the main process and no place in the window. */
export interface ProductFeatures {
  /** Save notes to Notion. */
  notion: boolean
  /** Deepgram as an alternative to local Whisper: sends the audio to their servers. */
  cloudTranscription: boolean
}

export interface Product {
  /** The app's name, as shown in the window, dialogs and texts. */
  name: string
  /** Scheme of the links that bring the app to the front, without "://". */
  protocol: string
  /** Folder under the system's app data that holds downloaded models; apps with the same name share them. */
  modelsFolder: string
  /** What differs from the default settings (common/defaults.ts). */
  settings: Partial<Settings>
  /** Built-in templates and recipes; the user's own are kept in the database. */
  templates: Template[]
  recipes: Recipe[]
  features: ProductFeatures
  /** The Notion database notes are saved to, and the property that holds a note's id. */
  notion: { databaseTitle: string; idProperty: string }
}

/** What is sent to the model: a system prompt and the conversation. */
export interface Prompt {
  system: string
  messages: ChatMessage[]
}

/** How the app words its requests to the model (main process only). */
export interface Prompts {
  enhance(req: EnhanceRequest, settings: Settings): Prompt
  chat(req: ChatRequest, settings: Settings): Prompt
}
