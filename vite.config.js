import { fileURLToPath } from 'node:url'
import path from 'node:path'
import crypto from 'node:crypto'

import { defineConfig } from 'vite'

const ROOT = path.dirname(fileURLToPath(import.meta.url))

/**
 * The dev and preview servers get the same /__llm routes the built app has, so
 * the English features can be developed without rebuilding. Vite serves the
 * project root by default — english.config.json holds the API key, so it is
 * refused here before any file handler can see it.
 */
function englishRoutes() {
  const attach = async (server) => {
    const { createEnglish } = await import('./local/english/routes.mjs')
    const token = crypto.randomBytes(16).toString('hex')
    const english = createEnglish({ configPath: path.join(ROOT, 'english.config.json'), token })
    server.middlewares.use((req, res, next) => {
      const pathname = (req.url || '').split('?')[0]
      if (pathname === '/__token') {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({ token }))
        return
      }
      if (english.owns(req.url)) {
        english.handle(req, res)
        return
      }
      // Vite serves anything under the project root: refuse the settings file
      // and any backup copy of it (english.config.json.bak, .old, …).
      if (/^\/english\.config\.json/i.test(pathname)) {
        res.statusCode = 403
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end('forbidden')
        return
      }
      next()
    })
  }
  return {
    name: 'dual-pdf-english',
    configureServer: attach,
    configurePreviewServer: attach,
  }
}

export default defineConfig({
  plugins: [englishRoutes()],
  server: {
    host: '127.0.0.1',
    port: 5178,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 5179,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
})
