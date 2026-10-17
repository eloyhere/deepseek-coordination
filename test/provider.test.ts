/**
 * Provider view and cache optimizer tests.
 *
 * The modules are exercised against a fake `LlmReadPort` and an in-memory
 * coordination database: no DSH process, no network, no compiled bundle. Every
 * assertion is about this repository's contract — DSH stays the authority for
 * brands and models, while the module owns only the documented policy
 * supplement and its own accounting rows.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CacheModule } from '../src/host/cache.js'
import type { CoordinationConfig } from '../src/host/config.js'
import { SceneProfiles } from '../src/shared/enum.js'
import { CoordinationDatabase } from '../src/host/database.js'
import { ManualClock } from '../src/host/handle.js'
import { createModuleHost } from '../src/host/module.js'
import type {
  LlmConfigurableProviderInfo,
  LlmModelInfo,
  LlmProviderInfo,
  LlmReadPort,
  LlmResolvedModelInfo,
  ModuleHost,
  TraceWriter,
} from '../src/host/module.js'
import { ProviderModule } from '../src/host/provider.js'
import { mapProviderView } from '../src/host/row.js'
import type { Row } from '../src/host/row.js'
import { NotFoundError, NotImplementedError, UpstreamError } from '../src/shared/error.js'
import type { GenerateOptionsLike, MessageLike } from '../src/shared/service.js'

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

/** The schema-mirroring defaults, written out so tests never load schemastery. */
function testConfig(ttl = 60_000): CoordinationConfig {
  return {
    database: 'coordination',
    databasePath: '',
    maxTurnPerSession: 1000,
    defaultLease: 30_000,
    clarifyTimeout: 30_000,
    profession: {
      enabled: true,
      lock: true,
      default: 'execution',
      rebuildCanReselect: true,
      abandonCanReselect: true,
      audit: true,
      errorHint: true,
    },
    plan: {
      threshold: 0.5,
      maxRebuild: 3,
      weights: {
        feasibility: 0.15,
        coverage: 0.15,
        clarity: 0.1,
        specificity: 0.1,
        alignment: 0.2,
        risk: 0.1,
        cost: 0.1,
        efficiency: 0.1,
      },
      dimensions: {
        feasibility: 0.5,
        coverage: 0.6,
        clarity: 0.5,
        specificity: 0.5,
        alignment: 0.7,
        risk: 0.7,
        cost: 0.8,
        efficiency: 0.5,
      },
    },
    orchestration: {
      maxReject: 2,
      maxSubTask: 32,
      groundTruth: true,
      groundTruthTimeout: 5000,
      allowShellGroundTruth: false,
      modelRouting: true,
    },
    cache: { enabled: true, ttl, fingerprintWindow: 50, effortWarning: true },
    bayesian: { prior: 0.5, stopEntropy: 0.05, infoGain: 0.01, maxRoutes: 12, calibrationFloor: 0.1 },
    comprehension: { stageTimeout: 30_000, searchEnabled: true, maxEvidence: 8, highHistoryWindow: 50 },
    compaction: {
      auto: true,
      soft: 0.7,
      hard: 0.88,
      reserve: 2048,
      recentTurns: 6,
      cooldown: 30000,
      maxPerSession: 20,
    },
    parser: {
      enabled: true,
      maxFileBytes: 1_048_576,
      maxTokens: 200_000,
      maxAstDepth: 256,
      timeoutMs: 2000,
      cacheCapacity: 256,
      dependencyGraphMaxVertices: 20_000,
      dependencyGraphMaxEdges: 100_000,
    },
    chain: { depth: 8, links: 50, tokenBudget: 1500 },
    tools: { maxResultBytes: 0 },
    scenes: SceneProfiles,
    ui: { toolbar: true, showTooltip: true, takeover: false, refreshInterval: 5000, compact: true, locale: 'auto' },
    defaults: { profession: 'execution', interaction: 'think', scene: 'dialogue', validation: 'medium', command: 'none' },
  }
}

/** Provider and cache modules never write the governance trace. */
const unusedTrace: TraceWriter = {
  append: () => {
    throw new Error('provider/cache modules do not append trace events')
  },
  list: () => [],
  verify: () => ({ ok: true }),
}

function makeHost(
  llm?: LlmReadPort,
  options: { clock?: ManualClock; ttl?: number } = {},
): { host: ModuleHost; clock: ManualClock } {
  const clock = options.clock ?? new ManualClock()
  const host = createModuleHost({
    db: new CoordinationDatabase(':memory:'),
    config: testConfig(options.ttl),
    trace: unusedTrace,
    clock,
    ...(llm === undefined ? {} : { llm }),
  })
  return { host, clock }
}

/** A read port that behaves like DSH: registries, catalogs and resolution. */
class FakeLlm implements LlmReadPort {
  readonly providers: LlmProviderInfo[]
  readonly configurable: LlmConfigurableProviderInfo[]
  readonly catalog = new Map<string, LlmModelInfo[]>()
  readonly resolved = new Map<string, LlmResolvedModelInfo>()
  readonly listModelsCalls: string[] = []
  readonly resolveCalls: string[] = []

  constructor(providers: LlmProviderInfo[], configurable: LlmConfigurableProviderInfo[]) {
    this.providers = providers
    this.configurable = configurable
  }

  listProviders(): LlmProviderInfo[] {
    return this.providers.map((provider) => ({ ...provider }))
  }

  listConfigurableProviders(): LlmConfigurableProviderInfo[] {
    return this.configurable.map((entry) => ({ ...entry, settingsPath: [...entry.settingsPath] }))
  }

  async listModels(provider: string): Promise<LlmModelInfo[]> {
    this.listModelsCalls.push(provider)
    const models = this.catalog.get(provider)
    // Mirrors dsh-llm: only a registered provider has an adapter to ask.
    if (models === undefined) throw new Error(`no adapter registered for provider "${provider}"`)
    return models.map((model) => ({ ...model }))
  }

  async resolveModelInfo(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.resolveCalls.push(`${provider}/${model}`)
    const resolved = this.resolved.get(`${provider}/${model}`)
    return resolved === undefined ? { provider, id: model, name: model } : { ...resolved }
  }
}

/** Two live routes (one of them declared) plus one dormant declared route. */
function fixtureLlm(): FakeLlm {
  const llm = new FakeLlm(
    [
      { id: 'deepseek-official', name: 'DeepSeek' },
      { id: 'anthropic', name: 'Anthropic' },
    ],
    [
      {
        provider: 'deepseek-official',
        displayName: 'DeepSeek (declared)',
        settingsNs: 'llm-deepseek',
        settingsPath: ['provider'],
        declared: true,
      },
      {
        provider: 'moonshot',
        displayName: 'Moonshot',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['provider'],
        declared: true,
      },
      // Declared directory entry that no adapter has activated: dormant and
      // undeclared, which is the user layer in both branches of the mapping.
      {
        provider: 'local-llm',
        displayName: 'Local LLM',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['provider'],
      },
    ],
  )
  llm.catalog.set('deepseek-official', [
    { provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat', inputModalities: ['text'] },
    {
      provider: 'deepseek-official',
      id: 'deepseek-reasoner',
      name: 'DeepSeek Reasoner',
      inputModalities: ['text', 'image'],
    },
  ])
  llm.catalog.set('anthropic', [
    { provider: 'anthropic', id: 'claude-sonnet', name: 'Claude Sonnet', inputModalities: ['text', 'image'] },
  ])
  llm.resolved.set('deepseek-official/deepseek-chat', {
    provider: 'deepseek-official',
    id: 'deepseek-chat',
    name: 'DeepSeek Chat',
    context: { contextWindow: 65_536 },
    defaultMaxTokens: 8_192,
    inputModalities: ['text'],
    reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
  })
  llm.resolved.set('deepseek-official/deepseek-reasoner', {
    provider: 'deepseek-official',
    id: 'deepseek-reasoner',
    name: 'DeepSeek Reasoner',
    context: { contextWindow: 131_072 },
    defaultMaxTokens: 16_384,
    inputModalities: ['text', 'image'],
    reasoning: { efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] },
  })
  llm.resolved.set('anthropic/claude-sonnet', {
    provider: 'anthropic',
    id: 'claude-sonnet',
    name: 'Claude Sonnet',
    context: { contextWindow: 200_000 },
    defaultMaxTokens: 8_192,
    inputModalities: ['text', 'image'],
    reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }] },
  })
  return llm
}

/* ------------------------------------------------------------------------- *
 * Provider view
 * ------------------------------------------------------------------------- */

test('list merges the live and configurable registries with DSH provenance', (t) => {
  const { host, clock } = makeHost(fixtureLlm())
  t.after(() => host.db.close())
  const provider = new ProviderModule(host)

  const views = provider.list()
  assert.deepEqual(
    views.map((view) => view.route),
    ['deepseek-official', 'anthropic', 'moonshot', 'local-llm'],
    'live routes first, then dormant directory entries',
  )
  const byRoute = new Map(views.map((view) => [view.route, view]))

  const deepseek = byRoute.get('deepseek-official')
  assert.ok(deepseek)
  assert.equal(deepseek.live, true)
  assert.equal(deepseek.source, 'plugin')
  assert.equal(deepseek.title, 'DeepSeek (declared)')
  assert.equal(deepseek.observed, clock.now())
  assert.deepEqual(deepseek.cacheStrategy, { effortCacheBreak: true, reasoningPreserve: false })
  assert.deepEqual(deepseek.models, [])

  const anthropic = byRoute.get('anthropic')
  assert.ok(anthropic)
  assert.equal(anthropic.live, true)
  assert.equal(anthropic.source, 'base', 'live but undeclared is a base composition route')
  assert.equal(anthropic.title, 'Anthropic', 'falls back to the live provider name')

  const moonshot = byRoute.get('moonshot')
  assert.ok(moonshot)
  assert.equal(moonshot.live, false)
  assert.equal(moonshot.source, 'user')
  assert.equal(moonshot.title, 'Moonshot', 'a dormant route still gets its display name')
  assert.match(moonshot.notes ?? '', /dormant/)
  assert.deepEqual(moonshot.models, [])

  const local = byRoute.get('local-llm')
  assert.ok(local)
  assert.equal(local.live, false)
  assert.equal(local.source, 'user', 'dormant and undeclared is still the user layer')
  assert.match(local.notes ?? '', /dormant/)

  assert.deepEqual(provider.resolve('deepseek-official'), deepseek)
  assert.throws(() => provider.resolve('missing'), (error: unknown) => error instanceof NotFoundError)
})

test('models are read from DSH and enriched with resolved capability', async (t) => {
  const llm = fixtureLlm()
  const { host } = makeHost(llm)
  t.after(() => host.db.close())
  const provider = new ProviderModule(host)

  const models = await provider.models('deepseek-official')
  assert.deepEqual(
    models.map((model) => model.id),
    ['deepseek-chat', 'deepseek-reasoner'],
  )
  const chat = models[0]
  assert.equal(chat.name, 'DeepSeek Chat')
  assert.equal(chat.contextWindow, 65_536)
  assert.equal(chat.maxTokens, 8_192)
  assert.deepEqual(chat.input, ['text'])
  assert.deepEqual(chat.reasoningEfforts, ['low', 'high'])
  const reasoner = models[1]
  assert.equal(reasoner.contextWindow, 131_072)
  assert.equal(reasoner.maxTokens, 16_384)
  assert.deepEqual(reasoner.input, ['text', 'image'])
  assert.deepEqual(reasoner.reasoningEfforts, ['medium', 'high'])
  assert.deepEqual(llm.resolveCalls, ['deepseek-official/deepseek-chat', 'deepseek-official/deepseek-reasoner'])

  // The synchronous view carries the catalog once it has been observed.
  const view = provider.resolve('deepseek-official')
  assert.deepEqual(
    view.models.map((model) => model.id),
    ['deepseek-chat', 'deepseek-reasoner'],
  )
  assert.deepEqual(llm.listModelsCalls, ['deepseek-official'], 'a fresh catalog is not re-read')

  // A dormant route has no registered adapter to interrogate.
  assert.deepEqual(await provider.models('moonshot'), [])
  assert.deepEqual(llm.listModelsCalls, ['deepseek-official'])

  // Unknown routes are a typed miss, synchronously and asynchronously.
  assert.throws(() => provider.resolve('missing'), (error: unknown) => error instanceof NotFoundError)
  await assert.rejects(provider.models('missing'), (error: unknown) => error instanceof NotFoundError)

  // Results are copies: mutation cannot corrupt the cached catalog.
  chat.input.push('audio')
  const again = await provider.models('deepseek-official')
  assert.deepEqual(again[0].input, ['text'])
})

test('a failing DSH catalog read surfaces as a typed upstream error', async (t) => {
  const llm = fixtureLlm()
  llm.catalog.delete('deepseek-official')
  const { host } = makeHost(llm)
  t.after(() => host.db.close())
  const provider = new ProviderModule(host)

  await assert.rejects(
    provider.models('deepseek-official'),
    (error: unknown) => error instanceof UpstreamError && error.code === 'UPSTREAM',
  )
  // The failure is not cached: the next call asks DSH again.
  await assert.rejects(provider.models('deepseek-official'), (error: unknown) => error instanceof UpstreamError)
  assert.deepEqual(llm.listModelsCalls, ['deepseek-official', 'deepseek-official'])
})

test('the model catalog cache honours config.cache.ttl and invalidate()', async (t) => {
  const llm = fixtureLlm()
  const clock = new ManualClock()
  const { host } = makeHost(llm, { clock, ttl: 1_000 })
  t.after(() => host.db.close())
  const provider = new ProviderModule(host)

  await provider.models('deepseek-official')
  await provider.models('deepseek-official')
  assert.equal(llm.listModelsCalls.length, 1)

  clock.advance(999)
  await provider.models('deepseek-official')
  assert.equal(llm.listModelsCalls.length, 1, 'still inside the TTL')

  clock.advance(1)
  await provider.models('deepseek-official')
  assert.equal(llm.listModelsCalls.length, 2, 'the TTL expired')

  provider.invalidate('deepseek-official')
  await provider.models('deepseek-official')
  assert.equal(llm.listModelsCalls.length, 3)

  provider.invalidate()
  await provider.models('deepseek-official')
  assert.equal(llm.listModelsCalls.length, 4)
})

test('cache strategies are the documented provider policy, not a model catalog', (t) => {
  const { host } = makeHost()
  t.after(() => host.db.close())
  const provider = new ProviderModule(host)

  assert.deepEqual(provider.cacheStrategy('deepseek-official'), { effortCacheBreak: true, reasoningPreserve: false })
  assert.deepEqual(provider.cacheStrategy('anthropic'), { effortCacheBreak: true, reasoningPreserve: false })
  assert.deepEqual(provider.cacheStrategy('moonshot'), { effortCacheBreak: true, reasoningPreserve: true })
  assert.deepEqual(provider.cacheStrategy('kimi-k2'), { effortCacheBreak: true, reasoningPreserve: true })
  assert.deepEqual(provider.cacheStrategy('openai'), {
    effortCacheBreak: false,
    reasoningPreserve: false,
    configUpdateParam: 'configuration_update',
  })
  assert.deepEqual(provider.cacheStrategy('gpt-6-preview'), {
    effortCacheBreak: false,
    reasoningPreserve: false,
    configUpdateParam: 'configuration_update',
  })
  assert.deepEqual(provider.cacheStrategy('xai-grok'), { effortCacheBreak: true, reasoningPreserve: false })

  const fallback = provider.cacheStrategy('acme-local')
  assert.deepEqual(fallback, { effortCacheBreak: true, reasoningPreserve: false }, 'unknown families fail conservative')
  assert.notEqual(fallback, provider.cacheStrategy('acme-local'), 'callers get their own copy')

  // The policy is pure, but the view itself is not: without ctx.llm it refuses.
  assert.throws(
    () => provider.list(),
    (error: unknown) => error instanceof NotImplementedError && error.code === 'NOT_IMPLEMENTED',
  )
})

test('the view reports exactly what the port registers, never a guessed brand', async (t) => {
  const llm = new FakeLlm([{ id: 'acme-llm', name: 'Acme' }], [])
  llm.catalog.set('acme-llm', [{ provider: 'acme-llm', id: 'acme-1', name: 'Acme One' }])
  const { host } = makeHost(llm)
  t.after(() => host.db.close())
  const provider = new ProviderModule(host)

  assert.deepEqual(
    provider.list().map((view) => view.route),
    ['acme-llm'],
    'no brand outside the port appears',
  )
  // No resolved metadata means the capability is unknown, not invented.
  assert.deepEqual(await provider.models('acme-llm'), [
    { id: 'acme-1', name: 'acme-1', contextWindow: 0, maxTokens: 0, input: [] },
  ])
  // The policy table names no models and defaults conservatively.
  assert.deepEqual(provider.cacheStrategy('acme-llm'), { effortCacheBreak: true, reasoningPreserve: false })
})

test('checkQualification gates on a live route and its observed capability only', async (t) => {
  const { host } = makeHost(fixtureLlm())
  t.after(() => host.db.close())
  const provider = new ProviderModule(host)

  assert.equal(provider.checkQualification('deepseek-official'), true)
  assert.equal(provider.checkQualification('moonshot'), false, 'a dormant route cannot qualify')
  assert.equal(
    provider.checkQualification('deepseek-official', { input: 'image' }),
    false,
    'without an observed catalog the requirement fails closed',
  )

  await provider.models('deepseek-official')
  assert.equal(provider.checkQualification('deepseek-official', { input: 'image' }), true)
  assert.equal(provider.checkQualification('deepseek-official', { input: 'video' }), false)
  assert.equal(provider.checkQualification('deepseek-official', { contextWindow: 100_000 }), true)
  assert.equal(provider.checkQualification('deepseek-official', { contextWindow: 300_000 }), false)
  assert.equal(provider.checkQualification('deepseek-official', { effort: 'high' }), true)
  assert.equal(provider.checkQualification('deepseek-official', { effort: 'none' }), false)
  assert.equal(
    provider.checkQualification('deepseek-official', { input: 'image', contextWindow: 100_000, effort: 'high' }),
    true,
  )
  assert.throws(() => provider.checkQualification('missing'), (error: unknown) => error instanceof NotFoundError)
})

test('observe upserts one provider_view row per route', async (t) => {
  const llm = fixtureLlm()
  const { host, clock } = makeHost(llm)
  t.after(() => host.db.close())
  const provider = new ProviderModule(host)

  await provider.models('deepseek-official')
  provider.observe('deepseek-official')
  provider.observe('deepseek-official')
  assert.equal(host.db.count('provider_view'), 1, 'route is the upsert key')

  const row = host.db.get<Row>('SELECT * FROM provider_view WHERE route = ?', 'deepseek-official')
  assert.ok(row)
  const view = mapProviderView(row)
  assert.equal(view.route, 'deepseek-official')
  assert.equal(view.title, 'DeepSeek (declared)')
  assert.equal(view.live, true)
  assert.equal(view.source, 'plugin')
  assert.deepEqual(
    view.models.map((model) => model.id),
    ['deepseek-chat', 'deepseek-reasoner'],
  )
  assert.deepEqual(view.cacheStrategy, { effortCacheBreak: true, reasoningPreserve: false })
  assert.equal(view.observed, clock.now())

  provider.observe('moonshot')
  const dormant = host.db.get<Row>('SELECT * FROM provider_view WHERE route = ?', 'moonshot')
  assert.ok(dormant)
  assert.equal(mapProviderView(dormant).live, false)
  assert.throws(() => provider.observe('missing'), (error: unknown) => error instanceof NotFoundError)
})

test('without the llm port the view refuses to invent a provider', async (t) => {
  const { host } = makeHost()
  t.after(() => host.db.close())
  const provider = new ProviderModule(host)

  assert.throws(
    () => provider.list(),
    (error: unknown) => error instanceof NotImplementedError && error.code === 'NOT_IMPLEMENTED',
  )
  assert.throws(() => provider.resolve('deepseek-official'), (error: unknown) => error instanceof NotImplementedError)
  assert.throws(() => provider.observe('deepseek-official'), (error: unknown) => error instanceof NotImplementedError)
  await assert.rejects(
    provider.models('deepseek-official'),
    (error: unknown) => error instanceof NotImplementedError,
  )
  // The policy supplement needs no DSH read and still answers.
  assert.deepEqual(provider.cacheStrategy('deepseek-official'), { effortCacheBreak: true, reasoningPreserve: false })
})

/* ------------------------------------------------------------------------- *
 * Cache optimizer
 * ------------------------------------------------------------------------- */

test('fingerprint is stable across object key order and distinguishes content', (t) => {
  const { host } = makeHost()
  t.after(() => host.db.close())
  const cache = new CacheModule(host)

  const first: MessageLike[] = [{ role: 'user', content: { text: 'hi', meta: { a: 1, b: 2 } } }]
  const reordered: MessageLike[] = [{ role: 'user', content: { meta: { b: 2, a: 1 }, text: 'hi' } }]
  assert.equal(cache.fingerprint(first), cache.fingerprint(reordered))
  assert.match(cache.fingerprint(first), /^[0-9a-f]{64}$/)
  assert.equal(cache.fingerprint(first), cache.fingerprint(first))

  assert.notEqual(
    cache.fingerprint(first),
    cache.fingerprint([{ role: 'assistant', content: { text: 'hi', meta: { a: 1, b: 2 } } }]),
    'role is part of the digest',
  )
  assert.notEqual(cache.fingerprint(first), cache.fingerprint([{ role: 'user', content: 'hi' }]))
  assert.notEqual(
    cache.fingerprint([{ role: 'user', content: [1, 2, 3] }]),
    cache.fingerprint([{ role: 'user', content: [3, 2, 1] }]),
    'array order is content',
  )
})

test('reorderMessages keeps fixed content first and preserves relative order', (t) => {
  const { host } = makeHost()
  t.after(() => host.db.close())
  const cache = new CacheModule(host)
  const strategy = { effortCacheBreak: true, reasoningPreserve: false }

  const messages: MessageLike[] = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'system', content: 's' },
    { role: 'developer', content: 'd' },
    { role: 'user', content: 'u2' },
    { role: 'tool', content: 't1' },
  ]
  const ordered = cache.reorderMessages(messages, strategy)
  assert.deepEqual(
    ordered.map((message) => message.content),
    ['s', 'd', 'u1', 'a1', 'u2', 't1'],
  )
  assert.equal(ordered.length, messages.length, 'nothing is dropped or merged')
  assert.deepEqual(
    messages.map((message) => message.content),
    ['u1', 'a1', 's', 'd', 'u2', 't1'],
    'the input array is untouched',
  )
  // The fixed-prefix rule of v23 §5.3 applies to every provider family.
  assert.deepEqual(
    cache
      .reorderMessages(messages, { effortCacheBreak: false, reasoningPreserve: true, configUpdateParam: 'x' })
      .map((message) => message.content),
    ['s', 'd', 'u1', 'a1', 'u2', 't1'],
  )
})

test('stripDynamicContent removes volatile fragments deterministically', (t) => {
  const { host } = makeHost()
  t.after(() => host.db.close())
  const cache = new CacheModule(host)

  const text = [
    'Started 2026-01-02T03:04:05.678Z by 550e8400-e29b-41d4-a716-446655440000.',
    `Token ${'a'.repeat(40)} stays out of the prefix;`,
    'current time is 12:34:56',
  ].join(' ')
  const stripped = cache.stripDynamicContent(text)
  assert.ok(!stripped.includes('2026-01-02T03:04:05'), 'ISO timestamp is normalised')
  assert.ok(stripped.includes('<timestamp>'))
  assert.ok(!stripped.includes('550e8400-e29b-41d4-a716-446655440000'), 'UUID is normalised')
  assert.ok(stripped.includes('<uuid>'))
  assert.ok(!stripped.includes('a'.repeat(40)), 'long hex is normalised')
  assert.ok(stripped.includes('<hex>'))
  assert.ok(stripped.includes('current time is <time>'))
  assert.ok(!stripped.includes('12:34:56'))
  assert.equal(cache.stripDynamicContent(text), stripped, 'deterministic')
  assert.equal(cache.stripDynamicContent(''), '')
  assert.equal(
    cache.stripDynamicContent('Keep the system prompt and user request intact.'),
    'Keep the system prompt and user request intact.',
    'ordinary prose is never stripped',
  )
})

test('effort break detection is counted per coordination session', (t) => {
  const { host } = makeHost()
  t.after(() => host.db.close())
  const cache = new CacheModule(host)

  assert.equal(cache.checkEffortCacheBreak(7, 'medium'), false, 'the first observation is not a change')
  assert.equal(cache.checkEffortCacheBreak(7, 'medium'), false, 'unchanged effort is not a break')
  assert.equal(
    cache.checkEffortCacheBreak(7, 'high', { effortCacheBreak: true, reasoningPreserve: false }),
    true,
  )
  assert.equal(cache.stats(7).effortBreaks, 1)
  assert.equal(cache.stats(7).totalRequests, 0, 'an effort break is not a request')

  assert.equal(cache.checkEffortCacheBreak(8, 'low'), false)
  assert.equal(
    cache.checkEffortCacheBreak(8, 'high', { effortCacheBreak: false, reasoningPreserve: false }),
    false,
    'providers that update effort in place keep the cache',
  )
  assert.equal(cache.stats(8).effortBreaks, 0)
  assert.equal(cache.checkEffortCacheBreak(8, 'low'), true, 'the conservative default breaks')
  assert.equal(cache.stats(8).effortBreaks, 1)

  assert.equal(cache.stats(7).effortBreaks, 1, 'sessions are isolated')
  assert.deepEqual(cache.stats(9), {
    totalRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    hitRate: 0,
    estimatedSavings: 0,
    effortBreaks: 0,
  })
})

test('cache stats come from recorded TokenUsage and never estimate savings', (t) => {
  const { host } = makeHost()
  t.after(() => host.db.close())
  const cache = new CacheModule(host)

  cache.recordUsage(1, { inputTokens: 1000, cacheReadTokens: 400 })
  let stats = cache.stats(1)
  assert.equal(stats.totalRequests, 1)
  assert.equal(stats.cacheHits, 400)
  assert.equal(stats.cacheMisses, 600)
  assert.equal(stats.hitRate, 0.4)
  assert.equal(stats.estimatedSavings, 0, 'DSH owns pricing')

  cache.recordUsage(1, { inputTokens: 200, cacheReadTokens: 50 })
  stats = cache.stats(1)
  assert.equal(stats.totalRequests, 2)
  assert.equal(stats.cacheHits, 450)
  assert.equal(stats.cacheMisses, 750)
  assert.equal(stats.hitRate, 0.375)

  // A request with no usage still counts, and adds no phantom hit or miss.
  cache.recordUsage(1, {})
  stats = cache.stats(1)
  assert.equal(stats.totalRequests, 3)
  assert.equal(stats.cacheHits, 450)
  assert.equal(stats.cacheMisses, 750)

  // A cache read larger than the reported input never yields a negative miss.
  cache.recordUsage(1, { inputTokens: 10, cacheReadTokens: 50 })
  stats = cache.stats(1)
  assert.equal(stats.cacheHits, 500)
  assert.equal(stats.cacheMisses, 750)
  assert.equal(stats.hitRate, 0.4)
  assert.deepEqual(cache.stats(2), {
    totalRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    hitRate: 0,
    estimatedSavings: 0,
    effortBreaks: 0,
  })
})

test('decorate reorders and strips without touching reasoningEffort or the input', (t) => {
  const { host } = makeHost()
  t.after(() => host.db.close())
  const cache = new CacheModule(host)
  const original: GenerateOptionsLike = {
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    reasoningEffort: 'high',
    maxTokens: 4096,
    temperature: 0.2,
    messages: [
      { role: 'user', content: 'Run at 2026-01-02T03:04:05Z' },
      { role: 'system', content: 'Be stable', extra: 'kept' },
    ],
    options: { keep: true },
  }
  const snapshot = JSON.parse(JSON.stringify(original)) as unknown

  const decorated = cache.decorate(original, { effortCacheBreak: true, reasoningPreserve: false })
  assert.notEqual(decorated, original)
  assert.notEqual(decorated.messages, original.messages)
  assert.deepEqual(
    decorated.messages.map((message) => message.role),
    ['system', 'user'],
  )
  assert.equal(decorated.messages[0].content, 'Be stable')
  assert.equal(decorated.messages[0].extra, 'kept')
  assert.ok(String(decorated.messages[1].content).includes('<timestamp>'))
  assert.equal(decorated.reasoningEffort, 'high', 'effort is passed through verbatim')
  assert.equal(decorated.provider, 'deepseek-official')
  assert.equal(decorated.model, 'deepseek-chat')
  assert.equal(decorated.maxTokens, 4096)
  assert.equal(decorated.temperature, 0.2)
  assert.deepEqual(decorated.options, { keep: true })
  assert.equal(typeof decorated.cacheWarning, 'string')
  assert.deepEqual(original, snapshot, 'the caller\'s options are not mutated')
})

test('decorate honours the cache switches', (t) => {
  const { host } = makeHost()
  t.after(() => host.db.close())
  const cache = new CacheModule(host)
  const original: GenerateOptionsLike = {
    messages: [
      { role: 'user', content: 'Run at 2026-01-02T03:04:05Z' },
      { role: 'system', content: 'Be stable' },
    ],
    reasoningEffort: 'high',
  }

  // GPT-6 can change effort through `configuration_update`; no cache warning.
  const updating = cache.decorate(original, cacheSafeStrategy())
  assert.equal(updating.cacheWarning, undefined)
  assert.equal(updating.reasoningEffort, 'high')

  host.config.cache.effortWarning = false
  assert.equal(cache.decorate(original, cacheBreakingStrategy()).cacheWarning, undefined)
  host.config.cache.effortWarning = true

  host.config.cache.enabled = false
  const disabled = cache.decorate(original, cacheBreakingStrategy())
  assert.deepEqual(
    disabled.messages.map((message) => message.content),
    original.messages.map((message) => message.content),
    'the optimizer switch disables reordering and stripping',
  )
  assert.equal(disabled.cacheWarning, undefined)
  assert.equal(disabled.reasoningEffort, 'high')
  assert.deepEqual(
    cache.reorderMessages(original.messages, cacheBreakingStrategy()).map((message) => message.role),
    ['system', 'user'],
    'the stateless helpers remain available',
  )
})

function cacheBreakingStrategy() {
  return { effortCacheBreak: true, reasoningPreserve: false }
}

function cacheSafeStrategy() {
  return { effortCacheBreak: false, reasoningPreserve: false, configUpdateParam: 'configuration_update' }
}
