/**
 * One settings file for the English routes: <project>/english.config.json.
 *
 * The key lives in exactly one place. It is read on the Host side only — the
 * page never receives it back, only a masked tail. An environment variable
 * still wins, so a one-off test run does not have to write a key to disk.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { clip, keyTail } from './pure.mjs'

export const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  timeoutMs: 30000,
}

const FILE_NAME = 'english.config.json'

/** Only http(s) endpoints; anything else (file:, data:) must not be reachable. */
function safeBaseUrl(value) {
  const text = clip(value, 300)
  if (text === '') return DEFAULTS.baseUrl
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULTS.baseUrl
    return text.replace(/\/+$/, '')
  } catch {
    return DEFAULTS.baseUrl
  }
}

export class ConfigStore {
  constructor(configPath) {
    this.path = path.resolve(configPath)
    this.cached = null
    this.cachedAt = 0
  }

  async readFile() {
    let stat = null
    try {
      stat = await fs.stat(this.path)
    } catch {
      this.cached = {}
      this.cachedAt = Date.now()
      return {}
    }
    if (this.cached !== null && stat.mtimeMs === this.cachedAt) return this.cached
    try {
      const text = await fs.readFile(this.path, 'utf8')
      const parsed = JSON.parse(text)
      this.cached = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      this.cached = {}
    }
    this.cachedAt = stat.mtimeMs
    return this.cached
  }

  /** Full runtime config: env first, then the file, then defaults. */
  async resolve() {
    const file = await this.readFile()
    const apiKey = clip(process.env.DPV_LLM_API_KEY, 400) || clip(file.apiKey, 400)
    const baseUrl = safeBaseUrl(process.env.DPV_LLM_BASE_URL || file.baseUrl)
    const model = clip(process.env.DPV_LLM_MODEL, 120) || clip(file.model, 120) || DEFAULTS.model
    const timeoutMs = Number(file.timeoutMs) > 5000 ? Math.min(Number(file.timeoutMs), 90000) : DEFAULTS.timeoutMs
    const mock = process.env.DPV_LLM_MOCK === '1' || file.mock === true
    return {
      apiKey,
      baseUrl,
      model,
      timeoutMs,
      mock,
      configured: mock || apiKey !== '',
      keySource: clip(process.env.DPV_LLM_API_KEY, 400) ? 'env' : apiKey ? 'file' : 'none',
    }
  }

  /** What the settings panel is allowed to see. */
  async describe() {
    const config = await this.resolve()
    return {
      configured: config.configured,
      mock: config.mock,
      baseUrl: config.baseUrl,
      model: config.model,
      keyTail: keyTail(config.apiKey),
      keySource: config.keySource,
    }
  }

  /** Merge a patch into the file. An omitted key keeps the current one. */
  async patch(patch) {
    const file = await this.readFile()
    const next = { ...file }
    if (typeof patch.apiKey === 'string') {
      const key = patch.apiKey.trim()
      if (key === '') delete next.apiKey
      else next.apiKey = key
    }
    if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim() !== '') {
      next.baseUrl = safeBaseUrl(patch.baseUrl)
    }
    if (typeof patch.model === 'string' && patch.model.trim() !== '') {
      next.model = clip(patch.model, 120)
    }
    await fs.mkdir(path.dirname(this.path), { recursive: true })
    await fs.writeFile(this.path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    this.cached = next
    this.cachedAt = (await fs.stat(this.path)).mtimeMs
    return this.describe()
  }

  get fileName() {
    return FILE_NAME
  }
}
