// The English assistant panel that lives beside the source editor.
//
// Four jobs, all of them option-first: Chinese fragments get English candidates,
// a selection can be translated, a paragraph can be checked, and a whole
// sentence can be replaced by a better version. Nothing here rewrites the text
// on its own — every write back to the document is one explicit click.

import { chineseSegments, englishApi, englishSettings, hasChinese } from './api.js'

const DEBOUNCE_MS = 900

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

const FOCUS_LABEL = {
  concise: '更短',
  formal: '更正式',
  clear: '更清楚',
  precise: '更精确',
  natural: '更自然',
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(className, text, label) {
  const node = el('button', className, text)
  node.type = 'button'
  if (label) node.title = label
  return node
}

/** How much of the selection to echo in the panel header. */
function brief(text, max = 46) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

export class EditAssist {
  constructor({ bodyEl, scopeEl, statusEl, hintEl }) {
    this.bodyEl = bodyEl
    this.scopeEl = scopeEl
    this.statusEl = statusEl
    this.hintEl = hintEl
    this.pane = null
    this.seq = 0
    this.timer = 0
    this.suggest = { key: '', paragraph: null, items: [], busy: false }
    this.build()
  }

  build() {
    this.suggestHost = el('div', 'assist-block-host')
    this.resultHost = el('div', 'assist-block-host')
    this.bodyEl.append(this.suggestHost, this.resultHost)
    this.bodyEl.addEventListener('click', (event) => this.onClick(event))
  }

  /* ---------------------------------------------------------------- */
  /* lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  attach(pane) {
    this.pane = pane
    this.seq++
    clearTimeout(this.timer)
    this.suggest = { key: '', paragraph: null, items: [], busy: false }
    this.suggestHost.textContent = ''
    this.resultHost.textContent = ''
    this.setScope(null)
    this.setStatus('')
    this.syncHint()
  }

  detach() {
    this.seq++
    clearTimeout(this.timer)
    this.pane = null
    this.suggestHost.textContent = ''
    this.resultHost.textContent = ''
  }

  syncHint() {
    if (!this.hintEl) return
    const usable = !!this.pane && englishSettings.enabled
    this.hintEl.hidden = !usable && !!this.pane
    this.hintEl.textContent = englishSettings.enabled
      ? '选中一句话就会出现按钮；打中文停一下会给英文候选。'
      : '英文助手已关（顶部「设置」里重新打开）。'
  }

  setScope(selection) {
    if (!this.scopeEl) return
    if (!selection) {
      this.scopeEl.textContent = '未选中'
      this.scopeEl.title = ''
      return
    }
    const chinese = hasChinese(selection.text)
    this.scopeEl.textContent = `选中 ${selection.text.length} 字 · ${chinese ? '中文' : '英文'}`
    this.scopeEl.title = brief(selection.text, 200)
  }

  setStatus(text, bad = false) {
    if (!this.statusEl) return
    this.statusEl.textContent = text || ''
    this.statusEl.hidden = !text
    this.statusEl.classList.toggle('bad', !!bad)
  }

  /* ---------------------------------------------------------------- */
  /* ① Chinese fragments -> English candidates (automatic)              */
  /* ---------------------------------------------------------------- */

  /** Called on every keystroke; only the paragraph under the caret counts. */
  onInput(pane) {
    if (this.pane !== pane) return
    if (!englishSettings.enabled) return
    const paragraph = pane.paragraphAt()
    if (!paragraph.text.trim()) return
    clearTimeout(this.timer)
    if (!hasChinese(paragraph.text)) {
      if (this.suggest.paragraph) this.clearSuggest()
      return
    }
    const key = `${paragraph.start}:${paragraph.end}`
    if (this.suggest.paragraph && this.suggest.key === key && this.suggest.items.length) return
    this.timer = setTimeout(() => this.requestSuggest(pane, paragraph), DEBOUNCE_MS)
  }

  async requestSuggest(pane, paragraph) {
    if (this.pane !== pane) return
    const segments = chineseSegments(paragraph.text).map((segment) => ({
      ...segment,
      start: paragraph.start + segment.start,
      end: paragraph.start + segment.end,
    }))
    if (!segments.length) return
    const seq = ++this.seq
    this.suggest = {
      key: `${paragraph.start}:${paragraph.end}`,
      paragraph,
      items: [],
      busy: true,
      segments,
      error: '',
    }
    this.renderSuggest()
    try {
      const data = await englishApi.suggest(
        paragraph.text.slice(0, 4000),
        segments.map(({ id, text, left, right }) => ({ id, text, left, right })),
      )
      if (seq !== this.seq || this.pane !== pane) return
      const byId = new Map(segments.map((segment) => [segment.id, segment]))
      this.suggest.items = (data.suggestions || [])
        .map((entry) => ({ ...entry, segment: byId.get(entry.id) }))
        .filter((entry) => !!entry.segment)
      this.suggest.usage = data.usage
      if (!this.suggest.items.length) {
        this.suggest.error = '这段中文没有常见的对应表达，先自己写一句试试'
      }
    } catch (error) {
      if (seq !== this.seq) return
      this.suggest.items = []
      this.suggest.error = error.message || '生成建议失败'
    } finally {
      if (seq === this.seq) {
        this.suggest.busy = false
        this.renderSuggest()
      }
    }
  }

  clearSuggest() {
    this.suggest = { key: '', paragraph: null, items: [], busy: false }
    this.suggestHost.textContent = ''
  }

  renderSuggest() {
    this.suggestHost.textContent = ''
    const state = this.suggest
    if (!state.paragraph) return
    const card = el('div', 'assist-card')
    const head = el('div', 'assist-card-head')
    head.append(el('span', 'assist-card-title', '中文候选'))
    head.append(el('span', 'assist-card-sub', state.busy ? '生成中…' : '点一条就替换'))
    head.append(el('span', 'spacer'))
    const close = button('assist-x', '×', '收起')
    close.dataset.act = 'close-suggest'
    head.append(close)
    card.append(head)

    const para = el('div', 'assist-paragraph', brief(state.paragraph.text, 220))
    card.append(para)

    if (state.error) card.append(el('div', 'assist-error', state.error))

    for (const item of state.items) {
      const row = el('div', 'assist-chip-row')
      row.append(el('span', 'chip-cn', item.segment.text))
      for (const option of item.options) {
        const chip = button(`assist-chip ${option.register}`, option.en)
        chip.dataset.act = 'pick'
        chip.dataset.id = item.id
        chip.dataset.en = option.en
        chip.title = option.register === 'concise' ? '更短' : '最自然'
        row.append(chip)
      }
      if (item.note) row.append(el('span', 'chip-note', item.note))
      card.append(row)
    }
    this.suggestHost.append(card)
  }

  /* ---------------------------------------------------------------- */
  /* ② translate a selection                                           */
  /* ---------------------------------------------------------------- */

  async runTranslate(pane, selection, direction) {
    if (!this.allow()) return
    const seq = ++this.seq
    const title = direction === 'en-en' ? '英→英' : direction === 'zh-en' ? '→EN' : '英→中'
    const card = this.beginCard(title, brief(selection.text))
    const body = el('div', 'assist-card-body')
    const main = el('p', 'assist-main busy', '翻译中…')
    body.append(main)
    const notes = el('ul', 'assist-notes')
    body.append(notes)
    card.append(body)
    this.setResult(card)

    try {
      const context = this.contextFor(pane, selection)
      const data = await englishApi.translate(selection.text, direction, context)
      if (seq !== this.seq) return
      main.classList.remove('busy')
      main.textContent = data.result.main
      for (const note of data.result.notes || []) {
        const li = el('li')
        li.append(el('b', '', note.term))
        if (note.gloss) li.append(document.createTextNode(` ${note.gloss}`))
        if (note.why) li.append(el('span', 'assist-why', note.why))
        notes.append(li)
      }
      card.append(this.cardFoot(data))
    } catch (error) {
      if (seq !== this.seq) return
      main.classList.remove('busy')
      main.classList.add('error')
      main.textContent = error.message || '翻译失败'
    }
  }

  /* ---------------------------------------------------------------- */
  /* ③ check: errors and improvements together                         */
  /* ---------------------------------------------------------------- */

  async runCheck(pane, scope, title = '检查优化') {
    if (!this.allow()) return
    if (!scope.text.trim()) {
      this.setStatus('这一段是空的', true)
      return
    }
    const seq = ++this.seq
    const card = this.beginCard(title, brief(scope.text))
    const body = el('div', 'assist-card-body')
    body.append(el('p', 'assist-main busy', '检查中…'))
    card.append(body)
    this.setResult(card)

    try {
      const data = await englishApi.check(scope.text)
      if (seq !== this.seq) return
      body.textContent = ''
      const issues = data.issues || []
      const summary = el('div', 'assist-summary', data.summary || '')
      body.append(summary)
      if (issues.length === 0) {
        body.append(el('div', 'assist-empty', '这一段没挑出问题。'))
      } else {
        const all = button('btn assist-apply-all', '全部应用', '把所有建议一次改完')
        all.dataset.act = 'apply-all'
        all.dataset.scopeStart = String(scope.start)
        all.dataset.scopeEnd = String(scope.end)
        all.dataset.corrected = data.corrected || ''
        summary.append(document.createTextNode(' '), all)

        const preview = this.buildPreview(scope.text, issues)
        body.append(preview)

        issues.forEach((issue, index) => {
          const row = el('div', 'assist-issue')
          const tag = el('span', `tag ${issue.severity === 'error' ? 'error' : 'improve'}`)
          tag.textContent = TYPE_LABEL[issue.type] || issue.type
          row.append(tag)
          row.append(el('span', 'assist-from', issue.original))
          row.append(el('span', 'assist-arrow', '→'))
          row.append(el('span', 'assist-to', issue.replacement))
          const apply = button('assist-apply', '应用')
          apply.dataset.act = 'apply-issue'
          apply.dataset.index = String(index)
          apply.dataset.scopeStart = String(scope.start)
          apply.dataset.scopeEnd = String(scope.end)
          apply.dataset.original = issue.original
          apply.dataset.replacement = issue.replacement
          row.append(apply)
          if (issue.message) row.append(el('div', 'assist-msg', issue.message))
          body.append(row)
        })
      }
      card.append(this.cardFoot(data))
    } catch (error) {
      if (seq !== this.seq) return
      body.textContent = ''
      body.append(el('p', 'assist-main error', error.message || '检查失败'))
    }
  }

  buildPreview(text, issues) {
    const preview = el('div', 'assist-preview')
    let from = 0
    const located = []
    for (const issue of issues) {
      const at = text.indexOf(issue.original, from)
      if (at < 0) continue
      located.push({ issue, at })
      from = at + issue.original.length
    }
    let cursor = 0
    for (const { issue, at } of located) {
      if (at < cursor) continue
      if (at > cursor) preview.append(document.createTextNode(text.slice(cursor, at)))
      const mark = el(
        'span',
        issue.severity === 'error' ? 'hl-error' : 'hl-improve',
        issue.original,
      )
      preview.append(mark)
      cursor = at + issue.original.length
    }
    preview.append(document.createTextNode(text.slice(cursor)))
    return preview
  }

  /* ---------------------------------------------------------------- */
  /* ④ replace one sentence with a few better versions                 */
  /* ---------------------------------------------------------------- */

  async runReplace(pane, selection) {
    if (!this.allow()) return
    const seq = ++this.seq
    const card = this.beginCard('替换', brief(selection.text))
    const body = el('div', 'assist-card-body')
    body.append(el('p', 'assist-main busy', '正在重写…'))
    card.append(body)
    this.setResult(card)

    try {
      const data = await englishApi.replace(selection.text, this.contextFor(pane, selection))
      if (seq !== this.seq) return
      body.textContent = ''
      const options = data.options || []
      if (!options.length) {
        body.append(el('div', 'assist-empty', '没想出更好的写法，这句留着也行。'))
      }
      options.forEach((option, index) => {
        const row = el('div', 'assist-option')
        const head = el('div', 'assist-option-head')
        head.append(el('span', 'assist-focus', FOCUS_LABEL[option.focus] || '改写'))
        head.append(el('span', 'spacer'))
        const pick = button('btn assist-pick', '替换')
        pick.dataset.act = 'pick-replace'
        pick.dataset.start = String(selection.start)
        pick.dataset.end = String(selection.end)
        pick.dataset.original = selection.text
        pick.dataset.text = option.text
        head.append(pick)
        row.append(head)
        row.append(el('div', 'assist-option-text', option.text))
        if (option.why) row.append(el('div', 'assist-msg', option.why))
        body.append(row)
      })
      card.append(this.cardFoot(data))
    } catch (error) {
      if (seq !== this.seq) return
      body.textContent = ''
      body.append(el('p', 'assist-main error', error.message || '重写失败'))
    }
  }

  /* ---------------------------------------------------------------- */
  /* wiring                                                            */
  /* ---------------------------------------------------------------- */

  allow() {
    if (!this.pane) return false
    if (!englishSettings.enabled) {
      this.setStatus('英文助手已关闭', true)
      return false
    }
    return true
  }

  /** The paragraph around a selection, used as model context. */
  contextFor(pane, selection) {
    const paragraph = pane.paragraphAt(selection.start)
    const text = paragraph.text.replace(/\s+/g, ' ').trim()
    if (!text || text.length <= selection.text.length) return []
    return [{ text: text.slice(0, 1200) }]
  }

  beginCard(title, subtitle) {
    const card = el('div', 'assist-card assist-result')
    const head = el('div', 'assist-card-head')
    head.append(el('span', 'assist-card-title', title))
    if (subtitle) head.append(el('span', 'assist-card-sub', subtitle))
    head.append(el('span', 'spacer'))
    const copy = button('assist-x', '复制', '复制这一栏的结果')
    copy.dataset.act = 'copy-card'
    const close = button('assist-x', '×', '收起')
    close.dataset.act = 'close-result'
    head.append(copy, close)
    card.append(head)
    return card
  }

  cardFoot(data) {
    const foot = el('div', 'assist-foot')
    const used = data?.usage?.totalTokens
    if (Number.isFinite(used) && used > 0) foot.append(el('span', '', `${used} token`))
    if (data?.meta?.mock) foot.append(el('span', 'assist-mock', '模拟'))
    if (data?.cached) foot.append(el('span', '', '缓存'))
    foot.hidden = foot.childElementCount === 0
    return foot
  }

  setResult(card) {
    this.resultHost.textContent = ''
    this.resultHost.append(card)
  }

  /* ---------------------------------------------------------------- */
  /* applying results back to the document                             */
  /* ---------------------------------------------------------------- */

  onClick(event) {
    const target = event.target
    const act = target.closest?.('[data-act]')?.dataset
    if (!act) return
    const card = target.closest('.assist-card')
    event.preventDefault()

    if (act.act === 'close-suggest') {
      this.clearSuggest()
      return
    }
    if (act.act === 'close-result') {
      this.resultHost.textContent = ''
      return
    }
    if (act.act === 'copy-card') {
      const text = card?.querySelector('.assist-main, .assist-option-text')?.textContent || ''
      if (text) navigator.clipboard?.writeText(text).catch(() => {})
      return
    }
    if (act.act === 'pick') {
      this.applyPickedSuggestion(act.id, act.en)
      return
    }
    if (act.act === 'apply-issue') {
      const start = Number(act.scopeStart)
      const end = Number(act.scopeEnd)
      const issue = { original: act.original, replacement: act.replacement }
      this.applyIssue(start, end, issue)
      return
    }
    if (act.act === 'apply-all') {
      const start = Number(act.scopeStart)
      const end = Number(act.scopeEnd)
      this.applyCorrected(start, end, act.corrected || '')
      return
    }
    if (act.act === 'pick-replace') {
      this.applySpan(Number(act.start), Number(act.end), act.original, act.text)
      this.resultHost.textContent = ''
    }
  }

  applyPickedSuggestion(id, english) {
    const pane = this.pane
    const item = this.suggest.items.find((entry) => entry.id === id)
    if (!pane || !item) return
    const { start, end, text } = item.segment
    if (this.applySpan(start, end, text, english)) {
      // Offsets move after every replacement, so the cards go away and the next
      // keystroke or pause re-asks for the paragraph as it now reads.
      this.clearSuggest()
    }
  }

  applyIssue(scopeStart, scopeEnd, issue) {
    const pane = this.pane
    if (!pane) return
    const scopeText = pane.editorEl.value.slice(scopeStart, scopeEnd)
    const at = scopeText.indexOf(issue.original)
    if (at < 0) {
      this.setStatus('正文已经变了，重新点一次检查', true)
      return
    }
    const start = scopeStart + at
    this.applySpan(start, start + issue.original.length, issue.original, issue.replacement)
  }

  applyCorrected(scopeStart, scopeEnd, corrected) {
    const pane = this.pane
    if (!pane || !corrected) return
    const current = pane.editorEl.value.slice(scopeStart, scopeEnd)
    if (!current.trim()) {
      this.setStatus('正文已经变了，重新点一次检查', true)
      return
    }
    // The corrected text came from this very scope; apply it at the same place.
    pane.applyTextRange(scopeStart, scopeEnd, corrected)
    this.setStatus('已全部应用')
  }

  /** Write one range back, but only if it still holds what we expected. */
  applySpan(start, end, expected, replacement) {
    const pane = this.pane
    if (!pane) return false
    if (pane.editorEl.value.slice(start, end) !== expected) {
      this.setStatus('正文已经变了，重新来一次', true)
      return false
    }
    pane.applyTextRange(start, end, replacement)
    this.setStatus('已替换')
    return true
  }
}
