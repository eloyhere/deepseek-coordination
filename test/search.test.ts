/**
 * `coordination_search`: the Elasticsearch projection and its model-facing tool.
 *
 * The cluster is never contacted. The tests pin the parts that decide what the
 * model can ask and what comes back:
 *
 *  - argument validation (query, index pattern, size/from bounds, fields);
 *  - environment-only connection resolution, with bounded defaults;
 *  - the `simple_query_string` request shape;
 *  - response projection, including total-count forms and `_source` truncation;
 *  - typed failures for an unreachable cluster, a missing index and a missing
 *    client module — never fabricated hits.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SEARCH_LIMITS,
  buildSearchRequest,
  parseSearchQuery,
  runSearch,
  searchConnectionFromEnv,
  shapeSearchResult,
} from '../src/host/search.js'
import { coordinationSearchToolDefinition } from '../src/host/searchTools.js'

/* ------------------------------------------------------------------------- *
 * Arguments and environment
 * ------------------------------------------------------------------------- */

test('query arguments normalise to bounded defaults', () => {
  assert.deepEqual(parseSearchQuery({ query: '  index out of range  ' }), {
    query: 'index out of range',
    size: SEARCH_LIMITS.defaultSize,
    from: 0,
  })

  const full = parseSearchQuery({
    query: 'level:error',
    index: 'logs-*',
    size: 25,
    from: 40,
    fields: ['message', 'service.name'],
  })
  assert.equal(full.index, 'logs-*')
  assert.equal(full.size, 25)
  assert.equal(full.from, 40)
  assert.deepEqual(full.fields, ['message', 'service.name'])
})

test('query arguments reject out-of-range and unknown input', () => {
  assert.throws(() => parseSearchQuery({}), /query must be a string/)
  assert.throws(() => parseSearchQuery({ query: '   ' }), /must not be empty/)
  assert.throws(() => parseSearchQuery({ query: 'x'.repeat(SEARCH_LIMITS.query + 1) }), /at most/)
  assert.throws(() => parseSearchQuery({ query: 'ok', size: 0 }), /between/)
  assert.throws(() => parseSearchQuery({ query: 'ok', size: SEARCH_LIMITS.size + 1 }), /between/)
  assert.throws(() => parseSearchQuery({ query: 'ok', from: -1 }), /between/)
  assert.throws(() => parseSearchQuery({ query: 'ok', index: 'bad index!' }), /plain index name/)
  assert.throws(() => parseSearchQuery({ query: 'ok', fields: [] }), /non-empty array/)
  assert.throws(() => parseSearchQuery({ query: 'ok', fields: ['ok', 'bad field!'] }), /plain field name/)
  assert.throws(() => parseSearchQuery({ query: 'ok', url: 'http://evil' }), /unknown search parameter/)
})

test('the connection comes from the environment with bounded defaults', () => {
  assert.deepEqual(searchConnectionFromEnv({}), {
    url: 'http://127.0.0.1:9200',
    index: 'coordination',
    timeout: SEARCH_LIMITS.timeout,
  })

  const configured = searchConnectionFromEnv({
    COORDINATION_ES_URL: 'https://es.internal:9243',
    COORDINATION_ES_INDEX: 'amp-*',
    COORDINATION_ES_API_KEY: 'secret',
    COORDINATION_ES_TIMEOUT_MS: '999999',
  })
  assert.equal(configured.url, 'https://es.internal:9243')
  assert.equal(configured.index, 'amp-*')
  assert.equal(configured.apiKey, 'secret')
  assert.equal(configured.timeout, SEARCH_LIMITS.maxTimeout, 'timeout is clamped to the maximum')

  const basic = searchConnectionFromEnv({
    COORDINATION_ES_USERNAME: 'elastic',
    COORDINATION_ES_PASSWORD: 'changeme',
  })
  assert.equal(basic.username, 'elastic')
  assert.equal(basic.password, 'changeme')

  assert.throws(() => searchConnectionFromEnv({ COORDINATION_ES_URL: 'ftp://es' }), /http\(s\) URL/)
  assert.throws(() => searchConnectionFromEnv({ COORDINATION_ES_URL: 'not a url' }), /http\(s\) URL/)
  assert.throws(() => searchConnectionFromEnv({ COORDINATION_ES_INDEX: 'bad index!' }), /plain index name/)
})

/* ------------------------------------------------------------------------- *
 * Request and response shaping
 * ------------------------------------------------------------------------- */

test('the request is a simple_query_string over all fields unless narrowed', () => {
  const query = parseSearchQuery({ query: 'timeout', size: 3, from: 2 })
  const connection = searchConnectionFromEnv({ COORDINATION_ES_INDEX: 'logs' })
  const request = buildSearchRequest(query, connection)
  assert.equal(request.index, 'logs')
  assert.equal(request.from, 2)
  assert.equal(request.size, 3)
  assert.equal(request.track_total_hits, true)
  assert.deepEqual(request.query, {
    simple_query_string: { query: 'timeout', fields: ['*'], default_operator: 'and' },
  })

  const narrowed = buildSearchRequest(
    parseSearchQuery({ query: 'timeout', fields: ['message'] }),
    connection,
  )
  assert.deepEqual((narrowed.query.simple_query_string as { fields: string[] }).fields, ['message'])
})

test('a response projects totals, scores and bounded sources', () => {
  const small = shapeSearchResult({
    _index: 'logs-2026',
    took: 7,
    hits: {
      total: { value: 42, relation: 'eq' },
      hits: [
        { _id: 'a', _score: 1.5, _source: { message: 'timeout' } },
        { _id: 'b', _source: { message: 'no score' } },
        { _source: 'skipped: no id' },
      ],
    },
  }, 'logs')
  assert.equal(small.index, 'logs-2026')
  assert.equal(small.total, 42)
  assert.equal(small.took, 7)
  assert.equal(small.hits.length, 2)
  assert.deepEqual(small.hits[0], { id: 'a', score: 1.5, source: { message: 'timeout' }, truncated: false })
  assert.deepEqual(small.hits[1], { id: 'b', source: { message: 'no score' }, truncated: false })

  const numericTotal = shapeSearchResult({ hits: { total: 3, hits: [] } }, 'logs')
  assert.equal(numericTotal.total, 3)
  assert.equal(numericTotal.index, 'logs', 'a response without _index keeps the requested index')
})

test('an oversized _source becomes a bounded JSON preview', () => {
  const big = shapeSearchResult({
    hits: {
      total: 1,
      hits: [{ _id: 'big', _source: { blob: 'x'.repeat(SEARCH_LIMITS.sourcePreview * 2) } }],
    },
  }, 'logs')
  assert.equal(big.hits[0]?.truncated, true)
  assert.equal(typeof big.hits[0]?.source, 'string')
  assert.ok(String(big.hits[0]?.source).length <= SEARCH_LIMITS.sourcePreview)
})

/* ------------------------------------------------------------------------- *
 * Runner failures
 * ------------------------------------------------------------------------- */

class FakeClient {
  readonly requests: unknown[] = []
  constructor(
    readonly response: unknown,
    readonly failure?: unknown,
  ) {}
  async search(request: unknown): Promise<unknown> {
    this.requests.push(request)
    if (this.failure !== undefined) throw this.failure
    return this.response
  }
}

/** A client module whose `Client` constructor returns the scripted client. */
function moduleOf(client: FakeClient): {
  Client: new (options: unknown) => { search(request: unknown): Promise<unknown> }
} {
  const holder = client
  return {
    Client: class {
      search(request: unknown): Promise<unknown> {
        return holder.search(request)
      }
    },
  }
}

test('runSearch returns projected hits and never throws', async () => {
  const client = new FakeClient({
    hits: { total: { value: 1 }, hits: [{ _id: 'x', _score: 2, _source: { ok: true } }] },
  })
  const outcome = await runSearch(
    parseSearchQuery({ query: 'ok' }),
    searchConnectionFromEnv({}),
    undefined,
    { importClient: async () => moduleOf(client) },
  )
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.total, 1)
  assert.deepEqual(outcome.hits[0], { id: 'x', score: 2, source: { ok: true }, truncated: false })
  assert.equal(client.requests.length, 1)
})

test('a missing index and an unreachable cluster are typed failures', async () => {
  const notFound = Object.assign(new Error('index_not_found_exception'), { meta: { statusCode: 404 } })
  const missingIndex = await runSearch(
    parseSearchQuery({ query: 'ok', index: 'nope' }),
    searchConnectionFromEnv({}),
    undefined,
    { importClient: async () => moduleOf(new FakeClient(undefined, notFound)) },
  )
  assert.equal(missingIndex.ok, false)
  assert.equal(missingIndex.ok ? '' : missingIndex.error.code, 'NOT_FOUND')

  const refused = await runSearch(
    parseSearchQuery({ query: 'ok' }),
    searchConnectionFromEnv({ COORDINATION_ES_URL: 'http://127.0.0.1:1' }),
    undefined,
    { importClient: async () => moduleOf(new FakeClient(undefined, new Error('ECONNREFUSED'))) },
  )
  assert.equal(refused.ok, false)
  assert.equal(refused.ok ? '' : refused.error.code, 'UPSTREAM')
  assert.match(refused.ok ? '' : refused.error.message, /127\.0\.0\.1:1/)
})

test('a host without the module reports UPSTREAM instead of crashing', async () => {
  const outcome = await runSearch(
    parseSearchQuery({ query: 'ok' }),
    searchConnectionFromEnv({}),
    undefined,
    { importClient: async () => null },
  )
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok ? '' : outcome.error.code, 'UPSTREAM')
  assert.match(outcome.ok ? '' : outcome.error.message, /attention-manifest-protocol/)
})

/* ------------------------------------------------------------------------- *
 * Tool
 * ------------------------------------------------------------------------- */

test('the tool passes a validated query to the runner and reports its outcome', async () => {
  let seen: unknown
  const definition = coordinationSearchToolDefinition('en-US', {
    env: { COORDINATION_ES_INDEX: 'logs' },
    run: async (query, connection) => {
      seen = { query, connection }
      return { ok: true, index: 'logs', total: 0, took: 1, hits: [] }
    },
  })
  assert.equal(definition.name, 'coordination_search')
  const result = await definition.execute({ query: 'timeout', size: 5 }, { agent: { id: 's' } })
  assert.equal(result.ok, true)
  assert.equal(result.index, 'logs')
  assert.deepEqual(seen, {
    query: { query: 'timeout', size: 5, from: 0 },
    connection: { url: 'http://127.0.0.1:9200', index: 'logs', timeout: SEARCH_LIMITS.timeout },
  })
})

test('the tool reports invalid arguments and runner failures as typed results', async () => {
  const definition = coordinationSearchToolDefinition('zh-CN', {
    run: async () => ({ ok: false, error: { code: 'UPSTREAM', message: 'down' } }),
  })
  const invalid = await definition.execute({ query: '' }, undefined)
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error?.code, 'INVALID_ARGUMENT')

  const upstream = await definition.execute({ query: 'ok' }, undefined)
  assert.equal(upstream.ok, false)
  assert.equal(upstream.error?.code, 'UPSTREAM')
})
