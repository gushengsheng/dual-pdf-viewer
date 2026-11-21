// Note assistance inside the notes panel: an English checker for the note body
// and Chinese-to-English options while typing.
//
// Nothing here rewrites a note on its own. The checker renders a preview and one
// button per issue; the suggestion chips only replace the exact Chinese span the
// writer clicks.

import { chineseSegments, englishApi, englishSettings, hasChinese } from './api.js'

const DEBOUNCE_MS = 900

/** Plain text runs plus the runs a check reply located. */
function buildHighlight(text, issues) {
  const located = []
  for (const issue of issues || []) {
    const original = typeof issue?.original === 'string' ? issue.original : ''
    if (original === '') continue
    const at = text.indexOf(original)
    if (at < 0) continue
    located.push({ issue, at })
  }
  located.sort((a, b) => a.at - b.at)
  const spans = []
  let from = 0
  for (const { issue, at } of located) {
    if (at < from) continue
    if (at > from) spans.push({ text: text.slice(from, at) })
    spans.push({ text: issue.original, issue })
    from = at + issue.original.length
  }
  if (from < text.length) spans.push({ text: text.slice(from) })
  return spans
}

const TYPE_LABEL = {
  grammar: '语法',
  tense: '时态',
  agreement: '一致',
  article: '冠词',
  preposition: '介词',
  'word-choice': '用词',
  punctuation: '标点',
  phrasing: '措辞',
  expression: '表达',
}

function countChinese(text) {
  const matches = String(text || '').match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)
  return matches ? matches.length : 0
}

export class NoteAssist {
  constructor({ notes }) {
    this.notes = notes
    this.listEl = notes.listEl
    this.state = new Map()
    this.timers = new Map()
    this.composing = new Set()
    notes.onCard = (card, item) => this.enhance(card, item)
    this.bind()
  }

  /* ---------------------------------------------------------------- */
  /* state                                                             */
  /* ---------------------------------------------------------------- */

  of(id) {
    let state = this.state.get(id)
    if (!state) {
      state = { check: null, error: '', busy: false, suggestions: [], suggestBusy: false, applied: new Set() }
      this.state.set(id, state)
    }
    return state
  }

  item(card) {
    if (!card) return null
    return this.notes.items.find((note) => note.id === card.dataset.id) || null
  }

  /* ---------------------------------------------------------------- */
  /* card decoration                                                   */
  /* ---------------------------------------------------------------- */

  /** Called by the notes panel for every rendered card. */
  enhance(card, item) {
    this.render(card, item)
  }

  /* ---------------------------------------------------------------- */
  /* rendering                                                         */
  /* ---------------------------------------------------------------- */

  /** Badge and check button state; cheap enough to run on every keystroke. */
  renderTools(card, item, state) {
    const tools = card.querySelector('.note-tools')
    if (!tools) return
    const check = tools.querySelector('[data-note-check]')
    const badge = tools.querySelector('[data-note-cn]')
    const chinese = countChinese(item.body)
    badge.hidden = chinese === 0 || !englishSettings.enabled
    badge.textContent = `中文 ${chinese}`
    badge.title = '这条笔记里还有中文；下面是可替换的英文'
    if (!check) return
    const filled = !!String(item.body || '').trim()
    if (check.disabled !== (!englishSettings.enabled || state.busy || !filled)) {
      check.disabled = !englishSettings.enabled || state.busy || !filled
    }
    check.textContent = state.busy ? '检查中…' : '检查'
    check.title = '检查这条笔记的英文：错误与可优化处'
  }

  render(card, item) {
    const state = this.of(item.id)
    this.renderTools(card, item, state)

    const host = card.querySelector('.note-assist')
    if (!host) return
    host.textContent = ''

    if (state.error) {
      const error = document.createElement('div')
      error.className = 'assist-error'
      error.textContent = state.error
      host.append(error)
    }

    if (state.check) host.append(this.buildCheck(card, item, state))
    if (state.suggestions.length || state.suggestBusy) host.append(this.buildSuggest(card, item, state))
    host.hidden = host.childElementCount === 0
  }

  buildCheck(card, item, state) {
    const box = document.createElement('div')
    box.className = 'assist-block'

    const head = document.createElement('div')
    head.className = 'assist-head'
    const title = document.createElement('span')
    title.className = 'assist-title'
    title.textContent = '检查'
    const summary = document.createElement('span')
    summary.className = 'assist-summary'
    summary.textContent = state.check.summary || ''
    const spacer = document.createElement('span')
    spacer.className = 'spacer'
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'assist-x'
    close.dataset.assistClose = '1'
    close.title = '收起'
    close.textContent = '×'
    head.append(title, summary, spacer, close)
    if (state.check.issues.length > 0) {
      const all = document.createElement('button')
      all.type = 'button'
      all.className = 'btn assist-apply-all'
      all.dataset.applyAll = '1'
      all.textContent = '全部应用'
      head.insertBefore(all, close)
    }
    box.append(head)

    const preview = document.createElement('div')
    preview.className = 'assist-preview'
    for (const span of buildHighlight(item.body || '', state.check.issues)) {
      if (!span.issue) {
        preview.append(document.createTextNode(span.text))
        continue
      }
      const mark = document.createElement('span')
      mark.className = span.issue.severity === 'error' ? 'hl-error' : 'hl-improve'
      mark.textContent = span.text
      preview.append(mark)
    }
    box.append(preview)

    state.check.issues.forEach((issue, index) => {
      const row = document.createElement('div')
      row.className = `assist-issue${state.applied.has(index) ? ' applied' : ''}`
      const tag = document.createElement('span')
      tag.className = `tag ${issue.severity === 'error' ? 'error' : 'improve'}`
      tag.textContent = TYPE_LABEL[issue.type] || issue.type
      const from = document.createElement('span')
      from.className = 'assist-from'
      from.textContent = issue.original
      const arrow = document.createElement('span')
      arrow.className = 'assist-arrow'
      arrow.textContent = '→'
      const to = document.createElement('span')
      to.className = 'assist-to'
      to.textContent = issue.replacement
      const apply = document.createElement('button')
      apply.type = 'button'
      apply.className = 'assist-apply'
      apply.dataset.apply = String(index)
      apply.textContent = state.applied.has(index) ? '已应用' : '应用'
      apply.disabled = state.applied.has(index)
      const message = document.createElement('div')
      message.className = 'assist-msg'
      message.textContent = issue.message || ''
      row.append(tag, from, arrow, to, apply, message)
      box.append(row)
    })

    return box
  }

  buildSuggest(card, item, state) {
    const box = document.createElement('div')
    box.className = 'assist-block assist-suggest'

    const head = document.createElement('div')
    head.className = 'assist-head'
    const title = document.createElement('span')
    title.className = 'assist-title'
    title.textContent = '英文建议'
    const hint = document.createElement('span')
    hint.className = 'assist-summary'
    hint.textContent = state.suggestBusy ? '正在生成…' : '点一个就替换'
    const spacer = document.createElement('span')
    spacer.className = 'spacer'
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'assist-x'
    close.dataset.suggestClose = '1'
    close.title = '收起'
    close.textContent = '×'
    head.append(title, hint, spacer, close)
    box.append(head)

    for (const suggestion of state.suggestions) {
      const row = document.createElement('div')
      row.className = 'assist-chip-row'
      const cn = document.createElement('span')
      cn.className = 'chip-cn'
      cn.textContent = suggestion.text
      row.append(cn)
      for (const option of suggestion.options) {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = `assist-chip ${option.register}`
        chip.dataset.pick = suggestion.id
        chip.dataset.pickEn = option.en
        chip.title = option.register === 'concise' ? '更短' : '最自然'
        chip.textContent = option.en
        row.append(chip)
      }
      if (suggestion.note) {
        const note = document.createElement('span')
        note.className = 'chip-note'
        note.textContent = suggestion.note
        row.append(note)
      }
      box.append(row)
    }

    return box
  }

  /* ---------------------------------------------------------------- */
  /* events                                                            */
  /* ---------------------------------------------------------------- */

  bind() {
    this.listEl.addEventListener('click', (event) => this.onClick(event))
    this.listEl.addEventListener('input', (event) => this.onInput(event))
    this.listEl.addEventListener('compositionstart', (event) => {
      const body = event.target.closest?.('.note-body')
      if (body) this.composing.add(body)
    })
    this.listEl.addEventListener('compositionend', (event) => {
      const body = event.target.closest?.('.note-body')
      if (!body) return
      this.composing.delete(body)
      this.schedule(body)
    })
  }

  onClick(event) {
    const target = event.target
    const card = target.closest?.('.note-card')
    if (!card) return
    const item = this.item(card)
    if (!item) return

    if (target.closest('[data-note-check]')) {
      event.preventDefault()
      this.runCheck(card, item)
      return
    }
    if (target.closest('[data-assist-close]')) {
      const state = this.of(item.id)
      state.check = null
      state.applied = new Set()
      this.render(card, item)
      return
    }
    if (target.closest('[data-suggest-close]')) {
      const state = this.of(item.id)
      state.suggestions = []
      this.render(card, item)
      return
    }
    const apply = target.closest('[data-apply]')
    if (apply) {
      event.preventDefault()
      this.applyIssue(card, item, Number(apply.dataset.apply))
      return
    }
    if (target.closest('[data-apply-all]')) {
      event.preventDefault()
      this.applyAll(card, item)
      return
    }
    const chip = target.closest('[data-pick]')
    if (chip) {
      event.preventDefault()
      this.pick(card, item, chip.dataset.pick, chip.dataset.pickEn)
    }
  }

  onInput(event) {
    const body = event.target.closest?.('.note-body')
    if (!body) return
    const card = body.closest('.note-card')
    const item = this.item(card)
    if (item) this.renderTools(card, item, this.of(item.id))
    if (this.composing.has(body)) return
    this.schedule(body)
  }

  /** Debounced: ask for English options only after typing stops. */
  schedule(body) {
    const card = body.closest('.note-card')
    const item = this.item(card)
    if (!item) return
    const state = this.of(item.id)
    clearTimeout(this.timers.get(item.id))
    if (!englishSettings.enabled) {
      if (state.suggestions.length) {
        state.suggestions = []
        this.render(card, item)
      }
      return
    }
    const text = String(item.body || '')
    if (!hasChinese(text)) {
      if (state.suggestions.length) {
        state.suggestions = []
        this.render(card, item)
      }
      return
    }
    this.timers.set(
      item.id,
      setTimeout(() => this.requestSuggest(card, item), DEBOUNCE_MS),
    )
  }

  /* ---------------------------------------------------------------- */
  /* requests                                                          */
  /* ---------------------------------------------------------------- */

  async requestSuggest(card, item) {
    const state = this.of(item.id)
    const text = String(item.body || '')
    if (!hasChinese(text)) return
    const segments = chineseSegments(text)
    if (!segments.length) return
    state.suggestBusy = true
    state.error = ''
    this.render(card, item)
    try {
      const data = await englishApi.suggest(
        text.slice(0, 4000),
        segments.map(({ id, text: segment, left, right }) => ({ id, text: segment, left, right })),
      )
      const byId = new Map(segments.map((segment) => [segment.id, segment.text]))
      state.suggestions = (data.suggestions || []).map((entry) => ({
        ...entry,
        text: byId.get(entry.id) || '',
      }))
      if (state.suggestions.length === 0) state.error = '这段中文没有常见的对应表达，先自己写一句试试'
    } catch (error) {
      state.error = error.message || '生成建议失败'
      state.suggestions = []
    } finally {
      state.suggestBusy = false
      if (this.notes.items.some((note) => note.id === item.id)) this.render(card, item)
    }
  }

  async runCheck(card, item) {
    const state = this.of(item.id)
    const text = String(item.body || '')
    if (!text.trim() || state.busy) return
    state.busy = true
    state.error = ''
    state.applied = new Set()
    this.enhance(card, item)
    try {
      const data = await englishApi.check(text)
      state.check = { issues: data.issues || [], corrected: data.corrected || text, summary: data.summary || '' }
      if (typeof data.meta?.mock === 'boolean' && data.meta.mock) state.mock = true
    } catch (error) {
      state.check = null
      state.error = error.message || '检查失败'
    } finally {
      state.busy = false
      if (this.notes.items.some((note) => note.id === item.id)) this.enhance(card, item)
    }
  }

  /* ---------------------------------------------------------------- */
  /* applying                                                          */
  /* ---------------------------------------------------------------- */

  applyIssue(card, item, index) {
    const state = this.of(item.id)
    const issue = state.check?.issues?.[index]
    if (!issue) return
    const body = String(item.body || '')
    const at = body.indexOf(issue.original)
    if (at < 0) {
      state.error = '正文已经变了，重新点一次检查'
      this.render(card, item)
      return
    }
    const next = body.slice(0, at) + issue.replacement + body.slice(at + issue.original.length)
    this.notes.setBody(item.id, next)
    state.applied.add(index)
    state.check = { ...state.check, issues: state.check.issues, summary: `已应用 ${state.applied.size} 处` }
    this.enhance(card, item)
  }

  applyAll(card, item) {
    const state = this.of(item.id)
    if (!state.check) return
    this.notes.setBody(item.id, state.check.corrected)
    state.applied = new Set(state.check.issues.map((_, index) => index))
    state.check = { ...state.check, summary: '已全部应用' }
    this.enhance(card, item)
  }

  pick(card, item, id, english) {
    const state = this.of(item.id)
    const suggestion = state.suggestions.find((entry) => entry.id === id)
    if (!suggestion) return
    const body = String(item.body || '')
    const at = body.indexOf(suggestion.text)
    if (at < 0) {
      state.suggestions = []
      state.error = '正文已经变了，再停一下重新生成'
      this.render(card, item)
      return
    }
    const next = body.slice(0, at) + english + body.slice(at + suggestion.text.length)
    this.notes.setBody(item.id, next)
    state.suggestions = []
    state.error = ''
    this.enhance(card, item)
    // Put the caret right after the inserted English so typing can continue.
    const textarea = card.querySelector('.note-body')
    if (textarea) {
      const caret = at + english.length
      textarea.focus({ preventScroll: true })
      textarea.setSelectionRange(caret, caret)
    }
  }
}
