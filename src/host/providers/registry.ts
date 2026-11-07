/** Address-scoped request policies; unregistered providers pass through unchanged. */
export type RequestBody = Record<string, unknown>
export interface ProviderOptimization {
  readonly id: string
  readonly apiBase: string
  readonly endpoints: readonly string[]
  readonly optimize: (body: RequestBody, route: { readonly endpoint: string }) => RequestBody | undefined
}
interface Registration extends ProviderOptimization { matched: number; patched: number }
export interface ProviderRoute { readonly registration: Registration; readonly endpoint: string }
export type Fetch = typeof globalThis.fetch

function canonicalBase(value: string): string {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError('API base must be an HTTP(S) URL without credentials, query or fragment')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

export class ProviderOptimizationRegistry {
  private readonly entries = new Map<string, Registration>()

  register(policy: ProviderOptimization): () => void {
    const base = canonicalBase(policy.apiBase)
    if (!policy.id || typeof policy.optimize !== 'function' || policy.endpoints.length === 0 || policy.endpoints.some(path => !/^[a-z][a-z0-9/-]*$/i.test(path) || path.includes('..'))) {
      throw new TypeError('A policy needs an id, relative endpoints and an optimizer')
    }
    if (this.entries.has(base) || [...this.entries.values()].some(entry => entry.id === policy.id)) throw new Error('Provider policy id and API base must be unique')
    const registration: Registration = { ...policy, apiBase: base, endpoints: [...new Set(policy.endpoints)], matched: 0, patched: 0 }
    this.entries.set(base, registration)
    return () => { if (this.entries.get(base) === registration) this.entries.delete(base) }
  }

  resolve(url: string, method: string): ProviderRoute | undefined {
    if (method.toUpperCase() !== 'POST') return undefined
    const target = new URL(url)
    if (target.username || target.password) return undefined
    for (const registration of [...this.entries.values()].sort((a, b) => b.apiBase.length - a.apiBase.length)) {
      const endpoint = registration.endpoints.find(path => `${target.origin}${target.pathname}` === `${registration.apiBase}/${path}`)
      if (endpoint !== undefined) return { registration, endpoint }
    }
    return undefined
  }

  transform(route: ProviderRoute, body: unknown): RequestBody | undefined {
    route.registration.matched += 1
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
    const next = route.registration.optimize(body as RequestBody, { endpoint: route.endpoint })
    if (next !== undefined) route.registration.patched += 1
    return next
  }

  snapshot(): ReadonlyArray<{ id: string; apiBase: string; endpoints: readonly string[]; matched: number; patched: number }> {
    return [...this.entries.values()].map(({ optimize: _optimize, ...entry }) => ({ ...entry, endpoints: [...entry.endpoints] }))
  }
}

export function createOptimizedFetch(original: Fetch, registry: ProviderOptimizationRegistry, onPatched: () => void = () => {}): Fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const route = registry.resolve(url, method)
    if (route === undefined) return original(input, init)
    const request = new Request(input, init)
    // Encoded/non-JSON bodies must retain their original representation.
    if (request.headers.has('content-encoding')) return original(input, init)
    const mediaType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    if (mediaType && mediaType !== 'application/json' && !mediaType.endsWith('+json') && mediaType !== 'text/plain') return original(input, init)
    let body: unknown
    try { body = JSON.parse(await request.clone().text()) as unknown } catch { return original(input, init) }
    const next = registry.transform(route, body)
    if (next === undefined) return original(input, init)
    const headers = new Headers(request.headers)
    headers.delete('content-length')
    onPatched()
    return original(new Request(request, { headers, body: JSON.stringify(next) }))
  }
}
