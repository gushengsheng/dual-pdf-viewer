// Thin client for the /__llm routes. The per-process token is fetched once and
// reused; every failure surfaces as an Error with the server's Chinese message.

const PATH = '/__llm'
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

let tokenPromise = null

function token() {
  if (!tokenPromise) {
    tokenPromise = (async () => {
      try {
        const response = await fetch('/__token', { cache: 'no-store' })
        if (!response.ok) return ''
        const data = await response.json()
        return typeof data.token === 'string' ? data.token : ''
      } catch {
        return ''
      }
    })()
  }
  return tokenPromise
}

async function call(path, { method = 'POST', body = null } = {}) {
  const value = await token()
  const url = `${PATH}${path}?token=${encodeURIComponent(value)}`
  let response
  try {
    response = await fetch(url, {
      method,
      headers: body === null ? undefined : { 'content-type': 'application/json' },
      body: body === null ? undefined : JSON.stringify(body),
      cache: 'no-store',
    })
  } catch (error) {
    const wrapped = new Error('连不上本地服务')
    wrapped.code = 'OFFLINE'
    throw wrapped
  }
  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }
  if (!response.ok || data === null || data.ok !== true) {
    const error = new Error(data && data.message ? data.message : `请求失败（${response.status}）`)
    error.code = data && data.code ? data.code : ''
    error.status = response.status
    throw error
  }
  return data
}

/** True when the text contains CJK, i.e. it is worth offering English for. */
export function hasChinese(text) {
  return HAN.test(String(text || ''))
}

/** Split text into CJK runs with the characters on either side, for context. */
export function chineseSegments(text, limit = 4) {
  const segments = []
  const pattern = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const value = match[0]
    if (value.length < 2) continue
    segments.push({
      id: `s${segments.length}`,
      text: value,
      start: match.index,
      end: match.index + value.length,
      left: text.slice(Math.max(0, match.index - 80), match.index),
      right: text.slice(match.index + value.length, match.index + value.length + 80),
    })
    if (segments.length === limit) break
  }
  return segments
}

export const englishApi = {
  health: () => call('/health', { method: 'GET' }),
  translate: (text, direction, context = []) => call('/translate', { body: { text, direction, context, notes: true } }),
  check: (text) => call('/check', { body: { text } }),
  replace: (text, context = []) => call('/replace', { body: { text, context } }),
  suggest: (draft, segments) => call('/suggest', { body: { draft, segments } }),
  saveConfig: (patch) => call('/config', { body: patch }),
  test: () => call('/test', { body: {} }),
  usage: () => call('/usage', { method: 'GET' }),
  resetUsage: () => call('/usage/reset', { body: {} }),
}

/** Every English-feature switch lives here, in one localStorage key. */
const SETTINGS_KEY = 'dpv:english:v1'

export const englishSettings = {
  enabled: true,
  load() {
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null')
      if (raw && typeof raw === 'object') this.enabled = raw.enabled !== false
    } catch {
      /* corrupted storage - keep the default */
    }
    return this
  },
  save() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ enabled: this.enabled }))
    } catch {
      /* storage disabled */
    }
  },
  setEnabled(on) {
    this.enabled = !!on
    this.save()
  },
}

englishSettings.load()
