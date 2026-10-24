import { marked } from 'marked'
import TurndownService from 'turndown'

const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' })
turndown.addRule('taskItem', {
  filter: (node) => node.nodeName === 'LI' && node.getAttribute('data-type') === 'taskItem',
  replacement: (content, node) => {
    const checked = (node as HTMLElement).getAttribute('data-checked') === 'true'
    return `- [${checked ? 'x' : ' '}] ${content.trim()}\n`
  }
})

export const htmlToMarkdown = (html: string) => (html ? turndown.turndown(html) : '')

export const markdownToHtml = (md: string) => marked.parse(md, { async: false, gfm: true, breaks: false })

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)

/**
 * Granola renders the words you typed in black and the AI's additions in grey.
 * We approximate that by marking each generated block whose wording overlaps
 * strongly with a line from the user's own notes.
 */
export function markAuthorship(html: string, userMarkdown: string) {
  const userLines = userMarkdown
    .split('\n')
    .map((l) => new Set(normalize(l)))
    .filter((s) => s.size > 0)
  if (!userLines.length) return html.replace(/<(p|li)>/g, '<$1 class="ai-text">')

  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  doc.querySelectorAll('li, p').forEach((el) => {
    if (el.tagName === 'P' && el.parentElement?.tagName === 'LI') return
    const own = Array.from(el.childNodes)
      .filter((n) => !(n instanceof HTMLElement && /^(UL|OL)$/.test(n.tagName)))
      .map((n) => n.textContent ?? '')
      .join(' ')
    const words = normalize(own)
    if (!words.length) return
    const best = Math.max(
      ...userLines.map((set) => {
        const hits = words.filter((w) => set.has(w)).length
        return hits / Math.min(words.length, set.size)
      })
    )
    el.classList.add(best >= 0.6 ? 'user-text' : 'ai-text')
  })
  return doc.body.firstElementChild?.innerHTML ?? html
}
