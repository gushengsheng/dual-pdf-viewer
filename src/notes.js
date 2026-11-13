// Notes panel: stacked note cards tied to sentences in the active pane.
// Notes are written to localStorage on every change and, in the local app,
// mirrored to a JSON file under notes/ so they survive closing the window.

const STORE = 'dpv:notes:'
const newId = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const isLocal = () => !!window.__DUAL_PDF_LOCAL__

function readKey(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null')
    return Array.isArray(raw?.items) ? raw.items : []
  } catch {
    return []
  }
}

function load(fp) {
  return readKey(STORE + fp)
}

function save(fp, items) {
  try {
    localStorage.setItem(STORE + fp, JSON.stringify({ v: 1, items }))
  } catch {
    /* storage full / disabled */
  }
}

/** Old keys used `name:size:lastModified`; match them by file name. */
function loadLegacy(fp) {
  const name = String(fp).split(':')[0]
  if (!name) return []
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(`${STORE}${name}:`)) continue
    const items = readKey(key)
    if (items.length) return items
  }
  return []
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export class NotesPanel {
  constructor(root) {
    this.root = root
    this.pane = null
    this.listEl = root.querySelector('.notes-list')
    this.countEl = root.querySelector('.notes-count')
    this.sourceEl = root.querySelector('.notes-source')
    this.items = []
    this.fp = ''
    this.selectedId = null
    this.inputTimer = 0
    this.lastExport = null
    this.statusEl = root.querySelector('.notes-status')
    this.token = ''
    this.loadToken = 0
    this.diskTimer = 0

    const flushOnHide = () => this.flush()
    window.addEventListener('pagehide', flushOnHide)
    window.addEventListener('beforeunload', flushOnHide)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushOnHide()
    })

    this.exportBtn = root.querySelector('#notes-export')
    this.exportMenu = root.querySelector('#notes-export-menu')
    if (this.exportBtn) {
      this.exportBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        this.toggleExportMenu()
      })
    }
    if (this.exportMenu) {
      this.exportMenu.addEventListener('click', (e) => {
        const item = e.target.closest('[data-export]')
        if (!item) return
        this.toggleExportMenu(false)
        this.exportTo(item.dataset.export)
      })
    }
    document.addEventListener('click', (e) => {
      if (!this.exportMenu || this.exportMenu.hidden) return
      if (this.exportMenu.contains(e.target) || this.exportBtn.contains(e.target)) return
      this.toggleExportMenu(false)
    })

    this.listEl.addEventListener('click', (e) => this.onClick(e))
    this.listEl.addEventListener('input', (e) => this.onInput(e))
    this.listEl.addEventListener('keydown', (e) => this.onKeyDown(e))
  }

  /* ---------------------------------------------------------------- */
  /* data                                                              */
  /* ---------------------------------------------------------------- */

  /** Bind the panel to one pane; that pane's notes become the current set. */
  begin(pane) {
    if (this.pane && this.pane !== pane) this.pane.setNotes([])
    this.pane = pane || null
    this.fp = pane?.fp || ''
    this.selectedId = null
    this.loadToken = (this.loadToken || 0) + 1
    const token = this.loadToken
    const key = this.fp
    if (this.sourceEl) this.sourceEl.textContent = pane?.nameEl?.textContent || ''
    this.items = []
    this.render()
    this.pane?.setNotes([])
    this.setStatus('')
    if (!key) return
    // Warm the token up front so flush-on-close can use sendBeacon.
    if (isLocal()) this.ensureToken().catch(() => {})

    this.loadFor(key).then((items) => {
      if (token !== this.loadToken || this.fp !== key) return
      this.items = items
      this.render()
      this.pane?.setNotes(items)
      this.setStatus(items.length ? '已保存' : '')
    })
  }

  end() {
    this.flush()
    this.pane?.setNotes([])
    this.pane = null
    this.fp = ''
    this.items = []
    this.selectedId = null
    this.render()
  }

  /** Reload after the bound pane opened a different document. */
  reload() {
    if (!this.pane) return
    this.begin(this.pane)
  }

  /** localStorage first, then legacy key, then the on-disk copy (local app). */
  async loadFor(key) {
    const cached = load(key)
    if (cached.length) {
      this.pushDisk()
      return cached
    }
    const legacy = loadLegacy(key)
    if (legacy.length) {
      save(key, legacy)
      this.pushDisk()
      return legacy
    }
    if (isLocal()) {
      try {
        const token = await this.ensureToken()
        const r = await fetch(
          `/__notes?token=${encodeURIComponent(token)}&key=${encodeURIComponent(key)}`,
          { cache: 'no-store' },
        )
        if (r.ok) {
          const data = await r.json()
          if (Array.isArray(data.items) && data.items.length) {
            save(key, data.items)
            return data.items
          }
        }
      } catch {
        /* offline or older server */
      }
    }
    return []
  }

  async ensureToken() {
    if (this.token) return this.token
    const r = await fetch('/__token', { cache: 'no-store' })
    if (!r.ok) throw new Error('no token')
    this.token = (await r.json()).token
    return this.token
  }

  persist() {
    if (!this.fp) return
    save(this.fp, this.items)
    if (!isLocal()) {
      this.setStatus('已保存')
      return
    }
    this.setStatus('保存中…')
    clearTimeout(this.diskTimer)
    this.diskTimer = setTimeout(() => this.pushDisk(), 350)
  }

  async pushDisk() {
    if (!isLocal() || !this.fp) return
    try {
      const token = await this.ensureToken()
      const r = await fetch(`/__notes?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: this.fp, items: this.items }),
      })
      this.setStatus(r.ok ? '已保存到文件' : '保存失败', !r.ok)
    } catch {
      this.setStatus('保存失败', true)
    }
  }

  /** Called on pagehide / tab hidden: no debounce, write everything now. */
  flush() {
    if (!this.fp) return
    save(this.fp, this.items)
    if (!isLocal() || !this.token) return
    try {
      const blob = new Blob([JSON.stringify({ key: this.fp, items: this.items })], {
        type: 'application/json',
      })
      navigator.sendBeacon(`/__notes?token=${encodeURIComponent(this.token)}`, blob)
    } catch {
      /* ignore */
    }
  }

  setStatus(text, isError = false) {
    if (!this.statusEl) return
    this.statusEl.textContent = text || ''
    this.statusEl.classList.toggle('error', !!isError)
  }

  /* ---------------------------------------------------------------- */
  /* export                                                           */
  /* ---------------------------------------------------------------- */

  sourceName() {
    return this.pane?.nameEl?.textContent?.trim() || 'notes'
  }

  toggleExportMenu(force) {
    if (!this.exportMenu) return
    const open = force === undefined ? this.exportMenu.hidden : !!force
    this.exportMenu.hidden = !open
    this.exportBtn.setAttribute('aria-expanded', String(open))
  }

  exportMarkdown() {
    const source = this.sourceName()
    const when = new Date().toLocaleString('zh-CN', { hour12: false })
    const out = [
      `# 笔记 · ${source}`,
      '',
      `导出时间：${when}`,
      `条目数：${this.items.length}`,
      '',
    ]
    this.items.forEach((n, i) => {
      const quote = (n.text || '（框选区域）').replace(/\s+/g, ' ').trim()
      const where =
        n.kind === 'text' ? (n.format === 'txt' ? 'TXT' : 'Markdown') : `第 ${n.page} 页`
      out.push(`## ${i + 1}. ${where}`, '', `> ${quote}`, '')
      const body = (n.body || '').trim()
      if (body) out.push(body, '')
      out.push('---', '')
    })
    return out.join('\n')
  }

  exportJson() {
    return JSON.stringify(
      {
        version: 1,
        source: this.sourceName(),
        exportedAt: new Date().toISOString(),
        notes: this.items.map((n) => ({
          kind: n.kind === 'text' ? 'text' : 'pdf',
          format: n.format || null,
          page: n.page,
          xPt: n.xPt,
          yPt: n.yPt,
          wPt: n.wPt ?? null,
          hPt: n.hPt ?? null,
          quote: n.text || '',
          body: n.body || '',
          createdAt: n.ts ? new Date(n.ts).toISOString() : null,
        })),
      },
      null,
      2,
    )
  }

  exportTo(kind) {
    if (!this.items.length) return null
    const json = kind === 'json'
    const text = json ? this.exportJson() : this.exportMarkdown()
    const base =
      this.sourceName()
        .replace(/\.pdf$/i, '')
        .replace(/[\\/:*?"<>|\s]+/g, '_') || 'notes'
    const filename = `${base}-笔记.${json ? 'json' : 'md'}`
    this.lastExport = { filename, text }
    download(
      filename,
      text,
      json ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8',
    )
    return this.lastExport
  }

  addNote(anchor) {
    if (!this.pane || !anchor) return null
    const item = {
      id: newId(),
      kind: anchor.kind === 'text' ? 'text' : 'pdf',
      format: anchor.kind === 'text' ? (anchor.format === 'txt' ? 'txt' : 'md') : null,
      page: anchor.page ?? 1,
      xPt: anchor.xPt ?? 0,
      yPt: anchor.yPt ?? 0,
      ratio: Number.isFinite(anchor.ratio) ? anchor.ratio : null,
      text: String(anchor.text || '').slice(0, 2000),
      body: '',
      ts: Date.now(),
    }
    this.items.push(item)
    this.persist()
    this.render()
    this.pane.setNotes(this.items)
    this.select(item.id, { reveal: false })
    this.listEl.focus({ preventScroll: true })
    const body = this.cardEl(item.id)?.querySelector('.note-body')
    body?.focus()
    return item
  }

  focusNote(id) {
    if (!this.items.some((n) => n.id === id)) return
    this.select(id)
    this.listEl.focus({ preventScroll: true })
  }

  remove(id) {
    if (!id) return
    this.items = this.items.filter((n) => n.id !== id)
    this.selectedId = this.items[0]?.id ?? null
    this.persist()
    this.render()
    this.pane?.setNotes(this.items)
    if (this.selectedId) this.select(this.selectedId)
  }

  /* ---------------------------------------------------------------- */
  /* rendering                                                         */
  /* ---------------------------------------------------------------- */

  cardEl(id) {
    return [...this.listEl.querySelectorAll('.note-card')].find((el) => el.dataset.id === id) ?? null
  }

  render() {
    this.listEl.textContent = ''
    if (!this.items.length) {
      const empty = document.createElement('div')
      empty.className = 'notes-empty'
      empty.textContent = '在左侧选中一句话，点句子旁边出现的 ＋ 气泡，就在这里生成一条笔记。'
      this.listEl.append(empty)
    }

    this.items.forEach((item, index) => {
      const card = document.createElement('article')
      card.className = `note-card${item.id === this.selectedId ? ' selected' : ''}`
      card.dataset.id = item.id
      card.tabIndex = -1

      const head = document.createElement('div')
      head.className = 'note-card-head'

      const quote = document.createElement('span')
      quote.className = 'note-quote'
      quote.textContent = item.text || '（框选区域）'
      quote.title = item.text || '（框选区域，无文字）'

      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'note-del'
      del.dataset.del = item.id
      del.title = '删除这条笔记'
      del.textContent = '×'

      head.append(quote, del)

      const meta = document.createElement('div')
      meta.className = 'note-meta'
      const where =
        item.kind === 'text' ? (item.format === 'txt' ? 'TXT' : 'Markdown') : `第 ${item.page} 页`
      meta.textContent = `${where} · 第 ${index + 1} 条`

      const body = document.createElement('textarea')
      body.className = 'note-body'
      body.placeholder = '写点什么…'
      body.rows = 2
      body.value = item.body || ''

      card.append(head, meta, body)
      this.listEl.append(card)
    })

    this.countEl.textContent = `${this.items.length} 条`
    if (this.exportBtn) this.exportBtn.disabled = !this.items.length
  }

  select(id, { reveal = true, focusBody = false } = {}) {
    this.selectedId = id
    for (const card of this.listEl.querySelectorAll('.note-card')) {
      const on = card.dataset.id === id
      card.classList.toggle('selected', on)
      if (on) card.scrollIntoView({ block: 'nearest' })
    }
    const item = this.items.find((n) => n.id === id)
    if (item && reveal) this.pane?.revealNote(item)
    if (focusBody && item) this.cardEl(id)?.querySelector('.note-body')?.focus()
  }

  /* ---------------------------------------------------------------- */
  /* events                                                            */
  /* ---------------------------------------------------------------- */

  onClick(e) {
    const del = e.target.closest?.('.note-del')
    if (del) {
      e.stopPropagation()
      this.remove(del.dataset.del)
      return
    }
    const card = e.target.closest?.('.note-card')
    if (!card) return
    // Clicking the note body is editing, not navigation; clicking anywhere else
    // on the card selects it and jumps back to the source sentence.
    if (e.target.closest?.('.note-body')) return
    this.select(card.dataset.id)
  }

  onInput(e) {
    const body = e.target.closest?.('.note-body')
    if (!body) return
    const card = body.closest('.note-card')
    const item = this.items.find((n) => n.id === card?.dataset.id)
    if (!item) return
    item.body = body.value
    clearTimeout(this.inputTimer)
    this.inputTimer = setTimeout(() => this.persist(), 300)
  }

  onKeyDown(e) {
    const inBody = e.target instanceof HTMLTextAreaElement
    if (inBody && e.key === 'Escape') {
      e.target.blur()
      this.listEl.focus({ preventScroll: true })
      e.preventDefault()
      return
    }
    if (inBody) return

    const idx = this.items.findIndex((n) => n.id === this.selectedId)

    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      if (this.items.length) this.select(this.items[Math.min(this.items.length - 1, idx + 1)].id)
      e.preventDefault()
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      if (this.items.length) this.select(this.items[Math.max(0, idx - 1)].id)
      e.preventDefault()
    } else if (e.key === 'Enter') {
      const card = this.cardEl(this.selectedId)
      if (card) {
        card.querySelector('.note-body')?.focus()
        e.preventDefault()
      }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.selectedId) {
        this.remove(this.selectedId)
        e.preventDefault()
      }
    }
  }
}
