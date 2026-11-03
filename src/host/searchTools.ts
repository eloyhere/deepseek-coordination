/**
 * `coordination_search` — the model-facing Elasticsearch query.
 *
 * The tool is a thin, validating shell around {@link runSearch}: it owns the
 * argument surface, the bilingual description and the failure envelope, while
 * the connection, query DSL and response projection live in `host/search.ts`
 * (testable without a cluster).
 *
 * Scope note for the model: this searches the operator's internal
 * Elasticsearch, not the workspace graph. The workspace has its own lexical
 * tools (`coordination_chain`, `/graph/search`); an Elasticsearch hit is a
 * document, so it is returned as bounded `_source`, never as file content.
 */
import type { CoordinationToolDefinition, CoordinationToolTextBlock, ToolExecution } from './tools.js'
import { normaliseLocale, type Locale } from '../shared/i18n.js'
import {
  SEARCH_LIMITS,
  parseSearchQuery,
  runSearch,
  searchConnectionFromEnv,
  type SearchConnection,
  type SearchOutcome,
  type SearchQuery,
} from './search.js'

/** The registered tool name. */
export type SearchToolName = 'coordination_search'

/** Every successful and failing shape this tool returns, closed for the model. */
export interface SearchToolResult {
  ok: boolean
  index?: string
  total?: number
  took?: number
  hits?: ReadonlyArray<{ id: string; score?: number; source: unknown; truncated: boolean }>
  error?: { code: string; message: string }
}

const RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    index: { type: 'string' },
    total: { type: 'number' },
    took: { type: 'number' },
    hits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          score: { type: 'number' },
          source: {},
          truncated: { type: 'boolean' },
        },
      },
    },
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
  },
}

function asArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('search arguments must be a JSON object')
  }
  return value as Record<string, unknown>
}

function failure(error: unknown): SearchToolResult {
  const code = typeof (error as { code?: unknown } | null)?.code === 'string'
    ? String((error as { code?: unknown }).code)
    : 'INVALID_ARGUMENT'
  const message = error instanceof Error ? error.message : 'search call failed'
  return { ok: false, error: { code, message } }
}

function textBlocks(value: unknown): CoordinationToolTextBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** Test seams: a fake search, or a fixed environment. */
export interface SearchToolDeps {
  readonly run?: (query: SearchQuery, connection: SearchConnection, signal?: AbortSignal) => Promise<SearchOutcome>
  readonly env?: NodeJS.ProcessEnv
}

/** Build the definition; the runner is injectable so no cluster is needed in tests. */
export function coordinationSearchToolDefinition(
  locale: Locale = 'zh-CN',
  deps: SearchToolDeps = {},
): CoordinationToolDefinition<SearchToolResult> {
  const zh = normaliseLocale(locale) === 'zh-CN'
  return {
    name: 'coordination_search',
    description: zh
      ? [
        '在运维方内部的 Elasticsearch 上执行一次检索，返回命中的文档 id、分数与被截断的 _source。',
        '连接地址与默认索引来自宿主环境变量（COORDINATION_ES_URL / COORDINATION_ES_INDEX 等），工具只决定搜什么、不能改连到哪里。',
        '查询走 simple_query_string：默认跨全部字段，可用 fields 收窄；size ≤ 50、from ≤ 1000。',
        '这里搜的是索引里的文档，不是工作区代码；看代码请用 coordination_chain / coordination_read，看工作区里的词法命中请用图查询。',
        '集群不可达时返回 UPSTREAM 错误，不会编造结果。',
      ].join(' ')
      : [
        'Run one query against the operator-internal Elasticsearch and return hit ids, scores and truncated _source documents.',
        'The endpoint and default index come from host environment variables (COORDINATION_ES_URL / COORDINATION_ES_INDEX and friends); the tool chooses what to search, never where.',
        'Queries use simple_query_string over all fields by default; narrow with fields. size ≤ 50, from ≤ 1000.',
        'This searches indexed documents, not the workspace source tree; use coordination_chain / coordination_read for code and the graph queries for lexical workspace hits.',
        'An unreachable cluster returns an UPSTREAM error instead of invented hits.',
      ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: zh
            ? `检索词，1–${SEARCH_LIMITS.query} 个字符（simple_query_string 语法）。`
            : `Search text, 1–${SEARCH_LIMITS.query} characters (simple_query_string syntax).`,
        },
        index: {
          type: 'string',
          description: zh
            ? '可选索引名或通配（如 `logs-*`）；省略用宿主的 COORDINATION_ES_INDEX。'
            : 'Optional index name or pattern (e.g. `logs-*`); defaults to the host COORDINATION_ES_INDEX.',
        },
        size: {
          type: 'integer',
          minimum: 1,
          maximum: SEARCH_LIMITS.size,
          description: zh
            ? `返回条数，1–${SEARCH_LIMITS.size}，默认 ${SEARCH_LIMITS.defaultSize}。`
            : `Hits to return, 1–${SEARCH_LIMITS.size}; defaults to ${SEARCH_LIMITS.defaultSize}.`,
        },
        from: {
          type: 'integer',
          minimum: 0,
          maximum: SEARCH_LIMITS.from,
          description: zh
            ? `偏移量，0–${SEARCH_LIMITS.from}，默认 0。`
            : `Offset, 0–${SEARCH_LIMITS.from}; defaults to 0.`,
        },
        fields: {
          type: 'array',
          maxItems: SEARCH_LIMITS.fields,
          items: { type: 'string' },
          description: zh
            ? '可选字段列表（支持通配）；省略等价于 ["*"]。'
            : 'Optional field list (wildcards allowed); omit for ["*"].',
        },
      },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => textBlocks(value),
    },
    async execute(rawArgs: unknown, exec?: ToolExecution): Promise<SearchToolResult> {
      try {
        const args = asArguments(rawArgs)
        const query = parseSearchQuery(args)
        const connection = searchConnectionFromEnv(deps.env ?? process.env)
        const run = deps.run ?? runSearch
        const outcome = await run(query, connection, exec?.signal)
        return outcome.ok
          ? { ok: true, index: outcome.index, total: outcome.total, took: outcome.took, hits: outcome.hits }
          : outcome
      } catch (error) {
        return failure(error)
      }
    },
  }
}
