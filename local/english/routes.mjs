/**
 * HTTP routes for the English helpers, shared by both servers:
 *
 *   local/server.cjs   the built app (npm run local / 启动 Dual PDF.bat)
 *   vite.config.js     the dev server (npm run dev)
 *
 * Everything sits under /__llm and, like /__notes, needs the per-process token,
 * so another page on the same machine cannot spend the reader's tokens.
 *
 *   GET  /__llm/health        -> { configured, model, baseUrl, keyTail, usage }
 *   POST /__llm/config        -> save key / base URL / model
 *   POST /__llm/test          -> one tiny round trip
 *   POST /__llm/translate     -> { text, direction, context, notes }
 *   POST /__llm/check         -> { text } -> issues + corrected + summary
 *   POST /__llm/suggest       -> { draft, segments } -> English options
 *   POST /__llm/replace       -> { text, context } -> whole-sentence alternatives
 *   GET  /__llm/usage         -> token ledger
 *   POST /__llm/usage/reset   -> zero the ledger
 */

import { EnglishEngine, UpstreamError } from './engine.mjs'
import { ConfigStore } from './config.mjs'
import {
  CHECK_SYSTEM,
  REPLACE_SYSTEM,
  SUGGEST_SYSTEM,
  TRANSLATE_SYSTEM,
  checkPayload,
  replacePayload,
  suggestPayload,
  translatePayload,
} from './prompts.mjs'
import {
  clip,
  normalizeCheck,
  normalizeReplace,
  normalizeSuggestions,
  normalizeTranslation,
  zeroUsage,
} from './pure.mjs'

const PREFIX = '/__llm'
const MAX_BODY_BYTES = 128 * 1024
const DIRECTIONS = new Set(['en-zh', 'en-en', 'zh-en'])

class RouteError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

function sendJson(res, status, payload) {
  if (res.headersSent) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        finish(reject, new RouteError('BODY_TOO_LARGE', '请求体过大', 413))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', (error) => finish(reject, error))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return finish(resolve, {})
      try {
        const parsed = JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return finish(reject, new RouteError('BAD_JSON', '请求体必须是 JSON 对象'))
        }
        finish(resolve, parsed)
      } catch {
        finish(reject, new RouteError('BAD_JSON', '请求体不是合法 JSON'))
      }
    })
  })
}

function mapError(error) {
  if (error instanceof RouteError || error instanceof UpstreamError) return error
  const message = String(error?.message || error)
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return new RouteError('TIMEOUT', '模型响应超时，请重试', 504)
  }
  return new RouteError('MODEL_FAILED', message, 502)
}

/** Abort the model call when the page disconnects before the reply is sent. */
function requestSignal(req, res) {
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })
  req.on('aborted', () => controller.abort())
  return controller.signal
}

function collectSegments(body) {
  const segments = []
  for (const item of Array.isArray(body.segments) ? body.segments : []) {
    if (item === null || typeof item !== 'object') continue
    const id = clip(item.id, 40)
    const text = clip(item.text, 300)
    if (id === '' || text === '') continue
    segments.push({ id, text, left: clip(item.left, 160), right: clip(item.right, 160) })
    if (segments.length === 6) break
  }
  return segments
}

function collectContext(body) {
  const context = []
  for (const item of Array.isArray(body.context) ? body.context : []) {
    if (item === null || typeof item !== 'object') continue
    const text = clip(item.text, 1200)
    if (text === '') continue
    context.push({ text })
    if (context.length === 6) break
  }
  return context
}

export function createEnglish({ configPath, token }) {
  const configStore = new ConfigStore(configPath)
  const engine = new EnglishEngine(configStore)

  const meta = (model, mock) => ({ model, reasoning: 'disabled', ...(mock ? { mock: true } : {}) })

  async function route(req, res) {
    const url = new URL(req.url, 'http://local')
    const given = url.searchParams.get('token') || req.headers['x-dpv-token'] || ''
    if (given !== token) {
      sendJson(res, 403, { ok: false, code: 'BAD_TOKEN', message: 'bad token' })
      return
    }

    const path = url.pathname

    if (path === `${PREFIX}/health`) {
      if (req.method !== 'GET') throw new RouteError('METHOD_NOT_ALLOWED', '只接受 GET', 405)
      const described = await configStore.describe()
      sendJson(res, 200, {
        ok: true,
        ...described,
        reasoning: 'disabled',
        totals: engine.totalsView(),
        limits: { checkChars: 6000, translateChars: 3000, draftChars: 4000, segments: 6 },
      })
      return
    }

    if (path === `${PREFIX}/config`) {
      if (req.method !== 'POST') throw new RouteError('METHOD_NOT_ALLOWED', '只接受 POST', 405)
      const body = await readJsonBody(req)
      const described = await configStore.patch({
        apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
        baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
        model: typeof body.model === 'string' ? body.model : undefined,
      })
      sendJson(res, 200, { ok: true, ...described })
      return
    }

    if (path === `${PREFIX}/test`) {
      if (req.method !== 'POST') throw new RouteError('METHOD_NOT_ALLOWED', '只接受 POST', 405)
      const result = await engine.ping()
      sendJson(res, 200, { ok: true, ...result, totals: engine.totalsView() })
      return
    }

    if (path === `${PREFIX}/usage`) {
      if (req.method !== 'GET') throw new RouteError('METHOD_NOT_ALLOWED', '只接受 GET', 405)
      sendJson(res, 200, { ok: true, totals: engine.totalsView() })
      return
    }

    if (path === `${PREFIX}/usage/reset`) {
      if (req.method !== 'POST') throw new RouteError('METHOD_NOT_ALLOWED', '只接受 POST', 405)
      sendJson(res, 200, { ok: true, totals: engine.resetTotals() })
      return
    }

    if (path === `${PREFIX}/translate`) {
      if (req.method !== 'POST') throw new RouteError('METHOD_NOT_ALLOWED', '只接受 POST', 405)
      const body = await readJsonBody(req)
      const text = clip(body.text, 3000)
      if (text === '') throw new RouteError('EMPTY_TEXT', '没有可翻译的文本')
      const direction = DIRECTIONS.has(body.direction) ? body.direction : 'en-zh'
      const notes = body.notes !== false
      const config = await configStore.resolve()
      const reply = await engine.completeJson({
        kind: `translate:${direction}:${notes ? 1 : 0}`,
        system: TRANSLATE_SYSTEM,
        user: translatePayload(text, collectContext(body), direction, notes),
        maxTokens: 1400,
        timeoutMs: config.timeoutMs,
        signal: requestSignal(req, res),
      })
      const result = normalizeTranslation(reply.value, direction)
      if (result === null) throw new RouteError('BAD_MODEL_JSON', '模型没有给出翻译结果，请重试', 502)
      sendJson(res, 200, {
        ok: true,
        result,
        cached: reply.cached === true,
        usage: reply.usage,
        totals: engine.totalsView(),
        meta: meta(reply.model, reply.mock),
      })
      return
    }

    if (path === `${PREFIX}/check`) {
      if (req.method !== 'POST') throw new RouteError('METHOD_NOT_ALLOWED', '只接受 POST', 405)
      const body = await readJsonBody(req)
      const text = clip(body.text, 6000)
      if (text === '') {
        sendJson(res, 200, {
          ok: true,
          issues: [],
          corrected: '',
          summary: '这条笔记还是空的',
          usage: zeroUsage(false),
          totals: engine.totalsView(),
        })
        return
      }
      if (!/[A-Za-z]/.test(text)) {
        sendJson(res, 200, {
          ok: true,
          issues: [],
          corrected: text,
          summary: '这条笔记里还没有英文可检查',
          usage: zeroUsage(false),
          totals: engine.totalsView(),
        })
        return
      }
      const config = await configStore.resolve()
      const reply = await engine.completeJson({
        kind: 'check',
        system: CHECK_SYSTEM,
        user: checkPayload(text),
        maxTokens: 1600,
        timeoutMs: config.timeoutMs,
        signal: requestSignal(req, res),
      })
      const result = normalizeCheck(reply.value, text)
      sendJson(res, 200, {
        ok: true,
        ...result,
        cached: reply.cached === true,
        usage: reply.usage,
        totals: engine.totalsView(),
        meta: meta(reply.model, reply.mock),
      })
      return
    }

    if (path === `${PREFIX}/suggest`) {
      if (req.method !== 'POST') throw new RouteError('METHOD_NOT_ALLOWED', '只接受 POST', 405)
      const body = await readJsonBody(req)
      const draft = clip(body.draft, 4000)
      const segments = collectSegments(body)
      if (draft === '' || segments.length === 0) {
        sendJson(res, 200, {
          ok: true,
          suggestions: [],
          usage: zeroUsage(false),
          totals: engine.totalsView(),
        })
        return
      }
      const config = await configStore.resolve()
      const reply = await engine.completeJson({
        kind: 'suggest',
        system: SUGGEST_SYSTEM,
        user: suggestPayload(draft, segments),
        maxTokens: 1200,
        timeoutMs: config.timeoutMs,
        signal: requestSignal(req, res),
      })
      sendJson(res, 200, {
        ok: true,
        suggestions: normalizeSuggestions(reply.value, segments),
        cached: reply.cached === true,
        usage: reply.usage,
        totals: engine.totalsView(),
        meta: meta(reply.model, reply.mock),
      })
      return
    }

    if (path === `${PREFIX}/replace`) {
      if (req.method !== 'POST') throw new RouteError('METHOD_NOT_ALLOWED', '只接受 POST', 405)
      const body = await readJsonBody(req)
      const text = clip(body.text, 2000)
      if (text === '') throw new RouteError('EMPTY_TEXT', '没有可替换的文本')
      // Chinese selections are the suggestion route's job, not this one.
      if (!/[A-Za-z]/.test(text)) {
        sendJson(res, 200, {
          ok: true,
          options: [],
          usage: zeroUsage(false),
          totals: engine.totalsView(),
        })
        return
      }
      const config = await configStore.resolve()
      const reply = await engine.completeJson({
        kind: 'replace',
        system: REPLACE_SYSTEM,
        user: replacePayload(text, collectContext(body)),
        maxTokens: 1200,
        timeoutMs: config.timeoutMs,
        signal: requestSignal(req, res),
      })
      sendJson(res, 200, {
        ok: true,
        ...normalizeReplace(reply.value, text),
        cached: reply.cached === true,
        usage: reply.usage,
        totals: engine.totalsView(),
        meta: meta(reply.model, reply.mock),
      })
      return
    }

    throw new RouteError('NOT_FOUND', '没有这个接口', 404)
  }

  /** True when this URL belongs to the English routes. */
  function owns(url) {
    if (typeof url !== 'string') return false
    const path = url.split('?')[0]
    return path === PREFIX || path.startsWith(`${PREFIX}/`)
  }

  /** Never throws: every failure becomes a JSON error the page can show. */
  async function handle(req, res) {
    try {
      await route(req, res)
    } catch (error) {
      const mapped = mapError(error)
      sendJson(res, mapped.status, { ok: false, code: mapped.code, message: mapped.message })
    }
  }

  return { owns, handle, engine, configStore }
}
