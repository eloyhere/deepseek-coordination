/**
 * Proxy adapter audit.
 *
 * The adapter exists because the harness freezes a request before any adapter
 * sees it: the only way to change what reaches the provider is to rebuild the
 * request *outside* the frozen object. These tests pin exactly that contract —
 * forwarding swaps the route, never mutates the input, and refuses to loop.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProxyAdapter } from '../src/host/proxy-adapter.js'
import type { LlmRuntimeLike, ProxyRoute } from '../src/host/proxy-adapter.js'

interface Forwarded {
  provider?: unknown
  messages?: unknown
  extra?: unknown
}

/** A runtime double that records every forwarded request. */
function fakeLlm(): { llm: LlmRuntimeLike; sent: Forwarded[] } {
  const sent: Forwarded[] = []
  const llm: LlmRuntimeLike = {
    stream: (options: unknown) => {
      sent.push(options as Forwarded)
      return 'stream-handle'
    },
    resolveModelInfo: async (provider: string, model: string) => ({
      provider,
      id: model,
      name: `${provider}/${model}`,
      context: { contextWindow: 128_000 },
    }),
    listModels: async (provider: string) => [{ provider, id: `${provider}-model` }],
  }
  return { llm, sent }
}

/** A request shaped like the frozen one the agent loop builds. */
function frozenRequest(overrides: Record<string, unknown> = {}): Readonly<Record<string, unknown>> {
  const messages = Object.freeze([
    Object.freeze({ role: 'user', content: 'hello' }),
    Object.freeze({ role: 'assistant', content: 'hi' }),
  ])
  return Object.freeze({
    provider: 'coordination-proxy',
    model: 'deepseek-flash',
    messages,
    temperature: 0.3,
    ...overrides,
  })
}

function adapterWith(route: ProxyRoute | undefined, overrides: Record<string, unknown> = {}) {
  const { llm, sent } = fakeLlm()
  const adapter = createProxyAdapter({
    provider: 'coordination-proxy',
    routeOf: () => route,
    llm,
    ...overrides,
  })
  return { adapter, sent, llm }
}

test('forwards a frozen request through the upstream route without mutating it', () => {
  const { adapter, sent } = adapterWith({ provider: 'deepseek-account', model: 'deepseek-flash' })
  const request = frozenRequest()

  const handle = adapter.stream(request)

  assert.equal(handle, 'stream-handle')
  assert.equal(sent.length, 1)
  const forwarded = sent[0]
  assert.equal(forwarded.provider, 'deepseek-account', 'the route is swapped')
  assert.equal(forwarded.model, 'deepseek-flash', 'the model is preserved')
  assert.equal(forwarded.temperature, 0.3, 'every other field is carried over')
  assert.deepEqual(forwarded.messages, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ])
  // The forwarding object must be writable and distinct from the frozen input:
  // that is the whole point of cloning at the adapter boundary.
  assert.notEqual(forwarded, request)
  assert.equal(Object.isFrozen(forwarded), false)
  assert.equal(request.provider, 'coordination-proxy', 'the frozen input is untouched')
})

test('a decorate hook can rebuild the messages before forwarding', () => {
  const { adapter, sent } = adapterWith(
    { provider: 'deepseek-account' },
    {
      decorate: (request: Readonly<Record<string, unknown>>) => ({
        ...request,
        messages: [{ role: 'user', content: 'normalised' }],
      }),
    },
  )

  adapter.stream(frozenRequest())

  assert.deepEqual(sent[0].messages, [{ role: 'user', content: 'normalised' }])
  assert.equal(sent[0].provider, 'deepseek-account')
})

test('refuses to forward the proxy route to itself', () => {
  const { adapter, sent } = adapterWith({ provider: 'coordination-proxy' })

  assert.throws(() => adapter.stream(frozenRequest()), /to itself/)
  assert.equal(sent.length, 0, 'nothing is forwarded on a loop')
})

test('throws when no upstream route is known yet', () => {
  const { adapter, sent } = adapterWith(undefined)
  assert.throws(() => adapter.stream(frozenRequest()), /no upstream route/)
  assert.equal(sent.length, 0)
})

test('throws when the request is not an object', () => {
  const { adapter } = adapterWith({ provider: 'deepseek-account' })
  assert.throws(() => adapter.stream(null), /not an object/)
})

test('prepareCall resolves the upstream metadata and forwards through it', async () => {
  const { adapter, sent } = adapterWith({ provider: 'deepseek-account' })

  const prepared = await adapter.prepareCall('coordination-proxy', 'deepseek-flash')

  // Identity must claim the registered route; the rest is upstream metadata.
  assert.deepEqual(prepared.model, {
    provider: 'coordination-proxy',
    id: 'deepseek-flash',
    name: 'deepseek-account/deepseek-flash',
    context: { contextWindow: 128_000 },
  })
  prepared.stream(frozenRequest())
  assert.equal(sent[0].provider, 'deepseek-account')
})

test('model metadata falls back to the proxy identity when the upstream cannot answer', async () => {
  const { llm } = fakeLlm()
  const failing: LlmRuntimeLike = {
    ...llm,
    resolveModelInfo: async () => {
      throw new Error('upstream catalog down')
    },
  }
  const adapter = createProxyAdapter({
    provider: 'coordination-proxy',
    routeOf: () => ({ provider: 'deepseek-account' }),
    llm: failing,
  })

  const info = await adapter.prepareCall('coordination-proxy', 'deepseek-flash').then((p) => p.model)
  assert.deepEqual(info, { provider: 'coordination-proxy', id: 'deepseek-flash', name: 'deepseek-flash' })
})

test('the catalog is the upstream catalog, never a phantom empty provider', async () => {
  const { adapter } = adapterWith({ provider: 'deepseek-account' })
  assert.deepEqual(await adapter.listModels('coordination-proxy'), [
    { provider: 'coordination-proxy', id: 'deepseek-account-model' },
  ])

  const failing = createProxyAdapter({
    provider: 'coordination-proxy',
    routeOf: () => ({ provider: 'deepseek-account' }),
    llm: {
      stream: () => 'x',
      listModels: async () => {
        throw new Error('down')
      },
    },
  })
  assert.deepEqual(await failing.listModels('coordination-proxy'), [])
})

test('the adapter advertises the route it is registered under', () => {
  const { adapter } = adapterWith({ provider: 'deepseek-account' })
  assert.deepEqual(adapter.providerInfo('coordination-proxy'), {
    id: 'coordination-proxy',
    name: 'Coordination Proxy',
  })
})

test('implements every hook the runtime calls, not just stream', () => {
  // `registerAdapter` calls providerInfo + providerRetryPolicy while validating
  // the route, and the token meter calls the image helpers per measurement. A
  // plain object missing them throws before a single model call happens.
  const { adapter } = adapterWith({ provider: 'deepseek-account' })
  const hooks = [
    'providerInfo',
    'providerRetryPolicy',
    'imageRequestPricing',
    'imageRequestTarget',
    'listModels',
    'resolveModel',
    'prepareCall',
    'stream',
  ] as const
  for (const name of hooks) {
    assert.equal(
      typeof (adapter as unknown as Record<string, unknown>)[name],
      'function',
      `${name} must be callable`,
    )
  }
  assert.equal(adapter.providerRetryPolicy('coordination-proxy'), undefined)
  assert.equal(adapter.imageRequestPricing('coordination-proxy', 'deepseek-flash'), undefined)
  assert.deepEqual(
    adapter.imageRequestTarget('coordination-proxy', 'deepseek-flash', { width: 10, height: 20, bytes: 30 }),
    { width: 10, height: 20, maxBytes: 30 },
  )
})
