import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { AiStreamEvent, ChatMessage, ChatRequest, EnhanceRequest, Settings } from '../common/types'
import { runCli } from './ai-cli'
import { product } from './product'

// Notes and chat run on Claude (Anthropic API), OpenAI, or the user's Claude Code / Codex CLI,
// per Settings → AI. What is asked of the model is the app's own (Product.prompts); every
// request goes out through run().

type Emit = (event: AiStreamEvent) => void

const controllers = new Map<string, AbortController>()

export async function enhance(id: string, settings: Settings, req: EnhanceRequest, emit: Emit) {
  const { system, messages } = product.prompts.enhance(req, settings)
  await run(id, settings, system, messages, emit)
}

export async function chat(id: string, settings: Settings, req: ChatRequest, emit: Emit) {
  const { system, messages } = product.prompts.chat(req, settings)
  await run(id, settings, system, messages, emit)
}

async function run(id: string, settings: Settings, system: string, messages: ChatMessage[], emit: Emit) {
  const controller = new AbortController()
  controllers.set(id, controller)
  const out = { text: '' }
  const push = (delta: string) => {
    out.text += delta
    emit({ type: 'delta', text: delta })
  }
  try {
    const { signal } = controller
    if (settings.aiProvider === 'openai') await runOpenAI(settings, system, messages, signal, push)
    else if (settings.aiProvider === 'claude-cli') await runCli('claude', settings, system, messages, signal, push)
    else if (settings.aiProvider === 'codex-cli') await runCli('codex', settings, system, messages, signal, push)
    else await runAnthropic(settings, system, messages, signal, push)
    emit({ type: 'done', text: out.text })
  } catch (err) {
    if (controller.signal.aborted) emit({ type: 'done', text: out.text })
    else emit({ type: 'error', message: describeError(err) })
  } finally {
    controllers.delete(id)
  }
}

function describeError(err: unknown) {
  if (err instanceof Anthropic.AuthenticationError) return 'Invalid Anthropic API key. Check Settings → AI.'
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by the Anthropic API. Try again in a moment.'
  if (err instanceof Anthropic.APIError) return err.message
  if (err instanceof OpenAI.AuthenticationError) return 'Invalid OpenAI API key. Check Settings → AI.'
  if (err instanceof OpenAI.RateLimitError) return 'Rate limited by the OpenAI API. Try again in a moment.'
  if (err instanceof OpenAI.NotFoundError) return 'This OpenAI model is not available for your key. Pick another in Settings → AI.'
  if (err instanceof OpenAI.APIError) return err.message
  return err instanceof Error ? err.message : String(err)
}

async function runAnthropic(
  { anthropicApiKey, model }: Settings,
  system: string,
  messages: ChatMessage[],
  signal: AbortSignal,
  push: (delta: string) => void
) {
  if (!anthropicApiKey) throw new Error('Add your Anthropic API key in Settings → AI.')
  const client = new Anthropic({ apiKey: anthropicApiKey })
  let text = ''
  const stream = client.beta.messages.stream(
    {
      model,
      max_tokens: 64000,
      output_config: { effort: 'medium' },
      // On a safety decline, the API re-runs the request on a fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content }))
    },
    { signal }
  )
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text
      push(event.delta.text)
    }
  }
  const final = await stream.finalMessage()
  if (final.stop_reason === 'refusal' && !text) throw new Error('The model declined this request.')
}

async function runOpenAI(
  { openaiApiKey, openaiModel }: Settings,
  system: string,
  messages: ChatMessage[],
  signal: AbortSignal,
  push: (delta: string) => void
) {
  if (!openaiApiKey) throw new Error('Add your OpenAI API key in Settings → AI.')
  const client = new OpenAI({ apiKey: openaiApiKey })
  const stream = await client.chat.completions.create(
    {
      model: openaiModel,
      stream: true,
      messages: [
        { role: 'developer', content: system },
        ...messages.map((m) => ({ role: m.role, content: m.content }))
      ]
    },
    { signal }
  )
  let text = ''
  for await (const chunk of stream) {
    const choice = chunk.choices[0]
    const delta = choice?.delta?.content
    if (delta) {
      text += delta
      push(delta)
    }
    if (choice?.finish_reason === 'content_filter' && !text) throw new Error('The model declined this request.')
  }
}

/** Chat-capable models available to this OpenAI key, newest first. */
export async function listOpenAIModels(apiKey: string): Promise<string[]> {
  if (!apiKey) return []
  const client = new OpenAI({ apiKey })
  const ids: { id: string; created: number }[] = []
  for await (const m of client.models.list()) ids.push({ id: m.id, created: m.created })
  return ids
    .filter(({ id }) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|embedding)/.test(id))
    .sort((a, b) => b.created - a.created)
    .map(({ id }) => id)
}

export function abort(id: string) {
  controllers.get(id)?.abort()
}
