import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { ChatMessage, CliStatus, Settings } from '../shared/types'

// Runs notes and chat through the user's own Claude Code or Codex CLI, so they bill to the
// subscription the CLI is signed in with instead of an API key. Each request is one
// non-interactive run with no tools, from an empty temp folder.

export type CliKind = 'claude' | 'codex'

const SIGN_IN = {
  claude: 'Sign in to Claude Code: run "claude" in Terminal and log in with your Claude subscription.',
  codex: 'Sign in to Codex: run "codex login" in Terminal and choose Sign in with ChatGPT.'
}
const NOT_FOUND = {
  claude: 'Claude Code CLI not found. Install it from claude.com/claude-code, then sign in.',
  codex: 'Codex CLI not found. Install it with "npm i -g @openai/codex", then run "codex login".'
}

let pathPromise: Promise<string> | undefined

/**
 * GUI apps on macOS start with a bare PATH, so ask the login shell for the one the user has
 * in Terminal: that is where claude / codex (and the node that runs codex) live.
 */
function shellPath(): Promise<string> {
  const fallback = process.env.PATH ?? ''
  if (process.platform === 'win32') return Promise.resolve(fallback)
  pathPromise ??= new Promise((resolve) => {
    const marker = '__OATS_PATH__'
    execFile(
      process.env.SHELL || '/bin/zsh',
      ['-ilc', `printf '${marker}%s${marker}' "$PATH"`],
      { timeout: 5000 },
      (_err, stdout) => resolve(stdout?.split(marker)[1] || fallback)
    )
  })
  return pathPromise
}

async function cliEnv() {
  return { ...process.env, PATH: await shellPath() }
}

// npm installs .cmd shims on Windows, which only run through the shell.
const quote = (arg: string) => (process.platform === 'win32' ? `"${arg.replace(/"/g, '""')}"` : arg)

function spawnCli(kind: CliKind, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const win = process.platform === 'win32'
  return spawn(kind, win ? args.map(quote) : args, { cwd, env, shell: win, windowsHide: true })
}

/** Past turns go in as a transcript, since each run is a fresh one-shot session. */
function promptFrom(messages: ChatMessage[]) {
  if (messages.length === 1) return messages[0].content
  const turns = messages.map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`).join('\n')
  return `<conversation>\n${turns}\n</conversation>\n\nReply to the last user message.`
}

export async function runCli(
  kind: CliKind,
  settings: Settings,
  system: string,
  messages: ChatMessage[],
  signal: AbortSignal,
  push: (delta: string) => void
) {
  const dir = await mkdtemp(join(tmpdir(), 'oats-ai-'))
  try {
    if (kind === 'claude') await runClaude(dir, settings, system, messages, signal, push)
    else await runCodex(dir, settings, system, messages, signal, push)
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function runClaude(
  dir: string,
  { model }: Settings,
  system: string,
  messages: ChatMessage[],
  signal: AbortSignal,
  push: (delta: string) => void
) {
  // A file, because the chat system prompt carries every meeting and can outgrow argv.
  const systemFile = join(dir, 'system.md')
  await writeFile(systemFile, system)
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--system-prompt-file', systemFile,
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--no-session-persistence',
    '--model', claudeAlias(model)
  ]
  let streamed = false
  let failure: string | undefined
  const exitError = await runLines('claude', args, promptFrom(messages), dir, signal, (event) => {
    if (event.type === 'stream_event' && event.event?.type === 'content_block_delta') {
      const delta = event.event.delta
      if (delta?.type === 'text_delta' && delta.text) {
        streamed = true
        push(delta.text)
      }
    } else if (event.type === 'result') {
      if (event.is_error) failure = String(event.result || 'Claude Code failed.')
      else if (!streamed && event.result) push(String(event.result))
    }
  })
  if (failure) throw new Error(/authenticat|log ?in|oauth/i.test(failure) ? `${failure}. ${SIGN_IN.claude}` : failure)
  if (exitError) throw new Error(exitError)
}

/** The CLI knows its models by family alias ("opus"), which follows the latest release. */
function claudeAlias(model: string) {
  return /^claude-(opus|sonnet|haiku|fable)-/.exec(model)?.[1] ?? model
}

async function runCodex(
  dir: string,
  { codexModel }: Settings,
  system: string,
  messages: ChatMessage[],
  signal: AbortSignal,
  push: (delta: string) => void
) {
  const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '-s', 'read-only']
  if (codexModel) args.push('-m', codexModel)
  args.push('-')
  // codex exec has no system prompt option, so the instructions lead the prompt.
  const prompt = `<instructions>\n${system}\n</instructions>\n\n${promptFrom(messages)}`
  let text = ''
  let failure: string | undefined
  const exitError = await runLines('codex', args, prompt, dir, signal, (event) => {
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
      const delta = (text ? '\n\n' : '') + event.item.text
      text += delta
      push(delta)
    } else if (event.type === 'turn.failed' || event.type === 'error') {
      failure = codexError(event.error?.message ?? event.message)
    }
  })
  if (failure) throw new Error(/401|unauthori|log ?in/i.test(failure) ? `${failure} ${SIGN_IN.codex}` : failure)
  if (exitError) throw new Error(exitError)
}

/** Codex wraps API errors as a JSON string; pull out the readable message. */
function codexError(raw: unknown) {
  const message = String(raw ?? 'Codex failed.')
  try {
    return JSON.parse(message).error?.message ?? message
  } catch {
    return message
  }
}

/**
 * Spawns the CLI, writes the prompt to stdin and hands each JSON line of stdout to `onEvent`.
 * Resolves with stderr's last line when the CLI exits with an error; callers prefer the error
 * its events reported, since stderr also carries warnings.
 */
async function runLines(
  kind: CliKind,
  args: string[],
  input: string,
  cwd: string,
  signal: AbortSignal,
  onEvent: (event: any) => void
): Promise<string | undefined> {
  const child = spawnCli(kind, args, await cliEnv(), cwd)
  const kill = () => child.kill()
  signal.addEventListener('abort', kill)
  let stderr = ''
  child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-4000)))
  child.stdin.on('error', () => {})
  child.stdin.end(input)
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', (err: NodeJS.ErrnoException) =>
      reject(err.code === 'ENOENT' ? new Error(NOT_FOUND[kind]) : err)
    )
    child.on('close', resolve)
  })
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      if (!line.startsWith('{')) continue
      try {
        onEvent(JSON.parse(line))
      } catch {
        // Not an event line.
      }
    }
    const code = await exited
    if (code && !signal.aborted) return stderr.trim().split('\n').pop() || `${kind} exited with code ${code}.`
  } finally {
    signal.removeEventListener('abort', kill)
  }
}

/** Whether the CLI is installed and signed in, for Settings → AI. */
export async function cliStatus(kind: CliKind): Promise<CliStatus> {
  const env = await cliEnv()
  const args = kind === 'claude' ? ['auth', 'status'] : ['login', 'status']
  return new Promise((resolve) => {
    const child = spawnCli(kind, args, env, tmpdir())
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (out += chunk))
    child.on('error', (err: NodeJS.ErrnoException) =>
      resolve({ ok: false, message: err.code === 'ENOENT' ? NOT_FOUND[kind] : err.message })
    )
    child.on('close', (code) => {
      if (kind === 'claude') {
        try {
          const status = JSON.parse(out)
          if (status.loggedIn) {
            const plan = status.subscriptionType ? ` (${status.subscriptionType})` : ''
            return resolve({ ok: true, detail: `Signed in${status.email ? ` as ${status.email}` : ''}${plan}` })
          }
        } catch {
          // Older versions print text; fall through to the exit code.
        }
      }
      if (code === 0) resolve({ ok: true, detail: out.trim().split('\n').pop() || 'Signed in' })
      else resolve({ ok: false, message: SIGN_IN[kind] })
    })
  })
}
