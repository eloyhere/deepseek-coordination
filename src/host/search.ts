/**
 * Elasticsearch-backed search for `coordination_search`.
 *
 * The client is `@elastic/elasticsearch` 9.x, which this host already carries
 * through `attention-manifest-protocol`'s dependency (the AMP catalog search
 * uses the same package). It is imported **lazily**, so a host without the
 * module and a call that never searches pay nothing at boot.
 *
 * Endpoint configuration is environment-only and never a tool argument:
 *
 * | Variable | Default | Used for |
 * |---|---|---|
 * | `COORDINATION_ES_URL` | `http://127.0.0.1:9200` | cluster/node URL |
 * | `COORDINATION_ES_INDEX` | `coordination` | default index or alias |
 * | `COORDINATION_ES_API_KEY` | — | `ApiKey` auth |
 * | `COORDINATION_ES_USERNAME` / `_PASSWORD` | — | basic auth when no API key |
 * | `COORDINATION_ES_TIMEOUT_MS` | `5000` | per-request timeout |
 *
 * That split is deliberate: the model chooses *what* to search, the operator
 * chooses *where*, so a prompt cannot point the tool at an arbitrary host or
 * smuggle credentials into a query.
 *
 * The query shape is `simple_query_string` over `fields` (default `["*"]`),
 * which is the honest generic choice for an unknown index mapping: it searches
 * every mapped text field without requiring a field list up front, and its
 * syntax errors are reported by the cluster instead of being silently ignored.
 * Results are bounded: `size` ≤ 50, `from` ≤ 1000, and one hit's `_source` is
 * truncated to a JSON preview rather than returned whole.
 */
import { InvalidArgumentError } from '../shared/error.js'

/** Where one search goes, resolved from the environment (never from the model). */
export interface SearchConnection {
  readonly url: string
  readonly index: string
  readonly apiKey?: string
  readonly username?: string
  readonly password?: string
  /** Per-request timeout in milliseconds. */
  readonly timeout: number
}

/** One validated search request. */
export interface SearchQuery {
  readonly query: string
  readonly index?: string
  readonly size: number
  readonly from: number
  readonly fields?: readonly string[]
}

/** One returned document reference; never the whole document. */
export interface SearchHit {
  readonly id: string
  /** `null` when the cluster did not score the hit (a filter-only match). */
  readonly score?: number
  /** Parsed `_source`, or a bounded JSON preview string when oversized. */
  readonly source: unknown
  readonly truncated: boolean
}

/** Success or a typed failure; the tool never throws into the registry. */
export type SearchOutcome =
  | { readonly ok: true; readonly index: string; readonly total: number; readonly took: number; readonly hits: SearchHit[] }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** Hard limits, mirrored in the tool schema. */
export const SEARCH_LIMITS = {
  /** Characters in the query text. */
  query: 1000,
  /** Maximum `size`. */
  size: 50,
  /** Default `size`. */
  defaultSize: 10,
  /** Maximum `from` (deep paging is not this tool's job). */
  from: 1000,
  /** Maximum field names in `fields`. */
  fields: 20,
  /** Characters in one field name. */
  fieldName: 80,
  /** Characters of one hit's JSON `_source` before it becomes a preview. */
  sourcePreview: 6000,
  /** Default request timeout. */
  timeout: 5000,
  /** Accepted timeout range. */
  minTimeout: 500,
  maxTimeout: 30_000,
} as const

const QUERY_KEYS = new Set(['query', 'index', 'size', 'from', 'fields'])
const INDEX_PATTERN = /^[A-Za-z0-9_.*-]{1,255}$/
const FIELD_PATTERN = /^[A-Za-z0-9_.*-]{1,80}$/

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function integerIn(name: string, value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new InvalidArgumentError(`${name} must be an integer`, { [name]: value })
  }
  if (value < min || value > max) {
    throw new InvalidArgumentError(`${name} must be between ${min} and ${max}`, { [name]: value })
  }
  return value
}

/**
 * Validate one model request. Unknown keys are refused except `session`, which
 * the tool surface may carry for consistency with the other coordination tools.
 */
export function parseSearchQuery(input: unknown): SearchQuery {
  const record = asRecord(input)
  if (record === undefined) throw new InvalidArgumentError('search arguments must be a JSON object')
  for (const key of Object.keys(record)) {
    if (key === 'session') continue
    if (!QUERY_KEYS.has(key)) {
      throw new InvalidArgumentError(`unknown search parameter "${key}"`, { parameter: key })
    }
  }
  if (typeof record.query !== 'string') throw new InvalidArgumentError('query must be a string')
  const query = record.query.trim()
  if (query.length === 0) throw new InvalidArgumentError('query must not be empty')
  if (query.length > SEARCH_LIMITS.query) {
    throw new InvalidArgumentError(`query must be at most ${SEARCH_LIMITS.query} characters`, {
      length: query.length,
      limit: SEARCH_LIMITS.query,
    })
  }
  let index: string | undefined
  if (record.index !== undefined && record.index !== null) {
    if (typeof record.index !== 'string' || !INDEX_PATTERN.test(record.index.trim())) {
      throw new InvalidArgumentError('index must be a plain index name or pattern', { index: record.index })
    }
    index = record.index.trim()
  }
  let fields: string[] | undefined
  if (record.fields !== undefined && record.fields !== null) {
    if (!Array.isArray(record.fields) || record.fields.length === 0) {
      throw new InvalidArgumentError('fields must be a non-empty array of field names')
    }
    if (record.fields.length > SEARCH_LIMITS.fields) {
      throw new InvalidArgumentError(`fields must hold at most ${SEARCH_LIMITS.fields} names`)
    }
    fields = record.fields.map((field) => {
      if (typeof field !== 'string' || !FIELD_PATTERN.test(field.trim())) {
        throw new InvalidArgumentError('each field must be a plain field name or wildcard', { field })
      }
      return field.trim()
    })
  }
  return {
    query,
    ...(index === undefined ? {} : { index }),
    size: integerIn('size', record.size, SEARCH_LIMITS.defaultSize, 1, SEARCH_LIMITS.size),
    from: integerIn('from', record.from, 0, 0, SEARCH_LIMITS.from),
    ...(fields === undefined ? {} : { fields }),
  }
}

/** Resolve the connection from the environment, applying bounded defaults. */
export function searchConnectionFromEnv(env: NodeJS.ProcessEnv = process.env): SearchConnection {
  const url = (env.COORDINATION_ES_URL ?? '').trim() || 'http://127.0.0.1:9200'
  const index = (env.COORDINATION_ES_INDEX ?? '').trim() || 'coordination'
  if (!INDEX_PATTERN.test(index)) {
    throw new InvalidArgumentError('COORDINATION_ES_INDEX must be a plain index name or pattern')
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new InvalidArgumentError('COORDINATION_ES_URL must be an absolute http(s) URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidArgumentError('COORDINATION_ES_URL must be an absolute http(s) URL')
  }
  const rawTimeout = Number(env.COORDINATION_ES_TIMEOUT_MS ?? '')
  const timeout = Number.isFinite(rawTimeout) && rawTimeout > 0
    ? Math.min(SEARCH_LIMITS.maxTimeout, Math.max(SEARCH_LIMITS.minTimeout, Math.trunc(rawTimeout)))
    : SEARCH_LIMITS.timeout
  const apiKey = (env.COORDINATION_ES_API_KEY ?? '').trim() || undefined
  const username = (env.COORDINATION_ES_USERNAME ?? '').trim() || undefined
  const password = env.COORDINATION_ES_PASSWORD ?? undefined
  return {
    url,
    index,
    timeout,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(username === undefined ? {} : { username, ...(password === undefined ? {} : { password }) }),
  }
}

/** The Elasticsearch request body for one validated query. */
export function buildSearchRequest(query: SearchQuery, connection: SearchConnection): {
  index: string
  from: number
  size: number
  track_total_hits: boolean
  query: Record<string, unknown>
} {
  return {
    index: query.index ?? connection.index,
    from: query.from,
    size: query.size,
    track_total_hits: true,
    query: {
      simple_query_string: {
        query: query.query,
        fields: [...(query.fields ?? ['*'])],
        default_operator: 'and',
      },
    },
  }
}

/** Bound one document: a JSON preview replaces an oversized `_source`. */
function shapeSource(source: unknown): { source: unknown; truncated: boolean } {
  if (source === undefined) return { source: null, truncated: false }
  const text = JSON.stringify(source)
  if (text === undefined || text.length <= SEARCH_LIMITS.sourcePreview) {
    return { source, truncated: false }
  }
  return { source: text.slice(0, SEARCH_LIMITS.sourcePreview), truncated: true }
}

/**
 * Project an Elasticsearch response onto the tool's closed result shape.
 *
 * `total` is read from the object form (`{ value }`) the cluster uses once
 * `track_total_hits` is exact, with the plain number kept for older answers.
 */
export function shapeSearchResult(
  response: unknown,
  fallbackIndex: string,
): { ok: true; index: string; total: number; took: number; hits: SearchHit[] } {
  const record = asRecord(response) ?? {}
  const rawHits = asRecord(record.hits) ?? {}
  const totalRaw = rawHits.total
  const total = typeof totalRaw === 'number'
    ? totalRaw
    : typeof asRecord(totalRaw)?.value === 'number'
      ? Number(asRecord(totalRaw)?.value)
      : 0
  const list = Array.isArray(rawHits.hits) ? rawHits.hits : []
  const hits: SearchHit[] = []
  for (const raw of list) {
    const hit = asRecord(raw)
    if (hit === undefined || typeof hit._id !== 'string') continue
    const shaped = shapeSource(hit._source)
    hits.push({
      id: hit._id,
      ...(typeof hit._score === 'number' ? { score: hit._score } : {}),
      source: shaped.source,
      truncated: shaped.truncated,
    })
  }
  return {
    ok: true,
    index: typeof record._index === 'string' ? record._index : fallbackIndex,
    total,
    took: typeof record.took === 'number' ? record.took : 0,
    hits,
  }
}

/** The structural slice of `@elastic/elasticsearch` this module uses. */
interface ElasticClient {
  search(request: unknown, options?: unknown): Promise<unknown>
}

export interface SearchRunDeps {
  /** Test seam: returns the module namespace or `null` when it is missing. */
  readonly importClient?: () => Promise<{ Client?: new (options: unknown) => ElasticClient } | null>
}

/** Load the client lazily; `null` means the dependency is not installed. */
async function loadClientModule(deps: SearchRunDeps): Promise<{ Client?: new (options: unknown) => ElasticClient } | null> {
  if (deps.importClient !== undefined) return await deps.importClient()
  try {
    return (await import('@elastic/elasticsearch')) as unknown as { Client?: new (options: unknown) => ElasticClient }
  } catch {
    return null
  }
}

/**
 * Run one search. Never throws: an unavailable cluster, a bad index or a
 * rejected query returns a typed failure the model can read and act on.
 */
export async function runSearch(
  query: SearchQuery,
  connection: SearchConnection,
  signal?: AbortSignal,
  deps: SearchRunDeps = {},
): Promise<SearchOutcome> {
  const index = query.index ?? connection.index
  const module = await loadClientModule(deps)
  if (module?.Client === undefined) {
    return {
      ok: false,
      error: {
        code: 'UPSTREAM',
        message: '@elastic/elasticsearch is not installed in this host; it ships with attention-manifest-protocol',
      },
    }
  }
  const options: Record<string, unknown> = {
    node: connection.url,
    requestTimeout: connection.timeout,
    ...(connection.apiKey === undefined
      ? connection.username === undefined
        ? {}
        : { auth: { username: connection.username, password: connection.password ?? '' } }
      : { auth: { apiKey: connection.apiKey } }),
  }
  let client: ElasticClient
  try {
    client = new module.Client(options)
  } catch (error) {
    return { ok: false, error: { code: 'UPSTREAM', message: `elasticsearch client failed: ${messageOf(error)}` } }
  }
  try {
    const response = await client.search(
      buildSearchRequest(query, connection),
      signal === undefined ? undefined : { signal },
    )
    return shapeSearchResult(response, index)
  } catch (error) {
    const status = statusOf(error)
    if (status === 404) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `index "${index}" does not exist or is not searchable` } }
    }
    return {
      ok: false,
      error: {
        code: 'UPSTREAM',
        message: `elasticsearch at ${connection.url} did not answer: ${messageOf(error)}`,
      },
    }
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function statusOf(error: unknown): number | undefined {
  const meta = (error as { meta?: { statusCode?: unknown } } | null)?.meta
  return typeof meta?.statusCode === 'number' ? meta.statusCode : undefined
}
