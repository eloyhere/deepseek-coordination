/**
 * Proxy provider adapter — an off-label use of `ctx.llm.registerAdapter`.
 *
 * The harness freezes a request before it reaches any adapter
 * (`buildRequest()` deep-freezes the messages and `Object.freeze`s the request)
 * and the `llm/stream` waterfall's fallback closes over that frozen object, so
 * nothing after the freeze can edit a request in place. An adapter, however,
 * receives the frozen request as an *input* and decides what to hand the
 * provider — which makes this module the one supported place where the outgoing
 * content can still be rebuilt.
 *
 * ## Security model
 *
 * This adapter sits on the model path, so it can see every prompt and every
 * answer. The design therefore assumes the module itself is the risk and makes
 * it unable to become a leak channel:
 *
 *  1. **No credential access.** It never reads `ctx.credentials`, the account
 *     token, an API key, an `Authorization` header or the credentials file. It
 *     holds no transport: forwarding delegates back to `ctx.llm.stream`, so the
 *     real adapter still owns authentication, attribution and HTTP.
 *  2. **No egress.** The module contains no `fetch`, `http`, `https`, `net` or
 *     socket use. The only outbound act is an in-process call into the harness.
 *  3. **No content persistence.** Tracing is structural: an event carries a
 *     provider id, a model id, message/tool counts and a character total. No
 *     message text, tool payload or response text ever leaves the request.
 *  4. **Provider allowlist.** Forwarding is restricted to providers the host
 *     named explicitly; an unknown provider is refused rather than proxied, so
 *     traffic can never be redirected to an endpoint this plugin invented.
 *  5. **Fail closed, not fail leak.** Every refusal or failure raises a message
 *     that names the route only; it never quotes request content, and it never
 *     falls back to a silent second destination.
 *  6. **Opt-in and reversible.** The caller decides whether the route exists at
 *     all (`index.ts` gates it behind an explicit switch); disposing the
 *     registration restores the normal path.
 *
 * What this module deliberately does *not* do: it does not register a service
 * other plugins can drive, and it exposes no method that takes or returns
 * message content. Observability is counts and identities only.
 */

/** The slice of `ctx.llm` this adapter depends on. */
export interface LlmRuntimeLike {
  stream?: (options: unknown) => unknown
  resolveModelInfo?: (provider: string, model: string, signal?: AbortSignal) => Promise<unknown>
  listModels?: (provider: string) => Promise<readonly unknown[]>
}

/** One upstream route the adapter forwards to. */
export interface ProxyRoute {
  provider: string
  model?: string
}

/**
 * One structural trace line.
 *
 * Every field is an identity or a count. Adding a field that carries request
 * text would turn this adapter into the leak channel the security model above
 * forbids, so the shape stays deliberately narrow.
 */
export interface ProxyTraceEvent {
  readonly event: 'install' | 'route' | 'forward' | 'refuse' | 'model'
  readonly provider?: string
  readonly model?: string
  /** Cache brand the host's model identity classified onto. */
  readonly brand?: string
  /** Number of messages in the outgoing request. */
  readonly messages?: number
  /** Total characters across message contents — a size, never the text. */
  readonly chars?: number
  /** Number of tool definitions in the outgoing request. */
  readonly tools?: number
  /** Machine-readable refusal reason; never content. */
  readonly reason?: string
}

export interface ProxyAdapterOptions {
  /** Provider id this adapter is registered under (e.g. `coordination-proxy`). */
  readonly provider: string
  /** Resolve the real route to forward to. May change between calls. */
  readonly routeOf: () => ProxyRoute | undefined
  /** The live `ctx.llm` runtime used for forwarding and metadata delegation. */
  readonly llm: LlmRuntimeLike
  /** Providers this proxy may forward to. Empty or omitted refuses everything. */
  readonly allowProviders?: readonly string[]
  /**
   * Optional content rewrite applied to the cloned request.
   *
   * Receives the frozen request and returns the object to forward. The default
   * forwards the clone unchanged, which already proves the routing path.
   */
  readonly decorate?: (request: Readonly<Record<string, unknown>>) => Record<string, unknown>
  /** Structural trace sink. Never receives request or response content. */
  readonly trace?: (event: ProxyTraceEvent) => void
}

/** The adapter object `ctx.llm.registerAdapter` expects. */
export interface ProxyAdapter {
  providerInfo(provider: string): { id: string; name: string }
  /**
   * Retry policy owned by this route.
   *
   * The runtime calls this during registration; a plain object without it makes
   * `registerAdapter` throw. `undefined` means "use the harness default", which
   * is right for a route that performs no I/O of its own.
   */
  providerRetryPolicy(provider: string): undefined
  /** No request images are priced here; the real adapter still owns pricing. */
  imageRequestPricing(provider: string, model: string): undefined
  /** Preserve the normalized image target unchanged. */
  imageRequestTarget(
    provider: string,
    model: string,
    image: { width: number; height: number; bytes: number },
  ): { width: number; height: number; maxBytes: number }
  listModels(provider: string): Promise<readonly unknown[]>
  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<unknown>
  prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: unknown; stream: (options: unknown) => unknown }>
  /** Direct entry point, also used by tests. */
  stream(options: unknown): unknown
}

/**
 * Provider allowlist shared by the adapter and the routing listener.
 *
 * Only the deployment's own model routes may be proxied. Anything else (a
 * provider another plugin registered, a future third-party route) is left
 * exactly as the harness built it.
 */
export const PROXY_ALLOWED_PROVIDERS: readonly string[] = ['deepseek', 'deepseek-account', 'deepseek-official']

/** True when the proxy may intercept this provider route. */
export function isProxyProviderAllowed(provider: unknown, allow = PROXY_ALLOWED_PROVIDERS): boolean {
  return typeof provider === 'string' && allow.includes(provider)
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Structural shape of one request: counts only, never content. */
function summarise(request: UnknownRecord): Pick<ProxyTraceEvent, 'messages' | 'chars' | 'tools'> {
  const messages = Array.isArray(request.messages) ? request.messages : []
  let chars = 0
  for (const message of messages) {
    const content = asRecord(message)?.content
    if (typeof content === 'string') chars += content.length
    else if (Array.isArray(content)) {
      for (const block of content) {
        const record = asRecord(block)
        if (typeof record?.text === 'string') chars += record.text.length
      }
    }
  }
  const tools = Array.isArray(request.tools) ? request.tools.length : undefined
  return { messages: messages.length, chars, ...(tools === undefined ? {} : { tools }) }
}

/** Build the adapter. Registration and disposal belong to the caller. */
export function createProxyAdapter(options: ProxyAdapterOptions): ProxyAdapter {
  const { provider: proxyProvider, llm } = options
  const allow = options.allowProviders ?? PROXY_ALLOWED_PROVIDERS

  /** The real route, or `undefined` before the first request names one. */
  const upstream = (): ProxyRoute | undefined => {
    const route = options.routeOf()
    if (route === undefined) return undefined
    const provider = asString(route.provider).trim()
    if (provider.length === 0) return undefined
    const model = asString(route.model).trim()
    return { provider, ...(model.length === 0 ? {} : { model }) }
  }

  const stream = (request: unknown): unknown => {
    const frozen = asRecord(request)
    if (frozen === undefined) {
      options.trace?.({ event: 'refuse', provider: proxyProvider, reason: 'request-not-an-object' })
      throw new Error('coordination proxy: the request is not an object')
    }
    const route = upstream()
    if (route === undefined) {
      options.trace?.({ event: 'refuse', provider: proxyProvider, reason: 'no-upstream-route' })
      throw new Error('coordination proxy: no upstream route recorded yet')
    }
    if (route.provider === proxyProvider) {
      options.trace?.({ event: 'refuse', provider: proxyProvider, reason: 'self-forward' })
      throw new Error(`coordination proxy: refusing to forward "${proxyProvider}" to itself`)
    }
    if (!isProxyProviderAllowed(route.provider, allow)) {
      options.trace?.({ event: 'refuse', provider: route.provider, reason: 'provider-not-allowlisted' })
      throw new Error(`coordination proxy: provider "${route.provider}" is not on the allowlist`)
    }
    const forwarding = llm.stream
    if (typeof forwarding !== 'function') {
      options.trace?.({ event: 'refuse', provider: route.provider, reason: 'stream-unavailable' })
      throw new Error('coordination proxy: ctx.llm.stream is unavailable')
    }
    // The frozen request is only read: spreading it produces the writable clone
    // the real adapter will see.
    const rewritten = options.decorate === undefined
      ? { ...frozen }
      : options.decorate(frozen)
    const outgoing: UnknownRecord = { ...rewritten, provider: route.provider }
    options.trace?.({
      event: 'forward',
      provider: route.provider,
      ...(typeof outgoing.model === 'string' ? { model: outgoing.model } : {}),
      ...summarise(outgoing),
    })
    return forwarding.call(llm, outgoing)
  }

  return {
    providerInfo: (provider: string) => ({ id: provider, name: 'Coordination Proxy' }),

    // The harness calls these three during registration and token measurement.
    // Omitting them from a plain object (rather than a base-class instance)
    // makes `registerAdapter` throw "providerRetryPolicy is not a function".
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (
      _provider: string,
      _model: string,
      image: { width: number; height: number; bytes: number },
    ) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),

    async listModels(provider: string): Promise<readonly unknown[]> {
      const route = upstream()
      if (route === undefined || typeof llm.listModels !== 'function') return []
      try {
        const models = await llm.listModels(route.provider)
        // The catalog belongs to the registered route: every entry must claim
        // the proxy provider, or callers reject it as foreign metadata.
        return Array.isArray(models)
          ? models.map((entry) => {
              const record = asRecord(entry)
              return record === undefined ? entry : { ...record, provider }
            })
          : []
      } catch {
        // An upstream catalog failure must not turn into a phantom empty
        // provider; the Models page simply shows nothing for this route.
        return []
      }
    },

    async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<unknown> {
      const route = upstream()
      if (route !== undefined && typeof llm.resolveModelInfo === 'function') {
        try {
          const info = asRecord(await llm.resolveModelInfo(route.provider, model, signal))
          if (info !== undefined) {
            // Identity must match the registered route; only the metadata is the
            // upstream provider's. `normalizeModelInfo` rejects anything else.
            return {
              ...info,
              provider,
              id: model,
              name: asString(info.name) || model,
            }
          }
        } catch {
          // Fall through to the minimal identity below.
        }
      }
      return { provider, id: model, name: model }
    },

    async prepareCall(provider: string, model: string, signal?: AbortSignal) {
      const info = await this.resolveModel(provider, model, signal)
      return { model: info, stream: (request: unknown) => stream(request) }
    },

    stream,
  }
}
