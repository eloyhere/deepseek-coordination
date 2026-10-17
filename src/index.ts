/**
 * deepseek-coordination — Host half (Cordis plugin running in the Node process)
 *
 * Two responsibilities:
 *  - serve the Angular Elements bundle that the client half mounts, so the
 *    browser half never needs a second plugin row or a global script tag;
 *  - keep the liveness/echo routes used by the settings page to prove the host
 *    half is actually up.
 *
 * Contract notes:
 *  - Hard dependencies go in `inject`; apply() runs only once they are ready.
 *  - Everything registered through ctx is disposed on unload — the route
 *    disposer is returned from ctx.effect().
 *  - The route prefix is absolute with no trailing slash; kind 'prefix' matches
 *    every sub-path beneath it.
 */
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

export const name = 'deepseek-coordination'

export const inject = ['webServer']

/** Route prefix owned by this plugin. Mirrors src/client/index.ts. */
const ROUTE_PREFIX = '/deepseek-coordination'

/** Where the static assets land, relative to this module (bundled into lib/index.mjs). */
const STATIC_DIR = new URL('./static/', import.meta.url)

/** Content types for the few file kinds tsdown/Angular emit here. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

/** Unified JSON response envelope: { ok: true, value } | { ok: false, error }. */
function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** Read a POST JSON body, with a size cap that guards against oversized payloads. */
const BODY_CAP_BYTES = 1 << 20

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const part = chunk as Buffer
    total += part.length
    if (total > BODY_CAP_BYTES) {
      req.destroy()
      return null
    }
    chunks.push(part)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Serve one file from the Angular build directory.
 *
 * The request path is reduced to a basename chain and resolved inside the build
 * directory, so `..` cannot escape it; unknown files answer 404 with the JSON
 * envelope rather than a stack trace.
 */
async function serveElement(pathname: string, res: ServerResponse): Promise<void> {
  const relative = pathname.slice(`${ROUTE_PREFIX}/static/`.length)
  if (relative === '' || relative.includes('..') || relative.includes('\\')) {
    json(res, { ok: false, error: 'not found' }, 404)
    return
  }
  const extension = relative.slice(relative.lastIndexOf('.'))
  try {
    const body = await readFile(new URL(relative, STATIC_DIR))
    res.writeHead(200, { 'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    json(res, { ok: false, error: `not found: ${relative}` }, 404)
  }
}

export function apply(ctx: Context): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const pathname = new URL(req.url ?? '/', 'http://x').pathname

        // Static bundle: the browser fetches it as a module, so it must not be POST-only.
        if (req.method === 'GET' && pathname.startsWith(`${ROUTE_PREFIX}/static/`)) {
          await serveElement(pathname, res)
          return
        }

        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end()
          return
        }

        if (pathname === `${ROUTE_PREFIX}/ping`) {
          json(res, { ok: true, value: { plugin: name, pong: true } })
          return
        }

        if (pathname === `${ROUTE_PREFIX}/echo`) {
          json(res, { ok: true, value: await readJsonBody(req) })
          return
        }

        res.writeHead(404)
        res.end()
      },
    })
    return () => { dispose() }
  }, `${name}: ${ROUTE_PREFIX} routes`)
}
