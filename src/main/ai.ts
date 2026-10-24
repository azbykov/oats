import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { AiStreamEvent, ChatMessage, ChatRequest, EnhanceRequest, Settings } from '../shared/types'

// Notes and chat run on either Claude (Anthropic API) or OpenAI, per Settings → AI.

type Emit = (event: AiStreamEvent) => void

const controllers = new Map<string, AbortController>()

const ENHANCE_SYSTEM = `You are an AI notepad for meetings, like Granola.
The user typed rough notes during a meeting while a transcript was captured.
Your job is to turn their notes into polished meeting notes.

Rules:
- The user's own notes are the skeleton: keep every point they wrote, in their wording where possible, and use them to decide what matters.
- Fill in context, details, numbers, names and decisions from the transcript.
- Output GitHub-flavoured Markdown only: "### " section headings, "- " bullets (nest with two spaces). No title, no preamble, no closing remarks.
- Be concise. Prefer short bullets over prose. Never invent facts that are not in the notes or transcript.
- In the transcript, "Me" is the user. Other people appear as "Them", or as "Speaker N" / a name when speakers were separated; attribute statements to them accordingly.
- Write in the language the meeting was held in, headings included.
- If there is no transcript, just tidy and structure the notes.`

function templateInstructions(req: EnhanceRequest) {
  const { sections, instructions } = req.template
  const parts: string[] = []
  if (instructions?.trim()) parts.push(instructions.trim())
  if (sections.length) {
    const lines = sections.map((s) => `### ${s.heading}\n${s.instructions}`)
    parts.push(`Use exactly these sections, in this order (omit a section only if nothing relevant was said):\n\n${lines.join('\n\n')}`)
  } else if (!instructions?.trim()) {
    parts.push(
      'Choose 2-6 section headings that best fit the main topic of this conversation. Put an "### Next steps" section after them if there are any action items.\n' +
        'Do not silently drop parts of the conversation that are off the main topic (small talk, side remarks, personal matters): summarise them in a few short bullets under a final "### Other topics" section (heading in the meeting language). Omit that section only if nothing else was discussed.'
    )
  }
  return parts.join('\n\n')
}

const whoIsMe = (settings: Settings) =>
  settings.userName.trim() ? `\nThe user's name is ${settings.userName.trim()}; "Me" refers to them.` : ''

export async function enhance(id: string, settings: Settings, req: EnhanceRequest, emit: Emit) {
  const attendees = req.attendees.map((a) => a.name).join(', ') || 'unknown'
  const prompt = `<meeting title="${req.title || 'Untitled'}" date="${req.date}" attendees="${attendees}">
<my_notes>
${req.notesMarkdown.trim() || '(no notes typed)'}
</my_notes>
<transcript>
${req.transcript.trim() || '(no transcript)'}
</transcript>
</meeting>

Template: ${req.template.title}
${templateInstructions(req)}${req.needsTitle ? '\n\nThe meeting has no title yet: start your output with one line "# <short descriptive title>" before the first section.' : ''}`

  await run(id, settings, ENHANCE_SYSTEM + whoIsMe(settings), [{ role: 'user', content: prompt }], emit)
}

const CHAT_SYSTEM = `You are the assistant inside an AI meeting notepad, like Granola.
Answer questions using the meeting notes and transcripts provided in <meetings>. "Me" in a transcript is the user; other speakers appear as "Them", "Speaker N" or by name.
Be direct and concise. Use Markdown (short bullets, bold for key facts). If the answer is not in the meetings, say so plainly.`

export async function chat(id: string, settings: Settings, req: ChatRequest, emit: Emit) {
  const meetings = req.context
    .map(
      (m) => `<meeting title="${m.title || 'Untitled'}" date="${m.date}">
<notes>
${m.notesMarkdown.trim()}
</notes>
<transcript>
${m.transcript.trim()}
</transcript>
</meeting>`
    )
    .join('\n')
  const system = `${CHAT_SYSTEM}${whoIsMe(settings)}\n\n<meetings scope="${req.scope}">\n${meetings || '(no meetings yet)'}\n</meetings>`
  await run(id, settings, system, req.messages, emit)
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
    if (settings.aiProvider === 'openai') await runOpenAI(settings, system, messages, controller.signal, push)
    else await runAnthropic(settings, system, messages, controller.signal, push)
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
