// Copy pdf.js runtime assets (CMaps + standard fonts) into public/ so that
// CJK PDFs without embedded ToUnicode maps and non-embedded standard fonts
// still render and can be selected.
import { existsSync } from 'node:fs'
import { cp, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const pkg = path.join(root, 'node_modules', 'pdfjs-dist')
const target = path.join(root, 'public', 'pdfjs')

const jobs = [
  ['cmaps', 'cmaps'],
  ['standard_fonts', 'standard_fonts'],
  ['standard_fonts', 'standard_fonts'],
]

if (!existsSync(pkg)) {
  console.warn('[pdfjs-assets] pdfjs-dist not installed yet; skipping copy.')
  process.exit(0)
}

const seen = new Set()
for (const [from, to] of jobs) {
  if (seen.has(to)) continue
  seen.add(to)
  const src = path.join(pkg, from)
  if (!existsSync(src)) {
    console.warn(`[pdfjs-assets] missing ${src}; skipped.`)
    continue
  }
  const dst = path.join(target, to)
  await mkdir(dst, { recursive: true })
  await cp(src, dst, { recursive: true })
  console.log(`[pdfjs-assets] ${from} -> public/pdfjs/${to}`)
}
