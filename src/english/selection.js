// Selection actions for either pane: pick a sentence in the PDF text layer, a
// Markdown block or a TXT paragraph, then translate it without leaving the page.
//
// The bar is deliberately independent from the viewer: it listens in the capture
// phase so it sees the selection before notes mode consumes it, and it never
// touches the pane's own DOM.

import { englishApi, englishSettings, hasChinese } from './api.js'

const MAX_CHARS = 1200
const PAD = 26

const BLOCK_SELECTOR = 'p, li, td, th, blockquote, h1, h2, h3, h4, h5, h6, pre, dd, dt, .textLayer'

export class SelectionBar {
  constructor({ onSaveToNote = null, canSaveToNote = null } = {}) {
    this.onSaveToNote = onSaveToNote
    this.canSaveToNote = canSaveToNote
    this.selection = null
    this.result = null
    this.busy = false
    this.build()
    this.bind()
  }

  /* ---------------------------------------------------------------- */
  /* markup                                                            */
  /* ---------------------------------------------------------------- */

  build() {
    const bar = document.createElement('div')
    bar.className = 'en-bar'
    bar.hidden = true
    bar.setAttribute('role', 'toolbar')
    bar.innerHTML = `
      <span class="en-bar-label">选中</span>
      <button type="button" data-en="en-zh">中译</button>
      <button type="button" data-en="en-en">简释</button>
      <button type="button" data-en="zh-en" hidden>→EN</button>
      <span class="en-bar-sep"></span>
      <button type="button" class="en-bar-x" data-en="close" title="关闭 (Esc)">×</button>`
    document.body.append(bar)

    const card = document.createElement('div')
    card.className = 'en-card'
    card.hidden = true
    card.innerHTML = `
      <div class="en-card-head">
        <span class="en-card-title">译文</span>
        <span class="en-card-badge" hidden>模拟</span>
        <span class="spacer"></span>
        <button type="button" class="en-card-x" data-en="close" title="关闭 (Esc)">×</button>
      </div>
      <div class="en-card-body">
        <p class="en-main">翻译中…</p>
        <ul class="en-notes"></ul>
      </div>
      <div class="en-card-foot">
        <button type="button" class="btn" data-en="copy">复制</button>
        <button type="button" class="btn" data-en="to-note">存成笔记</button>
      </div>`
    document.body.append(card)

    this.bar = bar
    this.card = card
    this.mainEl = card.querySelector('.en-main')
    this.notesEl = card.querySelector('.en-notes')
    this.badgeEl = card.querySelector('.en-card-badge')
    this.titleEl = card.querySelector('.en-card-title')
    this.toNoteBtn = card.querySelector('[data-en="to-note"]')
  }

  /* ---------------------------------------------------------------- */
  /* events                                                            */
  /* ---------------------------------------------------------------- */

  bind() {
    // Capture phase: notes mode clears the selection on mouseup, so the bar has
    // to read it first.
    document.addEventListener(
      'mouseup',
      (event) => {
        if (this.owns(event.target)) return
        this.readSelection(event, true)
      },
      true,
    )
    document.addEventListener(
      'dblclick',
      (event) => {
        if (this.owns(event.target)) return
        setTimeout(() => this.readSelection(event, false), 0)
      },
      true,
    )

    document.addEventListener(
      'mousedown',
      (event) => {
        if (this.owns(event.target)) return
        this.hide()
      },
      true,
    )
    // Any scroll moves the sentence, so the bar rides along with it. The Range
    // is cloned because notes mode clears the live selection on mouseup.
    document.addEventListener(
      'scroll',
      (event) => {
        const target = event.target
        if (target instanceof Element && target.closest('.notes-panel')) return
        this.followScroll()
      },
      true,
    )
    window.addEventListener('resize', () => this.hide())
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      if (!this.card.hidden || !this.bar.hidden) {
        event.preventDefault()
        event.stopPropagation()
        this.hide()
      }
    }, true)

    this.bar.addEventListener('mousedown', (event) => event.preventDefault())
    this.bar.addEventListener('click', (event) => {
      const button = event.target.closest('[data-en]')
      if (!button) return
      const act = button.dataset.en
      if (act === 'close') this.hide()
      else this.run(act)
    })
    this.card.addEventListener('click', (event) => {
      const button = event.target.closest('[data-en]')
      if (!button) return
      const act = button.dataset.en
      if (act === 'close') this.hide()
      else if (act === 'copy') this.copy()
      else if (act === 'to-note') this.saveToNote()
    })
  }

  owns(target) {
    return !!(target && (this.bar.contains(target) || this.card.contains(target)))
  }

  /* ---------------------------------------------------------------- */
  /* selection                                                         */
  /* ---------------------------------------------------------------- */

  /** Read the current selection; `guard` rejects a click far from the range. */
  readSelection(event, guard) {
    if (!englishSettings.enabled) return
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return

    const range = selection.getRangeAt(0)
    const node = range.commonAncestorContainer
    const element = node.nodeType === 1 ? node : node.parentElement
    if (!element) return

    const pane = element.closest('.pane')
    const inText = !!element.closest('.md-doc')
    const inPdf = !!element.closest('.page')
    if (!pane || (!inText && !inPdf)) return

    const text = selection.toString().replace(/\s+/g, ' ').trim()
    if (text.length < 2) return
    const rect = range.getBoundingClientRect()
    if (!rect.width && !rect.height) return

    if (guard && event) {
      const { clientX: x, clientY: y } = event
      if (x < rect.left - PAD || x > rect.right + PAD || y < rect.top - PAD || y > rect.bottom + PAD) {
        return
      }
    }

    this.selection = {
      text: text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width },
      range: range.cloneRange(),
      context: this.contextFor(element, text),
    }
    this.showBar()
  }

  /**
   * Keep the bar glued to its sentence while the page scrolls; hide it once the
   * sentence leaves the viewport.
   */
  followScroll() {
    if (!this.selection || (this.bar.hidden && this.card.hidden)) return
    const rect = this.selection.range.getBoundingClientRect()
    if (!rect.width && !rect.height) {
      this.hide()
      return
    }
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      this.hide()
      return
    }
    this.selection.rect = {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
    }
    if (!this.bar.hidden) this.setBarPosition(this.selection.rect)
    if (!this.card.hidden) this.setCardPosition(this.selection.rect)
  }

  /** The surrounding block, so the model sees what the sentence is doing. */
  contextFor(element, text) {
    const block = element.closest(BLOCK_SELECTOR) || element
    const full = (block.textContent || '').replace(/\s+/g, ' ').trim()
    if (full === '' || full.length <= text.length) return ''
    const at = full.indexOf(text.slice(0, 24))
    if (at < 0) return full.slice(0, 1200)
    return full.slice(Math.max(0, at - 600), at + text.length + 600)
  }

  showBar() {
    const { rect, text } = this.selection
    this.setBarPosition(rect)
    const toEn = this.bar.querySelector('[data-en="zh-en"]')
    toEn.hidden = !hasChinese(text)
    this.bar.hidden = false
    this.card.hidden = true
  }

  setBarPosition(rect) {
    const width = this.bar.offsetWidth || 220
    const height = this.bar.offsetHeight || 32
    const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, 8), window.innerWidth - width - 8)
    const below = rect.bottom + 8 + height
    const top = below < window.innerHeight - 8 ? rect.bottom + 8 : Math.max(8, rect.top - height - 8)
    this.bar.style.left = `${Math.round(left)}px`
    this.bar.style.top = `${Math.round(top)}px`
  }

  setCardPosition(rect) {
    const width = this.card.offsetWidth || 380
    const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, 8), window.innerWidth - width - 8)
    const top = Math.min(Math.max(rect.bottom + 10, 8), window.innerHeight - 120)
    this.card.style.left = `${Math.round(left)}px`
    this.card.style.top = `${Math.round(top)}px`
  }

  /* ---------------------------------------------------------------- */
  /* actions                                                           */
  /* ---------------------------------------------------------------- */

  async run(direction) {
    if (!this.selection || this.busy) return
    const selection = this.selection
    this.busy = true
    this.bar.hidden = true
    this.titleEl.textContent = direction === 'en-en' ? '简释' : direction === 'zh-en' ? '英文' : '中译'
    this.badgeEl.hidden = true
    this.mainEl.textContent = '翻译中…'
    this.mainEl.classList.add('busy')
    this.notesEl.textContent = ''
    this.toNoteBtn.disabled = true
    this.setCardPosition(selection.rect)
    this.card.hidden = false

    try {
      const data = await englishApi.translate(
        selection.text,
        direction,
        selection.context ? [{ text: selection.context }] : [],
      )
      this.result = { ...data.result, meta: data.meta || {}, source: selection.text }
      this.mainEl.classList.remove('busy')
      this.mainEl.textContent = data.result.main
      for (const note of data.result.notes || []) {
        const li = document.createElement('li')
        const term = document.createElement('b')
        term.textContent = note.term
        const gloss = document.createTextNode(note.gloss ? ` ${note.gloss}` : '')
        li.append(term, gloss)
        if (note.why) {
          const why = document.createElement('span')
          why.className = 'en-why'
          why.textContent = note.why
          li.append(why)
        }
        this.notesEl.append(li)
      }
      this.badgeEl.hidden = data.meta?.mock !== true
      const canPark = !!this.onSaveToNote && (!this.canSaveToNote || this.canSaveToNote())
      this.toNoteBtn.disabled = !canPark
      this.toNoteBtn.title = canPark ? '把译文写进当前选中的笔记' : '先在这一侧进入笔记模式'
    } catch (error) {
      this.mainEl.classList.remove('busy')
      this.mainEl.textContent = error.message || '翻译失败'
      this.mainEl.classList.add('error')
      this.result = null
    } finally {
      this.busy = false
    }
  }

  async copy() {
    if (!this.result) return
    try {
      await navigator.clipboard.writeText(this.result.main)
      const button = this.card.querySelector('[data-en="copy"]')
      button.textContent = '已复制'
      setTimeout(() => (button.textContent = '复制'), 1200)
    } catch {
      /* clipboard blocked: leave the text on screen to select manually */
    }
  }

  saveToNote() {
    if (!this.result || !this.onSaveToNote) return
    const ok = this.onSaveToNote({
      source: this.result.source,
      translation: this.result.main,
      direction: this.result.direction,
    })
    const button = this.toNoteBtn
    button.textContent = ok ? '已存' : '先开笔记'
    setTimeout(() => (button.textContent = '存成笔记'), 1400)
    if (ok) setTimeout(() => this.hide(), 700)
  }

  hide() {
    this.bar.hidden = true
    this.card.hidden = true
    this.mainEl.classList.remove('error')
  }
}
