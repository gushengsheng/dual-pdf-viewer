// Markdown rendering for the text panes. `marked` converts, DOMPurify strips
// anything active so a stray .md file cannot run script in the app origin.
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: false })

export function renderMarkdown(text) {
  const html = marked.parse(String(text ?? ''))
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
}
