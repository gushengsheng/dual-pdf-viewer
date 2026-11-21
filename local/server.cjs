// Zero-dependency static server for the built app (dist/).
// pdf.js needs a real http origin (ES modules, worker, CMaps), so the local
// build serves its own files instead of using file://.
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const OPENABLE = /\.(pdf|md|markdown|txt)$/i
const MAX_FILE = 200 * 1024 * 1024
const MAX_SAVE_BYTES = 8 * 1024 * 1024

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
}

function startServer(root, { port = 0, host = '127.0.0.1', dataDir = '', configPath = '' } = {}) {
  return startServerInner(path.resolve(root), { port, host, dataDir, configPath })
}

async function startServerInner(rootDir, { port, host, dataDir, configPath }) {
  // Only this page can read the token (same-origin), and /__open refuses
  // anything that is not an absolute-ish existing file with a known extension.
  const token = crypto.randomBytes(16).toString('hex')
  const notesDir = dataDir ? path.resolve(dataDir) : path.join(rootDir, '..', 'notes')
  // english.config.json lives next to the project, not inside dist/, so a
  // rebuild never touches the key and the static handler can never serve it.
  const englishConfig = configPath
    ? path.resolve(configPath)
    : path.join(rootDir, '..', 'english.config.json')
  const noteFile = (key) =>
    path.join(notesDir, `${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}.json`)

  // Every path the page opened through /__open. /__save only writes back to one
  // of these, so a stray or malicious request cannot touch anything else.
  const writable = new Set()

  const { createEnglish } = await import('./english/routes.mjs')
  const english = createEnglish({ configPath: englishConfig, token })

  const server = http.createServer((req, res) => {
    if (req.url === '/__health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end('{"app":"dual-pdf"}')
      return
    }

    if (req.url === '/__token') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify({ token }))
      return
    }

    if (english.owns(req.url)) {
      english.handle(req, res)
      return
    }

    if (req.url.startsWith('/__open')) {
      const q = new URL(req.url, 'http://local').searchParams
      if (q.get('token') !== token) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('bad token')
        return
      }
      const raw = String(q.get('path') || '').trim().replace(/^"(.*)"$/, '$1')
      if (!raw) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('缺少路径')
        return
      }
      const expanded = raw.startsWith('~')
        ? path.join(os.homedir(), raw.slice(1).replace(/^[\\/]+/, ''))
        : raw
      const filePath = path.resolve(expanded)
      if (!OPENABLE.test(filePath)) {
        res
          .writeHead(415, { 'content-type': 'text/plain; charset=utf-8' })
          .end('只支持 .pdf / .md / .markdown / .txt')
        return
      }
      fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('找不到文件')
          return
        }
        if (stat.size > MAX_FILE) {
          res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' }).end('文件太大')
          return
        }
        writable.add(filePath)
        res.writeHead(200, {
          'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
          'content-length': stat.size,
          'cache-control': 'no-store',
          'x-file-name': encodeURIComponent(path.basename(filePath)),
        })
        fs.createReadStream(filePath).pipe(res)
      })
      return
    }

    if (req.url.startsWith('/__save')) {
      const q = new URL(req.url, 'http://local').searchParams
      if (q.get('token') !== token) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('bad token')
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' }).end('method not allowed')
        return
      }
      let body = ''
      let tooBig = false
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > MAX_SAVE_BYTES) {
          tooBig = true
          req.destroy()
        }
      })
      req.on('end', () => {
        if (tooBig) return
        let payload = null
        try {
          payload = JSON.parse(body)
        } catch {
          /* handled below */
        }
        const raw = String(payload?.path || '').trim()
        const text = typeof payload?.text === 'string' ? payload.text : null
        if (!raw || text === null) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('参数不全')
          return
        }
        const expanded = raw.startsWith('~')
          ? path.join(os.homedir(), raw.slice(1).replace(/^[\\/]+/, ''))
          : raw
        const filePath = path.resolve(expanded)
        if (!writable.has(filePath)) {
          res
            .writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
            .end('只能写回本次打开过的文本文件')
          return
        }
        if (!OPENABLE.test(filePath)) {
          res.writeHead(415, { 'content-type': 'text/plain; charset=utf-8' }).end('只能写回 .md / .txt')
          return
        }
        // Write beside the target, then rename: a crash mid-write can never leave
        // a half-written file where the reader expects the original.
        const temp = `${filePath}.dpv-save-${process.pid}`
        fs.writeFile(temp, text, 'utf8', (writeErr) => {
          if (writeErr) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('写临时文件失败')
            return
          }
          fs.rename(temp, filePath, (renameErr) => {
            if (renameErr) {
              fs.unlink(temp, () => {})
              res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('替换原文件失败')
              return
            }
            const out = JSON.stringify({ ok: true, bytes: Buffer.byteLength(text, 'utf8') })
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(out)
          })
        })
      })
      return
    }

    if (req.url.startsWith('/__notes')) {
      const q = new URL(req.url, 'http://local').searchParams
      if (q.get('token') !== token) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('bad token')
        return
      }
      if (req.method === 'GET') {
        const key = q.get('key') || ''
        if (!key) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('缺少 key')
          return
        }
        fs.readFile(noteFile(key), 'utf8', (err, data) => {
          if (err) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('no notes')
            return
          }
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(data)
        })
        return
      }
      if (req.method === 'DELETE') {
        const key = q.get('key') || ''
        if (!key) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('缺少 key')
          return
        }
        fs.unlink(noteFile(key), () => {
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
        })
        return
      }
      if (req.method === 'POST') {
        let body = ''
        req.on('data', (chunk) => {
          body += chunk
          if (body.length > 4 * 1024 * 1024) req.destroy()
        })
        req.on('end', () => {
          let payload = null
          try {
            payload = JSON.parse(body)
          } catch {
            /* handled below */
          }
          const key = String(payload?.key || '')
          const items = payload?.items
          if (!key || !Array.isArray(items)) {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad payload')
            return
          }
          fs.mkdir(notesDir, { recursive: true }, () => {
            const out = JSON.stringify(
              { key, items, savedAt: new Date().toISOString() },
              null,
              2,
            )
            fs.writeFile(noteFile(key), out, (err) => {
              if (err) {
                res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('write failed')
                return
              }
              res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
            })
          })
        })
        return
      }
      res.writeHead(405).end('method not allowed')
      return
    }

    let pathname
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname)
    } catch {
      res.writeHead(400).end('bad request')
      return
    }
    if (pathname.endsWith('/')) pathname += 'index.html'

    const filePath = path.resolve(rootDir, `.${pathname}`)
    if (filePath !== rootDir && !filePath.startsWith(rootDir + path.sep)) {
      res.writeHead(403).end('forbidden')
      return
    }

    if (pathname.endsWith('/index.html')) {
      // Inject a flag so the page knows it runs under the local server: the
      // path input needs the loopback file API, a plain dev server has none.
      fs.readFile(filePath, 'utf8', (err, html) => {
        if (err) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('read error')
          return
        }
        const out = html.includes('</head>')
          ? html.replace('</head>', '<script>window.__DUAL_PDF_LOCAL__=true</script></head>')
          : html
        const buf = Buffer.from(out, 'utf8')
        res.writeHead(200, {
          'content-type': MIME['.html'],
          'content-length': buf.length,
          'cache-control': 'no-store',
        })
        res.end(buf)
      })
      return
    }

    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
        return
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'content-length': stat.size,
        'cache-control': 'no-store',
      })
      fs.createReadStream(filePath).pipe(res)
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      resolve({ server, port: server.address().port, url: `http://${host}:${server.address().port}/` })
    })
  })
}

/** Is something already serving this app on the given port? */
function probe(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/__health', timeout: 800 }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve(res.statusCode === 200 && body.includes('dual-pdf')))
    })
    req.on('timeout', () => req.destroy(() => resolve(false)))
    req.on('error', () => resolve(false))
  })
}

module.exports = { startServer, probe }
