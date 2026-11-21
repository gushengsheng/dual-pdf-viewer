/**
 * Pure helpers for the English routes: JSON extraction, reply normalization and
 * token accounting. No network, no filesystem, so the test suite runs them
 * directly under `node test/english.mjs`.
 *
 * Ported from dsh-english-master/lib/pure.mjs; the streaming chunk assembler is
 * not needed here because the reader calls a non-streaming completion.
 */

/** Clamp a value to a string of at most `max` UTF-16 units. */
export function clip(value, max) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return text.length <= max ? text : text.slice(0, max)
}

/** Clamp an integer into [min, max], falling back to `fallback`. */
export function clampInt(value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

/**
 * Parse the first JSON object in a model reply, tolerating a fenced block and
 * surrounding prose. Returns null instead of throwing.
 */
export function extractJson(reply) {
  if (typeof reply !== 'string') return null
  let text = reply.trim()
  if (text === '') return null
  const fence = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/)
  if (fence !== null) text = fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

const asArray = (value) => (Array.isArray(value) ? value : [])

/**
 * Keep only suggestions whose id matches a requested segment, and normalize
 * both options to { en, register }.
 */
export function normalizeSuggestions(raw, segments) {
  const ids = new Set(segments.map((segment) => String(segment.id)))
  const seen = new Set()
  const suggestions = []
  for (const item of asArray(raw.suggestions)) {
    if (item === null || typeof item !== 'object') continue
    const id = String(item.id ?? '')
    if (!ids.has(id) || seen.has(id)) continue
    const options = []
    for (const option of asArray(item.options)) {
      if (option === null || typeof option !== 'object') continue
      const en = clip(option.en, 600)
      if (en === '') continue
      const register = option.register === 'concise' ? 'concise' : 'natural'
      if (options.some((entry) => entry.en === en)) continue
      options.push({ en, register })
      if (options.length === 2) break
    }
    if (options.length === 0) continue
    seen.add(id)
    suggestions.push({ id, options, note: clip(item.note, 120) })
  }
  return suggestions
}

/**
 * Normalize a check reply against the exact source text. Issues whose
 * `original` cannot be found are dropped, because the Client highlights by
 * substring and an unfindable span would silently do nothing.
 */
export function normalizeCheck(raw, text) {
  const issues = []
  for (const item of asArray(raw.issues)) {
    if (item === null || typeof item !== 'object') continue
    const original = clip(item.original, 400)
    const replacement = clip(item.replacement, 400)
    if (original === '' || original === replacement) continue
    if (!text.includes(original)) continue
    if (issues.some((issue) => issue.original === original && issue.replacement === replacement)) continue
    issues.push({
      original,
      replacement,
      type: clip(item.type, 40) || 'phrasing',
      severity: item.severity === 'improve' ? 'improve' : 'error',
      message: clip(item.message, 240),
    })
    if (issues.length === 20) break
  }
  const corrected = clip(raw.corrected, 12000) || text
  const summary =
    clip(raw.summary, 160) ||
    (issues.length === 0 ? '没有发现问题' : `发现 ${issues.length} 处可修改`)
  return { issues, corrected, summary }
}

const REPLACE_FOCUS = new Set(['concise', 'formal', 'clear', 'precise', 'natural'])

/**
 * Normalize a replace reply: 1-3 whole-sentence alternatives. Anything equal to
 * the selection is dropped — an option that changes nothing is not an option.
 */
export function normalizeReplace(raw, source) {
  const seen = new Set([String(source ?? '').replace(/\s+/g, ' ').trim()])
  const options = []
  for (const item of asArray(raw.options)) {
    if (item === null || typeof item !== 'object') continue
    const text = clip(item.text, 2000)
    if (text === '') continue
    const key = text.replace(/\s+/g, ' ').trim()
    if (seen.has(key)) continue
    seen.add(key)
    options.push({
      text,
      focus: REPLACE_FOCUS.has(item.focus) ? item.focus : 'clear',
      why: clip(item.why, 200),
    })
    if (options.length === 3) break
  }
  return { options }
}

/** Normalize a translation reply into { direction, main, notes }. */export function normalizeTranslation(raw, direction) {
  const main = clip(raw.main, 6000)
  if (main === '') return null
  const notes = []
  for (const item of asArray(raw.notes)) {
    if (item === null || typeof item !== 'object') continue
    const term = clip(item.term, 120)
    const gloss = clip(item.gloss, 200)
    if (term === '' && gloss === '') continue
    notes.push({ term, gloss, why: clip(item.why, 240) })
    if (notes.length === 2) break
  }
  return { direction, main, notes }
}

/** Stable cache key for one model request. */
export function cacheKey(kind, config, payload) {
  return JSON.stringify([kind, config.baseUrl, config.model, payload])
}

/** Normalize a provider usage block into the shape the routes expose. */
export function normalizeUsage(value) {
  const source = value !== null && typeof value === 'object' ? value : {}
  const read = (key) => {
    const number = Number(source[key])
    return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0
  }
  const inputTokens = read('prompt_tokens') || read('inputTokens')
  const outputTokens = read('completion_tokens') || read('outputTokens')
  const usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
  const reasoning = Number(source.completion_tokens_details?.reasoning_tokens)
  if (Number.isFinite(reasoning) && reasoning > 0) usage.reasoningTokens = Math.trunc(reasoning)
  const cachedInput = Number(source.prompt_tokens_details?.cached_tokens)
  if (Number.isFinite(cachedInput) && cachedInput > 0) usage.cacheReadTokens = Math.trunc(cachedInput)
  return usage
}

/** An all-zero usage row, used for cache hits. */
export function zeroUsage(cached = true) {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cached: cached === true }
}

/** Sum two usage rows without mutating either. */
export function addUsage(left, right) {
  const a = normalizeUsage(left)
  const b = normalizeUsage(right)
  const sum = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  }
  if (a.reasoningTokens || b.reasoningTokens) {
    sum.reasoningTokens = (a.reasoningTokens || 0) + (b.reasoningTokens || 0)
  }
  if (a.cacheReadTokens || b.cacheReadTokens) {
    sum.cacheReadTokens = (a.cacheReadTokens || 0) + (b.cacheReadTokens || 0)
  }
  return sum
}

/** Mask a key for the settings panel: never send the whole thing back. */
export function keyTail(key) {
  const text = typeof key === 'string' ? key.trim() : ''
  if (text === '') return ''
  return text.length <= 4 ? '····' : `…${text.slice(-4)}`
}
