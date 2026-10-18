/**
 * Cache proxy service audit.
 *
 * The service is the one place the proxy installs itself: routing listener,
 * adapter registration, status snapshot and trace file. These tests pin that
 * contract, plus the measurement baseline that must exist before anyone turns
 * rewriting on:
 *
 *  - install/dispose idempotence and the attach switch;
 *  - the provider allowlist (a foreign route is never intercepted);
 *  - the body-free status shape, including upstream identity and metrics;
 *  - usage sampling over the sliding window (missing usage never breaks a call);
 *  - prefix fingerprint stability and drift;
 *  - `measure` forwarding unchanged bytes, `normalize` calling the decorator;
 *  - the static compatibility list and the one-time `compat` trace line.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { PROXY_METRIC_WINDOW, createProxyService } from '../src/host/proxy-service.js'
import type { ProxyService, ProxyServiceOptions } from '../src/host/proxy-service.js'

// These tests must see the built-in defaults, not an operator's shell.
delete process.env.DSH_COORDINATION_PROXY_MODE
delete process.env.DSH_COORDINATION_PROXY_REWRITE

interface AdapterLike {
  stream(request: unknown): unknown
}

interface Registration {
  providers: readonly string[]
  adapter: AdapterLike
}

interface ListenerEntry {
  event: string
  listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
  options?: unknown
}

interface FakeRuntime {
  context: Context
  forwarded: unknown[]
  registrations: Registration[]
  listeners: ListenerEntry[]
  detachCalls: number
  unregisterCalls: number
  adapter(): AdapterLike
  fire(seed: Record<string, unknown>): Promise<Record<string, unknown>>
}

/**
 * A minimal Cordis context: only `get` for the services the proxy reads and
 * `on` for the `agent/request` waterfall. `registerAdapter` returns a disposer,
 * just like the host's registration handle.
 */
function fakeContext(settings: {
  defaultRoute?: { provider: string; model: string }
  chunks?: (index: number) => unknown[]
  modelInfo?: (provider: string, model: string) => Record<string, unknown>
} = {}): FakeRuntime {
  const forwarded: unknown[] = []
  const registrations: Registration[] = []
  const listeners: ListenerEntry[] = []
  const runtime = {
    detachCalls: 0,
    unregisterCalls: 0,
  }

  const llm: Record<string, unknown> = {
    stream: (request: unknown) => {
      forwarded.push(request)
      const chunks = settings.chunks?.(forwarded.length - 1) ?? []
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
          for (const chunk of chunks) yield chunk
        },
      }
    },
    // A synchronous answer keeps `describeModel` deterministic in tests.
    resolveModelInfo: (provider: string, model: string) =>
      settings.modelInfo?.(provider, model) ?? { provider, id: model, name: `${provider}/${model}` },
    listModels: async () => [],
    registerAdapter: (providers: readonly string[], adapter: AdapterLike) => {
      registrations.push({ providers, adapter })
      return () => { runtime.unregisterCalls += 1 }
    },
  }
  const services: Record<string, Record<string, unknown>> = { llm }
  if (settings.defaultRoute !== undefined) {
    services.agentDefaultModel = { currentSelection: () => settings.defaultRoute }
  }
  const context = {
    get: (name: string) => services[name],
    on: (event: string, listener: ListenerEntry['listener'], options?: unknown) => {
      listeners.push({ event, listener, options })
      return () => { runtime.detachCalls += 1 }
    },
  } as unknown as Context

  return {
    context,
    forwarded,
    registrations,
    listeners,
    get detachCalls() { return runtime.detachCalls },
    get unregisterCalls() { return runtime.unregisterCalls },
    adapter() {
      assert.equal(registrations.length, 1, 'exactly one adapter registration')
      return registrations[0].adapter
    },
    async fire(seed: Record<string, unknown>) {
      const entry = listeners.find((candidate) => candidate.event === 'agent/request')
      assert.ok(entry, 'the agent/request listener is installed')
      return await entry.listener(seed, async () => seed) as Record<string, unknown>
    },
  }
}

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-proxy-service-'))
}

function enableProxy(dir: string): void {
  writeFileSync(join(dir, 'proxy.enable'), '', 'utf8')
}

function traceLines(dir: string): Array<Record<string, unknown>> {
  const path = join(dir, 'proxy.log')
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function frozenRequest(overrides: Record<string, unknown> = {}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    provider: 'coordination-proxy',
    model: 'deepseek-flash',
    system: 'stable system prompt',
    messages: Object.freeze([
      Object.freeze({ role: 'user', content: 'hello' }),
      Object.freeze({ role: 'assistant', content: 'hi' }),
    ]),
    tools: Object.freeze([
      Object.freeze({ name: 'read', description: 'read a file', parameters: { type: 'object' } }),
    ]),
    temperature: 0.3,
    ...overrides,
  })
}

async function consume(stream: unknown): Promise<unknown[]> {
  const chunks: unknown[] = []
  if (
    typeof stream === 'object' && stream !== null &&
    typeof (stream as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  ) {
    for await (const chunk of stream as AsyncIterable<unknown>) chunks.push(chunk)
  }
  return chunks
}

/** Install the proxy, then let one real request name the upstream route. */
async function installRoutedService(
  dir: string,
  fake: FakeRuntime,
  extra: Partial<ProxyServiceOptions> = {},
): Promise<{ service: ProxyService; dispose: () => void; adapter: AdapterLike }> {
  enableProxy(dir)
  const service = createProxyService({ context: fake.context, stateDir: dir, ...extra })
  const dispose = service.install()
  const routed = await fake.fire({ provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(routed.provider, 'coordination-proxy')
  return { service, dispose, adapter: fake.adapter() }
}

test('install and dispose are idempotent, and a disposed service can be re-installed', (t) => {
  const dir = stateDir()
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  enableProxy(dir)
  const fake = fakeContext({ defaultRoute: { provider: 'deepseek-account', model: 'deepseek-flash' } })
  const service = createProxyService({ context: fake.context, stateDir: dir, decorate: (request) => request })

  const first = service.install()
  const second = service.install()

  assert.equal(second, first, 'a second install returns the active disposer')
  assert.equal(fake.registrations.length, 1, 'one adapter registration')
  assert.equal(fake.listeners.length, 1, 'one agent/request listener')
  assert.equal(service.status().enabled, true)
  assert.equal(service.status().decorate, true)

  first()
  first()
  assert.equal(fake.unregisterCalls, 1, 'dispose unregisters once')
  assert.equal(fake.detachCalls, 1, 'dispose detaches once')
  assert.equal(service.status().enabled, false)
  assert.equal(service.status().decorate, false)

  const third = service.install()
  assert.notEqual(third, first, 're-install creates a fresh installation')
  assert.equal(fake.registrations.length, 2)
  third()
  assert.equal(fake.unregisterCalls, 2)
})

test('install is a no-op until the attach switch is present', (t) => {
  const dir = stateDir()
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  const previous = process.env.DSH_COORDINATION_PROXY
  delete process.env.DSH_COORDINATION_PROXY
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_COORDINATION_PROXY
    else process.env.DSH_COORDINATION_PROXY = previous
  })

  const fake = fakeContext()
  const service = createProxyService({ context: fake.context, stateDir: dir })
  const dispose = service.install()

  assert.equal(fake.registrations.length, 0, 'nothing is registered')
  assert.equal(fake.listeners.length, 0, 'nothing listens')
  assert.equal(service.status().available, false)
  assert.equal(service.status().enabled, false)
  assert.equal(service.status().cacheStrategy.id, 'unknown/conservative',
    'status always names a strategy row, even before a route is known')
  assert.deepEqual(traceLines(dir), [], 'an inert service writes no trace')
  dispose()
})

test('an allowlisted route is rewritten while a foreign route is refused', async (t) => {
  const dir = stateDir()
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  enableProxy(dir)
  const fake = fakeContext()
  const service = createProxyService({ context: fake.context, stateDir: dir, decorate: (request) => request })
  const dispose = service.install()
  t.after(() => { dispose() })

  const foreign = { provider: 'someone-elses-provider', model: 'mystery' }
  const untouched = await fake.fire(foreign)
  assert.equal(untouched, foreign, 'the foreign seed object is returned untouched')
  assert.equal(service.upstreamProvider(), undefined, 'a refusal records no upstream')
  assert.equal(service.status().refusals, 1)
  assert.equal(service.status().forwards, 0)

  const allowed = await fake.fire({ provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(allowed.provider, 'coordination-proxy')
  assert.equal(service.upstreamProvider(), 'deepseek-account')
  assert.equal(service.status().upstreamProvider, 'deepseek-account')
  assert.deepEqual(service.status().upstream, { provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(service.status().refusals, 1, 'a rewrite is not a refusal')
})

test('status() is the documented body-free shape with counters and upstream identity', async (t) => {
  const dir = stateDir()
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  const fake = fakeContext({
    defaultRoute: { provider: 'deepseek-account', model: 'deepseek-flash' },
    chunks: () => [
      { type: 'usage', usage: { inputTokens: 1000, outputTokens: 12, cacheReadTokens: 250 } },
      { type: 'finish', reason: 'stop' },
    ],
    modelInfo: (provider, model) => ({ provider, model, name: 'DeepSeek Flash' }),
  })
  const { service, dispose, adapter } = await installRoutedService(dir, fake, {
    decorate: (request) => request,
  })
  t.after(() => { dispose() })

  const secret = 'sk-live-DO-NOT-LEAK-0123456789'
  await consume(adapter.stream(frozenRequest({
    messages: Object.freeze([Object.freeze({ role: 'user', content: `my key is ${secret}` })]),
  })))

  const status = service.status()
  assert.deepEqual(Object.keys(status).sort(), [
    'available',
    'cacheStrategy',
    'decorate',
    'enabled',
    'forwards',
    'lastForwardAt',
    'metrics',
    'mode',
    'model',
    'prefix',
    'provider',
    'refusals',
    'upstream',
    'upstreamProvider',
  ])
  assert.equal(status.provider, 'coordination-proxy')
  assert.equal(status.mode, 'measure', 'the default mode only measures')
  assert.equal(status.available, true)
  assert.equal(status.enabled, true)
  assert.equal(status.decorate, true)
  assert.equal(status.forwards, 1)
  assert.equal(status.refusals, 0)
  assert.match(status.lastForwardAt ?? '', /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(status.upstreamProvider, 'deepseek-account')
  assert.deepEqual(status.upstream, { provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(status.model?.brand, 'deepseek')
  assert.equal(status.model?.effortBreaksCache, 'unknown', 'effort behaviour is not a documented fact')

  assert.deepEqual(Object.keys(status.cacheStrategy).sort(), [
    'compactionPolicy',
    'effortBreaksPrefix',
    'id',
    'minPrefixTokens',
    'mode',
    'sources',
    'volatileStrippingHelps',
  ])
  assert.deepEqual(status.cacheStrategy, {
    id: 'deepseek/automatic',
    mode: 'automatic-prefix',
    minPrefixTokens: 64,
    effortBreaksPrefix: 'unknown',
    volatileStrippingHelps: true,
    compactionPolicy: 'avoid-mid-prefix',
    sources: ['deepseek-context-caching', 'prompt-cache-paper'],
  })
  // Removing volatile fragments is the lever for this row, so normalize may
  // decorate (the existing switch still has to say `normalize` first).
  assert.equal(status.cacheStrategy.volatileStrippingHelps, true)

  assert.deepEqual(Object.keys(status.metrics).sort(), [
    'cachedInputTokens',
    'hitRate',
    'inputTokens',
    'requests',
    'samples',
    'window',
  ])
  assert.deepEqual(status.metrics, {
    requests: 1,
    samples: 1,
    inputTokens: 1000,
    cachedInputTokens: 250,
    hitRate: 0.25,
    window: PROXY_METRIC_WINDOW,
  })
  assert.deepEqual(Object.keys(status.prefix).sort(), ['changes', 'current', 'stable'])
  assert.match(status.prefix.current ?? '', /^[0-9a-f]{16}$/)
  assert.equal(status.prefix.stable, true)
  assert.equal(status.prefix.changes, 0)
  assert.equal(JSON.stringify(status).includes(secret), false, 'status never carries request text')
})

test('compatibility() is a non-empty, stable, data-only list', () => {
  const dir = stateDir()
  const service = createProxyService({ context: fakeContext().context, stateDir: dir })
  try {
    const first = service.compatibility()
    const second = service.compatibility()
    assert.ok(first.length > 0)
    assert.equal(second, first, 'the same frozen list is returned')
    assert.deepEqual(second, first)
    assert.ok(Object.isFrozen(first))
    const webSearch = first.find((row) => row.feature === 'web-search')
    assert.ok(webSearch, 'the known web-search interaction is listed')
    assert.equal(webSearch.risk, 'account-fallback')
    assert.match(webSearch.note, /0\.2\.1-rc\.2/)
    assert.equal(webSearch.note.length > 0, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a successful install writes exactly one compat trace line', (t) => {
  const dir = stateDir()
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  enableProxy(dir)
  const fake = fakeContext({ defaultRoute: { provider: 'deepseek-account', model: 'deepseek-flash' } })
  const service = createProxyService({ context: fake.context, stateDir: dir })
  const dispose = service.install()
  service.install()
  t.after(() => { dispose() })

  const compat = traceLines(dir).filter((line) => line.event === 'compat')
  assert.equal(compat.length, 1, 'idempotent install writes one compat line')
  assert.equal(compat[0].reason, 'provider-id-rewrite')
  assert.equal(compat[0].upstreamProvider, 'deepseek-account')
  assert.equal('messages' in compat[0], false)
  assert.equal('chars' in compat[0], false)
  assert.equal(JSON.stringify(compat[0]).includes('stable system prompt'), false)
})

test('missing or malformed usage is skipped without breaking the stream', async (t) => {
  const dir = stateDir()
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  const chunkSets = [
    [
      { type: 'text-delta', index: 0, text: 'hello' },
      { type: 'usage' },
      { type: 'usage', usage: { outputTokens: 5 } },
      { type: 'usage', usage: { inputTokens: -1, cacheReadTokens: 3 } },
      { type: 'finish', reason: 'stop' },
    ],
  ]
  const fake = fakeContext({ chunks: (index) => chunkSets[index] ?? [] })
  const { service, dispose, adapter } = await installRoutedService(dir, fake)
  t.after(() => { dispose() })

  const chunks = await consume(adapter.stream(frozenRequest()))

  assert.equal(chunks.length, 5, 'every chunk still reaches the consumer')
  assert.deepEqual(service.status().metrics, {
    requests: 1,
    samples: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    hitRate: 0,
    window: PROXY_METRIC_WINDOW,
  })
})

test('hitRate accumulates readable usage samples over the window', async (t) => {
  const dir = stateDir()
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  const fake = fakeContext({
    chunks: (index) => index === 0
      ? [{ type: 'usage', usage: { inputTokens: 1000, cacheReadTokens: 250 } }]
      // The normalized alias must work as well as the host's field name.
      : [{ type: 'usage', usage: { inputTokens: 500, cachedInputTokens: 200 } }],
  })
  const { service, dispose, adapter } = await installRoutedService(dir, fake)
  t.after(() => { dispose() })

  await consume(adapter.stream(frozenRequest()))
  await consume(adapter.stream(frozenRequest()))

  const metrics = service.status().metrics
  assert.equal(metrics.requests, 2)
  assert.equal(metrics.samples, 2)
  assert.equal(metrics.inputTokens, 1500)
  assert.equal(metrics.cachedInputTokens, 450)
  assert.equal(metrics.hitRate, 0.3)
})

test('the metrics window keeps only the most recent 100 requests', async (t) => {
  const dir = stateDir()
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  const fake = fakeContext({
    chunks: (index) => index === 0
      ? [{ type: 'usage', usage: { inputTokens: 9999, cacheReadTokens: 9999 } }]
      : [{ type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 2 } }],
  })
  const { service, dispose, adapter } = await installRoutedService(dir, fake)
  t.after(() => { dispose() })

  for (let index = 0; index < PROXY_METRIC_WINDOW + 1; index += 1) {
    await consume(adapter.stream(frozenRequest()))
  }

  const metrics = service.status().metrics
  assert.equal(metrics.requests, PROXY_METRIC_WINDOW)
  assert.equal(metrics.samples, PROXY_METRIC_WINDOW)
  assert.equal(metrics.inputTokens, 10 * PROXY_METRIC_WINDOW, 'the evicted first request is not counted')
  assert.equal(metrics.cachedInputTokens, 2 * PROXY_METRIC_WINDOW)
  assert.equal(metrics.hitRate, 0.2)
  assert.equal(metrics.window, PROXY_METRIC_WINDOW)
})

test('prefix fingerprints are stable for the same prefix and churn for a new one', async (t) => {
  const dir = stateDir()
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  const fake = fakeContext()
  const { service, dispose, adapter } = await installRoutedService(dir, fake)
  t.after(() => { dispose() })

  const secret = 'DO-NOT-LEAK-PREFIX-CONTENT'
  const requestA = frozenRequest({
    system: `system ${secret}`,
    messages: Object.freeze([Object.freeze({ role: 'user', content: secret })]),
  })
  const requestB = frozenRequest({
    system: 'different system',
    messages: Object.freeze([Object.freeze({ role: 'user', content: 'different content' })]),
  })

  adapter.stream(requestA)
  adapter.stream(requestA)
  const first = service.status().prefix
  assert.match(first.current ?? '', /^[0-9a-f]{16}$/)
  assert.equal(first.stable, true)
  assert.equal(first.changes, 0)

  adapter.stream(requestB)
  const changed = service.status().prefix
  assert.notEqual(changed.current, first.current)
  assert.equal(changed.stable, false)
  assert.equal(changed.changes, 1)

  adapter.stream(requestB)
  const recovered = service.status().prefix
  assert.equal(recovered.current, changed.current)
  assert.equal(recovered.stable, true)
  assert.equal(recovered.changes, 1)

  const lines = traceLines(dir)
  const prefixes = lines.filter((line) => line.event === 'prefix')
  assert.deepEqual(prefixes.map((line) => line.stable), [true, true, false, true])
  assert.equal(new Set(prefixes.slice(0, 2).map((line) => line.prefix)).size, 1)
  const churn = lines.filter((line) => line.event === 'prefix-churn')
  assert.equal(churn.length, 1)
  assert.equal(churn[0].from, prefixes[1].prefix)
  assert.equal(churn[0].to, prefixes[2].prefix)
  assert.equal(readFileSync(join(dir, 'proxy.log'), 'utf8').includes(secret), false,
    'prefix traces carry hashes, never the prefix content')
})

test('measure mode forwards the frozen request unchanged and never calls the decorator', async (t) => {
  const dir = stateDir()
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  const fake = fakeContext()
  let decorateCalls = 0
  const { service, dispose, adapter } = await installRoutedService(dir, fake, {
    decorate: (request) => {
      decorateCalls += 1
      return { ...request, messages: [{ role: 'user', content: 'rewritten' }] }
    },
  })
  t.after(() => { dispose() })

  const request = frozenRequest()
  await consume(adapter.stream(request))

  assert.equal(decorateCalls, 0, 'measure mode never invokes the decorator')
  const forwarded = fake.forwarded[0] as Record<string, unknown>
  const original = request as Record<string, unknown>
  assert.equal(forwarded.messages, original.messages, 'message objects are not cloned or rewritten')
  assert.equal(forwarded.tools, original.tools)
  assert.equal(forwarded.system, original.system)
  assert.deepEqual(forwarded, { ...original, provider: 'deepseek-account' })
  assert.equal(JSON.stringify(forwarded), JSON.stringify({ ...original, provider: 'deepseek-account' }),
    'the serialized request differs only in the restored provider route')
  assert.equal(service.status().mode, 'measure')
  assert.equal(service.status().decorate, true)
})

test('normalize mode calls the decorator with the real identity', async (t) => {
  const dir = stateDir()
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  writeFileSync(join(dir, 'proxy.mode'), 'normalize\n', 'utf8')
  const fake = fakeContext()
  const calls: Array<{ request: unknown; identity: unknown }> = []
  const { service, dispose, adapter } = await installRoutedService(dir, fake, {
    decorate: (request, identity) => {
      calls.push({ request, identity })
      return { ...request, messages: [{ role: 'user', content: 'normalized' }] }
    },
  })
  t.after(() => { dispose() })

  const request = frozenRequest()
  await consume(adapter.stream(request))

  assert.equal(service.status().mode, 'normalize')
  assert.equal(service.status().cacheStrategy.id, 'deepseek/automatic')
  assert.equal(service.status().cacheStrategy.volatileStrippingHelps, true)
  assert.equal(calls.length, 1, 'normalize invokes the decorator once')
  assert.equal(calls[0].request, request, 'the decorator receives the frozen request')
  assert.deepEqual(calls[0].identity, { provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.deepEqual((fake.forwarded[0] as Record<string, unknown>).messages, [
    { role: 'user', content: 'normalized' },
  ])
})

test('normalize gating follows the resolved preset, not the coarse brand profile', async (t) => {
  const dir = stateDir()
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  writeFileSync(join(dir, 'proxy.mode'), 'normalize\n', 'utf8')
  const fake = fakeContext()
  let decorateCalls = 0
  const { service, dispose, adapter } = await installRoutedService(dir, fake, {
    decorate: (request) => {
      decorateCalls += 1
      return { ...request, messages: [{ role: 'user', content: 'normalized' }] }
    },
  })
  t.after(() => { dispose() })

  // The first route is DeepSeek, whose preset says byte-stable stripping helps.
  assert.equal(service.status().cacheStrategy.id, 'deepseek/automatic')
  assert.equal(service.status().cacheStrategy.volatileStrippingHelps, true)

  // A Claude model resolves through the same allowlisted route; its preset is
  // explicit-breakpoints, where reuse is decided by markers this plugin cannot
  // emit, so rewriting bytes would only risk changing what the model sees.
  const claudeRequest = frozenRequest({ model: 'claude-opus-4-6' })
  await fake.fire({ provider: 'deepseek-account', model: 'claude-opus-4-6' })
  await consume(adapter.stream(claudeRequest))

  assert.equal(service.status().mode, 'normalize')
  assert.equal(service.status().cacheStrategy.id, 'anthropic/claude-high-minimum')
  assert.equal(service.status().cacheStrategy.mode, 'explicit-breakpoints')
  assert.equal(service.status().cacheStrategy.volatileStrippingHelps, false)
  assert.equal(decorateCalls, 0, 'the preset gate refuses to decorate a marker-only row')
  assert.equal(
    (fake.forwarded[0] as Record<string, unknown>).messages,
    claudeRequest.messages,
    'the request is forwarded unchanged when the preset has no local lever',
  )
})

test('a proxy.rewrite marker forces normalize even when proxy.mode says measure', async (t) => {
  const dir = stateDir()
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  writeFileSync(join(dir, 'proxy.mode'), 'measure\n', 'utf8')
  writeFileSync(join(dir, 'proxy.rewrite'), '', 'utf8')
  const fake = fakeContext()
  let decorateCalls = 0
  const { service, dispose, adapter } = await installRoutedService(dir, fake, {
    decorate: (request) => {
      decorateCalls += 1
      return request
    },
  })
  t.after(() => { dispose() })

  await consume(adapter.stream(frozenRequest()))

  assert.equal(service.status().mode, 'normalize')
  assert.equal(decorateCalls, 1)
})
