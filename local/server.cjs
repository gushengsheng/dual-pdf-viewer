// Zero-dependency static server for the built app (dist/).
// pdf.js needs a real http origin (ES modules, worker, CMaps), so the local
// build serves its own files instead of using file://.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

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

function startServer(root, { port = 0, host = '127.0.0.1' } = {}) {
  const rootDir = path.resolve(root)

  const server = http.createServer((req, res) => {
    if (req.url === '/__health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end('{"app":"dual-pdf"}')
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
