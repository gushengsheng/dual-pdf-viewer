import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { prefs } from './prefs.js'
import { renderMarkdown } from './markdown.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const PAD = 14
const GAP = 10
const PRELOAD = 2
const MAX_DPR = 2
const MAX_CANVAS_PIXELS = 24_000_000
const MIN_SCALE = 0.12
const MAX_SCALE = 8
const STORE = 'dpv:pos:'

const cMapUrl = new URL('pdfjs/cmaps/', document.baseURI).href
const standardFontDataUrl = new URL('pdfjs/standard_fonts/', document.baseURI).href

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

function readStore(key) {
  try {
    return JSON.parse(localStorage.getItem(STORE + key) || 'null')
  } catch {
    return null
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(STORE + key, JSON.stringify(value))
  } catch {
    /* storage full or disabled; reading still works */
  }
}

const isAbort = (err) =>
  err && (err.name === 'AbortException' || err.name === 'RenderingCancelledException')

/**
 * One completely independent PDF pane: own document, own scroll position,
 * own zoom, own page navigation. Nothing here talks to the other pane.
 */
export class PdfPane {
  constructor(root) {
    this.root = root
    this.scrollEl = root.querySelector('.pane-scroll')
    this.pagesEl = root.querySelector('.pages')
    this.emptyEl = root.querySelector('.empty')
    this.emptyMsg = root.querySelector('.empty-msg')
    this.nameEl = root.querySelector('.file-name')
    this.pageInput = root.querySelector('.page-input')
    this.pageTotalEl = root.querySelector('.page-total')
    this.zoomEl = root.querySelector('.zoom-label')
    this.fileInput = root.querySelector('input[type=file]')
    this.viewEl = root.querySelector('.pane-view')

    // text (markdown) mode container, sits next to the PDF pages
    this.kind = 'pdf'
    this.lastText = ''
    this.mdEl = document.createElement('div')
    this.mdEl.className = 'md-doc'
    this.mdEl.hidden = true
    this.scrollEl.insertBefore(this.mdEl, this.emptyEl)

    this.doc = null
    this.rawBytes = null
    this.fp = ''
    this.dims = []
    this.scale = 1
    this.autoFit = true
    this.gen = 0
    this.offsets = []
    this.rendered = new Map()
    this.pending = new Set()
    this.failed = new Set()
    this.currentPage = 1
    this.rafPending = false
    this.saveTimer = 0
    this.interacting = false
    this.onActivate = null

    // smooth zoom state
    this.visualRel = 1
    this.targetScale = 1
    this.zoomAnchor = null
    this.zoomAnim = false
    this.zoomRAF = 0
    this.lastFrame = 0

    // tools
    this.tool = 'select'
    this.marquee = null
    this.lensTask = null

    // notes
    this.notes = []
    this.noteMode = false
    this.dragOrigin = null
    this.onRegionNote = null
    this.onToggleNotes = null
    this.onNoteBubble = null
    this.onDocLoaded = null

    this.buildOverlay()
    this.bindEvents()
    this.setTool('select')
    this.setEmpty('drag')
    this.updateChrome()
  }

  /* ------------------------------------------------------------------ */
  /* events                                                              */
  /* ------------------------------------------------------------------ */

  bindEvents() {
    const root = this.root

    this.scrollEl.addEventListener(
      'scroll',
      () => {
        this.scheduleVisible()
        this.updateCurrentPage()
        this.scheduleSave()
      },
      { passive: true },
    )

    root.addEventListener('pointerenter', () => this.onActivate?.(this))
    root.addEventListener('pointerdown', () => this.onActivate?.(this))

    this.overlay.addEventListener('pointerdown', (e) => {
      if (this.onPanDown(e)) return
      this.onMarqueeDown(e)
    })

    this.scrollEl.addEventListener('pointerdown', (e) => {
      this.onPanDown(e)
      if (e.button === 0 && !e.target.closest?.('.note-bubble, .lens')) {
        const r = this.scrollEl.getBoundingClientRect()
        this.dragOrigin = { x: e.clientX - r.left, y: e.clientY - r.top }
      }
    })

    this.scrollEl.addEventListener('mouseup', (e) => this.finishDrag(e))
    // A drag that ends outside the pane still counts: window-level backup, the
    // origin guard keeps the other pane from reacting.
    window.addEventListener('mouseup', (e) => {
      if (this.dragOrigin) this.finishDrag(e)
    })
    this.pagesEl.addEventListener('pointerdown', (e) => this.onNoteBubbleDown(e))
    this.viewEl.addEventListener('dblclick', (e) => this.onDblClick(e))

    // The overlay sits above the pages in marquee mode, so wheel/pan have to be
    // forwarded or the document would freeze while a tool is active.
    this.overlay.addEventListener(
      'wheel',
      (e) => {
        if (!this.doc || e.target.closest?.('.lens')) return
        if (e.ctrlKey) {
          this.onWheelZoom(e)
          return
        }
        e.preventDefault()
        const unit = e.deltaMode === 1 ? 16 : 1
        this.scrollEl.scrollTop += e.deltaY * unit
        this.scrollEl.scrollLeft += e.deltaX * unit
      },
      { passive: false },
    )

    this.scrollEl.addEventListener(
      'wheel',
      (e) => this.onWheelZoom(e),
      { passive: false },
    )

    this.pageInput.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') {
        e.preventDefault()
        const n = parseInt(this.pageInput.value, 10)
        if (Number.isFinite(n)) this.goToPage(n)
        this.pageInput.blur()
      } else if (e.key === 'Escape') {
        this.pageInput.blur()
      }
    })
    this.pageInput.addEventListener('focus', () => this.pageInput.select())

    this.pageInput.addEventListener('input', () => {
      this.pageInput.value = this.pageInput.value.replace(/[^\d]/g, '')
    })

    root.addEventListener('click', (e) => {
      const toolBtn = e.target.closest?.('.tool-btn')
      if (toolBtn) {
        this.onActivate?.(this)
        this.setTool(toolBtn.dataset.toolBtn)
        return
      }
      const btn = e.target.closest?.('[data-act]')
      if (!btn) return
      const act = btn.dataset.act
      this.onActivate?.(this)
      if (act === 'open') this.chooseFile()
      else if (act === 'notes') this.onToggleNotes?.(this)
      else if (act === 'zoom-in') this.zoomStep(1)
      else if (act === 'zoom-out') this.zoomStep(-1)
      else if (act === 'fit') this.fitWidth()
    })

    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0]
      if (file) this.openFile(file)
      this.fileInput.value = ''
    })
  }

  /* ------------------------------------------------------------------ */
  /* public api                                                          */
  /* ------------------------------------------------------------------ */

  chooseFile() {
    this.fileInput.click()
  }

  async openFile(file) {
    const name = file.name || ''
    if (/\.(md|markdown|txt)$/i.test(name)) {
      const text = await file.text()
      const fp = `${name}:${file.size}:${file.lastModified}`
      this.loadText(text, { name, fp })
      return
    }
    const buf = await file.arrayBuffer()
    const bytes = new Uint8Array(buf)
    const fp = `${file.name}:${file.size}:${file.lastModified}`
    await this.loadBytes(bytes, { name: file.name, fp })
  }

  /** Markdown / plain text mode: no PDF document, just a rendered article. */
  loadText(text, { name = '未命名.md', fp = '' } = {}) {
    this.gen++
    this.teardown()
    this.kind = 'text'
    this.lastText = String(text ?? '')
    this.rawBytes = null
    this.doc = null
    this.fp = fp || name
    this.nameEl.textContent = name
    this.nameEl.title = name
    this.setTool('select')

    this.pagesEl.hidden = true
    this.mdEl.innerHTML = renderMarkdown(this.lastText)
    this.mdEl.hidden = false
    this.scale = 1
    this.autoFit = true
    this.applyTextZoom()
    this.setEmpty('hidden')
    this.updateChrome()

    this.scrollEl.scrollTop = 0
    const saved = readStore(this.fp)
    if (saved && saved.kind === 'text') {
      if (Number.isFinite(saved.scale)) {
        this.scale = clamp(saved.scale, MIN_SCALE, MAX_SCALE)
        this.applyTextZoom()
      }
      if (Number.isFinite(saved.ratio)) {
        requestAnimationFrame(() => {
          const max = Math.max(1, this.scrollEl.scrollHeight - this.scrollEl.clientHeight)
          this.scrollEl.scrollTop = saved.ratio * max
        })
      }
    }
    this.onDocLoaded?.(this)
  }

  async loadBytes(bytes, { name = '未命名.pdf', fp = '', view = null } = {}) {
    const gen = ++this.gen
    this.teardown()
    this.kind = 'pdf'
    this.mdEl.hidden = true
    this.mdEl.textContent = ''
    this.pagesEl.hidden = false
    this.rawBytes = bytes
    this.fp = fp || name
    this.nameEl.textContent = name
    this.nameEl.title = name
    this.setEmpty('loading')

    let doc = null
    try {
      doc = await this.openDocument(bytes)
    } catch (err) {
      if (gen !== this.gen) return
      this.setEmpty('error', this.describeError(err))
      this.updateChrome()
      return
    }
    if (gen !== this.gen) {
      doc.destroy()
      return
    }

    this.doc = doc
    this.dims = await this.collectDims(doc, gen)
    if (gen !== this.gen || !this.dims.length) return

    const saved = view || readStore(this.fp)
    if (saved && Number.isFinite(saved.scale) && !saved.autoFit) {
      this.autoFit = false
      this.scale = clamp(saved.scale, MIN_SCALE, MAX_SCALE)
    } else {
      this.autoFit = true
      this.scale = this.fitScale()
    }

    this.computeLayout()
    this.destroyAll()
    this.renderVisible()
    this.setEmpty('hidden')
    this.updateChrome()

    if (saved && Number.isFinite(saved.page)) {
      this.restoreAnchor({ page: clamp(saved.page, 1, doc.numPages), frac: saved.frac ?? 0 })
    }
    this.updateCurrentPage()
    this.onDocLoaded?.(this)
  }

  snapshot() {
    if (this.kind === 'text' && !this.mdEl.hidden) {
      const max = Math.max(1, this.scrollEl.scrollHeight - this.scrollEl.clientHeight)
      return {
        kind: 'text',
        text: this.lastText,
        name: this.nameEl.textContent,
        fp: this.fp,
        scale: this.scale,
        ratio: this.scrollEl.scrollTop / max,
      }
    }
    if (!this.doc || !this.rawBytes) return null
    return {
      kind: 'pdf',
      bytes: this.rawBytes,
      name: this.nameEl.textContent,
      fp: this.fp,
      view: { ...this.anchor(), scale: this.scale, autoFit: this.autoFit },
    }
  }

  restore(snap) {
    if (!snap) {
      this.clear()
      return
    }
    if (snap.kind === 'text') {
      this.loadText(snap.text, { name: snap.name, fp: snap.fp })
      return
    }
    this.loadBytes(snap.bytes, { name: snap.name, fp: snap.fp, view: snap.view })
  }

  clear() {
    this.gen++
    this.teardown()
    this.kind = 'pdf'
    this.mdEl.hidden = true
    this.mdEl.textContent = ''
    this.pagesEl.hidden = false
    this.rawBytes = null
    this.fp = ''
    this.nameEl.textContent = '未打开'
    this.nameEl.title = ''
    this.setEmpty('drag')
    this.updateChrome()
    this.onDocLoaded?.(this)
  }

  handleResize() {
    if (!this.doc || this.interacting || this.zoomAnim || this.scrollEl.clientWidth < 60) return
    if (!this.rafPending) {
      this.rafPending = true
      requestAnimationFrame(() => {
        this.rafPending = false
        this.refit()
      })
    }
  }

  /* ------------------------------------------------------------------ */
  /* tools: select / marquee-to-lens                                     */
  /* ------------------------------------------------------------------ */

  buildOverlay() {
    const overlay = document.createElement('div')
    overlay.className = 'overlay'

    const marqueeEl = document.createElement('div')
    marqueeEl.className = 'marquee'
    marqueeEl.hidden = true
    overlay.append(marqueeEl)

    const lensEl = document.createElement('div')
    lensEl.className = 'lens'
    lensEl.hidden = true

    const canvas = document.createElement('canvas')
    canvas.className = 'lens-canvas'

    const bar = document.createElement('div')
    bar.className = 'lens-bar'
    const info = document.createElement('span')
    info.className = 'lens-info'
    const back = document.createElement('button')
    back.type = 'button'
    back.className = 'btn lens-back'
    back.textContent = '回到原视角 (Esc)'
    back.addEventListener('click', (e) => {
      e.stopPropagation()
      this.closeLens()
    })
    bar.append(info, back)

    lensEl.append(canvas, bar)
    overlay.append(lensEl)
    this.viewEl.append(overlay)

    this.overlay = overlay
    this.marqueeEl = marqueeEl
    this.lensEl = lensEl
    this.lensCanvas = canvas
    this.lensInfo = info
  }

  setTool(tool) {
    if (tool !== 'select' && tool !== 'marquee') return
    // Switching tools always dismisses the magnified lens, including pressing
    // the marquee key again while the lens is open.
    if (this.lensEl && !this.lensEl.hidden) this.closeLens()
    this.tool = tool
    this.root.dataset.tool = tool
    for (const btn of this.root.querySelectorAll('.tool-btn')) {
      const on = btn.dataset.toolBtn === tool
      btn.classList.toggle('active', on)
      btn.setAttribute('aria-pressed', String(on))
    }
    if (tool === 'select') {
      this.marquee = null
      this.marqueeEl.hidden = true
    }
  }

  /** Middle-button drag pans the document, in either tool. */
  onPanDown(e) {
    if (e.button !== 1 || !this.doc) return false
    if (e.target.closest?.('.lens')) return false
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const startLeft = this.scrollEl.scrollLeft
    const startTop = this.scrollEl.scrollTop
    this.root.classList.add('panning')

    const move = (ev) => {
      this.scrollEl.scrollLeft = startLeft - (ev.clientX - startX)
      this.scrollEl.scrollTop = startTop - (ev.clientY - startY)
    }
    const finish = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      this.root.classList.remove('panning')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return true
  }

  onMarqueeDown(e) {
    if (this.tool !== 'marquee' || !this.doc || e.button !== 0) return
    if (e.target.closest?.('.lens')) return
    e.preventDefault()

    const box = this.overlay.getBoundingClientRect()
    const start = {
      x: clamp(e.clientX - box.left, 0, box.width),
      y: clamp(e.clientY - box.top, 0, box.height),
    }
    this.marquee = { start, current: start }
    this.marqueeEl.hidden = false
    this.paintMarquee()

    const move = (ev) => {
      if (!this.marquee) return
      this.marquee.current = {
        x: clamp(ev.clientX - box.left, 0, box.width),
        y: clamp(ev.clientY - box.top, 0, box.height),
      }
      this.paintMarquee()
    }
    const finish = (ev) => {
      this.overlay.removeEventListener('pointermove', move)
      this.overlay.removeEventListener('pointerup', finish)
      this.overlay.removeEventListener('pointercancel', finish)
      try {
        this.overlay.releasePointerCapture(ev.pointerId)
      } catch {
        /* ignore */
      }
      const rect = this.marqueeRect()
      this.marquee = null
      this.marqueeEl.hidden = true
      if (rect && rect.w >= 10 && rect.h >= 10) {
        if (this.noteMode) {
          const anchor = this.anchorFromRect(rect)
          if (anchor) this.onRegionNote?.(anchor)
        } else {
          this.openLens(rect)
        }
      }
    }
    this.overlay.addEventListener('pointermove', move)
    this.overlay.addEventListener('pointerup', finish)
    this.overlay.addEventListener('pointercancel', finish)
    try {
      this.overlay.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  marqueeRect() {
    const m = this.marquee
    if (!m) return null
    const x = Math.min(m.start.x, m.current.x)
    const y = Math.min(m.start.y, m.current.y)
    return { x, y, w: Math.abs(m.current.x - m.start.x), h: Math.abs(m.current.y - m.start.y) }
  }

  paintMarquee() {
    const r = this.marqueeRect()
    if (!r) return
    this.marqueeEl.style.left = `${r.x}px`
    this.marqueeEl.style.top = `${r.y}px`
    this.marqueeEl.style.width = `${r.w}px`
    this.marqueeEl.style.height = `${r.h}px`
  }

  /**
   * Magnify the marquee region inside the pane: the lens is capped at 80% of the
   * pane on each axis, keeps the region's aspect ratio, and the main view stays
   * exactly where it was (so "回到原视角" is just closing the lens).
   */
  async openLens(rect) {
    if (!this.doc || !this.offsets.length) return
    const sx = this.scrollEl.scrollLeft + rect.x
    const sy = this.scrollEl.scrollTop + rect.y

    let idx = 0
    for (let i = 0; i < this.offsets.length; i++) {
      if (this.offsets[i].top <= sy) idx = i
      else break
    }
    const off = this.offsets[idx]
    if (!off) return

    const x0 = clamp(sx, off.left, off.left + off.w)
    const y0 = clamp(sy, off.top, off.top + off.h)
    const x1 = clamp(sx + rect.w, off.left, off.left + off.w)
    const y1 = clamp(sy + rect.h, off.top, off.top + off.h)
    const cw = x1 - x0
    const ch = y1 - y0
    if (cw < 6 || ch < 6) return

    const xPt = (x0 - off.left) / this.scale
    const yPt = (y0 - off.top) / this.scale
    const wPt = cw / this.scale
    const hPt = ch / this.scale

    const viewW = this.viewEl.clientWidth
    const viewH = this.viewEl.clientHeight
    const BAR_H = 32
    const maxW = Math.max(140, viewW * 0.8)
    const maxH = Math.max(100, viewH * 0.8 - BAR_H)
    const aspect = wPt / hPt

    let bw = maxW
    let bh = bw / aspect
    if (bh > maxH) {
      bh = maxH
      bw = bh * aspect
    }

    const lensScale = bw / wPt
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    this.closeLens()
    const canvas = this.lensCanvas
    canvas.width = Math.max(1, Math.round(bw * dpr))
    canvas.height = Math.max(1, Math.round(bh * dpr))
    canvas.style.width = `${bw}px`
    canvas.style.height = `${bh}px`
    this.lensEl.style.width = `${bw}px`
    this.lensEl.hidden = false
    this.lensInfo.textContent = `第 ${idx + 1} 页 · ${(lensScale / this.scale).toFixed(1)}×`

    let page
    try {
      page = await this.doc.getPage(idx + 1)
    } catch {
      return
    }
    if (this.lensEl.hidden) return

    const ctx = canvas.getContext('2d', { alpha: false })
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const viewport = page.getViewport({ scale: lensScale })
    const task = page.render({
      canvasContext: ctx,
      viewport,
      transform: [dpr, 0, 0, dpr, -xPt * lensScale * dpr, -yPt * lensScale * dpr],
    })
    this.lensTask = task
    try {
      await task.promise
    } catch (err) {
      if (!isAbort(err)) console.warn('lens render failed', err)
    }
    if (this.lensTask === task) this.lensTask = null
  }

  closeLens() {
    if (this.lensTask) {
      try {
        this.lensTask.cancel()
      } catch {
        /* ignore */
      }
      this.lensTask = null
    }
    this.lensEl.hidden = true
    this.lensEl.style.width = ''
    this.lensCanvas.width = 0
    this.lensCanvas.height = 0
  }

  /* ------------------------------------------------------------------ */
  /* notes: selection bubble + anchors that survive zoom/scroll          */
  /* ------------------------------------------------------------------ */

  setNotes(list) {
    this.notes = Array.isArray(list) ? list : []
    this.renderNoteBubbles()
  }

  renderNoteBubbles() {
    if (!this.pagesEl) return
    for (const el of this.pagesEl.querySelectorAll('.note-bubble')) el.remove()
    this.notes.forEach((n, i) => {
      const bubble = document.createElement('button')
      bubble.type = 'button'
      bubble.className = 'note-bubble'
      bubble.dataset.noteId = n.id
      bubble.dataset.idx = String(i)
      bubble.textContent = '✎'
      bubble.title = `第 ${n.page} 页的笔记`
      this.pagesEl.append(bubble)
    })
    this.positionNoteBubbles()
  }

  positionNoteBubbles() {
    if (!this.pagesEl || !this.offsets.length) return
    const SIZE = 18
    for (const el of this.pagesEl.querySelectorAll('.note-bubble')) {
      const n = this.notes[Number(el.dataset.idx)]
      const off = n ? this.offsets[n.page - 1] : null
      if (!n || !off) {
        el.style.display = 'none'
        continue
      }
      el.style.display = ''
      let x = off.left - SIZE - 5
      if (x < 2) x = Math.max(2, off.left + 4)
      const y = clamp(
        off.top + n.yPt * this.scale - SIZE / 2,
        off.top + 2,
        off.top + off.h - SIZE - 2,
      )
      el.style.left = `${x}px`
      el.style.top = `${y}px`
    }
  }

  onNoteBubbleDown(e) {
    const bubble = e.target.closest?.('.note-bubble')
    if (!bubble) return
    e.preventDefault()
    e.stopPropagation()
    this.onNoteBubble?.(bubble.dataset.noteId)
  }

  /**
   * Notes mode: a finished text selection becomes a note immediately, so the
   * right side never waits for a confirm click. Returns true when it consumed
   * the drag (the region fallback in finishDrag then stays out of the way).
   */
  afterSelection(e) {
    if (this.tool !== 'select' || !this.doc || !this.noteMode) return false
    if (e?.target?.closest?.('.note-bubble')) return false
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount || sel.isCollapsed) return false
    const range = sel.getRangeAt(0)
    if (!this.pagesEl.contains(range.commonAncestorContainer)) return false
    const text = sel.toString().replace(/\s+/g, ' ').trim()
    if (!text) return false
    const start = range.startContainer
    const startEl = start.nodeType === 1 ? start : start.parentElement
    const pageEl = startEl?.closest?.('.page')
    if (!pageEl) return false
    const rect = range.getBoundingClientRect()
    if (!rect.width && !rect.height) return false

    // Only capture a selection the pointer actually finished on. Without this,
    // a stray click far away can re-add an old selection (e.g. after a
    // double-click in the page margin).
    const pad = 24
    const { clientX: px, clientY: py } = e
    if (px < rect.left - pad || px > rect.right + pad || py < rect.top - pad || py > rect.bottom + pad) {
      return false
    }
    const pageRect = pageEl.getBoundingClientRect()
    this.onRegionNote?.({
      page: Number(pageEl.dataset.page),
      xPt: clamp((rect.left - pageRect.left) / this.scale, 0, 100000),
      yPt: clamp((rect.top - pageRect.top) / this.scale, 0, 100000),
      text: text.slice(0, 1000),
    })
    // The quote now lives in the panel; dropping the highlight keeps a later
    // stray click from re-adding the same sentence.
    sel.removeAllRanges()
    return true
  }

  revealNote(note) {
    if (!note || !this.offsets.length) return
    const off = this.offsets[note.page - 1]
    if (!off) return
    const y = off.top + note.yPt * this.scale
    this.scrollEl.scrollTo({
      top: Math.max(0, y - this.scrollEl.clientHeight * 0.35),
      behavior: 'smooth',
    })
    const ring = document.createElement('div')
    ring.className = 'note-flash'
    ring.style.left = `${off.left + note.xPt * this.scale}px`
    ring.style.top = `${y - 4}px`
    ring.style.width = `${Math.min(Math.max(40, off.w - note.xPt * this.scale), 220)}px`
    ring.style.height = '16px'
    this.pagesEl.append(ring)
    setTimeout(() => ring.remove(), 1500)
  }

  onDblClick(e) {
    if (e.target.closest?.('.lens, .note-bubble, .textLayer')) return
    const background =
      e.target === this.scrollEl || e.target === this.pagesEl || !!e.target.closest?.('.empty')
    if (!this.doc || background) this.chooseFile()
  }

  /** Notes mode: the pane button toggles it, and box-drags become notes too. */
  setNoteMode(on) {
    this.noteMode = !!on
    const btn = this.root.querySelector('[data-act="notes"]')
    if (!btn) return
    btn.classList.toggle('active', this.noteMode)
    btn.setAttribute('aria-pressed', String(this.noteMode))
    btn.title = this.noteMode ? '退出这一侧的笔记模式' : '进入这一侧的笔记模式'
  }

  finishDrag(e) {
    const origin = this.dragOrigin
    this.dragOrigin = null
    const consumed = this.afterSelection(e)
    if (consumed) return

    // Select tool + notes mode: a drag that selects nothing is treated as a
    // box around a figure / blank area, which is also worth a note.
    if (!this.noteMode || this.tool !== 'select' || !this.doc || !origin) return
    const r = this.scrollEl.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    if (Math.abs(x - origin.x) < 12 || Math.abs(y - origin.y) < 12) return
    const rect = {
      x: Math.min(x, origin.x),
      y: Math.min(y, origin.y),
      w: Math.abs(x - origin.x),
      h: Math.abs(y - origin.y),
    }
    const anchor = this.anchorFromRect(rect)
    if (anchor) this.onRegionNote?.(anchor)
  }

  /** Viewport-relative box -> { page, xPt, yPt, wPt, hPt, text } anchor. */
  anchorFromRect(rect) {
    if (!this.doc || !this.offsets.length) return null
    const sx = this.scrollEl.scrollLeft + rect.x
    const sy = this.scrollEl.scrollTop + rect.y

    let idx = 0
    for (let i = 0; i < this.offsets.length; i++) {
      if (this.offsets[i].top <= sy) idx = i
      else break
    }
    const off = this.offsets[idx]
    if (!off) return null

    const x0 = clamp(sx, off.left, off.left + off.w)
    const y0 = clamp(sy, off.top, off.top + off.h)
    const x1 = clamp(sx + rect.w, off.left, off.left + off.w)
    const y1 = clamp(sy + rect.h, off.top, off.top + off.h)
    if (x1 - x0 < 6 || y1 - y0 < 6) return null

    const pageEl = this.pagesEl.querySelector(`.page[data-page="${idx + 1}"]`)
    const pr = pageEl?.getBoundingClientRect()
    const text =
      pageEl && pr
        ? this.textInRect(
            {
              left: pr.left + (x0 - off.left),
              top: pr.top + (y0 - off.top),
              right: pr.left + (x1 - off.left),
              bottom: pr.top + (y1 - off.top),
            },
            pageEl,
          )
        : ''

    return {
      page: idx + 1,
      xPt: (x0 - off.left) / this.scale,
      yPt: (y0 - off.top) / this.scale,
      wPt: (x1 - x0) / this.scale,
      hPt: (y1 - y0) / this.scale,
      text,
    }
  }

  textInRect(rect, pageEl) {
    const parts = []
    for (const span of pageEl.querySelectorAll('.textLayer span')) {
      const r = span.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      if (cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom) {
        parts.push(span.textContent)
      }
      if (parts.length > 300) break
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 1000)
  }

  /* ------------------------------------------------------------------ */
  /* zoom / navigation                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Edge-style zoom: Ctrl + wheel (and trackpad pinch, which Chrome reports as
   * ctrl+wheel) interpolates continuously, keeps the point under the cursor
   * pinned, and only re-renders the raster once the gesture settles. During the
   * gesture the pages are CSS-scaled, so the feedback is immediate.
   */
  onWheelZoom(e) {
    if (!e.ctrlKey) return
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.scrollEl.clientHeight : 1
    // One wheel notch (deltaY 100) == prefs.step, but keep the curve smooth for
    // trackpad deltas, which arrive in small continuous values.
    const perNotch = Math.log(1 + prefs.step) / 100
    const factor = Math.exp(-e.deltaY * unit * perNotch)

    if (this.kind === 'text') {
      if (this.mdEl.hidden) return
      e.preventDefault()
      this.setTextScale(this.scale * factor)
      return
    }
    if (!this.doc) return
    e.preventDefault()
    this.autoFit = false
    const anchor =
      prefs.anchor === 'cursor' ? this.makeAnchor(e.clientX, e.clientY) : this.centerAnchor()
    this.zoomTo(this.targetOrScale() * factor, anchor)
  }

  /** One discrete zoom step, used by the +/- keys and buttons. */
  zoomStep(dir) {
    const mult = dir > 0 ? 1 + prefs.step : 1 / (1 + prefs.step)
    if (this.kind === 'text') {
      if (this.mdEl.hidden) return
      this.setTextScale(this.scale * mult)
      return
    }
    if (!this.doc) return
    this.autoFit = false
    this.zoomTo(this.targetOrScale() * mult, this.centerAnchor())
  }

  /** Text panes zoom by scaling the article font size. */
  setTextScale(next) {
    this.scale = clamp(next, 0.6, 3)
    this.autoFit = false
    this.applyTextZoom()
    this.updateChrome()
    this.scheduleSave()
  }

  applyTextZoom() {
    this.mdEl.style.fontSize = `${(15 * this.scale).toFixed(2)}px`
  }

  zoomBy(factor) {
    if (!this.doc) return
    this.autoFit = false
    this.zoomTo(this.targetOrScale() * factor, this.centerAnchor())
  }

  targetOrScale() {
    return this.zoomAnim ? this.targetScale : this.scale
  }

  zoomTo(nextScale, anchor) {
    if (!this.doc || !this.dims.length) return
    const target = clamp(nextScale, MIN_SCALE, MAX_SCALE)
    this.zoomAnchor = anchor
    this.targetScale = target
    if (this.zoomAnim) return
    this.zoomAnim = true
    this.visualRel = 1
    this.pagesEl.classList.add('zooming')
    this.lastFrame = performance.now()
    this.zoomRAF = requestAnimationFrame(this.stepZoom)
  }

  stepZoom = (now) => {
    if (!this.zoomAnim || !this.doc) return
    const dt = Math.min(64, Math.max(1, now - this.lastFrame))
    this.lastFrame = now
    const targetRel = clamp(this.targetScale / this.scale, 0.02, 50)
    const k = 1 - Math.exp(-dt / Math.max(20, prefs.smooth))
    this.visualRel += (targetRel - this.visualRel) * k

    const settled = Math.abs(targetRel - this.visualRel) < 0.0016 * Math.max(1, targetRel)
    if (settled) this.visualRel = targetRel
    this.applyVisual()
    if (settled) {
      this.zoomAnim = false
      this.zoomRAF = 0
      this.commitZoom()
      return
    }
    this.zoomRAF = requestAnimationFrame(this.stepZoom)
  }

  applyVisual() {
    const rel = this.visualRel
    if (Math.abs(rel - 1) < 0.0005) {
      this.pagesEl.style.transform = ''
    } else {
      this.pagesEl.style.transform = `scale(${rel})`
    }
    const visualScale = this.scale * rel
    this.zoomEl.textContent = `${Math.round(visualScale * 100)}%`
    this.syncAnchorScroll()
  }

  syncAnchorScroll() {
    const a = this.zoomAnchor
    if (!a) return
    const off = this.offsets[a.idx]
    if (!off) return
    const rel = this.visualRel
    this.scrollEl.scrollLeft = Math.max(0, (off.left + a.fx * off.w) * rel - a.mx)
    this.scrollEl.scrollTop = Math.max(0, (off.top + a.fy * off.h) * rel - a.my)
  }

  commitZoom() {
    const finalScale = clamp(this.targetScale, MIN_SCALE, MAX_SCALE)
    const a = this.zoomAnchor
    this.pagesEl.style.transform = ''
    this.pagesEl.classList.remove('zooming')
    this.visualRel = 1
    this.scale = finalScale
    this.destroyAll()
    this.computeLayout()
    this.renderVisible()
    if (a) {
      const off = this.offsets[a.idx]
      if (off) {
        this.scrollEl.scrollLeft = Math.max(0, off.left + a.fx * off.w - a.mx)
        this.scrollEl.scrollTop = Math.max(0, off.top + a.fy * off.h - a.my)
      }
    }
    this.zoomAnchor = null
    this.updateChrome()
    this.scheduleSave()
  }

  cancelZoom() {
    if (this.zoomRAF) cancelAnimationFrame(this.zoomRAF)
    this.zoomRAF = 0
    this.zoomAnim = false
    this.visualRel = 1
    this.zoomAnchor = null
    this.pagesEl.style.transform = ''
    this.pagesEl.classList.remove('zooming')
  }

  /** Screen point -> page-relative fraction, stable across scale changes. */
  makeAnchor(clientX, clientY) {
    const rect = this.scrollEl.getBoundingClientRect()
    const mx = clamp(clientX - rect.left, 0, rect.width)
    const my = clamp(clientY - rect.top, 0, rect.height)
    const offs = this.offsets
    if (!offs.length) return { idx: 0, fx: 0.5, fy: 0.5, mx, my }
    const rel = this.visualRel || 1
    const xb = (this.scrollEl.scrollLeft + mx) / rel
    const yb = (this.scrollEl.scrollTop + my) / rel

    let idx = 0
    for (let i = 0; i < offs.length; i++) {
      if (offs[i].top <= yb) idx = i
      else break
    }
    const off = offs[idx]
    return { idx, fx: (xb - off.left) / off.w, fy: (yb - off.top) / off.h, mx, my }
  }

  centerAnchor() {
    const rect = this.scrollEl.getBoundingClientRect()
    return this.makeAnchor(rect.left + rect.width / 2, rect.top + rect.height / 2)
  }

  fitWidth() {
    if (this.kind === 'text') {
      if (this.mdEl.hidden) return
      this.scale = 1
      this.autoFit = true
      this.applyTextZoom()
      this.updateChrome()
      this.scheduleSave()
      return
    }
    if (!this.doc) return
    this.cancelZoom()
    this.autoFit = true
    const anchor = this.anchor()
    this.scale = this.fitScale()
    this.relayout(anchor)
  }

  setScale(next) {
    this.cancelZoom()
    const anchor = this.anchor()
    this.scale = clamp(next, MIN_SCALE, MAX_SCALE)
    this.relayout(anchor)
  }

  refit() {
    if (!this.doc) return
    this.computeLayout()
    if (this.autoFit) {
      const anchor = this.anchor()
      this.scale = this.fitScale()
      this.destroyAll()
      this.computeLayout()
      this.renderVisible()
      this.restoreAnchor(anchor)
      this.updateChrome()
    } else {
      for (const [n, entry] of this.rendered) this.positionPage(entry.el, n)
    }
  }

  relayout(anchor) {
    this.cancelZoom()
    this.destroyAll()
    this.computeLayout()
    this.renderVisible()
    if (anchor) this.restoreAnchor(anchor)
    this.updateChrome()
    this.scheduleSave()
  }

  goToPage(n) {
    if (!this.doc) return
    const page = clamp(Math.round(n) || 1, 1, this.doc.numPages)
    const off = this.offsets[page - 1]
    if (!off) return
    this.scrollEl.scrollTop = Math.max(0, off.top - 4)
    this.currentPage = page
    this.syncPageInput()
    this.scheduleSave()
  }

  scrollBy(delta) {
    this.scrollEl.scrollTop += delta
  }

  /** Keyboard entry point. Returns true when the key was consumed. */
  handleKey(e) {
    const textMode = this.kind === 'text' && !this.mdEl.hidden
    if (!this.doc && !textMode) return false
    if (e.altKey || e.ctrlKey || e.metaKey) return false
    const step = this.scrollEl.clientHeight * 0.88
    switch (e.key) {
      case 'PageDown':
        this.scrollBy(step)
        return true
      case 'PageUp':
        this.scrollBy(-step)
        return true
      case ' ':
        this.scrollBy(e.shiftKey ? -step : step)
        return true
      case 'ArrowDown':
        this.scrollBy(64)
        return true
      case 'ArrowUp':
        this.scrollBy(-64)
        return true
      case 'Home':
        this.scrollEl.scrollTop = 0
        return true
      case 'End':
        this.scrollEl.scrollTop = this.scrollEl.scrollHeight
        return true
      case '+':
      case '=':
        this.zoomStep(1)
        return true
      case '-':
      case '_':
        this.zoomStep(-1)
        return true
      case 'Escape':
        if (!this.lensEl.hidden) {
          this.closeLens()
          return true
        }
        if (this.tool === 'marquee') {
          this.setTool('select')
          return true
        }
        return false
      case '0':
        this.fitWidth()
        return true
      default:
        return false
    }
  }

  /* ------------------------------------------------------------------ */
  /* document plumbing                                                   */
  /* ------------------------------------------------------------------ */

  async openDocument(bytes) {
    let password = ''
    for (let attempt = 0; attempt < 3; attempt++) {
      const params = {
        data: bytes.slice(),
        cMapUrl,
        cMapPacked: true,
        standardFontDataUrl,
      }
      if (password) params.password = password
      try {
        return await pdfjsLib.getDocument(params).promise
      } catch (err) {
        if (err?.name !== 'PasswordException') throw err
        password = window.prompt('这个 PDF 有密码，请输入：') ?? ''
        if (!password) throw err
      }
    }
    throw new Error('密码错误次数过多')
  }

  async collectDims(doc, gen) {
    const dims = []
    for (let i = 1; i <= doc.numPages; i++) {
      if (gen !== this.gen) return []
      const page = await doc.getPage(i)
      const vp = page.getViewport({ scale: 1 })
      dims.push({ w: vp.width, h: vp.height })
      if (i % 40 === 0) await new Promise((r) => setTimeout(r, 0))
    }
    return dims
  }

  fitScale() {
    if (!this.dims.length) return 1
    // Fit to the most common page width, so one stray landscape figure page
    // does not shrink the whole document.
    const counts = new Map()
    for (const d of this.dims) {
      const key = Math.round(d.w)
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    let target = 0
    let best = -1
    for (const [w, c] of counts) {
      if (c > best) {
        best = c
        target = w
      }
    }
    const avail = Math.max(120, this.scrollEl.clientWidth - PAD * 2)
    return clamp(avail / (target || 612), MIN_SCALE, MAX_SCALE)
  }

  computeLayout() {
    const avail = this.scrollEl.clientWidth
    let y = PAD
    this.offsets = this.dims.map((d) => {
      const w = d.w * this.scale
      const h = d.h * this.scale
      const off = { top: y, w, h, left: Math.max(PAD, (avail - w) / 2) }
      y += h + GAP
      return off
    })
    this.pagesEl.style.height = `${Math.max(0, y - GAP + PAD)}px`
    this.positionNoteBubbles()
  }

  positionPage(el, n) {
    const off = this.offsets[n - 1]
    if (!off) return
    el.style.top = `${off.top}px`
    el.style.left = `${off.left}px`
    el.style.width = `${off.w}px`
    el.style.height = `${off.h}px`
    el.style.setProperty('--total-scale-factor', String(this.scale))
  }

  /* ------------------------------------------------------------------ */
  /* virtualised rendering                                               */
  /* ------------------------------------------------------------------ */

  visibleRange() {
    const st = this.scrollEl.scrollTop
    const h = this.scrollEl.clientHeight
    const offs = this.offsets
    if (!offs.length) return [1, 1]
    let lo = 0
    let hi = offs.length - 1
    let first = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (offs[mid].top + offs[mid].h >= st) {
        first = mid
        hi = mid - 1
      } else {
        lo = mid + 1
      }
    }
    let last = first
    while (last + 1 < offs.length && offs[last + 1].top < st + h) last++
    return [first + 1, last + 1]
  }

  scheduleVisible() {
    if (this.rafPending) return
    this.rafPending = true
    requestAnimationFrame(() => {
      this.rafPending = false
      this.renderVisible()
    })
  }

  renderVisible() {
    if (!this.doc || !this.offsets.length) return
    const [a, b] = this.visibleRange()
    const lo = Math.max(1, a - PRELOAD)
    const hi = Math.min(this.doc.numPages, b + PRELOAD)

    for (const n of [...this.rendered.keys()]) {
      if (n < lo || n > hi) this.destroyPage(n)
    }
    for (let n = lo; n <= hi; n++) {
      if (!this.rendered.has(n) && !this.pending.has(n) && !this.failed.has(n)) {
        this.renderPage(n)
      }
    }
  }

  async renderPage(n) {
    const gen = this.gen
    const doc = this.doc
    if (!doc) return
    this.pending.add(n)
    try {
      const page = await doc.getPage(n)
      if (gen !== this.gen) return

      const scale = this.scale
      const viewport = page.getViewport({ scale })
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      let outputScale = dpr
      const area = viewport.width * viewport.height * dpr * dpr
      if (area > MAX_CANVAS_PIXELS) {
        outputScale = Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height))
      }

      const el = document.createElement('div')
      el.className = 'page'
      el.dataset.page = String(n)
      this.positionPage(el, n)

      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.floor(viewport.width * outputScale))
      canvas.height = Math.max(1, Math.floor(viewport.height * outputScale))
      const ctx = canvas.getContext('2d', { alpha: false })
      el.append(canvas)

      const task = page.render({
        canvasContext: ctx,
        viewport,
        transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
      })

      const entry = { el, task, text: null, page }
      this.rendered.set(n, entry)
      this.pagesEl.append(el)

      await task.promise
      if (gen !== this.gen) return

      try {
        const textDiv = document.createElement('div')
        textDiv.className = 'textLayer'
        const textLayer = new pdfjsLib.TextLayer({
          textContentSource: page.streamTextContent({ includeMarkedContent: true }),
          container: textDiv,
          viewport,
        })
        entry.text = textLayer
        el.append(textDiv)
        await textLayer.render()
      } catch (err) {
        if (!isAbort(err)) console.warn(`[${this.fp}] text layer failed on page ${n}`, err)
      }
    } catch (err) {
      if (!isAbort(err)) {
        console.error(`[${this.fp}] render failed on page ${n}`, err)
        this.failed.add(n)
      }
    } finally {
      if (gen === this.gen) this.pending.delete(n)
    }
  }

  destroyPage(n) {
    const entry = this.rendered.get(n)
    if (!entry) return
    this.rendered.delete(n)
    try {
      entry.task?.cancel()
    } catch {
      /* already settled */
    }
    try {
      entry.text?.cancel?.()
    } catch {
      /* already settled */
    }
    entry.el.remove()
    try {
      // Drop the page's parsed operator/font caches; without this, long
      // documents that have been scrolled a lot keep growing.
      entry.page?.cleanup?.()
    } catch {
      /* ignore */
    }
  }

  destroyAll() {
    for (const n of [...this.rendered.keys()]) this.destroyPage(n)
    this.pending.clear()
  }

  teardown() {
    this.cancelZoom()
    this.closeLens()
    this.destroyAll()
    this.pagesEl.textContent = ''
    this.mdEl.hidden = true
    this.mdEl.textContent = ''
    this.lastText = ''
    this.notes = []
    this.offsets = []
    this.dims = []
    this.failed.clear()
    this.currentPage = 1
    if (this.doc) {
      try {
        this.doc.destroy()
      } catch {
        /* ignore */
      }
      this.doc = null
    }
  }

  /* ------------------------------------------------------------------ */
  /* position helpers                                                    */
  /* ------------------------------------------------------------------ */

  anchor() {
    const offs = this.offsets
    if (!offs.length) return { page: 1, frac: 0 }
    const st = this.scrollEl.scrollTop
    let page = 1
    for (let i = 0; i < offs.length; i++) {
      if (offs[i].top <= st + 1) page = i + 1
      else break
    }
    const off = offs[page - 1]
    const frac = off.h ? clamp((st - off.top) / off.h, 0, 1) : 0
    return { page, frac }
  }

  restoreAnchor({ page, frac = 0 }) {
    const off = this.offsets[clamp(page, 1, this.offsets.length) - 1]
    if (!off) return
    this.scrollEl.scrollTop = Math.max(0, off.top + frac * off.h)
  }

  updateCurrentPage() {
    if (this.kind === 'text') return
    const [first] = this.visibleRange()
    this.currentPage = first
    this.syncPageInput()
  }

  syncPageInput() {
    if (document.activeElement === this.pageInput) return
    this.pageInput.value = String(this.currentPage)
  }

  scheduleSave() {
    if (!this.fp) return
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      if (this.kind === 'text') {
        const max = Math.max(1, this.scrollEl.scrollHeight - this.scrollEl.clientHeight)
        writeStore(this.fp, {
          kind: 'text',
          scale: this.scale,
          ratio: this.scrollEl.scrollTop / max,
        })
        return
      }
      if (!this.doc) return
      const a = this.anchor()
      writeStore(this.fp, {
        page: a.page,
        frac: a.frac,
        scale: this.scale,
        autoFit: this.autoFit,
      })
    }, 350)
  }

  /* ------------------------------------------------------------------ */
  /* chrome                                                              */
  /* ------------------------------------------------------------------ */

  setEmpty(mode, message) {
    this.emptyEl.classList.toggle('hidden', mode === 'hidden')
    this.emptyEl.classList.toggle('is-error', mode === 'error')
    this.emptyMsg.textContent =
      message ?? (mode === 'loading' ? '正在打开…' : '拖入 PDF / Markdown 或点「打开」')
  }

  updateChrome() {
    if (this.kind === 'text' && !this.mdEl.hidden) {
      this.pageInput.disabled = true
      this.pageInput.value = ''
      this.pageTotalEl.textContent = '—'
      this.zoomEl.textContent = `${Math.round(this.scale * 100)}%`
      for (const btn of this.root.querySelectorAll(
        '[data-act="fit"], [data-act="zoom-in"], [data-act="zoom-out"]',
      )) {
        btn.disabled = false
      }
      return
    }
    const hasDoc = !!this.doc
    this.pageInput.disabled = !hasDoc
    this.pageTotalEl.textContent = hasDoc ? `/ ${this.doc.numPages}` : '/ –'
    this.zoomEl.textContent = hasDoc ? `${Math.round(this.scale * 100)}%` : '–'
    for (const btn of this.root.querySelectorAll('[data-act="fit"], [data-act="zoom-in"], [data-act="zoom-out"]')) {
      btn.disabled = !hasDoc
    }
    this.syncPageInput()
  }

  describeError(err) {
    if (err?.name === 'PasswordException') return '这个 PDF 需要密码，已取消'
    if (err?.name === 'InvalidPDFException') return '不是有效的 PDF 文件'
    return `打开失败：${err?.message || err}`
  }
}
