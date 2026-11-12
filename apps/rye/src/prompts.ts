import type { Prompt, Prompts } from '../../../shared/src/common/product'
import type { ChatRequest, EnhanceRequest, Settings } from '../../../shared/src/common/types'

// What Rye asks of the model. For now the same as Oats (apps/oats/src/prompts.ts): polished
// notes from the user's notes and the transcript, and answers about past conversations.
// Wording for therapy sessions comes with the client and the session templates.

const ENHANCE_SYSTEM = `You are an AI notepad for meetings.
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

function enhance(req: EnhanceRequest, settings: Settings): Prompt {
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

  return { system: ENHANCE_SYSTEM + whoIsMe(settings), messages: [{ role: 'user', content: prompt }] }
}

const CHAT_SYSTEM = `You are the assistant inside an AI meeting notepad.
Answer questions using the meeting notes and transcripts provided in <meetings>. "Me" in a transcript is the user; other speakers appear as "Them", "Speaker N" or by name.
Be direct and concise. Use Markdown (short bullets, bold for key facts). If the answer is not in the meetings, say so plainly.`

const CITATIONS = `
Cite your sources: right after a statement that comes from a meeting, add a Markdown link to it whose URL is meeting://<ref> and whose text is a short form of the meeting title, e.g. "Pricing stays at $20 [Weekly sync](meeting://m3)." Use only refs that appear in <meetings>, and cite each meeting where it supports a point rather than all at the end.`

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

function scopeNote(req: ChatRequest) {
  if (req.scope === 'note') return 'The user is asking about the one meeting below.'
  const total = `the user's ${req.searched} meeting${req.searched === 1 ? '' : 's'}`
  const where = req.scope === 'folder' ? `${total} in the folder "${req.folderName ?? ''}"` : `all ${total}`
  return req.context.length < req.searched
    ? `A search over ${where} picked the ${req.context.length} most relevant to the conversation, best match first; the rest were not included. If the answer may be in a meeting that is not here, say so.`
    : `These are ${where}, best match first.`
}

function chat(req: ChatRequest, settings: Settings): Prompt {
  const meetings = req.context
    .map(
      (m) => `<meeting ref="${m.ref}" title="${attr(m.title)}" date="${m.date}"${m.attendees ? ` people="${attr(m.attendees)}"` : ''}>
<notes>
${m.notesMarkdown.trim()}
</notes>
<transcript${m.excerpt ? ' excerpt="only the passages matching the question"' : ''}>
${m.transcript.trim()}
</transcript>
</meeting>`
    )
    .join('\n')
  const system = `${CHAT_SYSTEM}${req.scope === 'note' ? '' : CITATIONS}${whoIsMe(settings)}
Today is ${req.today}

${scopeNote(req)}
<meetings scope="${req.scope}">
${meetings || '(no meetings yet)'}
</meetings>`
  return { system, messages: req.messages }
}

export const prompts: Prompts = { enhance, chat }
