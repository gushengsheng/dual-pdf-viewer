// Pure-logic tests for the English helpers. No network, no DSH, no browser:
// node test/english.mjs
import assert from 'node:assert/strict'

import {
  addUsage,
  cacheKey,
  extractJson,
  keyTail,
  normalizeCheck,
  normalizeSuggestions,
  normalizeTranslation,
  normalizeUsage,
  zeroUsage,
} from '../local/english/pure.mjs'

let passed = 0
function test(name, fn) {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

test('extractJson takes a bare object', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 })
})

test('extractJson tolerates fences and prose', () => {
  assert.deepEqual(extractJson('好的：\n```json\n{"a":1}\n```\n完'), { a: 1 })
  assert.equal(extractJson('not json'), null)
  assert.equal(extractJson('[1,2]'), null)
})

test('normalizeSuggestions keeps requested ids only, two options max', () => {
  const segments = [{ id: 's0' }, { id: 's1' }]
  const raw = {
    suggestions: [
      { id: 's0', options: [{ en: 'a', register: 'natural' }, { en: 'b', register: 'concise' }, { en: 'c' }], note: 'x' },
      { id: 's9', options: [{ en: 'z' }] },
      { id: 's0', options: [{ en: 'dup' }] },
    ],
  }
  const out = normalizeSuggestions(raw, segments)
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].options.map((o) => o.en), ['a', 'b'])
  assert.equal(out[0].options[1].register, 'concise')
})

test('normalizeCheck drops unfindable originals', () => {
  const text = 'The sample were small and the result is very very clear.'
  const raw = {
    issues: [
      { original: 'sample were', replacement: 'sample was', type: 'agreement', severity: 'error', message: '主谓一致' },
      { original: 'not in the text', replacement: 'x' },
      { original: 'very very', replacement: 'markedly', severity: 'improve' },
    ],
    corrected: 'The sample was small and the result is markedly clear.',
    summary: '2 处',
  }
  const out = normalizeCheck(raw, text)
  assert.equal(out.issues.length, 2)
  assert.equal(out.issues[1].severity, 'improve')
  assert.equal(out.issues[1].type, 'phrasing')
})

test('normalizeCheck keeps text when corrected is empty', () => {
  const out = normalizeCheck({}, 'unchanged')
  assert.equal(out.corrected, 'unchanged')
  assert.equal(out.summary, '没有发现问题')
})

test('normalizeTranslation rejects an empty main and caps notes at 2', () => {
  assert.equal(normalizeTranslation({ main: '' }, 'en-zh'), null)
  const out = normalizeTranslation(
    { main: '译文', notes: [{ term: 'a', gloss: '甲' }, { term: 'b', gloss: '乙' }, { term: 'c', gloss: '丙' }] },
    'en-zh',
  )
  assert.equal(out.notes.length, 2)
  assert.equal(out.direction, 'en-zh')
})

test('usage math adds and normalizes provider shapes', () => {
  const usage = normalizeUsage({
    prompt_tokens: 100,
    completion_tokens: 20,
    completion_tokens_details: { reasoning_tokens: 0 },
    prompt_tokens_details: { cached_tokens: 40 },
  })
  assert.deepEqual(usage, { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 40 })
  const sum = addUsage(usage, zeroUsage(false))
  assert.equal(sum.totalTokens, 120)
  assert.equal(sum.cached, undefined)
})

test('cacheKey separates models and payloads', () => {
  const a = cacheKey('check', { baseUrl: 'u', model: 'm' }, '{"text":"x"}')
  const b = cacheKey('check', { baseUrl: 'u', model: 'n' }, '{"text":"x"}')
  assert.notEqual(a, b)
})

test('keyTail never leaks the key', () => {
  assert.equal(keyTail('sk-1234567890abcd'), '…abcd')
  assert.equal(keyTail(''), '')
  assert.equal(keyTail('abc'), '····')
})

console.log(`\n${passed} passed`)
