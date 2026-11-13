// Shared zoom preferences. One object, persisted, read by the viewer at use time
// so changing a slider takes effect on the very next wheel tick.

const KEY = 'dpv:prefs:v1'

const DEFAULTS = {
  /** 'center' keeps the viewport centre pinned; 'cursor' follows the mouse. */
  anchor: 'center',
  /** Zoom multiplier for one wheel notch / one +/- press, e.g. 0.11 = +11%. */
  step: 0.11,
  /** Exponential time constant of the zoom animation, in ms. */
  smooth: 70,
  /** Single-key shortcuts: two pane tools plus "leave notes mode". */
  toolKeys: { select: 'v', marquee: 'z', notesExit: 'escape' },
}

const DEFAULT_TOOL_KEYS = { select: 'v', marquee: 'z', notesExit: 'escape' }
const KEY_RE = /^[a-z]$|^escape$/

export const prefs = {
  ...DEFAULTS,
  toolKeys: { ...DEFAULT_TOOL_KEYS },
}

const clampNum = (v, min, max, fallback) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (!raw || typeof raw !== 'object') return
    if (raw.anchor === 'cursor' || raw.anchor === 'center') prefs.anchor = raw.anchor
    prefs.step = clampNum(raw.step, 0.03, 0.4, DEFAULTS.step)
    prefs.smooth = clampNum(raw.smooth, 30, 300, DEFAULTS.smooth)
    if (raw.toolKeys && typeof raw.toolKeys === 'object') {
      for (const which of ['select', 'marquee', 'notesExit']) {
        const v = String(raw.toolKeys[which] || '').toLowerCase()
        if (!KEY_RE.test(v)) continue
        if (Object.entries(prefs.toolKeys).some(([k, val]) => k !== which && val === v)) continue
        prefs.toolKeys[which] = v
      }
    }
  } catch {
    /* corrupted storage - keep defaults */
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    /* storage disabled */
  }
}

export function setPrefs(patch = {}) {
  if (patch.anchor === 'cursor' || patch.anchor === 'center') prefs.anchor = patch.anchor
  if ('step' in patch) prefs.step = clampNum(patch.step, 0.03, 0.4, prefs.step)
  if ('smooth' in patch) prefs.smooth = clampNum(patch.smooth, 30, 300, prefs.smooth)
  if (patch.toolKeys && typeof patch.toolKeys === 'object') {
    for (const which of ['select', 'marquee', 'notesExit']) {
      const raw = patch.toolKeys[which]
      if (raw === undefined) continue
      const v = String(raw).toLowerCase()
      if (!KEY_RE.test(v)) continue
      if (Object.entries(prefs.toolKeys).some(([k, val]) => k !== which && val === v)) continue
      prefs.toolKeys = { ...prefs.toolKeys, [which]: v }
    }
  }
  save()
  return prefs
}

load()
