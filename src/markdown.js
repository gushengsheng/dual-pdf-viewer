// Markdown rendering for the text panes. `marked` converts, DOMPurify strips
// anything active so a stray .md file cannot run script in the app origin.
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: false })

export function renderMarkdown(text) {
  const html = marked.parse(String(text ?? ''))
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
}

/**
 * Plain .txt: no markdown syntax, just keep the line breaks. Everything is
 * escaped, so no sanitizer needed.
 */
export function renderPlainText(text) {
  const escape = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const blocks = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
  return blocks
    .map((block) => `<p>${escape(block).replace(/\n/g, '<br>')}</p>`)
    .join('\n')
}
