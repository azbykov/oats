import type { AiStreamEvent, ChatRequest, EnhanceRequest } from '../../../shared/types'
import { uid } from './store'

type Handlers = { onDelta: (text: string, full: string) => void }

const listeners = new Map<string, (e: AiStreamEvent) => void>()
let subscribed = false

function subscribe() {
  if (subscribed) return
  subscribed = true
  window.oats.onAiEvent((id, event) => listeners.get(id)?.(event))
}

function runStream(start: (id: string) => void, { onDelta }: Handlers) {
  subscribe()
  const id = uid()
  let full = ''
  const promise = new Promise<string>((resolve, reject) => {
    listeners.set(id, (e) => {
      if (e.type === 'delta') {
        full += e.text
        onDelta(e.text, full)
      } else {
        listeners.delete(id)
        if (e.type === 'done') resolve(e.text)
        else reject(new Error(e.message))
      }
    })
  })
  start(id)
  return { promise, abort: () => window.oats.abortAi(id) }
}

export const streamEnhance = (req: EnhanceRequest, h: Handlers) => runStream((id) => window.oats.enhance(id, req), h)
export const streamChat = (req: ChatRequest, h: Handlers) => runStream((id) => window.oats.chat(id, req), h)
