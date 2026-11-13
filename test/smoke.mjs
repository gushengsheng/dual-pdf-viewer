/**
 * Headless smoke test for the dual-pane viewer.
 *
 * Verifies the only requirement that actually matters: the two panes are
 * completely independent (scroll, zoom, page, keyboard, swap) and that the
 * text layer produces selectable text.
 *
 * Requires a running dev server (npm run dev) at DPV_URL or :5178.
 */
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, 'fixtures')
const outDir = path.join(here, 'out')

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

const url = process.env.DPV_URL || 'http://127.0.0.1:5178/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'],
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })

  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const loc = m.location?.() || {}
    consoleErrors.push({ text: m.text(), url: loc.url || '' })
  })
  page.on('pageerror', (e) => consoleErrors.push({ text: `pageerror: ${e.message}`, url: '' }))

  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 })

  const state = () =>
    page.evaluate(() => {
      const { panes } = window.__dpv
      const one = (p) => ({
        pages: p.doc ? p.doc.numPages : 0,
        scrollTop: Math.round(p.scrollEl.scrollTop),
        scale: Number(p.scale.toFixed(4)),
        name: p.nameEl.textContent,
        canvases: p.root.querySelectorAll('.page canvas').length,
        spans: p.root.querySelectorAll('.textLayer span').length,
        currentPage: p.currentPage,
        emptyHidden: p.emptyEl.classList.contains('hidden'),
      })
      return { left: one(panes.left), right: one(panes.right) }
    })

  const [leftInput] = await page.$$('[data-side="left"] input[type=file]')
  const [rightInput] = await page.$$('[data-side="right"] input[type=file]')
  await leftInput.uploadFile(path.join(fixtures, 'paper-a.pdf'))
  await rightInput.uploadFile(path.join(fixtures, 'paper-b.pdf'))

  await page.waitForFunction(
    () => {
      const p = window.__dpv.panes
      return p.left.doc && p.right.doc && p.left.rendered.size > 0 && p.right.rendered.size > 0
    },
    { timeout: 30000 },
  )
  await sleep(600)

  let s = await state()
  check('左窗格打开 paper-a', s.left.pages >= 5, `pages=${s.left.pages}`)
  check('右窗格打开 paper-b', s.right.pages >= 3, `pages=${s.right.pages}`)
  check('两份文档页数不同（确认是两份独立文档）', s.left.pages !== s.right.pages, `${s.left.pages} vs ${s.right.pages}`)
  check('两侧都渲染出 canvas', s.left.canvases >= 1 && s.right.canvases >= 1, `${s.left.canvases}/${s.right.canvases}`)
  check('文本层已生成（可选中复制）', s.left.spans > 0 && s.right.spans > 0, `spans ${s.left.spans}/${s.right.spans}`)
  check('空状态已隐藏', s.left.emptyHidden && s.right.emptyHidden)

  const textSample = await page.evaluate(() =>
    [...document.querySelectorAll('[data-side="left"] .textLayer span')]
      .map((n) => n.textContent)
      .join('')
      .slice(0, 120),
  )
  check('文本层能取到中文正文', textSample.length > 20, JSON.stringify(textSample.slice(0, 40)))

  // --- scrolling independence -------------------------------------------
  await page.evaluate(() => {
    window.__dpv.panes.left.scrollEl.scrollTop = 900
  })
  await sleep(500)
  let before = await state()
  check(
    '左窗格滚动后右窗格不动',
    before.left.scrollTop > 500 && before.right.scrollTop === 0,
    `L=${before.left.scrollTop} R=${before.right.scrollTop}`,
  )

  // --- keyboard routing --------------------------------------------------
  const leftScrollBefore = before.left.scrollTop
  const box = await page.$eval('[data-side="right"] .pane-scroll', (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  await page.mouse.move(box.x, box.y)
  await page.mouse.move(box.x + 2, box.y + 2)
  await sleep(150)
  const activeSide = await page.evaluate(() => (window.__dpv.getActive() === window.__dpv.panes.right ? 'right' : 'left'))
  check('鼠标悬停右侧后右侧成为 active', activeSide === 'right', activeSide)

  await page.keyboard.press('PageDown')
  await sleep(500)
  s = await state()
  check(
    'PageDown 只翻右窗格',
    s.right.scrollTop > 100 && s.left.scrollTop === leftScrollBefore,
    `L=${s.left.scrollTop} R=${s.right.scrollTop}`,
  )

  // --- zoom independence -------------------------------------------------
  const zoomBefore = (await state()).right.scale
  await page.mouse.move(200, 500)
  await sleep(150)
  await page.keyboard.press('Equal')
  await sleep(400)
  s = await state()
  check(
    '放大只作用于左侧',
    s.left.scale > before.left.scale && s.right.scale === zoomBefore,
    `L ${before.left.scale}->${s.left.scale}, R ${zoomBefore}->${s.right.scale}`,
  )

  // --- smooth ctrl+wheel zoom (Edge style) -------------------------------
  const rightBox = await page.$eval('[data-side="right"] .pane-scroll', (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  const readAnchor = (box) =>
    page.evaluate((b) => {
      const p = window.__dpv.panes.right
      const r = p.scrollEl.getBoundingClientRect()
      const my = b.y - r.top
      const yDoc = p.scrollEl.scrollTop + my
      let idx = 0
      for (let i = 0; i < p.offsets.length; i++) {
        if (p.offsets[i].top <= yDoc) idx = i
        else break
      }
      const off = p.offsets[idx]
      return {
        pageIndex: idx,
        pageFrac: off ? (yDoc - off.top) / off.h : 0,
        scale: p.scale,
        leftScale: window.__dpv.panes.left.scale,
      }
    }, box)

  await page.mouse.move(rightBox.x, rightBox.y)
  await sleep(150)
  const beforeSmooth = await readAnchor(rightBox)

  await page.evaluate(() => {
    const p = window.__dpv.panes.right
    window.__zoomSamples = []
    const start = performance.now()
    const tick = () => {
      window.__zoomSamples.push({
        tf: getComputedStyle(p.pagesEl).transform,
        anim: p.zoomAnim,
      })
      if (performance.now() - start < 700) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  await page.keyboard.down('Control')
  await page.mouse.wheel({ deltaY: -240 })
  await page.keyboard.up('Control')
  await sleep(1000)

  const zoomRun = await page.evaluate((b) => {
    const p = window.__dpv.panes.right
    const r = p.scrollEl.getBoundingClientRect()
    const my = b.y - r.top
    const yDoc = p.scrollEl.scrollTop + my
    let idx = 0
    for (let i = 0; i < p.offsets.length; i++) {
      if (p.offsets[i].top <= yDoc) idx = i
      else break
    }
    const off = p.offsets[idx]
    const samples = window.__zoomSamples || []
    const transforms = [...new Set(samples.map((s) => s.tf).filter((t) => t && t !== 'none'))]
    return {
      animatedFrames: samples.filter((s) => s.anim).length,
      distinctTransforms: transforms.length,
      finalTransform: samples.length ? samples[samples.length - 1].tf : null,
      scale: p.scale,
      leftScale: window.__dpv.panes.left.scale,
      pageIndex: idx,
      pageFrac: off ? (yDoc - off.top) / off.h : 0,
    }
  }, rightBox)

  check(
    'Ctrl+滚轮产生多帧中间缩放（不是一步跳）',
    zoomRun.animatedFrames >= 2 && zoomRun.distinctTransforms >= 2,
    `animated=${zoomRun.animatedFrames} distinct=${zoomRun.distinctTransforms}`,
  )
  check(
    '缩放结束后清除 transform 并重渲染',
    !zoomRun.finalTransform ||
      zoomRun.finalTransform === 'none' ||
      /matrix\(1,\s*0,\s*0,\s*1,/.test(zoomRun.finalTransform),
    String(zoomRun.finalTransform),
  )
  check(
    'Ctrl+滚轮只放大右侧',
    zoomRun.scale > beforeSmooth.scale * 1.05 && zoomRun.leftScale === beforeSmooth.leftScale,
    `${beforeSmooth.scale} -> ${zoomRun.scale}`,
  )
  check(
    '缩放时光标下的内容点保持不动',
    zoomRun.pageIndex === beforeSmooth.pageIndex &&
      Math.abs(zoomRun.pageFrac - beforeSmooth.pageFrac) < 0.01,
    `page ${beforeSmooth.pageIndex + 1}@${beforeSmooth.pageFrac.toFixed(3)} -> page ${zoomRun.pageIndex + 1}@${zoomRun.pageFrac.toFixed(3)}`,
  )

  // --- centre anchor with an off-centre cursor --------------------------
  await page.evaluate(() => window.__dpv.setPrefs({ anchor: 'center', step: 0.11, smooth: 70 }))
  const paneRect = await page.$eval('[data-side="right"] .pane-scroll', (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  const centerPoint = { x: paneRect.x + paneRect.w / 2, y: paneRect.y + paneRect.h / 2 }
  const offCenter = { x: paneRect.x + paneRect.w * 0.3, y: paneRect.y + paneRect.h * 0.3 }

  await page.mouse.move(offCenter.x, offCenter.y)
  await sleep(150)
  const centreBefore = await readAnchor(centerPoint)
  await page.keyboard.down('Control')
  await page.mouse.wheel({ deltaY: -120 })
  await page.keyboard.up('Control')
  await sleep(900)
  const centreAfter = await readAnchor(centerPoint)
  check(
    '锚点=中心时，缩放后视口中心的内容不动',
    centreAfter.pageIndex === centreBefore.pageIndex &&
      Math.abs(centreAfter.pageFrac - centreBefore.pageFrac) < 0.012,
    `page ${centreBefore.pageIndex + 1}@${centreBefore.pageFrac.toFixed(3)} -> page ${centreAfter.pageIndex + 1}@${centreAfter.pageFrac.toFixed(3)}`,
  )

  // --- configurable zoom speed ------------------------------------------
  await page.evaluate(() => window.__dpv.setPrefs({ step: 0.3, smooth: 60 }))
  const stepBefore = await page.evaluate(() => window.__dpv.panes.right.scale)
  await page.mouse.move(centerPoint.x, centerPoint.y)
  await sleep(120)
  await page.keyboard.down('Control')
  await page.mouse.wheel({ deltaY: -100 })
  await page.keyboard.up('Control')
  await sleep(800)
  const stepAfter = await page.evaluate(() => window.__dpv.panes.right.scale)
  const stepRatio = stepAfter / stepBefore
  check(
    '步进设置生效：一格 = +30%',
    Math.abs(stepRatio - 1.3) < 0.04,
    `${stepBefore.toFixed(3)} -> ${stepAfter.toFixed(3)} (×${stepRatio.toFixed(3)})`,
  )

  // --- settings panel ----------------------------------------------------
  await page.click('#settings-btn')
  await sleep(200)
  const panelOpen = await page.$eval('#settings', (el) => !el.hidden)
  await page.click('#seg-anchor .seg-btn[data-value="cursor"]')
  await sleep(120)
  const anchorNow = await page.evaluate(() => window.__dpv.prefs.anchor)
  const storedPrefs = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('dpv:prefs:v1') || '{}'),
  )
  check(
    '设置面板可切换到鼠标锚点并持久化',
    panelOpen && anchorNow === 'cursor' && storedPrefs.anchor === 'cursor',
    `open=${panelOpen} anchor=${anchorNow} stored=${storedPrefs.anchor}`,
  )
  await page.click('#seg-anchor .seg-btn[data-value="center"]')
  await page.mouse.click(paneRect.x + 20, paneRect.y + 20)
  await page.evaluate(() => window.__dpv.setPrefs({ step: 0.11, smooth: 70 }))

  // --- tools: select / marquee ------------------------------------------
  await page.evaluate(() => {
    const p = window.__dpv.panes.left
    p.scrollEl.scrollTop = 0
    p.setTool('select')
  })
  await sleep(250)

  await page.mouse.move(400, 450)
  await page.keyboard.press('z')
  await sleep(150)
  const toolAfterKey = await page.evaluate(() => window.__dpv.panes.left.tool)
  check('快捷键 z 切到框选工具', toolAfterKey === 'marquee', toolAfterKey)

  const pageRect = await page.$eval('[data-side="left"] .page[data-page="1"]', (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  const dragFrom = { x: pageRect.x + pageRect.w * 0.14, y: pageRect.y + pageRect.h * 0.22 }
  const dragTo = { x: pageRect.x + pageRect.w * 0.66, y: pageRect.y + pageRect.h * 0.37 }
  const dragAspect = (dragTo.x - dragFrom.x) / (dragTo.y - dragFrom.y)
  const scaleBeforeLens = await page.evaluate(() => window.__dpv.panes.left.scale)

  await page.mouse.move(dragFrom.x, dragFrom.y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(
      dragFrom.x + ((dragTo.x - dragFrom.x) * i) / 8,
      dragFrom.y + ((dragTo.y - dragFrom.y) * i) / 8,
    )
  }
  await page.mouse.up()
  await sleep(900)

  const lens = await page.evaluate(() => {
    const p = window.__dpv.panes.left
    const c = p.lensCanvas
    let dark = 0
    if (c.width && c.height) {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) dark++
      }
      dark /= d.length / 4
    }
    return {
      hidden: p.lensEl.hidden,
      w: c.width,
      h: c.height,
      ink: dark,
      scale: p.scale,
      info: p.lensInfo.textContent,
    }
  })
  check('框选后出现放大镜', !lens.hidden && lens.w > 100 && lens.h > 60, `${lens.w}x${lens.h} ${lens.info}`)
  check('放大镜保持选区比例', Math.abs(lens.w / lens.h - dragAspect) < 0.2, `${(lens.w / lens.h).toFixed(2)} vs ${dragAspect.toFixed(2)}`)
  check('放大镜里确有内容（非空白）', lens.ink > 0.01, `ink=${(lens.ink * 100).toFixed(1)}%`)
  check('放大镜不改变主视图缩放', lens.scale === scaleBeforeLens, `${scaleBeforeLens}`)

  await page.keyboard.press('Escape')
  await sleep(200)
  const lensClosed = await page.evaluate(() => window.__dpv.panes.left.lensEl.hidden)
  check('Esc 回到原视角', lensClosed === true)

  // reopen and close with the button
  await page.mouse.move(dragFrom.x, dragFrom.y)
  await page.mouse.down()
  await page.mouse.move(dragTo.x, dragTo.y)
  await page.mouse.up()
  await sleep(700)
  await page.click('[data-side="left"] .lens-back')
  await sleep(200)
  const lensClosedByBtn = await page.evaluate(() => window.__dpv.panes.left.lensEl.hidden)
  check('「回到原视角」按钮可关闭', lensClosedByBtn === true)

  // --- marquee mode can still move the view ------------------------------
  await page.evaluate(() => {
    const p = window.__dpv.panes.left
    p.setTool('marquee')
    p.scrollEl.scrollTop = 300
  })
  await sleep(200)
  const scrollBeforeWheel = await page.evaluate(() => window.__dpv.panes.left.scrollEl.scrollTop)
  await page.mouse.move(300, 500)
  await page.mouse.wheel({ deltaY: 320 })
  await sleep(350)
  const scrollAfterWheel = await page.evaluate(() => window.__dpv.panes.left.scrollEl.scrollTop)
  check(
    '框选模式下滚轮仍能滚动',
    scrollAfterWheel > scrollBeforeWheel + 200,
    `${scrollBeforeWheel} -> ${scrollAfterWheel}`,
  )

  const panStart = await page.evaluate(() => window.__dpv.panes.left.scrollEl.scrollTop)
  await page.mouse.move(300, 500)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(300, 360)
  await page.mouse.up({ button: 'middle' })
  await sleep(250)
  const panEnd = await page.evaluate(() => window.__dpv.panes.left.scrollEl.scrollTop)
  const lensAfterPan = await page.evaluate(() => window.__dpv.panes.left.lensEl.hidden)
  check('框选模式下中键拖动可平移', panEnd > panStart + 100, `${panStart} -> ${panEnd}`)
  check('中键拖动不会误开镜面', lensAfterPan === true)

  // --- switching tools closes the lens -----------------------------------
  await page.evaluate(() => {
    const p = window.__dpv.panes.left
    p.scrollEl.scrollTop = 0
  })
  await sleep(300)
  const pr = await page.$eval('[data-side="left"] .page[data-page="1"]', (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  await page.mouse.move(pr.x + pr.w * 0.2, pr.y + pr.h * 0.2)
  await page.mouse.down()
  await page.mouse.move(pr.x + pr.w * 0.6, pr.y + pr.h * 0.35)
  await page.mouse.up()
  await sleep(900)
  const openBeforeZ = await page.evaluate(() => !window.__dpv.panes.left.lensEl.hidden)
  await page.keyboard.press('z')
  await sleep(300)
  const closedAfterZ = await page.evaluate(() => window.__dpv.panes.left.lensEl.hidden)
  check(
    '放大后按 z 关闭镜面（切工具即关闭）',
    openBeforeZ && closedAfterZ,
    `open=${openBeforeZ} closed=${closedAfterZ}`,
  )

  // rebind the marquee shortcut
  await page.evaluate(() => window.__dpv.setPrefs({ toolKeys: { marquee: 'b' } }))
  await page.keyboard.press('b')
  await sleep(120)
  const toolAfterRebind = await page.evaluate(() => window.__dpv.panes.left.tool)
  await page.keyboard.press('z')
  await sleep(120)
  const toolAfterOldKey = await page.evaluate(() => window.__dpv.panes.left.tool)
  check(
    '改键后新快捷键生效、旧键失效',
    toolAfterRebind === 'marquee' && toolAfterOldKey === 'marquee',
    `b->${toolAfterRebind} z->${toolAfterOldKey}`,
  )
  await page.evaluate(() => window.__dpv.setPrefs({ toolKeys: { marquee: 'z' } }))
  await page.keyboard.press('v')
  await sleep(120)
  const toolBackToSelect = await page.evaluate(() => window.__dpv.panes.left.tool)
  check('快捷键 v 切回选择工具', toolBackToSelect === 'select', toolBackToSelect)

  // --- notes mode ---------------------------------------------------------
  await page.click('[data-side="left"] [data-act="notes"]')
  await sleep(350)
  const notesModeState = await page.evaluate(() => ({
    mode: document.getElementById('workspace').classList.contains('notes-mode'),
    panel: !document.getElementById('notes-panel').hidden,
    rightHidden: getComputedStyle(document.querySelector('[data-side="right"]')).display === 'none',
  }))
  check(
    '笔记模式：右侧换成笔记面板',
    notesModeState.mode && notesModeState.panel && notesModeState.rightHidden,
    JSON.stringify(notesModeState),
  )

  const selectSpanInPage = async (pageNo, index) => {
    const ok = await page.evaluate(
      ({ pageNo, index }) => {
        const pageEl = document.querySelector(`[data-side="left"] .page[data-page="${pageNo}"]`)
        const spans = [...(pageEl?.querySelectorAll('.textLayer span') || [])].filter(
          (s) => s.getBoundingClientRect().width > 0,
        )
        if (!spans.length || !spans[index]) return false
        const range = document.createRange()
        range.selectNodeContents(spans[index])
        const sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
        const r = spans[index].getBoundingClientRect()
        document.querySelector('[data-side="left"] .pane-scroll').dispatchEvent(
          new MouseEvent('mouseup', {
            bubbles: true,
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2,
          }),
        )
        return true
      },
      { pageNo, index },
    )
    await sleep(250)
    return ok
  }

  await page.evaluate(() => {
    window.__dpv.panes.left.scrollEl.scrollTop = 0
  })
  await sleep(300)

  await selectSpanInPage(1, 0)
  const afterAdd = await page.evaluate(() => ({
    cards: document.querySelectorAll('.note-card').length,
    bubbles: document.querySelectorAll('[data-side="left"] .note-bubble').length,
    pending: document.querySelectorAll('[data-side="left"] .note-bubble.pending').length,
    items: window.__dpv.notes.items.length,
    focused: document.activeElement?.className || '',
  }))
  check(
    '笔记模式下选中文字自动生成条目',
    afterAdd.cards === 1 &&
      afterAdd.items === 1 &&
      afterAdd.bubbles === 1 &&
      afterAdd.pending === 0,
    JSON.stringify(afterAdd),
  )

  await page.keyboard.type('第一条笔记正文')
  await sleep(500)
  const storedNote = await page.evaluate(() => {
    const fp = window.__dpv.panes.left.fp
    const raw = JSON.parse(localStorage.getItem(`dpv:notes:${fp}`) || '{}')
    return { count: raw.items?.length, body: raw.items?.[0]?.body }
  })
  check('笔记正文写入 localStorage', storedNote.count === 1 && storedNote.body === '第一条笔记正文', JSON.stringify(storedNote))

  await selectSpanInPage(2, 0)
  const afterSecond = await page.evaluate(() => ({
    cards: document.querySelectorAll('.note-card').length,
    bubbles: document.querySelectorAll('[data-side="left"] .note-bubble').length,
  }))
  check('第二条自动加入', afterSecond.cards === 2 && afterSecond.bubbles === 2, JSON.stringify(afterSecond))

  // select the first card, then navigate down with the keyboard
  await page.evaluate(() => document.querySelectorAll('.note-card')[0].click())
  await sleep(700)
  const navBefore = await page.evaluate(() => ({
    id: window.__dpv.notes.selectedId,
    top: window.__dpv.panes.left.scrollEl.scrollTop,
  }))
  await page.evaluate(() => document.querySelector('.notes-list').focus())
  await page.keyboard.press('ArrowDown')
  await sleep(800)
  const navAfter = await page.evaluate(() => ({
    id: window.__dpv.notes.selectedId,
    top: window.__dpv.panes.left.scrollEl.scrollTop,
  }))
  check(
    '上下键切换条目，左侧自动跳回该句',
    navAfter.id !== navBefore.id && navAfter.top - navBefore.top > 100,
    `${navBefore.id}->${navAfter.id} top ${Math.round(navBefore.top)}->${Math.round(navAfter.top)}`,
  )

  await page.evaluate(() => document.querySelectorAll('.note-card')[0].click())
  await sleep(800)
  const backTop = await page.evaluate(() => window.__dpv.panes.left.scrollEl.scrollTop)
  check('点条目左侧回到对应句子', backTop < 400, `top=${Math.round(backTop)}`)

  await page.evaluate(() => {
    const cards = document.querySelectorAll('.note-card')
    cards[1]?.querySelector('.note-del')?.click()
  })
  await sleep(400)
  const afterDelete = await page.evaluate(() => document.querySelectorAll('.note-card').length)
  check('删除条目', afterDelete === 1, `cards=${afterDelete}`)

  // --- export notes -------------------------------------------------------
  await page.click('#notes-export')
  await sleep(250)
  const exportMenuOpen = await page.evaluate(
    () => !document.getElementById('notes-export-menu').hidden,
  )
  await page.click('#notes-export-menu [data-export="md"]')
  await sleep(500)
  const mdExport = await page.evaluate(() => window.__dpv.notes.lastExport)
  check(
    '导出 Markdown 含引用与正文',
    exportMenuOpen &&
      !!mdExport &&
      mdExport.filename.endsWith('.md') &&
      mdExport.text.includes('第一条笔记正文') &&
      mdExport.text.includes('第 1 页'),
    JSON.stringify({ menu: exportMenuOpen, file: mdExport?.filename }),
  )

  await page.click('#notes-export')
  await sleep(200)
  await page.click('#notes-export-menu [data-export="json"]')
  await sleep(500)
  const jsonExport = await page.evaluate(() => {
    const e = window.__dpv.notes.lastExport
    let parsed = null
    try {
      parsed = JSON.parse(e.text)
    } catch {
      /* ignore */
    }
    return {
      filename: e.filename,
      count: parsed?.notes?.length ?? -1,
      source: parsed?.source ?? '',
      quote: parsed?.notes?.[0]?.quote ?? '',
    }
  })
  check(
    '导出 JSON 可被解析',
    jsonExport.filename.endsWith('.json') &&
      jsonExport.count === 1 &&
      jsonExport.source.includes('paper-a') &&
      jsonExport.quote.length > 0,
    JSON.stringify(jsonExport),
  )

  // --- double click background opens the file picker ----------------------
  await page.evaluate(() => {
    window.__pickerOpened = 0
    window.__dbl = 0
    document.addEventListener('dblclick', () => {
      window.__dbl++
    }, true)
    document
      .querySelector('[data-side="left"] input[type=file]')
      .addEventListener('click', () => {
        window.__pickerOpened++
      })
  })
  await page.mouse.move(6, 600)
  await page.mouse.down({ clickCount: 1 })
  await page.mouse.up({ clickCount: 1 })
  await page.mouse.down({ clickCount: 2 })
  await page.mouse.up({ clickCount: 2 })
  await sleep(300)
  const pickerOpened = await page.evaluate(() => ({
    opened: window.__pickerOpened,
    dbl: window.__dbl,
  }))
  check('双击空白处打开文件选择', pickerOpened.opened >= 1, JSON.stringify(pickerOpened))

  await page.click('#notes-exit')
  await sleep(400)
  const notesExited = await page.evaluate(() => ({
    panelHidden: document.getElementById('notes-panel').hidden,
    rightVisible: getComputedStyle(document.querySelector('[data-side="right"]')).display !== 'none',
  }))
  check('退出笔记模式恢复右侧 PDF', notesExited.panelHidden && notesExited.rightVisible, JSON.stringify(notesExited))

  // --- notes belong to the pane you selected ------------------------------
  await page.mouse.click(paneRect.x + 60, paneRect.y + 80)
  await sleep(200)
  const activeIsRight = await page.evaluate(
    () => window.__dpv.getActive() === window.__dpv.panes.right,
  )
  await page.click('[data-side="right"] [data-act="notes"]')
  await sleep(450)
  const rightNotes = await page.evaluate(() => ({
    side: document.getElementById('workspace').dataset.notesSide,
    leftHidden: getComputedStyle(document.querySelector('[data-side="left"]')).display === 'none',
    source: document.querySelector('.notes-source').textContent,
  }))
  check(
    '选中右侧窗格，进入的是右侧的笔记',
    activeIsRight && rightNotes.side === 'left' && rightNotes.leftHidden && rightNotes.source.includes('paper-b'),
    JSON.stringify({ activeIsRight, ...rightNotes }),
  )

  await page.evaluate(() => {
    window.__dpv.panes.right.scrollEl.scrollTop = 0
  })
  await sleep(300)
  await page.evaluate(() => {
    const pageEl = document.querySelector('[data-side="right"] .page[data-page="1"]')
    const spans = [...(pageEl?.querySelectorAll('.textLayer span') || [])].filter(
      (s) => s.getBoundingClientRect().width > 0,
    )
    if (!spans.length) return
    const range = document.createRange()
    range.selectNodeContents(spans[0])
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    const r = spans[0].getBoundingClientRect()
    document.querySelector('[data-side="right"] .pane-scroll').dispatchEvent(
      new MouseEvent('mouseup', {
        bubbles: true,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      }),
    )
  })
  await sleep(300)
  const rightAfterSelect = await page.evaluate(() => ({
    cards: document.querySelectorAll('.note-card').length,
    bubbles: document.querySelectorAll('[data-side="right"] .note-bubble').length,
  }))
  check(
    '右侧窗格选中文字也自动加入',
    rightAfterSelect.cards === 1 && rightAfterSelect.bubbles === 1,
    JSON.stringify(rightAfterSelect),
  )

  const rightNoteState = await page.evaluate(() => {
    const fp = window.__dpv.panes.right.fp
    const raw = JSON.parse(localStorage.getItem(`dpv:notes:${fp}`) || '{}')
    return { cards: document.querySelectorAll('.note-card').length, stored: raw.items?.length ?? 0 }
  })
  check('右侧笔记独立存储', rightNoteState.cards === 1 && rightNoteState.stored === 1, JSON.stringify(rightNoteState))

  await page.click('#notes-exit')
  await sleep(400)

  // --- notes mode: box-drag also notes, Esc exits -------------------------
  await page.evaluate(() => {
    const p = window.__dpv.panes.left
    p.setTool('select')
    p.scrollEl.scrollTop = 0
  })
  await page.mouse.move(200, 400)
  await page.click('[data-side="left"] [data-act="notes"]')
  await sleep(450)
  const leftNotesOn = await page.evaluate(() => !document.getElementById('notes-panel').hidden)
  const cardsBeforeRegion = await page.evaluate(() => document.querySelectorAll('.note-card').length)

  const pr1 = await page.$eval('[data-side="left"] .page[data-page="1"]', (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  await page.mouse.move(pr1.x + pr1.w * 0.15, pr1.y + pr1.h * 0.48)
  await page.mouse.down()
  await page.mouse.move(pr1.x + pr1.w * 0.6, pr1.y + pr1.h * 0.6, { steps: 6 })
  await page.mouse.up()
  await sleep(700)
  const regionState = await page.evaluate(() => ({
    cards: document.querySelectorAll('.note-card').length,
    lens: !window.__dpv.panes.left.lensEl.hidden,
  }))
  check(
    '笔记模式下框选空白区域直接记一条',
    leftNotesOn && regionState.cards === cardsBeforeRegion + 1 && regionState.lens === false,
    JSON.stringify({ leftNotesOn, ...regionState }),
  )

  await page.evaluate(() => window.__dpv.panes.left.setTool('marquee'))
  await sleep(150)
  const cardsBeforeMarquee = await page.evaluate(() => document.querySelectorAll('.note-card').length)
  await page.mouse.move(pr1.x + pr1.w * 0.12, pr1.y + pr1.h * 0.2)
  await page.mouse.down()
  await page.mouse.move(pr1.x + pr1.w * 0.7, pr1.y + pr1.h * 0.3, { steps: 6 })
  await page.mouse.up()
  await sleep(700)
  const marqueeState = await page.evaluate(() => {
    const quotes = [...document.querySelectorAll('.note-quote')]
    return {
      cards: document.querySelectorAll('.note-card').length,
      lens: !window.__dpv.panes.left.lensEl.hidden,
      lastQuote: quotes.length ? quotes[quotes.length - 1].textContent : '',
    }
  })
  check(
    '笔记模式下框选文字区域记一条（不开镜面）',
    marqueeState.cards === cardsBeforeMarquee + 1 &&
      marqueeState.lens === false &&
      marqueeState.lastQuote.length > 5,
    JSON.stringify(marqueeState),
  )

  await page.evaluate(() => window.__dpv.panes.left.setTool('select'))
  await page.keyboard.press('Escape')
  await sleep(400)
  const escExited = await page.evaluate(() => ({
    panelHidden: document.getElementById('notes-panel').hidden,
    noteBtnActive: document
      .querySelector('[data-side="left"] [data-act="notes"]')
      .classList.contains('active'),
  }))
  check('Esc 退出笔记模式', escExited.panelHidden && !escExited.noteBtnActive, JSON.stringify(escExited))

  // --- the exit shortcut is configurable ---------------------------------
  await page.evaluate(() => window.__dpv.setPrefs({ toolKeys: { notesExit: 'q' } }))
  await page.click('[data-side="left"] [data-act="notes"]')
  await sleep(450)
  const reopened = await page.evaluate(() => !document.getElementById('notes-panel').hidden)
  await page.keyboard.press('q')
  await sleep(350)
  const closedByQ = await page.evaluate(() => document.getElementById('notes-panel').hidden)
  check('退出笔记的快捷键可改', reopened && closedByQ, `open=${reopened} closed=${closedByQ}`)
  await page.evaluate(() => window.__dpv.setPrefs({ toolKeys: { notesExit: 'escape' } }))

  // --- page jump ---------------------------------------------------------
  await page.click('[data-side="left"] .page-input', { clickCount: 3 })
  await page.type('[data-side="left"] .page-input', '4')
  await page.keyboard.press('Enter')
  await sleep(500)
  s = await state()
  check('页码跳转只影响左侧', s.left.currentPage === 4, `left page=${s.left.currentPage}`)

  // --- swap --------------------------------------------------------------
  const nameBefore = (await state()).left.name
  await page.click('#swap')
  await page.waitForFunction(
    () => window.__dpv.panes.left.doc && window.__dpv.panes.right.doc,
    { timeout: 15000 },
  )
  await sleep(1200)
  s = await state()
  check('互换左右生效', s.left.name !== nameBefore && s.right.name === nameBefore, `${s.left.name} / ${s.right.name}`)

  // --- splitter ----------------------------------------------------------
  await page.click('[data-side="left"] [data-act="fit"]')
  await sleep(700)
  const beforeSplit = await state()
  const leftBoxBefore = await page.$eval('[data-side="left"]', (el) => el.getBoundingClientRect().width)
  const rightScaleBeforeSplit = beforeSplit.right.scale

  const sp = await page.$eval('#splitter', (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  await page.mouse.move(sp.x, sp.y)
  await page.mouse.down()
  for (let i = 1; i <= 6; i++) await page.mouse.move(sp.x + i * 25, sp.y)
  await page.mouse.up()
  await sleep(900)

  s = await state()
  const leftBoxAfter = await page.$eval('[data-side="left"]', (el) => el.getBoundingClientRect().width)
  check('拖动分隔条改变左栏宽度', leftBoxAfter > leftBoxBefore + 100, `${Math.round(leftBoxBefore)} -> ${Math.round(leftBoxAfter)}`)
  check('适宽模式跟随新宽度重算缩放', s.left.scale > beforeSplit.left.scale, `${beforeSplit.left.scale} -> ${s.left.scale}`)
  check('分隔条不影响非适宽的一侧', s.right.scale === rightScaleBeforeSplit, `${s.right.scale}`)

  const sp2 = await page.$eval('#splitter', (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  await page.mouse.click(sp2.x, sp2.y)
  await page.mouse.click(sp2.x, sp2.y)
  await sleep(700)
  const lw = await page.$eval('[data-side="left"]', (el) => el.getBoundingClientRect().width)
  const rw = await page.$eval('[data-side="right"]', (el) => el.getBoundingClientRect().width)
  check('双击分隔条恢复平分', Math.abs(lw - rw) <= 10, `${Math.round(lw)} vs ${Math.round(rw)}`)

  // --- open by path (only the local server injects the flag) -------------
  const pathApi = await page.evaluate(() => !!window.__DUAL_PDF_LOCAL__)

  if (pathApi) {
    await page.mouse.move(paneRect.x + 80, paneRect.y + 80)
    await sleep(150)
    await page.keyboard.down('Control')
    await page.keyboard.press('l')
    await page.keyboard.up('Control')
    await sleep(250)
    const ctrlL = await page.evaluate(() => {
      const p = window.__dpv.panes.right
      return !p.openMenu.hidden && document.activeElement === p.openPathInput
    })
    check('Ctrl+L 聚焦路径输入', ctrlL === true, String(ctrlL))
    await page.keyboard.press('Escape')
    await sleep(150)

    await page.click('[data-side="right"] [data-act="open"]')
    await sleep(250)
    const menuOpen = await page.evaluate(() => {
      const m = document.querySelector('[data-side="right"] .open-menu')
      return !!m && !m.hidden
    })
    await page.type('[data-side="right"] .open-path-input', path.join(fixtures, 'paper-b.pdf'))
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      () => {
        const p = window.__dpv.panes.right
        return !!p.doc && p.nameEl.textContent === 'paper-b.pdf'
      },
      { timeout: 15000 },
    )
    await sleep(600)
    const pathLoaded = await page.evaluate(() => {
      const p = window.__dpv.panes.right
      return {
        name: p.nameEl.textContent,
        canvases: p.root.querySelectorAll('.page canvas').length,
        menuHidden: p.openMenu.hidden,
      }
    })
    check(
      '输入路径打开 PDF',
      menuOpen && pathLoaded.name === 'paper-b.pdf' && pathLoaded.canvases > 0 && pathLoaded.menuHidden,
      JSON.stringify(pathLoaded),
    )

    await page.click('[data-side="right"] [data-act="open"]')
    await sleep(200)
    await page.type('[data-side="right"] .open-path-input', path.join(fixtures, 'nope.pdf'))
    await page.keyboard.press('Enter')
    await sleep(800)
    const badPath = await page.evaluate(() => {
      const p = window.__dpv.panes.right
      return {
        hint: p.openHintEl.textContent,
        name: p.nameEl.textContent,
        error: p.openHintEl.classList.contains('error'),
      }
    })
    check(
      '错误路径有提示且不破坏当前文档',
      badPath.error && badPath.hint.length > 0 && badPath.name === 'paper-b.pdf',
      JSON.stringify(badPath),
    )
    await page.keyboard.press('Escape')
    await sleep(150)
  } else {
    console.log('SKIP  输入路径打开（当前不是本地服务，dev 模式属正常）')
  }

  // --- markdown ---------------------------------------------------------
  await rightInput.uploadFile(path.join(fixtures, 'notes-sample.md'))
  await sleep(900)
  const mdState = await page.evaluate(() => {
    const p = window.__dpv.panes.right
    const doc = p.root.querySelector('.md-doc')
    return {
      kind: p.kind,
      visible: !!doc && !doc.hidden,
      h1: doc?.querySelector('h1')?.textContent?.trim() || '',
      tables: doc ? doc.querySelectorAll('table').length : 0,
      pageDisabled: p.pageInput.disabled,
      canvases: p.root.querySelectorAll('.page canvas').length,
      font: doc ? parseFloat(getComputedStyle(doc).fontSize) : 0,
    }
  })
  check(
    'Markdown 渲染为文章',
    mdState.kind === 'text' && mdState.visible && mdState.h1.length > 0 && mdState.tables === 1,
    JSON.stringify(mdState),
  )
  check(
    'Markdown 模式隐藏 PDF 画布并禁用页码',
    mdState.canvases === 0 && mdState.pageDisabled === true,
    JSON.stringify(mdState),
  )

  const mdBox = await page.$eval('[data-side="right"] .pane-scroll', (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  await page.mouse.move(mdBox.x, mdBox.y)
  await sleep(150)
  await page.keyboard.press('Equal')
  await sleep(450)
  const mdZoom = await page.evaluate(() => {
    const p = window.__dpv.panes.right
    const doc = p.root.querySelector('.md-doc')
    return { font: parseFloat(getComputedStyle(doc).fontSize), label: p.zoomEl.textContent }
  })
  check('Markdown 支持字号缩放', mdZoom.font > mdState.font + 1, `${mdState.font} -> ${mdZoom.font} (${mdZoom.label})`)

  // --- notes on markdown --------------------------------------------------
  await page.mouse.move(mdBox.x, mdBox.y)
  await page.click('[data-side="right"] [data-act="notes"]')
  await sleep(650)
  const mdNotesMode = await page.evaluate(() => ({
    panel: !document.getElementById('notes-panel').hidden,
    source: document.querySelector('.notes-source').textContent,
  }))
  check(
    'Markdown 也能进笔记模式',
    mdNotesMode.panel && mdNotesMode.source.includes('notes-sample'),
    JSON.stringify(mdNotesMode),
  )

  const mdSelected = await page.evaluate(() => {
    const doc = document.querySelector('[data-side="right"] .md-doc')
    const block = [...doc.querySelectorAll('p, li, h1, h2')].find((el) =>
      el.textContent.includes('样本量'),
    )
    if (!block) return null
    const range = document.createRange()
    range.selectNodeContents(block)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    const r = range.getBoundingClientRect()
    document.querySelector('[data-side="right"] .pane-scroll').dispatchEvent(
      new MouseEvent('mouseup', {
        bubbles: true,
        clientX: r.left + 5,
        clientY: r.top + 5,
      }),
    )
    return block.textContent.trim().slice(0, 20)
  })
  await sleep(700)
  const mdNoteState = await page.evaluate(() => {
    const p = window.__dpv.panes.right
    const cards = document.querySelectorAll('.note-card')
    const last = cards[cards.length - 1]
    return {
      cards: cards.length,
      quote: last?.querySelector('.note-quote')?.textContent || '',
      meta: last?.querySelector('.note-meta')?.textContent || '',
      bubbles: p.mdEl.querySelectorAll('.note-bubble').length,
    }
  })
  check(
    'Markdown 选中文字自动成条',
    !!mdSelected && mdNoteState.cards === 1 && mdNoteState.bubbles === 1,
    JSON.stringify(mdNoteState),
  )
  check('Markdown 笔记标注来源', /Markdown/.test(mdNoteState.meta), mdNoteState.meta)

  await page.evaluate(() => document.querySelectorAll('.note-card')[0].click())
  await sleep(600)
  const mdReveal = await page.evaluate(() => ({
    selected: document.querySelector('.note-card.selected') ? 1 : 0,
    hasFlash: !!document.querySelector('.md-doc .note-flash'),
  }))
  check('点 Markdown 笔记能定位原文', mdReveal.selected === 1 && mdReveal.hasFlash, JSON.stringify(mdReveal))

  await page.click('#notes-exit')
  await sleep(450)

  // --- txt ----------------------------------------------------------------
  await rightInput.uploadFile(path.join(fixtures, 'plain-notes.txt'))
  await sleep(800)
  const txtState = await page.evaluate(() => {
    const p = window.__dpv.panes.right
    const doc = p.root.querySelector('.md-doc')
    return {
      kind: p.kind,
      format: p.textFormat,
      paragraphs: doc ? doc.querySelectorAll('p').length : 0,
      text: doc ? doc.innerText : '',
      exportHidden: p.root.querySelector('[data-act="export-text"]').hidden,
    }
  })
  check(
    'TXT 渲染为纯文本段落',
    txtState.kind === 'text' &&
      txtState.format === 'txt' &&
      txtState.paragraphs >= 3 &&
      txtState.text.includes('A 组 421 例'),
    JSON.stringify({ ...txtState, text: txtState.text.slice(0, 30) }),
  )
  check('TXT 显示「导出全文」按钮', txtState.exportHidden === false, String(txtState.exportHidden))

  await page.click('[data-side="right"] [data-act="export-text"]')
  await sleep(400)
  const txtExport = await page.evaluate(() => window.__dpv.panes.right.lastTextExport)
  check(
    '导出全文内容与原文一致',
    txtExport.filename.endsWith('.txt') && txtExport.text.includes('切缘阳性'),
    JSON.stringify({ file: txtExport.filename, len: txtExport.text.length }),
  )

  await page.mouse.move(mdBox.x, mdBox.y)
  await page.click('[data-side="right"] [data-act="notes"]')
  await sleep(600)
  await page.evaluate(() => {
    const doc = document.querySelector('[data-side="right"] .md-doc')
    const block = [...doc.querySelectorAll('p')].find((el) => el.textContent.includes('A 组 421'))
    if (!block) return
    const range = document.createRange()
    range.selectNodeContents(block)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    const r = range.getBoundingClientRect()
    document.querySelector('[data-side="right"] .pane-scroll').dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }),
    )
  })
  await sleep(700)
  const txtNote = await page.evaluate(() => {
    const p = window.__dpv.panes.right
    const cards = document.querySelectorAll('.note-card')
    const last = cards[cards.length - 1]
    return {
      cards: cards.length,
      meta: last?.querySelector('.note-meta')?.textContent || '',
      bubbles: p.mdEl.querySelectorAll('.note-bubble').length,
    }
  })
  check(
    'TXT 也能记笔记并标注 TXT',
    txtNote.cards === 1 && /TXT/.test(txtNote.meta) && txtNote.bubbles === 1,
    JSON.stringify(txtNote),
  )
  await page.click('#notes-exit')
  await sleep(450)

  // PDF left + TXT right for the final screenshot (TXT shows 「导出全文」)
  await leftInput.uploadFile(path.join(fixtures, 'paper-a.pdf'))
  await sleep(1400)

  // clean final state for the screenshot: both sides fit width
  await page.click('[data-side="right"] [data-act="fit"]')
  await sleep(800)

  // The bad-path test intentionally produces one 404 for /__open; anything else
  // in the console is a real failure.
  const unexpectedErrors = consoleErrors.filter((e) => !e.url.includes('/__open'))
  check(
    '没有控制台报错',
    unexpectedErrors.length === 0,
    unexpectedErrors
      .slice(0, 3)
      .map((e) => e.text)
      .join(' | '),
  )

  mkdirSync(outDir, { recursive: true })
  const shot = path.join(outDir, 'smoke.png')
  await page.screenshot({ path: shot })
  console.log(`\nscreenshot: ${shot}`)

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exitCode = failed.length ? 1 : 0
} finally {
  await browser.close()
}
