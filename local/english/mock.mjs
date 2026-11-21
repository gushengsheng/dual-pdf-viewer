/**
 * Canned model replies for developing the UI without a key and without
 * spending tokens. Enabled by DPV_LLM_MOCK=1 or {"mock": true} in
 * english.config.json; every route then answers locally.
 *
 * The replies are rule-based rather than fixed strings, so the panel still
 * reacts to what was actually typed: only phrases the rules recognise are
 * flagged, and only Chinese fragments in the small dictionary get options.
 */

const CHECK_RULES = [
  {
    re: /\bvery very\b/gi,
    replacement: 'markedly',
    type: 'phrasing',
    severity: 'improve',
    message: '重复强调，换成一个精确的程度词',
  },
  {
    re: /\bwe do\b/gi,
    replacement: 'we performed',
    type: 'tense',
    severity: 'error',
    message: '描述已完成的分析用过去时',
  },
  {
    re: /\bthe sample were\b/gi,
    replacement: 'the sample was',
    type: 'agreement',
    severity: 'error',
    message: 'sample 是单数，谓语用 was',
  },
  {
    re: /\bis consist of\b/gi,
    replacement: 'consists of',
    type: 'grammar',
    severity: 'error',
    message: 'consist 是不及物动词，不加 is',
  },
  {
    re: /\bin the other hand\b/gi,
    replacement: 'on the other hand',
    type: 'preposition',
    severity: 'error',
    message: '固定搭配是 on the other hand',
  },
  {
    re: /\bthis results suggests\b/gi,
    replacement: 'this result suggests',
    type: 'agreement',
    severity: 'error',
    message: 'this 后接单数名词 result',
  },
]

const SUGGEST_DICTIONARY = [
  { test: /我们发现.*复发率/, natural: 'We found a lower recurrence rate', concise: 'We found lower recurrence', note: 'rate 可省略' },
  { test: /复发率更低|复发率较低/, natural: 'a lower recurrence rate', concise: 'lower recurrence', note: 'rate 可省略' },
  { test: /我们发现|结果表明/, natural: 'We found that', concise: 'We found', note: 'that 可省' },
  { test: /显著/, natural: 'significantly', concise: 'clearly', note: '统计显著用 significantly' },
  { test: /提示|表明/, natural: 'suggests that', concise: 'suggests', note: '数据提示用 suggests' },
  { test: /样本量小|样本较小/, natural: 'the sample was small', concise: 'the sample is small', note: '注意时态' },
  { test: /随访/, natural: 'during follow-up', concise: 'at follow-up', note: 'follow-up 是名词' },
  { test: /纳入|共纳入/, natural: 'were enrolled', concise: 'enrolled', note: '被动语态更常见' },
  { test: /没有差异|无差异/, natural: 'showed no difference', concise: 'did not differ', note: '两种都自然' },
]

const TRANSLATE_DEMO = {
  'en-zh': {
    main: '（模拟）基线评分较高的患者，校正后复发风险为 1.8 倍。',
    notes: [
      { term: 'baseline score', gloss: '基线评分', why: '研究开始时的初始状态，论文里固定译作“基线”。' },
      { term: 'after adjustment', gloss: '校正后', why: '统计语境指校正混杂因素，译“校正”比“调整”更贴。' },
    ],
  },
  'en-en': {
    main: '（模拟）People who started with a higher score were about twice as likely to relapse, even after the analysis accounted for other factors.',
    notes: [{ term: 'adjusted', gloss: '校正过的', why: '这里指把年龄、性别等因素算进去，不是“调整了剂量”。' }],
  },
  'zh-en': {
    main: '（模拟）Recurrence was less frequent in the matched group.',
    notes: [{ term: 'recurrence', gloss: '复发', why: '比 relapse 更偏流行病学表述。' }],
  },
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function mockCheck(payload) {
  const text = typeof payload.text === 'string' ? payload.text : ''
  const issues = []
  const applied = []
  for (const rule of CHECK_RULES) {
    rule.re.lastIndex = 0
    const match = rule.re.exec(text)
    if (match === null) continue
    // Keep the sentence's capital where the rule only replaces a phrase.
    const original = match[0]
    let replacement = rule.replacement
    if (/^[A-Z]/.test(original) && /^[a-z]/.test(replacement)) {
      replacement = replacement[0].toUpperCase() + replacement.slice(1)
    }
    issues.push({
      original,
      replacement,
      type: rule.type,
      severity: rule.severity,
      message: rule.message,
    })
    applied.push({ original, replacement })
    if (issues.length === 6) break
  }
  let corrected = text
  for (const issue of applied) corrected = corrected.replace(issue.original, issue.replacement)
  return {
    issues,
    corrected,
    summary: issues.length === 0 ? '没有发现问题（模拟）' : `发现 ${issues.length} 处可修改（模拟）`,
  }
}

function mockSuggest(payload) {
  const segments = Array.isArray(payload.segments) ? payload.segments : []
  const suggestions = []
  for (const segment of segments) {
    const text = String(segment.text || '')
    const hit = SUGGEST_DICTIONARY.find((entry) => entry.test.test(text))
    if (!hit) continue
    suggestions.push({
      id: segment.id,
      options: [
        { en: hit.natural, register: 'natural' },
        { en: hit.concise, register: 'concise' },
      ],
      note: hit.note,
    })
  }
  return { suggestions }
}

function mockTranslate(payload) {
  const direction = payload.direction === 'zh-en' || payload.direction === 'en-en' ? payload.direction : 'en-zh'
  const demo = TRANSLATE_DEMO[direction]
  const notes = payload.notes === false ? [] : demo.notes
  return { main: demo.main, notes }
}

/**
 * Deterministic rewrites for the replace route: enough shapes that the UI can be
 * exercised offline. Real answers come from the model once a key is configured.
 */
const REPLACE_RULES = [
  {
    test: /^The results?\s+of\s+this\s+study\s+(show|showed|suggest|suggested)\s+that\s+/i,
    strip: true,
    focus: 'concise',
    why: '去掉“本研究的结果表明”这层套话，直接说结论（模拟）',
  },
  {
    test: /,\s*which\s+is\s+/i,
    swap: [', which is ', ', '],
    focus: 'concise',
    why: '定语从句压成短语，句子更短（模拟）',
  },
  {
    test: /\bit is\s+(?:important|necessary)\s+to\s+/i,
    swap: [/it is (?:important|necessary) to /i, 'we '],
    focus: 'formal',
    why: '去掉空泛的必要性表述，改用实义主语（模拟）',
  },
]

function mockReplace(payload) {
  const text = typeof payload.text === 'string' ? payload.text : ''
  if (text === '' || !/[A-Za-z]/.test(text)) return { options: [] }
  const options = []
  for (const rule of REPLACE_RULES) {
    let next = ''
    if (rule.strip) {
      const match = text.match(rule.test)
      if (match === null) continue
      const rest = text.slice(match[0].length)
      next = rest.charAt(0).toUpperCase() + rest.slice(1)
    } else {
      const swap = rule.swap
      const re = Array.isArray(swap[0]) ? swap[0] : null
      if (re === null) continue
      if (!re.test(text)) continue
      next = text.replace(re, swap[1])
    }
    if (next === '' || next === text) continue
    if (options.some((option) => option.text === next)) continue
    options.push({ text: next, focus: rule.focus, why: rule.why })
    if (options.length === 3) break
  }
  if (options.length === 0) {
    options.push({
      text: text.trim(),
      focus: 'clear',
      why: '（模拟）这里没有可演示的改写规则，接上真实模型后会给出 3 个版本',
    })
  }
  return { options }
}

/** The JSON the model would have returned, for one route. */
export async function mockReply(kind, userText) {
  await sleep(320)
  let payload = {}
  try {
    payload = JSON.parse(userText)
  } catch {
    payload = {}
  }
  if (kind === 'check') return mockCheck(payload)
  if (kind === 'suggest') return mockSuggest(payload)
  if (kind === 'replace') return mockReplace(payload)
  if (kind.startsWith('translate')) return mockTranslate(payload)
  return {}
}

/** A plausible bill so the counter is not stuck at zero during UI work. */
export function mockUsage() {
  return { inputTokens: 120, outputTokens: 45, totalTokens: 165 }
}
