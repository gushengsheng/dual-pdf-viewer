// Local launcher: serve the built app and open it in a chromeless app window
// (Chrome/Edge --app) so it behaves like a desktop app without Electron.
const { spawn, exec } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { startServer, probe } = require('./server.cjs')

const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const PREFERRED_PORT = Number(process.env.DP_PORT) || 5180
const PROFILE = path.join(ROOT, '.profile')
const NO_WINDOW = Boolean(process.env.DP_NO_WINDOW)
// 外部指定要打开的文件（任务中枢用它做“一键恢复现场”）
const OPEN_PATH = String(process.env.DP_OPEN || '').trim()

const BROWSERS = [
  path.join(process.env['PROGRAMFILES'] || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['PROGRAMFILES'] || 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
]

function withOpen(url) {
  return OPEN_PATH ? `${url}?open=${encodeURIComponent(OPEN_PATH)}` : url
}

function openWindow(url) {
  if (NO_WINDOW) return
  url = withOpen(url)
  const browser = BROWSERS.find((p) => p && fs.existsSync(p))
  if (!browser) {
    console.log('没找到 Chrome / Edge，用默认浏览器打开')
    exec(`start "" "${url}"`)
    return
  }
  const child = spawn(
    browser,
    [
      `--app=${url}`,
      '--window-size=1440,900',
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
    ],
    { detached: true, stdio: 'ignore' },
  )
  child.unref()
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('没找到 dist/index.html，先运行：npm install && npm run build')
    process.exit(1)
  }

  if (await probe(PREFERRED_PORT)) {
    console.log(`已经在运行：http://127.0.0.1:${PREFERRED_PORT}/`)
    openWindow(`http://127.0.0.1:${PREFERRED_PORT}/`)
    return
  }

  let handle
  try {
    handle = await startServer(DIST, { port: PREFERRED_PORT, dataDir: path.join(ROOT, 'notes') })
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      // 端口被别的程序占了，换一个还能用，但 localStorage 会按新端口分开。
      handle = await startServer(DIST, { port: 0, dataDir: path.join(ROOT, 'notes') })
      console.log(`端口 ${PREFERRED_PORT} 被占用，改用 ${handle.port}（笔记/设置会另存一份）`)
    } else {
      throw err
    }
  }

  console.log(`Dual PDF 本地服务：${handle.url}`)
  console.log('关闭这个窗口或按 Ctrl+C 即停止。')
  openWindow(handle.url)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
