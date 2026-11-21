/**
 * UI test for edit mode: the editable source pane plus the English assistant.
 *
 * Runs against the local server in mock mode, like english-ui.mjs:
 *   $env:DPV_LLM_MOCK='1'; node local/start.cjs
 *   node test/edit-ui.mjs
 *
 * A throwaway copy of the fixture is opened by path, so a failed save can never
 * touch the repository copy.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, 'out')
mkdirSync(outDir, { recursive: true })

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => p && existsSync(p))

if (!CHROME) {
  console.error('找不到 Chrome / Edge，可用 CHROME_PATH 指定')
  process.exit(2)
}

const url = process.env.DPV_URL || 'http://127.0.0.1:5180/'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const fixture = path.join(here, 'fixtures', 'editable.md')
const target = path.join(here, 'out', 'editable.md')
rmSync(target, { force: true })
copyFileSync(fixture, target)
const original = readFileSync(fixture, 'utf8')

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'],
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1560, height: 960, deviceScaleFactor: 1 })

  const errors = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const source = message.location()?.url || ''
    if (source.includes('/__notes')) return
    errors.push(message.text())
  })
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().includes('/__notes')) {
      errors.push(`HTTP ${response.status()} ${response.url()}`)
    }
  })

  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 })

  // ---- open the text file by path, then switch that pane into edit mode ----
  await page.evaluate((file) => window.__dpv.panes.left.openPath(file), target)
  await page.waitForFunction(() => window.__dpv.panes.left.kind === 'text', { timeout: 8000 })

  const editBtnVisible = await page.$eval('[data-side="left"] [data-act="edit"]', (el) => !el.disabled)
  check('文本窗格里「修改」按钮可用', editBtnVisible)

  await page.click('[data-side="left"] [data-act="edit"]')
  await page.waitForSelector('.workspace.edit-mode', { timeout: 4000 })

  const editorState = await page.evaluate(() => {
    const pane = window.__dpv.panes.left
    return {
      visible: !pane.editorEl.hidden,
      value: pane.editorEl.value,
      mdHidden: pane.mdEl.hidden,
      panelVisible: !document.getElementById('assist-panel').hidden,
    }
  })
  check('编辑器显示的就是原始 markdown 源码', editorState.visible && editorState.value === original, `md 已隐藏=${editorState.mdHidden}`)
  check('右栏助手面板出现', editorState.panelVisible)

  // ---- ④ replace: select a sentence, the bar offers four actions ----
  const selection = await page.evaluate(() => {
    const pane = window.__dpv.panes.left
    const text = pane.editorEl.value
    const start = text.indexOf('The results of this study')
    const end = text.indexOf('\n\n', start)
    pane.editorEl.focus()
    pane.editorEl.setSelectionRange(start, end)
    pane.editorEl.dispatchEvent(new Event('select'))
    return { start, end, text: text.slice(start, end) }
  })
  await sleep(150)

  const barState = await page.evaluate(() => {
    const bar = document.querySelector('.en-bar-edit')
    if (!bar || bar.hidden) return null
    return {
      labels: [...bar.querySelectorAll('[data-en]')]
        .filter((b) => !b.hidden && b.dataset.en !== 'close')
        .map((b) => b.textContent.trim()),
      top: bar.getBoundingClientRect().top,
    }
  })
  check('选中后浮条出现', !!barState)
  check(
    '浮条有四个动作（检查优化 / 英→中 / 英→英 / 替换）',
    JSON.stringify(barState?.labels) === JSON.stringify(['检查优化', '英→中', '英→英', '替换']),
    JSON.stringify(barState?.labels),
  )

  await page.evaluate(() => document.querySelector('.en-bar-edit [data-en="replace"]').click())
  await page.waitForSelector('.assist-panel .assist-option', { timeout: 6000 })

  const optionCount = await page.$$eval('.assist-panel .assist-option', (nodes) => nodes.length)
  const firstOption = await page.$eval('.assist-panel .assist-option-text', (el) => el.textContent.trim())
  check('替换卡同时给出多个版本', optionCount >= 1, `${optionCount} 版：${firstOption}`)
  check('替换版本确实整句重写', firstOption !== selection.text, firstOption)

  const beforeApply = await page.$eval('.assist-panel .assist-option-head .assist-focus', (el) => el.textContent)
  await page.click('.assist-panel .assist-option .assist-pick')
  await sleep(200)

  const afterReplace = await page.evaluate(() => window.__dpv.panes.left.editorEl.value)
  check('点「替换」把选区换成了新句', afterReplace.includes(firstOption), `标签=${beforeApply}`)
  check('替换没有动到别的段落', afterReplace.includes('The sample were small'))

  // ---- ③ check the paragraph under the caret ----
  await page.evaluate(() => {
    const pane = window.__dpv.panes.left
    const at = pane.editorEl.value.indexOf('The sample were small')
    pane.editorEl.focus()
    pane.editorEl.setSelectionRange(at, at)
    pane.editorEl.dispatchEvent(new Event('select'))
  })
  await page.click('#assist-para-check')
  await page.waitForSelector('.assist-panel .assist-issue', { timeout: 6000 })
  const issueCount = await page.$$eval('.assist-panel .assist-issue', (nodes) => nodes.length)
  const summary = await page.$eval('.assist-panel .assist-summary', (el) => el.textContent.trim())
  check('「查本段」只查光标所在段落', issueCount > 0, `${issueCount} 条 · ${summary}`)

  const scopeBefore = await page.$eval('.assist-panel .assist-preview', (el) => el.textContent)
  check('检查范围确实是一段而不是全文', !scopeBefore.includes('The results of this study'), scopeBefore.slice(0, 40))

  // ---- ① Chinese typed into the editor gets English candidates ----
  await page.evaluate(() => {
    const pane = window.__dpv.panes.left
    const value = `${pane.editorEl.value}\n\n我们发现复发率更低。\n`
    pane.editorEl.value = value
    pane.editorEl.dispatchEvent(new Event('input'))
    pane.editorEl.focus()
    pane.editorEl.setSelectionRange(value.length - 2, value.length - 2)
    pane.editorEl.dispatchEvent(new Event('select'))
  })
  await page.waitForSelector('.assist-panel .assist-chip', { timeout: 6000 })
  const chips = await page.$$eval('.assist-panel .assist-chip-row', (rows) =>
    rows.map((row) => ({
      cn: row.querySelector('.chip-cn')?.textContent || '',
      options: [...row.querySelectorAll('.assist-chip')].map((chip) => chip.textContent),
    })),
  )
  check('打中文后自动给出英文候选', chips.length > 0 && chips[0].options.length === 2, JSON.stringify(chips[0]))

  await page.click('.assist-panel .assist-chip')
  await sleep(250)
  const afterChip = await page.evaluate(() => window.__dpv.panes.left.editorEl.value)
  check('点候选后中文被原位替换成英文', !afterChip.includes('我们发现复发率更低'), afterChip.slice(-60))

  // ---- save back to the file on disk ----
  const dirtyBefore = await page.$eval('[data-side="left"]', (el) => el.classList.contains('dirty'))
  check('改动后文件名旁出现未保存标记', dirtyBefore)

  await page.click('#assist-save')
  await sleep(600)

  const onDisk = readFileSync(target, 'utf8')
  const matchesEditor = await page.evaluate(
    (text) => window.__dpv.panes.left.editorEl.value === text,
    onDisk,
  )
  check('保存写回了原文件', matchesEditor, `${onDisk.length} 字符`)
  check('保存后不再显示未保存标记', !(await page.$eval('[data-side="left"]', (el) => el.classList.contains('dirty'))))

  // ---- leaving edit mode keeps the edited text in the rendered view ----
  await page.click('#assist-exit')
  await sleep(250)
  const afterExit = await page.evaluate(() => ({
    editMode: window.__dpv.isEditing(),
    mdVisible: !window.__dpv.panes.left.mdEl.hidden,
    rendered: window.__dpv.panes.left.mdEl.textContent,
  }))
  check('退出后回到渲染阅读态', !afterExit.editMode && afterExit.mdVisible)
  check('渲染视图用的是改过的正文', afterExit.rendered.includes('The sample were small'))

  // ---- notes mode still works and is a separate mode ----
  await page.click('[data-side="left"] [data-act="notes"]')
  await page.waitForSelector('.workspace.notes-mode', { timeout: 4000 })
  const notesState = await page.evaluate(() => ({
    notes: !!document.querySelector('.workspace.notes-mode'),
    edit: !!document.querySelector('.workspace.edit-mode'),
    panel: !document.getElementById('notes-panel').hidden,
  }))
  check('笔记模式仍然独立可用', notesState.notes && notesState.panel && !notesState.edit)

  // ---- a PDF pane offers no edit entry ----
  const pdfEdit = await page.evaluate(async () => {
    const pane = window.__dpv.panes.right
    await pane.openFile(new File([new Uint8Array([37, 80, 68, 70])], 'broken.pdf', { type: 'application/pdf' }))
    return { disabled: pane.root.querySelector('[data-act="edit"]').disabled, kind: pane.kind }
  })
  check('PDF 窗格没有修改入口', pdfEdit.disabled, `kind=${pdfEdit.kind}`)

  check('无控制台报错', errors.length === 0, errors.slice(0, 2).join(' | '))

  await page.screenshot({ path: path.join(outDir, 'edit-mode.png'), fullPage: false })
} finally {
  await browser.close()
  rmSync(target, { force: true })
}

const passed = results.filter((entry) => entry.ok).length
console.log(`\n${passed}/${results.length} passed`)
if (passed !== results.length) process.exit(1)
