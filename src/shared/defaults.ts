import type { Recipe, Settings, Template } from './types'

export const DEFAULT_SETTINGS: Settings = {
  aiProvider: 'anthropic',
  anthropicApiKey: '',
  openaiApiKey: '',
  openaiModel: 'gpt-6.1-sol',
  codexModel: '',
  transcriptionProvider: 'whisper',
  whisperModel: 'openai_whisper-large-v3-v20240930_turbo_632MB',
  deepgramApiKey: '',
  model: 'claude-opus-5-5',
  language: 'multi',
  icsUrl: '',
  theme: 'system',
  userName: '',
  captureSystemAudio: true,
  separateSpeakers: true,
  keepAudioBackup: true,
  detectMeetings: true,
  ignoredMeetingApps: []
}

export const BUILT_IN_TEMPLATES: Template[] = [
  {
    id: 'auto',
    title: 'Auto',
    description: 'Picks a structure that fits the conversation',
    builtIn: true,
    sections: []
  },
  {
    id: 'full-recap',
    title: 'Full recap',
    description: 'Every topic in the order it came up, nothing left out',
    builtIn: true,
    sections: [],
    instructions:
      'Recap the whole conversation in chronological order, leaving nothing out — including small talk, side conversations and personal remarks. ' +
      'Start a new "### " section each time the topic changes, with a short heading describing that topic. ' +
      'Under each, list in short bullets what was said and by whom. End with "### Next steps" if any action items came up.'
  },
  {
    id: 'one-on-one',
    title: '1 on 1',
    description: 'Updates, blockers, feedback and next steps',
    builtIn: true,
    sections: [
      { heading: 'Updates', instructions: 'What each person shared since the last 1:1.' },
      { heading: 'Blockers & concerns', instructions: 'Problems raised and any help requested.' },
      { heading: 'Feedback', instructions: 'Feedback given in either direction.' },
      { heading: 'Next steps', instructions: 'Action items with owners.' }
    ]
  },
  {
    id: 'standup',
    title: 'Stand-up',
    description: 'Yesterday, today, blockers per person',
    builtIn: true,
    sections: [
      { heading: 'Progress', instructions: 'Per person: what they finished.' },
      { heading: 'Plans', instructions: 'Per person: what they are working on next.' },
      { heading: 'Blockers', instructions: 'Anything blocking the team.' }
    ]
  },
  {
    id: 'customer-discovery',
    title: 'Customer discovery',
    description: 'Context, pains, current solution, buying signals',
    builtIn: true,
    sections: [
      { heading: 'About them', instructions: 'Company, role, team, context.' },
      { heading: 'Pain points', instructions: 'Problems in their own words, with quotes where useful.' },
      { heading: 'Current solution', instructions: 'Tools and workarounds they use today.' },
      { heading: 'Buying signals & objections', instructions: 'Budget, timeline, decision makers, concerns.' },
      { heading: 'Next steps', instructions: 'Agreed follow-ups.' }
    ]
  },
  {
    id: 'interview',
    title: 'Candidate interview',
    description: 'Background, strengths, concerns, recommendation',
    builtIn: true,
    sections: [
      { heading: 'Background', instructions: 'Experience and relevant history.' },
      { heading: 'Strengths', instructions: 'Evidence-backed strengths.' },
      { heading: 'Concerns', instructions: 'Gaps or red flags.' },
      { heading: 'Questions they asked', instructions: 'Candidate questions.' },
      { heading: 'Overall impression', instructions: 'Summary without a hire decision unless stated.' }
    ]
  },
  {
    id: 'team-meeting',
    title: 'Team meeting',
    description: 'Topics, decisions and action items',
    builtIn: true,
    sections: [
      { heading: 'Topics discussed', instructions: 'One sub-section per topic.' },
      { heading: 'Decisions', instructions: 'What was decided.' },
      { heading: 'Action items', instructions: 'Owner — task — due date if mentioned.' }
    ]
  }
]

export const BUILT_IN_RECIPES: Recipe[] = [
  {
    id: 'action-items',
    slug: 'action-items',
    title: 'List my action items',
    prompt: 'List the action items that are mine, then everyone else\'s, grouped by owner.',
    builtIn: true
  },
  {
    id: 'follow-up',
    slug: 'follow-up-email',
    title: 'Write follow-up email',
    prompt: 'Draft a concise follow-up email to the attendees summarizing decisions and next steps.',
    builtIn: true
  },
  {
    id: 'tldr',
    slug: 'tldr',
    title: 'TL;DR',
    prompt: 'Give me a 3-bullet TL;DR of this meeting.',
    builtIn: true
  },
  {
    id: 'missed',
    slug: 'what-did-i-miss',
    title: 'What did I miss?',
    prompt: 'I joined late or zoned out. What happened in the last part of the conversation?',
    builtIn: true
  },
  {
    id: 'coach',
    slug: 'coach-me',
    title: 'Coach me',
    prompt: 'Based on how I spoke in this meeting, give me candid, specific coaching on what I could do better.',
    builtIn: true
  }
]
