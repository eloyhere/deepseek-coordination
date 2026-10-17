/**
 * deepseek-coordination — Host half (Cordis plugin running in the Node process)
 *
 * Keeps the liveness and echo routes the settings page uses to prove the host
 * half is actually up. The UI itself is drawn entirely by the client half with
 * React, so no static assets are served from here.
 *
 * Contract notes:
 *  - Hard dependencies go in `inject`; apply() runs only once they are ready.
 *  - Everything registered through ctx is disposed on unload — the route
 *    disposer is returned from ctx.effect().
 *  - The route prefix is absolute with no trailing slash; kind 'prefix' matches
 *    every sub-path beneath it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

export const name = 'deepseek-coordination'

export const inject = ['webServer']

/** Route prefix owned by this plugin. Mirrors src/client/index.ts. */
const ROUTE_PREFIX = '/deepseek-coordination'

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

export function apply(ctx: Context): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end()
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://x').pathname

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
