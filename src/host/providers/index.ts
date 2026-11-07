/** API-address optimization plugin, independently loadable from AMP coordination. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { ProviderOptimizationRegistry, createOptimizedFetch, type Fetch } from './registry.js'
import { registerTccxyOptimization, TCCXY_API_BASE } from './tccxy.js'
export { ProviderOptimizationRegistry, createOptimizedFetch, registerTccxyOptimization }
export { isOpenAIModel } from './tccxy.js'
export const name = 'provider-context-compat'
export const inject = ['webServer']

export function patchBody(url: string, method: string, text: string, upstream = TCCXY_API_BASE): string | undefined {
  const registry = new ProviderOptimizationRegistry()
  registerTccxyOptimization(registry, upstream)
  const route = registry.resolve(url, method)
  if (route === undefined) return undefined
  let body: unknown
  try { body = JSON.parse(text) as unknown } catch { return undefined }
  const next = registry.transform(route, body)
  return next === undefined ? undefined : JSON.stringify(next)
}

export function createCompatibleFetch(original: Fetch, upstream = TCCXY_API_BASE, patched: () => void = () => {}): Fetch {
  const registry = new ProviderOptimizationRegistry()
  registerTccxyOptimization(registry, upstream)
  return createOptimizedFetch(original, registry, patched)
}

export function apply(ctx: Context): void {
  const registry = new ProviderOptimizationRegistry()
  registerTccxyOptimization(registry)
  ctx.effect(() => {
    const original = globalThis.fetch
    const wrapped = createOptimizedFetch(original, registry)
    globalThis.fetch = wrapped
    return () => { if (globalThis.fetch === wrapped) globalThis.fetch = original }
  })
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/provider-context-compat/status',
    handler: (request, response) => {
      const registrations = registry.snapshot()
      response.writeHead(request.method === 'GET' ? 200 : 405, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify(request.method === 'GET' ? { patched: registrations.reduce((sum, entry) => sum + entry.patched, 0), registrations } : { error: 'GET only' }))
    },
  }))
}
