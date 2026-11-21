// Floating action bar for the source editor.
//
// The editor is a textarea, so there is no DOM Range to anchor to: the caller
// measures a caret rect with a mirror element and hands it over. The bar itself
// only knows how to place itself and which action was clicked.

import { hasChinese } from './api.js'

const PAD = 30

export class EditBar {
  constructor({ onAction = null } = {}) {
    this.onAction = onAction
    this.owner = null
    this.selection = null
    this.build()
    this.bind()
  }

  build() {
    const bar = document.createElement('div')
    bar.className = 'en-bar en-bar-edit'
    bar.hidden = true
    bar.setAttribute('role', 'toolbar')
    bar.innerHTML = `
      <button type="button" data-en="check">检查优化</button>
      <button type="button" data-en="en-zh">英→中</button>
      <button type="button" data-en="en-en">英→英</button>
      <button type="button" data-en="replace">替换</button>
      <button type="button" data-en="zh-en" hidden>→EN</button>
      <span class="en-bar-sep"></span>
      <button type="button" class="en-bar-x" data-en="close" title="关闭 (Esc)">×</button>`
    document.body.append(bar)
    this.bar = bar
  }

  bind() {
    // Keep the textarea selection: clicking the bar must not steal focus.
    this.bar.addEventListener('mousedown', (event) => event.preventDefault())
    this.bar.addEventListener('click', (event) => {
      const button = event.target.closest('[data-en]')
      if (!button) return
      const act = button.dataset.en
      if (act === 'close') {
        this.hide()
        return
      }
      if (!this.owner || !this.selection) return
      this.onAction?.(act, { pane: this.owner, selection: this.selection })
    })
    document.addEventListener(
      'mousedown',
      (event) => {
        if (this.bar.hidden) return
        if (this.bar.contains(event.target)) return
        if (event.target instanceof Element && event.target.closest('.assist-panel')) return
        if (event.target === this.owner?.editorEl) return
        this.hide()
      },
      true,
    )
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape' || this.bar.hidden) return
        event.preventDefault()
        event.stopPropagation()
        this.hide()
      },
      true,
    )
  }

  /** Show for a non-collapsed editor selection. */
  show(pane, selection, rect) {
    if (!selection || !rect) {
      this.hide()
      return
    }
    this.owner = pane
    this.selection = selection
    this.bar.querySelector('[data-en="zh-en"]').hidden = !hasChinese(selection.text)
    // Chinese selections never need a replace card; English never needs →EN.
    this.bar.querySelector('[data-en="replace"]').hidden = hasChinese(selection.text)
    this.bar.hidden = false
    this.place(rect)
  }

  place(rect) {
    const width = this.bar.offsetWidth || 300
    const height = this.bar.offsetHeight || 32
    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - width / 2, 8),
      window.innerWidth - width - 8,
    )
    const below = rect.bottom + 8 + height
    const top = below < window.innerHeight - 8 ? rect.bottom + 8 : Math.max(8, rect.top - height - 8)
    this.bar.style.left = `${Math.round(left)}px`
    this.bar.style.top = `${Math.round(top)}px`
  }

  /** Follow the caret while the reader keeps editing with a selection. */
  follow(pane, selection, rect) {
    if (this.bar.hidden || this.owner !== pane) return
    if (!selection || !rect || !this.sameRange(selection)) {
      this.hide()
      return
    }
    this.selection = selection
    this.place(rect)
  }

  sameRange(selection) {
    return (
      !!this.selection &&
      this.selection.start === selection.start &&
      this.selection.end === selection.end
    )
  }

  hide() {
    this.bar.hidden = true
    this.selection = null
  }

  /** True when the open bar belongs to this pane (used to avoid double work). */
  owns(pane) {
    return !this.bar.hidden && this.owner === pane
  }

  /** PAD is exported through the class for callers that clamp hit tests. */
  static get pad() {
    return PAD
  }
}
