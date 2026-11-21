import './style.css'
import { PdfPane } from './viewer.js'
import { prefs, setPrefs } from './prefs.js'
import { NotesPanel } from './notes.js'
import { englishApi, englishSettings } from './english/api.js'
import { SelectionBar } from './english/selection.js'
import { NoteAssist } from './english/notes-ui.js'
import { EditAssist } from './english/assist.js'
import { EditBar } from './english/edit-bar.js'

const workspace = document.getElementById('workspace')
const splitter = document.getElementById('splitter')
const swapBtn = document.getElementById('swap')
const resetBtn = document.getElementById('reset-split')

const paneEl = {
  left: document.querySelector('[data-side="left"]'),
  right: document.querySelector('[data-side="right"]'),
}

const panes = {
  left: new PdfPane(paneEl.left),
  right: new PdfPane(paneEl.right),
}

/* ------------------------------------------------------------------ */
/* notes panel                                                         */
/* ------------------------------------------------------------------ */

const notesPanelEl = document.getElementById('notes-panel')
const notesExitBtn = document.getElementById('notes-exit')
const notes = new NotesPanel(notesPanelEl)
const noteAssist = new NoteAssist({ notes })
const selectionBar = new SelectionBar({
  onSaveToNote: ({ translation }) => notes.insertTranslation({ translation }),
  canSaveToNote: () => !!notes.pane,
})

for (const pane of [panes.left, panes.right]) {
  pane.onRegionNote = (anchor) => {
    if (notes.pane === pane) notes.addNote(anchor)
  }
  pane.onNoteBubble = (id) => {
    if (notes.pane === pane) notes.focusNote(id)
  }
  pane.onToggleNotes = (p) => {
    if (notesMode && notes.pane === p) exitNotes()
    else enterNotes(p)
  }
  pane.onToggleEdit = (p) => {
    if (editMode && editPane() === p) exitEdit()
    else enterEdit(p)
  }
  pane.onEditInput = (p) => {
    if (editMode && editPane() === p) assist.onInput(p)
  }
  pane.onEditSelection = (p) => {
    if (!editMode || editPane() !== p) return
    const selection = p.selectionInfo()
    assist.setScope(selection)
    const rect = selection ? p.selectionRect() : null
    if (selection && rect) editBar.show(p, selection, rect)
    else editBar.hide()
  }
  pane.onSaveRequest = (p) => {
    if (editMode && editPane() === p) saveActive()
  }
  pane.onDocLoaded = () => {
    if (notes.pane === pane) notes.reload()
    refreshEditButtons()
  }
}

let notesMode = false
let notesSide = 'right'
// Declared here, next to notesMode, because pane callbacks can fire before the
// edit-mode block below is evaluated.
let editMode = false

/**
 * Notes are per pane: the button lives in that pane's own toolbar, and the
 * panel takes the *other* slot so the annotated PDF stays visible.
 */
function enterNotes(pane) {
  const usable = !!pane?.doc || (pane?.kind === 'text' && !pane.mdEl.hidden)
  if (!usable) return
  setActive(pane)
  notesSide = pane === panes.left ? 'right' : 'left'
  notesMode = true
  panes.left.setNoteMode(pane === panes.left)
  panes.right.setNoteMode(pane === panes.right)
  workspace.classList.add('notes-mode')
  workspace.dataset.notesSide = notesSide
  notesPanelEl.hidden = false
  notes.begin(pane)
  pane.handleResize()
  ;(notesSide === 'right' ? panes.right : panes.left).handleResize()
  notes.listEl.focus({ preventScroll: true })
}

function exitNotes() {
  if (!notesMode) return
  notesMode = false
  notes.end()
  panes.left.setNoteMode(false)
  panes.right.setNoteMode(false)
  workspace.classList.remove('notes-mode')
  delete workspace.dataset.notesSide
  notesPanelEl.hidden = true
  panes.left.handleResize()
  panes.right.handleResize()
}

function setNotesMode(on) {
  if (on) enterNotes(active)
  else exitNotes()
}

notesExitBtn.addEventListener('click', exitNotes)

/* ------------------------------------------------------------------ */
/* edit mode: editable markdown source + English assistant             */
/* ------------------------------------------------------------------ */

const assistPanelEl = document.getElementById('assist-panel')
const assistExitBtn = document.getElementById('assist-exit')
const assistParaBtn = document.getElementById('assist-para-check')
const assistSaveBtn = document.getElementById('assist-save')

const assist = new EditAssist({
  bodyEl: document.getElementById('assist-body'),
  scopeEl: document.getElementById('assist-scope'),
  statusEl: document.getElementById('assist-status'),
  hintEl: document.getElementById('assist-hint'),
})

const editBar = new EditBar({
  onAction: (act, { pane, selection }) => {
    onEditBarAction(act, pane, selection)
    editBar.hide()
  },
})

/** The pane currently being edited, if any. */
function editPane() {
  if (!editMode) return null
  if (panes.left.editMode) return panes.left
  if (panes.right.editMode) return panes.right
  return null
}

function refreshEditButtons() {
  const owner = editPane()
  panes.left.setEditButton(panes.left === owner)
  panes.right.setEditButton(panes.right === owner)
}

function enterEdit(pane) {
  if (!editMode && !pane?.canEdit()) return
  if (notesMode) exitNotes()
  setActive(pane)
  editMode = true
  if (!pane.enterEdit()) {
    editMode = false
    return
  }
  workspace.classList.add('edit-mode')
  workspace.dataset.editSide = pane === panes.left ? 'left' : 'right'
  assistPanelEl.hidden = false
  assist.attach(pane)
  refreshEditButtons()
  pane.handleResize()
}

function exitEdit() {
  if (!editMode) return
  const pane = editPane()
  editMode = false
  editBar.hide()
  assist.detach()
  workspace.classList.remove('edit-mode')
  delete workspace.dataset.editSide
  assistPanelEl.hidden = true
  if (pane) pane.exitEdit()
  refreshEditButtons()
  panes.left.handleResize()
  panes.right.handleResize()
}

function onEditBarAction(act, pane, selection) {
  if (!pane || !selection) return
  if (act === 'check') assist.runCheck(pane, selection, '检查优化')
  else if (act === 'replace') assist.runReplace(pane, selection)
  else if (act === 'en-zh' || act === 'en-en' || act === 'zh-en') {
    assist.runTranslate(pane, selection, act)
  }
}

async function saveActive() {
  const pane = editPane()
  if (!pane) return
  try {
    const result = await pane.saveText()
    if (result.ok) {
      assist.setStatus(`已保存 · ${result.bytes} 字符`)
      return
    }
    if (result.reason === 'no-path' || result.reason === 'no-local') {
      downloadCopy(pane)
      assist.setStatus('不是按路径打开的，已下载一份副本', false)
      return
    }
    assist.setStatus('现在没有在编辑', true)
  } catch (error) {
    assist.setStatus(error.message || '保存失败', true)
  }
}

/** Fallback when there is no file to write back to: hand over a copy. */
function downloadCopy(pane) {
  const blob = new Blob([pane.editorEl.value], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = pane.textName || 'document.md'
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

assistExitBtn.addEventListener('click', exitEdit)
assistSaveBtn.addEventListener('click', saveActive)
assistParaBtn.addEventListener('click', () => {
  const pane = editPane()
  if (pane) assist.runCheck(pane, pane.paragraphAt(), '查本段')
})

// A dirty editor must not disappear with a stray Ctrl+W.
window.addEventListener('beforeunload', (event) => {
  if (!panes.left.isDirty() && !panes.right.isDirty()) return
  event.preventDefault()
  event.returnValue = ''
})


const SPLIT_KEY = 'dpv:split'

/* ------------------------------------------------------------------ */
/* active pane (this is the whole "focus routing" story)               */
/* ------------------------------------------------------------------ */

let active = panes.left

function setActive(pane) {
  if (!pane || active === pane) return
  active = pane
  panes.left.root.classList.toggle('active', active === panes.left)
  panes.right.root.classList.toggle('active', active === panes.right)
}

panes.left.onActivate = () => setActive(panes.left)
panes.right.onActivate = () => setActive(panes.right)
panes.left.root.classList.add('active')

// Small hook so the smoke test can inspect state without guessing at the DOM.
// 允许从外部指定要打开的文件：/?open=<绝对路径>
// 任务中枢靠这个实现“一键把上次那篇 PDF 摆回来”。
const openFromQuery = new URLSearchParams(location.search).get('open')
if (openFromQuery) {
  panes.left.openPath(openFromQuery).catch(() => {})
}

window.__dpv = {
  panes,
  getActive: () => active,
  setActive,
  prefs,
  setPrefs: applyPrefs,
  notes,
  setNotesMode,
  assist,
  editBar,
  enterEdit,
  exitEdit,
  saveActive,
  isEditing: () => !!editPane(),
  english: { api: englishApi, settings: englishSettings, bar: selectionBar, assist: noteAssist },
}

/* ------------------------------------------------------------------ */
/* zoom settings popover                                               */
/* ------------------------------------------------------------------ */

const settingsEl = document.getElementById('settings')
const settingsBtn = document.getElementById('settings-btn')
const segAnchor = document.getElementById('seg-anchor')
const stepInput = document.getElementById('set-step')
const stepVal = document.getElementById('set-step-val')
const smoothInput = document.getElementById('set-smooth')
const smoothVal = document.getElementById('set-smooth-val')
const keyButtons = [...document.querySelectorAll('.key-capture')]
let capturing = null

function renderKeyButtons() {
  for (const btn of keyButtons) {
    const which = btn.dataset.keyCap
    const isCapturing = capturing === btn
    btn.classList.toggle('capturing', isCapturing)
    const key = prefs.toolKeys[which]
    btn.querySelector('.cap-key').textContent = isCapturing
      ? '…'
      : key === 'escape'
        ? 'Esc'
        : key.toUpperCase()
  }
}

function syncSettingsUI() {
  for (const btn of segAnchor.querySelectorAll('.seg-btn')) {
    btn.classList.toggle('active', btn.dataset.value === prefs.anchor)
  }
  stepInput.value = String(Math.round(prefs.step * 100))
  stepVal.textContent = `${Math.round(prefs.step * 100)}%`
  smoothInput.value = String(Math.round(prefs.smooth))
  smoothVal.textContent = `${Math.round(prefs.smooth)}ms`
  renderKeyButtons()
}

function applyPrefs(patch) {
  setPrefs(patch)
  syncSettingsUI()
}

settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  const opening = settingsEl.hidden
  settingsEl.hidden = !opening
  settingsBtn.setAttribute('aria-expanded', String(opening))
})

document.addEventListener('click', (e) => {
  if (capturing && !e.target.closest?.('.key-capture')) {
    capturing = null
    renderKeyButtons()
  }
  if (settingsEl.hidden) return
  if (settingsEl.contains(e.target) || e.target === settingsBtn) return
  settingsEl.hidden = true
  settingsBtn.setAttribute('aria-expanded', 'false')
})

segAnchor.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn')
  if (btn) applyPrefs({ anchor: btn.dataset.value })
})

stepInput.addEventListener('input', () => applyPrefs({ step: Number(stepInput.value) / 100 }))
smoothInput.addEventListener('input', () => applyPrefs({ smooth: Number(smoothInput.value) }))

for (const btn of keyButtons) {
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    capturing = capturing === btn ? null : btn
    renderKeyButtons()
  })
}

// Capture phase: while listening for a new key, swallow it before the global
// tool-shortcut handler below ever sees it.
document.addEventListener(
  'keydown',
  (e) => {
    if (!capturing) return
    e.preventDefault()
    e.stopPropagation()
    const btn = capturing
    capturing = null
    const which = btn.dataset.keyCap
    const k = e.key === 'Escape' ? 'escape' : e.key.toLowerCase()
    const valid = /^[a-z]$/.test(k) || (k === 'escape' && which === 'notesExit')
    if (valid) {
      const owner = Object.entries(prefs.toolKeys).find(([slot, val]) => slot !== which && val === k)
      if (owner) {
        // Stealing another slot's key swaps the two instead of erroring out.
        applyPrefs({ toolKeys: { [owner[0]]: prefs.toolKeys[which], [which]: k } })
      } else {
        applyPrefs({ toolKeys: { [which]: k } })
      }
    }
    renderKeyButtons()
  },
  true,
)

syncSettingsUI()

document.addEventListener('keydown', (e) => {
  const t = e.target
  const typing =
    t instanceof HTMLElement &&
    (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)

  // Leave notes mode: Escape always works, even from the note textarea; a
  // letter shortcut only fires outside text fields so typing is never hijacked.
  if (
    notesMode &&
    e.key.toLowerCase() === prefs.toolKeys.notesExit &&
    (!typing || e.key === 'Escape')
  ) {
    e.preventDefault()
    exitNotes()
    return
  }

  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
    if (editMode) {
      e.preventDefault()
      saveActive()
      return
    }
  }

  if (typing) return
  // The notes panel handles its own arrow keys (card navigation).
  if (notesPanelEl.contains(t)) return
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'o') {
    e.preventDefault()
    active.chooseFile()
    return
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'l') {
    e.preventDefault()
    active.focusOpenPath()
    return
  }
  if (e.key === 'Escape') {
    let closed = false
    for (const pane of Object.values(panes)) {
      if (!pane.lensEl.hidden) {
        pane.closeLens()
        closed = true
      }
    }
    if (closed) {
      e.preventDefault()
      return
    }
  }
  if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    const k = e.key.toLowerCase()
    if (k === prefs.toolKeys.select) {
      e.preventDefault()
      active.setTool('select')
      return
    }
    if (k === prefs.toolKeys.marquee) {
      e.preventDefault()
      active.setTool('marquee')
      return
    }
  }
  if (active.handleKey(e)) e.preventDefault()
})

/* ------------------------------------------------------------------ */
/* splitter                                                            */
/* ------------------------------------------------------------------ */

let dragging = false
let lastDown = 0
const MIN_PANE = 240

function applySplit(px) {
  const rect = workspace.getBoundingClientRect()
  const x = Math.min(Math.max(px, MIN_PANE), Math.max(MIN_PANE, rect.width - MIN_PANE))
  workspace.style.setProperty('--left-width', `${Math.round(x)}px`)
}

function resetSplit() {
  workspace.style.removeProperty('--left-width')
  try {
    localStorage.removeItem(SPLIT_KEY)
  } catch {
    /* ignore */
  }
  panes.left.handleResize()
  panes.right.handleResize()
}

try {
  const saved = Number(localStorage.getItem(SPLIT_KEY))
  if (saved > 0) requestAnimationFrame(() => applySplit(saved))
} catch {
  /* ignore */
}

splitter.addEventListener('pointerdown', (e) => {
  // preventDefault() on pointerdown suppresses mouse compatibility events
  // (including dblclick), so double-tap is detected by hand here.
  const now = performance.now()
  if (now - lastDown < 380) {
    lastDown = 0
    resetSplit()
    return
  }
  lastDown = now
  e.preventDefault()
  dragging = true
  splitter.classList.add('dragging')
  splitter.setPointerCapture(e.pointerId)
  panes.left.interacting = true
  panes.right.interacting = true
})

splitter.addEventListener('pointermove', (e) => {
  if (!dragging) return
  applySplit(e.clientX - workspace.getBoundingClientRect().left)
})

function endDrag(e) {
  if (!dragging) return
  dragging = false
  splitter.classList.remove('dragging')
  try {
    splitter.releasePointerCapture(e.pointerId)
  } catch {
    /* ignore */
  }
  panes.left.interacting = false
  panes.right.interacting = false
  panes.left.handleResize()
  panes.right.handleResize()
  const leftWidth = parseInt(getComputedStyle(workspace).getPropertyValue('--left-width'), 10)
  if (Number.isFinite(leftWidth)) {
    try {
      localStorage.setItem(SPLIT_KEY, String(leftWidth))
    } catch {
      /* ignore */
    }
  }
}

splitter.addEventListener('pointerup', endDrag)
splitter.addEventListener('pointercancel', endDrag)

resetBtn.addEventListener('click', resetSplit)

/* ------------------------------------------------------------------ */
/* swap / resize                                                       */
/* ------------------------------------------------------------------ */

swapBtn.addEventListener('click', () => {
  const a = panes.left.snapshot()
  const b = panes.right.snapshot()
  if (!a && !b) return
  panes.left.restore(b)
  panes.right.restore(a)
  setActive(panes.right)
})

const ro = new ResizeObserver(() => {
  panes.left.handleResize()
  panes.right.handleResize()
})
ro.observe(panes.left.scrollEl)
ro.observe(panes.right.scrollEl)

/* ------------------------------------------------------------------ */
/* drag & drop                                                         */
/* ------------------------------------------------------------------ */

const isDoc = (f) =>
  f && (/\.(pdf|md|markdown|txt)$/i.test(f.name) || f.type === 'application/pdf' || f.type.startsWith('text/'))

function clearDropMarks() {
  panes.left.root.classList.remove('dropping')
  panes.right.root.classList.remove('dropping')
}

workspace.addEventListener('dragover', (e) => {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  const target = e.target.closest?.('.pane')
  panes.left.root.classList.toggle('dropping', target === paneEl.left)
  panes.right.root.classList.toggle('dropping', target === paneEl.right)
})

workspace.addEventListener('dragleave', (e) => {
  if (!workspace.contains(e.relatedTarget)) clearDropMarks()
})

workspace.addEventListener('drop', async (e) => {
  e.preventDefault()
  clearDropMarks()
  const files = [...(e.dataTransfer?.files || [])].filter(isDoc)
  if (!files.length) return

  const target = e.target.closest?.('.pane')
  const primary =
    (target === paneEl.left && panes.left) ||
    (target === paneEl.right && panes.right) ||
    (panes.left.doc ? panes.right : panes.left)
  const secondary = primary === panes.left ? panes.right : panes.left

  setActive(primary)
  await primary.openFile(files[0])
  if (files[1]) await secondary.openFile(files[1])
})

// Never let a stray drop navigate the page away from the viewer.
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

/* ------------------------------------------------------------------ */
/* english settings                                                    */
/* ------------------------------------------------------------------ */

const enEnabled = document.getElementById('en-enabled')
const enKey = document.getElementById('en-key')
const enSave = document.getElementById('en-save')
const enTest = document.getElementById('en-test')
const enStatus = document.getElementById('en-status')

function setEnStatus(text, bad = false) {
  if (!enStatus) return
  enStatus.textContent = text
  enStatus.classList.toggle('bad', !!bad)
}

function describeHealth(health) {
  if (health.mock) {
    setEnStatus('模拟模式：不调用模型，只演示界面')
    return
  }
  if (!health.configured) {
    setEnStatus('未配置：粘贴密钥后点保存', true)
    return
  }
  const used = health.totals ? health.totals.totalTokens : 0
  const source = health.keySource === 'env' ? '环境变量' : health.keyTail || '—'
  setEnStatus(`${health.model} · ${source} · 已用 ${used} token`)
}

async function refreshEnglishStatus() {
  try {
    describeHealth(await englishApi.health())
  } catch (error) {
    setEnStatus(error.message || '本地服务未响应', true)
  }
}

if (enEnabled) {
  enEnabled.checked = englishSettings.enabled
  enEnabled.addEventListener('change', () => {
    englishSettings.setEnabled(enEnabled.checked)
    if (!enEnabled.checked) selectionBar.hide()
    for (const card of notes.listEl.querySelectorAll('.note-card')) {
      const item = notes.items.find((note) => note.id === card.dataset.id)
      if (item) noteAssist.enhance(card, item)
    }
  })
}

if (enSave) {
  enSave.addEventListener('click', async () => {
    const value = enKey.value.trim()
    if (!value) {
      setEnStatus('先粘贴密钥', true)
      return
    }
    enSave.disabled = true
    setEnStatus('保存中…')
    try {
      await englishApi.saveConfig({ apiKey: value })
      enKey.value = ''
      await refreshEnglishStatus()
    } catch (error) {
      setEnStatus(error.message || '保存失败', true)
    } finally {
      enSave.disabled = false
    }
  })
}

if (enTest) {
  enTest.addEventListener('click', async () => {
    enTest.disabled = true
    setEnStatus('测试中…')
    try {
      const result = await englishApi.test()
      setEnStatus(
        result.mock ? '模拟模式可用' : `连接正常 · ${result.latencyMs}ms · ${result.model}`,
      )
    } catch (error) {
      setEnStatus(error.message || '连接失败', true)
    } finally {
      enTest.disabled = false
    }
  })
}

refreshEnglishStatus()
