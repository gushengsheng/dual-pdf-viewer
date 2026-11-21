/**
 * The one place that talks to the model provider.
 *
 * A single non-streaming completion, asked to answer with one JSON object and
 * retried once with a repair line when the reply is not parseable. Results are
 * cached in memory for ten minutes so that re-checking the same note is free.
 *
 * Thinking is switched off explicitly. `deepseek-flash` lists low/high/max in
 * its supported effort levels and treats every one of them as thinking, so the
 * provider-level `thinking:{type:"disabled"}` switch is what actually removes
 * the reasoning scaffold (and its input tokens) from the response.
 */

import { addUsage, cacheKey, extractJson, normalizeUsage, zeroUsage } from './pure.mjs'
import { mockReply, mockUsage } from './mock.mjs'

const CACHE_TTL_MS = 10 * 60 * 1000
const CACHE_MAX = 160
const RETRY_LINE = '\n\n你的上一条输出不是可解析的 JSON。请只输出一个 JSON 对象，不要代码块、不要解释。'

export class UpstreamError extends Error {
  constructor(code, message, status = 502) {
    super(message)
    this.code = code
    this.status = status
  }
}

export class EnglishEngine {
  constructor(configStore) {
    this.configStore = configStore
    this.cache = new Map()
    /** Process-lifetime token ledger. Resets when the local service restarts. */
    this.totals = { inputTokens: 0, outputTokens: 0, calls: 0, cachedCalls: 0 }
  }

  totalsView() {
    return { ...this.totals, totalTokens: this.totals.inputTokens + this.totals.outputTokens }
  }

  resetTotals() {
    this.totals = { inputTokens: 0, outputTokens: 0, calls: 0, cachedCalls: 0 }
    return this.totalsView()
  }

  recordTotals(usage, cached) {
    this.totals.inputTokens += Math.max(0, Number(usage?.inputTokens) || 0)
    this.totals.outputTokens += Math.max(0, Number(usage?.outputTokens) || 0)
    this.totals.calls += 1
    if (cached === true) this.totals.cachedCalls += 1
  }

  cacheGet(key) {
    const hit = this.cache.get(key)
    if (hit === undefined) return undefined
    if (Date.now() - hit.at > CACHE_TTL_MS) {
      this.cache.delete(key)
      return undefined
    }
    return hit.value
  }

  cacheSet(key, value) {
    this.cache.set(key, { at: Date.now(), value })
    if (this.cache.size <= CACHE_MAX) return
    const now = Date.now()
    for (const [entryKey, entry] of this.cache) {
      if (now - entry.at > CACHE_TTL_MS) this.cache.delete(entryKey)
    }
    while (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  /**
   * One chat completion. `thinkingOff: false` is only used by the retry path
   * for providers that reject the field.
   */
  async #chat(config, messages, maxTokens, signal, thinkingOff) {
    const body = {
      model: config.model,
      messages,
      temperature: 0.15,
      max_tokens: maxTokens,
      stream: false,
    }
    if (thinkingOff) body.thinking = { type: 'disabled' }
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })
    const text = await response.text()
    if (!response.ok) {
      if (response.status === 400 && thinkingOff && /thinking|unknown|unrecogni|unsupported/i.test(text)) {
        const error = new UpstreamError('RETRY_WITHOUT_THINKING', 'provider rejected thinking field')
        error.retryWithoutThinking = true
        throw error
      }
      if (response.status === 401 || response.status === 403) {
        throw new UpstreamError('KEY_REJECTED', '密钥被拒绝，请在设置里检查 DEEPSEEK_KEY', 401)
      }
      if (response.status === 429) {
        throw new UpstreamError('RATE_LIMITED', '模型限流了，等一会儿再试', 429)
      }
      throw new UpstreamError('MODEL_FAILED', `模型返回 ${response.status}：${text.slice(0, 200)}`, 502)
    }
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch {
      throw new UpstreamError('MODEL_FAILED', '模型返回的不是 JSON', 502)
    }
    const message = payload?.choices?.[0]?.message
    const content = typeof message?.content === 'string' ? message.content : ''
    return { content, usage: normalizeUsage(payload?.usage) }
  }

  /**
   * Ask for JSON. Usage of every attempt is summed, so a repair retry shows its
   * real cost. `signal` aborts the whole thing when the page goes away.
   */
  async completeJson({ kind, system, user, maxTokens, timeoutMs, signal }) {
    const config = await this.configStore.resolve()
    if (config.mock) {
      const value = await mockReply(kind, user)
      const usage = mockUsage()
      this.recordTotals(usage, false)
      return { value, usage, cached: false, model: 'mock', mock: true }
    }
    if (!config.configured) {
      throw new UpstreamError('NO_KEY', '还没有填密钥：设置 → 英文', 400)
    }
    const key = cacheKey(kind, config, user)
    const cached = this.cacheGet(key)
    if (cached !== undefined) {
      this.recordTotals(zeroUsage(true), true)
      return { value: cached, usage: zeroUsage(true), cached: true, model: config.model }
    }

    let prompt = user
    let usage = zeroUsage(false)
    let thinkingOff = true
    let triedFallback = false
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const deadline = AbortSignal.timeout(timeoutMs)
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
      let reply
      try {
        reply = await this.#chat(
          config,
          [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          maxTokens,
          combined,
          thinkingOff,
        )
      } catch (error) {
        if (error instanceof UpstreamError && error.retryWithoutThinking && !triedFallback) {
          triedFallback = true
          thinkingOff = false
          attempt -= 1
          continue
        }
        throw error
      }
      usage = addUsage(usage, reply.usage)
      const parsed = extractJson(reply.content)
      if (parsed !== null) {
        this.cacheSet(key, parsed)
        this.recordTotals(usage, false)
        return { value: parsed, usage, cached: false, model: config.model }
      }
      prompt = `${user}${RETRY_LINE}`
    }
    this.recordTotals(usage, false)
    throw new UpstreamError('BAD_MODEL_JSON', '模型没有返回可解析的结果，请重试', 502)
  }

  /** Settings → "测试连接": the smallest possible round trip. */
  async ping() {
    const config = await this.configStore.resolve()
    if (config.mock) {
      return { ok: true, mock: true, model: 'mock', latencyMs: 0, usage: mockUsage(), reply: 'ok (mock)' }
    }
    if (!config.configured) throw new UpstreamError('NO_KEY', '还没有填密钥', 400)
    const started = Date.now()
    const reply = await this.#chat(
      config,
      [{ role: 'user', content: 'Reply with exactly: ok' }],
      16,
      AbortSignal.timeout(Math.min(config.timeoutMs, 20000)),
      true,
    )
    this.recordTotals(reply.usage, false)
    return {
      ok: reply.content.trim().toLowerCase().includes('ok'),
      model: config.model,
      latencyMs: Date.now() - started,
      usage: reply.usage,
      reply: reply.content.slice(0, 40),
    }
  }
}
