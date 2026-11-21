/**
 * UI test for the English helpers, driven entirely by mock replies.
 *
 * Start a server with mock mode on, then run this file:
 *   $env:DPV_LLM_MOCK='1'; node local/start.cjs
 *   node test/english-ui.mjs
 *
 * Nothing here calls a model: the server answers /__llm from local/english/mock.mjs.
 */
import { existsSync, mkdirSync } from 'node:fs'
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

const ARTICLE = [
  'Patients with a higher baseline score had a 1.8-fold risk of relapse after adjustment.',
  '',
  'This paper compares two cohorts of equal size.',
  '',
  'The sample were small and the result is very very clear.',
].join('\n')

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'],
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1500, height: 940, deviceScaleFactor: 1 })

  const errors = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    // A missing note file is a normal answer from /__notes, not a page error.
    if ((message.location()?.url || '').includes('/__notes')) return
    errors.push(message.text())
  })
  page.on('response', (response) => {
    // A missing note file is a normal answer from /__notes, not a page error.
    if (response.status() >= 400 && !response.url().includes('/__notes')) {
      errors.push(`HTTP ${response.status()} ${response.url()}`)
    }
  })

  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 })

  const health = await page.evaluate(() => window.__dpv.english.api.health())
  check('mock 模式生效', health.mock === true, JSON.stringify({ mock: health.mock, configured: health.configured }))

  // Each run starts from an empty note set for this fixture, or old cards pile
  // up in the panel and the assertions start reading the wrong one.
  await page.evaluate(async () => {
    const key = 'english-fixture.md:1'
    localStorage.removeItem(`dpv:notes:${key}`)
    for (const name of Object.keys(localStorage)) {
      if (name.startsWith('dpv:notes:english-fixture')) localStorage.removeItem(name)
    }
    if (window.__DUAL_PDF_LOCAL__) {
      try {
        const { token } = await (await fetch('/__token', { cache: 'no-store' })).json()
        await fetch(`/__notes?token=${encodeURIComponent(token)}&key=${encodeURIComponent(key)}`, {
          method: 'DELETE',
        })
      } catch {
        /* no disk copy */
      }
    }
  })

  // The fixture text goes through the same entry point the file picker uses.
  await page.evaluate((text) => {
    window.__dpv.panes.left.loadText(text, { name: 'english-fixture.md', fp: 'english-fixture.md:1' })
  }, ARTICLE)
  await sleep(120)

  /* ---------------------------------------------------------------- */
  /* 1. selection bar                                                  */
  /* ---------------------------------------------------------------- */

  const selectFirstParagraph = () =>
    page.evaluate(() => {
      const md = document.querySelector('[data-side="left"] .md-doc')
      const block = [...md.querySelectorAll('p')].find((el) => el.textContent.includes('baseline score'))
      if (!block) return null
      const range = document.createRange()
      range.selectNodeContents(block)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      const rect = range.getBoundingClientRect()
      block.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      )
      return { text: selection.toString(), width: rect.width }
    })

  const selected = await selectFirstParagraph()
  await sleep(80)
  const barVisible = await page.evaluate(() => {
    const bar = document.querySelector('.en-bar')
    return !!bar && !bar.hidden
  })
  check('选中文本后浮条出现', barVisible && !!selected?.text, selected?.text?.slice(0, 40))

  await page.click('.en-bar [data-en="en-zh"]')
  await page.waitForFunction(
    () => {
      const main = document.querySelector('.en-card:not([hidden]) .en-main')
      return main && main.textContent && !main.textContent.includes('翻译中')
    },
    { timeout: 5000 },
  )
  const card = await page.evaluate(() => {
    const card = document.querySelector('.en-card:not([hidden])')
    return {
      main: card.querySelector('.en-main').textContent,
      notes: [...card.querySelectorAll('.en-notes li')].map((li) => li.textContent),
      badge: card.querySelector('.en-card-badge').hidden ? '' : card.querySelector('.en-card-badge').textContent,
    }
  })
  check('中译结果卡渲染', card.main.includes('模拟'), card.main.slice(0, 36))
  check('词义提示渲染', card.notes.length === 2, card.notes[0]?.slice(0, 40) || '')
  check('模拟角标可见', card.badge === '模拟', card.badge)

  const beforeNotes = await page.evaluate(() => document.querySelector('.en-card [data-en="to-note"]').disabled)
  check('未开笔记时「存成笔记」不可用', beforeNotes === true)

  await page.screenshot({ path: path.join(outDir, 'english-selection.png') })

  /* ---------------------------------------------------------------- */
  /* 2. notes mode: chinese suggestions                                */
  /* ---------------------------------------------------------------- */

  await page.click('[data-side="left"] [data-act="notes"]')
  await sleep(200)

  // In notes mode the same selection now also becomes a note card, and that
  // card is the one the translation should be parked in.
  await page.evaluate(() => {
    const block = [...document.querySelectorAll('.md-doc p')].find((el) =>
      el.textContent.includes('baseline score'),
    )
    const range = document.createRange()
    range.selectNodeContents(block)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    const rect = range.getBoundingClientRect()
    block.dispatchEvent(
      new MouseEvent('mouseup', {
        bubbles: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    )
  })
  await sleep(150)
  const hasCard = await page.evaluate(() => !!document.querySelector('.note-card.selected .note-body'))
  check('笔记卡出现且被选中', hasCard)

  await page.click('.en-bar [data-en="en-zh"]')
  await page.waitForFunction(
    () => {
      const main = document.querySelector('.en-card:not([hidden]) .en-main')
      return main && main.textContent && !main.textContent.includes('翻译中')
    },
    { timeout: 5000 },
  )
  await page.click('.en-card [data-en="to-note"]')
  await sleep(150)
  const parked = await page.evaluate(
    () => document.querySelector('.note-card.selected .note-body')?.value || '',
  )
  check('译文存进笔记正文', parked.startsWith('> （模拟）'), parked.slice(0, 30))

  // Typing Chinese triggers the suggestion chips after the debounce.
  await page.evaluate(() => {
    const body = document.querySelector('.note-card.selected .note-body')
    body.focus()
    body.value = 'This paper compares two cohorts. 我们发现复发率更低 in the matched group.'
    body.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.waitForFunction(() => document.querySelectorAll('.assist-chip').length > 0, { timeout: 6000 })
  const chips = await page.evaluate(() => ({
    count: document.querySelectorAll('.assist-chip').length,
    first: document.querySelector('.assist-chip')?.textContent,
    cn: document.querySelector('.chip-cn')?.textContent,
    badge: document.querySelector('.note-card.selected .note-cn')?.textContent,
  }))
  check('中文片段给出英文选项', chips.count === 2, `${chips.cn} → ${chips.first}`)
  check('中文计数角标', /中文\s*\d+/.test(chips.badge || ''), chips.badge)

  await page.click('.assist-chip')
  await sleep(120)
  const afterPick = await page.evaluate(
    () => document.querySelector('.note-card.selected .note-body').value,
  )
  check(
    '点选后原位替换，中文消失',
    afterPick.includes('We found') && !afterPick.includes('我们发现'),
    afterPick.slice(0, 60),
  )

  /* ---------------------------------------------------------------- */
  /* 3. checker                                                        */
  /* ---------------------------------------------------------------- */

  await page.evaluate(() => {
    const body = document.querySelector('.note-card.selected .note-body')
    body.value = 'The sample were small. We do the analysis and the result is very very clear.'
    body.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.click('.note-card.selected [data-note-check]')
  await page.waitForFunction(() => document.querySelectorAll('.assist-issue').length > 0, {
    timeout: 6000,
  })
  const checked = await page.evaluate(() => ({
    issues: document.querySelectorAll('.assist-issue').length,
    summary: document.querySelector('.assist-summary')?.textContent,
    errors: document.querySelectorAll('.hl-error').length,
    improves: document.querySelectorAll('.hl-improve').length,
  }))
  check('检查器列出问题', checked.issues === 3, `${checked.issues} 条 · ${checked.summary}`)
  check('原文高亮同时标出错误与优化', checked.errors === 2 && checked.improves === 1, `${checked.errors} 红 / ${checked.improves} 绿`)

  await page.screenshot({ path: path.join(outDir, 'english-checker.png') })

  await page.click('.assist-apply-all')
  await sleep(150)
  const fixed = await page.evaluate(
    () => document.querySelector('.note-card.selected .note-body').value,
  )
  check(
    '全部应用后正文被改写',
    fixed.includes('The sample was small') && fixed.includes('markedly'),
    fixed.slice(0, 70),
  )

  /* ---------------------------------------------------------------- */
  /* 4. degraded + toggle                                              */
  /* ---------------------------------------------------------------- */

  await page.evaluate(() => {
    window.__dpv.english.settings.setEnabled(false)
  })
  const labelText = await page.evaluate(() => {
    const el = document.getElementById('en-enabled')
    el.checked = false
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return document.getElementById('en-status').textContent
  })
  const barAfterOff = await page.evaluate(() => document.querySelector('.en-bar').hidden)
  check('关掉开关后浮条不再出现', barAfterOff === true, labelText)

  // Re-enable for the screenshot; the toggle itself is what was under test.
  await page.evaluate(() => {
    window.__dpv.english.settings.setEnabled(true)
    const el = document.getElementById('en-enabled')
    el.checked = true
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
  /* ---------------------------------------------------------------- */
  /* 5. PDF text layer                                                 */
  /* ---------------------------------------------------------------- */

  const pdfInput = await page.$('[data-side="left"] input[type=file]')
  await pdfInput.uploadFile(path.join(here, 'fixtures', 'paper-a.pdf'))
  await page.waitForFunction(
    () =>
      window.__dpv.panes.left.doc &&
      document.querySelectorAll('[data-side="left"] .page .textLayer span').length > 0,
    { timeout: 25000 },
  )

  const pdfSelected = await page.evaluate(() => {
    window.getSelection()?.removeAllRanges()
    window.__dpv.english.bar.hide()
    // pdf.js splits the text layer into word-level spans, so select the whole
    // layer of the first page instead of a single span.
    const layer = document.querySelector('[data-side="left"] .page .textLayer')
    if (!layer) return null
    const range = document.createRange()
    range.selectNodeContents(layer)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    const text = selection.toString().replace(/\s+/g, ' ').trim().slice(0, 40)
    const rect = range.getBoundingClientRect()
    layer.dispatchEvent(
      new MouseEvent('mouseup', {
        bubbles: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    )
    // Notes mode consumes the live selection on mouseup; the text is read first.
    return { text }
  })
  await sleep(120)
  const pdfBar = await page.evaluate(() => {
    const bar = document.querySelector('.en-bar')
    return {
      shown: !!bar && !bar.hidden,
      pages: document.querySelectorAll('[data-side="left"] .page').length,
      layers: document.querySelectorAll('[data-side="left"] .page .textLayer').length,
      spans: document.querySelectorAll('[data-side="left"] .page .textLayer span').length,
      selection: String(window.getSelection()).slice(0, 30),
    }
  })
  check(
    'PDF 文本层选区也能唤出浮条',
    pdfBar.shown && !!pdfSelected?.text,
    `${pdfSelected?.text || '无选区'} | ${JSON.stringify(pdfBar)}`,
  )

  await page.click('.en-bar [data-en="en-zh"]')
  await page.waitForFunction(
    () => {
      const main = document.querySelector('.en-card:not([hidden]) .en-main')
      return main && main.textContent && !main.textContent.includes('翻译中')
    },
    { timeout: 8000 },
  )
  const pdfCard = await page.evaluate(() => document.querySelector('.en-main').textContent)
  check('PDF 选区能出译文', pdfCard.length > 0, pdfCard.slice(0, 30))
  await page.evaluate(() => window.__dpv.english.bar.hide())

  await page.click('#settings-btn')
  await page.screenshot({ path: path.join(outDir, 'english-settings.png') })

  check('无控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '))
} finally {
  await browser.close()
}

mkdirSync(outDir, { recursive: true })
const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
